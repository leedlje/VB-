import './style.css';
import { safePosition, scrollTarget } from './position.ts';
import { findMatches } from './search.ts';
import type { PublicationView, SearchHit } from './publications.ts';
import type { BookPosition, BookRecord, Encoding, OpenedBook, OpenResult, Theme } from '../shared/types.ts';

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
let lineHeight = 1.9;
let contentWidth = 820;
let lastKnownOffset = 0;
let resizeAnchor: number | null = null;
let resizeTimer: number | undefined;
let lastPanel = '';
let pendingAnchor: number | null = null;
let saveTimer: number | undefined;
let messageTimer: number | undefined;
let searchGeneration = 0;
let matches: number[] = [];
let matchIndex = -1;
let activePublication: BookRecord | null = null;
let publicationView: PublicationView | null = null;
let publicationMatches: SearchHit[] = [];
let publicationMatchIndex = -1;
let publicationSearchGeneration = 0;
let pdfZoom = 1;

function notify(text: string): void {
  message.textContent = text;
  message.hidden = false;
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => { message.hidden = true; }, 6500);
}

function applyTheme(value: Theme): void { document.documentElement.dataset.theme = value; theme.value = value; }
function applyLayout(): void {
  content.style.setProperty('--reader-line-height', String(lineHeight));
  content.style.setProperty('--reader-width', `${contentWidth}px`);
  byId<HTMLOutputElement>('line-height').textContent = lineHeight.toFixed(1);
  byId<HTMLOutputElement>('content-width').textContent = `${contentWidth} px`;
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

function jumpTo(offset: number): void {
  if (!currentBook) return;
  const safe = safePosition(offset, currentBook.content);
  pendingAnchor = safe;
  requestAnimationFrame(() => { restoreOffset(safe); pendingAnchor = null; queueProgress(); });
}

function updateProgress(): void {
  if (activePublication && publicationView) {
    const position = publicationView.position();
    progress.textContent = position.format === 'epub' ? `${position.percent}%` : position.format === 'pdf' ? `第 ${position.page} / ${position.pageCount} 页` : '';
    if (position.format === 'pdf') byId<HTMLInputElement>('pdf-page').value = String(position.page);
    return;
  }
  if (currentBook) lastKnownOffset = currentOffset();
  progress.textContent = currentBook ? `${Math.round(currentOffset() / Math.max(1, currentBook.content.length) * 100)}%` : '';
}

async function saveProgress(): Promise<void> {
  if (activePublication && publicationView) {
    try { await window.reader.saveBookPosition(activePublication.id, publicationView.position()); }
    catch { notify('阅读进度保存失败，请检查磁盘空间或文件权限。'); }
    return;
  }
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
  if (activePublication) {
    searchCount.textContent = !searchInput.value ? '输入文字开始搜索' : publicationMatches.length ? `${publicationMatchIndex + 1} / ${publicationMatches.length}` : '没有结果';
    searchPrev.disabled = searchNext.disabled = publicationMatches.length === 0;
    return;
  }
  searchCount.textContent = !searchInput.value ? '输入文字开始搜索' : matches.length ? `${matchIndex + 1} / ${matches.length}` : '没有结果';
  searchPrev.disabled = searchNext.disabled = matches.length === 0;
}

async function runSearch(): Promise<void> {
  if (activePublication && publicationView) {
    const generation = ++publicationSearchGeneration;
    publicationMatches = []; publicationMatchIndex = -1;
    if (!searchInput.value) { updateSearchCount(); return; }
    searchCount.textContent = '正在逐章或逐页搜索…';
    try {
      const view = publicationView;
      const hits = await view.search(searchInput.value, () => generation !== publicationSearchGeneration || view !== publicationView, (count) => {
        if (generation === publicationSearchGeneration) searchCount.textContent = `正在搜索…已找到 ${count} 处`;
      });
      if (generation !== publicationSearchGeneration || view !== publicationView) return;
      publicationMatches = hits;
      publicationMatchIndex = hits.length ? 0 : -1;
      updateSearchCount();
      if (hits.length) await view.go(hits[0].position);
    } catch (error) {
      if (generation === publicationSearchGeneration) { searchCount.textContent = error instanceof Error ? error.message : '搜索失败'; notify(searchCount.textContent); }
    }
    return;
  }
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
  if (activePublication && publicationView) {
    if (!publicationMatches.length) return;
    publicationMatchIndex = (publicationMatchIndex + delta + publicationMatches.length) % publicationMatches.length;
    updateSearchCount();
    void publicationView.go(publicationMatches[publicationMatchIndex].position);
    return;
  }
  if (!matches.length) return;
  matchIndex = (matchIndex + delta + matches.length) % matches.length;
  updateSearchCount();
  paintMatches();
  jumpTo(matches[matchIndex]);
}

function renderBookmarks(): void {
  const list = byId<HTMLUListElement>('bookmarks-list');
  list.replaceChildren();
  const marks = currentBook?.bookmarks ?? activePublication?.bookmarks ?? [];
  byId<HTMLElement>('bookmarks-empty').hidden = marks.length > 0;
  byId<HTMLButtonElement>('bookmark-add').disabled = !currentBook && !activePublication;
  for (const mark of marks) {
    const item = document.createElement('li');
    const jump = document.createElement('button');
    jump.type = 'button';
    if ('position' in mark) {
      jump.textContent = `${mark.position.format === 'epub' ? `${mark.position.percent}%` : mark.position.format === 'pdf' ? `第 ${mark.position.page} 页` : ''} · ${new Date(mark.createdAt).toLocaleString()}`;
      jump.addEventListener('click', () => { void publicationView?.go(mark.position); });
    } else {
      jump.textContent = `${Math.round(mark.offset / Math.max(1, currentBook!.content.length) * 100)}% · ${new Date(mark.createdAt).toLocaleString()}`;
      jump.addEventListener('click', () => jumpTo(mark.offset));
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', '删除书签');
    remove.addEventListener('click', async () => {
      if (!currentBook && !activePublication) return;
      try {
        if (activePublication) activePublication.bookmarks = await window.reader.removeBookBookmark(activePublication.id, mark.id);
        else if (currentBook) currentBook.bookmarks = await window.reader.removeBookmark(currentBook.path, mark.id);
        renderBookmarks();
      }
      catch { notify('删除书签失败，请重试。'); }
    });
    item.append(jump, remove);
    list.append(item);
  }
}

function clearBook(): void {
  window.clearTimeout(saveTimer);
  currentBook = null;
  if (publicationView) { void publicationView.dispose(); publicationView = null; }
  activePublication = null;
  ++publicationSearchGeneration;
  byId<HTMLElement>('publication-view').hidden = true;
  byId<HTMLElement>('publication-controls').hidden = true;
  byId<HTMLElement>('chapters-panel').hidden = true;
  byId<HTMLButtonElement>('smaller').disabled = byId<HTMLButtonElement>('larger').disabled = false;
  byId<HTMLButtonElement>('layout-toggle').disabled = false;
  content.textContent = '';
  content.hidden = true;
  empty.hidden = false;
  title.textContent = '还没有打开书籍';
  document.title = 'VB阅读器';
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
    const relocate = document.createElement('button');
    relocate.type = 'button';
    relocate.textContent = '重新定位';
    relocate.setAttribute('aria-label', `重新定位 ${record.path.split(/[\\/]/).pop()}`);
    relocate.addEventListener('click', async () => {
      window.clearTimeout(saveTimer);
      await saveProgress();
      try { handleResult(await window.reader.relocateFile(record.path)); }
      catch { notify('重新定位失败，原阅读记录已保留。'); }
    });
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
    item.append(open, details, relocate, remove);
    list.append(item);
  }
}

function showBook(book: OpenedBook): void {
  if (publicationView) { void publicationView.dispose(); publicationView = null; }
  activePublication = null;
  byId<HTMLElement>('publication-view').hidden = true;
  byId<HTMLElement>('publication-controls').hidden = true;
  byId<HTMLElement>('shelf').hidden = true;
  byId<HTMLButtonElement>('smaller').disabled = byId<HTMLButtonElement>('larger').disabled = false;
  byId<HTMLButtonElement>('layout-toggle').disabled = false;
  window.clearTimeout(saveTimer);
  pendingAnchor = null;
  currentBook = book;
  fontSize = book.fontSize;
  lineHeight = book.lineHeight;
  contentWidth = book.contentWidth;
  content.style.setProperty('--reader-font-size', `${fontSize}px`);
  applyLayout();
  fontSizeLabel.textContent = String(fontSize);
  applyTheme(book.theme);
  content.textContent = book.content;
  content.hidden = false;
  empty.hidden = true;
  title.textContent = book.name;
  document.title = `${book.name} · VB阅读器`;
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
  if (activePublication?.format === 'pdf') return;
  const offset = currentOffset();
  pendingAnchor = offset;
  try {
    await saveProgress();
    fontSize = await window.reader.setFontSize(fontSize + delta);
    content.style.setProperty('--reader-font-size', `${fontSize}px`);
    fontSizeLabel.textContent = String(fontSize);
    publicationView?.setAppearance(fontSize, lineHeight, contentWidth, document.documentElement.dataset.theme ?? 'light');
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
    publicationView?.setAppearance(fontSize, lineHeight, contentWidth, next);
    if (currentBook) currentBook.theme = next;
    requestAnimationFrame(() => { restoreOffset(offset); pendingAnchor = null; queueProgress(); });
  } catch { pendingAnchor = null; applyTheme(previous); notify('主题设置保存失败，请重试。'); }
}

async function changeLayout(lineDelta: number, widthDelta: number): Promise<void> {
  if (activePublication?.format === 'pdf') return;
  const offset = currentOffset();
  pendingAnchor = offset;
  try {
    await saveProgress();
    const next = await window.reader.setLayout(lineHeight + lineDelta, contentWidth + widthDelta);
    lineHeight = next.lineHeight;
    contentWidth = next.contentWidth;
    if (currentBook) { currentBook.lineHeight = lineHeight; currentBook.contentWidth = contentWidth; }
    applyLayout();
    publicationView?.setAppearance(fontSize, lineHeight, contentWidth, document.documentElement.dataset.theme ?? 'light');
    requestAnimationFrame(() => { restoreOffset(offset); pendingAnchor = null; queueProgress(); });
  } catch { pendingAnchor = null; notify('排版设置保存失败，请重试。'); }
}

const panels: Record<string, string> = {
  'recent-panel': 'recent-toggle', 'bookmarks-panel': 'bookmarks-toggle',
  searchbar: 'search-toggle', layoutbar: 'layout-toggle',
};

function closePanel(panelId: string, restoreFocus = false): void {
  const panel = byId<HTMLElement>(panelId);
  if (panel.hidden) return;
  panel.hidden = true;
  byId<HTMLButtonElement>(panels[panelId]).setAttribute('aria-expanded', 'false');
  if (panelId === 'searchbar') { searchInput.value = ''; void runSearch(); }
  if (restoreFocus) (currentBook || activePublication ? viewport : byId<HTMLButtonElement>(panels[panelId])).focus();
}

function togglePanel(panelId: string, toggleId: string): void {
  const panel = byId<HTMLElement>(panelId);
  if (!panel.hidden) { closePanel(panelId); return; }
  if (panelId === 'recent-panel') closePanel('bookmarks-panel');
  if (panelId === 'bookmarks-panel') closePanel('recent-panel');
  panel.hidden = false;
  lastPanel = panelId;
  byId<HTMLButtonElement>(toggleId).setAttribute('aria-expanded', 'true');
  if (!panel.hidden && panelId === 'recent-panel') void renderRecent();
  if (!panel.hidden && panelId === 'searchbar') searchInput.focus();
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && key === 'o') { event.preventDefault(); void chooseFile(); return; }
  if (event.ctrlKey && key === 'f') {
    event.preventDefault();
    if (byId<HTMLElement>('searchbar').hidden) togglePanel('searchbar', 'search-toggle');
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (!event.ctrlKey && key === 'f3' && !byId<HTMLElement>('searchbar').hidden) {
    event.preventDefault();
    stepMatch(event.shiftKey ? -1 : 1);
    return;
  }
  if (!event.ctrlKey && key === 'escape') {
    const active = [lastPanel, 'searchbar', 'recent-panel', 'bookmarks-panel', 'layoutbar']
      .find((id) => id && !byId<HTMLElement>(id).hidden);
    if (active) { event.preventDefault(); closePanel(active, true); }
  }
}

function shelfProgress(book: BookRecord): string {
  const position = book.position;
  if (position.format === 'txt') return `${Math.round(position.offset / Math.max(1, position.length) * 100)}%`;
  if (position.format === 'epub') return `${position.percent}%`;
  return `第 ${position.page} / ${position.pageCount} 页`;
}
async function renderShelf(): Promise<void> {
  const list = byId<HTMLElement>('shelf-list');
  const books = await window.reader.listBooks();
  const query = byId<HTMLInputElement>('shelf-search').value.trim().toLocaleLowerCase();
  const format = byId<HTMLSelectElement>('shelf-format').value;
  const sort = byId<HTMLSelectElement>('shelf-sort').value;
  const filtered = books.filter((book) => (format === 'all' || book.format === format) && book.title.toLocaleLowerCase().includes(query));
  if (sort === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  else filtered.sort((a, b) => b.recentAt - a.recentAt || b.importedAt - a.importedAt);
  list.replaceChildren();
  byId<HTMLElement>('shelf-empty').hidden = filtered.length > 0;
  for (const book of filtered) {
    const card = document.createElement('article');
    card.className = 'shelf-card';
    card.dataset.bookId = book.id;
    const cover = document.createElement('div');
    cover.className = 'shelf-cover';
    cover.textContent = book.format.toUpperCase();
    void window.reader.coverData(book.id).then((data) => {
      if (!data || !card.isConnected) return;
      const image = document.createElement('img');
      image.className = 'shelf-cover'; image.alt = `${book.title} 封面`; image.src = data;
      cover.replaceWith(image);
    });
    const open = document.createElement('button');
    open.className = 'shelf-title'; open.type = 'button'; open.textContent = book.title;
    open.addEventListener('click', () => { void openShelfBook(book.id); });
    const detail = document.createElement('small');
    detail.textContent = `${book.author || '未知作者'} · ${book.format.toUpperCase()} · ${shelfProgress(book)}`;
    const actions = document.createElement('div');
    actions.className = 'shelf-actions';
    const relink = document.createElement('button');
    relink.type = 'button'; relink.textContent = '重新定位';
    relink.setAttribute('aria-label', `重新定位 ${book.title}`);
    relink.addEventListener('click', async () => {
      const result = await window.reader.relocateBook(book.id);
      if (result && !result.ok) notify(result.message);
      if (result?.ok) { await renderShelf(); await openShelfBook(book.id); }
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '移出书架';
    remove.setAttribute('aria-label', `移出 ${book.title}`);
    remove.addEventListener('click', async () => {
      await window.reader.removeBook(book.id);
      if (activePublication?.id === book.id || currentBook?.path === book.path) { clearBook(); byId<HTMLElement>('shelf').hidden = false; empty.hidden = true; }
      await renderShelf();
    });
    actions.append(relink, remove);
    card.append(cover, open, detail, actions);
    list.append(card);
  }
}
async function showShelf(): Promise<void> {
  window.clearTimeout(saveTimer);
  await saveProgress();
  clearBook();
  byId<HTMLElement>('shelf').hidden = false;
  empty.hidden = true;
  title.textContent = '书架';
  progress.textContent = '';
  await renderShelf();
}
async function importBooks(): Promise<void> {
  try {
    const result = await window.reader.chooseBooks();
    if (!result) return;
    await showShelf();
    if (result.errors.length) notify(`已导入 ${result.added.length} 本；${result.errors.map((item) => `${item.path.split(/[\\/]/).pop()}：${item.message}`).join('；')}`);
    else notify(`书架已有 ${result.added.length} 本所选书籍。`);
  } catch { notify('无法导入书籍，请重试。'); }
}
function renderChapters(): void {
  const list = byId<HTMLUListElement>('chapters-list');
  list.replaceChildren();
  for (const chapter of publicationView?.chapters() ?? []) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = chapter.label;
    button.addEventListener('click', () => { void publicationView?.jumpChapter(chapter.target); });
    item.append(button); list.append(item);
  }
  byId<HTMLButtonElement>('chapters-toggle').hidden = list.children.length === 0;
}
async function openShelfBook(id: string): Promise<void> {
  const record = (await window.reader.listBooks()).find((book) => book.id === id);
  if (!record) { notify('书籍记录不存在。'); return; }
  window.clearTimeout(saveTimer);
  await saveProgress();
  if (record.format === 'txt') {
    handleResult(await window.reader.openFile(record.path));
    return;
  }
  const result = await window.reader.openPublication(id);
  if (!result.ok) { notify(result.message); return; }
  if (publicationView) await publicationView.dispose();
  publicationView = null;
  currentBook = null;
  activePublication = result.book;
  ++publicationSearchGeneration;
  content.hidden = true;
  empty.hidden = true;
  byId<HTMLElement>('shelf').hidden = true;
  byId<HTMLElement>('publication-view').hidden = false;
  byId<HTMLElement>('publication-controls').hidden = false;
  byId<HTMLElement>('pdf-controls').hidden = result.book.format !== 'pdf';
  encoding.disabled = true;
  byId<HTMLButtonElement>('smaller').disabled = byId<HTMLButtonElement>('larger').disabled = result.book.format === 'pdf';
  byId<HTMLButtonElement>('layout-toggle').disabled = result.book.format === 'pdf';
  title.textContent = result.book.title;
  document.title = `${result.book.title} · VB阅读器`;
  const host = byId<HTMLElement>('publication-view');
  host.replaceChildren();
  const onPosition = (position: BookPosition) => {
    if (activePublication?.id !== id) return;
    activePublication.position = position;
    progress.textContent = position.format === 'epub' ? `${position.percent}%` : position.format === 'pdf' ? `第 ${position.page} / ${position.pageCount} 页` : '';
    if (position.format === 'pdf') byId<HTMLInputElement>('pdf-page').value = String(position.page);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void window.reader.saveBookPosition(id, position).catch(() => notify('阅读进度保存失败。')); }, 350);
  };
  try {
    const { createEpubView, createPdfView } = await import('./publications.ts');
    if (result.book.format === 'epub') {
      const bytes = await window.reader.readPublication(id);
      publicationView = await createEpubView(host, result.book, onPosition, bytes);
    } else {
      const view = await createPdfView(host, result.book, result.url, onPosition);
      publicationView = view;
      byId<HTMLOutputElement>('pdf-total').textContent = String(view.pageCount);
      byId<HTMLInputElement>('pdf-page').max = String(view.pageCount);
    }
    publicationView.setAppearance(fontSize, lineHeight, contentWidth, document.documentElement.dataset.theme ?? 'light');
    renderChapters();
    renderBookmarks();
    updateProgress();
    searchInput.value = '';
    updateSearchCount();
    void renderShelf();
  } catch (error) {
    notify(error instanceof Error ? `打开书籍失败：${error.message}` : '打开书籍失败。');
    await showShelf();
  }
}

byId<HTMLButtonElement>('open').addEventListener('click', () => { void chooseFile(); });
byId<HTMLButtonElement>('shelf-toggle').addEventListener('click', () => { void showShelf(); });
byId<HTMLButtonElement>('import-books').addEventListener('click', () => { void importBooks(); });
byId<HTMLInputElement>('shelf-search').addEventListener('input', () => { void renderShelf(); });
byId<HTMLSelectElement>('shelf-format').addEventListener('change', () => { void renderShelf(); });
byId<HTMLSelectElement>('shelf-sort').addEventListener('change', () => { void renderShelf(); });
byId<HTMLButtonElement>('publication-next').addEventListener('click', () => { void publicationView?.next(); });
byId<HTMLButtonElement>('publication-prev').addEventListener('click', () => { void publicationView?.previous(); });
byId<HTMLButtonElement>('chapters-toggle').addEventListener('click', () => { byId<HTMLElement>('chapters-panel').hidden = !byId<HTMLElement>('chapters-panel').hidden; });
byId<HTMLInputElement>('pdf-page').addEventListener('change', () => {
  if (!publicationView || activePublication?.position.format !== 'pdf') return;
  void publicationView.go({ ...activePublication.position, page: Number(byId<HTMLInputElement>('pdf-page').value), fraction: 0 });
});
byId<HTMLButtonElement>('pdf-fit-page').addEventListener('click', () => { if (publicationView && 'zoom' in publicationView) void (publicationView as PublicationView & { zoom: (value: 'page') => Promise<void> }).zoom('page'); });
byId<HTMLButtonElement>('pdf-fit-width').addEventListener('click', () => { if (publicationView && 'zoom' in publicationView) void (publicationView as PublicationView & { zoom: (value: 'width') => Promise<void> }).zoom('width'); });
byId<HTMLButtonElement>('pdf-zoom-out').addEventListener('click', () => { pdfZoom = Math.max(0.5, pdfZoom - 0.25); if (publicationView && 'zoom' in publicationView) void (publicationView as PublicationView & { zoom: (value: number) => Promise<void> }).zoom(pdfZoom); });
byId<HTMLButtonElement>('pdf-zoom-in').addEventListener('click', () => { pdfZoom = Math.min(3, pdfZoom + 0.25); if (publicationView && 'zoom' in publicationView) void (publicationView as PublicationView & { zoom: (value: number) => Promise<void> }).zoom(pdfZoom); });
byId<HTMLButtonElement>('empty-open').addEventListener('click', () => { void importBooks(); });
byId<HTMLButtonElement>('recent-toggle').addEventListener('click', () => togglePanel('recent-panel', 'recent-toggle'));
byId<HTMLButtonElement>('search-toggle').addEventListener('click', () => togglePanel('searchbar', 'search-toggle'));
byId<HTMLButtonElement>('bookmarks-toggle').addEventListener('click', () => togglePanel('bookmarks-panel', 'bookmarks-toggle'));
byId<HTMLButtonElement>('layout-toggle').addEventListener('click', () => togglePanel('layoutbar', 'layout-toggle'));
byId<HTMLButtonElement>('line-smaller').addEventListener('click', () => { void changeLayout(-0.2, 0); });
byId<HTMLButtonElement>('line-larger').addEventListener('click', () => { void changeLayout(0.2, 0); });
byId<HTMLButtonElement>('width-smaller').addEventListener('click', () => { void changeLayout(0, -80); });
byId<HTMLButtonElement>('width-larger').addEventListener('click', () => { void changeLayout(0, 80); });
byId<HTMLButtonElement>('smaller').addEventListener('click', () => { void changeFontSize(-2); });
byId<HTMLButtonElement>('larger').addEventListener('click', () => { void changeFontSize(2); });
byId<HTMLButtonElement>('bookmark-add').addEventListener('click', async () => {
  if (!currentBook && !activePublication) return;
  try {
    if (activePublication && publicationView) activePublication.bookmarks = await window.reader.addBookBookmark(activePublication.id, publicationView.position());
    else if (currentBook) currentBook.bookmarks = await window.reader.addBookmark(currentBook.path, currentOffset());
    renderBookmarks();
  }
  catch { notify('添加书签失败，请重试。'); }
});
searchInput.addEventListener('input', () => { void runSearch(); });
searchPrev.addEventListener('click', () => stepMatch(-1));
searchNext.addEventListener('click', () => stepMatch(1));
encoding.addEventListener('change', () => { void changeEncoding(encoding.value as Encoding); });
theme.addEventListener('change', () => { void changeTheme(theme.value as Theme); });
viewport.addEventListener('scroll', queueProgress, { passive: true });
window.addEventListener('keydown', handleShortcut);
window.addEventListener('resize', () => {
  if (!currentBook) return;
  if (resizeAnchor === null) resizeAnchor = lastKnownOffset;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (resizeAnchor !== null) jumpTo(resizeAnchor);
    resizeAnchor = null;
  }, 120);
});
window.reader.onRequestProgress(() => {
  if (activePublication && publicationView) void window.reader.saveBookPosition(activePublication.id, publicationView.position()).finally(() => window.reader.submitCloseProgress(null, 0));
  else window.reader.submitCloseProgress(currentBook?.path ?? null, currentOffset());
});

async function initializeShelf(): Promise<void> {
  try {
    const startupWarning = await window.reader.getStartupWarning();
    if (startupWarning) notify(startupWarning);
    const appearance = await window.reader.getAppearance();
    fontSize = appearance.fontSize;
    lineHeight = appearance.lineHeight;
    contentWidth = appearance.contentWidth;
    fontSizeLabel.textContent = String(fontSize);
    applyLayout();
    applyTheme(appearance.theme);
    const lastId = await window.reader.getLastBookId();
    const books = await window.reader.listBooks();
    const last = books.find((book) => book.id === lastId);
    if (last) {
      if (last.format === 'txt') {
        const result = await window.reader.restoreLastFile();
        if (result?.ok) { showBook(result.book); return; }
        if (result && !result.ok) notify(result.message);
      } else { await openShelfBook(last.id); return; }
    }
    await showShelf();
  } catch { notify('恢复书架失败，请重新导入书籍。'); await showShelf(); }
}
void initializeShelf();
