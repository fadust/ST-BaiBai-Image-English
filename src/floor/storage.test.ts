import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendEntry,
  BBI_IMAGE_EXTRA_KEY,
  deleteImageFileOnly,
  deleteImageResult,
  generationId,
  historyEntries,
  imageFileName,
  latestEntry,
  latestStaleEntry,
  mutateStore,
  prepareImageForStorage,
  promptHash,
  readStore,
  saveExternalImage,
  saveImageResult,
  sidecarFileName,
  sidecarPathFor,
  type BbiImageEntry,
} from '@/floor/storage';
import type { GenerationMeta } from '@/generationMeta';
import type { STContext, STMessage } from '@/st/context';
import { settings } from '@/state/settings';

function fakeEntry(overrides: Partial<BbiImageEntry> = {}): BbiImageEntry {
  return {
    generationId: 'g1',
    path: '/user/files/bbi_x.png',
    prompt: '<bbi_image>a</bbi_image>',
    seed: null,
    status: 'ready',
    createdAt: 1000,
    ...overrides,
  };
}

function fakeMessage(): STMessage {
  return { name: 'c', is_user: false, is_system: false, mes: 'x' };
}

function fakeCtx(message: STMessage, saveChat = vi.fn(async () => undefined)): STContext {
  return { chat: [message], saveChat } as unknown as STContext;
}

afterEach(() => vi.unstubAllGlobals());

describe('promptHash', () => {
  it('is deterministic and 14 hex chars', () => {
    const tag = '<bbi_image>1girl, moonlight</bbi_image>';
    expect(promptHash(tag)).toBe(promptHash(tag));
    expect(promptHash(tag)).toMatch(/^[0-9a-f]{14}$/);
  });

  it('distinguishes different prompts', () => {
    expect(promptHash('<bbi_image>a</bbi_image>')).not.toBe(
      promptHash('<bbi_image>b</bbi_image>'),
    );
    // Editing the prompt content → the hash changes (the basis of stale detection)
    expect(promptHash('<bbi_image>1girl, cat</bbi_image>')).not.toBe(
      promptHash('<bbi_image>1girl, dog</bbi_image>'),
    );
  });
});

describe('imageFileName', () => {
  it('uses a stable character-name hash in the flat filename', () => {
    expect(imageFileName('\u67cf\u5b9d', 0, 'a3f9c2', 'g_1723', 'png')).toBe(
      `bbi_${promptHash('\u67cf\u5b9d')}_0_a3f9c2-g_1723.png`,
    );
  });

  it('does not expose unsupported characters from the character name', () => {
    expect(imageFileName('\u67cf\u5b9d/\u6d4b\u8bd5 \u5361', 1, 'h', 'g', 'png')).toMatch(
      /^bbi_[0-9a-f]{14}_1_h-g\.png$/,
    );
  });
});

describe('sidecar naming', () => {
  it('swaps the extension of the image filename', () => {
    expect(sidecarFileName('bbi_abc_0_h-g1.png')).toBe('bbi_abc_0_h-g1.json');
    expect(sidecarFileName('bbi_abc_0_h-g1.jpg')).toBe('bbi_abc_0_h-g1.json');
  });

  it('appends .json when there is no extension', () => {
    expect(sidecarFileName('bbi_abc_0_h-g1')).toBe('bbi_abc_0_h-g1.json');
  });

  it('stays inside validateAssetFileName limits for real filenames', () => {
    // The server's /api/files/upload only accepts /^[a-zA-Z0-9_\-.]+$/; non-compliant names get a 400
    const name = sidecarFileName(imageFileName('柏宝/测试 卡', 1, 'h', 'g', 'png'));
    expect(name).toMatch(/^[a-zA-Z0-9_\-.]+$/);
    expect(name.endsWith('.json')).toBe(true);
  });

  it('derives the sidecar path from an image path', () => {
    expect(sidecarPathFor('/user/images/柏宝绘_a/bbi_abc_0_h-g1.png')).toBe(
      '/user/files/bbi_abc_0_h-g1.json',
    );
  });

  it('returns empty for files this plugin did not name', () => {
    // A sidecar name computed from a foreign file is certain to 404, so no request should be wasted
    expect(sidecarPathFor('/user/images/柏宝绘_a/photo.png')).toBe('');
    expect(sidecarPathFor('/user/files/bbi-vibe-thumb-x.jpg')).toBe('');
    expect(sidecarPathFor('')).toBe('');
  });
});

