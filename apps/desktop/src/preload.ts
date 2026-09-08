import { contextBridge, ipcRenderer } from 'electron';
import type { Activity } from '@sausixudos/shared';

// Repassa exceções e rejeições não tratadas pro console.error, que o main
// process já captura via webContents 'console-message' — sem isso, um erro
// que quebra silenciosamente um clique (ex.: tela cheia) não deixa rastro
// nenhum, já que o DevTools fica desligado no build empacotado.
window.addEventListener('error', (event) => {
  console.error('[uncaught]', event.message, event.error?.stack || '');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error('[unhandledrejection]', reason instanceof Error ? reason.stack || reason.message : String(reason));
});

export interface SharePickerChoice {
  quality: '720p30' | '720p60' | '1080p60';
  shareAudio: boolean;
}

export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

contextBridge.exposeInMainWorld('desktop', {
  chooseShareSource: (): Promise<SharePickerChoice | null> => ipcRenderer.invoke('share-picker:open'),
  setZoomFactor: (factor: number): void => ipcRenderer.send('set-zoom-factor', Number(factor)),
  setFullscreen: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('window:set-fullscreen', Boolean(enabled)),
  getFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:get-fullscreen'),
  onFullscreenChanged: (listener: (enabled: boolean) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, enabled: unknown) => listener(Boolean(enabled));
    ipcRenderer.on('window:fullscreen-changed', wrapped);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', wrapped);
  },
  getMediaAccessStatus: (mediaType: 'camera' | 'microphone'): Promise<MediaAccessStatus> =>
    ipcRenderer.invoke('media:get-access-status', mediaType),
  openMediaSettings: (mediaType: 'camera' | 'microphone'): Promise<boolean> =>
    ipcRenderer.invoke('media:open-settings', mediaType),
  onActivityChanged: (listener: (activity: Activity | null) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, activity: unknown) => listener(activity as Activity | null);
    ipcRenderer.on('activity:changed', wrapped);
    return () => ipcRenderer.removeListener('activity:changed', wrapped);
  },
});
