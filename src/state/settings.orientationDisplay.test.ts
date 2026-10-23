import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Three settings added in 0.3.1: the frame lock (one at the NAI channel level, one per ComfyUI workflow),
 * NAI "Generate Natural Language", and floor image display size.
 *
 * What to watch:
 * 1. Old configs missing fields all fall to defaults, with no migration. The frame lock defaults to "Auto" and NAI natural language defaults to on, both equal to pre-upgrade behaviour;
 *    display size defaulting to "Medium" is deliberate: the pre-upgrade "fill the floor width" is exactly the problem being fixed, and anyone wanting it back picks it in the dropdown.
 * 2. The frame lock criterion lives in one place only (activeOrientationLock), taking the one for the current backend; the two never cross.
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWith(stored: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: stored },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
});

describe('frame lock / NAI natural language / display size · read fallbacks', () => {
  it('old configs missing these fields → orientation not locked, NAI still writes natural language, display size Medium', async () => {
    const { settings } = await hydrateWith({
      nai: { model: 'nai-diffusion-4-5-full' },
      comfyui: { workflows: [{ id: 'wf_a', name: 'A', workflow: '' }], activeWorkflowId: 'wf_a' },
      ui: { theme: 'st' },
    });
    expect(settings.nai.orientationLock).toBe('auto');
    expect(settings.nai.naturalLanguage).toBe(true);
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
    expect(settings.ui.imageDisplaySize).toBe('medium');
  });

  it('valid values kept as-is; each workflow has its own lock', async () => {
    const { settings } = await hydrateWith({
      nai: { naturalLanguage: false, orientationLock: 'landscape' },
      comfyui: {
        workflows: [
          { id: 'wf_a', name: 'A', workflow: '', orientationLock: 'portrait' },
          { id: 'wf_b', name: 'B', workflow: '', orientationLock: 'landscape' },
          { id: 'wf_c', name: 'C', workflow: '' },
        ],
        activeWorkflowId: 'wf_a',
      },
      ui: { imageDisplaySize: 'full' },
    });
    expect(settings.nai.naturalLanguage).toBe(false);
    expect(settings.nai.orientationLock).toBe('landscape');
    expect(settings.comfyui.workflows.map(w => w.orientationLock)).toEqual([
      'portrait',
      'landscape',
      'auto',
    ]);
    expect(settings.ui.imageDisplaySize).toBe('full');
  });

  it('dirty values → each falls back to its default without throwing', async () => {
    const { settings } = await hydrateWith({
      nai: { naturalLanguage: 'no', orientationLock: 'sideways' },
      comfyui: {
        workflows: [{ id: 'wf_a', name: 'A', workflow: '', orientationLock: 1 }],
        activeWorkflowId: 'wf_a',
      },
      ui: { imageDisplaySize: 'huge' },
    });
    expect(settings.nai.naturalLanguage).toBe(true);
    expect(settings.nai.orientationLock).toBe('auto');
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
    expect(settings.ui.imageDisplaySize).toBe('medium');
  });

  it('when an even older single ComfyUI config is folded into a preset, orientation is likewise not locked', async () => {
    const { settings } = await hydrateWith({ comfyui: { workflow: '{}', naturalLanguage: true } });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].orientationLock).toBe('auto');
  });

  it('newly created workflow presets are unlocked by default', async () => {
    const { newComfyWorkflow } = await import('@/state/settings');
    expect(newComfyWorkflow().orientationLock).toBe('auto');
  });
});

describe('activeOrientationLock: takes the one for the current backend', () => {
  it('NAI takes the channel level, ComfyUI the current workflow; switching workflow switches the lock', async () => {
    const { settings, activeOrientationLock } = await hydrateWith({
      defaultBackend: 'nai',
      nai: { orientationLock: 'portrait' },
      comfyui: {
        workflows: [
          { id: 'wf_a', name: 'A', workflow: '', orientationLock: 'landscape' },
          { id: 'wf_b', name: 'B', workflow: '' },
        ],
        activeWorkflowId: 'wf_a',
      },
    });
    expect(activeOrientationLock()).toBe('portrait');

    settings.defaultBackend = 'comfyui';
    expect(activeOrientationLock()).toBe('landscape');

    settings.comfyui.activeWorkflowId = 'wf_b';
    expect(activeOrientationLock()).toBe('auto');
  });
});

describe('imageDisplayMaxHeight', () => {
  it('small/medium/large cap height at 400/600/800, fill has no cap', async () => {
    const { imageDisplayMaxHeight } = await import('@/state/settings');
    expect(imageDisplayMaxHeight('small')).toBe(400);
    expect(imageDisplayMaxHeight('medium')).toBe(600);
    expect(imageDisplayMaxHeight('large')).toBe(800);
    expect(imageDisplayMaxHeight('full')).toBeNull();
  });
});