describe('store read helpers', () => {
  it('reads latest entry by swipe + hash and ignores other swipes', () => {
    const store = appendEntry({}, 0, 'h1', fakeEntry({ generationId: 'a', createdAt: 1, slotSeq: 0 }));
    const store2 = appendEntry(store, 0, 'h1', fakeEntry({ generationId: 'b', createdAt: 2, slotSeq: 0 }));
    const store3 = appendEntry(store2, 1, 'h1', fakeEntry({ generationId: 'c', slotSeq: 0 }));

    expect(latestEntry(store3, 0, 'h1', 0)?.generationId).toBe('b');
    expect(latestEntry(store3, 1, 'h1', 0)?.generationId).toBe('c');
    expect(latestEntry(store3, 0, 'other-hash', 0)).toBeNull();
  });

  it('isolates results by slot: same-hash entries of different slots stay separate', () => {
    // Two tags on the same floor with identical content (same hash) → each slot fetches its image independently, never crossing
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'slot0', slotSeq: 0, createdAt: 1 }));
    const store2 = appendEntry(store, 0, 'h', fakeEntry({ generationId: 'slot1', slotSeq: 1, createdAt: 2 }));
    const store3 = appendEntry(store2, 0, 'h', fakeEntry({ generationId: 'slot0-again', slotSeq: 0, createdAt: 3 }));

    expect(latestEntry(store3, 0, 'h', 0)?.generationId).toBe('slot0-again');
    expect(latestEntry(store3, 0, 'h', 1)?.generationId).toBe('slot1');
  });

  it('falls back to slot 0 for legacy entries without slotSeq', () => {
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'legacy' }));
    expect(latestEntry(store, 0, 'h', 0)?.generationId).toBe('legacy');
    expect(latestEntry(store, 0, 'h', 1)).toBeNull();
  });

  it('historyEntries returns same-slot history in time order for paging', () => {
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'first', slotSeq: 0, createdAt: 1 }));
    const store2 = appendEntry(store, 0, 'h', fakeEntry({ generationId: 'second', slotSeq: 0, createdAt: 2 }));
    const store3 = appendEntry(store2, 0, 'h', fakeEntry({ generationId: 'other-slot', slotSeq: 1, createdAt: 3 }));
    const store4 = appendEntry(store3, 0, 'other-hash', fakeEntry({ generationId: 'other-hash', slotSeq: 0 }));

    expect(historyEntries(store4, 0, 'h', 0).map(e => e.generationId)).toEqual(['first', 'second']);
    expect(historyEntries(store4, 0, 'h', 1).map(e => e.generationId)).toEqual(['other-slot']);
    expect(historyEntries(store4, 0, 'h', 2)).toEqual([]);
    expect(historyEntries(null, 0, 'h', 0)).toEqual([]);
  });

  it('finds the newest stale entry from other prompt hashes in the same slot only', () => {
    const store = appendEntry({}, 0, 'old1', fakeEntry({ generationId: 'a', createdAt: 5, slotSeq: 0 }));
    const store2 = appendEntry(store, 0, 'old2', fakeEntry({ generationId: 'b', createdAt: 9, slotSeq: 0 }));
    const store3 = appendEntry(store2, 0, 'current', fakeEntry({ generationId: 'c', createdAt: 1, slotSeq: 0 }));

    expect(latestStaleEntry(store3, 0, 'current', 0)?.generationId).toBe('b');
    // Excluding its own key, returns the newest among the other keys (old1's a is newer than current's c)
    expect(latestStaleEntry(store3, 0, 'old2', 0)?.generationId).toBe('a');
    expect(latestStaleEntry(null, 0, 'x', 0)).toBeNull();
    expect(latestStaleEntry(store3, 9, 'x', 0)).toBeNull();
  });

  it('never reports a neighbor slot result as stale (multi-tag floor bug)', () => {
    // Card 1 has generated (slot 0), card 2 (slot 1) never has → card 2 must be pending,
    // and must not show card 1's image as stale
    const store = appendEntry({}, 0, 'hash-of-tag1', fakeEntry({ generationId: 'tag1-img', slotSeq: 0 }));
    expect(latestEntry(store, 0, 'hash-of-tag2', 1)).toBeNull();
    expect(latestStaleEntry(store, 0, 'hash-of-tag2', 1)).toBeNull();
    // But after the same slot's prompt changes, the old image can still show as stale
    expect(latestStaleEntry(store, 0, 'hash-of-tag1-edited', 0)?.generationId).toBe('tag1-img');
  });

  it('readStore tolerates missing extra', () => {
    expect(readStore(fakeMessage())).toBeNull();
    const message = fakeMessage();
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: { '0': {} } };
    expect(readStore(message)).toEqual({ '0': {} });
  });
});

