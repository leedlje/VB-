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
    await first.updateFile(a, { encoding: 'gb18030', offset: 145 });
    await first.updateFile(b, { offset: 7 });
    await first.setFontSize(24);
    const second = new StateStore(filePath);
    const state = await second.load();
    assert.equal(state.lastFile, b);
    assert.deepEqual(second.record(a), { path: a, encoding: 'gb18030', offset: 145 });
    assert.deepEqual(second.record(b), { path: b, encoding: 'utf8', offset: 7 });
    assert.equal(state.fontSize, 24);
    assert.equal((await readFile(filePath, 'utf8')).includes('书籍正文'), false);
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
