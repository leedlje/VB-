import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { BookError, normalizedKey, readBook } from './book.ts';
import { StateStore } from './state.ts';
import { clampOffset, type Encoding, type OpenResult, type Theme } from '../shared/types.ts';

const baseDir = __dirname;
let window: BrowserWindow | null = null;
let store: StateStore;
let currentPath: string | null = null;
let finishingClose = false;

if (process.env.READER_TEST_USER_DATA) app.setPath('userData', process.env.READER_TEST_USER_DATA);

async function openFile(filePath: string, requestedEncoding?: Encoding): Promise<OpenResult> {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { ok: false, message: '文件路径无效，请重新选择文件。' };
  if (requestedEncoding && requestedEncoding !== 'utf8' && requestedEncoding !== 'gb18030') return { ok: false, message: '不支持此文字编码。' };
  const previous = store.record(filePath);
  const encoding = requestedEncoding ?? previous?.encoding ?? 'utf8';
  try {
    const content = await readBook(filePath, encoding);
    const modifiedAt = (await stat(filePath)).mtimeMs;
    const offset = clampOffset(previous?.offset ?? 0, content.length);
    let warning: string | undefined;
    try { await store.updateFile(filePath, { encoding, offset, length: content.length, modifiedAt }); }
    catch { warning = '阅读状态保存失败；本次阅读仍可继续。'; }
    currentPath = filePath;
    const state = store.snapshot();
    return { ok: true, book: { path: filePath, name: path.basename(filePath), content, encoding, offset,
      fontSize: state.fontSize, theme: state.theme, lineHeight: state.lineHeight, contentWidth: state.contentWidth,
      bookmarks: store.record(filePath)?.bookmarks ?? [],
      changed: Boolean(previous?.length && (previous.length !== content.length || (previous.modifiedAt && previous.modifiedAt !== modifiedAt))), warning } };
  } catch (error) {
    return { ok: false, message: error instanceof BookError ? error.message : '打开文件时发生错误，请重试。' };
  }
}

async function chooseFile(): Promise<OpenResult | null> {
  if (!window) return null;
  const choice = await dialog.showOpenDialog(window, {
    title: '选择 TXT 文件', properties: ['openFile'], filters: [{ name: 'TXT 文件', extensions: ['txt'] }],
  });
  return choice.canceled || !choice.filePaths[0] ? null : openFile(choice.filePaths[0]);
}

