import { clampOffset } from '../shared/types.ts';

export function safePosition(offset: number, content: string): number {
  return clampOffset(offset, content.length);
}

export function scrollTarget(scrollTop: number, anchorTop: number, viewportTop: number, inset = 8): number {
  return Math.max(0, scrollTop + anchorTop - viewportTop - inset);
}
