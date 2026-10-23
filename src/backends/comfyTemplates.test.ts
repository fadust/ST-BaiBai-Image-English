import { describe, expect, it } from 'vitest';

import {
  buildSimpleWorkflow,
  normalizeSimpleConfig,
  simpleDefaults,
  templateSupportsNegative,
  validateSimpleConfig,
  type ComfySimpleConfig,
  type SimpleWorkflowNode,
} from '@/backends/comfyTemplates';

const VALUES = { prompt: '1girl, silver hair', seed: 42, width: 832, height: 1216 };

function config(patch: Partial<ComfySimpleConfig>): ComfySimpleConfig {
  return { ...simpleDefaults(), ...patch };
}

function node(workflow: Record<string, SimpleWorkflowNode>, id: string): SimpleWorkflowNode {
  const found = workflow[id];
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

describe('validateSimpleConfig', () => {
  it('errors when no model is selected', () => {
    expect(validateSimpleConfig(simpleDefaults())).toContain("Model");
  });

  it('flux/anima missing VAE or CLIP reports the matching field; checkpoint external VAE may be blank', () => {
    const flux = { ...simpleDefaults('flux'), model: 'flux1-dev.safetensors' };
    expect(validateSimpleConfig(flux)).toContain('VAE');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors' })).toContain('T5-XXL');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors' })).toContain('CLIP-L');
    expect(
      validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors', clip2: 'clip_l.safetensors' }),
    ).toBeNull();

    const anima = { ...simpleDefaults('anima'), model: 'anima.safetensors', vae: 'qwen_image_vae.safetensors' };
    expect(validateSimpleConfig(anima)).toContain('Qwen');
    expect(validateSimpleConfig({ ...anima, clip1: 'qwen_2.5_vl_7b.safetensors' })).toBeNull();

    expect(validateSimpleConfig(config({ model: 'illustrious.safetensors' }))).toBeNull();
  });
});

describe('buildSimpleWorkflow - checkpoint', () => {
  const simple = config({ model: 'illustrious_xl.safetensors', positive: 'masterpiece, best quality', negative: 'worst quality' });

  it('builds the classic five-node chain, positive/negative joined as fixed + generated', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '1').inputs.ckpt_name).toBe('illustrious_xl.safetensors');
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('worst quality, extra people');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, '6').inputs).toMatchObject({
      seed: 42,
      steps: 28,
      cfg: 5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
    });
    // No external VAE → use the checkpoint's built-in one (slot 2)
    expect(node(wf, '7').inputs.vae).toEqual(['1', 2]);
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('when nl exists it takes precedence over tag as the positive generated content', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, nl: 'A girl with silver hair.' });
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, A girl with silver hair.');
  });

  it('blank fixed words leave only generated content (no extra commas)', () => {
    const wf = buildSimpleWorkflow(config({ model: 'm.safetensors' }), VALUES);
    expect(node(wf, '3').inputs.text).toBe('1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('');
  });

  it('external VAE goes through VAELoader; LoRAs chain between the base model and encoding', () => {
    const wf = buildSimpleWorkflow(
      config({
        model: 'm.safetensors',
        vae: 'fix_vae.safetensors',
        loras: [
          { name: 'style.safetensors', strength: 0.8 },
          { name: '', strength: 1 }, // Unfinished rows are ignored
          { name: 'detail.safetensors', strength: 0.5 },
        ],
      }),
      VALUES,
    );
    expect(node(wf, '2').class_type).toBe('VAELoader');
    expect(node(wf, '7').inputs.vae).toEqual(['2', 0]);
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'detail.safetensors', model: ['300', 0], clip: ['300', 1] });
    expect(node(wf, '6').inputs.model).toEqual(['301', 0]);
    expect(node(wf, '3').inputs.clip).toEqual(['301', 1]);
    expect(wf['302']).toBeUndefined();
  });
});

