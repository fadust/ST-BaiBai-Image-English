import { describe, expect, it } from 'vitest';

import { isWorldInfoEntryExcluded, sortWorldInfoEntriesLikeST } from '@/autoTag/excludes';
import type { WorldInfoEntry } from '@/st/context';
import type { ExcludesSettings } from '@/state/settings';

function excludes(partial: Partial<ExcludesSettings>): ExcludesSettings {
  return {
    excludedChars: [],
    excludedWorldNames: [],
    excludedWorldInfoPatterns: [],
    customStripTags: [],
    ...partial,
  };
}

function entry(partial: Partial<WorldInfoEntry>): WorldInfoEntry {
  return { world: '主世界', comment: '设定', content: '…', ...partial };
}

describe('isWorldInfoEntryExcluded', () => {
  it('whole-book exclusion: an exact world name match is excluded', () => {
    const ex = excludes({ excludedWorldNames: ['附加知识'] });
    expect(isWorldInfoEntryExcluded(entry({ world: '附加知识' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ world: '主世界' }), ex)).toBe(false);
  });

  it('entry-name rules: a plain name is a contains-match, case-insensitive', () => {
    const ex = excludes({ excludedWorldInfoPatterns: ['附加'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '附加设定' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '核心设定' }), ex)).toBe(false);
    // Case-insensitive: entering mvu matches [MVU]
    expect(isWorldInfoEntryExcluded(entry({ comment: '[MVU] 框架' }), excludes({ excludedWorldInfoPatterns: ['mvu'] }))).toBe(true);
  });

  it('entry-name rules: compiled as regexes, ^ anchors work', () => {
    const ex = excludes({ excludedWorldInfoPatterns: ['^规则'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '规则说明' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '附:规则补充' }), ex)).toBe(false);
  });

  it('an invalid regex degrades to a literal substring match (case-insensitive) without false hits', () => {
    // Unclosed parenthesis: invalid regex → degrades to a literal substring comparison (metacharacters taken as-is), not treated as wildcards
    const ex = excludes({ excludedWorldInfoPatterns: ['(临时'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '设定(临时)补充' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '设定临时补充' }), ex)).toBe(false);
  });

  it('empty comment / empty lists / all-empty entry: not excluded', () => {
    const ex = excludes({ excludedWorldNames: ['附加'], excludedWorldInfoPatterns: ['附加'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '' }), ex)).toBe(false);
    expect(isWorldInfoEntryExcluded(entry({ comment: '附加设定' }), excludes({}))).toBe(false);
    expect(isWorldInfoEntryExcluded(entry({ world: '', comment: '' }), ex)).toBe(false);
  });

  it('world names with leading/trailing whitespace match after trim', () => {
    const ex = excludes({ excludedWorldNames: ['附加知识'] });
    expect(isWorldInfoEntryExcluded(entry({ world: ' 附加知识 ' }), ex)).toBe(true);
  });
});

describe('sortWorldInfoEntriesLikeST', () => {
  function e(position: number | undefined, order: number | undefined, depth?: number): WorldInfoEntry {
    return { world: '主世界', comment: 'c', content: 'x', position, order, depth };
  }

  it('buckets follow ST order of appearance: before → after → author note → @depth → EM', () => {
    const entries = [
      e(4, 100), // @depth
      e(1, 100), // after char
      e(2, 100), // before author note
      e(0, 100), // before char
      e(5, 100), // EM top
      e(6, 100), // EM bottom
    ];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.position)).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('ascending order within a bucket; missing values fall back to the default 100', () => {
    const entries = [e(0, 200), e(0, undefined), e(0, 50)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.order)).toEqual([50, undefined, 200]);
  });

  it('inside the @depth bucket: deeper entries first, then ascending order', () => {
    const entries = [e(4, 100, 2), e(4, 100, 8), e(4, 50, 8)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.depth)).toEqual([8, 8, 2]);
    expect(out[0].order).toBe(50);
    expect(out[1].order).toBe(100);
  });

  it('unknown positions go to "other" at the end; no entry is lost', () => {
    const entries = [e(7, 100), e(0, 100), e(99, 100)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.position)).toEqual([0, 7, 99]);
  });

  it('does not modify the original array', () => {
    const entries = [e(1, 100), e(0, 100)];
    sortWorldInfoEntriesLikeST(entries);
    expect(entries.map(x => x.position)).toEqual([1, 0]);
  });
});
