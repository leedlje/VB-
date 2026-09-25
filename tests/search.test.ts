import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatches } from '../src/renderer/search.ts';

test('search finds Chinese and literal punctuation, and reports no matches', async () => {
  assert.deepEqual(await findMatches('中文 abc 中文\n中X文', '中文'), [0, 7]);
  assert.deepEqual(await findMatches('a.b a-b a.b', 'a.b'), [0, 8]);
  assert.deepEqual(await findMatches('没有目标', '缺少'), []);
});

test('search spans chunk boundaries and cancels obsolete queries', async () => {
  const content = `${'x'.repeat(65535)}中文${'y'.repeat(65536)}中文`;
  assert.deepEqual(await findMatches(content, '中文'), [65535, 131073]);
  let canceled = false;
  const result = await findMatches(content, '中文', () => canceled);
  assert.deepEqual(result, [65535, 131073]);
  canceled = true;
  assert.equal(await findMatches(content, '中文', () => canceled), null);
});
