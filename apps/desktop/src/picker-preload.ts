import { contextBridge, ipcRenderer } from 'electron';

export interface CaptureSourceView {
  id: string;
  name: string;
  thumbnail: string;
  kind: 'screen' | 'window';
}

export type PickerShareQuality = '720p30' | '720p60' | '1080p60';

contextBridge.exposeInMainWorld('capturePicker', {
  listSources: (): Promise<CaptureSourceView[]> => ipcRenderer.invoke('capture-picker:list'),
  chooseSource: (sourceId: string, quality: PickerShareQuality, shareAudio: boolean): Promise<void> =>
    ipcRenderer.invoke('capture-picker:choose', String(sourceId).slice(0, 256), quality, Boolean(shareAudio)),
  cancel: (): Promise<void> => ipcRenderer.invoke('capture-picker:cancel'),
});
