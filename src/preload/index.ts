import { contextBridge, ipcRenderer } from 'electron';
import type { ReaderApi } from '../shared/types.ts';

const api: ReaderApi = {
  restoreLastFile: () => ipcRenderer.invoke('reader:restore'),
  chooseFile: () => ipcRenderer.invoke('reader:choose'),
  openFile: (filePath, encoding) => ipcRenderer.invoke('reader:open', filePath, encoding),
  saveProgress: (filePath, offset) => ipcRenderer.invoke('reader:progress', filePath, offset),
  setFontSize: (size) => ipcRenderer.invoke('reader:font-size', size),
  getAppearance: () => ipcRenderer.invoke('reader:appearance'),
  setTheme: (theme) => ipcRenderer.invoke('reader:theme', theme),
  listRecent: () => ipcRenderer.invoke('reader:recent'),
  removeRecent: (filePath) => ipcRenderer.invoke('reader:remove-recent', filePath),
  addBookmark: (filePath, offset) => ipcRenderer.invoke('reader:add-bookmark', filePath, offset),
  removeBookmark: (filePath, id) => ipcRenderer.invoke('reader:remove-bookmark', filePath, id),
  onRequestProgress: (callback) => { ipcRenderer.on('reader:request-progress', callback); },
  submitCloseProgress: (filePath, offset) => ipcRenderer.send('reader:close-progress', filePath, offset),
};
contextBridge.exposeInMainWorld('reader', api);
