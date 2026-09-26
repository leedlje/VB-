import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizedKey } from './book.ts';
import { clampOffset, type Bookmark, type Encoding, type FileRecord, type ReaderState, type Theme } from '../shared/types.ts';

export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_LINE_HEIGHT = 1.9;
export const DEFAULT_CONTENT_WIDTH = 820;
export const THEMES: Theme[] = ['light', 'dark', 'sepia'];

export function freshState(): ReaderState { return { version: 3, lastFile: null, fontSize: DEFAULT_FONT_SIZE, theme: 'light', lineHeight: DEFAULT_LINE_HEIGHT, contentWidth: DEFAULT_CONTENT_WIDTH, files: {} }; }
export function clampFontSize(size: number): number {
  return Number.isFinite(size) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size))) : DEFAULT_FONT_SIZE;
}
export function clampLineHeight(value: number): number {
  return Number.isFinite(value) ? Math.max(1.4, Math.min(2.4, Math.round(value * 10) / 10)) : DEFAULT_LINE_HEIGHT;
}
export function clampContentWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(560, Math.min(1040, Math.round(value / 20) * 20)) : DEFAULT_CONTENT_WIDTH;
}

export function parseState(value: unknown): ReaderState {
  const state = freshState();
  if (!value || typeof value !== 'object') return state;
  const source = value as { version?: number } & Omit<Partial<ReaderState>, 'version'>;
  if (source.version !== 1 && source.version !== 2 && source.version !== 3) return state;
  if (typeof source.lastFile === 'string' && path.isAbsolute(source.lastFile)) state.lastFile = source.lastFile;
  if (typeof source.fontSize === 'number') state.fontSize = clampFontSize(source.fontSize);
  if (THEMES.includes(source.theme as Theme)) state.theme = source.theme as Theme;
  if (typeof source.lineHeight === 'number') state.lineHeight = clampLineHeight(source.lineHeight);
  if (typeof source.contentWidth === 'number') state.contentWidth = clampContentWidth(source.contentWidth);
  if (source.files && typeof source.files === 'object' && !Array.isArray(source.files)) {
    for (const entry of Object.values(source.files) as Partial<FileRecord>[]) {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue;
      if (entry.encoding !== 'utf8' && entry.encoding !== 'gb18030') continue;
      const length = clampOffset(entry.length ?? 0, Number.MAX_SAFE_INTEGER);
      const bookmarks: Bookmark[] = Array.isArray(entry.bookmarks) ? entry.bookmarks.filter((mark): mark is Bookmark =>
        typeof mark?.id === 'string' && mark.id.length > 0 && Number.isFinite(mark.offset) && Number.isFinite(mark.createdAt))
        .map((mark) => ({ id: mark.id, offset: clampOffset(mark.offset, Number.MAX_SAFE_INTEGER), createdAt: Math.max(0, mark.createdAt) })) : [];
      state.files[normalizedKey(entry.path)] = {
        path: entry.path, encoding: entry.encoding, offset: clampOffset(entry.offset ?? 0, Number.MAX_SAFE_INTEGER),
        length, modifiedAt: typeof entry.modifiedAt === 'number' && Number.isFinite(entry.modifiedAt) ? Math.max(0, entry.modifiedAt) : 0,
        recentAt: typeof entry.recentAt === 'number' && Number.isFinite(entry.recentAt) ? Math.max(0, entry.recentAt) : 0, bookmarks,
      };
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
  constructor(filePath: string, onError: (error: Error) => void = console.error) { this.filePath = filePath; this.onError = onError; }

  async load(): Promise<ReaderState> {
    try { this.state = parseState(JSON.parse(await readFile(this.filePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error as Error); this.state = freshState(); }
    return this.snapshot();
  }
  snapshot(): ReaderState { return structuredClone(this.state); }
  record(filePath: string): FileRecord | undefined { return this.state.files[normalizedKey(filePath)]; }
  listRecent(): FileRecord[] { return structuredClone(Object.values(this.state.files).sort((a, b) => b.recentAt - a.recentAt || a.path.localeCompare(b.path))); }

  async updateFile(filePath: string, update: { encoding?: Encoding; offset?: number; length?: number; modifiedAt?: number }): Promise<void> {
    return this.withMutation(async () => {
      const key = normalizedKey(filePath);
      const previous = this.state.files[key];
      const length = update.length ?? previous?.length ?? 0;
      this.state.files[key] = {
        path: filePath, encoding: update.encoding ?? previous?.encoding ?? 'utf8',
        offset: update.offset === undefined ? previous?.offset ?? 0 : clampOffset(update.offset, length || Number.MAX_SAFE_INTEGER),
        length, modifiedAt: update.modifiedAt ?? previous?.modifiedAt ?? 0,
        recentAt: Date.now(), bookmarks: previous?.bookmarks ?? [],
      };
      this.state.lastFile = filePath;
      await this.persist();
    });
  }
  async removeFile(filePath: string): Promise<void> {
    return this.withMutation(async () => {
      delete this.state.files[normalizedKey(filePath)];
      if (this.state.lastFile && normalizedKey(this.state.lastFile) === normalizedKey(filePath)) this.state.lastFile = this.listRecent()[0]?.path ?? null;
      await this.persist();
    });
  }
  async relocateFile(oldPath: string, newPath: string, length: number, modifiedAt: number): Promise<FileRecord> {
    return this.withMutation(async () => {
      if (!path.isAbsolute(oldPath) || !path.isAbsolute(newPath)) throw new Error('文件路径无效。');
      const oldKey = normalizedKey(oldPath);
      const newKey = normalizedKey(newPath);
      const record = this.state.files[oldKey];
      if (!record) throw new Error('找不到原阅读记录。');
      if (newKey !== oldKey && this.state.files[newKey]) throw new Error('新路径已有阅读记录，请先处理该记录。');
      const next = this.snapshot();
      delete next.files[oldKey];
      next.files[newKey] = { ...record, path: newPath, length, modifiedAt, bookmarks: structuredClone(record.bookmarks) };
      if (next.lastFile && normalizedKey(next.lastFile) === oldKey) next.lastFile = newPath;
      await this.persist(next, true);
      return structuredClone(next.files[newKey]);
    });
  }
  async addBookmark(filePath: string, offset: number): Promise<Bookmark[]> {
    return this.withMutation(async () => {
      const record = this.record(filePath);
      if (!record) throw new Error('当前文件没有阅读记录。');
      record.bookmarks.push({ id: randomUUID(), offset: clampOffset(offset, record.length), createdAt: Date.now() });
      await this.persist();
      return structuredClone(record.bookmarks);
    });
  }
  async removeBookmark(filePath: string, id: string): Promise<Bookmark[]> {
    return this.withMutation(async () => {
      const record = this.record(filePath);
      if (!record) throw new Error('当前文件没有阅读记录。');
      record.bookmarks = record.bookmarks.filter((mark) => mark.id !== id);
      await this.persist();
      return structuredClone(record.bookmarks);
    });
  }
  async setFontSize(size: number): Promise<number> {
    return this.withMutation(async () => {
      this.state.fontSize = clampFontSize(size);
      await this.persist();
      return this.state.fontSize;
    });
  }
  async setTheme(theme: Theme): Promise<Theme> {
    return this.withMutation(async () => {
      if (!THEMES.includes(theme)) throw new Error('不支持此主题。');
      this.state.theme = theme;
      await this.persist();
      return theme;
    });
  }
  async setLayout(lineHeight: number, contentWidth: number): Promise<{ lineHeight: number; contentWidth: number }> {
    return this.withMutation(async () => {
      this.state.lineHeight = clampLineHeight(lineHeight);
      this.state.contentWidth = clampContentWidth(contentWidth);
      await this.persist();
      return { lineHeight: this.state.lineHeight, contentWidth: this.state.contentWidth };
    });
  }
  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationGate.then(operation);
    this.mutationGate = result.then(() => {}, () => {});
    return result;
  }
  private persist(state: ReaderState = this.state, replaceAfterWrite = false): Promise<void> {
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
