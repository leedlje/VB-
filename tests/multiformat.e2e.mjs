import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright-core';
import { writeEpub, writeMixedFixtures, writePdf } from './fixtures.mjs';

const packaged = Boolean(process.env.READER_PACKAGED_EXE);
const executablePath = path.resolve(process.env.READER_PACKAGED_EXE || 'node_modules/electron/dist/electron.exe');
const launch = (userData) => electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: process.cwd(), env: { ...process.env, READER_TEST_USER_DATA: userData } });
const choose = (app, paths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, paths);
const state = async (userData) => JSON.parse(await readFile(path.join(userData, 'reader-state', 'state.json'), 'utf8'));

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
    assert.equal((await state(userData)).version, 4);
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
  const filePath = await writeEpub(path.join(dir, 'story.epub'), { malicious: true, remoteUrl: `http://127.0.0.1:${address.port}/tracker.png` });
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await choose(app, [filePath]);
    await page.locator('#import-books').click();
    await page.locator('.shelf-title').click();
    await page.locator('#publication-view iframe').waitFor({ state: 'visible', timeout: 15000 });
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'epub.png') });
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('%'));
    assert.equal(await page.evaluate(() => window.hacked ?? false), false);
    assert.equal(remoteRequests, 0);
    assert.ok(await page.frameLocator('#publication-view iframe').locator('img[alt="封面插图"]').count() > 0);
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
    await page.locator('#publication-view iframe').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
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
    await page.waitForFunction(() => document.getElementById('pdf-total').textContent === '3');
    if (process.env.VB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VB_SCREENSHOT_DIR, 'pdf.png') });
    assert.equal(await page.locator('#pdf-total').textContent(), '3');
    await page.locator('#pdf-page').fill('2');
    await page.locator('#pdf-page').press('Tab');
    await page.waitForFunction(() => document.getElementById('progress').textContent.includes('第 2 / 3'));
    await page.locator('#pdf-fit-page').click();
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
    assert.equal(migrated.version, 4);
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
    await page.locator('#publication-view iframe').waitFor({ state: 'visible', timeout: 15000 });
    const migrated = await state(userData);
    assert.equal(Object.keys(migrated.books)[0], id);
    assert.equal(migrated.books[id].path, newPath);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
