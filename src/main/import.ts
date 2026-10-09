import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { BookError } from './book.ts';
import { formatForPath } from './inspect.ts';
import { MAX_IMPORT_FILES } from '../shared/import.ts';

export function isImportBatch(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_IMPORT_FILES;
}

export function validImportPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (platform !== 'win32') return path.posix.isAbsolute(value);
  // Refuse drive-relative paths, device namespaces and NTFS alternate streams.
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value) || /^\\\\[?.][\\/]/.test(value)) return false;
  const rest = value.replace(/^[a-z]:/i, '');
  return !rest.includes(':') && !rest.split(/[\\/]/).some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export async function validateImportPath(value: unknown): Promise<string> {
  if (!validImportPath(value)) throw new BookError('文件路径无效，请重新选择本地文件。');
  formatForPath(value);
  try {
    const info = await stat(value);
    if (!info.isFile()) throw new BookError('请选择普通文件，不支持导入文件夹。');
    await access(value, constants.R_OK);
  } catch (error) {
    if (error instanceof BookError) throw error;
    throw new BookError((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? '文件已不存在，请重新选择文件。' : '无法读取文件，请检查文件权限。');
  }
  return path.normalize(value);
}

// Only the app window's top-level, expected document may invoke the new entry.
export function trustedImportSender(event: { sender: unknown; senderFrame: unknown },
  contents: { mainFrame: { url: string } } | undefined, expectedUrl: string): boolean {
  return Boolean(contents && event.sender === contents && event.senderFrame === contents.mainFrame
    && contents.mainFrame.url === expectedUrl);
}