describe('mutateStore (CAS)', () => {
  it('creates the store on first write and persists via saveChat', async () => {
    const message = fakeMessage();
    const saveChat = vi.fn(async () => undefined);
    const ctx = fakeCtx(message, saveChat);

    const ok = await mutateStore(ctx, 0, store => appendEntry(store, 0, 'h', fakeEntry()));
    expect(ok).toBe(true);
    expect(message.extra?.[BBI_IMAGE_EXTRA_KEY]).toBeTruthy();
    expect(latestEntry(readStore(message), 0, 'h', 0)).not.toBeNull();
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it('retries when the store reference was replaced concurrently', async () => {
    const message = fakeMessage();
    const ctx = fakeCtx(message);
    let calls = 0;
    const ok = await mutateStore(ctx, 0, store => {
      calls += 1;
      if (calls === 1) {
        // Simulate another task replacing the store reference wholesale first
        message.extra![BBI_IMAGE_EXTRA_KEY] = {};
      }
      return appendEntry(store, 0, 'h', fakeEntry({ generationId: `g${calls}` }));
    });

    expect(ok).toBe(true);
    expect(calls).toBe(2);
    // The second write, based on the latest reference, takes effect
    expect(latestEntry(readStore(message), 0, 'h', 0)?.generationId).toBe('g2');
  });

  it('returns false when the message no longer exists', async () => {
    const message = fakeMessage();
    const ctx = { chat: [message], saveChat: vi.fn(async () => undefined) } as unknown as STContext;
    expect(await mutateStore(ctx, 5, store => store)).toBe(false);
  });
});

describe('prepareImageForStorage', () => {
  const pngResult = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };

  afterEach(() => {
    settings.storage.saveAsJpeg = false;
  });

  it('keeps the original format when the switch is off', async () => {
    settings.storage.saveAsJpeg = false;
    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('png');
    expect(out.base64).toBe('AAAA');
  });

  it('reencodes to jpg when the switch is on', async () => {
    settings.storage.saveAsJpeg = true;
    const jpegBlob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      return { width: 2, height: 2, close: vi.fn() };
    }));
    const toBlob = vi.fn((cb: (b: Blob | null) => void, _type: string, _q: number) => {
      cb(jpegBlob);
    });
    const ctx2d = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ctx2d,
        toBlob,
      }),
    });
    // The browser's FileReader.readAsDataURL returns a full Data URL with the MIME prefix
    vi.stubGlobal('FileReader', class {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:image/jpeg;base64,jpegb64';
        this.onload?.();
      }
    });

    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('jpg');
    expect(out.base64).toBe('jpegb64');
    expect(createImageBitmap).toHaveBeenCalled();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    settings.storage.saveAsJpeg = false;
  });

  it('falls back to the original format when reencode fails', async () => {
    settings.storage.saveAsJpeg = true;
    // createImageBitmap throws → should fall back to saving the PNG as-is
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      throw new Error('decode failed');
    }));
    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('png');
    expect(out.base64).toBe('AAAA');
    settings.storage.saveAsJpeg = false;
  });
});

