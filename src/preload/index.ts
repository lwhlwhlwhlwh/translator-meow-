import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, ProgressEvent, Settings } from '../shared/types';
const api: AppApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('settings:save', settings),
  updateApiKey: (apiKey: string) => ipcRenderer.invoke('settings:update-api-key', apiKey),
  translateText: (text, settings) => ipcRenderer.invoke('translate:text', text, settings),
  chooseInput: () => ipcRenderer.invoke('dialog:input'),
  chooseOutput: defaultPath => ipcRenderer.invoke('dialog:output', defaultPath),
  translateDocument: (input, output, settings) => ipcRenderer.invoke('translate:document', input, output, settings),
  cancel: () => ipcRenderer.invoke('translate:cancel'),
  onProgress: callback => { const listener = (_: Electron.IpcRendererEvent, p: ProgressEvent) => callback(p); ipcRenderer.on('translate:progress', listener); return () => ipcRenderer.removeListener('translate:progress', listener); }
};
contextBridge.exposeInMainWorld('app', api);
