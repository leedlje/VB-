import './style.css';
import { safePosition, scrollTarget } from './position.ts';
import { findMatches } from './search.ts';
import type { Encoding, OpenedBook, OpenResult, Theme } from '../shared/types.ts';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewport = byId<HTMLElement>('viewport');
const content = byId<HTMLElement>('content');
const empty = byId<HTMLElement>('empty');
const title = byId<HTMLElement>('book-title');
const progress = byId<HTMLElement>('progress');
const message = byId<HTMLElement>('message');
const encoding = byId<HTMLSelectElement>('encoding');
const theme = byId<HTMLSelectElement>('theme');
const fontSizeLabel = byId<HTMLElement>('font-size');
const searchInput = byId<HTMLInputElement>('search-input');
const searchCount = byId<HTMLElement>('search-count');
const searchPrev = byId<HTMLButtonElement>('search-prev');
const searchNext = byId<HTMLButtonElement>('search-next');
let currentBook: OpenedBook | null = null;
let fontSize = 18;
let pendingAnchor: number | null = null;
let saveTimer: number | undefined;
let messageTimer: number | undefined;
let searchGeneration = 0;
let matches: number[] = [];
let matchIndex = -1;

function notify(text: string): void {
  message.textContent = text;
  message.hidden = false;
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => { message.hidden = true; }, 6500);
}

function applyTheme(value: Theme): void { document.documentElement.dataset.theme = value; theme.value = value; }

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

function jumpTo(offset: number): void {
  if (!currentBook) return;
  const safe = safePosition(offset, currentBook.content);
  pendingAnchor = safe;
  requestAnimationFrame(() => { restoreOffset(safe); pendingAnchor = null; queueProgress(); });
}

function updateProgress(): void {
  progress.textContent = currentBook ? `${Math.round(currentOffset() / Math.max(1, currentBook.content.length) * 100)}%` : '';
}

async function saveProgress(): Promise<void> {
  if (!currentBook) return;
  try { await window.reader.saveProgress(currentBook.path, currentOffset()); }
  catch { notify('阅读进度保存失败，请检查磁盘空间或文件权限。'); }
}

function queueProgress(): void {
  updateProgress();
  window.clearTimeout(saveTimer);
  if (currentBook) saveTimer = window.setTimeout(() => { void saveProgress(); }, 350);
}

function clearHighlights(): void {
  if ('highlights' in CSS) {
    CSS.highlights.delete('search-results');
    CSS.highlights.delete('search-active');
  }
}

function paintMatches(): void {
  clearHighlights();
  if (!currentBook || !content.firstChild || !('highlights' in CSS)) return;
  const node = content.firstChild;
  const queryLength = searchInput.value.length;
  const ranges = matches.slice(0, 2000).map((offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(currentBook!.content.length, offset + queryLength));
    return range;
  });
  CSS.highlights.set('search-results', new Highlight(...ranges));
  if (matchIndex >= 0) {
    const active = document.createRange();
    active.setStart(node, matches[matchIndex]);
    active.setEnd(node, Math.min(currentBook.content.length, matches[matchIndex] + queryLength));
    CSS.highlights.set('search-active', new Highlight(active));
  }
}

function updateSearchCount(): void {
  searchCount.textContent = !searchInput.value ? '输入文字开始搜索' : matches.length ? `${matchIndex + 1} / ${matches.length}` : '没有结果';
  searchPrev.disabled = searchNext.disabled = matches.length === 0;
}

async function runSearch(): Promise<void> {
  const generation = ++searchGeneration;
  matches = [];
  matchIndex = -1;
  clearHighlights();
  searchPrev.disabled = searchNext.disabled = true;
  if (!currentBook || !searchInput.value) { updateSearchCount(); return; }
  searchCount.textContent = '正在搜索…';
  const found = await findMatches(currentBook.content, searchInput.value, () => generation !== searchGeneration);
  if (!found || generation !== searchGeneration) return;
  matches = found;
  matchIndex = found.length ? 0 : -1;
  updateSearchCount();
  paintMatches();
  if (found.length) jumpTo(found[0]);
}

function stepMatch(delta: number): void {
  if (!matches.length) return;
  matchIndex = (matchIndex + delta + matches.length) % matches.length;
  updateSearchCount();
  paintMatches();
  jumpTo(matches[matchIndex]);
}

function renderBookmarks(): void {
  const list = byId<HTMLUListElement>('bookmarks-list');
  list.replaceChildren();
  const marks = currentBook?.bookmarks ?? [];
  byId<HTMLElement>('bookmarks-empty').hidden = marks.length > 0;
  byId<HTMLButtonElement>('bookmark-add').disabled = !currentBook;
  for (const mark of marks) {
    const item = document.createElement('li');
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = `${Math.round(mark.offset / Math.max(1, currentBook!.content.length) * 100)}% · ${new Date(mark.createdAt).toLocaleString()}`;
    jump.addEventListener('click', () => jumpTo(mark.offset));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', '删除书签');
    remove.addEventListener('click', async () => {
      if (!currentBook) return;
      try { currentBook.bookmarks = await window.reader.removeBookmark(currentBook.path, mark.id); renderBookmarks(); }
      catch { notify('删除书签失败，请重试。'); }
    });
    item.append(jump, remove);
    list.append(item);
  }
}