describe('buildSimpleWorkflow - flux', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('flux'),
    model: 'flux1-dev.safetensors',
    vae: 'ae.safetensors',
    clip1: 't5xxl_fp8.safetensors',
    clip2: 'clip_l.safetensors',
  };

  it('UNet + DualCLIP + ae, negative always empty, cfg always 1, via FluxGuidance', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'ignored' });
    expect(node(wf, '1').class_type).toBe('UNETLoader');
    expect(node(wf, '2').inputs).toMatchObject({ clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' });
    expect(node(wf, '5').inputs.text).toBe('');
    expect(node(wf, '6').inputs).toMatchObject({ guidance: 3.5, conditioning: ['4', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ cfg: 1, positive: ['6', 0], negative: ['5', 0] });
    expect(node(wf, '7').class_type).toBe('EmptySD3LatentImage');
  });

  it('guidance = 1 skips FluxGuidance and connects the encoding output directly', () => {
    const wf = buildSimpleWorkflow({ ...simple, guidance: 1 }, VALUES);
    expect(wf['6']).toBeUndefined();
    expect(node(wf, '8').inputs.positive).toEqual(['4', 0]);
  });

  it('GGUF uses UnetLoaderGGUF; LoRAs only attach to model (LoraLoaderModelOnly)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, gguf: true, loras: [{ name: 'flux_lora.safetensors', strength: 1 }] },
      VALUES,
    );
    expect(node(wf, '1').class_type).toBe('UnetLoaderGGUF');
    expect(node(wf, '300').class_type).toBe('LoraLoaderModelOnly');
    expect(node(wf, '300').inputs).not.toHaveProperty('clip');
    expect(node(wf, '8').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima'),
    model: 'anima_pencil.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_2.5_vl_7b.safetensors',
  };

  it('CLIPLoader uses the qwen_image type, and the model passes through ModelSamplingAuraFlow (adjustable shift)', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'blurry' });
    expect(node(wf, '2').inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image' });
    expect(node(wf, '6').inputs).toMatchObject({ shift: 3, model: ['1', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ model: ['6', 0], cfg: 4 });
    expect(node(wf, '5').inputs.text).toBe('blurry');
  });

  it('the LoRA chain end connects into AuraFlow, not the sampler', () => {
    const wf = buildSimpleWorkflow({ ...simple, loras: [{ name: 'a.safetensors', strength: 1 }] }, VALUES);
    expect(node(wf, '6').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - size', () => {
  it('errors on invalid size (the simple-mode canvas node is always built, with no exemption for a workflow with hardcoded size)', () => {
    const simple = config({ model: 'm.safetensors' });
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, width: 0 })).toThrow('landscape sizes');
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, height: 0 })).toThrow('landscape sizes');
  });
});

describe('normalizeSimpleConfig', () => {
  it('empty input gets checkpoint defaults', () => {
    expect(normalizeSimpleConfig(undefined)).toEqual(simpleDefaults());
  });

  it('invalid template falls back to checkpoint; dirty fields reset item by item', () => {
    const normalized = normalizeSimpleConfig({
      template: 'qwen-whatever',
      model: 42,
      steps: 'not a number',
      loras: [{ name: 'a.safetensors', strength: '0.7' }, null, 'junk'],
    });
    expect(normalized.template).toBe('checkpoint');
    expect(normalized.model).toBe('');
    expect(normalized.steps).toBe(28);
    expect(normalized.loras).toEqual([
      { name: 'a.safetensors', strength: 0.7 },
      { name: '', strength: 1 },
      { name: '', strength: 1 },
    ]);
  });

  it('sampling parameters of a valid template fall back to that template defaults', () => {
    expect(normalizeSimpleConfig({ template: 'flux' })).toEqual(simpleDefaults('flux'));
    expect(normalizeSimpleConfig({ template: 'anima' }).shift).toBe(3);
  });
});

describe('templateSupportsNegative', () => {
  it('flux has no real negative input; the others do', () => {
    expect(templateSupportsNegative('flux')).toBe(false);
    expect(templateSupportsNegative('checkpoint')).toBe(true);
    expect(templateSupportsNegative('anima')).toBe(true);
  });
});
