export type Encoding = 'utf8' | 'gb18030';
export type Theme = 'light' | 'dark' | 'sepia';
export type BookFormat = 'txt' | 'epub' | 'pdf';

export interface Bookmark { id: string; offset: number; createdAt: number }
export interface FileRecord { path: string; encoding: Encoding; offset: number; length: number; modifiedAt: number; recentAt: number; bookmarks: Bookmark[] }

export type BookPosition =
  | { format: 'txt'; offset: number; length: number; encoding: Encoding }
  | { format: 'epub'; cfi: string; chapter: string; percent: number }
  | { format: 'pdf'; page: number; fraction: number; pageCount: number };
export interface BookBookmark { id: string; createdAt: number; position: BookPosition }
export type AnnotationAnchor = { format: 'txt'; start: number; end: number } | { format: 'epub'; cfi: string; chapter: string };
export interface Annotation {
  id: string; bookId: string; anchor: AnnotationAnchor; text: string; prefix: string; suffix: string;
  note: string; status: 'anchored' | 'unresolved'; createdAt: number; updatedAt: number;
}
export type AnnotationDraft = Pick<Annotation, 'anchor' | 'text' | 'prefix' | 'suffix' | 'note'>;
export interface BookRecord {
  id: string; format: BookFormat; path: string; title: string; author: string;
  coverKey: string | null; importedAt: number; recentAt: number; size: number;
  modifiedAt: number; position: BookPosition; bookmarks: BookBookmark[]; annotations: Annotation[];
}
export interface ReaderState {
  version: 5; lastBookId: string | null; fontSize: number; theme: Theme;
  lineHeight: number; contentWidth: number; books: Record<string, BookRecord>;
}

export interface OpenedBook {
  id: string; path: string; name: string; content: string; encoding: Encoding; offset: number;
  fontSize: number; theme: Theme; lineHeight: number; contentWidth: number;
  bookmarks: Bookmark[]; annotations: Annotation[]; changed: boolean; warning?: string;
}
export type OpenResult = { ok: true; book: OpenedBook } | { ok: false; message: string };
export interface ImportResult { added: BookRecord[]; errors: { path: string; message: string }[] }
export type PublicationResult = { ok: true; book: BookRecord; url: string; changed: boolean } | { ok: false; message: string };
export interface ReaderApi {
  restoreLastFile(): Promise<OpenResult | null>;
  chooseFile(): Promise<OpenResult | null>;
  openFile(path: string, encoding?: Encoding): Promise<OpenResult>;
  saveProgress(path: string, offset: number): Promise<void>;
  setFontSize(size: number): Promise<number>;
  getAppearance(): Promise<{ fontSize: number; theme: Theme; lineHeight: number; contentWidth: number }>;
  setTheme(theme: Theme): Promise<Theme>;
  setLayout(lineHeight: number, contentWidth: number): Promise<{ lineHeight: number; contentWidth: number }>;
  listRecent(): Promise<FileRecord[]>;
  relocateFile(path: string): Promise<OpenResult | null>;
  removeRecent(path: string): Promise<void>;
  addBookmark(path: string, offset: number): Promise<Bookmark[]>;
  removeBookmark(path: string, id: string): Promise<Bookmark[]>;
  onRequestProgress(callback: () => void): void;
  submitCloseProgress(path: string | null, offset: number): void;
  chooseBooks(): Promise<ImportResult | null>;
  listBooks(): Promise<BookRecord[]>;
  getLastBookId(): Promise<string | null>;
  getStartupWarning(): Promise<string | null>;
  openPublication(id: string): Promise<PublicationResult>;
  readPublication(id: string): Promise<Uint8Array>;
  saveBookPosition(id: string, position: BookPosition): Promise<void>;
  addBookBookmark(id: string, position: BookPosition): Promise<BookBookmark[]>;
  removeBookBookmark(id: string, markId: string): Promise<BookBookmark[]>;
  removeBook(id: string): Promise<void>;
  relocateBook(id: string): Promise<PublicationResult | null>;
  coverData(id: string): Promise<string | null>;
  addAnnotation(id: string, draft: AnnotationDraft): Promise<Annotation[]>;
  updateAnnotationNote(id: string, annotationId: string, note: string): Promise<Annotation[]>;
  removeAnnotation(id: string, annotationId: string): Promise<Annotation[]>;
  setAnnotationAnchor(id: string, annotationId: string, anchor: AnnotationAnchor | null): Promise<Annotation[]>;
}

declare global { interface Window { reader: ReaderApi } }
export function clampOffset(offset: number, length: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(length, Math.trunc(offset))) : 0;
}