function clearBook(): void {
  window.clearTimeout(saveTimer);
  currentBook = null;
  content.textContent = '';
  content.hidden = true;
  empty.hidden = false;
  title.textContent = '还没有打开书籍';
  document.title = 'TXT 阅读器';
  encoding.disabled = true;
  updateProgress();
  searchInput.value = '';
  void runSearch();
  renderBookmarks();
}

async function renderRecent(): Promise<void> {
  const list = byId<HTMLUListElement>('recent-list');
  const records = await window.reader.listRecent();
  list.replaceChildren();
  byId<HTMLElement>('recent-empty').hidden = records.length > 0;
  for (const record of records) {
    const item = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = `${record.path.split(/[\\/]/).pop()} · ${record.length ? `${Math.round(record.offset / record.length * 100)}%` : '进度待更新'}`;
    open.title = record.path;
    open.addEventListener('click', async () => {
      window.clearTimeout(saveTimer);
      await saveProgress();
      try { handleResult(await window.reader.openFile(record.path)); }
      catch { notify('无法打开文件，请重试。'); }
    });
    const details = document.createElement('small');
    details.textContent = record.recentAt ? new Date(record.recentAt).toLocaleString() : '旧版阅读记录';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除 ${record.path.split(/[\\/]/).pop()} 的阅读记录`);
    remove.addEventListener('click', async () => {
      try {
        const active = currentBook?.path === record.path;
        window.clearTimeout(saveTimer);
        await window.reader.removeRecent(record.path);
        if (active) clearBook();
        await renderRecent();
      } catch { notify('移除阅读记录失败，请重试。'); }
    });
    item.append(open, details, remove);
    list.append(item);
  }
}

function showBook(book: OpenedBook): void {
  window.clearTimeout(saveTimer);
  pendingAnchor = null;
  currentBook = book;
  fontSize = book.fontSize;
  content.style.setProperty('--reader-font-size', `${fontSize}px`);
  fontSizeLabel.textContent = String(fontSize);
  applyTheme(book.theme);
  content.textContent = book.content;
  content.hidden = false;
  empty.hidden = true;
  title.textContent = book.name;
  document.title = `${book.name} · TXT 阅读器`;
  encoding.disabled = false;
  encoding.value = book.encoding;
  viewport.scrollTop = 0;
  jumpTo(book.offset);
  searchInput.value = '';
  void runSearch();
  renderBookmarks();
  void renderRecent();
  if (book.changed) notify('文件内容已变化，旧进度或书签位置可能不再精确。');
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
    if (result.ok) showBook({ ...result.book, offset: safePosition(offset, result.book.content) });
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

async function changeTheme(next: Theme): Promise<void> {
  const offset = currentOffset();
  const previous = document.documentElement.dataset.theme as Theme;
  pendingAnchor = offset;
  try {
    await saveProgress();
    applyTheme(await window.reader.setTheme(next));
    if (currentBook) currentBook.theme = next;
    requestAnimationFrame(() => { restoreOffset(offset); pendingAnchor = null; queueProgress(); });
  } catch { pendingAnchor = null; applyTheme(previous); notify('主题设置保存失败，请重试。'); }
}

function togglePanel(panelId: string, toggleId: string): void {
  const panel = byId<HTMLElement>(panelId);
  panel.hidden = !panel.hidden;
  byId<HTMLButtonElement>(toggleId).setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden && panelId === 'recent-panel') void renderRecent();
  if (!panel.hidden && panelId === 'searchbar') searchInput.focus();
}

byId<HTMLButtonElement>('open').addEventListener('click', () => { void chooseFile(); });
byId<HTMLButtonElement>('empty-open').addEventListener('click', () => { void chooseFile(); });
byId<HTMLButtonElement>('recent-toggle').addEventListener('click', () => togglePanel('recent-panel', 'recent-toggle'));
byId<HTMLButtonElement>('search-toggle').addEventListener('click', () => togglePanel('searchbar', 'search-toggle'));
byId<HTMLButtonElement>('bookmarks-toggle').addEventListener('click', () => togglePanel('bookmarks-panel', 'bookmarks-toggle'));
byId<HTMLButtonElement>('smaller').addEventListener('click', () => { void changeFontSize(-2); });
byId<HTMLButtonElement>('larger').addEventListener('click', () => { void changeFontSize(2); });
byId<HTMLButtonElement>('bookmark-add').addEventListener('click', async () => {
  if (!currentBook) return;
  try { currentBook.bookmarks = await window.reader.addBookmark(currentBook.path, currentOffset()); renderBookmarks(); }
  catch { notify('添加书签失败，请重试。'); }
});
searchInput.addEventListener('input', () => { void runSearch(); });
searchPrev.addEventListener('click', () => stepMatch(-1));
searchNext.addEventListener('click', () => stepMatch(1));
encoding.addEventListener('change', () => { void changeEncoding(encoding.value as Encoding); });
theme.addEventListener('change', () => { void changeTheme(theme.value as Theme); });
viewport.addEventListener('scroll', queueProgress, { passive: true });
window.reader.onRequestProgress(() => window.reader.submitCloseProgress(currentBook?.path ?? null, currentOffset()));

window.reader.getAppearance().then((appearance) => {
  fontSize = appearance.fontSize;
  fontSizeLabel.textContent = String(fontSize);
  applyTheme(appearance.theme);
}).catch(() => notify('读取阅读设置失败，已使用默认外观。'));
window.reader.restoreLastFile().then(handleResult).catch(() => notify('恢复上次阅读失败，请重新选择 TXT 文件。'));
