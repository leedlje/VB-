import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import iconv from 'iconv-lite';
import { BookError, readBook } from '../src/main/book.ts';

test('UTF-8 and GB18030 TXT preserve Chinese and newlines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-book-'));
  try {
    const content = '第一行\n第二行\r\n很长的一行';
    const utf8 = path.join(dir, 'utf8.txt');
    const gb = path.join(dir, 'gb.txt');
    await writeFile(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]));
    await writeFile(gb, iconv.encode(content, 'gb18030'));
    assert.equal(await readBook(utf8, 'utf8'), content);
    assert.equal(await readBook(gb, 'gb18030'), content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('empty, missing, unreadable and non-TXT files return clear errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-errors-'));
  try {
    const empty = path.join(dir, 'empty.txt');
    await writeFile(empty, '');
    await assert.rejects(readBook(empty, 'utf8'), (error: unknown) => error instanceof BookError && error.kind === 'empty');
    await assert.rejects(readBook(path.join(dir, 'gone.txt'), 'utf8'), (error: unknown) => error instanceof BookError && error.kind === 'missing');
    const directory = path.join(dir, 'folder.txt');
    await mkdir(directory);
    await assert.rejects(readBook(directory, 'utf8'), (error: unknown) => error instanceof BookError && error.kind === 'unreadable');
    await assert.rejects(readBook(path.join(dir, 'other.pdf'), 'utf8'), (error: unknown) => error instanceof BookError && error.kind === 'invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
