import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
