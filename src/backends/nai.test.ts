import { describe, expect, it } from 'vitest';

import {
  applyVibes,
  buildNaiParameters,
  BUILTIN_NAI_ARTISTS,
  fullNegativePrompt,
  fullPositivePrompt,
  isBuiltinNaiArtist,
  naiArtistPrompt,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiEndpoint,
  naiRandomSeed,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiArtistPreset, NaiModel, NaiSettings, NaiVibe, NaiVibeData } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

function nai(overrides: Partial<NaiSettings> = {}): NaiSettings {
  return {
    url: 'https://image.novelai.net',
    qualityTags: '',
    negativePrompt: '',
    resolution: '832×1216',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    key: 'nai-test',
    endpoints: [{ id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'nai-test' }],
    activeEndpointId: 'nep_official',
    model: 'nai-diffusion-4-5-full',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    concurrency: 1,
    vibes: [],
    artistPresets: [],
    activeArtistId: '',
    naturalLanguage: true,
    orientationLock: 'auto',
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '测试Vibe',
    dataPath: '/user/files/v1.json',
    thumbnailPath: '/user/files/v1.jpg',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: 'v4-5full:ZW5jb2Rpbmc=',
    strength: 0.6,
    enabled: true,
    group: '',
    ...overrides,
  };
}

