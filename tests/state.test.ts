import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateStore, DEFAULT_FONT_SIZE, parseState } from '../src/main/state.ts';
import { clampOffset } from '../src/shared/types.ts';
import { safePosition, scrollTarget } from '../src/renderer/position.ts';

test('each file has independent encoding and character offset across launches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-state-'));
  try {
    const filePath = path.join(dir, 'state.json');
    const a = path.join(dir, 'A.txt');
    const b = path.join(dir, 'B.txt');
    const first = new StateStore(filePath);
    await first.load();
    await first.updateFile(a, { encoding: 'gb18030', offset: 145, length: 200 });
    await first.updateFile(b, { offset: 7, length: 10 });
    await first.setFontSize(24);
    const second = new StateStore(filePath);
    const state = await second.load();
    assert.equal(state.lastFile, b);
    assert.equal(second.record(a)?.encoding, 'gb18030');
    assert.equal(second.record(a)?.offset, 145);
    assert.equal(second.record(a)?.length, 200);
    assert.equal(second.record(b)?.encoding, 'utf8');
    assert.equal(second.record(b)?.offset, 7);
    assert.equal(state.fontSize, 24);
    assert.equal((await readFile(filePath, 'utf8')).includes('书籍正文'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('version 1 state migrates without losing progress and new fields have defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-migrate-'));
  try {
    const filePath = path.join(dir, 'state.json');
    const book = path.join(dir, 'legacy.txt');
    await writeFile(filePath, JSON.stringify({ version: 1, lastFile: book, fontSize: 24,
      files: { [book]: { path: book, encoding: 'gb18030', offset: 72 } } }));
    const store = new StateStore(filePath);
    const state = await store.load();
    assert.equal(state.version, 2);
    assert.equal(state.lastFile, book);
    assert.equal(state.fontSize, 24);
    assert.equal(state.theme, 'light');
    assert.equal(store.record(book)?.offset, 72);
    assert.equal(store.record(book)?.modifiedAt, 0);
    assert.deepEqual(store.record(book)?.bookmarks, []);
    await store.updateFile(book, { length: 100 });
    assert.equal(store.record(book)?.offset, 72);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recent list, bookmarks, themes and removal persist without altering source files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-features-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await writeFile(a, '原文内容');
    const store = new StateStore(statePath);
    await store.load();
    await store.updateFile(a, { offset: 2, length: 4 });
    await store.updateFile(b, { offset: 3, length: 10 });
    await store.updateFile(a, { offset: 3 });
    assert.deepEqual(store.listRecent().map((record) => record.path), [a, b]);
    const marks = await store.addBookmark(a, 999);
    assert.equal(marks[0].offset, 4);
    assert.deepEqual(store.record(b)?.bookmarks, []);
    await store.setTheme('dark');
    const restored = new StateStore(statePath);
    await restored.load();
    assert.equal(restored.snapshot().theme, 'dark');
    assert.equal(restored.record(a)?.bookmarks[0].id, marks[0].id);
    await restored.removeBookmark(a, marks[0].id);
    assert.deepEqual(restored.record(a)?.bookmarks, []);
    await restored.removeFile(a);
    assert.equal(restored.snapshot().lastFile, b);
    assert.equal(restored.record(a), undefined);
    assert.equal(await readFile(a, 'utf8'), '原文内容');
    await assert.rejects(store.setTheme('invalid' as 'light'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt or malformed state falls back to safe defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-corrupt-'));
  try {
    const filePath = path.join(dir, 'state.json');
    await writeFile(filePath, '{broken');
    const errors: Error[] = [];
    const store = new StateStore(filePath, (error) => errors.push(error));
    assert.equal((await store.load()).fontSize, DEFAULT_FONT_SIZE);
    assert.equal(errors.length, 1);
    assert.deepEqual(parseState({ version: 99, files: {} }), parseState(null));
    assert.equal(parseState({ version: 1, fontSize: 100, files: {} }).fontSize, 32);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('changed content and font reflow retain a valid character anchor', () => {
  assert.equal(clampOffset(500, 120), 120);
  assert.equal(clampOffset(-5, 120), 0);
  assert.equal(safePosition(90, '短文'), 2);
  assert.equal(scrollTarget(200, 450, 100), 542);
  assert.equal(scrollTarget(5, -20, 100), 0);
});

test('write failure is reported without losing in-memory state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-write-'));
  try {
    const errors: Error[] = [];
    const store = new StateStore(dir, (error) => errors.push(error));
    await store.load();
    await assert.rejects(store.setFontSize(22));
    assert.equal(store.snapshot().fontSize, 22);
    assert.equal(errors.length, 2); // load found a directory, then writing to it failed
  } finally { await rm(dir, { recursive: true, force: true }); }
});
