/**
 * ComfyUI 简易模式:选模型/LoRA + 填基础参数,插件把预设组装成 API 工作流。
 *
 * 与自定义模式(粘贴 API JSON + %占位符%)互斥:预设二选一,出图时在
 * comfyui.ts 的 generateComfyImage 里分叉,汇合点是「拿到可提交的 JSON」,
 * 之后的排队/轮询/取消完全共用。
 *
 * 模板按模型架构分族,不做「一个工作流打天下」——不同架构的加载节点、
 * latent 类型、负面词支持都不一样,硬揉在一起只会处处是特例。
 * 范围刻意收敛:checkpoint 系(SD1.5/SDXL/Pony/Illustrious)、Flux、Anima(Qwen 链路)。
 * Chroma/视频系等不见实际使用的一律不做,新架构 = 在 COMFY_TEMPLATES 加一条数据 + 一个组装分支。
 *
 * 本模块刻意不 import settings/comfyui:settings.ts 要拿这里的类型与默认值工厂,
 * comfyui.ts 要拿组装器,反向依赖会成环。错误用带中文信息的普通 Error,
 * 由 comfyui.ts 包成 ComfyUIError。
 */

import type { GenerationParams } from '@/generationMeta';

/** 节点引用:[节点 id, 输出槽位]。 */
type NodeRef = [string, number];

// 用 type 而非 interface:接口没有隐式索引签名,赋不进 comfyui.ts 的 ComfyWorkflow(Record<string, JsonObject>)
export type SimpleWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type SimpleWorkflow = Record<string, SimpleWorkflowNode>;

export type ComfyPresetMode = 'custom' | 'simple';

export type ComfySimpleTemplateId = 'checkpoint' | 'flux' | 'anima' | 'moss';

export interface ComfyLoraEntry {
  /** LoRA 文件名(相对 models/loras)。 */
  name: string;
  /** 强度;checkpoint 模板同时作用于 model 与 clip,Flux/Anima 只作用于 model。 */
  strength: number;
}

/**
 * 一套简易模式参数。全部字段都有默认值(normalize 保证),
 * 出图组装时只做「选没选模型/VAE/CLIP」这种存在性校验。
 */
