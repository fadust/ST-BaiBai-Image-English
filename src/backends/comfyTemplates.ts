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

export type ComfySimpleTemplateId = 'checkpoint' | 'flux' | 'anima' | 'moss' | 'moss-anime';

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
   * 新建预设预填的固定正面(与 defaultNegative 同一套写法)。
   *
   * 两条 MOSS 线必须填:那条线的画质串/画风串**只能**由固定正面承担(规范明令 AI 不许写
   * 画质词与画风词),留空则整条链路没人承担底子且全程没有报错。
   * 其余模板留空:它们的 AI 生成内容本来就带着质量词(见 aiProvidesStyle)。
   */
  defaultPositive: string;
  /**
   * negativeRequired 时新建预设预填的默认串。写实线与动漫线的负面不是同一份:
   * 动漫线不能带 text / logo(会把画面内文字一起压掉),要带 3d / shiny hair(防插画滑向 3D)。
   */
  defaultNegative: string;
  /**
   * AI 生成的内容里是否**自带**画质词/画风词(checkpoint / flux / anima 的 tag 流就是这种:
   * AI 那侧本来就会写质量词、写画风),此时固定正面空着只是「少一层加固」。
   *
   * MOSS 两条线相反:规范把画质词与画风词**从 AI 那侧拿走了**,固定正面是唯一承担者。
   * 故这个标记的真正用途只有一个 —— 让 simpleConfigWarnings 只对「没人兜底」的模板告警,
   * 不对 checkpoint/flux/anima 误报。它**不参与校验**,也永远不拦出图。
   */
  aiProvidesStyle: boolean;
  /**
   * 采样器被底模锁死(null = 用户自选)。MOSS 官方 SFT 口径是 euler,换别的不是报错而是画质明显劣化,
   * 面板据此禁用选择框——比事后解释「为什么出图变糊」便宜。
   */
  samplerFixed: string | null;
  /**
   * SkipLayerGuidanceDiTSimple 参数;null = 不建该节点。
   *
   * 只有动漫线要它:官方 SFT 底模本身不带二次元审美,靠「画风 LoRA + 单层跳层引导」一起拉出来。
   * 写实线不加 —— 加了对胶片质感是反效果(细节被抹平)。
   */
  slg: { singleLayers: string; startPercent: number; endPercent: number } | null;
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

/**
 * MOSS 动漫线的默认固定负面(动漫线专用口径,自 story-image 的 `moss-anime` 线)。
 *
 * 与写实线那份的两处硬差别:
 * 1. **去掉 `text` / `logo`**:动漫线这条底模擅长画面内文字(海报标题、气泡台词),
 *    带着这两个词会把要画的字一起压掉 —— 不想要字时正面不写「要字」即可。
 * 2. **加 `3d` / `shiny hair`**:动漫线要的是平面插画的质感,3D 渲染感和
 *    塑料高光头发是这条线最常见的走形方向。
 * 另有 `missing fingers` / `extra toes` / `bad feet` / `artistic error` / `signature` / `username`
 * 六条是动漫姿态(手指、脚趾、签名角标)特有的翻车点,写实线那份不需要。
 */
export const MOSS_ANIME_DEFAULT_NEGATIVE =
  '3d, worst quality, low quality, bad anatomy, bad hands, extra fingers, missing fingers, ' +
  'extra toes, bad feet, fused limbs, extra limbs, lowres, blurry, jpeg artifacts, ' +
  'watermark, signature, username, artistic error, shiny hair, plastic skin';

