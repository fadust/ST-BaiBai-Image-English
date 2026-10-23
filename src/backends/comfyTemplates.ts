/**
 * ComfyUI simple mode: pick models/LoRA + fill basic parameters, and the plugin assembles the preset into an API workflow.
 *
 * Mutually exclusive with custom mode (pasted API JSON + %placeholders%): a preset is one or the other, and generation forks in
 * generateComfyImage in comfyui.ts. The meeting point is "have a submittable JSON";
 * queueing/polling/cancelling after that is fully shared.
 *
 * Templates are grouped by model architecture rather than "one workflow for everything": loader nodes,
 * latent types and negative-prompt support all differ between architectures, and forcing them together would mean special cases everywhere.
 * Scope is deliberately narrow: checkpoint family (SD1.5/SDXL/Pony/Illustrious), Flux, Anima (Qwen chain).
 * Chroma, video families and others not seen in real use are not supported; a new architecture = one data entry in COMFY_TEMPLATES + one assembly branch.
 *
 * This module deliberately does not import settings/comfyui: settings.ts needs the types and default factories here,
 * and comfyui.ts needs the assembler, so a reverse dependency would create a cycle. Errors are plain Errors with user-facing messages,
 * wrapped into ComfyUIError by comfyui.ts.
 */

import type { GenerationParams } from '@/generationMeta';

/** Node reference: [node id, output slot]. */
type NodeRef = [string, number];

// type rather than interface: interfaces have no implicit index signature and can't be assigned to ComfyWorkflow (Record<string, JsonObject>) in comfyui.ts
export type SimpleWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type SimpleWorkflow = Record<string, SimpleWorkflowNode>;

export type ComfyPresetMode = 'custom' | 'simple';

export type ComfySimpleTemplateId = 'checkpoint' | 'flux' | 'anima';

export interface ComfyLoraEntry {
  /** LoRA file name (relative to models/loras). */
  name: string;
  /** Strength; the checkpoint template applies it to both model and clip, Flux/Anima to model only. */
  strength: number;
}

/**
 * One set of simple-mode parameters. Every field has a default (guaranteed by normalize),
 * so assembly only checks existence, such as whether a model/VAE/CLIP was selected.
 */
export interface ComfySimpleConfig {
  template: ComfySimpleTemplateId;
  /** checkpoint template = ckpt file name; flux/anima = diffusion_models file name. */
  model: string;
  /** flux/anima with a GGUF model selected → loaded with UnetLoaderGGUF. */
  gguf: boolean;
  /** External VAE file name; empty for the checkpoint template = use the model's built-in VAE; required for flux/anima. */
  vae: string;
  /** flux: t5xxl; anima: qwen_2.5_vl; unused by checkpoint. */
  clip1: string;
  /** flux: clip_l; unused by other templates. */
  clip2: string;
  loras: ComfyLoraEntry[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** flux only: FluxGuidance strength; 1 = skip the node (wire the encoder output directly). */
  guidance: number;
  /** anima only: shift for ModelSamplingAuraFlow. */
  shift: number;
  /** Fixed positive, placed before the AI-generated content. */
  positive: string;
  /** Fixed negative; the AI's dynamic negative is appended after it. */
  negative: string;
}

export interface ComfyTemplateMeta {
  id: ComfySimpleTemplateId;
  label: string;
  /** Which file list the model field draws from. */
  modelKind: 'checkpoint' | 'unet';
  modelLabel: string;
  vaeRequired: boolean;
  vaeLabel: string;
  /** Placeholder for the VAE input (meaning of blank/recommended file name). */
  vaePlaceholder: string;
  /** CLIP files the user must choose; empty for checkpoint since it is built in. */
  clips: { key: 'clip1' | 'clip2'; label: string }[];
  /** Whether a real negative input exists (Flux negative is always empty, so no dynamic negative is requested from the AI). */
  supportsNegative: boolean;
  /** Default frame sizes for simple mode (written into a new preset's portrait/landscape sizes). */
  portraitSize: string;
  landscapeSize: string;
  defaults: {
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    guidance: number;
    shift: number;
  };
}

export const COMFY_TEMPLATES: Record<ComfySimpleTemplateId, ComfyTemplateMeta> = {
  checkpoint: {
    id: 'checkpoint',
    label: 'Checkpoint series (SD1.5/SDXL/Pony/Illustrious)',
    modelKind: 'checkpoint',
    modelLabel: 'Model',
    vaeRequired: false,
    vaeLabel: 'VAE',
    vaePlaceholder: 'Can be left blank to use model built-in',
    clips: [],
    supportsNegative: true,
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', guidance: 1, shift: 3 },
  },
  flux: {
    id: 'flux',
    label: 'Flux series',
    modelKind: 'unet',
    modelLabel: 'Model',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'ae.safetensors',
    clips: [
      { key: 'clip1', label: 'T5-XXL' },
      { key: 'clip2', label: 'CLIP-L' },
    ],
    supportsNegative: false,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', guidance: 3.5, shift: 3 },
  },
  anima: {
    id: 'anima',
    label: 'Anima series (Qwen link)',
    modelKind: 'unet',
    modelLabel: 'Model',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'qwen_image_vae.safetensors',
    clips: [{ key: 'clip1', label: 'Qwen2.5-VL' }],
    supportsNegative: true,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 28, cfg: 4, sampler: 'euler', scheduler: 'simple', guidance: 1, shift: 3 },
  },
};

