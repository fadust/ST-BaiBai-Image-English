import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateComfyImage } from '@/backends/comfyui';
import { generateNaiImage } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { activeNaiEndpoint, newNaiEndpoint, settings, type NaiModel } from '@/state/settings';

vi.mock('@/backends/nai', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/nai')>()),
  generateNaiImage: vi.fn(),
}));
vi.mock('@/backends/comfyui', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/comfyui')>()),
  generateComfyImage: vi.fn(),
}));
vi.mock('@/floor/genQueue', () => ({ acquireNaiSlot: vi.fn() }));

function fakeResult() {
  return { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke: vi.fn() };
}

/** generateNaiImage now returns { result, usage } (usage is saved with the image). */
function fakeNaiOutput() {
  return {
    result: fakeResult(),
    usage: { positive: '', negative: '', width: 0, height: 0, artist: null, vibes: [], params: {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireNaiSlot).mockResolvedValue(vi.fn());
  vi.mocked(generateNaiImage).mockResolvedValue(fakeNaiOutput());
  vi.mocked(generateComfyImage).mockResolvedValue(fakeResult());
});

/**
 * Sets settings to "NAI fully configured". The address and key land on the **current endpoint**; the two channel-level ones are legacy fields.
 * settings is a module-level singleton that leaks between cases, so the endpoint library is reset wholesale to "only the official one" here.
 */
function naiReady(model: NaiModel = 'nai-diffusion-4-5-full'): void {
  settings.defaultBackend = 'nai';
  settings.nai.endpoints = [
    { id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'k' },
  ];
  settings.nai.activeEndpointId = 'nep_official';
  settings.nai.model = model;
  settings.nai.seed = 0;
  settings.nai.orientationLock = 'auto';
}

/** Sets settings to "ComfyUI custom workflow fully configured". */
function comfyReady(): void {
  settings.defaultBackend = 'comfyui';
  settings.comfyui.url = 'http://127.0.0.1:8188';
  const preset = settings.comfyui.workflows[0];
  settings.comfyui.activeWorkflowId = preset.id;
  preset.mode = 'custom';
  preset.workflow = '{"1":{}}';
  preset.orientationLock = 'auto';
}

describe('backendStatus', () => {
  it('reports each missing NAI field by name', () => {
    naiReady();
    expect(backendStatus()).toMatchObject({ configured: true, reason: '' });

    activeNaiEndpoint().key = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: "Current NAI access point is not filled in API Key",
    });

    activeNaiEndpoint().url = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: "The current NAI access point has no service address filled in",
    });
  });

  it('keeps the endpoint name out of reason (it goes to third parties, and users name rows after URLs)', () => {
    // reason is passed to third parties as-is via getBackendStatus, and an address must never appear in the public return value
    naiReady();
    const named = newNaiEndpoint('https://my-secret-proxy.example');
    settings.nai.endpoints.push(named);
    settings.nai.activeEndpointId = named.id;
    expect(backendStatus().reason).not.toContain('my-secret-proxy');
  });

  it('judges readiness by the active endpoint, not the legacy channel-level url/key', () => {
    // The legacy fields are kept only for rollback; image generation never looks at them, otherwise switching to a community site with no key would "look clickable"
    naiReady();
    settings.nai.url = 'https://image.novelai.net';
    settings.nai.key = 'legacy';

    const blank = newNaiEndpoint('公益站 A');
    settings.nai.endpoints.push(blank);
    settings.nai.activeEndpointId = blank.id;
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: "The current NAI access point has no service address filled in",
    });
  });

  it('sends the active endpoint down to the backend (switching outlets keeps every other param)', async () => {
    naiReady();
    settings.nai.steps = 33;
    const alt = newNaiEndpoint('公益站 A');
    alt.url = 'https://a.example';
    alt.key = 'ka';
    settings.nai.endpoints.push(alt);
    settings.nai.activeEndpointId = alt.id;

    await generateImage({ prompt: 'x', seed: 1 }, undefined, {});
    expect(vi.mocked(generateNaiImage).mock.calls[0][0]).toMatchObject({
      url: 'https://a.example',
      key: 'ka',
      steps: 33,
    });
  });

  it('answers supportsCharacters from the model alone, even before the key is filled in', () => {
    naiReady();
    activeNaiEndpoint().key = '';
    // Third parties need to know **before** generating whether to pass characters, not only once things are configured
    expect(backendStatus().supportsCharacters).toBe(true);
  });

  it('keeps ComfyUI at supportsCharacters=false (the pipeline never reads the field)', () => {
    comfyReady();
    expect(backendStatus()).toMatchObject({ configured: true, supportsCharacters: false });
  });

  it('flags an unconfigured ComfyUI without pretending it can draw', () => {
    comfyReady();
    settings.comfyui.workflows[0].workflow = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: "The current workflow preset does not fill in the workflow JSON",
    });
  });
});