/**
 * MOSS 写实线的默认固定正面(画质串)。新建预设预填,面板「填入默认正面」一键写回同一串。
 *
 * 取值不是自拟:规范 src/state/settings.ts 的 DEFAULT_MOSS_SPEC「二、tag」那一条把画质词的归属
 * 写死了 ——「画质串由渠道预设的『固定正面』承担(moodyrealism, photorealistic, photograph,
 * high detail, sharp focus, natural skin texture)。tag 里**不要**再写 masterpiece / best quality」。
 * 也就是说这条线上**AI 那一侧被明令禁止写画质词**,固定正面是唯一承担者:它空着不是
 * 「少一层加固」,是画质词彻底缺位且全程零报错 —— 正是本常量要堵的口子。
 *
 * 与 {@link MOSS_DEFAULT_NEGATIVE} 的关系(逐条对过,不是随手拼的):
 * - `natural skin texture` vs 负面 `plastic skin` / `waxy skin` / `overly smooth skin` /
 *   `excessive skin retouching`:这几对是**同一根轴的两头**,不是自相矛盾 —— 与
 *   `high detail` vs `blurry`、`sharp focus` vs `blurry` 同理,CFG 下正负两边各自加码,
 *   出来的才是「有纹理但不糙」的那一段。真正的自相矛盾是正面也要求光滑
 *   (`smooth skin` / `airbrushed` / `flawless`),那才会和负面互相抵消,故本串一个都没有,
 *   **也不要**往里加。
 * - `sharp focus` vs 负面 `oversharpening`:前者说焦点落在哪儿,后者说边缘过冲的锐化光晕,两回事。
 * - 规范禁的「皮肤反光词」(glossy / shiny / oily / greasy):本串写的是纹理(natural skin
 *   texture),不是油光,一个反光词都没进串。
 * - 规范禁的「拍摄介质参数词」(HDR / 计算摄影 / 高分辨率):`photograph` 是介质名词
 *   (这一张是照片而不是插画),不是参数词;那三个参数词也一个都没进串。
 *
 * 想换质感就整串替换(例如不要胶片味就去掉 moodyrealism),但别把它清空 ——
 * 清空了出图仍然会照常进行,只是画质基线没人承担(simpleConfigWarnings 会提示,不拦)。
 */
export const MOSS_DEFAULT_POSITIVE =
  'moodyrealism, photorealistic, photograph, high detail, sharp focus, natural skin texture';

/**
 * MOSS 动漫线的默认固定正面(画风层两句)。
 *
 * 取值照抄 story-image 工作区 moss-anime 配置集的「### 画风层」一节(2026-11-02 定稿:
 * 「这一段固定收尾,每张都写这两句,整套照抄,不要自己改写」):一句整体上色/线/材质,
 * 一句脸部单独刻画。柏宝绘这条线的规范(DEFAULT_MOSS_ANIME_SPEC「二、tag」)写的是
 * 「这条线的画风由渠道预设的『固定正面』承担,**你不要写任何画风词**」,且这条线的负面里
 * **没有** text / logo(要留画面内文字)—— 所以这两句是这条线唯一的画风承担者,
 * 空着等于让底模自己猜审美(会把二次元脸推回照片)。
 *
 * `sonsp` 是画风 LoRA(Sonsp_Moss_Style_v2 @0.8)的触发词,必须留在串里;
 * 但不要写成 `<lora:…>` 语法 —— LoRA 由简易模式的 LoRA 链挂载,不是串里的语法。
 *
 * 与 {@link MOSS_ANIME_DEFAULT_NEGATIVE} 的两处近似冲突,逐条对过:
 * - 负面 `3d`:针对三维渲染感;正面的「厚涂的笔触感」是平面绘画的笔触,不是 3D。
 * - 负面 `shiny hair`:针对整片塑料高光;正面的「头发一缕一缕分出高光与暗部」是结构分层,
 *   不是高光糊成一片。
 * 另外**不要**自己补「韩漫/赛璐璐/日式动画」这类风格名:story-image 同一节的实测结论是
 * 加了反而会把 sonsp 的画风拽歪。
 */
