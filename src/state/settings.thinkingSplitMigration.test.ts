import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The thought chain went from one copy shared by three backends to three: comfy / nai / naiV5.
 *
 * Existing users' custom thinking was always written in ComfyUI form (a single tag string + adjacency binding),
 * so it only migrates into the same-form comfyThinking and naiThinking; naiV5Thinking must stay empty and fall back to the new default.
 * Pouring the ComfyUI rule into V5 would cement the bug of "the thought chain asking for what the specification explicitly forbids".
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

describe('settings migration splitting the thought chain by backend', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('the old single thinking migrates into comfy and nai, V5 left empty', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { thinking: '我改过的清单' },
    });
    expect(autoTag.prompts.comfyThinking).toBe('我改过的清单');
    expect(autoTag.prompts.naiThinking).toBe('我改过的清单');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('fresh install has all three empty (each falls back to its built-in default)', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.prompts.comfyThinking).toBe('');
    expect(autoTag.prompts.naiThinking).toBe('');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('values already stored under the new fields are not overwritten by the old thinking', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: {
        thinking: '旧的',
        comfyThinking: '新的 comfy',
        naiThinking: '新的 nai',
        naiV5Thinking: '新的 V5',
      },
    });
    expect(autoTag.prompts.comfyThinking).toBe('新的 comfy');
    expect(autoTag.prompts.naiThinking).toBe('新的 nai');
    expect(autoTag.prompts.naiV5Thinking).toBe('新的 V5');
  });

  it('the split leaves the other prompt fields of the same batch untouched', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { jailbreak: '破限', comfySpec: '我的规范', thinking: '我的清单' },
    });
    expect(autoTag.prompts.jailbreak).toBe('破限');
    expect(autoTag.prompts.comfySpec).toBe('我的规范');
    expect(autoTag.prompts.naiSpec).toBe('');
    expect(autoTag.prompts.naiV5Spec).toBe('');
  });
});
