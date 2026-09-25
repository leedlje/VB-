export type Encoding = 'utf8' | 'gb18030';

export interface FileRecord {
  path: string;
  encoding: Encoding;
  offset: number;
}

export interface ReaderState {
  version: 1;
  lastFile: string | null;
  fontSize: number;
  files: Record<string, FileRecord>;
}

export interface OpenedBook {
  path: string;
  name: string;
  content: string;
  encoding: Encoding;
  offset: number;
  fontSize: number;
  warning?: string;
}

export type OpenResult = { ok: true; book: OpenedBook } | { ok: false; message: string };

export interface ReaderApi {
  restoreLastFile(): Promise<OpenResult | null>;
  chooseFile(): Promise<OpenResult | null>;
  openFile(path: string, encoding?: Encoding): Promise<OpenResult>;
  saveProgress(path: string, offset: number): Promise<void>;
  setFontSize(size: number): Promise<number>;
  onRequestProgress(callback: () => void): void;
  submitCloseProgress(path: string | null, offset: number): void;
}

declare global {
  interface Window { reader: ReaderApi }
}

export function clampOffset(offset: number, length: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(length, Math.trunc(offset))) : 0;
}
