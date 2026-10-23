import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Folding existing data and handling dirty data for the NAI endpoint library (address + key).
 *
 * It started with "switching between community sites": the same set of image parameters, switched between several exits. So only url/key go with entries;
 * model/sampler/size/vibes/artist string all stay at the channel level, and switching sites shouldn't force reconfiguring parameters.
 *
 * Two rules **opposite** to the artist string library (on the workflow library's side) are this file's main focus:
 * 1. The library is never empty and always contains the built-in official entry: the address is essential, and without one no image can be generated;
 * 2. a dangling activeEndpointId falls back to endpoints[0] and is **not** cleared. For the artist string, falling back means silently changing style
 *    (every image changes, untraceably); for an endpoint it only changes the exit, and an error shows up immediately as a connection failure, so the costs aren't equal.
 *
 * One more belongs only here: normalize forces the official entry's url back, and hand-editing settings.json can't override it.
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

const OFFICIAL = 'https://image.novelai.net';

describe('NAI endpoint library · folding existing data', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('nai key missing entirely → only the official entry, selected', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('existing official address → key folded into the official entry, with **no** duplicate entry', async () => {
    const settings = await hydrateWithNai({ url: OFFICIAL, key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
    expect(settings.nai.activeEndpointId).toBe('nep_official');
  });

  it('existing address blank → also folded into the official entry (a blank address does not deserve its own row)', async () => {
    const settings = await hydrateWithNai({ url: '', key: 'nai-old' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('nai-old');
  });

  it('existing official address with a trailing slash → treated as official, still folded into one', async () => {
    const settings = await hydrateWithNai({ url: `${OFFICIAL}/`, key: 'k' });
    expect(settings.nai.endpoints).toHaveLength(1);
    expect(settings.nai.endpoints[0].id).toBe('nep_official');
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('existing third-party site → becomes the first entry and stays selected, the official entry **appended after**', async () => {
    // The order is deliberate: putting the official one first would push the exit the user is using to the second row, looking as if it had been replaced.
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://nai.example.org', OFFICIAL]);
    expect(settings.nai.endpoints[0].key).toBe('sk-x');
    expect(settings.nai.activeEndpointId).toBe(settings.nai.endpoints[0].id);
    expect(settings.nai.endpoints[1].id).toBe('nep_official');
  });

  it('old fields kept as-is after migration (for rollback, not used for generation)', async () => {
    const settings = await hydrateWithNai({ url: 'https://nai.example.org', key: 'sk-x' });
    expect(settings.nai.key).toBe('sk-x');
    expect(settings.nai.url).toBe('https://nai.example.org');
  });

  it('migration is idempotent: new-format data is kept as-is and the current entry untouched', async () => {
    const first = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
      ],
      activeEndpointId: 'nep_a',
    });
    expect(first.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    expect(first.nai.endpoints[0].name).toBe('公益站 A');
    expect(first.nai.endpoints[0].key).toBe('ka');
    expect(first.nai.activeEndpointId).toBe('nep_a');
  });
});

describe('NAI endpoint library · never-empty and official-entry invariants', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('official entry deleted by hand → added back automatically (the library always has a usable exit)', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    expect(settings.nai.endpoints.map(e => e.id)).toEqual(['nep_a', 'nep_official']);
    // Adding it back doesn't take the selection: the user is still using A
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('official entry url edited by hand → forced back to the official address', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_official', name: '假官方', url: 'https://evil.example', key: 'k' }],
      activeEndpointId: 'nep_official',
    });
    expect(settings.nai.endpoints[0].url).toBe(OFFICIAL);
    // The name also goes back to the built-in name (the official entry can't be renamed; dirty data is corrected too); the key is the user's own and kept
    expect(settings.nai.endpoints[0].name).toBe("NovelAI official");
    expect(settings.nai.endpoints[0].key).toBe('k');
  });

  it('endpoints is an empty array → folded as if there were no new format, rather than left as an empty library', async () => {
    const settings = await hydrateWithNai({ endpoints: [], url: 'https://a.example', key: 'ka' });
    expect(settings.nai.endpoints.map(e => e.url)).toEqual(['https://a.example', OFFICIAL]);
  });

  it('dangling activeEndpointId → falls back to the first, **not** cleared to an empty string', async () => {
    const settings = await hydrateWithNai({
      endpoints: [
        { id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' },
        { id: 'nep_b', name: 'B', url: 'https://b.example', key: 'kb' },
      ],
      activeEndpointId: 'nep_gone',
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
    expect(settings.nai.endpoints).toHaveLength(3); // A, B, the re-added official one
  });

  it('activeEndpointId not a string → also falls back to the first', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 42,
    });
    expect(settings.nai.activeEndpointId).toBe('nep_a');
  });

  it('entries missing fields/containing dirty data → filled item by item, not discarded whole', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ name: 'no id' }, null, { id: 'nep_c', url: 42, key: null }],
      activeEndpointId: 'nep_c',
    });
    const [first, second, third] = settings.nai.endpoints;
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe('Endpoint 2');
    expect(second.url).toBe('');
    // Non-strings become empty strings; a valid id is still recognised by activeEndpointId
    expect(third.url).toBe('');
    expect(third.key).toBe('');
    expect(settings.nai.activeEndpointId).toBe('nep_c');
  });

  it('newNaiEndpoint gives unique ids on repeated calls; the nep_ prefix does not collide with art_/wf_/ch_', async () => {
    const { newNaiEndpoint } = await import('@/state/settings');
    const ids = [newNaiEndpoint(), newNaiEndpoint(), newNaiEndpoint()].map(e => e.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id.startsWith('nep_'))).toBe(true);
  });
});

describe('effectiveNai: generation only uses the current endpoint', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('url/key from the current entry, all other image parameters from the channel level (switching sites needs no reconfiguration)', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          nai: {
            url: 'https://legacy.example',
            key: 'legacy-key',
            model: 'nai-diffusion-4-5-full',
            steps: 33,
            endpoints: [
              { id: 'nep_official', name: 'NovelAI 官方', url: OFFICIAL, key: 'ko' },
              { id: 'nep_a', name: '公益站 A', url: 'https://a.example', key: 'ka' },
            ],
            activeEndpointId: 'nep_a',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, effectiveNai, settings } = await import('@/state/settings');
    await hydrateSettings();

    const conn = effectiveNai();
    expect(conn.url).toBe('https://a.example');
    expect(conn.key).toBe('ka');
    // Channel-level parameters carried over as-is, unchanged by switching sites
    expect(conn.model).toBe('nai-diffusion-4-5-full');
    expect(conn.steps).toBe(33);

    // Switch back to official: the same parameters, a different exit
    settings.nai.activeEndpointId = 'nep_official';
    expect(effectiveNai().url).toBe(OFFICIAL);
    expect(effectiveNai().key).toBe('ko');
    expect(effectiveNai().steps).toBe(33);
  });

  it('activeEndpointId broken while running → activeNaiEndpoint falls back to the first, never undefined', async () => {
    const settings = await hydrateWithNai({
      endpoints: [{ id: 'nep_a', name: 'A', url: 'https://a.example', key: 'ka' }],
      activeEndpointId: 'nep_a',
    });
    const { activeNaiEndpoint } = await import('@/state/settings');
    settings.nai.activeEndpointId = 'nep_gone';
    expect(activeNaiEndpoint().id).toBe('nep_a');
  });
});