export const COMFY_TEMPLATE_OPTIONS = (Object.keys(COMFY_TEMPLATES) as ComfySimpleTemplateId[]).map(id => ({
  value: id,
  label: COMFY_TEMPLATES[id].label,
}));

export function isComfyTemplateId(value: unknown): value is ComfySimpleTemplateId {
  return typeof value === 'string' && value in COMFY_TEMPLATES;
}

export function templateSupportsNegative(id: ComfySimpleTemplateId): boolean {
  return COMFY_TEMPLATES[id].supportsNegative;
}

/** Simple-mode defaults for a new preset: sampling parameters from the template's recommendations, the rest left blank to choose. */
export function simpleDefaults(template: ComfySimpleTemplateId = 'checkpoint'): ComfySimpleConfig {
  const meta = COMFY_TEMPLATES[template];
  return {
    template,
    model: '',
    gguf: false,
    vae: '',
    clip1: '',
    clip2: '',
    loras: [],
    steps: meta.defaults.steps,
    cfg: meta.defaults.cfg,
    sampler: meta.defaults.sampler,
    scheduler: meta.defaults.scheduler,
    guidance: meta.defaults.guidance,
    shift: meta.defaults.shift,
    positive: '',
    negative: '',
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Cleans field by field; an invalid template falls back to checkpoint. LoRA rows with an empty name are kept (blank rows being edited in the UI) and ignored at assembly. */
export function normalizeSimpleConfig(raw: unknown): ComfySimpleConfig {
  const o = (raw ?? {}) as Partial<ComfySimpleConfig>;
  const template = isComfyTemplateId(o.template) ? o.template : 'checkpoint';
  const base = simpleDefaults(template);
  return {
    template,
    model: asText(o.model),
    gguf: o.gguf === true,
    vae: asText(o.vae),
    clip1: asText(o.clip1),
    clip2: asText(o.clip2),
    loras: Array.isArray(o.loras)
      ? o.loras.map(entry => ({
          name: asText((entry as Partial<ComfyLoraEntry> | null)?.name),
          strength: asNumber((entry as Partial<ComfyLoraEntry> | null)?.strength, 1),
        }))
      : [],
    steps: Math.max(1, Math.round(asNumber(o.steps, base.steps))),
    cfg: asNumber(o.cfg, base.cfg),
    sampler: asText(o.sampler) || base.sampler,
    scheduler: asText(o.scheduler) || base.scheduler,
    guidance: asNumber(o.guidance, base.guidance),
    shift: asNumber(o.shift, base.shift),
    positive: asText(o.positive),
    negative: asText(o.negative),
  };
}

/**
 * Pre-generation validation; null = ready to generate, otherwise a user-facing reason.
 * The panel's status pill and the assembler share the same rules, avoiding "the panel says valid but generation errors".
 */
export function validateSimpleConfig(simple: ComfySimpleConfig): string | null {
  const meta = COMFY_TEMPLATES[simple.template] ?? COMFY_TEMPLATES.checkpoint;
  if (!simple.model.trim()) return `Please select${meta.modelLabel}`;
  if (meta.vaeRequired && !simple.vae.trim()) return `Please select ${meta.vaeLabel}`;
  for (const clip of meta.clips) {
    if (!simple[clip.key].trim()) return `Please select ${clip.label}`;
  }
  return null;
}

/** Assembly input: same source as the placeholder system, just without macro substitution. */
export interface SimpleGenValues {
  /** Positive tags generated by the AI. */
  prompt: string;
  /** Natural language generated by the AI (only when the preset has "Generate Natural Language" on); in simple mode it takes precedence over tags. */
  nl?: string;
  /** Dynamic negative tags generated by the AI. */
  negative?: string;
  seed: number;
  width: number;
  height: number;
}

/** Joins non-empty fragments with commas. */
function joinParts(...parts: (string | undefined)[]): string {
  return parts.map(part => (part ?? '').trim()).filter(Boolean).join(', ');
}

/**
 * Positive = fixed positive + generated content; the generated content prefers nl when present (Flux/Anima take natural language),
 * falling back to short tags otherwise. The toggle lives on the preset, so users decide how templates and toggles combine.
 */
export function composePositive(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return joinParts(simple.positive, (values.nl ?? '').trim() || values.prompt);
}

/** Negative = fixed negative + the AI's dynamic negative appended. */
export function composeNegative(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return joinParts(simple.negative, values.negative);
}

/**
 * Sampling-parameter snapshot for simple mode (recorded with the image). Only the scalars needed for display;
 * the full text of the fixed positive/negative goes into meta directly via composePositive/Negative.
 */
export function comfySimpleParams(simple: ComfySimpleConfig): GenerationParams {
  const loras = simple.loras
    .filter(lora => lora.name.trim())
    .map(lora => `${lora.name.trim()}×${lora.strength}`)
    .join(', ');
  return {
    mode: 'simple',
    template: simple.template,
    baseModel: simple.model,
    vae: simple.vae,
    clips: [simple.clip1, simple.clip2].filter(Boolean).join(', '),
    loras,
    sampler: simple.sampler,
    scheduler: simple.scheduler,
    steps: simple.steps,
    cfg: simple.cfg,
    guidance: simple.guidance,
    shift: simple.shift,
  };
}

/**
 * LoRA chain: starts from the base model (and clip) and chains each one, returning a reference to the chain's end.
 * checkpoint uses LoraLoader (model+clip, two heads); Flux/Anima LoRAs only attach to the UNet (LoraLoaderModelOnly).
 * Rows with an empty name are unfinished in the UI and ignored.
 */
function applyLoras(
  nodes: SimpleWorkflow,
  loras: ComfyLoraEntry[],
  modelOnly: boolean,
  startModel: NodeRef,
  startClip: NodeRef | null,
): { model: NodeRef; clip: NodeRef | null } {
  let model = startModel;
  let clip = startClip;
  loras
    .filter(lora => lora.name.trim())
    .forEach((lora, index) => {
      const id = `30${index}`;
      if (modelOnly) {
        nodes[id] = {
          class_type: 'LoraLoaderModelOnly',
          inputs: { lora_name: lora.name.trim(), strength_model: lora.strength, model },
        };
        model = [id, 0];
      } else {
        nodes[id] = {
          class_type: 'LoraLoader',
          inputs: {
            lora_name: lora.name.trim(),
            strength_model: lora.strength,
            strength_clip: lora.strength,
            model,
            clip: clip!,
          },
        };
        model = [id, 0];
        clip = [id, 1];
      }
    });
  return { model, clip };
}

function unetLoader(simple: ComfySimpleConfig): SimpleWorkflowNode {
  return simple.gguf
    ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: simple.model.trim() } }
    : { class_type: 'UNETLoader', inputs: { unet_name: simple.model.trim(), weight_dtype: 'default' } };
}

