import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { BookError, readBook } from './book.ts';
import { StateStore } from './state.ts';
import { clampOffset, type Encoding, type OpenResult } from '../shared/types.ts';

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
    const offset = clampOffset(previous?.offset ?? 0, content.length);
    let warning: string | undefined;
    try { await store.updateFile(filePath, { encoding, offset }); }
    catch { warning = '阅读状态保存失败；本次阅读仍可继续。'; }
    currentPath = filePath;
    return { ok: true, book: { path: filePath, name: path.basename(filePath), content, encoding, offset, fontSize: store.snapshot().fontSize, warning } };
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
      if (typeof filePath === 'string' && filePath === currentPath && typeof offset === 'number') {
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
  ipcMain.handle('reader:open', (_event, filePath: string, encoding?: Encoding) => {
    if (filePath !== currentPath && filePath !== store.snapshot().lastFile) return { ok: false, message: '请先选择文件。' };
    return openFile(filePath, encoding);
  });
  ipcMain.handle('reader:progress', (_event, filePath: string, offset: number) => {
    if (filePath !== currentPath || typeof offset !== 'number') return;
    return store.updateFile(filePath, { offset });
  });
  ipcMain.handle('reader:font-size', (_event, size: number) => store.setFontSize(size));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { finishingClose = false; createWindow(); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