export const MOSS_ANIME_DEFAULT_POSITIVE =
  '画面是 sonsp 那样的二次元插画（a 2D anime illustration），光影通透、明暗层次分明、有厚涂的笔触感；' +
  '上色通透精致，色块边界干净，暗部里再压一层冷色，皮肤透出淡淡的血色，头发一缕一缕分出高光与暗部，' +
  '布料有清楚的织纹和褶皱阴影，线条细而精、轮廓干净利落，人体曲线画得修长好看。' +
  '人物脸部单独精细刻画：眼白、虹膜、瞳孔和睫毛分开画，眼睑分出层次，脸颊透出淡淡的血色，' +
  '唇上带一层薄薄的高光，鼻尖与下颌的转折干净利落，光先落在脸上、眼睛里点出细小的反光。';

export const COMFY_TEMPLATES: Record<ComfySimpleTemplateId, ComfyTemplateMeta> = {
  checkpoint: {
    id: 'checkpoint',
    label: 'Checkpoint family (SD1.5/SDXL/Pony/Illustrious)',
    modelKind: 'checkpoint',
    modelLabel: 'Model',
    vaeRequired: false,
    vaeLabel: 'VAE',
    vaePlaceholder: '可留空,用模型内置',
    clips: [],
    supportsNegative: true,
    negativeRequired: false,
    defaultNegative: '',
    // 空着出生是对的:checkpoint 的 tag 流本来就是 AI 自己写质量词(masterpiece / best quality)。
    defaultPositive: '',
    aiProvidesStyle: true,
    samplerFixed: null,
    slg: null,
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', guidance: 1, shift: 3 },
  },
  flux: {
    id: 'flux',
    label: 'Flux family',
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
    negativeRequired: false,
    defaultNegative: '',
    defaultPositive: '',
    aiProvidesStyle: true,
    samplerFixed: null,
    slg: null,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', guidance: 3.5, shift: 3 },
  },
  anima: {
    id: 'anima',
    label: 'Anima family (Qwen path)',
    modelKind: 'unet',
    modelLabel: 'Model',
    vaeRequired: true,
    vaeLabel: 'VAE',
    vaePlaceholder: 'qwen_image_vae.safetensors',
    clips: [{ key: 'clip1', label: 'Qwen2.5-VL' }],
    supportsNegative: true,
    negativeRequired: false,
    defaultNegative: '',
    defaultPositive: '',
    aiProvidesStyle: true,
    samplerFixed: null,
    slg: null,
    portraitSize: '1024×1024',
    landscapeSize: '1344×768',
    defaults: { steps: 28, cfg: 4, sampler: 'euler', scheduler: 'simple', guidance: 1, shift: 3 },
  },
  moss: {
    id: 'moss',
    label: 'MOSS-Image realistic',
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
    defaultNegative: MOSS_DEFAULT_NEGATIVE,
    // 画质串的唯一承担者:规范禁止 AI 写画质词,tag 里再写 masterpiece 会把照片推回插画。
    defaultPositive: MOSS_DEFAULT_POSITIVE,
    aiProvidesStyle: false,
    // 官方 SFT 口径就是 euler + sgm_uniform,换采样器不是「个人口味」而是画质劣化。
    samplerFixed: 'euler',
    // 写实线不叠跳层引导:那是动漫线拉出二次元骨相的手段,对胶片/皮肤质感是反效果。
    slg: null,
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 30, cfg: 3.5, sampler: 'euler', scheduler: 'sgm_uniform', guidance: 1, shift: 3 },
  },
  'moss-anime': {
    id: 'moss-anime',
    // 底模与写实线同一份权重;差别全在「叠什么 LoRA、串怎么写」,故 label 要点明这一点。
    label: 'MOSS-Image anime (needs style LoRA)',
    modelKind: 'unet',
    modelLabel: 'MOSS 底模',
    vaeRequired: true,
    vaeLabel: 'VAE(flux2)',
    vaePlaceholder: 'flux2-vae_small.safetensors',
    clips: [{ key: 'clip1', label: 'CLIP(Qwen3.5 9B)' }],
    supportsNegative: true,
    // 底模不带二次元审美,崩手/崩脚/3D 感全靠这条收边,空着同样会走形。
    negativeRequired: true,
    defaultNegative: MOSS_ANIME_DEFAULT_NEGATIVE,
    // 画风层的唯一承担者:规范禁止 AI 写任何画风词,负面里也没有 text/logo(要画面内文字)。
    defaultPositive: MOSS_ANIME_DEFAULT_POSITIVE,
    aiProvidesStyle: false,
    samplerFixed: 'euler',
    // 单层 22、前 50% 生效 —— 与 story-image 的 moss-anime 线同口径。
    slg: { singleLayers: '22', startPercent: 0, endPercent: 0.5 },
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    defaults: { steps: 30, cfg: 3.5, sampler: 'euler', scheduler: 'sgm_uniform', guidance: 1, shift: 3 },
  },
};

