import { describe, expect, it } from 'vitest';

import { naiDefaultUndesired } from '@/backends/nai';
import {
  collectChatu8ArtistRefs,
  collectChatu8VibeRefs,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  planPrefixGroups,
  vibeFingerprint,
} from '@/backends/chatu8Vibe';

describe('collectChatu8VibeRefs', () => {
  it('collects vibe references from presets and groups', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: {
        默认: { vibeDataId: 'cfgimg_a', strength: 0.7 },
        风格B: { vibeDataId: 'cfgimg_b', strength: 0.5 },
      },
      vibeGroups: {
        默认组: { vibes: [{ vibeDataId: 'cfgimg_c', strength: 0.6 }] },
        战斗组: {
          vibes: [
            { vibeDataId: 'cfgimg_d', strength: 0.4 },
            { vibeDataId: 'cfgimg_e', strength: 0.8 },
          ],
        },
      },
    });
    expect(refs.map(r => r.vibeDataId)).toEqual(['cfgimg_a', 'cfgimg_b', 'cfgimg_c', 'cfgimg_d', 'cfgimg_e']);
    expect(refs[0]).toMatchObject({ source: '默认', kind: 'preset', strength: 0.7 });
    expect(refs[2]).toMatchObject({ source: '默认组', kind: 'group', strength: 0.6 });
  });

  it('deduplicates by preset first when the same vibeDataId appears in several places', () => {
    const refs = collectChatu8VibeRefs({
      vibePresets: { 我的预设: { vibeDataId: 'cfgimg_x', strength: 0.9 } },
      vibeGroups: { 组A: { vibes: [{ vibeDataId: 'cfgimg_x', strength: 0.3 }] } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'preset', source: '我的预设', strength: 0.9 });
  });

  it('tolerant of non-objects/missing fields/invalid strengths', () => {
    expect(collectChatu8VibeRefs(null)).toEqual([]);
    expect(collectChatu8VibeRefs('junk')).toEqual([]);
    const refs = collectChatu8VibeRefs({
      vibePresets: { 坏: { vibeDataId: 123 }, 好: { vibeDataId: 'cfgimg_ok', strength: 'abc' } },
      vibeGroups: { 空组: { vibes: 'not-array' } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ vibeDataId: 'cfgimg_ok', strength: 0.6 });
  });
});

describe('detectChatu8Vibes', () => {
  it('found=false when not installed/no settings', () => {
    expect(detectChatu8Vibes(undefined).found).toBe(false);
    expect(detectChatu8Vibes(null).found).toBe(false);
    expect(detectChatu8Vibes('junk').found).toBe(false);
  });

  it('counts vibes in presets and groups (deduplicated)', () => {
    const info = detectChatu8Vibes({
      vibePresets: { 默认: { vibeDataId: 'a' }, 风格B: { vibeDataId: 'b' } },
      vibeGroups: { 组1: { vibes: [{ vibeDataId: 'b' }, { vibeDataId: 'c' }] } },
    });
    expect(info).toEqual({ found: true, total: 3, presets: 2, groups: 1 });
  });

  it('settings but no vibes → found=true, total=0', () => {
    const info = detectChatu8Vibes({ someOtherSetting: 1 });
    expect(info).toEqual({ found: true, total: 0, presets: 0, groups: 0 });
  });
});

describe('planPrefixGroups', () => {
  const vibe = (id: string, name: string, group = '') => ({ id, name, group });

  it('restores the "group name · original name" prefix into a group', () => {
    const plans = planPrefixGroups([
      vibe('1', '战斗组 · 剑光'),
      vibe('2', '战斗组 · 火焰'),
      vibe('3', '日常组 · 咖啡'),
    ]);
    expect(plans).toEqual([
      { id: '1', group: '战斗组', name: '剑光' },
      { id: '2', group: '战斗组', name: '火焰' },
      { id: '3', group: '日常组', name: '咖啡' },
    ]);
  });

  it('does not touch entries already grouped', () => {
    expect(planPrefixGroups([vibe('1', '战斗组 · 剑光', '我的组')])).toEqual([]);
  });

  it('entries without a prefix are left out', () => {
    expect(planPrefixGroups([vibe('1', '剑光'), vibe('2', '一个·没有空格的名字')])).toEqual([]);
  });

  it('skips when the prefix or remainder is empty, never producing an empty group name', () => {
    expect(planPrefixGroups([vibe('1', ' · 剑光'), vibe('2', '战斗组 · ')])).toEqual([]);
  });

  it('only the first separator is used; further separators stay in the name', () => {
    expect(planPrefixGroups([vibe('1', '战斗组 · 剑光 · 二段')])).toEqual([
      { id: '1', group: '战斗组', name: '剑光 · 二段' },
    ]);
  });
});

