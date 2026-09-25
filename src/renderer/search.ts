export async function findMatches(content: string, query: string, canceled: () => boolean = () => false): Promise<number[] | null> {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches: number[] = [];
  const chunkSize = 64 * 1024;
  for (let start = 0; start < content.length; start += chunkSize) {
    if (canceled()) return null;
    const end = Math.min(content.length, start + chunkSize + query.length - 1);
    const expression = new RegExp(escaped, 'gi');
    const chunk = content.slice(start, end);
    for (let match = expression.exec(chunk); match; match = expression.exec(chunk)) {
      const offset = start + match.index;
      if (offset >= start + chunkSize) break;
      matches.push(offset);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return canceled() ? null : matches;
}
