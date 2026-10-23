import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Migration of existing data from a single ComfyUI workflow → the workflow library.
 *
 * Two key points:
 * 1. If old configs' workflow / naturalLanguage / landscape and portrait sizes weren't moved into the first preset, after upgrading
 *    the user's configured workflow would vanish into thin air (the panel goes blank, image generation fails outright).
 * 2. workflows never being empty is a global invariant: the panel and image gates take workflows[0] directly as the fallback,
 *    and an empty library would blow up with undefined all the way down. Dirty data must be caught too.
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithComfy(comfyui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: comfyui === undefined ? {} : { comfyui } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('ComfyUI workflow library migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('old single config folds into one preset, with JSON/toggles/landscape and portrait sizes moved in as-is and made current', async () => {
    const settings = await hydrateWithComfy({
      url: 'http://127.0.0.1:8188',
      workflow: '{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}',
      naturalLanguage: true,
      portraitSize: '1024×1536',
      landscapeSize: '1536×1024',
    });

    expect(settings.comfyui.workflows).toHaveLength(1);
    const [preset] = settings.comfyui.workflows;
    expect(preset.name).toBe("Default workflow");
    expect(preset.workflow).toBe('{"3":{"class_type":"KSampler","inputs":{"seed":"%seed%"}}}');
    expect(preset.naturalLanguage).toBe(true);
    expect(preset.portraitSize).toBe('1024×1536');
    expect(preset.landscapeSize).toBe('1536×1024');
    // The current entry points at it, otherwise the panel shows a blank after upgrading
    expect(settings.comfyui.activeWorkflowId).toBe(preset.id);
    // url stays at the channel level and does not move down into the preset
    expect(settings.comfyui.url).toBe('http://127.0.0.1:8188');
  });

  it('never configured (comfyui key missing) → still gets one empty preset without throwing', async () => {
    const settings = await hydrateWithComfy(undefined);
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
  });

  it('old config workflow is an empty string → still creates the entry (that is the empty slot the user faces, not junk data)', async () => {
    const settings = await hydrateWithComfy({ workflow: '', naturalLanguage: false });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.workflows[0].workflow).toBe('');
  });

  it('new-format data kept as-is and not folded again (migration is idempotent)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [
        { id: 'wf_a', name: 'Illustrious', workflow: '{"1":{}}', naturalLanguage: false, portraitSize: '832×1216', landscapeSize: '1216×832' },
        { id: 'wf_b', name: 'Flux', workflow: '{"2":{}}', naturalLanguage: true, portraitSize: '1024×1024', landscapeSize: '1024×1024' },
      ],
      activeWorkflowId: 'wf_b',
    });

    expect(settings.comfyui.workflows.map(w => w.id)).toEqual(['wf_a', 'wf_b']);
    expect(settings.comfyui.workflows.map(w => w.name)).toEqual(['Illustrious', 'Flux']);
    expect(settings.comfyui.activeWorkflowId).toBe('wf_b');
  });

  it('current entry points at a deleted entry → falls back to the first (a dangling id would blank the panel and leave image generation with no workflow)', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ id: 'wf_a', name: 'A', workflow: '{"1":{}}' }],
      activeWorkflowId: 'wf_gone',
    });
    expect(settings.comfyui.activeWorkflowId).toBe('wf_a');
  });

  it('workflows is an empty array → one entry added, keeping the never-empty invariant', async () => {
    const settings = await hydrateWithComfy({ workflows: [], activeWorkflowId: '' });
    expect(settings.comfyui.workflows).toHaveLength(1);
    expect(settings.comfyui.activeWorkflowId).toBe(settings.comfyui.workflows[0].id);
  });

  it('entries missing fields/containing dirty data → filled item by item, invariant still holds', async () => {
    const settings = await hydrateWithComfy({
      workflows: [{ name: 'no id' }, null, { id: 'wf_c', workflow: 42, portraitSize: '   ' }],
      activeWorkflowId: 'wf_c',
    });

    expect(settings.comfyui.workflows).toHaveLength(3);
    const [first, second, third] = settings.comfyui.workflows;
    // Entries missing an id get one; entries missing a name get the default name
    expect(first.id).toBeTruthy();
    expect(first.name).toBe('no id');
    expect(second.id).toBeTruthy();
    expect(second.name).toBe("Default workflow");
    // Non-string workflow becomes an empty string; blank sizes go back to defaults (they can't stay empty, otherwise %width% has no value)
    expect(third.workflow).toBe('');
    expect(third.portraitSize).toBe('832×1216');
    expect(settings.comfyui.activeWorkflowId).toBe('wf_c');
  });

  it('activeComfyPreset / effectiveComfyConn take the current entry', async () => {
    mocks.context = {
      extensionSettings: {
        baibai_image: {
          comfyui: {
            url: 'http://example:8188',
            workflows: [
              { id: 'wf_a', name: 'A', workflow: '{"1":{}}', portraitSize: '832×1216', landscapeSize: '1216×832' },
              { id: 'wf_b', name: 'B', workflow: '{"2":{}}', portraitSize: '1024×1024', landscapeSize: '1024×1024' },
            ],
            activeWorkflowId: 'wf_b',
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    const { hydrateSettings, activeComfyPreset, effectiveComfyConn } = await import('@/state/settings');
    await hydrateSettings();

    expect(activeComfyPreset().name).toBe('B');
    const { simpleDefaults } = await import('@/backends/comfyTemplates');
    expect(effectiveComfyConn()).toEqual({
      url: 'http://example:8188',
      workflow: '{"2":{}}',
      // Existing presets lack mode/simple fields → custom + simple-mode defaults
      mode: 'custom',
      simple: simpleDefaults(),
      portraitSize: '1024×1024',
      landscapeSize: '1024×1024',
    });
  });
});