export const COMFY_TEMPLATE_OPTIONS = (Object.keys(COMFY_TEMPLATES) as ComfySimpleTemplateId[]).map(id => ({
  value: id,
  label: COMFY_TEMPLATES[id].label,
}));

export function isComfyTemplateId(value: unknown): value is ComfySimpleTemplateId {
  return typeof value === 'string' && value in COMFY_TEMPLATES;
}

/**
 * 这条模板是不是「MOSS 系」——它决定提示词规范方言、串联写法与负面策略,
 * 而不是由用户手点的那份下拉决定。
 *
 * 写实线与动漫线是同一份底模、两套审美:规范、负面、画风层全不同,所以两条各自成族。
 */
export function isMossTemplate(id: ComfySimpleTemplateId): boolean {
  return id === 'moss' || id === 'moss-anime';
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
    // 默认正面与默认负面同一口径:填好**该模板自己的**那一份(写实线是画质串、动漫线是画风层),
    // 用户仍可整串替换或清空。MOSS 线上这不是加固而是必需品 —— 画质/画风词只活在这条串里。
    positive: meta.defaultPositive,
    // 必填固定负面的模板,新建时就填好**该模板自己的**默认串(写实线与动漫线不是同一份),
    // 让「选完模型点出图」这条路不被一条校验拦下;用户仍可整串替换。
    negative: meta.negativeRequired ? meta.defaultNegative : '',
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
    // 与下面 negative 同一口径(两条串共用一个归一规则,别再分叉):
    // 字段**缺失**(老数据/新键)才用模板默认值;显式空串是用户自己清掉的,原样保留。
    // 为什么不能「空串也回填默认值」:老用户既存预设里存的就是 positive: '' —— 升级后当场把它
    // 改成默认正面,等于替用户改了他一直在用的串,而他再也看不出自己清过、也调不回来。
    // 为什么空着也不报错:那正是 simpleConfigWarnings 存在的理由(见下),不是这里漏了。
    positive: typeof o.positive === 'string' ? o.positive : base.positive,
    negative: typeof o.negative === 'string' ? o.negative : base.negative,
  };
}

/**
 * 出图前校验;返回 null = 可出图,否则是给用户看的中文原因。
 * 面板的状态药丸与组装器共用同一口径,避免「面板说有效、出图才报错」。
 */
export function validateSimpleConfig(simple: ComfySimpleConfig): string | null {
  const meta = COMFY_TEMPLATES[simple.template] ?? COMFY_TEMPLATES.checkpoint;
  if (!simple.model.trim()) return `Please select ${meta.modelLabel}`;
  if (meta.vaeRequired && !simple.vae.trim()) return `Please select ${meta.vaeLabel}`;
  for (const clip of meta.clips) {
    if (!simple[clip.key].trim()) return `Please select ${clip.label}`;
  }
  // 必填固定负面:空着不是「没配好」而是「一定糊」——MOSS 方言已关掉 AI 动态负面,
  // 这条空串等于整条链路一个负面词都没有。拦在这里比让用户出一批走形图再排查便宜。
  if (meta.negativeRequired && !simple.negative.trim()) {
    return `${meta.label} 必须填写固定负面（可点「填入默认负面」一键填好）`;
  }
  // 注意:这里**故意不校验**固定正面。空正面不会让请求失败,只是画质基线没人承担;
  // 把「效果差」升格成「不能出图」会锁死老用户(他们的既存预设存的正是 positive:'')。
  // 正面缺失走的是下面 simpleConfigWarnings 那条非阻断通道,两条通道互不相交。
  return null;
}

