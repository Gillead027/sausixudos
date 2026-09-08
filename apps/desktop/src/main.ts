import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
  type DesktopCapturerSource,
} from 'electron';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { initAutoUpdater } from './updater.js';

// windows-media-sessions calcula o caminho do próprio backend nativo relativo
// a onde o módulo foi carregado — no build empacotado, isso caiu certo
// (dentro de app.asar.unpacked, resolvido via require() real desde que
// marcamos o pacote como external no tsup), mas ainda assim o handshake
// inicial deu timeout num teste real. O próprio pacote documenta essa
// variável de ambiente como escape hatch exatamente pra esse cenário — usamos
// process.resourcesPath (API confiável do Electron pra achar a pasta de
// recursos do app empacotado) em vez de depender da autodetecção da lib.
// Precisa ser setada ANTES do módulo ser importado, por isso o import de
// activity.js vira dinâmico lá embaixo em vez de estático aqui no topo.
if (app.isPackaged) {
  process.env.WINDOWS_MEDIA_SESSIONS_BACKEND = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'windows-media-sessions',
    'bin',
    'win-x64',
    'windows-media-sessions-backend.exe',
  );
}

const debugLogPath = path.join(process.env.TEMP || process.env.TMP || '.', 'sausixudos-startup-debug.log');

function debugLog(line: string): void {
  try {
    appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (error) {
    try {
      appendFileSync(
        path.join('.', 'sausixudos-startup-debug-fallback.log'),
        `[${new Date().toISOString()}] ${line} (primary log failed: ${String(error)})\n`,
        'utf8',
      );
    } catch {
      // diagnóstico best-effort, não pode travar o boot
    }
  }
}

process.on('uncaughtException', (error) => {
  debugLog(`uncaughtException: ${error.stack || error.message}`);
});
process.on('unhandledRejection', (reason) => {
  debugLog(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
debugLog('main.ts module start');

interface DesktopConfig {
  appUrl: string;
}

type PickerShareQuality = '720p30' | '720p60' | '1080p60';

interface CaptureChoice {
  source: DesktopCapturerSource;
  quality: PickerShareQuality;
  shareAudio: boolean;
}

interface ArmedCapture extends CaptureChoice {
  armedAt: number;
}

const PRE_ARM_TTL_MS = 15_000;

interface PendingCapture {
  window: BrowserWindow;
  sources: DesktopCapturerSource[];
  resolve: (choice: CaptureChoice | null) => void;
}

let mainWindow: BrowserWindow | null = null;
let pendingCapture: PendingCapture | null = null;
let stopActivityMonitor: (() => void) | null = null;
// Fonte já escolhida pelo usuário via o botão "Compartilhar tela" do app (fluxo
// proativo, ver share-picker:open) — quando presente, o handler de getDisplayMedia
// a usa direto em vez de abrir o picker de novo reagindo à chamada do navegador.
let preArmedCapture: ArmedCapture | null = null;

// Sem isso, o Electron deriva o nome do app do "name" do package.json
// (@sausixudos/desktop), e usa isso pra montar o caminho de userData —
// resultando numa pasta "@sausixudos\desktop" em vez de "Sausixudos".
app.setName('Sausixudos');
debugLog('after setName');

app.enableSandbox();
debugLog('after enableSandbox');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
debugLog(`hasSingleInstanceLock=${hasSingleInstanceLock}`);
if (!hasSingleInstanceLock) {
  debugLog('quitting: no single instance lock');
  app.quit();
}

function readConfiguredUrl(): URL {
  const developmentUrl = process.env.SAUSIXUDOS_APP_URL;
  if (!app.isPackaged && developmentUrl) return new URL(developmentUrl);

  const configPath = path.join(process.resourcesPath, 'desktop-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as DesktopConfig;
  return new URL(config.appUrl);
}

function isAllowedAppUrl(candidate: string, appOrigin: string): boolean {
  try {
    return new URL(candidate).origin === appOrigin;
  } catch {
    return false;
  }
}

function isAllowedPermissionOrigin(appOrigin: string, ...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => candidate && isAllowedAppUrl(candidate, appOrigin));
}

function finishCapture(choice: CaptureChoice | null): void {
  const capture = pendingCapture;
  if (!capture) return;
  pendingCapture = null;
  if (!capture.window.isDestroyed()) capture.window.close();
  capture.resolve(choice);
}

function installPickerIpc(): void {
  ipcMain.handle('capture-picker:list', (event) => {
    const capture = pendingCapture;
    if (!capture || event.sender.id !== capture.window.webContents.id) return [];
    return capture.sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    }));
  });

  ipcMain.handle('capture-picker:choose', (event, sourceId: unknown, quality: unknown, shareAudio: unknown) => {
    const capture = pendingCapture;
    if (
      !capture ||
      event.sender.id !== capture.window.webContents.id ||
      typeof sourceId !== 'string' ||
      typeof quality !== 'string'
    ) {
      return;
    }
    const source = capture.sources.find((candidate) => candidate.id === sourceId);
    finishCapture(source ? { source, quality: quality as PickerShareQuality, shareAudio: Boolean(shareAudio) } : null);
  });

  ipcMain.handle('capture-picker:cancel', (event) => {
    if (pendingCapture && event.sender.id === pendingCapture.window.webContents.id) {
      finishCapture(null);
    }
  });

  // CSS zoom deixa espaço vazio em layouts full-bleed (100vw/100vh calculado
  // antes do fator aplicar); o zoom nativo do Chromium (o mesmo do Ctrl+scroll)
  // recalcula as unidades de viewport corretamente, sem esse problema.
  ipcMain.on('set-zoom-factor', (event, factor: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 3) return;
    mainWindow.webContents.setZoomFactor(factor);
  });

  ipcMain.handle('share-picker:open', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    const choice = await chooseCaptureSource(sources);
    if (!choice) return null;
    preArmedCapture = { ...choice, armedAt: Date.now() };
    return { quality: choice.quality, shareAudio: choice.shareAudio };
  });

  ipcMain.handle('window:set-fullscreen', (event, enabled: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || typeof enabled !== 'boolean') return false;
    debugLog(`native fullscreen requested enabled=${enabled}`);
    mainWindow.setFullScreen(enabled);
    return enabled;
  });

  ipcMain.handle('window:get-fullscreen', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('media:get-access-status', (event, mediaType: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return 'unknown';
    if (mediaType !== 'camera' && mediaType !== 'microphone') return 'unknown';
    try {
      return systemPreferences.getMediaAccessStatus(mediaType);
    } catch (error) {
      debugLog(`getMediaAccessStatus failed mediaType=${mediaType}: ${String(error)}`);
      return 'unknown';
    }
  });

  ipcMain.handle('media:open-settings', async (event, mediaType: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    if (mediaType !== 'camera' && mediaType !== 'microphone') return false;
    if (process.platform !== 'win32') return false;
    const settingsUrl = mediaType === 'camera'
      ? 'ms-settings:privacy-webcam'
      : 'ms-settings:privacy-microphone';
    await shell.openExternal(settingsUrl);
    return true;
  });
}

