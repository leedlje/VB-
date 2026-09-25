import './style.css';
import { safePosition, scrollTarget } from './position.ts';
import type { Encoding, OpenedBook, OpenResult } from '../shared/types.ts';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewport = byId<HTMLElement>('viewport');
const content = byId<HTMLElement>('content');
const empty = byId<HTMLElement>('empty');
const title = byId<HTMLElement>('book-title');
const progress = byId<HTMLElement>('progress');
const message = byId<HTMLElement>('message');
const encoding = byId<HTMLSelectElement>('encoding');
const fontSizeLabel = byId<HTMLElement>('font-size');
let currentBook: OpenedBook | null = null;
let fontSize = 18;
let pendingAnchor: number | null = null;
let saveTimer: number | undefined;
let messageTimer: number | undefined;

function notify(text: string): void {
  message.textContent = text;
  message.hidden = false;
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => { message.hidden = true; }, 6500);
}

function currentOffset(): number {
  if (!currentBook) return 0;
  if (pendingAnchor !== null) return pendingAnchor;
  const textNode = content.firstChild;
  if (!textNode) return 0;
  const rect = content.getBoundingClientRect();
  const viewRect = viewport.getBoundingClientRect();
  const x = Math.min(rect.right - 2, rect.left + parseFloat(getComputedStyle(content).paddingLeft) + 8);
  const y = Math.max(viewRect.top + 8, rect.top + parseFloat(getComputedStyle(content).paddingTop) + 2);
  const range = document.caretRangeFromPoint(x, y);
  return range?.startContainer === textNode ? safePosition(range.startOffset, currentBook.content) : 0;
}

function restoreOffset(offset: number): void {
  if (!currentBook || !content.firstChild || currentBook.content.length === 0) return;
  const range = document.createRange();
  const start = Math.min(safePosition(offset, currentBook.content), currentBook.content.length - 1);
  range.setStart(content.firstChild, start);
  range.setEnd(content.firstChild, start + 1);
  const rect = range.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  if (rect.height || rect.width) viewport.scrollTop = scrollTarget(viewport.scrollTop, rect.top, viewportRect.top);
  updateProgress();
}

function updateProgress(): void {
  if (!currentBook) { progress.textContent = ''; return; }
  const percent = Math.round(currentOffset() / Math.max(1, currentBook.content.length) * 100);
  progress.textContent = `${percent}%`;
}

async function saveProgress(): Promise<void> {
  if (!currentBook) return;
  try { await window.reader.saveProgress(currentBook.path, currentOffset()); }
  catch { notify('阅读进度保存失败，请检查磁盘空间或文件权限。'); }
}

function queueProgress(): void {
  updateProgress();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void saveProgress(); }, 350);
}

function showBook(book: OpenedBook): void {
  window.clearTimeout(saveTimer);
  pendingAnchor = null;
  currentBook = book;
  fontSize = book.fontSize;
  content.style.setProperty('--reader-font-size', `${fontSize}px`);
  fontSizeLabel.textContent = String(fontSize);
  content.textContent = book.content;
  content.hidden = false;
  empty.hidden = true;
  title.textContent = book.name;
  document.title = `${book.name} · TXT 阅读器`;
  encoding.disabled = false;
  encoding.value = book.encoding;
  viewport.scrollTop = 0;
  requestAnimationFrame(() => restoreOffset(book.offset));
  if (book.warning) notify(book.warning);
}

function handleResult(result: OpenResult | null): void {
  if (!result) return;
  if (result.ok) showBook(result.book);
  else notify(result.message);
}

async function chooseFile(): Promise<void> {
  window.clearTimeout(saveTimer);
  await saveProgress();
  try { handleResult(await window.reader.chooseFile()); }
  catch { notify('无法打开文件选择窗口，请重试。'); }
}

async function changeEncoding(next: Encoding): Promise<void> {
  if (!currentBook) return;
  window.clearTimeout(saveTimer);
  await saveProgress();
  const offset = currentOffset();
  const oldEncoding = currentBook.encoding;
  try {
    const result = await window.reader.openFile(currentBook.path, next);
    if (result.ok) showBook({ ...result.book, offset });
    else { encoding.value = oldEncoding; notify(result.message); }
  } catch { encoding.value = oldEncoding; notify('切换编码失败，请重试。'); }
}

async function changeFontSize(delta: number): Promise<void> {
  const offset = currentOffset();
  pendingAnchor = offset;
  try {
    await saveProgress();
    fontSize = await window.reader.setFontSize(fontSize + delta);
    content.style.setProperty('--reader-font-size', `${fontSize}px`);
    fontSizeLabel.textContent = String(fontSize);
    requestAnimationFrame(() => { restoreOffset(offset); pendingAnchor = null; queueProgress(); });
  } catch { pendingAnchor = null; notify('字号设置保存失败，请检查磁盘空间或文件权限。'); }
}

byId<HTMLButtonElement>('open').addEventListener('click', () => { void chooseFile(); });
byId<HTMLButtonElement>('empty-open').addEventListener('click', () => { void chooseFile(); });
byId<HTMLButtonElement>('smaller').addEventListener('click', () => { void changeFontSize(-2); });
byId<HTMLButtonElement>('larger').addEventListener('click', () => { void changeFontSize(2); });
encoding.addEventListener('change', () => { void changeEncoding(encoding.value as Encoding); });
viewport.addEventListener('scroll', queueProgress, { passive: true });
window.reader.onRequestProgress(() => window.reader.submitCloseProgress(currentBook?.path ?? null, currentOffset()));

window.reader.restoreLastFile().then(handleResult).catch(() => notify('恢复上次阅读失败，请重新选择 TXT 文件。'));
