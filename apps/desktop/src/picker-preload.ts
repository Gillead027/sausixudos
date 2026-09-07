import { contextBridge, ipcRenderer } from 'electron';

export interface CaptureSourceView {
  id: string;
  name: string;
  thumbnail: string;
  kind: 'screen' | 'window';
}

contextBridge.exposeInMainWorld('capturePicker', {
  listSources: (): Promise<CaptureSourceView[]> => ipcRenderer.invoke('capture-picker:list'),
  chooseSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke('capture-picker:choose', String(sourceId).slice(0, 256)),
  cancel: (): Promise<void> => ipcRenderer.invoke('capture-picker:cancel'),
});