export interface ComfySimpleConfig {
  template: ComfySimpleTemplateId;
  /** checkpoint 模板 = ckpt 文件名;flux/anima = diffusion_models 文件名。 */
  model: string;
  /** flux/anima 选了 GGUF 格式的模型 → 用 UnetLoaderGGUF 加载。 */
  gguf: boolean;
  /** 外置 VAE 文件名;checkpoint 模板留空 = 用模型内置 VAE,flux/anima 必填。 */
  vae: string;
  /** flux: t5xxl;anima: qwen_2.5_vl;checkpoint 不用。 */
  clip1: string;
  /** flux: clip_l;其余模板不用。 */
  clip2: string;
  loras: ComfyLoraEntry[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** flux 专用:FluxGuidance 强度;1 = 跳过该节点(直连编码输出)。 */
  guidance: number;
  /** anima 专用:ModelSamplingAuraFlow 的 shift。 */
  shift: number;
  /** 固定正面,拼在 AI 生成内容之前。 */
  positive: string;
  /** 固定负面,AI 动态负面追加在后。 */
  negative: string;
}

export interface ComfyTemplateMeta {
  id: ComfySimpleTemplateId;
  label: string;
  /** 模型字段来自哪个文件列表。 */
  modelKind: 'checkpoint' | 'unet';
  modelLabel: string;
  vaeRequired: boolean;
  vaeLabel: string;
  /** VAE 输入框 placeholder(留空语义/推荐文件名)。 */
  vaePlaceholder: string;
  /** 需要用户选择的 CLIP 文件;checkpoint 内置故为空。 */
  clips: { key: 'clip1' | 'clip2'; label: string }[];
  /** 是否有真实负面输入(Flux 负面恒空,故也不请求 AI 动态负面词)。 */
  supportsNegative: boolean;
  /**
   * 固定负面是**必填**的:该底模的题材基线(画质/解剖/水印那套)只有预设里这条固定负面能承担,
   * 空着出图必然走形。validateSimpleConfig 据此报错拦住,而不是让用户出一批糊图才发现。
   * 与 supportsNegative 正交:那是「有没有负面输入通道」,这是「通道里必须有东西」。
   */
  negativeRequired: boolean;
  /**
   * 采样器被底模锁死(null = 用户自选)。MOSS 官方 SFT 口径是 euler,换别的不是报错而是画质明显劣化,
   * 面板据此禁用选择框——比事后解释「为什么出图变糊」便宜。
   */
  samplerFixed: string | null;
  /** 简易模式画幅默认尺寸(写入新预设的横竖尺寸)。 */
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
    label: 'Checkpoint 系(SD1.5/SDXL/Pony/Illustrious)',
    modelKind: 'checkpoint',
    modelLabel: '模型',
    vaeRequired: false,
    vaeLabel: 'VAE',
    vaePlaceholder: '可留空,用模型内置',
    clips: [],
    supportsNegative: true,
    negativeRequired: false,
    samplerFixed: null,
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', guidance: 1, shift: 3 },
  },
  flux: {
    id: 'flux',
    label: 'Flux 系',
    modelKind: 'unet',
    modelLabel: '模型',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'ae.safetensors',
    clips: [
      { key: 'clip1', label: 'T5-XXL' },
      { key: 'clip2', label: 'CLIP-L' },
    ],
    supportsNegative: false,
    negativeRequired: false,
    samplerFixed: null,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', guidance: 3.5, shift: 3 },
  },
  anima: {
    id: 'anima',
    label: 'Anima 系(Qwen 链路)',
    modelKind: 'unet',
    modelLabel: '模型',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'qwen_image_vae.safetensors',
    clips: [{ key: 'clip1', label: 'Qwen2.5-VL' }],
    supportsNegative: true,
    negativeRequired: false,
    samplerFixed: null,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 28, cfg: 4, sampler: 'euler', scheduler: 'simple', guidance: 1, shift: 3 },
  },
  moss: {
    id: 'moss',
    label: 'MOSS-Image 写实',
    modelKind: 'unet',
    modelLabel: 'MOSS 底模',
    vaeRequired: true,
    // MOSS 的 VAE 是 flux2 系(128 通道),不能用 SD 的 ae.safetensors;留空的语义在这里不存在。
    vaeLabel: 'VAE(flux2)',
    vaePlaceholder: 'flux2-vae_small.safetensors',
    // 文本编码器是 Qwen3.5 9B,CLIPLoader 的 type 必须是 moss_image(见 buildMossWorkflow)。
    clips: [{ key: 'clip1', label: 'CLIP(Qwen3.5 9B)' }],
    supportsNegative: true,
    // MOSS 线的画质/解剖/水印基线只活在固定负面里,AI 那侧被方言关掉了动态负面(见 SpecDialect)。
    negativeRequired: true,
    // 官方 SFT 口径就是 euler + sgm_uniform,换采样器不是「个人口味」而是画质劣化。
    samplerFixed: 'euler',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 30, cfg: 3.5, sampler: 'euler', scheduler: 'sgm_uniform', guidance: 1, shift: 3 },
  },
};

/**
 * MOSS 线的默认固定负面(官方 16 条 + 本机补 4 条)。
 *
 * 为什么必填:MOSS 方言下 autoTag 不请求 AI 动态负面(见 SpecDialect 的 moss 分支),
 * 串里那点题材级负面全靠这一条兜底。补的四条各有来由 —— `western face`/`caucasian`
 * 防欧美脸(底模的英文先验会把东亚角色画成白人)、`fused bodies`/`deformed genitals`
 * 防多人贴合处粘连与器官走形,都是实测最容易翻车的两处。
 */
export const MOSS_DEFAULT_NEGATIVE =
  'worst quality, low quality, bad anatomy, deformed hands, extra fingers, malformed limbs, ' +
  'distorted face, plastic skin, overly smooth skin, waxy skin, oversharpening, ' +
  'excessive skin retouching, blurry, jpeg artifacts, watermark, text, logo, ' +
  'western face, caucasian, fused bodies, deformed genitals';

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

