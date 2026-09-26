import ePub, { type Book as EpubBook, type Rendition } from 'epubjs';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { BookPosition, BookRecord } from '../shared/types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
export interface SearchHit { label: string; position: BookPosition }
export interface PublicationView {
  position(): BookPosition;
  go(position: BookPosition): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  search(query: string, canceled: () => boolean, onProgress: (count: number) => void): Promise<SearchHit[]>;
  setAppearance(fontSize: number, lineHeight: number, contentWidth: number, theme: string): void;
  chapters(): { label: string; target: string }[];
  jumpChapter(target: string): Promise<void>;
  dispose(): Promise<void>;
}
function sanitizeChapter(document: Document): void {
  document.querySelectorAll('script,iframe,object,embed,form,video,audio,meta[http-equiv]').forEach((element) => element.remove());
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (['src', 'href', 'xlink:href', 'poster'].includes(attribute.name.toLowerCase()) && /^(?:https?:|file:|javascript:|data:text\/html)/i.test(attribute.value.trim())) element.removeAttribute(attribute.name);
    }
  });
}
export async function createEpubView(host: HTMLElement, record: BookRecord, onPosition: (value: BookPosition) => void, bytes: Uint8Array): Promise<PublicationView> {
  const book = (ePub as unknown as () => EpubBook)();
  await book.open(Uint8Array.from(bytes).buffer);
  await book.ready;
  const rendition = book.renderTo(host, { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false });
  rendition.hooks.content.register((contents: { document: Document }) => sanitizeChapter(contents.document));
  let position: BookPosition = record.position.format === 'epub' ? record.position : { format: 'epub', cfi: '', chapter: '', percent: 0 };
  const spine = (book.spine as unknown as { spineItems: Array<{ index: number; href: string; load: (request: Function) => Promise<Document>; find: (query: string) => SearchHit[]; unload: () => void }> }).spineItems;
  rendition.on('relocated', (location: { start: { cfi: string; href: string; index: number; displayed: { page: number; total: number } } }) => {
    const within = location.start.displayed.total ? (location.start.displayed.page - 1) / location.start.displayed.total : 0;
    position = { format: 'epub', cfi: location.start.cfi, chapter: location.start.href, percent: Math.min(100, Math.round((location.start.index + within) / Math.max(1, spine.length) * 100)) };
    onPosition(position);
  });
  await rendition.display(position.cfi || undefined);
  const entries: { label: string; target: string }[] = [];
  const collect = (items: Array<{ label: string; href: string; subitems?: Array<{ label: string; href: string }> }>) => {
    for (const item of items) {
      entries.push({ label: item.label, target: item.href });
      if (item.subitems) collect(item.subitems);
    }
  };
  collect(book.navigation.toc);
  return {
    position: () => structuredClone(position),
    go: async (target) => { if (target.format === 'epub') await rendition.display(target.cfi || target.chapter || undefined); },
    next: () => rendition.next(),
    previous: () => rendition.prev(),
    search: async (query, canceled, onProgress) => {
      const hits: SearchHit[] = [];
      for (const section of spine) {
        if (canceled()) break;
        await section.load(book.load.bind(book));
        for (const hit of section.find(query) as unknown as Array<{ cfi: string; excerpt: string }>) {
          hits.push({ label: hit.excerpt, position: { format: 'epub', cfi: hit.cfi, chapter: section.href, percent: Math.round(section.index / Math.max(1, spine.length) * 100) } });
        }
        section.unload();
        onProgress(hits.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return hits;
    },
    setAppearance: (size, height, width, theme) => {
      rendition.themes.default({ body: { 'font-size': `${size}px !important`, 'line-height': `${height} !important`, 'max-width': `${width}px !important`, color: theme === 'dark' ? '#e8ece7' : theme === 'sepia' ? '#44392b' : '#302f2b', background: theme === 'dark' ? '#202522' : theme === 'sepia' ? '#f5edda' : '#f8f6f1' } });
    },
    chapters: () => entries,
    jumpChapter: (target) => rendition.display(target),
    dispose: async () => { rendition.destroy(); book.destroy(); host.replaceChildren(); },
  };
}

export async function createPdfView(host: HTMLElement, record: BookRecord, url: string, onPosition: (value: BookPosition) => void): Promise<PublicationView & { pageCount: number; zoom(value: number | 'page' | 'width'): Promise<void> }> {
  const task = pdfjs.getDocument({ url, withCredentials: false, disableAutoFetch: true, disableStream: true });
  const document = await task.promise;
  const pageCount = document.numPages;
  let pageNumber = record.position.format === 'pdf' ? Math.max(1, Math.min(pageCount, record.position.page)) : 1;
  let fraction = record.position.format === 'pdf' ? record.position.fraction : 0;
  let mode: number | 'page' | 'width' = 'width';
  let renderGeneration = 0;
  const container = globalThis.document.createElement('div');
  container.className = 'pdf-scroll';
  const canvas = globalThis.document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  const textLayer = globalThis.document.createElement('div');
  textLayer.className = 'textLayer';
  const pageFrame = globalThis.document.createElement('div');
  pageFrame.className = 'pdf-page';
  pageFrame.append(canvas, textLayer);
  container.append(pageFrame);
  host.replaceChildren(container);
  let position: BookPosition = { format: 'pdf', page: pageNumber, fraction, pageCount };
  const update = () => {
    fraction = Math.max(0, Math.min(1, container.scrollTop / Math.max(1, container.scrollHeight - container.clientHeight)));
    position = { format: 'pdf', page: pageNumber, fraction, pageCount };
    onPosition(position);
  };
  container.addEventListener('scroll', update, { passive: true });
  const render = async () => {
    const generation = ++renderGeneration;
    const page = await document.getPage(pageNumber);
    const normal = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(200, host.clientWidth - 60);
    const availableHeight = Math.max(200, host.clientHeight - 36);
    const scale = typeof mode === 'number' ? mode : mode === 'page' ? Math.min(availableWidth / normal.width, availableHeight / normal.height) : availableWidth / normal.width;
    const viewport = page.getViewport({ scale });
    if (generation !== renderGeneration) return;
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * pixelRatio);
    canvas.height = Math.round(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageFrame.style.width = `${viewport.width}px`;
    pageFrame.style.height = `${viewport.height}px`;
    textLayer.replaceChildren();
    const context = canvas.getContext('2d');
    if (!context) return;
    await page.render({ canvasContext: context, canvas, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
    if (generation !== renderGeneration) return;
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
    await layer.render();
    container.scrollTop = fraction * Math.max(0, container.scrollHeight - container.clientHeight);
    update();
  };
  await render();
  return {
    pageCount,
    position: () => structuredClone(position),
    go: async (target) => { if (target.format !== 'pdf') return; pageNumber = Math.max(1, Math.min(pageCount, target.page)); fraction = target.fraction; await render(); },
    next: async () => { pageNumber = Math.min(pageCount, pageNumber + 1); fraction = 0; await render(); },
    previous: async () => { pageNumber = Math.max(1, pageNumber - 1); fraction = 0; await render(); },
    zoom: async (value) => { mode = value; await render(); },
    search: async (query, canceled, onProgress) => {
      const hits: SearchHit[] = [];
      const needle = query.toLocaleLowerCase();
      let anyText = false;
      for (let number = 1; number <= pageCount; number++) {
        if (canceled()) break;
        const page = await document.getPage(number);
        const text = await page.getTextContent();
        for (const item of text.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          anyText = true;
          if (item.str.toLocaleLowerCase().includes(needle)) {
            const height = page.getViewport({ scale: 1 }).height;
            const y = 'transform' in item ? item.transform[5] : height;
            hits.push({ label: `第 ${number} 页 · ${item.str.slice(0, 80)}`, position: { format: 'pdf', page: number, fraction: Math.max(0, Math.min(1, 1 - y / height)), pageCount } });
          }
        }
        onProgress(hits.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!canceled() && !anyText) throw new Error('这份 PDF 没有可搜索的文字层；扫描图片暂不支持 OCR。');
      return hits;
    },
    setAppearance: () => {},
    chapters: () => [],
    jumpChapter: async () => {},
    dispose: async () => { ++renderGeneration; await task.destroy(); host.replaceChildren(); },
  };
}
