import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import iconv from 'iconv-lite';
import { _electron as electron } from 'playwright-core';

const packaged = Boolean(process.env.READER_PACKAGED_EXE);
const executablePath = path.resolve(process.env.READER_PACKAGED_EXE || 'node_modules/electron/dist/electron.exe');

async function launch(userData) {
  return electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: process.cwd(), env: { ...process.env, READER_TEST_USER_DATA: userData } });
}

async function waitForSavedOffset(statePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (Object.values(state.files).some((record) => record.offset > 0)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return JSON.parse(await readFile(statePath, 'utf8'));
}

test('real Electron window opens TXT, switches encoding, saves progress and restores on restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const utf8 = path.join(dir, 'book.txt');
  const gb = path.join(dir, 'gb.txt');
  await writeFile(utf8, Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行：中文阅读测试。`.repeat(5)).join('\n'));
  await writeFile(gb, iconv.encode('简体中文\n下一行', 'gb18030'));
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await page.locator('#open').waitFor();
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, utf8);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#book-title').textContent(), 'book.txt');
    assert.match(await page.locator('#content').textContent(), /第 1 行：中文阅读测试/);
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1800; });
    const before = await waitForSavedOffset(path.join(userData, 'reader-state', 'state.json'));
    assert.ok(Object.values(before.files)[0].offset > 0, 'scroll must save a character offset');
    await page.locator('#larger').click();
    await page.waitForFunction(() => document.getElementById('font-size').textContent === '20');
    assert.equal(await page.locator('#font-size').textContent(), '20');
    await app.close();

    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('viewport').scrollTop > 100);
    assert.equal(await page.locator('#book-title').textContent(), 'book.txt');
    assert.equal(await page.locator('#font-size').textContent(), '20');
    assert.ok(await page.locator('#viewport').evaluate((element) => element.scrollTop > 100), 'reading position must restore');
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, gb);
    await page.locator('#open').click();
    await page.locator('#encoding').selectOption('gb18030');
    await page.waitForFunction(() => document.getElementById('content').textContent === '简体中文\n下一行');
    assert.equal(await page.locator('#content').textContent(), '简体中文\n下一行');
    await app.close();

    await rm(gb);
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#message').waitFor({ state: 'visible' });
    assert.match(await page.locator('#message').textContent(), /文件已不存在/);
    assert.equal(await page.locator('#empty').isVisible(), true);
    await app.close();
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('a multi-megabyte TXT remains scrollable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-large-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const filePath = path.join(dir, 'large.txt');
  await writeFile(filePath, ('较长的中文段落，用于检查整文件读取和滚动。'.repeat(5) + '\n').repeat(20000));
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, filePath);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible', timeout: 15000 });
    assert.ok((await page.locator('#content').textContent()).length > 2_000_000);
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 100000; });
    await page.waitForFunction(() => Number.parseInt(document.getElementById('progress').textContent) > 0);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('recent reading, search, bookmarks and theme work in the Electron window', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-features-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const filePath = path.join(dir, 'features.txt');
  const original = Array.from({ length: 160 }, (_, i) => `第${i}行：中文测试与阅读。`).join('\n');
  await writeFile(filePath, original);
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, filePath);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('中文测试');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 160');
    await page.locator('#search-next').click();
    assert.equal(await page.locator('#search-count').textContent(), '2 / 160');
    await page.locator('#search-input').fill('不存在的词');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '没有结果');
    await page.locator('#bookmarks-toggle').click();
    await page.locator('#bookmark-add').click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 1);
    await page.locator('#theme').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.locator('#recent-toggle').click();
    await page.waitForFunction(() => document.getElementById('recent-list').textContent.includes('features.txt'));
    await app.close();

    const changed = original.replace('第0行', '第A行');
    await writeFile(filePath, changed);
    const later = new Date(Date.now() + 10_000);
    await utimes(filePath, later, later);

    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('可能不再精确'));
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
    await page.locator('#bookmarks-list li button').first().click();
    await page.locator('#bookmarks-list li button').last().click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 0);
    await page.locator('#recent-toggle').click();
    await page.locator('#recent-list li button').last().click();
    await page.locator('#empty').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#recent-list li').length === 0);
    await page.waitForTimeout(500);
    const state = JSON.parse(await readFile(path.join(userData, 'reader-state', 'state.json'), 'utf8'));
    assert.deepEqual(state.files, {});
    assert.equal(state.lastFile, null);
    assert.equal(await readFile(filePath, 'utf8'), changed);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('moved TXT can be relinked without losing its old record on canceled or invalid choices', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-relink-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const oldPath = path.join(dir, 'old.txt');
  const movedPath = path.join(dir, 'moved.txt');
  const otherPath = path.join(dir, 'other.txt');
  const invalidPath = path.join(dir, 'invalid.pdf');
  const text = ('中文阅读记录测试。'.repeat(8) + '\n').repeat(300);
  await writeFile(oldPath, text);
  await writeFile(otherPath, '另一份书');
  await writeFile(invalidPath, '不是 TXT');
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, otherPath);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible' });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, oldPath);
    await page.locator('#open').click();
    await page.waitForFunction(() => document.getElementById('book-title').textContent === 'old.txt');
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1600; });
    await waitForSavedOffset(path.join(userData, 'reader-state', 'state.json'));
    await page.locator('#bookmarks-toggle').click();
    await page.locator('#bookmark-add').click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 1);
    await app.close();

    await rename(oldPath, movedPath);
    await writeFile(movedPath, `${text}追加内容`);
    app = await launch(userData);
    page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('文件已不存在'));
    await page.locator('#recent-toggle').click();
    const oldItem = page.locator('#recent-list li').filter({ hasText: 'old.txt' });
    await oldItem.waitFor();
    const relocate = oldItem.locator('button[aria-label^="重新定位"]');
    const statePath = path.join(userData, 'reader-state', 'state.json');
    const original = JSON.parse(await readFile(statePath, 'utf8'));

    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await relocate.click();
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), original);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, invalidPath);
    await relocate.click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('请选择 TXT'));
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), original);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, otherPath);
    await relocate.click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('已有阅读记录'));
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), original);

    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, movedPath);
    await relocate.click();
    await page.waitForFunction(() => document.getElementById('book-title').textContent === 'moved.txt');
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('可能不再精确'));
    const migrated = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.values(migrated.files).some((record) => record.path === oldPath), false);
    const movedRecord = Object.values(migrated.files).find((record) => record.path === movedPath);
    assert.equal(movedRecord.bookmarks.length, 1);
    assert.equal(migrated.lastFile, movedPath);
    assert.ok(movedRecord.offset > 0);
    assert.equal(await readFile(movedPath, 'utf8'), `${text}追加内容`);
    await app.close();

    app = await launch(userData);
    page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('book-title').textContent === 'moved.txt');
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('keyboard shortcuts and layout settings survive restart and narrow windows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-shortcuts-e2e-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const filePath = path.join(dir, 'shortcut.txt');
  await writeFile(filePath, ('中文目标测试行。'.repeat(5) + '\n').repeat(350));
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await page.locator('#open').waitFor();
    await page.waitForLoadState('load');
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, filePath);
    await page.keyboard.press('Control+o');
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('progress').textContent !== '');
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1500; });
    await page.waitForFunction(() => document.getElementById('viewport').scrollTop > 1000);
    const statePath = path.join(userData, 'reader-state', 'state.json');
    const before = Object.values((await waitForSavedOffset(statePath)).files)[0].offset;
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('#search-input').evaluate((element) => element === document.activeElement), true);
    await page.locator('#search-input').fill('目标');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 1750');
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#search-count').textContent(), '2 / 1750');
    await page.keyboard.press('Shift+F3');
    assert.equal(await page.locator('#search-count').textContent(), '1 / 1750');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('找不到');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '没有结果');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#searchbar').isHidden(), true);
    assert.equal(await page.locator('#viewport').evaluate((element) => element === document.activeElement), true);
    const composed = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
      return document.dispatchEvent(event);
    });
    assert.equal(composed, true);
    assert.equal(await page.locator('#searchbar').isHidden(), true);
    await page.locator('#recent-toggle').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#recent-panel').isHidden(), true);

    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1800; });
    await page.waitForFunction(() => Number.parseInt(document.getElementById('progress').textContent) > 0);
    await page.waitForTimeout(450);
    const anchorBefore = Object.values(JSON.parse(await readFile(statePath, 'utf8')).files)[0].offset;

    await page.locator('#layout-toggle').click();
    await page.locator('#line-larger').click();
    await page.waitForFunction(() => document.getElementById('line-height').textContent === '2.1');
    await page.locator('#width-smaller').click();
    await page.waitForFunction(() => document.getElementById('content-width').textContent === '740 px');
    const after = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(after.lineHeight, 2.1);
    assert.equal(after.contentWidth, 740);
    assert.ok(before > 0, `scroll progress offset=${before}`);
    await page.waitForTimeout(450);
    const anchorAfter = Object.values(JSON.parse(await readFile(statePath, 'utf8')).files)[0].offset;
    assert.ok(Math.abs(anchorAfter - anchorBefore) < 200, `layout moved reading anchor from ${anchorBefore} to ${anchorAfter}`);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(620, 700); });
    await page.waitForFunction(() => window.innerWidth < 700);
    await page.waitForTimeout(550);
    const afterResize = Object.values(JSON.parse(await readFile(statePath, 'utf8')).files)[0].offset;
    assert.ok(Math.abs(afterResize - anchorAfter) < 200, `resize moved reading anchor from ${anchorAfter} to ${afterResize}`);
    const bounds = await page.locator('#content').evaluate((element) => {
      const content = element.getBoundingClientRect();
      const viewport = document.getElementById('viewport').getBoundingClientRect();
      return { contentRight: content.right, viewportRight: viewport.right, contentWidth: content.width };
    });
    assert.ok(bounds.contentRight <= bounds.viewportRight + 1);
    assert.ok(bounds.contentWidth <= 620);
    await app.close();

    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.locator('#layout-toggle').click();
    assert.equal(await page.locator('#line-height').textContent(), '2.1');
    assert.equal(await page.locator('#content-width').textContent(), '740 px');
    assert.ok(await page.locator('#viewport').evaluate((element) => element.scrollTop > 0));
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('relinking the active GB18030 book switches later progress writes to the new path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-active-relink-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const oldPath = path.join(dir, 'old.txt');
  const newPath = path.join(dir, 'new.txt');
  const bytes = iconv.encode(('简体中文阅读。'.repeat(5) + '\n').repeat(250), 'gb18030');
  await writeFile(oldPath, bytes);
  await writeFile(newPath, bytes);
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, oldPath);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.locator('#encoding').selectOption('gb18030');
    await page.waitForFunction(() => document.getElementById('content').textContent.startsWith('简体中文'));
    await page.locator('#recent-toggle').click();
    await page.waitForFunction(() => document.getElementById('recent-list').textContent.includes('old.txt'));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, newPath);
    await page.locator('#recent-list button[aria-label^="重新定位"]').click();
    await page.waitForFunction(() => document.getElementById('book-title').textContent === 'new.txt');
    assert.equal(await page.locator('#encoding').inputValue(), 'gb18030');
    await page.waitForFunction(() => document.getElementById('progress').textContent !== '');
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1200; });
    const statePath = path.join(userData, 'reader-state', 'state.json');
    const state = await waitForSavedOffset(statePath);
    assert.equal(Object.values(state.files).length, 1);
    assert.equal(Object.values(state.files)[0].path, newPath);
    assert.ok(Object.values(state.files)[0].offset > 0);
    await app.close();
    const closed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.values(closed.files).length, 1);
    assert.equal(Object.values(closed.files)[0].path, newPath);
    assert.deepEqual(await readFile(oldPath), bytes);
    assert.deepEqual(await readFile(newPath), bytes);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