describe('decideSeed', () => {
  it('prefers an explicit seed over everything else', () => {
    naiReady();
    settings.nai.seed = 999;
    expect(decideSeed('nai', 12345)).toBe(12345);
    expect(decideSeed('nai', 12345.7)).toBe(12345);
  });

  it('uses the NAI panel seed only when it is a positive number', () => {
    naiReady();
    settings.nai.seed = 777;
    expect(decideSeed('nai')).toBe(777);
    settings.nai.seed = 0;
    expect(decideSeed('nai')).not.toBe(0);
  });

  it.each([0, -1, NaN, undefined])('ignores %s as an override and still returns a usable seed', value => {
    naiReady();
    settings.nai.seed = 0;
    const seed = decideSeed('nai', value as number | undefined);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });
});

describe('generateImage', () => {
  it('holds a NAI gate slot and always releases it — even when the request throws', async () => {
    naiReady();
    const release = vi.fn();
    vi.mocked(acquireNaiSlot).mockResolvedValue(release);

    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    vi.mocked(generateNaiImage).mockRejectedValueOnce(new Error('429'));
    await expect(generateImage({ prompt: '1girl', seed: 1 })).rejects.toThrow('429');
    // Missing one release permanently loses a concurrency slot; miss enough and no request can ever be sent again
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('leaves ComfyUI out of the gate (its queue lives on the server)', async () => {
    comfyReady();
    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).not.toHaveBeenCalled();
  });

  it('passes characters through untouched — nai.ts owns the model predicate', async () => {
    naiReady();
    const characters = [{ name: '阿黛尔', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 5, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toEqual({
      prompt: 'x', nl: '', characters, seed: 5, size: 'landscape',
    });
  });

  it('says charactersApplied=false when the model cannot take them', async () => {
    naiReady('nai-diffusion-3');
    const characters = [{ name: 'a', tag: 'b', nl: '' }];
    const applied = await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(applied.charactersApplied).toBe(false);

    naiReady();
    expect((await generateImage({ prompt: 'x', characters, seed: 1 })).charactersApplied).toBe(true);
    // Without characters passed, it shouldn't report "used"
    expect((await generateImage({ prompt: 'x', seed: 1 })).charactersApplied).toBe(false);
  });

  it('refuses to fire a doomed request when the backend is not configured', async () => {
    naiReady();
    activeNaiEndpoint().key = '';
    await expect(generateImage({ prompt: 'x', seed: 1 })).rejects.toThrow('API Key');
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
  });

  it('clears the retry banner once the image is in hand', async () => {
    naiReady();
    const onRetry = vi.fn();
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onRetry });
    // Saving still takes a moment, during which "retrying shortly" shouldn't keep showing
    expect(onRetry).toHaveBeenLastCalledWith(null);
  });

  it('only fires onStart after the slot is in hand (that is the queued→generating moment)', async () => {
    naiReady();
    const order: string[] = [];
    vi.mocked(acquireNaiSlot).mockImplementation(async () => {
      order.push('slot');
      return () => {};
    });
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onStart: () => order.push('start') });
    expect(order).toEqual(['slot', 'start']);
  });

  it('sends the dynamic negative to ComfyUI (NAI takes its negative from settings)', async () => {
    comfyReady();
    await generateImage({ prompt: 'x', negative: 'bad hands', seed: 9 }, undefined, {});
    expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({
      negative_prompt: 'bad hands',
      seed: 9,
      size: 'portrait',
    });
  });

  it('auto lock keeps the orientation recorded in the tag, and reports it back', async () => {
    naiReady();
    const out = await generateImage({ prompt: 'x', seed: 1, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toMatchObject({ size: 'landscape' });
    expect(out.size).toBe('landscape');
  });

  it('applies the NAI channel lock here — the one path cards and the public API share', async () => {
    naiReady();
    settings.nai.orientationLock = 'landscape';
    try {
      // The tag records portrait (old images from before the lock / a size passed by a third party); once locked, everything comes out landscape
      const out = await generateImage({ prompt: 'x', seed: 1, size: 'portrait' });
      expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toMatchObject({ size: 'landscape' });
      // Report the actual orientation: the public API records the tag from this when saving to the gallery, not the portrait from the request
      expect(out.size).toBe('landscape');
      // A default size is overridden by the lock too
      await generateImage({ prompt: 'x', seed: 1 });
      expect(vi.mocked(generateNaiImage).mock.calls[1][1]).toMatchObject({ size: 'landscape' });
    } finally {
      settings.nai.orientationLock = 'auto';
    }
  });

  it('takes the ComfyUI lock from the active workflow preset, not from the NAI channel', async () => {
    comfyReady();
    const preset = settings.comfyui.workflows[0];
    preset.orientationLock = 'portrait';
    // Another channel's lock shouldn't leak over
    settings.nai.orientationLock = 'landscape';
    try {
      const out = await generateImage({ prompt: 'x', seed: 1, size: 'landscape' });
      expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({ size: 'portrait' });
      expect(out.size).toBe('portrait');
    } finally {
      preset.orientationLock = 'auto';
      settings.nai.orientationLock = 'auto';
    }
  });

  it('bubbles the NAI usage snapshot (artist/vibes) into output.meta', async () => {
    naiReady();
    vi.mocked(generateNaiImage).mockResolvedValue({
      result: fakeResult(),
      usage: {
        positive: 'artist:wlop, 1girl, masterpiece',
        negative: 'lowres',
        width: 832,
        height: 1216,
        artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
        vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.8, effectiveStrength: 0.8 }],
        params: { sampler: 'k_euler', steps: 28, cfg: 5 },
      },
    });

    const out = await generateImage({ prompt: '1girl', seed: 1 });
    expect(out.meta).toEqual({
      backend: 'nai',
      model: 'nai-diffusion-4-5-full',
      positive: 'artist:wlop, 1girl, masterpiece',
      negative: 'lowres',
      width: 832,
      height: 1216,
      artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
      vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.8, effectiveStrength: 0.8 }],
      params: { sampler: 'k_euler', steps: 28, cfg: 5 },
    });
  });

  it('snapshots the ComfyUI simple-mode recipe (loras/sampler/size) into output.meta', async () => {
    comfyReady();
    const preset = settings.comfyui.workflows[0];
    preset.mode = 'simple';
    preset.portraitSize = '832×1216';
    preset.simple.model = 'pony.safetensors';
    preset.simple.sampler = 'euler_ancestral';
    preset.simple.steps = 30;
    preset.simple.cfg = 7;
    preset.simple.loras = [{ name: 'detail', strength: 0.7 }];

    const out = await generateImage({ prompt: '1girl', negative: 'bad', seed: 1 });
    expect(out.meta).toMatchObject({
      backend: 'comfyui',
      model: preset.name,
      width: 832,
      height: 1216,
      artist: null,
      vibes: [],
      params: {
        mode: 'simple',
        baseModel: 'pony.safetensors',
        loras: 'detail×0.7',
        sampler: 'euler_ancestral',
        steps: 30,
        cfg: 7,
      },
    });
    // Simple mode's fixed negative + dynamic negative are combined into full text in meta
    expect(out.meta.negative).toBe('bad');
    expect(out.meta.positive).toBe('1girl');
  });
});
