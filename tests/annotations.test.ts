import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/main/state.ts';
import { findTextAnchor, resolveTxtAnchor, textContext } from '../src/shared/annotations.ts';

test('TXT annotation anchors follow unique context and reject ambiguous or changed text', () => {
  const source = '开头。海边的灯塔照亮了归途。结尾。';
  const start = source.indexOf('海边的灯塔');
  const text = '海边的灯塔';
  const mark = { id: 'm', bookId: 'b', anchor: { format: 'txt' as const, start, end: start + text.length },
    text, ...textContext(source, start, start + text.length), note: '', status: 'anchored' as const, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(resolveTxtAnchor(source, mark), mark.anchor);
  assert.deepEqual(resolveTxtAnchor(`新序章。${source}`, mark, true), { format: 'txt', start: start + 4, end: start + 4 + text.length });
  assert.equal(resolveTxtAnchor(source.replace(text, '另一座灯塔'), mark, true), null);
  assert.equal(findTextAnchor(`${source}${source}`, mark, undefined, true), null);
});

test('version 4 annotations migration, persistence, isolation and failed writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-annotations-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const bookPath = path.join(dir, 'a.txt');
    const otherPath = path.join(dir, 'b.txt');
    const store = new StateStore(statePath, () => {});
    await store.load();
    await store.updateFile(bookPath, { length: 100 });
    await store.updateFile(otherPath, { length: 100 });
    const legacy = store.snapshot() as unknown as Record<string, unknown>;
    legacy.version = 4;
    for (const record of Object.values(legacy.books as Record<string, Record<string, unknown>>)) delete record.annotations;
    await writeFile(statePath, JSON.stringify(legacy));
    const migrated = new StateStore(statePath, () => {});
    assert.equal((await migrated.load()).version, 5);
    assert.equal(JSON.parse(await readFile(`${statePath}.v4.bak`, 'utf8')).version, 4);
    const book = migrated.byPath(bookPath)!;
    const other = migrated.byPath(otherPath)!;
    assert.deepEqual(book.annotations, []);
    const draft = { anchor: { format: 'txt' as const, start: 4, end: 8 }, text: '选中文字', prefix: '前文', suffix: '后文', note: '' };
    const [created] = await migrated.addAnnotation(book.id, draft);
    assert.equal(created.bookId, book.id);
    assert.equal(created.note, '');
    assert.deepEqual(migrated.book(other.id)?.annotations, []);
    assert.equal((await migrated.updateAnnotationNote(book.id, created.id, '我的想法'))[0].note, '我的想法');
    assert.equal((await migrated.setAnnotationAnchor(book.id, created.id, null))[0].status, 'unresolved');
    assert.equal((await migrated.setAnnotationAnchor(book.id, created.id, draft.anchor))[0].status, 'anchored');
    const restored = new StateStore(statePath, () => {});
    await restored.load();
    assert.equal(restored.book(book.id)?.annotations[0].note, '我的想法');
    await assert.rejects(restored.addAnnotation(book.id, { ...draft, text: '字'.repeat(501) }), /超出/);
    await assert.rejects(restored.addAnnotation(other.id, { ...draft, anchor: { format: 'epub', cfi: 'epubcfi(x)', chapter: 'a' } }), /超出/);
    await rm(statePath);
    await mkdir(statePath);
    const before = restored.snapshot();
    await assert.rejects(restored.updateAnnotationNote(book.id, created.id, '不能保存'));
    assert.deepEqual(restored.snapshot(), before);
    await rm(statePath, { recursive: true });
    await restored.removeAnnotation(book.id, created.id);
    assert.deepEqual(restored.book(book.id)?.annotations, []);
    const damaged = restored.snapshot();
    damaged.books[book.id].annotations = [{ ...created, note: 42 as unknown as string }];
    await writeFile(statePath, JSON.stringify(damaged));
    const protectedStore = new StateStore(statePath, () => {});
    await protectedStore.load();
    assert.match(protectedStore.loadWarning() ?? '', /标注状态无效/);
    assert.deepEqual(JSON.parse(await readFile(`${statePath}.invalid-annotations.bak`, 'utf8')), damaged);
    await assert.rejects(protectedStore.addAnnotation(book.id, draft), /已停止写入/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
