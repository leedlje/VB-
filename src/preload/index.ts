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
  setLayout: (lineHeight, contentWidth) => ipcRenderer.invoke('reader:layout', lineHeight, contentWidth),
  listRecent: () => ipcRenderer.invoke('reader:recent'),
  relocateFile: (filePath) => ipcRenderer.invoke('reader:relocate', filePath),
  removeRecent: (filePath) => ipcRenderer.invoke('reader:remove-recent', filePath),
  addBookmark: (filePath, offset) => ipcRenderer.invoke('reader:add-bookmark', filePath, offset),
  removeBookmark: (filePath, id) => ipcRenderer.invoke('reader:remove-bookmark', filePath, id),
  onRequestProgress: (callback) => { ipcRenderer.on('reader:request-progress', callback); },
  submitCloseProgress: (filePath, offset) => ipcRenderer.send('reader:close-progress', filePath, offset),
  chooseBooks: () => ipcRenderer.invoke('reader:choose-books'),
  listBooks: () => ipcRenderer.invoke('reader:list-books'),
  getLastBookId: () => ipcRenderer.invoke('reader:last-book-id'),
  getStartupWarning: () => ipcRenderer.invoke('reader:startup-warning'),
  openPublication: (id) => ipcRenderer.invoke('reader:open-publication', id),
  readPublication: (id) => ipcRenderer.invoke('reader:read-publication', id),
  saveBookPosition: (id, position) => ipcRenderer.invoke('reader:book-position', id, position),
  addBookBookmark: (id, position) => ipcRenderer.invoke('reader:add-book-mark', id, position),
  removeBookBookmark: (id, markId) => ipcRenderer.invoke('reader:remove-book-mark', id, markId),
  removeBook: (id) => ipcRenderer.invoke('reader:remove-book', id),
  relocateBook: (id) => ipcRenderer.invoke('reader:relocate-book', id),
  coverData: (id) => ipcRenderer.invoke('reader:cover-data', id),
};
contextBridge.exposeInMainWorld('reader', api);