async function chooseCaptureSource(sources: DesktopCapturerSource[]): Promise<CaptureChoice | null> {
  if (pendingCapture) finishCapture(null);

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 820,
      height: 560,
      minWidth: 640,
      minHeight: 420,
      ...(mainWindow ? { parent: mainWindow } : {}),
      modal: Boolean(mainWindow),
      show: false,
      title: 'Compartilhar tela — Sausixudos',
      backgroundColor: '#111315',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });

    pendingCapture = { window: picker, sources, resolve };
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
    picker.once('ready-to-show', () => picker.show());
    picker.once('closed', () => {
      if (pendingCapture?.window === picker) {
        const capture = pendingCapture;
        pendingCapture = null;
        capture.resolve(null);
      }
    });
    void picker.loadFile(path.join(__dirname, '../src/picker.html'));
  });
}

function installSessionSecurity(appUrl: URL): void {
  const appOrigin = appUrl.origin;
  const websocketOrigin = `${appUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${appUrl.host}`;
  const developmentConnections = app.isPackaged
    ? ''
    : ' https: wss: http://localhost:* ws://localhost:*';
  // 'wasm-unsafe-eval' só libera compilar/instanciar WebAssembly (o filtro de
  // ruído Krisp roda como um módulo WASM) — não abre eval de JS arbitrário
  // como 'unsafe-eval' faria; sem isso o Chromium bloqueia silenciosamente
  // qualquer WebAssembly.instantiate quando há CSP restringindo script-src.
  const scriptSource = app.isPackaged
    ? "script-src 'self' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
  const styleSource = app.isPackaged ? "style-src 'self'" : "style-src 'self' 'unsafe-inline'";
  // A cor de destaque personalizada (hex livre) na tela de Aparência precisa mutar
  // a custom property --accent via element.style em runtime. style-src sozinho
  // bloquearia isso no build empacotado; liberamos só o atributo style="" (não
  // <style>/style-src geral) para essa única finalidade.
  const styleAttrSource = "style-src-attr 'unsafe-inline'";
  const contentSecurityPolicy = [
    "default-src 'self'",
    scriptSource,
    styleSource,
    styleAttrSource,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self' ${appOrigin} ${websocketOrigin}${developmentConnections}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isAllowedAppUrl(details.url, appOrigin)) {
      callback(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const allowedPermission =
        permission === 'media' ||
        permission === 'fullscreen' ||
        permission === 'automatic-fullscreen' ||
        permission === 'display-capture' ||
        permission === 'speaker-selection';
      const allowedOrigin = isAllowedPermissionOrigin(
        appOrigin,
        requestingOrigin,
        details.securityOrigin,
        details.requestingUrl,
        webContents?.getURL(),
      );
      // O Chromium 152 faz uma pré-checagem de câmera/microfone enquanto a
      // BrowserWindow ainda está navegando. Nessa chamada todos os campos de
      // origem chegam vazios; negar aqui fica em cache e bloqueia o pedido real
      // que vem logo depois. A pré-checagem pode passar porque a autorização
      // efetiva continua sendo validada por origem no RequestHandler abaixo.
      const originlessMediaPreflight =
        permission === 'media' &&
        !requestingOrigin &&
        !details.securityOrigin &&
        !details.requestingUrl &&
        !webContents?.getURL();
      const granted = allowedPermission && (allowedOrigin || originlessMediaPreflight);
      debugLog(
        `permission-check permission=${permission} mediaType=${details.mediaType || '-'} requestingOrigin=${requestingOrigin || '-'} securityOrigin=${details.securityOrigin || '-'} requestingUrl=${details.requestingUrl || '-'} webContentsUrl=${webContents?.getURL() || '-'} preflight=${originlessMediaPreflight} originAllowed=${allowedOrigin} granted=${granted}`,
      );
      return granted;
    },
  );

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined;
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
      const allowedPermission =
        permission === 'media' ||
        permission === 'fullscreen' ||
        permission === 'automatic-fullscreen' ||
        permission === 'display-capture' ||
        permission === 'speaker-selection';
      const allowedOrigin = isAllowedPermissionOrigin(
        appOrigin,
        details.requestingUrl,
        securityOrigin,
        webContents.getURL(),
      );
      const granted = allowedPermission && allowedOrigin;
      const cameraStatus = mediaTypes?.includes('video')
        ? systemPreferences.getMediaAccessStatus('camera')
        : 'not-requested';
      const microphoneStatus = mediaTypes?.includes('audio')
        ? systemPreferences.getMediaAccessStatus('microphone')
        : 'not-requested';
      debugLog(
        `permission-request permission=${permission} mediaTypes=${mediaTypes?.join(',') || '-'} originAllowed=${allowedOrigin} camera=${cameraStatus} microphone=${microphoneStatus} granted=${granted}`,
      );
      callback(granted);
    },
  );

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // O seletor proprio e aberto antes do getDisplayMedia. Enquanto o usuario
    // escolhe a fonte, a ativacao transitoria do clique expira no Chromium;
    // nesse fluxo, a fonte pre-armada e a autorizacao explicita e recente.
    const hasFreshPreArmedCapture =
      preArmedCapture !== null && Date.now() - preArmedCapture.armedAt < PRE_ARM_TTL_MS;
    if (
      (!request.userGesture && !hasFreshPreArmedCapture) ||
      !request.videoRequested ||
      !isAllowedAppUrl(request.securityOrigin, appOrigin)
    ) {
      callback({});
      return;
    }

    let callbackUsed = false;
    try {
      let choice: CaptureChoice | null;
      if (hasFreshPreArmedCapture && preArmedCapture) {
        choice = preArmedCapture;
        preArmedCapture = null;
      } else {
        preArmedCapture = null;
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: false,
        });
        choice = await chooseCaptureSource(sources);
      }
      if (!choice) {
        callbackUsed = true;
        callback({});
        return;
      }

      callbackUsed = true;
      if (request.audioRequested && choice.shareAudio && process.platform === 'win32') {
        callback({ video: choice.source, audio: 'loopback' });
      } else {
        callback({ video: choice.source });
      }
    } catch (error) {
      console.error('Falha ao selecionar fonte de captura:', error);
      if (!callbackUsed) callback({});
    }
  });
}

