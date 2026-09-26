import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { BookError, readBook } from './book.ts';
import type { BookFormat, BookPosition, BookRecord } from '../shared/types.ts';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: false, textNodeName: '#text' });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : value && typeof value === 'object' && '#text' in value ? string((value as Record<string, unknown>)['#text']) : '';
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export interface InspectedBook {
  record: Omit<BookRecord, 'id' | 'importedAt' | 'recentAt' | 'bookmarks'>;
  cover?: { bytes: Uint8Array; mime: string };
}
export function formatForPath(filePath: string): BookFormat {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.txt') return 'txt';
  if (extension === '.epub') return 'epub';
  if (extension === '.pdf') return 'pdf';
  throw new BookError('仅支持 TXT、EPUB 和 PDF 文件。');
}
function zipEntry(zip: JSZip, name: string): JSZip.JSZipObject | null {
  const cleaned = path.posix.normalize(name.replaceAll('\\', '/'));
  if (cleaned.startsWith('../') || cleaned.startsWith('/') || cleaned === '..') return null;
  return zip.file(cleaned);
}
async function inspectEpub(filePath: string): Promise<{ title: string; author: string; cover?: InspectedBook['cover'] }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(await readFile(filePath)); }
  catch { throw new BookError('EPUB 文件损坏或不是有效的 EPUB 压缩包。'); }
  if (zip.file('META-INF/encryption.xml')) throw new BookError('此 EPUB 已加密或受 DRM 保护，暂不支持。');
  const mimetype = zip.file('mimetype');
  if (!mimetype || (await mimetype.async('string')).trim() !== 'application/epub+zip') throw new BookError('EPUB 文件缺少有效的 mimetype。');
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new BookError('EPUB 文件缺少容器信息。');
  const containerXml = asObject(xml.parse(await container.async('string')));
  const rootfile = array(asObject(asObject(containerXml.container).rootfiles).rootfile)[0];
  const opfPath = string(asObject(rootfile)['@_full-path']);
  const opfEntry = zipEntry(zip, opfPath);
  if (!opfPath || !opfEntry) throw new BookError('EPUB 文件缺少书籍信息。');
  const opf = asObject(asObject(xml.parse(await opfEntry.async('string'))).package);
  const metadata = asObject(opf.metadata);
  const meta = array(metadata.meta).map(asObject);
  const layout = meta.find((item) => item['@_property'] === 'rendition:layout');
  if (string(layout?.['#text']) === 'pre-paginated') throw new BookError('此 EPUB 为固定版式，当前版本仅支持可重排 EPUB。');
  const spine = asObject(opf.spine);
  if (!array(spine.itemref).length) throw new BookError('EPUB 文件没有可阅读的正文。');
  const title = string(metadata['dc:title']);
  const author = string(metadata['dc:creator']);
  const coverMeta = meta.find((item) => item['@_name'] === 'cover');
  const coverId = string(coverMeta?.['@_content']) || string(asObject(metadata['meta'])['@_refines']);
  const items = array(asObject(opf.manifest).item).map(asObject);
  const coverItem = items.find((item) => item['@_id'] === coverId) || items.find((item) => String(item['@_properties'] ?? '').split(' ').includes('cover-image'));
  let cover: InspectedBook['cover'];
  if (coverItem) {
    const href = string(coverItem['@_href']);
    const mime = string(coverItem['@_media-type']);
    const entry = zipEntry(zip, path.posix.join(path.posix.dirname(opfPath), href));
    if (entry && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
      const bytes = await entry.async('uint8array');
      if (bytes.byteLength <= 5_000_000) cover = { bytes, mime };
    }
  }
  return { title, author, cover };
}
async function inspectPdf(filePath: string): Promise<{ title: string; author: string; pageCount: number }> {
  const signature = await readFile(filePath, { flag: 'r' }).then((bytes) => bytes.subarray(0, 5).toString());
  if (signature !== '%PDF-') throw new BookError('PDF 文件损坏或格式不正确。');
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = new Uint8Array(await readFile(filePath));
    const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
    const pdf = await task.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = asObject(metadata?.info);
    const result = { title: string(info.Title), author: string(info.Author), pageCount: pdf.numPages };
    await task.destroy();
    return result;
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'PasswordException') throw new BookError('此 PDF 已加密或需要密码，暂不支持。');
    throw new BookError('PDF 文件损坏或无法解码。');
  }
}
export async function inspectBook(filePath: string): Promise<InspectedBook> {
  if (!path.isAbsolute(filePath)) throw new BookError('文件路径无效。');
  const format = formatForPath(filePath);
  let file;
  try { file = await stat(filePath); }
  catch { throw new BookError('文件已不存在，请重新定位或移出书架。'); }
  if (!file.isFile()) throw new BookError('请选择普通文件。');
  let title = path.parse(filePath).name;
  let author = '';
  let position: BookPosition;
  let cover: InspectedBook['cover'];
  if (format === 'txt') {
    const content = await readBook(filePath, 'utf8');
    position = { format, offset: 0, length: content.length, encoding: 'utf8' };
  } else if (format === 'epub') {
    const info = await inspectEpub(filePath);
    title = info.title || title;
    author = info.author;
    cover = info.cover;
    position = { format, cfi: '', chapter: '', percent: 0 };
  } else {
    const info = await inspectPdf(filePath);
    title = info.title || title;
    author = info.author;
    position = { format, page: 1, fraction: 0, pageCount: info.pageCount };
  }
  return { record: { format, path: filePath, title, author, coverKey: null, size: file.size, modifiedAt: file.mtimeMs, position }, cover };
}
