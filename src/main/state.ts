import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizedKey } from './book.ts';
import { clampOffset, type Encoding, type ReaderState } from '../shared/types.ts';

export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 32;

export function freshState(): ReaderState { return { version: 1, lastFile: null, fontSize: DEFAULT_FONT_SIZE, files: {} }; }
export function clampFontSize(size: number): number {
  return Number.isFinite(size) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size))) : DEFAULT_FONT_SIZE;
}

export function parseState(value: unknown): ReaderState {
  const state = freshState();
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return state;
  const source = value as Partial<ReaderState>;
  if (typeof source.lastFile === 'string') state.lastFile = source.lastFile;
  if (typeof source.fontSize === 'number') state.fontSize = clampFontSize(source.fontSize);
  if (source.files && typeof source.files === 'object' && !Array.isArray(source.files)) {
    for (const entry of Object.values(source.files)) {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue;
      if (entry.encoding !== 'utf8' && entry.encoding !== 'gb18030') continue;
      state.files[normalizedKey(entry.path)] = { path: entry.path, encoding: entry.encoding, offset: clampOffset(entry.offset, Number.MAX_SAFE_INTEGER) };
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
  record(filePath: string) { return this.state.files[normalizedKey(filePath)]; }

  async updateFile(filePath: string, update: { encoding?: Encoding; offset?: number }): Promise<void> {
    const key = normalizedKey(filePath);
    const previous = this.state.files[key];
    this.state.files[key] = {
      path: filePath,
      encoding: update.encoding ?? previous?.encoding ?? 'utf8',
      offset: update.offset === undefined ? previous?.offset ?? 0 : clampOffset(update.offset, Number.MAX_SAFE_INTEGER),
    };
    this.state.lastFile = filePath;
    return this.persist();
  }
  async setFontSize(size: number): Promise<number> {
    this.state.fontSize = clampFontSize(size);
    await this.persist();
    return this.state.fontSize;
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