function vibeData(overrides: Partial<NaiVibeData> = {}): NaiVibeData {
  return {
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('adds the /ai prefix automatically', () => {
    expect(naiEndpoint('https://image.novelai.net', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    expect(naiEndpoint('https://mirror.example.com/', 'encode-vibe')).toBe(
      'https://mirror.example.com/ai/encode-vibe',
    );
  });

  it('uses base as-is when it is already a full endpoint', () => {
    expect(naiEndpoint('https://x.com/proxy/ai/generate-image', 'generate-image')).toBe(
      'https://x.com/proxy/ai/generate-image',
    );
  });

  it('errors on an empty address', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('supports × / x / * separators', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('rejects non-multiples of 64 and invalid formats', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/range/);
  });
});

describe('prompt assembly', () => {
  it('uses the model official quality tags, appended to the end of the prompt', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('1girl, sitting, location, very aesthetic, masterpiece, no text');
  });

  it('switches official quality tags by model', () => {
    expect(fullPositivePrompt(nai({ model: 'nai-diffusion-4-5-curated' }), '1girl')).toBe(
      '1girl, location, masterpiece, no text, -0.8::feet::, rating:general',
    );
  });

  it('negative = the model official default words', () => {
    const neg = fullNegativePrompt(nai());
    expect(neg).toContain('worst quality');
  });

  it('negative only reads undesiredContent, no longer joining negativePrompt', () => {
    // "Extra negative" was merged into one box; existing negativePrompt is folded into undesiredContent by normalizeNai
    expect(fullNegativePrompt(nai({ negativePrompt: 'bad hands', undesiredContent: 'lowres' }))).toBe('lowres');
  });

  it('overrides take precedence over the model official words (one each, positive and negative)', () => {
    expect(fullPositivePrompt(nai({ qualityTags: 'best quality' }), '1girl')).toBe('1girl, best quality');
    expect(fullNegativePrompt(nai({ undesiredContent: 'only this' }))).toBe('only this');
  });

  it('blank override = follow the model official words (content changes with the model)', () => {
    // This is the core contract of the "empty string = follow official" storage rule
    const asFull = fullPositivePrompt(nai({ qualityTags: '', model: 'nai-diffusion-3' }), '1girl');
    expect(asFull).toBe('1girl, best quality, amazing quality, very aesthetic, absurdres');
    expect(fullNegativePrompt(nai({ undesiredContent: '', model: 'nai-diffusion-3' }))).toContain('{bad}');
  });

  it('whitespace-only overrides count as blank', () => {
    expect(fullPositivePrompt(nai({ qualityTags: '   ' }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ undesiredContent: '  \n ' }))).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('unknown models without official words fall back to an empty string without throwing', () => {
    expect(naiDefaultQualityTags('nai-diffusion-9')).toBe('');
    expect(naiDefaultUndesired('nai-diffusion-9')).toBe('');
    const odd = nai({ model: 'nai-diffusion-9' as NaiSettings['model'] });
    expect(fullPositivePrompt(odd, '1girl')).toBe('1girl');
    expect(fullNegativePrompt(odd)).toBe('');
  });
});

describe('artist string assembly', () => {
  const preset = (prompt: string, id = 'art_a', extra: Partial<NaiArtistPreset> = {}): NaiArtistPreset => ({
    id,
    name: 'A',
    prompt,
    quality: '',
    negative: '',
    ...extra,
  });

  it('empty library / none selected → output byte for byte the same as before this feature (no change for existing users)', () => {
    expect(fullPositivePrompt(nai(), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('artist string goes first: artist string → image tags → quality tags', () => {
    const s = nai({
      artistPresets: [preset('artist:wlop, artist:krenz')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl, sitting')).toBe(
      'artist:wlop, artist:krenz, 1girl, sitting, location, very aesthetic, masterpiece, no text',
    );
  });

  it('dangling activeArtistId → none used, never falling back to the first (that would silently change the user style)', () => {
    const s = nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_gone' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('selected entry content all whitespace → same as none, no leading comma left', () => {
    // '   ' is truthy, and filter(Boolean) can't catch it, so naiArtistPrompt must trim internally
    const s = nai({ artistPresets: [preset('   ')], activeArtistId: 'art_a' });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('coexists with custom quality tags, order still artist string → tags → quality tags', () => {
    const s = nai({
      qualityTags: 'best quality',
      artistPresets: [preset('artist:a')],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, best quality');
  });

  it('naiArtistPrompt three states: empty library / dangling / selected (leading/trailing whitespace removed when selected)', () => {
    expect(naiArtistPrompt(nai())).toBe('');
    expect(naiArtistPrompt(nai({ artistPresets: [preset('artist:a')], activeArtistId: 'art_x' }))).toBe('');
    expect(
      naiArtistPrompt(nai({ artistPresets: [preset(' artist:a ')], activeArtistId: 'art_a' })),
    ).toBe('artist:a');
  });

  it('with several entries only the selected one is taken, no bleeding', () => {
    const s = nai({
      artistPresets: [preset('artist:a', 'art_a'), preset('artist:b', 'art_b')],
      activeArtistId: 'art_b',
    });
    expect(naiArtistPrompt(s)).toBe('artist:b');
  });
});

describe('recipe-bound positive/negative words (resolution chain: recipe → channel → official)', () => {
  const preset = (extra: Partial<NaiArtistPreset>): NaiArtistPreset => ({
    id: 'art_a',
    name: 'A',
    prompt: 'artist:a',
    quality: '',
    negative: '',
    ...extra,
  });
  const withPreset = (extra: Partial<NaiArtistPreset>, rest: Partial<NaiSettings> = {}) =>
    nai({ artistPresets: [preset(extra)], activeArtistId: 'art_a', ...rest });

  it('recipe-bound quality/negative words take precedence over channel overrides and official words', () => {
    const s = withPreset(
      { quality: 'recipe quality', negative: 'recipe negative' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, recipe quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('blank recipe fields → follow the channel overrides', () => {
    const s = withPreset({}, { qualityTags: 'channel quality', undesiredContent: 'channel negative' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('recipe and channel both blank → model official words (byte for byte the same as before this feature)', () => {
    const s = withPreset({});
    expect(fullPositivePrompt(s, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('only one bound: the other falls back as usual', () => {
    const s = withPreset({ negative: 'recipe negative' }, { qualityTags: 'channel quality' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('recipe negative');
  });

  it('whitespace-only bound values = unbound, falling further down', () => {
    const s = withPreset(
      { quality: '   ', negative: ' \n ' },
      { qualityTags: 'channel quality', undesiredContent: 'channel negative' },
    );
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('dangling activeArtistId → recipe fields void too, using channel/official', () => {
    const s = nai({
      artistPresets: [preset({ quality: 'recipe quality', negative: 'recipe negative' })],
      activeArtistId: 'art_gone',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('1girl, channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('switching recipe = positive/negative words switch together (the core contract of the requirement)', () => {
    const s = nai({
      artistPresets: [
        preset({ id: 'art_a', quality: 'q a', negative: 'n a' }),
        preset({ id: 'art_b', prompt: 'artist:b', quality: 'q b', negative: 'n b' }),
      ],
      activeArtistId: 'art_a',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, q a');
    expect(fullNegativePrompt(s)).toBe('n a');
    s.activeArtistId = 'art_b';
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:b, 1girl, q b');
    expect(fullNegativePrompt(s)).toBe('n b');
    // Switch to "None" → fall back to channel/official
    s.activeArtistId = '';
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });
});

describe('NAI V5 support', () => {
  it('uses official model defaults and params_version 4', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const) {
      expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
      expect(naiDefaultUndesired(model)).toContain('dithering, halftone, screentone');
      const params = buildNaiParameters(nai({ model }), { prompt: '1girl', seed: 42 });
      expect(params.params_version).toBe(4);
      expect(params.v4_prompt).toBeTruthy();
      expect(params.skip_cfg_above_sigma).toBeNull();
      expect(params.sampler).toBe('k_euler');
    }
    const fallback = buildNaiParameters(nai({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3' }), {
      prompt: '1girl',
      seed: 42,
    });
    expect(fallback.sampler).toBe('k_euler_ancestral');
  });

  it('V5 Full default negative only excludes defects, no longer banning subjects/styles/body types/artists', () => {
    // The old version chained a long string of community words onto the official baseline, banning chibi, large breasts, dark tones, specific artist names and more,
    // which kept fighting the positive words and artist string (the original author has declared it deprecated). Locked here: the general default doesn't touch subject preferences.
    const neg = naiDefaultUndesired('nai-diffusion-5-full');
    // The official baseline is kept as-is (V5 tuning depends on it, and the panel also uses it to recognise "not customised")
    expect(neg).toContain('worst quality, bad quality, jpeg artifacts');
    expect(neg).toContain('dithering, halftone, screentone');
    for (const banned of [
      'chibi',
      'large breasts',
      'huge breasts',
      'dark',
      'high contrast',
      'artist:',
      'artist collaboration',
      '4koma',
      'oekaki',
      'black face',
      'extra people',
      'honey',
      'tight pants',
      'childish',
    ]) {
      expect(neg).not.toContain(banned);
    }
  });

  it('maps Base Tag + NL and native Character Prompts into the V5 caption schema', () => {
    const settings = nai({
      model: 'nai-diffusion-5-full',
      qualityTags: 'very aesthetic',
      artistPresets: [{ id: 'artist', name: 'Artist', prompt: 'artist:test', quality: '', negative: '' }],
      activeArtistId: 'artist',
    });
    const params = buildNaiParameters(settings, {
      prompt: '2girls, classroom, sunset',
      nl: 'Two girls in a sunset classroom.',
      characters: [
        { name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left, waving.' },
        { name: 'B', tag: 'girl, silver hair, red dress', nl: '' },
      ],
      seed: 42,
    });
    const positive = params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string; centers: unknown[] }> };
      use_coords: boolean;
      use_order: boolean;
    };
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string; centers: unknown[] }> };
    };
    expect(positive.caption.base_caption).toBe(
      'artist:test, 2girls, classroom, sunset, very aesthetic. Two girls in a sunset classroom.',
    );
    expect(positive.caption.char_captions).toEqual([
      { char_caption: 'girl, black hair, white dress. On the left, waving.', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: 'girl, silver hair, red dress', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(negative.caption.char_captions).toEqual([
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(positive.use_coords).toBe(false);
    expect(positive.use_order).toBe(true);
  });

  it('uses model-specific V5 vibe encodings', () => {
    expect(vibeModelKey('nai-diffusion-5-full')).toBe('v5full');
    expect(vibeModelKey('nai-diffusion-5-curated')).toBe('v5curated');
    const settings = nai({ model: 'nai-diffusion-5-full', vibes: [vibe({ name: 'V5 vibe' })] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const data = vibeData({ encodings: { v5full: { encoding: 'djU=', infoExtracted: 1 } } });
    expect(applyVibes(params, settings, new Map([['v1', data]])).skipped).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([
      { cache_secret_key: expect.any(String), data: 'djU=' },
    ]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  // Regression lock: the field holding char_captions is literally called v4_prompt; this structure is a V4-era protocol that V5 merely inherits.
  // It was once gated on isNai5, so 4.5, which clearly supports it, couldn't send a single character prompt (character looks all blurred into Base).
  // The boundary is at 4.5, not the whole v4 family: natural language was introduced with 4.5, and the original NAI4 only takes tags.
  it('sends native Character Prompts on 4.5 as well as V5, but not on plain NAI 4', () => {
    const values = {
      prompt: '2girls, classroom',
      nl: 'Two girls in a classroom.',
      characters: [{ name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left.' }],
      seed: 1,
    };
    const captionsOf = (model: NaiModel) =>
      (
        buildNaiParameters(nai({ model }), values).v4_prompt as {
          caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
        }
      ).caption;

    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions.map(c => c.char_caption)]).toEqual([
        model,
        ['girl, black hair, white dress. On the left.'],
      ]);
      // nl joining is opened to 4.5 likewise: period-separated, after the tag string
      expect([model, caption.base_caption.endsWith('. Two girls in a classroom.')]).toEqual([model, true]);
    }

    // The original NAI4 keeps the single-string form: neither character prompts nor nl are sent
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions]).toEqual([model, []]);
      expect([model, caption.base_caption.includes('Two girls in a classroom.')]).toEqual([model, false]);
    }
  });
});

describe('buildNaiParameters', () => {
  it('v4 family carries the v4_prompt structure', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
    expect(p.ucPreset).toBe(3);
    expect(p.qualityToggle).toBe(true);
  });

  it('NAI3 has no v4 structure, with the original reference image array and sm toggles', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('v4_prompt base_caption comes from the same source as fullPositivePrompt (including the artist string)', () => {
    // If the top-level input (generateNaiImage) and parameters.v4_prompt each assembled separately, NAI3 reads input and
    // NAI4/4.5 read v4_prompt, so they would get different prompts, exposed only on NAI3. This assertion pins down "same source":
    // every assembly change must stay inside fullPositivePrompt, never adding extras at a call site.
    const s = nai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '' }],
      activeArtistId: 'art_a',
    });
    const p = buildNaiParameters(s, { prompt: '1girl', seed: 1 });
    const v4 = p.v4_prompt as { caption: { base_caption: string } };
    expect(v4.caption.base_caption).toBe(fullPositivePrompt(s, '1girl'));
    expect(v4.caption.base_caption.startsWith('artist:a, 1girl')).toBe(true);
  });

  it('k_euler_ancestral adds the brownian correction', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('landscape frames take the landscape size, skip_cfg_above_sigma changes with the pixel count', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 and 1216×832 have the same pixel count, so sigma should match too (proving it really derives from size)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('missing size generates portrait (matching the fixed default from before the change)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('falls back to the built-in portrait default when that orientation is unset', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('fixed seed takes precedence over random', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('null when variety is off', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 uses 58, others use 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5: encoded data goes into cached, strengths into the strength array', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(params, nai({ vibes: [vibe()] }), new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    // What is recorded with the image is the panel's configured strength and the strength actually sent
    expect(applied).toEqual([
      { id: 'v1', name: '测试Vibe', group: '', strength: 0.6, effectiveStrength: 0.6 },
    ]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('vibes missing the current model encoding are skipped and their names returned', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '旧模型Vibe', modelKeys: ['v3'] })] }),
      new Map([['v1', vibeData({ encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })]]),
    );
    expect(skipped).toEqual(['旧模型Vibe']);
    expect(applied).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('when total strength exceeds 1 with normalisation on, scaled back to 1 proportionally', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied } = applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
      new Map([
        ['a', vibeData()],
        ['b', vibeData()],
      ]),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
    // The record keeps the configured values as-is; the values actually sent reflect the normalisation
    expect(applied.map(v => v.strength)).toEqual([0.8, 0.6]);
    expect(applied[0].effectiveStrength).toBeCloseTo(0.8 / 1.4, 6);
    expect(applied[1].effectiveStrength).toBeCloseTo(0.6 / 1.4, 6);
  });

  it('NAI3: the original reference image goes into reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const { skipped } = applyVibes(params, settings, new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('disabled vibes take no part', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    applyVibes(params, nai({ vibes: [vibe({ enabled: false })] }), new Map([['v1', vibeData()]]));
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('maps the official key by model', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('parses the official format', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('missing strength field falls back to 0.6, not silently strength 0', () => {
    // Regression: the old implementation used Number(v), and Number(null) / Number('') are both 0:
    // the vibe would be imported at "strength 0", attached but with no effect on the image at all, and very hard to trace.
    const build = (importInfo: unknown) =>
      JSON.stringify({
        identifier: 'novelai-vibe-transfer',
        version: 1,
        image: 'aW1hZ2U=',
        encodings: {
          'v4-5full': {
            k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
          },
        },
        importInfo,
      });
    expect(parseNaiv4vibe(build({ model: 'nai-diffusion-4-5-full' })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: null })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: '' })).strength).toBe(0.6);
  });

  it('rejects non-vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/identifier/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('extracts the first image from the zip', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('non-zip data gives a friendly error', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32-bit unsigned integer', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('built-in artist string recipes (read-only, updated with the version, not in settings)', () => {
  it('with an empty user library, activeArtistId matches the built-in library', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(naiArtistPrompt(s)).toBe(BUILTIN_NAI_ARTISTS[0].prompt.trim());
    expect(fullPositivePrompt(s, '1girl')).toBe(
      `${BUILTIN_NAI_ARTISTS[0].prompt.trim()}, 1girl, location, very aesthetic, masterpiece, no text`,
    );
  });

  it('built-in recipes quality/negative follow the same fallback chain: blank → channel overrides', () => {
    // Built-in entries currently bind no positive/negative words; this locks down the "blank = follow the channel" rule,
    // so when bindings are added to built-in entries later this test will prompt a check of the chain's behaviour.
    const s = nai({
      artistPresets: [],
      activeArtistId: 'bi_default',
      qualityTags: 'channel quality',
      undesiredContent: 'channel negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toContain('channel quality');
    expect(fullNegativePrompt(s)).toBe('channel negative');
  });

  it('isBuiltinNaiArtist: the bi_ prefix matches, user entries (art_*) do not', () => {
    expect(isBuiltinNaiArtist('bi_default')).toBe(true);
    expect(isBuiltinNaiArtist('art_abc')).toBe(false);
    expect(isBuiltinNaiArtist('')).toBe(false);
  });

  it('activeArtistId points at a non-existent built-in id (e.g. after retirement) → no artist string added', () => {
    const s = nai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(naiArtistPrompt(s)).toBe('');
  });
});
