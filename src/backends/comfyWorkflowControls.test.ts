import { describe, expect, it } from 'vitest';
import { updateWorkflowField, workflowControls } from './comfyWorkflowControls';

function mossWorkflow(): string {
  const stack = (model: [string, number], clip: [string, number], names: string[], strengths: number[]) => ({
    class_type: 'Lora Loader Stack (rgthree)',
    inputs: Object.fromEntries([
      ['model', model], ['clip', clip],
      ...names.flatMap((name, index) => [[`lora_0${index + 1}`, name], [`strength_0${index + 1}`, strengths[index]]]),
    ]),
  });
  return JSON.stringify({
    '198': { class_type: 'CLIPLoader', inputs: { clip_name: 'text-encoder.safetensors', type: 'qwen_image' } },
    '252': { class_type: 'UNETLoader', inputs: { unet_name: 'moss.safetensors', weight_dtype: 'default' } },
    '215': stack(['252', 0], ['198', 0], ['turbo.safetensors', 'detail.safetensors', 'realism.safetensors', 'style.safetensors'], [0.7, 5, -1.75, 0.2]),
    '245': stack(['215', 0], ['215', 1], ['anime.safetensors', 'None', 'None', 'None'], [0.8, 0, 0, 0]),
    '195': { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 12, cfg: 1.7, sampler_name: 'res_3s', scheduler: 'simple', model: ['259', 0], positive: ['74', 0], negative: ['239', 0], latent_image: ['262', 0], denoise: 1 } },
    '259': { class_type: 'SkipLayerGuidanceDiT', inputs: { scale: 3, model: ['245', 0] } },
    '248': { class_type: 'PrimitiveStringMultiline', inputs: { value: '%prompt%\n%nl%' } },
    '262': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
  });
}

describe('custom workflow generation controls', () => {
  it('reads the model, sampler, scheduler, steps, CFG, and six usable slots across two rgthree stacks', () => {
    const controls = workflowControls(mossWorkflow());
    expect(controls.models[0]).toMatchObject({ node: '252', input: 'unet_name', value: 'moss.safetensors', kind: 'unet' });
    expect(controls.loras).toHaveLength(8);
    expect(controls.loras.slice(0, 6).map(slot => slot.name.value)).toEqual(['turbo.safetensors', 'detail.safetensors', 'realism.safetensors', 'style.safetensors', 'anime.safetensors', 'None']);
    expect(controls.loras[2].strength.value).toBe(-1.75);
    expect(controls.sampling[0]).toMatchObject({ steps: { value: 12 }, cfg: { value: 1.7 }, sampler: { value: 'res_3s' }, scheduler: { value: 'simple' } });
  });
  it('updates the sixth LoRA and its strength without changing graph wiring, placeholders, or other LoRA values', () => {
    const original = mossWorkflow();
    const controls = workflowControls(original);
    let edited = updateWorkflowField(original, controls.loras[5].name, 'extra.safetensors');
    edited = updateWorkflowField(edited, controls.loras[5].strength, -2.5);
    const expected = JSON.parse(original);
    expected['245'].inputs.lora_02 = 'extra.safetensors';
    expected['245'].inputs.strength_02 = -2.5;
    expect(JSON.parse(edited)).toEqual(expected);
    expect(JSON.parse(original)['245'].inputs.lora_02).toBe('None');
  });
  it('lets model and sampling controls edit exactly their existing fields', () => {
    const original = mossWorkflow();
    const controls = workflowControls(original);
    let edited = updateWorkflowField(original, controls.models[0], 'other-moss.safetensors');
    edited = updateWorkflowField(edited, controls.sampling[0].steps!, 20);
    edited = updateWorkflowField(edited, controls.sampling[0].cfg!, 2.3);
    edited = updateWorkflowField(edited, controls.sampling[0].sampler!, 'euler');
    edited = updateWorkflowField(edited, controls.sampling[0].scheduler!, 'beta');
    const expected = JSON.parse(original);
    expected['252'].inputs.unet_name = 'other-moss.safetensors';
    Object.assign(expected['195'].inputs, { steps: 20, cfg: 2.3, sampler_name: 'euler', scheduler: 'beta' });
    expect(JSON.parse(edited)).toEqual(expected);
  });
  it('supports standard LoRA loaders and updates their model/CLIP strengths together on an explicit strength edit', () => {
    const text = JSON.stringify({ '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } }, '2': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 0.7, strength_clip: 0.4, model: ['1', 0], clip: ['1', 1] } } });
    const controls = workflowControls(text);
    expect(controls.models[0].kind).toBe('checkpoint');
    expect(JSON.parse(updateWorkflowField(text, controls.loras[0].strength, 0.9))['2'].inputs).toMatchObject({ strength_model: 0.9, strength_clip: 0.9 });
    expect(JSON.parse(updateWorkflowField(text, controls.loras[0].name, 'other.safetensors'))['2'].inputs.strength_clip).toBe(0.4);
  });
  it('preserves linked parameter inputs rather than replacing graph connections', () => {
    const data = JSON.parse(mossWorkflow()); data['195'].inputs.steps = ['10', 0];
    const controls = workflowControls(JSON.stringify(data));
    expect(controls.sampling[0].steps).toBeUndefined();
    expect(() => updateWorkflowField(JSON.stringify(data), { node: '195', input: 'steps', value: 12 }, 20)).toThrow('field changed');
  });
  it('rejects invalid numeric edits without creating a new workflow value', () => {
    const text = mossWorkflow(); const sampler = workflowControls(text).sampling[0];
    expect(() => updateWorkflowField(text, sampler.steps!, 0)).toThrow('positive whole number');
    expect(() => updateWorkflowField(text, sampler.steps!, 2.5)).toThrow('positive whole number');
    expect(() => updateWorkflowField(text, sampler.cfg!, NaN)).toThrow('valid number');
    expect(() => updateWorkflowField(text, sampler.cfg!, -1)).toThrow('negative');
  });
});
