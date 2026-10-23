import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
  saveVibeFiles: vi.fn(),
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

// Only replace saveVibeFiles, which really needs intercepting (to assert calls and the failure path); other exports use the real thing.
// This once hand-copied the implementations of vibeFingerprint / vibeMetaFromData, so every export added to vibeStore
// would make this file blow up with "No xxx export is defined on the mock", and the copies would quietly drift from the real thing.
vi.mock('@/backends/vibeStore', async () => ({
  ...(await vi.importActual<typeof import('@/backends/vibeStore')>('@/backends/vibeStore')),
  saveVibeFiles: mocks.saveVibeFiles,
}));

describe('legacy vibe settings migration', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.saveVibeFiles.mockReset();
    vi.stubGlobal('toastr', {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  it('uploads the large fields and keeps only file paths and a small index', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-v1',
      name: '旧 Vibe',
      image: 'A'.repeat(1024),
      thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
      encodings: { 'v4-5full': { encoding: 'B'.repeat(512), infoExtracted: 1 } },
      strength: 0.7,
      enabled: true,
    };
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: { vibes: [legacy] },
        },
      },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockResolvedValue({
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
    });

    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(mocks.saveVibeFiles).toHaveBeenCalledOnce();
    expect(settings.nai.vibes[0]).toMatchObject({
      id: 'legacy-v1',
      dataPath: '/user/files/bbi-vibe-legacy-v1.json',
      thumbnailPath: '/user/files/bbi-vibe-thumb-legacy-v1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
      strength: 0.7,
      enabled: true,
    });
    const persisted = mocks.context.extensionSettings.baibai_image.nai.vibes[0];
    expect(persisted).not.toHaveProperty('image');
    expect(persisted).not.toHaveProperty('thumbnail');
    expect(persisted).not.toHaveProperty('encodings');
    expect(saveSettingsDebounced).toHaveBeenCalled();
  });

  it('frees each entry large fields right after it is saved', async () => {
    const vibes = [
      { id: 'legacy-1', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-2', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced: vi.fn(),
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/1.json', thumbnailPath: '' })
      .mockImplementationOnce(async () => {
        expect(vibes[0]).not.toHaveProperty('image');
        expect(vibes[1]).toHaveProperty('image');
        return { dataPath: '/user/files/2.json', thumbnailPath: '' };
      });

    const { hydrateSettings } = await import('@/state/settings');
    await hydrateSettings();

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).not.toHaveProperty('image');
  });

  it('when a single save fails, keeps the original data and does not enter the normal settings write-back', async () => {
    const saveSettingsDebounced = vi.fn();
    const legacy = {
      id: 'legacy-failed',
      image: 'A'.repeat(1024),
      thumbnail: '',
      encodings: {},
    };
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes: [legacy] } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles.mockRejectedValue(new Error('server 与 IndexedDB 都失败'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('server 与 IndexedDB 都失败');

    expect(mocks.context.extensionSettings.baibai_image.nai.vibes[0]).toBe(legacy);
    expect(legacy).toHaveProperty('image');
    expect(saveSettingsDebounced).not.toHaveBeenCalled();
  });

  it('on partial failure, saves the freed entries and keeps the failed ones', async () => {
    const saveSettingsDebounced = vi.fn();
    const vibes = [
      { id: 'legacy-ok', image: 'A'.repeat(1024), thumbnail: '', encodings: {} },
      { id: 'legacy-failed', image: 'B'.repeat(1024), thumbnail: '', encodings: {} },
    ];
    mocks.context = {
      extensionSettings: { baibai_image: { nai: { vibes } } },
      saveSettingsDebounced,
    };
    mocks.saveVibeFiles
      .mockResolvedValueOnce({ dataPath: '/user/files/ok.json', thumbnailPath: '' })
      .mockRejectedValueOnce(new Error('第二条失败'));

    const { hydrateSettings } = await import('@/state/settings');
    await expect(hydrateSettings()).rejects.toThrow('第二条失败');

    expect(vibes[0]).not.toHaveProperty('image');
    expect(vibes[1]).toHaveProperty('image');
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });
});
