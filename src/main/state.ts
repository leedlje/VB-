import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizedKey } from './book.ts';
import { clampOffset, type Bookmark, type Encoding, type FileRecord, type ReaderState, type Theme } from '../shared/types.ts';

export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 32;
export const THEMES: Theme[] = ['light', 'dark', 'sepia'];

export function freshState(): ReaderState { return { version: 2, lastFile: null, fontSize: DEFAULT_FONT_SIZE, theme: 'light', files: {} }; }
export function clampFontSize(size: number): number {
  return Number.isFinite(size) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size))) : DEFAULT_FONT_SIZE;
}

export function parseState(value: unknown): ReaderState {
  const state = freshState();
  if (!value || typeof value !== 'object') return state;
  const source = value as { version?: number } & Omit<Partial<ReaderState>, 'version'>;
  if (source.version !== 1 && source.version !== 2) return state;
  if (typeof source.lastFile === 'string' && path.isAbsolute(source.lastFile)) state.lastFile = source.lastFile;
  if (typeof source.fontSize === 'number') state.fontSize = clampFontSize(source.fontSize);
  if (THEMES.includes(source.theme as Theme)) state.theme = source.theme as Theme;
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
  }
  async removeFile(filePath: string): Promise<void> {
    delete this.state.files[normalizedKey(filePath)];
    if (this.state.lastFile && normalizedKey(this.state.lastFile) === normalizedKey(filePath)) this.state.lastFile = this.listRecent()[0]?.path ?? null;
    await this.persist();
  }
  async addBookmark(filePath: string, offset: number): Promise<Bookmark[]> {
    const record = this.record(filePath);
    if (!record) throw new Error('当前文件没有阅读记录。');
    record.bookmarks.push({ id: randomUUID(), offset: clampOffset(offset, record.length), createdAt: Date.now() });
    await this.persist();
    return structuredClone(record.bookmarks);
  }
  async removeBookmark(filePath: string, id: string): Promise<Bookmark[]> {
    const record = this.record(filePath);
    if (!record) throw new Error('当前文件没有阅读记录。');
    record.bookmarks = record.bookmarks.filter((mark) => mark.id !== id);
    await this.persist();
    return structuredClone(record.bookmarks);
  }
  async setFontSize(size: number): Promise<number> {
    this.state.fontSize = clampFontSize(size);
    await this.persist();
    return this.state.fontSize;
  }
  async setTheme(theme: Theme): Promise<Theme> {
    if (!THEMES.includes(theme)) throw new Error('不支持此主题。');
    this.state.theme = theme;
    await this.persist();
    return theme;
  }
  private persist(): Promise<void> {
    const serialized = JSON.stringify(this.state);
    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, serialized, 'utf8');
      await rename(temp, this.filePath);
    };
    this.pending = this.pending.catch(() => {}).then(write);
    return this.pending.catch((error: Error) => { this.onError(error); throw error; });
  }
}
