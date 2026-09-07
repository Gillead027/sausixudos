import { contextBridge, ipcRenderer } from 'electron';

export interface SharePickerChoice {
  quality: '720p30' | '720p60' | '1080p60';
  shareAudio: boolean;
}

contextBridge.exposeInMainWorld('desktop', {
  chooseShareSource: (): Promise<SharePickerChoice | null> => ipcRenderer.invoke('share-picker:open'),
  setZoomFactor: (factor: number): void => ipcRenderer.send('set-zoom-factor', Number(factor)),
});
