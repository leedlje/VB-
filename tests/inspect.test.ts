import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectBook } from '../src/main/inspect.ts';
import { StateStore, parseState } from '../src/main/state.ts';
import { writeEpub, writePdf } from './fixtures.mjs';

test('mixed formats expose metadata, format positions, and independently cached cover bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-inspect-'));
  try {
    const epub = await writeEpub(path.join(dir, 'book.epub'));
    const pdf = await writePdf(path.join(dir, 'book.pdf'));
    const txt = path.join(dir, 'book.txt');
    await writeFile(txt, '中文 TXT\n第二行');
    const [e, p, t] = await Promise.all([inspectBook(epub), inspectBook(pdf), inspectBook(txt)]);
    assert.equal(e.record.title, '山海小书');
    assert.equal(e.record.author, '测试作者');
    assert.equal(e.record.position.format, 'epub');
    assert.equal(e.cover?.mime, 'image/png');
    assert.ok(e.cover?.bytes.length);
    assert.equal(p.record.title, 'PDF Sample');
    assert.equal(p.record.author, 'PDF Author');
    assert.deepEqual(p.record.position, { format: 'pdf', page: 1, fraction: 0, pageCount: 3 });
    assert.equal(t.record.title, 'book');
    assert.equal(t.record.position.format, 'txt');
    const store = new StateStore(path.join(dir, 'state.json'));
    await store.load();
    const first = await store.importBook(e.record);
    const same = await store.importBook(e.record);
    assert.equal(first.id, same.id);
    assert.equal(store.listBooks().length, 1);
    await store.savePosition(first.id, { format: 'epub', cfi: 'epubcfi(/6/2!/4/2:3)', chapter: 'chapter1.xhtml', percent: 31 });
    const [mark] = await store.addBookBookmark(first.id, { format: 'epub', cfi: 'epubcfi(/6/2!/4/2:3)', chapter: 'chapter1.xhtml', percent: 31 });
    const moved = path.join(dir, 'moved.epub');
    await store.relocateBook(first.id, moved, e.record.size, e.record.modifiedAt);
    assert.equal(store.book(first.id)?.path, moved);
    assert.equal(store.book(first.id)?.bookmarks[0].id, mark.id);
    assert.equal(store.book(first.id)?.position.format, 'epub');
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(JSON.stringify(state).includes('山海故事开始'), false);
    await store.removeBook(first.id);
    assert.equal(store.listBooks().length, 0);
    assert.ok((await readFile(epub)).length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsupported fixed, encrypted, damaged EPUB and PDF fail without a shelf record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vb-errors-'));
  try {
    const fixed = await writeEpub(path.join(dir, 'fixed.epub'), { fixed: true });
    const encrypted = await writeEpub(path.join(dir, 'encrypted.epub'), { encrypted: true });
    const brokenEpub = path.join(dir, 'broken.epub');
    const brokenPdf = path.join(dir, 'broken.pdf');
    await writeFile(brokenEpub, 'broken');
    await writeFile(brokenPdf, 'broken');
    await assert.rejects(inspectBook(fixed), /固定版式/);
    await assert.rejects(inspectBook(encrypted), /加密|DRM/);
    await assert.rejects(inspectBook(brokenEpub), /损坏/);
    await assert.rejects(inspectBook(brokenPdf), /损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('version 3 TXT record migrates to a stable ID and retains old settings and bookmarks', () => {
  const filePath = path.join(os.tmpdir(), 'legacy-three.txt');
  const source = { version: 3, lastFile: filePath, fontSize: 26, theme: 'dark', lineHeight: 2.2, contentWidth: 940, files: {
    [filePath]: { path: filePath, encoding: 'gb18030', offset: 79, length: 100, modifiedAt: 8, recentAt: 9, bookmarks: [{ id: 'old', offset: 54, createdAt: 3 }] },
  } };
  const state = parseState(source);
  assert.equal(state.version, 4);
  const book = state.books[state.lastBookId!];
  assert.equal(book.path, filePath);
  assert.equal(book.position.format, 'txt');
  assert.equal(book.position.format === 'txt' && book.position.offset, 79);
  assert.equal(book.bookmarks[0].position.format === 'txt' && book.bookmarks[0].position.offset, 54);
  assert.equal(book.id, parseState(source).lastBookId);
  assert.deepEqual([state.fontSize, state.theme, state.lineHeight, state.contentWidth], [26, 'dark', 2.2, 940]);
});
