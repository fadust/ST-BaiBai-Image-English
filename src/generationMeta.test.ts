import { describe, expect, it } from 'vitest';

import { formatGenerationMeta, type GenerationMeta } from '@/generationMeta';

function meta(overrides: Partial<GenerationMeta> = {}): GenerationMeta {
  return {
    backend: 'nai',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    positive: 'artist:wlop, 1girl, masterpiece',
    negative: 'lowres',
    artist: null,
    vibes: [],
    params: {},
    ...overrides,
  };
}

describe('formatGenerationMeta', () => {
  it('renders artist, vibes, model, size and sampling params', () => {
    const text = formatGenerationMeta(
      meta({
        artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop, artist:foo' },
        vibes: [
          { id: 'v1', name: '参考A', group: '风景', strength: 0.8, effectiveStrength: 0.5714 },
          { id: 'v2', name: '参考B', group: '', strength: 0.6, effectiveStrength: 0.4286 },
        ],
        params: {
          sampler: 'k_euler',
          steps: 28,
          cfg: 5,
          cfgRescale: 0.2,
          noiseSchedule: 'karras',
          quality: 'masterpiece, best quality',
          varietyBoost: true,
          normalizeRefStrength: true,
        },
      }),
    );

    expect(text).toContain("Artist Tags: 厚涂 · artist:wlop, artist:foo");
    // 质量词与解析后的负面不在 tag 文本里，单独成行
    expect(text).toContain('Quality word: masterpiece, best quality');
    expect(text).toContain('Negative: lowres');
    // 配置强度是主值，归一化后的实际值以括号标注
    expect(text).toContain('参考A(风景) ×0.8(Actual ×0.571)');
    expect(text).toContain('参考B ×0.6(Actual ×0.429)');
    expect(text).toContain("Model: nai-diffusion-4-5-full");
    expect(text).toContain("Dimensions: 832×1216");
    expect(text).toContain('Sampling: k_euler · 28 steps · CFG 5 · CFG-Rescale 0.2 · Noise schedule karras · Variety Boost');
  });

  it('omits the normalized marker when configured and effective strengths match', () => {
    const text = formatGenerationMeta(
      meta({ vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.5, effectiveStrength: 0.5 }] }),
    );
    expect(text).toContain('参考A ×0.5');
    expect(text).not.toContain('实际');
  });

  it('renders ComfyUI simple params (model/vae/clips/loras)', () => {
    const text = formatGenerationMeta(
      meta({
        backend: 'comfyui',
        model: 'Pony 预设',
        width: 1024,
        height: 1024,
        params: {
          mode: 'simple',
          template: 'checkpoint',
          baseModel: 'pony.safetensors',
          vae: 'vae.safetensors',
          clips: 'clip-l.safetensors',
          loras: 'detail×0.7、style×1',
          sampler: 'euler_ancestral',
          scheduler: 'normal',
          steps: 30,
          cfg: 7,
        },
      }),
    );
    expect(text).toContain("Model: Pony 预设");
    expect(text).toContain('Template checkpoint');
    expect(text).toContain('Base model pony.safetensors');
    expect(text).toContain('LoRA detail×0.7、style×1');
    expect(text).toContain('euler_ancestral/normal · 30 steps · CFG 7');
  });

  it('does not invent lines when there is no extra info', () => {
    const text = formatGenerationMeta(meta({ model: 'nai-diffusion-3', negative: '' }));
    expect(text).toBe("Model: nai-diffusion-3\nDimensions: 832×1216");
  });
});
