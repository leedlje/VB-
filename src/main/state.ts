import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizedKey } from './book.ts';
import { ANNOTATION_CONTEXT, MAX_ANNOTATION_NOTE, MAX_ANNOTATION_TEXT } from '../shared/annotations.ts';
import { clampOffset, type Annotation, type AnnotationAnchor, type AnnotationDraft, type BookBookmark, type BookFormat, type BookPosition, type BookRecord, type Bookmark, type Encoding, type FileRecord, type ReaderState, type Theme } from '../shared/types.ts';

export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_LINE_HEIGHT = 1.9;
export const DEFAULT_CONTENT_WIDTH = 820;
export const THEMES: Theme[] = ['light', 'dark', 'sepia'];
export function freshState(): ReaderState { return { version: 5, lastBookId: null, fontSize: DEFAULT_FONT_SIZE, theme: 'light', lineHeight: DEFAULT_LINE_HEIGHT, contentWidth: DEFAULT_CONTENT_WIDTH, books: {} }; }
export function clampFontSize(size: number): number { return Number.isFinite(size) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size))) : DEFAULT_FONT_SIZE; }
export function clampLineHeight(value: number): number { return Number.isFinite(value) ? Math.max(1.4, Math.min(2.4, Math.round(value * 10) / 10)) : DEFAULT_LINE_HEIGHT; }
export function clampContentWidth(value: number): number { return Number.isFinite(value) ? Math.max(560, Math.min(1040, Math.round(value / 20) * 20)) : DEFAULT_CONTENT_WIDTH; }
const nonNegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
const validFormat = (format: unknown): format is BookFormat => format === 'txt' || format === 'epub' || format === 'pdf';
const validId = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(value);
export const legacyBookId = (filePath: string): string => createHash('sha256').update(normalizedKey(filePath)).digest('hex').slice(0, 32);

