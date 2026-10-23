import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Existing data and dirty data handling for the NAI artist string library.
 *
 * Three rules **deliberately opposite** to the ComfyUI workflow library are this file's main focus:
 * 1. The library may be empty, and `naiDefaults` seeds no entries either: the artist string is optional seasoning,
 *    and inserting one out of thin air would make people think some style had been forced on them;
 * 2. a dangling `activeArtistId` is cleared to an empty string, **not** falling back to the first. Falling back would silently change the user's style,
 *    and the dropdown would show exactly that entry (looking like their own choice), nearly impossible to trace;
 * 3. a purely additive migration with no old fields to fold: after upgrading, old configs' positive prompt output must stay byte for byte the same.
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI artist string library', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('existing configs without these two keys → empty library + None, no throw (image prompts unchanged after upgrading)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('nai key missing entirely → likewise empty library + None', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('new format kept as-is, current entry untouched (migration is idempotent)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: '厚涂', prompt: 'artist:wlop', quality: 'masterpiece', negative: 'lowres' },
        { id: 'art_b', name: '赛璐璐', prompt: 'artist:as109', quality: '', negative: '' },
      ],
      activeArtistId: 'art_b',
    });
    expect(settings.nai.artistPresets.map(a => a.id)).toEqual(['art_a', 'art_b']);
    expect(settings.nai.artistPresets.map(a => a.name)).toEqual(['厚涂', '赛璐璐']);
    expect(settings.nai.artistPresets[0].quality).toBe('masterpiece');
    expect(settings.nai.artistPresets[0].negative).toBe('lowres');
    expect(settings.nai.activeArtistId).toBe('art_b');
  });

  it('existing entries without bound positive/negative keys → filled with empty strings (= follow the channel level; prompts unchanged after upgrading)', async () => {
    // Old data from before the binding fields has only id/name/prompt; filling empty strings rather than official words
    // is what preserves old users' existing channel-level/official behaviour in the "recipe → channel → official" fallback chain.
    const settings = await hydrateWithNai({
      qualityTags: 'channel q',
      undesiredContent: 'channel n',
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_a',
    });
    const preset = settings.nai.artistPresets[0];
    expect(preset.quality).toBe('');
    expect(preset.negative).toBe('');
    // Channel-level overrides are unaffected by the migration
    expect(settings.nai.qualityTags).toBe('channel q');
    expect(settings.nai.undesiredContent).toBe('channel n');
  });

  it('binding fields with non-string dirty data → empty strings, entry not discarded', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a', quality: 42, negative: null }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets[0].quality).toBe('');
    expect(settings.nai.artistPresets[0].negative).toBe('');
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('previewPath: valid strings kept; missing/dirty data treated as no preview', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [
        { id: 'art_a', name: 'A', prompt: '', previewPath: '/user/images/柏宝绘_画师串/art_a.jpg' },
        { id: 'art_b', name: 'B', prompt: '' },
        { id: 'art_c', name: 'C', prompt: '', previewPath: 42 },
        { id: 'art_d', name: 'D', prompt: '', previewPath: '' },
      ],
      activeArtistId: '',
    });
    const [a, b, c, d] = settings.nai.artistPresets;
    expect(a.previewPath).toBe('/user/images/柏宝绘_画师串/art_a.jpg');
    expect(b.previewPath).toBeUndefined();
    expect(c.previewPath).toBeUndefined();
    expect(d.previewPath).toBeUndefined();
  });

  it('current entry points at a deleted entry → cleared to an empty string, **not** falling back to the first', async () => {
    // Deliberately different from normalizeComfyUI's "dangling falls back to workflows[0]": there the workflow is essential;
    // here falling back would silently apply a style the user never chose, changing every image with no traceable cause.
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 'art_gone',
    });
    expect(settings.nai.activeArtistId).toBe('');
    // The library itself is unaffected; the entries are still there
    expect(settings.nai.artistPresets).toHaveLength(1);
  });

  it('library is an empty array but id is not empty → id cleared, library stays empty (no entry added, opposite of the never-empty workflow library)', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'art_x' });
    expect(settings.nai.artistPresets).toEqual([]);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('activeArtistId not a string → cleared to an empty string', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
      activeArtistId: 42,
    });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('entries missing fields/containing dirty data → filled item by item, not discarded whole', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ name: 'no id' }, null, { id: 'art_c', prompt: 42 }],
      activeArtistId: 'art_c',
    });

    expect(settings.nai.artistPresets).toHaveLength(3);
    const [first, second, third] = settings.nai.artistPresets;
    // Entries missing an id get one; the name is kept
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    // null entries are also filled into usable empty slots, named by sequence number
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('Artist Tags 2');
    expect(second.prompt).toBe('');
    // Non-string prompts become empty strings; a valid id is still recognised by activeArtistId
    expect(third.prompt).toBe('');
    expect(settings.nai.activeArtistId).toBe('art_c');
  });

  it('entries whose prompt is an empty string are kept as usual (that is the empty slot the user faces, not junk data)', async () => {
    const settings = await hydrateWithNai({
      artistPresets: [{ id: 'art_a', name: '待填', prompt: '' }],
      activeArtistId: 'art_a',
    });
    expect(settings.nai.artistPresets).toHaveLength(1);
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('activeNaiArtist takes the current entry; returns null when none is selected / dangling', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            artistPresets: [
              { id: 'art_a', name: 'A', prompt: 'artist:a' },
              { id: 'art_b', name: 'B', prompt: 'artist:b' },
            ],
            activeArtistId: 'art_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeNaiArtist, settings } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeNaiArtist()?.name).toBe('B');
    expect(activeNaiArtist()?.prompt).toBe('artist:b');

    // Switch to "None"
    settings.nai.activeArtistId = '';
    expect(activeNaiArtist()).toBeNull();

    // Dangling (timing like the UI breaking the library while running) also returns null, rather than falling back to the first
    settings.nai.activeArtistId = 'art_gone';
    expect(activeNaiArtist()).toBeNull();
  });

  it('newNaiArtist gives unique ids on repeated calls (no collision even within the same millisecond)', async () => {
    const { newNaiArtist } = await import('@/state/settings');
    const ids = [newNaiArtist(), newNaiArtist(), newNaiArtist()].map(a => a.id);
    expect(new Set(ids).size).toBe(3);
    // The art_ prefix doesn't collide with the wf_ / ch_ id spaces
    expect(ids.every(id => id.startsWith('art_'))).toBe(true);
  });
});

describe('built-in artist strings (bi_*) and new vs old users', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('fresh install (no stored settings at all) → the built-in Default artist string enabled by default', async () => {
    // The default only applies on this path: when stored doesn't exist at all, the module-level defaults are written straight into extension_settings.
    mocks.context = {
      extensionSettings: {},
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, settings } = await import('@/state/settings');
    await hydrateSettings();
    expect(settings.nai.activeArtistId).toBe('bi_default');
    expect(settings.nai.artistPresets).toEqual([]); // The user library is still empty: built-in entries don't go into settings
  });

  it('old users: the stored activeArtistId kept as-is (empty string = None, not displaced by the default)', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      artistPresets: [],
      activeArtistId: '',
    });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('old users whose stored nai section lacks the activeArtistId key → empty string, not taking the fresh-install default', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('configs with a built-in entry selected: not dangling even with an empty user library, so normalize does not clear it', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_default' });
    expect(settings.nai.activeArtistId).toBe('bi_default');
  });

  it('bi_ prefix but the id does not exist (after a built-in entry was retired) → still cleared as dangling to an empty string', async () => {
    const settings = await hydrateWithNai({ artistPresets: [], activeArtistId: 'bi_gone' });
    expect(settings.nai.activeArtistId).toBe('');
  });
});
