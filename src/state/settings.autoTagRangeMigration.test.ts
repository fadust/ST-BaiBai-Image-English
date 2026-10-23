import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Images per floor upgraded from a single maxImages to minImages～maxImages.
 * Existing users must not suddenly be forced to get an image on every floor by the upgrade, so a missing minImages must migrate to 0;
 * dirty ranges must also be normalised at hydrate, so the prompt and parser never get min > max.
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithAutoTag(autoTag: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: autoTag === undefined ? {} : { autoTag } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings.autoTag;
}

describe('auto-tag image count range migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('old configs with only maxImages get minImages=0, keeping the allow-no-image behaviour', async () => {
    const autoTag = await hydrateWithAutoTag({ maxImages: 5 });
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(5);
  });

  it('fresh install default range is 0～2', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.minImages).toBe(0);
    expect(autoTag.maxImages).toBe(2);
  });

  it('clamps the minimum into 0～maximum and keeps the maximum at least 1', async () => {
    const tooHigh = await hydrateWithAutoTag({ minImages: 9, maxImages: 3 });
    expect(tooHigh.minImages).toBe(3);
    expect(tooHigh.maxImages).toBe(3);

    vi.resetModules();
    const negative = await hydrateWithAutoTag({ minImages: -4, maxImages: 0 });
    expect(negative.minImages).toBe(0);
    expect(negative.maxImages).toBe(1);
  });
});