/** 新预设的简易模式默认值:采样参数取模板推荐,其余留空待选。 */
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
    // MOSS 的固定负面是必填项(meta.negativeRequired),新建时就填好默认值,
    // 让「选完模型点出图」这条路不被一条校验拦下;用户仍可整串替换。
    negative: meta.negativeRequired ? MOSS_DEFAULT_NEGATIVE : '',
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 逐字段清洗;template 非法回 checkpoint。loras 里名字为空的行保留(UI 正在编辑的空行),组装时忽略。 */
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
    // 字段**缺失**(老数据/新键)才用模板默认值;显式空串是用户自己清掉的,原样保留。
    // 这条区分对 MOSS 有意义:它的默认负面是必填项,但用户仍有权整串删掉再自己写。
    negative: typeof o.negative === 'string' ? o.negative : base.negative,
  };
}

/**
 * 出图前校验;返回 null = 可出图,否则是给用户看的中文原因。
 * 面板的状态药丸与组装器共用同一口径,避免「面板说有效、出图才报错」。
 */
export function validateSimpleConfig(simple: ComfySimpleConfig): string | null {
  const meta = COMFY_TEMPLATES[simple.template] ?? COMFY_TEMPLATES.checkpoint;
  if (!simple.model.trim()) return `请选择${meta.modelLabel}`;
  if (meta.vaeRequired && !simple.vae.trim()) return `请选择 ${meta.vaeLabel}`;
  for (const clip of meta.clips) {
    if (!simple[clip.key].trim()) return `请选择 ${clip.label}`;
  }
  // 必填固定负面:空着不是「没配好」而是「一定糊」——MOSS 方言已关掉 AI 动态负面,
  // 这条空串等于整条链路一个负面词都没有。拦在这里比让用户出一批走形图再排查便宜。
  if (meta.negativeRequired && !simple.negative.trim()) {
    return `${meta.label} 必须填写固定负面（可点「填入默认负面」一键填好）`;
  }
  return null;
}

/** 组装入参:与占位符体系同源,只是不走宏替换。 */
export interface SimpleGenValues {
  /** AI 生成的正向 tag。 */
  prompt: string;
  /**
   * 角色的**中文外貌**段落(插件机械拼接,不来自 AI)。见 composePositive 的说明:
   * 只在 moss 模板下并入正向——其余模板的文本编码器对中文几乎无响应,拼了只是噪声。
   */
  appearance?: string;
  /** AI 生成的自然语言(预设开启「生成自然语言」时才有);简易模式下优先于 tag。 */
  nl?: string;
  /** AI 生成的动态负面 tag。 */
  negative?: string;
  seed: number;
  width: number;
  height: number;
}

/** 逗号拼接非空片段。 */
function joinParts(...parts: (string | undefined)[]): string {
  return parts.map(part => (part ?? '').trim()).filter(Boolean).join(', ');
}

/**
 * 正向 = 固定正面 + 生成内容;生成内容有 nl 优先用 nl(Flux/Anima 吃自然语言),
 * 没有才退回短 tag。开关在预设上,用户自己决定模板与开关的搭配。
 *
 * MOSS 模板额外并进两段:
 * - tag 行(values.prompt):MOSS 方言下 nl 恒非空,按旧口径 tag 会被整个丢掉,
 *   而人数、景别、人种这些承重墙只写在 tag 里。故 moss 走「tag + nl」全留。
 * - 中文外貌(values.appearance):角色库那七个字段是英文 tag、只能进 tag,
 *   中文外貌没处可去;由 state/charTags 的 chineseAppearanceForText 认人后
 *   原样拼在 nl 之后,不参与任何 tag/nl 抉择。
 * 其余模板不动:它们的文本编码器对中文几乎无响应,拼进去只是噪声。
 */
export function composePositive(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  const nl = (values.nl ?? '').trim();
  if (simple.template === 'moss') {
    return joinParts(simple.positive, values.prompt, nl, values.appearance);
  }
  return joinParts(simple.positive, nl || values.prompt);
}

/** 负面 = 固定负面 + AI 动态负面追加。 */
export function composeNegative(simple: ComfySimpleConfig, values: SimpleGenValues): string {
  return joinParts(simple.negative, values.negative);
}

/**
 * 简易模式的采样参数快照(供随图记录)。只收展示需要的标量;
 * 固定正/负面的实际全文由 composePositive/Negative 直接进 meta。
 */