describe('vibeFingerprint', () => {
  it('same content gives the same fingerprint, regardless of key order', () => {
    const a = vibeFingerprint({
      v3: { encoding: 'AAA', infoExtracted: 1 },
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
    });
    const b = vibeFingerprint({
      'v4-5full': { encoding: 'BBB', infoExtracted: 1 },
      v3: { encoding: 'AAA', infoExtracted: 1 },
    });
    expect(a).toBe(b);
  });

  it('different encodings give different fingerprints', () => {
    const a = vibeFingerprint({ v3: { encoding: 'AAA', infoExtracted: 1 } });
    const b = vibeFingerprint({ v3: { encoding: 'CCC', infoExtracted: 1 } });
    expect(a).not.toBe(b);
  });
});

describe('st-chatu8 artist migration', () => {
  const MODEL = 'nai-diffusion-4-5-full';
  const source = {
    yushe: {
      Default: { fixedPrompt: '', fixedPrompt_end: '', negativePrompt: '' },
      Painter: { fixedPrompt: 'artist:a', fixedPrompt_end: 'style:b', negativePrompt: 'bad hands' },
      SharedSDPreset: { fixedPrompt: 'score_9', fixedPrompt_end: '' },
      Broken: null,
    },
    yusheid_novelai: 'Painter',
  };

  it('collects each preset with its three fields split by position', () => {
    expect(collectChatu8ArtistRefs(source)).toEqual([
      { source: 'Default', prompt: '', quality: '', negative: '', active: false },
      { source: 'Painter', prompt: 'artist:a', quality: 'style:b', negative: 'bad hands', active: true },
      { source: 'SharedSDPreset', prompt: 'score_9', quality: '', negative: '', active: false },
    ]);
  });

  it('detects source settings independently from preset count', () => {
    expect(detectChatu8Artists(undefined)).toEqual({ found: false, total: 0 });
    expect(detectChatu8Artists({ yushe: {} })).toEqual({ found: true, total: 0 });
    expect(detectChatu8Artists(source)).toEqual({ found: true, total: 3 });
  });

  it('imports presets with position-preserving mapping and baked negative baseline', () => {
    const result = importArtistsFromChatu8([], source, MODEL);
    expect(result.found).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.overwritten).toBe(0);
    expect(result.duplicates).toBe(0);
    const byName = new Map(result.plans.map(p => [p.source, p]));
    const painter = byName.get('Painter')!;
    expect(painter.state).toBe('import');
    expect(painter.preset).toMatchObject({
      name: 'Painter',
      prompt: 'artist:a',
      quality: 'style:b',
      negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
    });
    // Empty negative → no baseline baked in; stays empty and uses the fallback chain (the baseline follows the model)
    expect(byName.get('SharedSDPreset')!.preset!.negative).toBe('');
    expect(byName.get('Default')!.preset!.prompt).toBe('');
    expect(result.activeArtistId).toBe(painter.targetId);
    expect(result.plans.every(p => p.targetId.startsWith('art_'))).toBe(true);
  });

  it('overwrites same-name entries with different content, keeping their id and the active mapping', () => {
    // Entries from the old migration: the whole positive stuffed into the artist string, empty negative → re-importing should fix them in place
    const existing = [
      { id: 'art_old', name: 'Painter', prompt: 'artist:a, style:b', quality: '', negative: '' },
    ];
    const result = importArtistsFromChatu8(existing, source, MODEL);
    expect(result.imported).toBe(2);
    expect(result.overwritten).toBe(1);
    expect(result.duplicates).toBe(0);
    const plan = result.plans.find(p => p.source === 'Painter')!;
    expect(plan.state).toBe('overwrite');
    expect(plan.targetId).toBe('art_old');
    expect(plan.preset).toMatchObject({
      id: 'art_old',
      prompt: 'artist:a',
      quality: 'style:b',
      negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
    });
    expect(result.activeArtistId).toBe('art_old');
  });

  it('skips same-name entries with identical content (idempotent re-import)', () => {
    const existing = [
      {
        id: 'art_x',
        name: 'Painter',
        prompt: 'artist:a',
        quality: 'style:b',
        negative: [naiDefaultUndesired(MODEL), 'bad hands'].join(', '),
      },
    ];
    const result = importArtistsFromChatu8(existing, source, MODEL);
    expect(result.imported).toBe(2);
    expect(result.overwritten).toBe(0);
    expect(result.duplicates).toBe(1);
    const plan = result.plans.find(p => p.source === 'Painter')!;
    expect(plan.state).toBe('skip');
    expect(plan.targetId).toBe('art_x');
    expect(result.activeArtistId).toBe('art_x');
  });

  it('does not collapse different names with identical prompt content', () => {
    const result = importArtistsFromChatu8(
      [],
      { yushe: { A: { fixedPrompt: 'artist:a' }, B: { fixedPrompt: 'artist:a' } } },
      MODEL,
    );
    expect(result.imported).toBe(2);
  });

  it('imports every valid preset, including all-empty ones', () => {
    const result = importArtistsFromChatu8([], source, MODEL);
    expect(result.plans.map(p => p.source)).toEqual(['Default', 'Painter', 'SharedSDPreset']);
  });
});
