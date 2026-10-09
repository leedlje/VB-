import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { launch } from './electron.mjs';
import { writeEpub, writeMixedFixtures, writePdf } from './fixtures.mjs';

const choose = (app, paths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, paths);
const state = async (userData) => JSON.parse(await readFile(path.join(userData, 'reader-state', 'state.json'), 'utf8'));

// CDP supplies disk-backed native Files, rather than new File() or File.path
// mocks, so this exercises Electron webUtils through the isolated preload.
async function nativeDrag(client, page, paths, target = '#shelf', drop = true) {
  const box = await page.locator(target).boundingBox();
  assert.ok(box);
  const args = { x: box.x + box.width / 2, y: box.y + Math.min(100, box.height / 2), data: { items: [], files: paths, dragOperationsMask: 1 } };
  await client.send('Input.dispatchDragEvent', { ...args, type: 'dragEnter' });
  await client.send('Input.dispatchDragEvent', { ...args, type: 'dragOver' });
  if (drop) await client.send('Input.dispatchDragEvent', { ...args, type: 'drop' });
}

test('native file drops import a mixed batch, deduplicate, report errors and preserve sources across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-drop-e2e-'));
  const userData = path.join(dir, 'profile');
  const files = await writeMixedFixtures(dir);
  const txt = path.join(dir, '中文 小说.TXT');
  await rename(files.txt, txt);
  files.txt = txt;
  const invalid = path.join(dir, 'broken.epub');
  const brokenPdf = path.join(dir, 'broken.pdf');
  const emptyTxt = path.join(dir, 'empty.txt');
  const unsupported = path.join(dir, 'image.png');
  const folder = path.join(dir, 'folder.epub');
  await mkdir(folder);
  await Promise.all([writeFile(invalid, 'broken'), writeFile(brokenPdf, '%PDF-broken'), writeFile(emptyTxt, ''), writeFile(unsupported, 'not a book')]);
  const sources = Object.values(files);
  const originals = await Promise.all(sources.map(async (file) => ({ bytes: await readFile(file), mtime: (await stat(file)).mtimeMs })));
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await page.locator('#shelf').waitFor({ state: 'visible' });
    const client = await page.context().newCDPSession(page);
    // Hold the real handler briefly to verify busy UI and repeated-drop guard.
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('reader:drop-books');
      globalThis.releaseDrop = null;
      ipcMain.removeHandler('reader:drop-books');
      ipcMain.handle('reader:drop-books', async (...args) => {
        await new Promise((resolve) => { globalThis.releaseDrop = resolve; });
        return handler(...args);
      });
      globalThis.restoreDrop = () => { ipcMain.removeHandler('reader:drop-books'); ipcMain.handle('reader:drop-books', handler); };
    });
    await nativeDrag(client, page, [txt], '#shelf', false);
    assert.match(await page.locator('#shelf-drop-hint').textContent(), /松开即可导入/);
    assert.equal(await page.locator('#shelf-drop-hint').isVisible(), true);
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'shelf-drop.png') });
    // Nested child enter/leave must not dismiss the shelf highlight.
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([''], 'x.txt'));
      const child = document.getElementById('shelf-search');
      child.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
      child.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer }));
    });
    assert.equal(await page.locator('#shelf').evaluate((element) => element.classList.contains('drag-over')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#shelf-drop-hint').isVisible(), false);
    await nativeDrag(client, page, [txt, files.epub, files.pdf, txt, invalid, brokenPdf, emptyTxt, unsupported, folder]);
    await page.waitForFunction(() => document.getElementById('shelf').getAttribute('aria-busy') === 'true');
    assert.match(await page.locator('#shelf-drop-hint').textContent(), /正在导入/);
    await nativeDrag(client, page, [files.pdf]);
    await app.evaluate(() => { globalThis.releaseDrop(); globalThis.restoreDrop(); });
    await page.waitForFunction(() => !document.getElementById('shelf').hasAttribute('aria-busy'));
    assert.equal(await page.locator('.shelf-card').count(), 3);
    const message = await page.locator('#message').textContent();
    assert.match(message, /broken.epub.*损坏/);
    assert.match(message, /broken.pdf.*损坏/);
    assert.match(message, /empty.txt.*空/);
    assert.match(message, /image.png.*仅支持/);
    assert.match(message, /folder.epub.*普通文件/);
    assert.equal(await page.locator('#shelf-drop-hint').isVisible(), false);
    const ids = Object.keys((await state(userData)).books).sort();
    await nativeDrag(client, page, sources);
    await page.waitForFunction(() => document.getElementById('message').textContent === '书架已有 3 本所选书籍。');
    assert.deepEqual(Object.keys((await state(userData)).books).sort(), ids);
    // Imported books are usable through the original TXT/EPUB/PDF readers.
    await page.locator('.shelf-card').filter({ hasText: '中文 小说' }).locator('.shelf-title').click();
    assert.match(await page.locator('#content').textContent(), /中文 TXT/);
    await page.locator('#shelf-toggle').click();
    await page.locator('.shelf-card').filter({ hasText: '山海小书' }).locator('.shelf-title').click();
    await page.locator('#publication-view iframe').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#shelf-toggle').click();
    await page.locator('.shelf-card').filter({ hasText: 'PDF Sample' }).locator('.shelf-title').click();
    await page.locator('.pdf-canvas').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#shelf-toggle').click();
    await app.close();
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#shelf-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 3);
    assert.deepEqual(Object.keys((await state(userData)).books).sort(), ids);
    for (let index = 0; index < sources.length; index++) {
      assert.deepEqual(await readFile(sources[index]), originals[index].bytes);
      assert.equal((await stat(sources[index])).mtimeMs, originals[index].mtime);
    }
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('drop bridge rejects forged paths and memory Files; outside/text drops cannot import or navigate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-drop-security-'));
  const txt = path.join(dir, 'book.txt');
  await writeFile(txt, '正文');
  let app;
  try {
    app = await launch(path.join(dir, 'profile'));
    const page = await app.firstWindow();
    await page.locator('#shelf').waitFor({ state: 'visible' });
    for (const kind of ['string', 'object', 'virtual']) {
      const result = await page.evaluate(({ kind, txt }) => window.reader.importDroppedBooks(
        kind === 'string' ? [txt] : kind === 'object' ? [{ name: 'book.txt', path: txt }] : [Object.assign(new File(['正文'], 'book.txt'), { path: txt })]
      ), { kind, txt });
      assert.equal(result.added.length, 0);
      assert.equal(result.errors.length, 1);
    }
    const client = await page.context().newCDPSession(page);
    const url = page.url();
    await nativeDrag(client, page, [txt], '.toolbar');
    await page.locator('#shelf-search').evaluate((element) => {
      const dataTransfer = new DataTransfer(); dataTransfer.setData('text/uri-list', 'https://example.com/book.txt');
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
      element.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('Default navigation was not blocked');
    });
    assert.equal(page.url(), url);
    assert.equal(await page.locator('#shelf-drop-hint').isVisible(), false);
    assert.equal(await page.locator('.shelf-card').count(), 0);
    // A second Electron window with the same document/preload is still denied.
    await app.evaluate(async ({ BrowserWindow, app }, url) => {
      const win = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/preload.cjs`, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      await win.loadURL(url);
    }, url);
    const other = (await app.windows()).find((candidate) => candidate !== page);
    assert.ok(other);
    await other.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'security-file'; document.body.append(input); });
    await other.locator('#security-file').setInputFiles(txt);
    const rejected = await other.evaluate(() => window.reader.importDroppedBooks([document.getElementById('security-file').files[0]]));
    assert.equal(rejected.added.length, 0);
    assert.match(rejected.errors[0].message, /此窗口/);
    assert.equal((await page.evaluate(() => window.reader.listBooks())).length, 0);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('unified shelf imports TXT, EPUB and PDF, deduplicates and keeps original files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-shelf-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const files = await writeMixedFixtures(dir);
  const invalid = path.join(dir, 'broken.epub');
  await writeFile(invalid, 'broken');
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await choose(app, [files.txt, files.epub, files.pdf, invalid]);
    await page.locator('#import-books').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 3);
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'shelf.png') });
    assert.match(await page.locator('#message').textContent(), /broken.epub.*损坏/);
    assert.equal((await state(userData)).version, 5);
    assert.equal(Object.keys((await state(userData)).books).length, 3);
    assert.ok(await page.locator('.shelf-card').filter({ hasText: '山海小书' }).locator('img').count() === 1);
    await choose(app, [files.epub, files.pdf]);
    await page.locator('#import-books').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 3);
    assert.equal(Object.keys((await state(userData)).books).length, 3);
    await page.locator('#shelf-format').selectOption('epub');
    assert.equal(await page.locator('.shelf-card').count(), 1);
    await page.locator('#shelf-format').selectOption('all');
    await page.locator('#shelf-search').fill('山海');
    assert.equal(await page.locator('.shelf-card').count(), 1);
    await page.locator('#shelf-search').fill('');
    await page.locator('#shelf-sort').selectOption('title');
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 3);
    await page.locator('.shelf-card').filter({ hasText: 'novel' }).locator('button[aria-label^="移出"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 2);
    assert.equal(Object.keys((await state(userData)).books).length, 2);
    assert.match(await readFile(files.txt, 'utf8'), /中文 TXT/);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('EPUB chapter, image, search, bookmark and CFI survive restart; book scripts stay isolated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-epub-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  let remoteRequests = 0;
  const server = createServer((_request, response) => { remoteRequests++; response.writeHead(200, { 'content-type': 'image/png' }); response.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const filePath = await writeEpub(path.join(dir, 'story.epub'), { malicious: true, longFirst: true, remoteUrl: `http://127.0.0.1:${address.port}/tracker.png` });
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await choose(app, [filePath]);
    await page.locator('#import-books').click();
    await page.locator('.shelf-title').click();
    await page.locator('#publication-view iframe').first().waitFor({ state: 'visible', timeout: 15000 });
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'epub.png') });
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('%'));
    assert.equal(await page.evaluate(() => window.hacked ?? false), false);
    assert.equal(remoteRequests, 0);
    assert.ok(await page.frameLocator('#publication-view iframe').first().locator('img[alt="封面插图"]').count() > 0);
    await page.locator('#chapters-toggle').click();
    assert.equal(await page.locator('#chapters-list li').count(), 2);
    await page.locator('#chapters-list li button').last().click();
    await page.waitForFunction(() => document.getElementById('progress').textContent !== '0%');
    await page.locator('#bookmarks-toggle').click();
    await page.locator('#bookmark-add').click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 1);
    await page.waitForFunction(async () => {
      const books = await window.reader.listBooks();
      return books[0]?.position.format === 'epub' && books[0].position.cfi.startsWith('epubcfi(');
    });
    let saved;
    for (let attempt = 0; attempt < 40; attempt++) {
      saved = (await state(userData)).books;
      if (Object.values(saved)[0]?.position.cfi) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const record = Object.values(saved)[0];
    assert.equal(record.position.format, 'epub');
    assert.match(record.position.cfi, /^epubcfi\(/);
    assert.equal(record.bookmarks[0].position.format, 'epub');
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('星辰');
    await page.waitForFunction(() => /1 \/ 2/.test(document.getElementById('search-count').textContent), { timeout: 15000 });
    await page.locator('#search-next').click();
    await app.close();
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#publication-view iframe').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('EPUB scrolls vertically with the mouse wheel and places page controls below the reader', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-epub-scroll-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const filePath = await writeEpub(path.join(dir, 'long-story.epub'), { long: true });
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await choose(app, [filePath]);
    await page.locator('#import-books').click();
    await page.locator('.shelf-title').click();
    const scroll = page.locator('#publication-view .epub-container');
    await scroll.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#publication-view .epub-container').scrollHeight > document.querySelector('#publication-view .epub-container').clientHeight);
    const metrics = await scroll.evaluate((element) => ({ overflowY: getComputedStyle(element).overflowY, overflowX: getComputedStyle(element).overflowX, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    assert.equal(metrics.overflowY, 'scroll');
    assert.equal(metrics.overflowX, 'hidden');
    assert.ok(metrics.scrollHeight > metrics.clientHeight);
    const footer = await page.locator('#publication-footer').boundingBox();
    const reader = await page.locator('.reader-layout').boundingBox();
    assert.ok(footer && reader && footer.y >= reader.y + reader.height - 1);
    assert.equal(await page.locator('#publication-controls').isVisible(), false);
    const initial = await scroll.evaluate((element) => element.scrollTop);
    const box = await scroll.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    await page.waitForFunction((start) => document.querySelector('#publication-view .epub-container').scrollTop > start, initial);
    assert.equal(await scroll.evaluate((element) => element.scrollLeft), 0);
    const afterWheel = await scroll.evaluate((element) => element.scrollTop);
    await page.locator('#publication-next').click();
    await page.waitForFunction((start) => document.querySelector('#publication-view .epub-container').scrollTop > start, afterWheel);
    const afterNext = await scroll.evaluate((element) => element.scrollTop);
    await page.locator('#publication-prev').click();
    await page.waitForFunction((start) => document.querySelector('#publication-view .epub-container').scrollTop < start, afterNext);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 20 && Number.parseInt(await page.locator('#progress').textContent(), 10) < 50; index++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(() => Number.parseInt(document.getElementById('progress').textContent, 10) >= 50);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF page, zoom, search, bookmark and position survive restart; scanned PDF explains search limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-pdf-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const pdf = await writePdf(path.join(dir, 'manual.pdf'));
  const scan = await writePdf(path.join(dir, 'scan.pdf'), { scanned: true, pages: 1, title: 'Scanned PDF' });
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await choose(app, [pdf, scan]);
    await page.locator('#import-books').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 2);
    await page.locator('.shelf-card').filter({ hasText: 'PDF Sample' }).first().locator('.shelf-title').click();
    await page.locator('.pdf-canvas').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('#annotations-toggle').isDisabled(), true);
    await page.waitForFunction(() => document.getElementById('pdf-total').textContent === '3');
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'pdf.png') });
    assert.equal(await page.locator('#pdf-total').textContent(), '3');
    const pdfScroll = page.locator('.pdf-scroll');
    await page.waitForFunction(() => {
      const element = document.querySelector('.pdf-scroll');
      return element.scrollHeight > element.clientHeight;
    });
    const pdfBox = await pdfScroll.boundingBox();
    await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2);
    await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => document.querySelector('.pdf-scroll').scrollTop > 0);
    assert.match(await page.locator('#progress').textContent(), /第 1 \/ 3 页/);
    await pdfScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 2 / 3'));
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -350);
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 1 / 3'));
    assert.ok(await pdfScroll.evaluate((element) => element.scrollTop > 0));
    await page.locator('#pdf-page').fill('2');
    await page.locator('#pdf-page').press('Tab');
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 2 / 3'));
    await page.locator('#pdf-fit-page').click();
    await page.waitForFunction(() => {
      const element = document.querySelector('.pdf-scroll');
      return element.scrollHeight <= element.clientHeight + 1;
    });
    await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 3 / 3'));
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -350);
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 2 / 3'));
    await page.locator('#pdf-fit-width').click();
    await page.locator('#pdf-zoom-in').click();
    await page.locator('#bookmarks-toggle').click();
    await page.locator('#bookmark-add').click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 1);
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('lighthouse');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 3', { timeout: 15000 });
    await app.close();
    const books = Object.values((await state(userData)).books);
    const saved = books.find((book) => book.path === pdf);
    assert.equal(saved.position.page, 1); // search jumps to first matching page
    assert.equal(saved.bookmarks[0].position.page, 2);
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('.pdf-canvas').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#shelf-toggle').click();
    await page.locator('.shelf-card').filter({ hasText: 'Scanned PDF' }).locator('.shelf-title').click();
    await page.locator('.pdf-canvas').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('anything');
    await page.waitForFunction(() => document.getElementById('search-count').textContent.includes('没有可搜索的文字层'), { timeout: 15000 });
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('version 3 TXT profile opens in renamed app with progress, bookmark and settings intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-upgrade-e2e-'));
  const userData = path.join(dir, 'profile');
  const stateDir = path.join(userData, 'reader-state');
  await mkdir(stateDir, { recursive: true });
  const txt = path.join(dir, 'old.txt');
  await writeFile(txt, ('旧版阅读内容。'.repeat(10) + '\n').repeat(200));
  const original = { version: 3, lastFile: txt, fontSize: 22, theme: 'sepia', lineHeight: 2.1, contentWidth: 900, files: {
    [txt]: { path: txt, encoding: 'utf8', offset: 1200, length: 18200, modifiedAt: 0, recentAt: 12345, bookmarks: [{ id: 'old-mark', offset: 900, createdAt: 123 }] },
  } };
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(original));
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await page.locator('#content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#book-title').textContent(), 'old.txt');
    assert.match(await page.title(), /VB阅读器/);
    assert.equal(await page.locator('#theme').inputValue(), 'sepia');
    assert.equal(await page.locator('#font-size').textContent(), '22');
    await page.locator('#layout-toggle').click();
    assert.equal(await page.locator('#line-height').textContent(), '2.1');
    assert.equal(await page.locator('#content-width').textContent(), '900 px');
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
    const migrated = await state(userData);
    assert.equal(migrated.version, 5);
    assert.equal(Object.values(migrated.books)[0].bookmarks[0].id, 'old-mark');
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'state.json.v3.bak'), 'utf8')).version, 3);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('moved EPUB reports the missing file and relinks without changing its book ID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-relink-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const oldPath = await writeEpub(path.join(dir, 'old.epub'));
  const newPath = path.join(dir, 'new.epub');
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await choose(app, [oldPath]);
    await page.locator('#import-books').click();
    await page.locator('.shelf-card').waitFor();
    const id = Object.keys((await state(userData)).books)[0];
    await rename(oldPath, newPath);
    await page.locator('.shelf-title').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('文件已不存在'));
    await choose(app, [newPath]);
    await page.locator('button[aria-label^="重新定位 山海小书"]').click();
    await page.locator('#publication-view iframe').first().waitFor({ state: 'visible', timeout: 15000 });
    const migrated = await state(userData);
    assert.equal(Object.keys(migrated.books)[0], id);
    assert.equal(migrated.books[id].path, newPath);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