export function comfySimpleParams(simple: ComfySimpleConfig): GenerationParams {
  const loras = simple.loras
    .filter(lora => lora.name.trim())
    .map(lora => `${lora.name.trim()}×${lora.strength}`)
    .join('、');
  return {
    mode: 'simple',
    template: simple.template,
    baseModel: simple.model,
    vae: simple.vae,
    clips: [simple.clip1, simple.clip2].filter(Boolean).join('、'),
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
 * LoRA 链:从底模(与 clip)出发逐个串联,返回链尾引用。
 * checkpoint 用 LoraLoader(model+clip 双头);Flux/Anima 的 LoRA 只挂在 UNet 上(LoraLoaderModelOnly)。
 * 名字为空的行是 UI 里没填完的,忽略。
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
  // Flux 是蒸馏模型:负面恒空,cfg 恒 1,guidance 走 FluxGuidance
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
 * MOSS-Image 写实线(官方 SFT int8 口径)。
 *
 * 三个与其它模板族**不通用**的地方,照抄 flux/anima 的组装器会直接跑不通:
 * 1. CLIPLoader 的 `type` 必须是 `moss_image`——文本编码器是 Qwen3.5 9B 的 MOSS 定制版,
 *    按 flux(qwen_image 那套双编码器)加载会报类型不匹配;
 * 2. latent 必须是 **EmptyFlux2LatentImage**:MOSS 指定 flux2 VAE(128 通道),
 *    EmptySD3LatentImage / EmptyLatentImage 出的是 4/16 通道,进 VAE 时通道数对不上;
 * 3. LoRA 只挂 UNet(LoraLoaderModelOnly):MOSS 工作流里的 LoRA 都是画风/器官向,
 *    没有配套的文本编码器权重,挂双头那版会在 clip 侧报缺文件。
 *
 * 采样器被 meta.samplerFixed 锁在 euler,故这里直接取 simple.sampler(面板已禁用改它)。
 */
function buildMossWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const nodes: SimpleWorkflow = {};
  nodes['1'] = unetLoader(simple);
  nodes['2'] = {
    class_type: 'CLIPLoader',
    inputs: { clip_name: simple.clip1.trim(), type: 'moss_image', device: 'default' },
  };
  nodes['3'] = { class_type: 'VAELoader', inputs: { vae_name: simple.vae.trim() } };

  const chain = applyLoras(nodes, simple.loras, true, ['1', 0], null);

  // 正向固定段(画质串)由 composePositive 拼在 AI 内容之前 —— MOSS 的画质基线在预设的 positive 里。
  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composePositive(simple, values), clip: ['2', 0] },
  };
  nodes['5'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: composeNegative(simple, values), clip: ['2', 0] },
  };
  nodes['6'] = {
    class_type: 'EmptyFlux2LatentImage',
    inputs: { width: values.width, height: values.height, batch_size: 1 },
  };
  nodes['7'] = {
    class_type: 'KSampler',
    inputs: {
      seed: values.seed,
      steps: simple.steps,
      cfg: simple.cfg,
      sampler_name: simple.sampler,
      scheduler: simple.scheduler,
      denoise: 1,
      model: chain.model,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  };
  nodes['8'] = { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } };
  nodes['9'] = saveNode(['8', 0]);
  return nodes;
}

/**
 * 把简易模式预设组装成可提交的 API 工作流(纯函数)。
 * 先跑与面板同口径的 validateSimpleConfig;尺寸异常也在这里报
 * (自定义模式是「工作流没用 %width% 就不查尺寸」,简易模式画布节点是必建的,没有豁免)。
 */
export function buildSimpleWorkflow(simple: ComfySimpleConfig, values: SimpleGenValues): SimpleWorkflow {
  const invalid = validateSimpleConfig(simple);
  if (invalid) throw new Error(invalid);
  if (!(values.width > 0) || !(values.height > 0)) {
    throw new Error('请在 ComfyUI 渠道页填写竖屏与横屏尺寸（如 832×1216）');
  }
  switch (simple.template) {
    case 'flux':
      return buildFluxWorkflow(simple, values);
    case 'anima':
      return buildAnimaWorkflow(simple, values);
    case 'moss':
      return buildMossWorkflow(simple, values);
    default:
      return buildCheckpointWorkflow(simple, values);
  }
}
