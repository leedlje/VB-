import { contextBridge, ipcRenderer } from 'electron';
import type { ReaderApi } from '../shared/types.ts';

const api: ReaderApi = {
  restoreLastFile: () => ipcRenderer.invoke('reader:restore'),
  chooseFile: () => ipcRenderer.invoke('reader:choose'),
  openFile: (filePath, encoding) => ipcRenderer.invoke('reader:open', filePath, encoding),
  saveProgress: (filePath, offset) => ipcRenderer.invoke('reader:progress', filePath, offset),
  setFontSize: (size) => ipcRenderer.invoke('reader:font-size', size),
  onRequestProgress: (callback) => { ipcRenderer.on('reader:request-progress', callback); },
  submitCloseProgress: (filePath, offset) => ipcRenderer.send('reader:close-progress', filePath, offset),
};
contextBridge.exposeInMainWorld('reader', api);