function parsePosition(value: unknown, format: BookFormat): BookPosition {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (format === 'txt') return { format, offset: clampOffset(Number(source.offset), Number.MAX_SAFE_INTEGER), length: clampOffset(Number(source.length), Number.MAX_SAFE_INTEGER), encoding: source.encoding === 'gb18030' ? 'gb18030' : 'utf8' };
  if (format === 'epub') return { format, cfi: typeof source.cfi === 'string' ? source.cfi : '', chapter: typeof source.chapter === 'string' ? source.chapter : '', percent: Math.max(0, Math.min(100, nonNegative(source.percent))) };
  return { format, page: Math.max(1, Math.trunc(nonNegative(source.page) || 1)), fraction: Math.max(0, Math.min(1, nonNegative(source.fraction))), pageCount: Math.max(1, Math.trunc(nonNegative(source.pageCount) || 1)) };
}
function parseAnchor(value: unknown, format: BookFormat): AnnotationAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const anchor = value as Record<string, unknown>;
  if (format === 'txt' && anchor.format === 'txt' && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end)
      && Number(anchor.start) >= 0 && Number(anchor.end) > Number(anchor.start)) {
    return { format: 'txt', start: Number(anchor.start), end: Number(anchor.end) };
  }
  if (format === 'epub' && anchor.format === 'epub' && typeof anchor.cfi === 'string' && /^epubcfi\(/.test(anchor.cfi)
      && anchor.cfi.length <= 1000 && typeof anchor.chapter === 'string' && anchor.chapter.length <= 500) {
    return { format: 'epub', cfi: anchor.cfi, chapter: anchor.chapter };
  }
  return null;
}
function parseAnnotation(value: unknown, bookId: string, format: BookFormat): Annotation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<Annotation>;
  const anchor = parseAnchor(item.anchor, format);
  if (!validId(item.id) || item.bookId !== bookId || !anchor || typeof item.text !== 'string' || !item.text.trim()
      || item.text.length > MAX_ANNOTATION_TEXT || typeof item.prefix !== 'string' || item.prefix.length > ANNOTATION_CONTEXT
      || typeof item.suffix !== 'string' || item.suffix.length > ANNOTATION_CONTEXT
      || typeof item.note !== 'string' || item.note.length > MAX_ANNOTATION_NOTE) return null;
  return { id: item.id, bookId, anchor, text: item.text, prefix: item.prefix, suffix: item.suffix, note: item.note,
    status: item.status === 'unresolved' ? 'unresolved' : 'anchored', createdAt: nonNegative(item.createdAt), updatedAt: nonNegative(item.updatedAt) };
}
function parseRecord(value: unknown): BookRecord | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<BookRecord>;
  if (!validId(source.id) || typeof source.path !== 'string' || !path.isAbsolute(source.path) || !validFormat(source.format)) return null;
  const position = parsePosition(source.position, source.format);
  const marks: BookBookmark[] = Array.isArray(source.bookmarks) ? source.bookmarks.flatMap((mark) => {
    if (typeof mark?.id !== 'string' || !mark.id || !mark.position || mark.position.format !== source.format) return [];
    return [{ id: mark.id, createdAt: nonNegative(mark.createdAt), position: parsePosition(mark.position, source.format!) }];
  }) : [];
  return {
    id: source.id, format: source.format, path: source.path,
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : path.parse(source.path).name,
    author: typeof source.author === 'string' ? source.author : '',
    coverKey: validId(source.coverKey) ? source.coverKey : null,
    importedAt: nonNegative(source.importedAt), recentAt: nonNegative(source.recentAt),
    size: nonNegative(source.size), modifiedAt: nonNegative(source.modifiedAt), position, bookmarks: marks,
    annotations: Array.isArray(source.annotations) ? source.annotations.flatMap((item) => {
      const parsed = parseAnnotation(item, source.id!, source.format!);
      return parsed ? [parsed] : [];
    }) : [],
  };
}
export function parseState(value: unknown): ReaderState {
  const state = freshState();
  if (!value || typeof value !== 'object') return state;
  const source = value as Record<string, unknown>;
  if (![1, 2, 3, 4, 5].includes(Number(source.version))) return state;
  if (typeof source.fontSize === 'number') state.fontSize = clampFontSize(source.fontSize);
  if (THEMES.includes(source.theme as Theme)) state.theme = source.theme as Theme;
  if (typeof source.lineHeight === 'number') state.lineHeight = clampLineHeight(source.lineHeight);
  if (typeof source.contentWidth === 'number') state.contentWidth = clampContentWidth(source.contentWidth);
  if ((source.version === 4 || source.version === 5) && source.books && typeof source.books === 'object' && !Array.isArray(source.books)) {
    const paths = new Set<string>();
    for (const raw of Object.values(source.books)) {
      const record = parseRecord(raw);
      if (!record || paths.has(normalizedKey(record.path))) continue;
      state.books[record.id] = record;
      paths.add(normalizedKey(record.path));
    }
    if (typeof source.lastBookId === 'string' && state.books[source.lastBookId]) state.lastBookId = source.lastBookId;
  } else if (source.files && typeof source.files === 'object' && !Array.isArray(source.files)) {
    for (const entry of Object.values(source.files) as Partial<FileRecord>[]) {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !['utf8', 'gb18030'].includes(String(entry.encoding))) continue;
      const id = legacyBookId(entry.path);
      const length = clampOffset(entry.length ?? 0, Number.MAX_SAFE_INTEGER);
      const bookmarks: BookBookmark[] = Array.isArray(entry.bookmarks) ? entry.bookmarks.flatMap((mark) =>
        typeof mark?.id === 'string' && Number.isFinite(mark.offset) ? [{ id: mark.id, createdAt: nonNegative(mark.createdAt), position: { format: 'txt' as const, offset: clampOffset(mark.offset, length || Number.MAX_SAFE_INTEGER), length, encoding: entry.encoding as Encoding } }] : []) : [];
      state.books[id] = {
        id, format: 'txt', path: entry.path, title: path.parse(entry.path).name, author: '', coverKey: null,
        importedAt: nonNegative(entry.recentAt), recentAt: nonNegative(entry.recentAt), size: 0,
        modifiedAt: nonNegative(entry.modifiedAt),
        position: { format: 'txt', offset: clampOffset(entry.offset ?? 0, length || Number.MAX_SAFE_INTEGER), length, encoding: entry.encoding as Encoding }, bookmarks, annotations: [],
      };
      if (typeof source.lastFile === 'string' && normalizedKey(source.lastFile) === normalizedKey(entry.path)) state.lastBookId = id;
    }
  }
  return state;
}

