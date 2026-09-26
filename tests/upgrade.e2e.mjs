import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';

const oldExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'local-txt-reader', 'TXT 阅读器.exe');
const newExe = process.env.READER_PACKAGED_EXE || path.resolve('node_modules/electron/dist/electron.exe');
const packaged = Boolean(process.env.READER_PACKAGED_EXE);
const launch = (executablePath, userData, args = []) => electron.launch({ executablePath, args, cwd: process.cwd(), env: { ...process.env, READER_TEST_USER_DATA: userData } });

test('installed 1.2.0 profile upgrades to VB阅读器 without losing TXT reading data', { skip: !existsSync(oldExe) }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-installed-upgrade-'));
  const userData = path.join(dir, 'profile');
  await mkdir(userData);
  const filePath = path.join(dir, 'real-old-book.txt');
  const original = ('旧版安装程序创建的记录。'.repeat(8) + '\n').repeat(250);
  await writeFile(filePath, original);
  let app;
  try {
    app = await launch(oldExe, userData);
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, filePath);
    await page.locator('#open').click();
    await page.locator('#content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('progress').textContent !== '');
    await page.locator('#viewport').evaluate((element) => { element.scrollTop = 1400; });
    await page.waitForFunction(() => Number.parseInt(document.getElementById('progress').textContent) > 0);
    await page.locator('#bookmarks-toggle').click();
    await page.locator('#bookmark-add').click();
    await page.waitForFunction(() => document.querySelectorAll('#bookmarks-list li').length === 1);
    await page.locator('#theme').selectOption('sepia');
    await page.locator('#larger').click();
    await page.waitForFunction(() => document.getElementById('font-size').textContent === '20');
    await app.close();
    app = null;
    const statePath = path.join(userData, 'reader-state', 'state.json');
    const oldState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(oldState.version, 3);
    assert.ok(Object.values(oldState.files)[0].offset > 0);
    assert.equal(Object.values(oldState.files)[0].bookmarks.length, 1);

    app = await launch(newExe, userData, packaged ? [] : ['.']);
    page = await app.firstWindow();
    await page.locator('#content').waitFor({ state: 'visible' });
    assert.match(await page.title(), /VB阅读器/);
    assert.equal(await page.locator('#theme').inputValue(), 'sepia');
    assert.equal(await page.locator('#font-size').textContent(), '20');
    await page.locator('#bookmarks-toggle').click();
    assert.equal(await page.locator('#bookmarks-list li').count(), 1);
    assert.ok(await page.locator('#viewport').evaluate((element) => element.scrollTop > 0));
    const newState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(newState.version, 4);
    assert.equal(Object.values(newState.books)[0].bookmarks.length, 1);
    assert.equal(JSON.parse(await readFile(`${statePath}.v3.bak`, 'utf8')).version, 3);
    assert.equal(await readFile(filePath, 'utf8'), original);
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
