import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isImportBatch, trustedImportSender, validImportPath, validateImportPath } from '../src/main/import.ts';
import { droppedPaths } from '../src/preload/drop.ts';
import { MAX_IMPORT_FILES } from '../src/shared/import.ts';

test('import batches are bounded and paths reject malformed, relative and Windows special paths', () => {
  for (const value of [null, {}, 'book.txt', new Array(MAX_IMPORT_FILES + 1)]) assert.equal(isImportBatch(value), false);
  assert.equal(isImportBatch([]), true);
  assert.equal(isImportBatch(new Array(MAX_IMPORT_FILES)), true);
  for (const value of [null, {}, 123, '', 'book.txt', '/tmp/book\0.txt']) assert.equal(validImportPath(value, 'linux'), false);
  assert.equal(validImportPath('/tmp/book.TXT', 'linux'), true);
  for (const value of ['C:book.txt', '\\books\\book.txt', 'C:\\books\\x.txt:secret.pdf', '\\\\?\\C:\\book.txt', '\\\\.\\NUL.txt', 'C:\\NUL.txt', 'C:\\COM1\\book.txt', 'file:///C:/book.pdf']) {
    assert.equal(validImportPath(value, 'win32'), false, value);
  }
  for (const value of ['C:\\books\\中文.PDF', 'C:/books/book.epub', '\\\\server\\share\\book.txt']) assert.equal(validImportPath(value, 'win32'), true, value);
});

test('main process accepts only supported readable regular files before importing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-import-'));
  try {
    const good = path.join(dir, 'book.TXT');
    await writeFile(good, '正文');
    assert.equal(await validateImportPath(good), good);
    await mkdir(path.join(dir, 'folder.epub'));
    await assert.rejects(validateImportPath(path.join(dir, 'folder.epub')), /普通文件/);
    await assert.rejects(validateImportPath(path.join(dir, 'missing.pdf')), /不存在/);
    await assert.rejects(validateImportPath(path.join(dir, 'image.png')), /仅支持/);
    await assert.rejects(validateImportPath({ path: good }), /路径无效/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('import IPC rejects other windows, subframes, navigated frames and missing senders', () => {
  const url = 'file:///app/renderer/index.html';
  const contents = { mainFrame: { url } };
  assert.equal(trustedImportSender({ sender: contents, senderFrame: contents.mainFrame }, contents, url), true);
  for (const event of [
    { sender: {}, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { url } },
    { sender: contents, senderFrame: null },
  ]) assert.equal(trustedImportSender(event, contents, url), false);
  assert.equal(trustedImportSender({ sender: contents, senderFrame: contents.mainFrame }, undefined, url), false);
  contents.mainFrame.url = 'https://example.com/';
  assert.equal(trustedImportSender({ sender: contents, senderFrame: contents.mainFrame }, contents, url), false);
});

test('preload uses only the native resolver, reports unbacked Files and continues a mixed batch', () => {
  const nativeFile = Object.assign(new File(['正文'], 'native.txt'), { path: '/spoof.txt' });
  const virtualFile = new File(['正文'], 'virtual.txt');
  const spoofed = { name: 'spoofed.txt', path: '/etc/secret.txt' };
  const result = droppedPaths([nativeFile, virtualFile, spoofed], (file) => {
    if (file === nativeFile) return '/native.txt';
    if (file === virtualFile) return '';
    throw new TypeError('Not a File');
  });
  assert.deepEqual(result.paths, ['/native.txt']);
  assert.deepEqual(result.errors.map((error) => error.path), ['virtual.txt', 'spoofed.txt']);
  assert.ok(result.errors.every((error) => error.message.includes('资源管理器')));
  for (const batch of ['/spoof.txt', null, new Array(MAX_IMPORT_FILES + 1)]) {
    assert.equal(droppedPaths(batch, () => { throw new Error('must not resolve'); }).errors.length, 1);
  }
});
