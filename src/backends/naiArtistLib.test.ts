import { describe, expect, it } from 'vitest';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import type { NaiArtistPreset } from '@/state/settings';

function preset(id: string, name = id, prompt = ''): NaiArtistPreset {
  return { id, name, prompt, quality: '', negative: '' };
}

describe('matchArtist', () => {
  it('empty query always true (no filtering)', () => {
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '')).toBe(true);
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '   ')).toBe(true);
  });

  it('matches by name and artist string content, case-insensitive', () => {
    const p = preset('a', '厚涂', 'artist:WLOP, artist:as109');
    expect(matchArtist(p, '厚涂')).toBe(true);
    expect(matchArtist(p, 'wlop')).toBe(true);
    expect(matchArtist(p, 'AS109')).toBe(true);
    expect(matchArtist(p, '油画')).toBe(false);
  });
});

describe('planArtistRemoval', () => {
  const list = [preset('a'), preset('b'), preset('c'), preset('d')];

  it('current entry not deleted → activeArtistId unchanged', () => {
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'a');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.removed.map(p => p.id)).toEqual(['b', 'c']);
    expect(plan.nextActiveId).toBe('a');
  });

  it('current entry deleted → the entry at the original position takes its place', () => {
    const plan = planArtistRemoval(list, new Set(['b']), 'b');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'c', 'd']);
    expect(plan.nextActiveId).toBe('c');
  });

  it('deleting the last → step back one', () => {
    const plan = planArtistRemoval(list, new Set(['d']), 'd');
    expect(plan.nextActiveId).toBe('c');
  });

  it('deleted until empty → back to None', () => {
    const plan = planArtistRemoval(list, new Set(['a', 'b', 'c', 'd']), 'c');
    expect(plan.remaining).toEqual([]);
    expect(plan.nextActiveId).toBe('');
  });

  it('bulk delete including the current entry → takes the earliest deleted position', () => {
    // Both b and c deleted; the replacement takes min(first deleted index 1, remaining length-1) → remaining[1] = d
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'c');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.nextActiveId).toBe('d');
  });

  it('built-in ids (bi_*) never appear in the delete set → the current built-in entry is unaffected', () => {
    const plan = planArtistRemoval(list, new Set(['a']), 'bi_default');
    expect(plan.nextActiveId).toBe('bi_default');
  });
});
