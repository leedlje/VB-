import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import path from 'node:path';
import { mkdir, open, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { BookError, normalizedKey, readBook } from './book.ts';
import { inspectBook, formatForPath } from './inspect.ts';
import { StateStore } from './state.ts';
import { clampOffset, type BookPosition, type Encoding, type ImportResult, type OpenResult, type PublicationResult, type Theme } from '../shared/types.ts';

const baseDir = __dirname;
let window: BrowserWindow | null = null;
let store: StateStore;
let currentPath: string | null = null;
let currentBookId: string | null = null;
let finishingClose = false;

protocol.registerSchemesAsPrivileged([{ scheme: 'vbbook', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.setPath('userData', process.env.READER_TEST_USER_DATA || path.join(app.getPath('appData'), 'local-txt-reader'));
const coverDir = () => path.join(app.getPath('userData'), 'reader-state', 'covers');

async function importPaths(paths: string[]): Promise<ImportResult> {
  const result: ImportResult = { added: [], errors: [] };
  for (const filePath of paths) {
    try {
      const existing = store.byPath(filePath);
      if (existing) { result.added.push(existing); continue; }
      const inspected = await inspectBook(filePath);
      let book = await store.importBook(inspected.record);
      if (inspected.cover) {
        try {
          await mkdir(coverDir(), { recursive: true });
          await writeFile(path.join(coverDir(), book.id), inspected.cover.bytes);
          const mimePath = path.join(coverDir(), `${book.id}.mime`);
          await writeFile(mimePath, inspected.cover.mime, 'utf8');
          await store.setCoverKey(book.id, book.id);
          book = store.book(book.id)!;
        } catch { /* default cover stays usable */ }
      }
      result.added.push(book);
    } catch (error) {
      result.errors.push({ path: filePath, message: error instanceof BookError ? error.message : '导入失败，请检查文件。' });
    }
  }
  return result;
}
async function chooseBooks(): Promise<ImportResult | null> {
  if (!window) return null;
  const choice = await dialog.showOpenDialog(window, {
    title: '导入书籍', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '电子书', extensions: ['txt', 'epub', 'pdf'] }],
  });
  return choice.canceled ? null : importPaths(choice.filePaths);
}
async function openPublication(id: string): Promise<PublicationResult> {
  const book = typeof id === 'string' ? store.book(id) : undefined;
  if (!book) return { ok: false, message: '书籍记录不存在。' };
  try {
    if (formatForPath(book.path) !== book.format) throw new BookError('文件格式与书架记录不一致，请重新定位。');
    const info = await stat(book.path);
    if (!info.isFile()) throw new BookError('请选择普通文件。');
    if (book.format === 'pdf') {
      const handle = await open(book.path, 'r');
      try {
        const signature = Buffer.alloc(5);
        await handle.read(signature, 0, 5, 0);
        if (signature.toString() !== '%PDF-') throw new BookError('PDF 文件损坏或格式不正确。');
      } finally { await handle.close(); }
    } else {
      const inspected = await inspectBook(book.path);
      if (inspected.record.format !== book.format) throw new BookError('文件格式与书架记录不一致，请重新定位。');
    }
    currentBookId = id;
    currentPath = book.format === 'txt' ? book.path : null;
    const touched = await store.touch(id);
    return { ok: true, book: touched, url: `vbbook://book/${encodeURIComponent(id)}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, message: error instanceof BookError ? error.message :
      code === 'ENOENT' ? '文件已不存在，请重新定位或移出书架。' :
      code === 'EACCES' ? '无法读取文件，请检查文件权限。' : '打开书籍失败，请检查文件。' };
  }
}
async function relocateBook(id: string): Promise<PublicationResult | null> {
  if (!window) return null;
  const old = store.book(id);
  if (!old) return { ok: false, message: '找不到原阅读记录。' };
  const choice = await dialog.showOpenDialog(window, {
    title: '重新定位书籍', properties: ['openFile'],
    filters: [{ name: old.format.toUpperCase(), extensions: [old.format] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const newPath = choice.filePaths[0];
  try {
    if (formatForPath(newPath) !== old.format) throw new BookError('新文件格式与原书籍不一致。');
    const inspected = await inspectBook(newPath);
    await store.relocateBook(id, newPath, inspected.record.size, inspected.record.modifiedAt, inspected.record.title, inspected.record.author);
    return openPublication(id);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '重新定位失败，原记录已保留。' };
  }
}
async function coverData(id: string): Promise<string | null> {
  const key = store.book(id)?.coverKey;
  if (!key) return null;
  try {
    const [bytes, mime] = await Promise.all([readFile(path.join(coverDir(), key)), readFile(path.join(coverDir(), `${key}.mime`), 'utf8')]);
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}

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
    currentBookId = store.byPath(filePath)?.id ?? null;
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
  if (normalizedKey(newPath) !== normalizedKey(oldPath) && store.byPath(newPath)) {
    return { ok: false, message: '新路径已有阅读记录，请先处理该记录。' };
  }
  try {
    const content = await readBook(newPath, previous.encoding);
    const modifiedAt = (await stat(newPath)).mtimeMs;
    const changed = Boolean(previous.length && (previous.length !== content.length || (previous.modifiedAt && previous.modifiedAt !== modifiedAt)));
    const record = await store.relocateFile(oldPath, newPath, content.length, modifiedAt);
    currentPath = newPath;
    currentBookId = store.byPath(newPath)?.id ?? null;
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
    width: 1120, height: 790, minWidth: 580, minHeight: 400,
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
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const external = /^https?:/i.test(details.url);
    const localDev = Boolean(process.env.READER_DEV_URL) && details.url.startsWith(process.env.READER_DEV_URL!);
    let outsideApp = false;
    if (details.url.startsWith('file:')) {
      try {
        const relative = path.relative(path.join(baseDir, 'renderer'), fileURLToPath(details.url));
        outsideApp = relative.startsWith('..') || path.isAbsolute(relative);
      } catch { outsideApp = true; }
    }
    callback({ cancel: (external && !localDev) || outsideApp });
  });
  protocol.handle('vbbook', async (request) => {
    const url = new URL(request.url);
    const id = url.hostname === 'book' ? decodeURIComponent(url.pathname.slice(1)) : '';
    const book = store.book(id);
    if (!book || book.format !== 'pdf') return new Response('Not found', { status: 404 });
    try {
      const info = await stat(book.path);
      const range = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.get('range') ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
      if (!info.isFile() || start < 0 || start >= info.size || end < start) return new Response(null, { status: 416 });
      const stream = createReadStream(book.path, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': 'application/pdf', 'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        },
      });
    } catch { return new Response('File unavailable', { status: 404 }); }
  });
  ipcMain.handle('reader:restore', () => {
    const last = store.book(store.snapshot().lastBookId ?? '');
    return last?.format === 'txt' ? openFile(last.path) : null;
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
    if (currentBookId === store.byPath(filePath)?.id) currentBookId = null;
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
  ipcMain.handle('reader:choose-books', chooseBooks);
  ipcMain.handle('reader:list-books', () => store.listBooks());
  ipcMain.handle('reader:last-book-id', () => store.snapshot().lastBookId);
  ipcMain.handle('reader:startup-warning', () => store.loadWarning());
  ipcMain.handle('reader:open-publication', (_event, id: string) => openPublication(id));
  ipcMain.handle('reader:read-publication', async (_event, id: string) => {
    const book = store.book(id);
    if (!book || book.id !== currentBookId || book.format !== 'epub') throw new Error('这本书尚未打开。');
    return new Uint8Array(await readFile(book.path));
  });
  ipcMain.handle('reader:book-position', (_event, id: string, position: BookPosition) => {
    if (id !== currentBookId || !position || store.book(id)?.format !== position.format) throw new Error('没有正在阅读的书籍。');
    return store.savePosition(id, position);
  });
  ipcMain.handle('reader:add-book-mark', (_event, id: string, position: BookPosition) => {
    if (id !== currentBookId || !position || store.book(id)?.format !== position.format) throw new Error('没有正在阅读的书籍。');
    return store.addBookBookmark(id, position);
  });
  ipcMain.handle('reader:remove-book-mark', (_event, id: string, markId: string) => {
    if (id !== currentBookId) throw new Error('没有正在阅读的书籍。');
    return store.removeBookBookmark(id, markId);
  });
  ipcMain.handle('reader:remove-book', async (_event, id: string) => {
    const key = store.book(id)?.coverKey;
    if (currentBookId === id) { currentBookId = null; currentPath = null; }
    await store.removeBook(id);
    if (key) await Promise.allSettled([rm(path.join(coverDir(), key), { force: true }), rm(path.join(coverDir(), `${key}.mime`), { force: true })]);
  });
  ipcMain.handle('reader:relocate-book', (_event, id: string) => relocateBook(id));
  ipcMain.handle('reader:cover-data', (_event, id: string) => coverData(id));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { finishingClose = false; createWindow(); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