export class StateStore {
  private state = freshState();
  private pending: Promise<void> = Promise.resolve();
  private mutationGate: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly onError: (error: Error) => void;
  private writesBlocked = false;
  private warning: string | null = null;
  constructor(filePath: string, onError: (error: Error) => void = console.error) { this.filePath = filePath; this.onError = onError; }
  async load(): Promise<ReaderState> {
    this.warning = null;
    this.writesBlocked = false;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      let version = 'invalid';
      try {
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (![1, 2, 3, 4, 5].includes(Number(parsed.version))) throw new Error('阅读状态版本无法识别。');
        version = String(parsed.version);
        this.state = parseState(parsed);
        if (version === '5' && parsed && typeof parsed === 'object' && 'books' in parsed) {
          const books = (parsed as { books?: unknown }).books;
          const invalidMarks = books && typeof books === 'object' && !Array.isArray(books)
            && Object.values(books).some((entry) => {
              if (!entry || typeof entry !== 'object' || !('annotations' in entry)) return false;
              const raw = entry as { id?: unknown; annotations?: unknown };
              return !Array.isArray(raw.annotations) || raw.annotations.length !== this.state.books[String(raw.id)]?.annotations.length;
            });
          if (invalidMarks) {
            this.writesBlocked = true;
            this.warning = '部分标注状态无效，已停止写入以保护原笔记；请检查阅读状态文件。';
            try { await copyFile(this.filePath, `${this.filePath}.invalid-annotations.bak`); }
            catch (error) { this.onError(error as Error); }
          }
        }
      } catch (error) {
        this.onError(error as Error);
        this.state = freshState();
        this.warning = '旧阅读状态无法解析，已保存备份；请检查磁盘中的状态文件。';
      }
      if (version !== '5') {
        try { await copyFile(this.filePath, `${this.filePath}.v${version}.bak`); }
        catch (error) {
          this.onError(error as Error);
          this.writesBlocked = true;
          this.warning = '阅读状态备份失败，已停止写入以保护旧数据。';
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.onError(error as Error); this.warning = '阅读状态无法读取，请检查文件权限。'; }
      this.state = freshState();
    }
    return this.snapshot();
  }
  loadWarning(): string | null { return this.warning; }
  snapshot(): ReaderState { return structuredClone(this.state); }
  book(id: string): BookRecord | undefined { return this.state.books[id] ? structuredClone(this.state.books[id]) : undefined; }
  byPath(filePath: string): BookRecord | undefined { return Object.values(this.state.books).find((book) => normalizedKey(book.path) === normalizedKey(filePath)); }
  listBooks(): BookRecord[] { return structuredClone(Object.values(this.state.books).sort((a, b) => b.recentAt - a.recentAt || b.importedAt - a.importedAt)); }
  record(filePath: string): FileRecord | undefined {
    const book = this.byPath(filePath);
    if (!book || book.position.format !== 'txt') return undefined;
    const p = book.position;
    return { path: book.path, encoding: p.encoding, offset: p.offset, length: p.length, modifiedAt: book.modifiedAt, recentAt: book.recentAt,
      bookmarks: book.bookmarks.filter((mark) => mark.position.format === 'txt').map((mark) => ({ id: mark.id, createdAt: mark.createdAt, offset: (mark.position as Extract<BookPosition, { format: 'txt' }>).offset })) };
  }
  listRecent(): FileRecord[] { return this.listBooks().flatMap((book) => { const record = this.record(book.path); return record ? [record] : []; }); }
  async importBook(candidate: Omit<BookRecord, 'id' | 'importedAt' | 'recentAt' | 'bookmarks' | 'annotations'>): Promise<BookRecord> {
    return this.withMutation(async () => {
      const existing = this.byPath(candidate.path);
      if (existing) return structuredClone(existing);
      const now = Date.now();
      const record: BookRecord = { ...candidate, id: randomUUID(), importedAt: now, recentAt: 0, bookmarks: [], annotations: [] };
      this.state.books[record.id] = record;
      await this.persist();
      return structuredClone(record);
    });
  }
  async touch(id: string): Promise<BookRecord> {
    return this.withMutation(async () => {
      const record = this.state.books[id];
      if (!record) throw new Error('书籍记录不存在。');
      record.recentAt = Date.now();
      this.state.lastBookId = id;
      await this.persist();
      return structuredClone(record);
    });
  }
  async setCoverKey(id: string, key: string): Promise<void> {
    return this.withMutation(async () => {
      if (!this.state.books[id] || !validId(key)) throw new Error('封面缓存键无效。');
      this.state.books[id].coverKey = key;
      await this.persist();
    });
  }
  async savePosition(id: string, position: BookPosition): Promise<void> {
    return this.withMutation(async () => {
      const record = this.state.books[id];
      if (!record || record.format !== position.format) throw new Error('书籍位置无效。');
      record.position = parsePosition(position, record.format);
      await this.persist();
    });
  }
  async updateFile(filePath: string, update: { encoding?: Encoding; offset?: number; length?: number; modifiedAt?: number }): Promise<void> {
    return this.withMutation(async () => {
      let book = this.byPath(filePath);
      if (!book) {
        const now = Date.now();
        book = { id: randomUUID(), format: 'txt', path: filePath, title: path.parse(filePath).name, author: '', coverKey: null,
          importedAt: now, recentAt: now, size: 0, modifiedAt: 0, position: { format: 'txt', offset: 0, length: 0, encoding: 'utf8' }, bookmarks: [], annotations: [] };
        this.state.books[book.id] = book;
      }
      if (book.position.format !== 'txt') throw new Error('这不是 TXT 书籍。');
      const old = book.position;
      const length = update.length ?? old.length;
      book.position = { format: 'txt', length, encoding: update.encoding ?? old.encoding, offset: clampOffset(update.offset ?? old.offset, length || Number.MAX_SAFE_INTEGER) };
      book.modifiedAt = update.modifiedAt ?? book.modifiedAt;
      book.recentAt = Date.now();
      this.state.lastBookId = book.id;
      await this.persist();
    });
  }
  async removeFile(filePath: string): Promise<void> { const record = this.byPath(filePath); if (record) await this.removeBook(record.id); }
  async removeBook(id: string): Promise<void> {
    return this.withMutation(async () => {
      delete this.state.books[id];
      if (this.state.lastBookId === id) this.state.lastBookId = this.listBooks()[0]?.id ?? null;
      await this.persist();
    });
  }
  async relocateBook(id: string, newPath: string, size: number, modifiedAt: number, title?: string, author?: string, coverKey?: string | null, txtLength?: number): Promise<BookRecord> {
    return this.withMutation(async () => {
      if (!path.isAbsolute(newPath)) throw new Error('文件路径无效。');
      const record = this.state.books[id];
      if (!record) throw new Error('找不到原阅读记录。');
      const conflict = this.byPath(newPath);
      if (conflict && conflict.id !== id) throw new Error('新路径已有阅读记录，请先处理该记录。');
      const next = this.snapshot();
      next.books[id] = { ...structuredClone(record), path: newPath, size, modifiedAt, title: title ?? record.title, author: author ?? record.author, coverKey: coverKey === undefined ? record.coverKey : coverKey };
      if (next.books[id].position.format === 'txt' && txtLength !== undefined) next.books[id].position.length = txtLength;
      await this.persist(next, true);
      return structuredClone(next.books[id]);
    });
  }
  async relocateFile(oldPath: string, newPath: string, length: number, modifiedAt: number): Promise<FileRecord> {
    const book = this.byPath(oldPath);
    if (!book || book.position.format !== 'txt') throw new Error('找不到原阅读记录。');
    const moved = await this.relocateBook(book.id, newPath, book.size, modifiedAt, undefined, undefined, undefined, length);
    const position = moved.position as Extract<BookPosition, { format: 'txt' }>;
    return { path: newPath, encoding: position.encoding, offset: position.offset, length: position.length, modifiedAt, recentAt: moved.recentAt,
      bookmarks: moved.bookmarks.filter((mark) => mark.position.format === 'txt').map((mark) => ({ id: mark.id, createdAt: mark.createdAt, offset: (mark.position as Extract<BookPosition, { format: 'txt' }>).offset })) };
  }
  async addBookBookmark(id: string, position: BookPosition): Promise<BookBookmark[]> {
    return this.withMutation(async () => {
      const book = this.state.books[id];
      if (!book || book.format !== position.format) throw new Error('当前文件没有阅读记录。');
      book.bookmarks.push({ id: randomUUID(), createdAt: Date.now(), position: parsePosition(position, book.format) });
      await this.persist();
      return structuredClone(book.bookmarks);
    });
  }
  async removeBookBookmark(id: string, markId: string): Promise<BookBookmark[]> {
    return this.withMutation(async () => {
      const book = this.state.books[id];
      if (!book) throw new Error('当前文件没有阅读记录。');
      book.bookmarks = book.bookmarks.filter((mark) => mark.id !== markId);
      await this.persist();
      return structuredClone(book.bookmarks);
    });
  }
  async addAnnotation(id: string, draft: AnnotationDraft): Promise<Annotation[]> {
    return this.withMutation(async () => {
      const book = this.state.books[id];
      if (!book || book.format === 'pdf' || !draft || typeof draft !== 'object') throw new Error('当前书籍不支持选文标注。');
      const anchor = parseAnchor(draft.anchor, book.format);
      if (!anchor || typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > MAX_ANNOTATION_TEXT
          || typeof draft.prefix !== 'string' || draft.prefix.length > ANNOTATION_CONTEXT
          || typeof draft.suffix !== 'string' || draft.suffix.length > ANNOTATION_CONTEXT
          || typeof draft.note !== 'string' || draft.note.length > MAX_ANNOTATION_NOTE) throw new Error('选文或笔记超出允许长度。');
      const now = Date.now();
      const next = this.snapshot();
      next.books[id].annotations.push({ id: randomUUID(), bookId: id, anchor, text: draft.text, prefix: draft.prefix,
        suffix: draft.suffix, note: draft.note, status: 'anchored', createdAt: now, updatedAt: now });
      await this.persist(next, true);
      return structuredClone(next.books[id].annotations);
    });
  }
  async updateAnnotationNote(id: string, annotationId: string, note: string): Promise<Annotation[]> {
    return this.withMutation(async () => {
      if (typeof note !== 'string' || note.length > MAX_ANNOTATION_NOTE) throw new Error('笔记最多 2000 字。');
      const next = this.snapshot();
      const mark = next.books[id]?.annotations.find((item) => item.id === annotationId);
      if (!mark) throw new Error('标注不存在。');
      mark.note = note;
      mark.updatedAt = Date.now();
      await this.persist(next, true);
      return structuredClone(next.books[id].annotations);
    });
  }
  async removeAnnotation(id: string, annotationId: string): Promise<Annotation[]> {
    return this.withMutation(async () => {
      const next = this.snapshot();
      const marks = next.books[id]?.annotations;
      if (!marks || !marks.some((mark) => mark.id === annotationId)) throw new Error('标注不存在。');
      next.books[id].annotations = marks.filter((mark) => mark.id !== annotationId);
      await this.persist(next, true);
      return structuredClone(next.books[id].annotations);
    });
  }
  async setAnnotationAnchor(id: string, annotationId: string, anchor: AnnotationAnchor | null): Promise<Annotation[]> {
    return this.withMutation(async () => {
      const next = this.snapshot();
      const book = next.books[id];
      const mark = book?.annotations.find((item) => item.id === annotationId);
      if (!mark || (anchor && !parseAnchor(anchor, book.format))) throw new Error('标注位置无效。');
      if (anchor) mark.anchor = parseAnchor(anchor, book.format)!;
      mark.status = anchor ? 'anchored' : 'unresolved';
      await this.persist(next, true);
      return structuredClone(book.annotations);
    });
  }
  async addBookmark(filePath: string, offset: number): Promise<Bookmark[]> {
    const book = this.byPath(filePath);
    if (!book || book.position.format !== 'txt') throw new Error('当前文件没有阅读记录。');
    await this.addBookBookmark(book.id, { ...book.position, offset: clampOffset(offset, book.position.length) });
    return this.record(filePath)!.bookmarks;
  }
  async removeBookmark(filePath: string, id: string): Promise<Bookmark[]> {
    const book = this.byPath(filePath);
    if (!book) throw new Error('当前文件没有阅读记录。');
    await this.removeBookBookmark(book.id, id);
    return this.record(filePath)!.bookmarks;
  }
  async setFontSize(size: number): Promise<number> { return this.withMutation(async () => { this.state.fontSize = clampFontSize(size); await this.persist(); return this.state.fontSize; }); }
  async setTheme(theme: Theme): Promise<Theme> { return this.withMutation(async () => { if (!THEMES.includes(theme)) throw new Error('不支持此主题。'); this.state.theme = theme; await this.persist(); return theme; }); }
  async setLayout(lineHeight: number, contentWidth: number): Promise<{ lineHeight: number; contentWidth: number }> {
    return this.withMutation(async () => { this.state.lineHeight = clampLineHeight(lineHeight); this.state.contentWidth = clampContentWidth(contentWidth); await this.persist(); return { lineHeight: this.state.lineHeight, contentWidth: this.state.contentWidth }; });
  }
  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationGate.then(operation);
    this.mutationGate = result.then(() => {}, () => {});
    return result;
  }
  private persist(state: ReaderState = this.state, replaceAfterWrite = false): Promise<void> {
    if (this.writesBlocked) return Promise.reject(new Error('阅读状态备份失败，已停止写入。'));
    const serialized = JSON.stringify(state);
    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, serialized, 'utf8');
      await rename(temp, this.filePath);
      if (replaceAfterWrite) this.state = state;
    };
    this.pending = this.pending.catch(() => {}).then(write);
    return this.pending.catch((error: Error) => { this.onError(error); throw error; });
  }
}
