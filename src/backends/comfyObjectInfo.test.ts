import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearComfyModelListsCache,
  fetchComfyModelLists,
  parseObjectInfo,
} from '@/backends/comfyObjectInfo';

vi.mock('@/st/context', () => ({
  getContext: () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  }),
}));

afterEach(() => {
  clearComfyModelListsCache();
  vi.restoreAllMocks();
});

const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illu.safetensors', 'pony.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [['flux1-dev.safetensors', 'anima.safetensors']] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [['anima-Q4.gguf']] } } },
  VAELoader: { input: { required: { vae_name: [['ae.safetensors', 'qwen_image_vae.safetensors']] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors']] } } },
  DualCLIPLoader: { input: { required: { clip_name1: [['t5xxl_fp8.safetensors', 'clip_l.safetensors']] } } },
  LoraLoader: { input: { required: { lora_name: [['style.safetensors']] } } },
  KSampler: {
    input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'simple']] } },
  },
};

describe('parseObjectInfo', () => {
  it('extracts each file list; clips is the deduplicated union of CLIPLoader and DualCLIPLoader', () => {
    const lists = parseObjectInfo(OBJECT_INFO);
    expect(lists.checkpoints).toEqual(['illu.safetensors', 'pony.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors', 'anima.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.vaes).toEqual(['ae.safetensors', 'qwen_image_vae.safetensors']);
    expect(lists.clips).toEqual(['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors', 't5xxl_fp8.safetensors']);
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(lists.samplers).toEqual(['euler', 'dpmpp_2m']);
    expect(lists.schedulers).toEqual(['normal', 'simple']);
  });

  it('degrades to empty arrays when nodes are missing/shapes do not match', () => {
    const lists = parseObjectInfo({ KSampler: { input: { required: {} } }, Broken: 42 });
    expect(lists.checkpoints).toEqual([]);
    expect(lists.ggufs).toEqual([]);
    expect(lists.samplers).toEqual([]);
  });
});

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => '' } as Response;
}

describe('fetchComfyModelLists', () => {
  it('direct browser connection succeeds → full lists, mode=browser', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => jsonResponse(OBJECT_INFO));
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://127.0.0.1:8188');
    expect(lists.mode).toBe('browser');
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8188/object_info');
  });

  it('the same url hits the cache without repeat requests; force refetches', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OBJECT_INFO));
    vi.stubGlobal('fetch', fetchMock);
    await fetchComfyModelLists('http://a:8188');
    await fetchComfyModelLists('http://a:8188');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchComfyModelLists('http://a:8188', { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network-level failure falls back to ST forwarding; loras/clips empty, models classified by UNet:/GGUF: prefix', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/object_info')) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/sd/comfy/models')) {
        return jsonResponse([
          { value: 'illu.safetensors', text: 'illu' },
          { value: 'flux1-dev.safetensors', text: 'UNet: flux1 dev' },
          { value: 'anima-Q4.gguf', text: 'GGUF: anima-Q4' },
        ]);
      }
      if (url.endsWith('/api/sd/comfy/samplers')) return jsonResponse(['euler']);
      if (url.endsWith('/api/sd/comfy/schedulers')) return jsonResponse(['simple']);
      if (url.endsWith('/api/sd/comfy/vaes')) return jsonResponse(['ae.safetensors']);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://b:8188');
    expect(lists.mode).toBe('server');
    expect(lists.checkpoints).toEqual(['illu.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.loras).toEqual([]);
    expect(lists.clips).toEqual([]);
    expect(lists.samplers).toEqual(['euler']);
  });

  it('HTTP errors are real server feedback and do not fall back to forwarding', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchComfyModelLists('http://c:8188')).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an empty url errors immediately', async () => {
    await expect(fetchComfyModelLists('  ')).rejects.toThrow("ComfyUI address");
  });
});
