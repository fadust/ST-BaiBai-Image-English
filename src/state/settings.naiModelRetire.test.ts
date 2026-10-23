import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Handling existing data after NAI models below 4.5 were retired (NAI_MODELS keeps only 4.5/V5).
 *
 * Key point: narrowing the allowlist **rewrites** the model users stored; style, Anlas cost and the vibe encoding key all change.
 * This is a deliberately accepted cost (those models are barely used any more), so what is locked here isn't "don't change" but
 * "change only what must change, and leave a trace": listed models must not change by a single byte, and retired models must fall back to
 * the default model with a console.warn (otherwise feedback like "my model changed by itself" would have no evidence).
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithModel(model: unknown) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai: { model } } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('handling stored models after old NAI models were retired', () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    warn = vi.fn();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('console', { ...console, warn });
  });

  it.each(['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'])(
    'retired %s falls back to the default model and leaves a warning',
    async retired => {
      const settings = await hydrateWithModel(retired);
      expect(settings.nai.model).toBe('nai-diffusion-5-full');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(retired));
    },
  );

  it.each([
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
  ])('listed %s kept as-is, undisturbed', async kept => {
    const settings = await hydrateWithModel(kept);
    expect(settings.nai.model).toBe(kept);
    expect(warn).not.toHaveBeenCalled();
  });

  it('configs that never stored a model use the default and do not count as retired', async () => {
    const settings = await hydrateWithModel(undefined);
    expect(settings.nai.model).toBe('nai-diffusion-5-full');
    expect(warn).not.toHaveBeenCalled();
  });
});
