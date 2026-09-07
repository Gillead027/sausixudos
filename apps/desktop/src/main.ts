import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  session,
  type DesktopCapturerSource,
} from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initAutoUpdater } from './updater.js';

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
// Fonte já escolhida pelo usuário via o botão "Compartilhar tela" do app (fluxo
// proativo, ver share-picker:open) — quando presente, o handler de getDisplayMedia
// a usa direto em vez de abrir o picker de novo reagindo à chamada do navegador.
let preArmedCapture: ArmedCapture | null = null;

// Sem isso, o Electron deriva o nome do app do "name" do package.json
// (@sausixudos/desktop), e usa isso pra montar o caminho de userData —
// resultando numa pasta "@sausixudos\desktop" em vez de "Sausixudos".
app.setName('Sausixudos');

app.enableSandbox();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

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

  ipcMain.handle('share-picker:open', async () => {
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
  const scriptSource = app.isPackaged ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'";
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
    (_webContents, permission, requestingOrigin) =>
      permission === 'media' && isAllowedAppUrl(requestingOrigin, appOrigin),
  );

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(permission === 'media' && isAllowedAppUrl(details.requestingUrl, appOrigin));
    },
  );

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (
      !request.userGesture ||
      !request.videoRequested ||
      !isAllowedAppUrl(request.securityOrigin, appOrigin)
    ) {
      callback({});
      return;
    }

    let callbackUsed = false;
    try {
      let choice: CaptureChoice | null;
      if (preArmedCapture && Date.now() - preArmedCapture.armedAt < PRE_ARM_TTL_MS) {
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
    }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Sausixudos indisponível',
      message: 'Não foi possível abrir o servidor.',
      detail: `${appUrl.origin}\n${errorDescription}`,
    });
  });
  void window.loadURL(appUrl.toString());
  return window;
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const appUrl = readConfiguredUrl();
    if (app.isPackaged && appUrl.protocol !== 'https:') {
      throw new Error('O cliente de produção exige uma URL HTTPS.');
    }
    Menu.setApplicationMenu(null);
    installPickerIpc();
    installSessionSecurity(appUrl);
    mainWindow = createMainWindow(appUrl);
    mainWindow.once('closed', () => {
      mainWindow = null;
    });
    initAutoUpdater();
  });
}

app.on('window-all-closed', () => app.quit());