/**
 * **非阻断**告警:固定正面空着、而该模板的 AI 那侧又不写画质/画风词时,给一句能照着做的提示。
 * 返回 null = 无需提示。**永远不拦出图**,也不参与 validateSimpleConfig 的判定。
 *
 * 为什么不写进 validateSimpleConfig:
 * 1. 老用户既存预设里存的就是显式空串(normalizeSimpleConfig 原样保留,那是用户的权利),
 *    一升级就被校验拦下 = 把整条出图链锁死,而他要的可能只是「这次先不写画质串」。
 * 2. 空正面**不会让请求失败**:ComfyUI 照常出图,只是画质基线缺位。拿更重的手段
 *    (报错拦住)去解决更轻的问题(效果差)不划算。
 * 故只给一行中文提示:面板显示在状态药丸附近,不弹窗、不阻塞。
 *
 * 判据是 meta.aiProvidesStyle 而不是模板 id:AI 那侧自带画质/画风词的模板
 * (checkpoint / flux / anima 的 tag 流)固定正面空着只是少一层加固,不提示;
 * 只有两条 MOSS 线(规范禁止 AI 写画质词与画风词)才提示。
 */
export function simpleConfigWarnings(simple: ComfySimpleConfig): string | null {
  const meta = COMFY_TEMPLATES[simple.template] ?? COMFY_TEMPLATES.checkpoint;
  if (meta.aiProvidesStyle) return null;
  if (simple.positive.trim()) return null;
  const fill = meta.id === 'moss-anime' ? '画风层' : '画质串';
  return (
    `${meta.label} 的固定正面是空的：这条线的${fill}只能由固定正面承担（规范禁止 AI 自己写），` +
    '空着出图不会报错，但画质基线没人兜底。点「填入默认正面」一键填好。'
  );
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
  if (isMossTemplate(simple.template)) {
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
 * MOSS-Image 族(写实线 + 动漫线,官方 SFT int8 口径)。
 *
 * 两条线的加载链完全相同,差别只在**模型链上叠什么**:
 * - 写实线:底模 → LoRA 链 → KSampler;
 * - 动漫线:底模 → SkipLayerGuidanceDiTSimple(单层 22 / 前 50%)→ 画风 LoRA → KSampler。
 *   官方 SFT 本身不带二次元审美,单靠 LoRA 拉出来会「形似而骨相不对」,那层跳层引导
 *   是把它从写实骨相掰成动画骨相的关键;顺序也不能反(LoRA 必须挂在 SLG 之后,
 *   否则画风权重会被 SLG 的层跳过一起改掉)。
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

  // 跳层引导(仅动漫线):插在底模之后、LoRA 之前。节点 id 用 20,和 applyLoras 的 30x 不撞。
  let modelRef: NodeRef = ['1', 0];
  const slg = COMFY_TEMPLATES[simple.template].slg;
  if (slg) {
    nodes['20'] = {
      class_type: 'SkipLayerGuidanceDiTSimple',
      inputs: {
        model: modelRef,
        double_layers: '',
        single_layers: slg.singleLayers,
        start_percent: slg.startPercent,
        end_percent: slg.endPercent,
      },
    };
    modelRef = ['20', 0];
  }

  const chain = applyLoras(nodes, simple.loras, true, modelRef, null);

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
    case 'moss-anime':
      return buildMossWorkflow(simple, values);
    default:
      return buildCheckpointWorkflow(simple, values);
  }
}
