export type Encoding = 'utf8' | 'gb18030';
export type Theme = 'light' | 'dark' | 'sepia';

export interface Bookmark { id: string; offset: number; createdAt: number }

export interface FileRecord {
  path: string;
  encoding: Encoding;
  offset: number;
  length: number;
  modifiedAt: number;
  recentAt: number;
  bookmarks: Bookmark[];
}

export interface ReaderState {
  version: 2;
  lastFile: string | null;
  fontSize: number;
  theme: Theme;
  files: Record<string, FileRecord>;
}

export interface OpenedBook {
  path: string;
  name: string;
  content: string;
  encoding: Encoding;
  offset: number;
  fontSize: number;
  theme: Theme;
  bookmarks: Bookmark[];
  changed: boolean;
  warning?: string;
}

export type OpenResult = { ok: true; book: OpenedBook } | { ok: false; message: string };

export interface ReaderApi {
  restoreLastFile(): Promise<OpenResult | null>;
  chooseFile(): Promise<OpenResult | null>;
  openFile(path: string, encoding?: Encoding): Promise<OpenResult>;
  saveProgress(path: string, offset: number): Promise<void>;
  setFontSize(size: number): Promise<number>;
  getAppearance(): Promise<{ fontSize: number; theme: Theme }>;
  setTheme(theme: Theme): Promise<Theme>;
  listRecent(): Promise<FileRecord[]>;
  removeRecent(path: string): Promise<void>;
  addBookmark(path: string, offset: number): Promise<Bookmark[]>;
  removeBookmark(path: string, id: string): Promise<Bookmark[]>;
  onRequestProgress(callback: () => void): void;
  submitCloseProgress(path: string | null, offset: number): void;
}

declare global {
  interface Window { reader: ReaderApi }
}

export function clampOffset(offset: number, length: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(length, Math.trunc(offset))) : 0;
}
