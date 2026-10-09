import { MAX_IMPORT_FILES } from '../shared/import.ts';
import type { ImportResult } from '../shared/types.ts';

// The resolver must be Electron's native webUtils.getPathForFile, never File.path
// or a path supplied by web content. Constructed Files have no disk backing.
export function droppedPaths(files: unknown, getPathForFile: (file: File) => string): {
  paths: string[]; errors: ImportResult['errors'];
} {
  const paths: string[] = [];
  const errors: ImportResult['errors'] = [];
  if (!Array.isArray(files) || files.length > MAX_IMPORT_FILES) {
    return { paths, errors: [{ path: '', message: `每次最多导入 ${MAX_IMPORT_FILES} 个文件。` }] };
  }
  for (const file of files) {
    try {
      const filePath = getPathForFile(file);
      if (!filePath) throw new Error('No disk backing');
      paths.push(filePath);
    } catch {
      errors.push({ path: typeof file?.name === 'string' ? file.name.slice(0, 255) : '', message: '无法获取本地文件，请从资源管理器拖入文件。' });
    }
  }
  return { paths, errors };
}