describe('saveImageResult', () => {
  beforeEach(() => {
    settings.storage.saveAsJpeg = false;
  });

  it.each([
    { name: ' 柏宝 ', name2: '柏宝', groupId: undefined, characterName: '柏宝', storedName: '柏宝' },
    { name: ' 小雪 ', name2: '另一位角色', groupId: 'group-a', characterName: '小雪', storedName: '小雪' },
    { name: ' ', name2: ' 柏宝 ', groupId: undefined, characterName: '柏宝', storedName: '柏宝' },
    { name: '', name2: undefined, groupId: undefined, characterName: '未命名角色', storedName: '未命名角色' },
    { name: ' ', name2: ' ', groupId: undefined, characterName: '未命名角色', storedName: '未命名角色' },
    { name: '小雪/测试:卡?', name2: '', groupId: undefined, characterName: '小雪/测试:卡?', storedName: '小雪测试卡' },
  ])('stores images by role with name=$name, name2=$name2, groupId=$groupId', async ({
    name, name2, groupId, characterName, storedName,
  }) => {
    const message = { ...fakeMessage(), name };
    const tag = '<bbi_image>a</bbi_image>';
    const hash = promptHash(tag);
    const legacyEntry = fakeEntry();
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: appendEntry({}, 0, hash, legacyEntry) };
    const storedPath = `/user/images/柏宝绘_${storedName}/bbi_seeded.png`;
    const saveChat = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => {
      expect(saveChat).not.toHaveBeenCalled();
      return new Response(JSON.stringify({ path: storedPath }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          name2,
          groupId,
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    const entry = await saveImageResult(0, 0, 0, tag, 987654321, result);

    const imageName = imageFileName(characterName, 0, hash, entry.generationId, 'png');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/images/upload', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        image: 'AAAA',
        format: 'png',
        ch_name: `柏宝绘_${characterName}`,
        filename: imageName,
      }),
    });
    // The second send is the sidecar: the only source of prompts when the gallery browses across chats
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sidecarUrl, sidecarInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(sidecarUrl).toBe('/api/files/upload');
    const sidecarBody = JSON.parse(String(sidecarInit.body)) as { name: string; data: string };
    expect(sidecarBody.name).toBe(sidecarFileName(imageName));
    // The character name contains CJK: btoa throws on code points > 255, so this also locks down "must be UTF-8 encoded"
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sidecarBody.data), c => c.charCodeAt(0))))).toEqual({
      v: 2,
      character: characterName,
      prompt: tag,
      seed: 987654321,
      createdAt: entry.createdAt,
    });
    expect(entry).toMatchObject({ path: storedPath, seed: 987654321, slotSeq: 0 });
    expect(historyEntries(readStore(message), 0, hash, 0)).toEqual([legacyEntry, entry]);
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it('persists generation meta into both the sidecar and the extra pointer', async () => {
    const message = fakeMessage();
    const tag = '<bbi_image>a</bbi_image>';
    const hash = promptHash(tag);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: '/user/images/x.png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          name2: 'c',
          saveChat: vi.fn(async () => undefined),
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    const meta: GenerationMeta = {
      backend: 'nai',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      positive: 'artist:wlop, 1girl',
      negative: 'lowres',
      artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
      vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.8, effectiveStrength: 0.8 }],
      params: { sampler: 'k_euler', steps: 28, cfg: 5 },
    };
    const entry = await saveImageResult(0, 0, 0, tag, 1, result, meta);

    // The extra pointer: the gallery's fast path for the current chat reads it directly
    expect(entry.meta).toEqual(meta);
    expect(readStore(message)?.['0']?.[hash]?.[0]?.meta).toEqual(meta);

    // The sidecar json: the only source of prompts/metadata when browsing across chats
    const [, sidecarInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const sidecarBody = JSON.parse(String(sidecarInit.body)) as { data: string };
    const sidecar = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(sidecarBody.data), c => c.charCodeAt(0))),
    );
    expect(sidecar).toMatchObject({ v: 2, meta });
  });

  it('keeps the image when the sidecar upload fails', async () => {
    const message = fakeMessage();
    const tag = '<bbi_image>a</bbi_image>';
    const storedPath = '/user/images/柏宝绘_c/bbi_seeded.png';
    const saveChat = vi.fn(async () => undefined);
    // Image upload succeeded, sidecar 500: the image must be saved as usual, just with no prompt to view
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/files/upload'
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ path: storedPath }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    const entry = await saveImageResult(0, 0, 0, tag, 1, result);

    expect(entry.path).toBe(storedPath);
    expect(historyEntries(readStore(message), 0, promptHash(tag), 0)).toEqual([entry]);
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy records untouched when the new upload fails', async () => {
    const message = fakeMessage();
    const originalStore = appendEntry({}, 0, 'h', fakeEntry());
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: originalStore };
    const saveChat = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response('Upload failed', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    await expect(saveImageResult(0, 0, 0, '<bbi_image>a</bbi_image>', 1, result)).rejects.toThrow('500');
    expect(message.extra[BBI_IMAGE_EXTRA_KEY]).toBe(originalStore);
    expect(saveChat).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('saveExternalImage', () => {
  beforeEach(() => {
    settings.storage.saveAsJpeg = false;
  });

  it('lands in the gallery: 柏宝绘_ folder + a name sidecarPathFor can recognize', async () => {
    const tag = '<bbi_image>1girl<size>portrait</size></bbi_image>';
    const storedPath = '/user/images/柏宝绘_小雪/bbi_seeded.png';
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/files/upload'
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ path: storedPath }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    expect(await saveExternalImage(' 小雪 ', tag, 123, result)).toBe(storedPath);

    const upload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      ch_name: string;
      filename: string;
    };
    // The folder prefix is the gallery's only basis for listing images: with a different prefix the image is saved but invisible in the gallery
    expect(upload.ch_name).toBe('柏宝绘_小雪');
    // The file name must pass sidecarPathFor's regex, otherwise the gallery never requests the sidecar;
    // the symptom is the image is there, the prompt is blank, and there is no error at all
    expect(sidecarPathFor(`/user/images/柏宝绘_小雪/${upload.filename}`)).toBe(
      `/user/files/${sidecarFileName(upload.filename)}`,
    );

    const [sidecarUrl, sidecarInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(sidecarUrl).toBe('/api/files/upload');
    const sidecar = JSON.parse(String(sidecarInit.body)) as { name: string; data: string };
    expect(sidecar.name).toBe(sidecarFileName(upload.filename));
    expect(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sidecar.data), c => c.charCodeAt(0)))),
    ).toMatchObject({ v: 2, character: '小雪', prompt: tag, seed: 123 });
  });

  it('falls back to 未命名角色 rather than writing a 柏宝绘_ folder with an empty name', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ path: '/user/images/柏宝绘_未命名角色/bbi_x.png' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    await saveExternalImage('   ', '<bbi_image>a</bbi_image>', 1, result);

    const upload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      ch_name: string;
    };
    expect(upload.ch_name).toBe('柏宝绘_未命名角色');
  });

  it('does not write any chat record (the image belongs to no floor)', async () => {
    const saveChat = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ path: '/user/images/柏宝绘_c/bbi_x.png' }), { status: 200 }),
    ));
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({ chat: [fakeMessage()], saveChat, getRequestHeaders: () => ({}) }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    await saveExternalImage('c', '<bbi_image>a</bbi_image>', 1, result);
    expect(saveChat).not.toHaveBeenCalled();
  });
});

