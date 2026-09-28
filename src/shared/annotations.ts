import type { Annotation, AnnotationAnchor } from './types.ts';

export const MAX_ANNOTATION_TEXT = 500;
export const MAX_ANNOTATION_NOTE = 2000;
export const ANNOTATION_CONTEXT = 32;

export function textContext(source: string, start: number, end: number): { prefix: string; suffix: string } {
  return {
    prefix: source.slice(Math.max(0, start - ANNOTATION_CONTEXT), start),
    suffix: source.slice(end, end + ANNOTATION_CONTEXT),
  };
}

export function findTextAnchor(source: string, mark: Pick<Annotation, 'text' | 'prefix' | 'suffix'>, preferredStart?: number, requireUnique = false): number | null {
  const matches = (start: number) => source.slice(Math.max(0, start - mark.prefix.length), start) === mark.prefix
    && source.slice(start + mark.text.length, start + mark.text.length + mark.suffix.length) === mark.suffix;
  if (!requireUnique && preferredStart !== undefined && source.slice(preferredStart, preferredStart + mark.text.length) === mark.text && matches(preferredStart)) return preferredStart;
  let found: number | null = null;
  for (let start = source.indexOf(mark.text); start !== -1; start = source.indexOf(mark.text, start + 1)) {
    if (!matches(start)) continue;
    if (found !== null) return null;
    found = start;
  }
  return found;
}

export function resolveTxtAnchor(source: string, mark: Annotation, changed = false): AnnotationAnchor | null {
  if (mark.anchor.format !== 'txt') return null;
  const start = findTextAnchor(source, mark, mark.anchor.start, changed || mark.status === 'unresolved');
  return start === null ? null : { format: 'txt', start, end: start + mark.text.length };
}