async function relocateFile(event: Electron.IpcMainInvokeEvent, oldPath: string): Promise<OpenResult | null> {
  if (!window || event.sender !== window.webContents || typeof oldPath !== 'string' || !path.isAbsolute(oldPath)) {
    return { ok: false, message: '文件路径无效，请从最近阅读中重试。' };
  }
  const previous = store.record(oldPath);
  if (!previous) return { ok: false, message: '找不到原阅读记录。' };
  const choice = await dialog.showOpenDialog(window, {
    title: '重新定位 TXT 文件', properties: ['openFile'], filters: [{ name: 'TXT 文件', extensions: ['txt'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const newPath = choice.filePaths[0];
  if (typeof newPath !== 'string' || !path.isAbsolute(newPath)) return { ok: false, message: '新文件路径无效。' };
  if (normalizedKey(newPath) !== normalizedKey(oldPath) && store.record(newPath)) {
    return { ok: false, message: '新路径已有阅读记录，请先处理该记录。' };
  }
  try {
    const content = await readBook(newPath, previous.encoding);
    const modifiedAt = (await stat(newPath)).mtimeMs;
    const changed = Boolean(previous.length && (previous.length !== content.length || (previous.modifiedAt && previous.modifiedAt !== modifiedAt)));
    const record = await store.relocateFile(oldPath, newPath, content.length, modifiedAt);
    currentPath = newPath;
    const state = store.snapshot();
    return { ok: true, book: { path: newPath, name: path.basename(newPath), content, encoding: record.encoding,
      offset: clampOffset(record.offset, content.length), fontSize: state.fontSize, theme: state.theme,
      lineHeight: state.lineHeight, contentWidth: state.contentWidth, bookmarks: record.bookmarks, changed } };
  } catch (error) {
    return { ok: false, message: error instanceof BookError ? error.message : error instanceof Error &&
      error.message.includes('已有阅读记录') ? error.message : '重新定位失败，原阅读记录已保留。' };
  }
}

function createWindow(): void {
  let closeRequested = false;
  window = new BrowserWindow({
    width: 1060, height: 760, minWidth: 580, minHeight: 400,
    backgroundColor: '#f8f6f1',
    webPreferences: {
      preload: path.join(baseDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.setMenuBarVisibility(false);
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (finishingClose || !window || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    const activeWindow = window;
    const onCloseProgress = async (event: Electron.IpcMainEvent, filePath: unknown, offset: unknown) => {
      if (event.sender !== activeWindow.webContents) return;
      clearTimeout(timeout);
      ipcMain.off('reader:close-progress', onCloseProgress);
      if (typeof filePath === 'string' && filePath === currentPath && store.record(filePath) && typeof offset === 'number') {
        try { await store.updateFile(filePath, { offset }); } catch { /* already logged */ }
      }
      finishingClose = true;
      activeWindow.destroy();
    };
    const timeout = setTimeout(() => {
      ipcMain.off('reader:close-progress', onCloseProgress);
      finishingClose = true;
      activeWindow.destroy();
    }, 1200);
    ipcMain.on('reader:close-progress', onCloseProgress);
    activeWindow.webContents.send('reader:request-progress');
  });
  window.on('closed', () => { window = null; });
  if (process.env.READER_DEV_URL) void window.loadURL(process.env.READER_DEV_URL);
  else void window.loadFile(path.join(baseDir, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  store = new StateStore(path.join(app.getPath('userData'), 'reader-state', 'state.json'));
  await store.load();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('reader:restore', () => {
    const lastFile = store.snapshot().lastFile;
    return lastFile ? openFile(lastFile) : null;
  });
  ipcMain.handle('reader:choose', chooseFile);
  ipcMain.handle('reader:relocate', relocateFile);
  ipcMain.handle('reader:open', (_event, filePath: string, encoding?: Encoding) => {
    if (filePath !== currentPath && !store.record(filePath)) return { ok: false, message: '请先选择文件。' };
    return openFile(filePath, encoding);
  });
  ipcMain.handle('reader:progress', (_event, filePath: string, offset: number) => {
    if (filePath !== currentPath || !store.record(filePath) || typeof offset !== 'number') return;
    return store.updateFile(filePath, { offset });
  });
  ipcMain.handle('reader:font-size', (_event, size: number) => store.setFontSize(size));
  ipcMain.handle('reader:appearance', () => {
    const { fontSize, theme, lineHeight, contentWidth } = store.snapshot();
    return { fontSize, theme, lineHeight, contentWidth };
  });
  ipcMain.handle('reader:theme', (_event, theme: Theme) => store.setTheme(theme));
  ipcMain.handle('reader:layout', (_event, lineHeight: number, contentWidth: number) => store.setLayout(lineHeight, contentWidth));
  ipcMain.handle('reader:recent', () => store.listRecent());
  ipcMain.handle('reader:remove-recent', async (_event, filePath: string) => {
    if (!store.record(filePath)) return;
    if (currentPath === filePath) currentPath = null;
    await store.removeFile(filePath);
  });
  ipcMain.handle('reader:add-bookmark', (_event, filePath: string, offset: number) => {
    if (filePath !== currentPath || typeof offset !== 'number') throw new Error('没有正在阅读的文件。');
    return store.addBookmark(filePath, offset);
  });
  ipcMain.handle('reader:remove-bookmark', (_event, filePath: string, id: string) => {
    if (filePath !== currentPath || typeof id !== 'string') throw new Error('没有正在阅读的文件。');
    return store.removeBookmark(filePath, id);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { finishingClose = false; createWindow(); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