describe('deleteImageResult', () => {
  it.each([
    '/user/images/柏宝绘_c/bbi_a.png',
    'user/images/柏宝绘_c/bbi_a.png',
  ])('deletes %s only after saving the chat and leaves legacy entries intact', async path => {
    const message = fakeMessage();
    const operations: string[] = [];
    const saveChat = vi.fn(async () => {
      await Promise.resolve();
      operations.push('saved');
    });
    const legacyEntry = fakeEntry({ generationId: 'g2', path: '/user/files/bbi_b.png' });
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'g1', path }));
    const store2 = appendEntry(store, 0, 'h', legacyEntry);
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: store2 };

    const fetchMock = vi.fn(async () => {
      operations.push('deleted');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const removed = await deleteImageResult(0, 0, 'h', 'g1');
    expect(removed).toBe(true);
    expect(historyEntries(readStore(message), 0, 'h', 0)).toEqual([legacyEntry]);
    expect(operations).toEqual(['saved', 'deleted']);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/images/delete', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ path }),
    });
  });

  it('deletes the sidecar alongside a real generated image', async () => {
    const message = fakeMessage();
    const path = '/user/images/柏宝绘_c/bbi_abc_0_h-g1.png';
    const saveChat = vi.fn(async () => undefined);
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: appendEntry({}, 0, 'h', fakeEntry({ path })) };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    await expect(deleteImageResult(0, 0, 'h', 'g1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/files/delete', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ path: '/user/files/bbi_abc_0_h-g1.json' }),
    });
  });

  it.each([
    '/user/files/bbi_a.png',
    'user/files/bbi_a.png',
  ])('removes a legacy record without deleting %s', async path => {
    const message = fakeMessage();
    const saveChat = vi.fn(async () => undefined);
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: appendEntry({}, 0, 'h', fakeEntry({ path })) };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => fakeCtx(message, saveChat) },
    });

    await expect(deleteImageResult(0, 0, 'h', 'g1')).resolves.toBe(true);
    expect(historyEntries(readStore(message), 0, 'h', 0)).toEqual([]);
    expect(saveChat).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not delete the image if saving the chat fails', async () => {
    const message = fakeMessage();
    message.extra = {
      [BBI_IMAGE_EXTRA_KEY]: appendEntry({}, 0, 'h', fakeEntry({ path: '/user/images/柏宝绘_c/bbi_a.png' })),
    };
    const saveChat = vi.fn(async () => { throw new Error('Save failed'); });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => fakeCtx(message, saveChat) },
    });

    await expect(deleteImageResult(0, 0, 'h', 'g1')).rejects.toThrow('Save failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteImageFileOnly', () => {
  it('decodes the encoded gallery src before calling the delete endpoints', async () => {
    // The gallery's src is encodeURIComponent'd segment by segment, while ST's delete endpoint doesn't decode:
    // sending the encoded path as-is would only 404 (the image isn't deleted), so this locks down "normalise before sending".
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    });

    const src = `/user/images/${encodeURIComponent('柏宝绘_测试角色')}/bbi_abc_0_h-g1.png`;
    await deleteImageFileOnly(src);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/images/delete', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ path: 'user/images/柏宝绘_测试角色/bbi_abc_0_h-g1.png' }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/files/delete', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ path: '/user/files/bbi_abc_0_h-g1.json' }),
    });
  });
});