function saveNode(images: NodeRef): SimpleWorkflowNode {
  return { class_type: 'SaveImage', inputs: { filename_prefix: 'BaiBai', images } };
}

function buildCheckpointWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: simple.model.trim() } };
  const externalVae = simple.vae.trim();
  if (externalVae) nodes['2'] = { class_type: 'VAELoader', inputs: { vae_name: externalVae } };

  const chain = applyLoras(nodes, simple.loras, false, ['1', 0], ['1', 1]);

  nodes['3'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: chain.clip },
  };
  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: chain.clip },
  };
  nodes['5'] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['6'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: chain.model,
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['5', 0],
    },
  };
  nodes['7'] = {
    class_type: 'VAEDecode',
    inputs: { samples: ['6', 0], vae: externalVae ? ['2', 0] : ['1', 2] },
  };
  nodes['8'] = saveNode(['7', 0]);
  return nodes;
}

function buildFluxWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'DualCLIPLoader',
    inputs: { clip_name1: simple.clip1.trim(), clip_name2: simple.clip2.trim(), type: 'flux' },
  };
  nodes['3'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: ['2', 0] },
  };
  // Flux is a distilled model: negative always empty, cfg always 1, guidance via FluxGuidance
  nodes['5'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } };
  let positive: NodeRef = ['4', 0];
  if (simple.guidance !== 1) {
    nodes['6'] = { class_type: 'FluxGuidance', inputs: { guidance: simple.guidance, conditioning: ['4', 0] } };
    positive = ['6', 0];
  }
  nodes['7'] = {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['8'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: 1,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: chain.model,
      positive,
      negative: ['5', 0],
      latent_image: ['7', 0],
    },
  };
  nodes['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
  nodes['10'] = saveNode(['9', 0]);
  return nodes;
}

function buildAnimaWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'CLIPLoader',
    inputs: { clip_name: simple.clip1.trim(), type: 'qwen_image' },
  };
  nodes['3'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: ['2', 0] },
  };
  nodes['5'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: ['2', 0] },
  };
  nodes['6'] = {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { shift: simple.shift, model: chain.model },
  };
  nodes['7'] = {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['8'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: ['6', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['7', 0],
    },
  };
  nodes['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
  nodes['10'] = saveNode(['9', 0]);
  return nodes;
}

/**
 * Assembles a simple-mode preset into a submittable API workflow (pure function).
 * Runs validateSimpleConfig first, with the same rules as the panel; size problems are also reported here
 * (custom mode means "no size check if the workflow doesn't use %width%"; in simple mode the canvas node is always built, so there is no exemption).
 */
export function buildSimpleWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const invalid = validateSimpleConfig(simple);
  if (invalid) throw new Error(invalid);
  if (!(values.width > 0) || !(values.height > 0)) {
    throw new Error('Please fill in the vertical and horizontal screen dimensions on the ComfyUI channel page (such as 832×1216)');
  }
  switch (simple.template) {
    case 'flux':
      return buildFluxWorkflow(simple, values);
    case 'anima':
      return buildAnimaWorkflow(simple, values);
    default:
      return buildCheckpointWorkflow(simple, values);
  }
}
