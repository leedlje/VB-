import { readFile } from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import type { Encoding } from '../shared/types.ts';

export class BookError extends Error {
  readonly kind: 'invalid' | 'missing' | 'unreadable' | 'empty';
  constructor(message: string, kind: 'invalid' | 'missing' | 'unreadable' | 'empty') { super(message); this.kind = kind; }
}

export function normalizedKey(filePath: string): string {
  const resolved = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export async function readBook(filePath: string, encoding: Encoding): Promise<string> {
  if (path.extname(filePath).toLocaleLowerCase() !== '.txt') {
    throw new BookError('请选择 TXT 文件。', 'invalid');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BookError('文件已不存在，请重新选择 TXT 文件。', 'missing');
    throw new BookError('无法读取文件，请检查文件权限后重试。', 'unreadable');
  }
  if (bytes.length === 0) throw new BookError('这个 TXT 文件是空的，请选择其他文件。', 'empty');
  const content = iconv.decode(bytes, encoding);
  return encoding === 'utf8' ? content.replace(/^\uFEFF/, '') : content;
}