function createMainWindow(appUrl: URL): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    title: 'Sausixudos',
    backgroundColor: '#111315',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppUrl(targetUrl, appUrl.origin)) event.preventDefault();
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isReloadCombo = (input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.alt && !input.shift;
    if (isReloadCombo || input.key === 'F5') {
      event.preventDefault();
      window.webContents.reloadIgnoringCache();
    } else if (input.key === 'F11') {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (input.key === 'Escape' && window.isFullScreen()) {
      event.preventDefault();
      window.setFullScreen(false);
    }
  });
  const emitFullscreenState = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const fullscreen = window.isFullScreen();
    debugLog(`native fullscreen changed enabled=${fullscreen}`);
    window.webContents.send('window:fullscreen-changed', fullscreen);
  };
  window.on('enter-full-screen', emitFullscreenState);
  window.on('leave-full-screen', emitFullscreenState);
  window.once('ready-to-show', () => {
    debugLog('ready-to-show fired, calling show()');
    window.show();
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    debugLog(`did-fail-load errorCode=${errorCode} description=${errorDescription}`);
    if (errorCode === -3) return;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Sausixudos indisponível',
      message: 'Não foi possível abrir o servidor.',
      detail: `${appUrl.origin}\n${errorDescription}`,
    });
  });
  window.webContents.on('did-finish-load', () => debugLog('did-finish-load'));
  window.webContents.on('dom-ready', () => debugLog('dom-ready'));
  // DevTools fica desligado no build empacotado, então sem isso nenhum
  // console.error/warn/log da página (nem exceções não tratadas do React)
  // chegam a algum lugar que dê pra ler depois.
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelName = ['verbose', 'info', 'warning', 'error'][level] ?? String(level);
    debugLog(`renderer console [${levelName}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    debugLog(`preload-error path=${preloadPath} error=${error.stack || error.message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => debugLog(`render-process-gone: ${JSON.stringify(details)}`));
  window.webContents.on('unresponsive', () => debugLog('webContents unresponsive'));
  window.webContents.on('responsive', () => debugLog('webContents responsive again'));
  window.on('show', () => debugLog('window show event'));
  window.on('close', () => debugLog('window close event'));
  window.on('closed', () => debugLog('window closed event'));
  // ready-to-show normalmente dispara no primeiro paint; se por algum motivo
  // não disparar (perda do evento, hang de carregamento sem did-fail-load),
  // isso garante que a janela apareça de qualquer forma em vez de ficar
  // rodando invisível pra sempre.
  const forceShowTimer = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      debugLog('forcing show() after timeout — ready-to-show never fired');
      window.show();
    }
  }, 8_000);
  window.once('show', () => clearTimeout(forceShowTimer));
  window.once('closed', () => clearTimeout(forceShowTimer));
  void window.loadURL(appUrl.toString());
  return window;
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    debugLog('whenReady resolved');
    try {
      const appUrl = readConfiguredUrl();
      debugLog(`appUrl=${appUrl.toString()} isPackaged=${app.isPackaged}`);
      if (app.isPackaged && appUrl.protocol !== 'https:') {
        throw new Error('O cliente de produção exige uma URL HTTPS.');
      }
      Menu.setApplicationMenu(null);
      installPickerIpc();
      debugLog('installPickerIpc done');
      installSessionSecurity(appUrl);
      debugLog('installSessionSecurity done');
      mainWindow = createMainWindow(appUrl);
      debugLog('createMainWindow done');
      mainWindow.once('closed', () => {
        mainWindow = null;
      });
      const { startActivityMonitor } = await import('./activity.js');
      stopActivityMonitor = startActivityMonitor((activity) => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('activity:changed', activity);
        }
      }, debugLog);
      debugLog('startActivityMonitor done');
      initAutoUpdater();
      debugLog('initAutoUpdater done');
    } catch (error) {
      debugLog(`whenReady handler threw: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }).catch((error) => {
    debugLog(`whenReady promise rejected: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  });
}

app.on('window-all-closed', () => {
  debugLog('window-all-closed -> quit');
  app.quit();
});
app.on('before-quit', () => {
  debugLog('before-quit');
  stopActivityMonitor?.();
  stopActivityMonitor = null;
});
app.on('will-quit', () => debugLog('will-quit'));
app.on('quit', (_event, exitCode) => debugLog(`quit exitCode=${exitCode}`));
app.on('child-process-gone', (_event, details) => debugLog(`child-process-gone: ${JSON.stringify(details)}`));
