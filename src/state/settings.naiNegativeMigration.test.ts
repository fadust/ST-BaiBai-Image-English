import { beforeEach, describe, expect, it, vi } from 'vitest';

import { naiDefaultUndesired } from '@/backends/nai';

/**
 * Migration of existing data after "extra negative" was merged into the single negative prompt box.
 * Key point: if old configs' negativePrompt weren't moved into undesiredContent, it would silently stop working after upgrading:
 * content the user once excluded would quietly come back into the image, with nothing looking wrong in the UI.
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('negative prompt box-merge migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('existing extra negative folded into the negative prompt in the old order: extra first + official words after', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-full',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.undesiredContent).toBe(`bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-full')}`);
    // Cleared once moved, leaving no shadow value that would make people think it still applies
    expect(settings.nai.negativePrompt).toBe('');
  });

  it('folding uses the config own model, not the default model', async () => {
    // Another listed model different from the default (5-full): retired old models would be rewritten to the default by the allowlist,
    // and then "whose model is used" couldn't be tested.
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-4-5-curated',
      negativePrompt: 'bad hands',
    });
    expect(settings.nai.undesiredContent).toBe(
      `bad hands, ${naiDefaultUndesired('nai-diffusion-4-5-curated')}`,
    );
  });

  it('leaves an existing undesiredContent alone (migration runs once and never appends twice)', async () => {
    const settings = await hydrateWithNai({ undesiredContent: 'mine only', negativePrompt: 'bad hands' });
    expect(settings.nai.undesiredContent).toBe('mine only');
  });

  it('already migrated and the user deliberately emptied it to follow the official words → stays an empty string, not folded again', async () => {
    const settings = await hydrateWithNai({ undesiredContent: '', negativePrompt: 'bad hands' });
    expect(settings.nai.undesiredContent).toBe('');
  });

  it('no existing extra negative → left empty (follows the model official words)', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full' });
    expect(settings.nai.undesiredContent).toBe('');
  });
});
