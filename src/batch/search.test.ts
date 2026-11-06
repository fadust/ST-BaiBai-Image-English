import { describe, expect, it } from 'vitest';
import { searchNames, searchableText, splitNames, stripTagList } from './search';
import type { STMessage } from '@/st/context';
describe('English character search', () => {
  it('preserves spaces in names and separates names with commas or newlines', () => {
    expect(splitNames('Mary Jane')).toEqual(['Mary Jane']);
    expect(splitNames('Mary Jane, Peter Parker\nMary Jane')).toEqual(['Mary Jane', 'Peter Parker']);
  });
  it('excludes reasoning, comments, image tags, and configured cleanup sections', () => {
    const text = '<think>Peter Parker</think><!-- Peter Parker --><bbi_image>Peter Parker</bbi_image><status>Peter Parker</status>Mary Jane arrives.';
    expect(searchableText(text, stripTagList(['status']))).toBe('Mary Jane arrives.');
  });
  it('finds independent and shared appearances, including optional user messages', () => {
    const chat = [
      { mes: 'Mary Jane arrives.', is_user: false },
      { mes: 'Peter Parker calls Mary Jane.', is_user: true },
      { mes: 'PETER PARKER meets Mary Jane.', is_user: false },
    ] as STMessage[];
    expect(searchNames(chat, ['Mary Jane', 'Peter Parker'], { withUser: false, stripTags: [] })).toEqual({ rows: [{ name: 'Mary Jane', floors: [0, 2] }, { name: 'Peter Parker', floors: [2] }], together: [2] });
    expect(searchNames(chat, ['Mary Jane', 'Peter Parker'], { withUser: true, stripTags: [] }).together).toEqual([1, 2]);
  });
});
