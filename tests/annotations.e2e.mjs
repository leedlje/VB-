import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import { writeEpub } from './fixtures.mjs';

const executablePath = path.resolve(process.env.READER_PACKAGED_EXE || 'node_modules/electron/dist/electron.exe');
const launch = (userData) => electron.launch({ executablePath, args: process.env.READER_PACKAGED_EXE ? [] : ['.'], cwd: process.cwd(), env: { ...process.env, READER_TEST_USER_DATA: userData } });
const choose = (app, paths) => app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, paths);
const state = async (userData) => JSON.parse(await readFile(path.join(userData, 'reader-state', 'state.json'), 'utf8'));

test('TXT selection creates, edits, deletes and restores isolated annotations without changing source', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-annotations-txt-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const first = path.join(dir, 'first.txt');
  const second = path.join(dir, 'second.txt');
  const source = '序章。海边的灯塔照亮归途。\n另一段，适合写想法。';
  await writeFile(first, source);
  await writeFile(second, '第二本书，不应看到第一本的标注。');
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await choose(app, [first, second]);
    await page.locator('#import-books').click();
    await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length === 2);
    const ids = await page.evaluate(() => window.reader.listBooks());
    const firstId = ids.find((book) => book.path === first).id;
    const secondId = ids.find((book) => book.path === second).id;
    await page.locator(`.shelf-card[data-book-id="${firstId}"] .shelf-title`).click();
    await page.locator('#content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#annotations-toggle').isEnabled(), true);
    const select = (phrase) => page.locator('#content').evaluate((node, text) => {
      const start = node.textContent.indexOf(text);
      const range = document.createRange();
      range.setStart(node.firstChild, start);
      range.setEnd(node.firstChild, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, phrase);
    await select('海边的灯塔');
    await page.locator('#selection-actions').waitFor({ state: 'visible' });
    await page.locator('#selection-note').click();
    await page.locator('#annotation-note').fill('先取消');
    await page.locator('#annotation-cancel').click();
    assert.equal(Object.values((await state(userData)).books).find((book) => book.path === first).annotations.length, 0);
    await select('海边的灯塔');
    await page.locator('#selection-note').click();
    await page.locator('#annotation-note').fill('灯塔笔记');
    await page.locator('#annotation-save').click();
    await page.locator('#annotations-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('#annotations-list li').length === 1);
    assert.match(await page.locator('#annotations-list').textContent(), /灯塔笔记/);
    assert.equal(await page.evaluate(() => CSS.highlights.get('annotation-marks')?.size), 1);
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('灯塔');
    await page.waitForFunction(() => CSS.highlights.has('search-results'));
    assert.equal(await page.evaluate(() => CSS.highlights.has('annotation-marks')), true);
    await page.locator('#annotations-list li button').filter({ hasText: '查看 / 编辑' }).click();
    await page.locator('#annotation-note').fill('修改后的想法');
    const statePath = path.join(userData, 'reader-state', 'state.json');
    const savedState = await readFile(statePath);
    await rm(statePath);
    await mkdir(statePath);
    await page.locator('#annotation-save').click();
    assert.equal(await page.locator('#annotation-editor').isVisible(), true);
    assert.equal(await page.locator('#annotation-note').inputValue(), '修改后的想法');
    assert.match(await page.locator('#message').textContent(), /输入内容已保留/);
    await rm(statePath, { recursive: true });
    await writeFile(statePath, savedState);
    await page.locator('#annotation-save').click();
    await page.waitForFunction(() => document.getElementById('annotations-list').textContent.includes('修改后的想法'));
    await page.locator('#shelf-toggle').click();
    await page.locator(`.shelf-card[data-book-id="${secondId}"] .shelf-title`).click();
    await page.locator('#annotations-toggle').click();
    assert.equal(await page.locator('#annotations-list li').count(), 0);
    await app.close();
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#shelf-toggle').click();
    await page.locator(`.shelf-card[data-book-id="${firstId}"] .shelf-title`).click();
    await page.locator('#annotations-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('#annotations-list li').length === 1);
    assert.match(await page.locator('#annotations-list').textContent(), /修改后的想法/);
    await page.locator('#annotations-list li button').filter({ hasText: '跳转' }).click();
    await page.locator('#annotations-list li button').filter({ hasText: '删除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#annotations-list li').length === 0);
    assert.equal(await page.evaluate(() => CSS.highlights.get('annotation-marks')?.size), 0);
    assert.equal(await readFile(first, 'utf8'), source);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('EPUB selection uses CFI and restores highlight and note after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-annotations-epub-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const epub = await writeEpub(path.join(dir, 'story.epub'));
  const original = await readFile(epub);
  let app;
  try {
    app = await launch(userData);
    let page = await app.firstWindow();
    await choose(app, [epub]);
    await page.locator('#import-books').click();
    await page.locator('.shelf-title').click();
    const paragraph = page.frameLocator('#publication-view iframe').first().locator('p').first();
    await paragraph.waitFor({ state: 'visible', timeout: 15000 });
    await paragraph.evaluate((node) => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 4);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.locator('#selection-actions').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#selection-highlight').click();
    await page.locator('#annotations-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('#annotations-list li').length === 1);
    const record = Object.values((await state(userData)).books)[0];
    assert.match(record.annotations[0].anchor.cfi, /^epubcfi\(/);
    assert.equal(record.annotations[0].text, '山海故事');
    assert.equal(record.annotations[0].status, 'anchored');
    await page.waitForFunction(() => document.querySelectorAll('#publication-view [ref="annotation-highlight"]').length > 0, null, { timeout: 5000 });
    await page.locator('#theme').selectOption('dark');
    await page.locator('#larger').click();
    await page.locator('#chapters-toggle').click();
    await page.locator('#chapters-list li button').last().click();
    await page.locator('#chapters-list li button').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#publication-view [ref="annotation-highlight"]').length > 0);
    await page.locator('#publication-view [ref="annotation-highlight"]').first().click({ force: true });
    await page.locator('#annotation-editor').waitFor({ state: 'visible' });
    await page.locator('#annotation-cancel').click();
    await page.locator('#annotations-list li button').filter({ hasText: '写想法' }).click();
    await page.locator('#annotation-note').fill('EPUB 想法');
    await page.locator('#annotation-save').click();
    await app.close();
    app = await launch(userData);
    page = await app.firstWindow();
    await page.locator('#publication-view iframe').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#annotations-toggle').click();
    await page.waitForFunction(() => document.getElementById('annotations-list').textContent.includes('EPUB 想法'));
    assert.equal(await page.locator('#annotations-list li button').filter({ hasText: '跳转' }).isEnabled(), true);
    await page.waitForFunction(() => document.querySelectorAll('#publication-view [ref="annotation-highlight"]').length > 0);
    assert.deepEqual(await readFile(epub), original);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('changed TXT text reanchors only a unique match and retains notes when ambiguous', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-annotations-change-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const file = path.join(dir, 'change.txt');
  const source = '前言。需要准确定位的句子。结尾。';
  await writeFile(file, source);
  let app;
  try {
    app = await launch(userData);
    const page = await app.firstWindow();
    await choose(app, [file]);
    await page.locator('#import-books').click();
    const id = (await page.evaluate(() => window.reader.listBooks()))[0].id;
    const reopen = async () => {
      await page.locator('#shelf-toggle').click();
      await page.locator(`.shelf-card[data-book-id="${id}"] .shelf-title`).click();
      await page.locator('#content').waitFor({ state: 'visible' });
      await page.locator('#annotations-toggle').click();
    };
    await page.locator(`.shelf-card[data-book-id="${id}"] .shelf-title`).click();
    await page.locator('#content').evaluate((node) => {
      const start = node.textContent.indexOf('需要准确定位');
      const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, start + 6);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#selection-note').click();
    await page.locator('#annotation-note').fill('不能丢失的笔记');
    await page.locator('#annotation-save').click();
    await writeFile(file, `新开头。${source}`);
    await reopen();
    await page.waitForFunction((bookId) => window.reader.listBooks().then((books) => books.find((book) => book.id === bookId)?.annotations[0]?.anchor.start === 7), id);
    assert.equal(await page.locator('#annotations-list li button').filter({ hasText: '跳转' }).isEnabled(), true);
    await writeFile(file, `新开头。${source}${source}`);
    await reopen();
    await page.waitForFunction((bookId) => window.reader.listBooks().then((books) => books.find((book) => book.id === bookId)?.annotations[0]?.status === 'unresolved'), id);
    assert.match(await page.locator('#annotations-list').textContent(), /位置待确认/);
    assert.match(await page.locator('#annotations-list').textContent(), /不能丢失的笔记/);
    assert.equal(await page.locator('#annotations-list li button').filter({ hasText: '跳转' }).isEnabled(), false);
    assert.equal(await page.evaluate(() => CSS.highlights.get('annotation-marks')?.size), 0);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
