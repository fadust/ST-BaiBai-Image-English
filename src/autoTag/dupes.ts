/**
 * 跨层重复项闸(layer dupes)—— 四层拼成一条之前,先查它们有没有互相复述。
 *
 * 为什么需要它:柏宝绘的正向串由 composePositive(backends/comfyTemplates.ts) 拼成一条
 * —— 固定正面 + tag + nl + 中文外貌。四层各有职责(tag 锁骨架 / 中文散文写画面 /
 * 英文身体段锁解剖 / 中文外貌保一致),但**没有任何代码在检查这四层有没有写同一件事**。
 * 规范自己在 state/settings.ts 里写过:同一条信息两层各写一遍 = 叠两层权重,
 * 模型为了同时满足两层会擅自改机位。那句话是散文,本模块把它变成判据。
 *
 * 只做**高置信、误判代价低**的几类(宁可漏判,不要误杀):
 *   1. race-duplicated    —— tag 写了 chinese / east asian,nl 又写「中国人」/「a Chinese woman」;
 *   2. age-duplicated     —— tag 写了 twenty years old,nl 又写「二十岁」/「of twenty」;
 *   3. garment-duplicated —— tag 写了 white + camisole,nl 又写「白吊带」(颜色与品类**同时**命中才算);
 *   4. missing-exclusion  —— 中文外貌段里的名字在 tag / nl 里根本没出现,这一段是空转的。
 *
 * 判定只读文本、不看剧情,所以误判的方向永远是「太严」;故本模块**不做任何阻断**:
 * 与 shotspec 同一条纪律 —— 它是一面镜子,不是闸门(见下面的 auditLayers)。
 *
 * 纯函数、无 IO、不 import settings / charTags:判定与调用方分离,单测可直接跑。
 */

export type LayerIssueLevel = 'block' | 'warn';

export interface LayerIssue {
  code: string;
  level: LayerIssueLevel;
  message: string;
  fix: string;
}

/** 一张图交给判定用的三个字段(与 composePositive 的四层一一对应,固定正面不参与)。 */
export interface LayerInput {
  /** AI 生成的英文 tag 行 —— 承重墙(人数/景别/机位/人种/年龄/服装)都在这里。 */
  tag?: string;
  /** AI 生成的 nl:既有中文散文段,也有英文身体段。 */
  nl?: string;
  /** 插件机械拼进来的中文外貌段(形如「林夏:鹅蛋脸… 苏曼:圆脸…」)。 */
  appearance?: string;
  /**
   * 判定范围。'tag' = 只做**不依赖其它层**的判定(目前是 tag 自身的年龄冲突),
   * 由 generate 链路使用 —— 那条链路里 appearance 是下游现算的(LayerInput 注释见 runner.ts
   * 的 508-511),而 tag 自身的矛盾与它无关,不该因为握手不上就一起放过。
   */
  only?: 'tag';
}

/** 一手数据来自模型:任何非字符串一律当空,绝不让类型噪声变成异常。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只转义词表里真会出现的元字符;词表是固定的一小张表,不需要通用转义。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?()^$|\\]/g, '\\$&');
}

/** 整词匹配(前后不能紧贴字母/数字):chinese 不该在 chinesestyle 里命中。 */
function hasWord(haystack: string, word: string): boolean {
  if (!word) return false;
  const pattern = new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(word.toLowerCase()) + '(?:[^a-z0-9]|$)');
  return pattern.test(haystack);
}

/** 按出现位置取第一个**整词**命中的候选(给 tag 侧的英文锚点用)。 */
function firstWordOf(haystack: string, candidates: readonly string[]): string | undefined {
  let hit: string | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!hasWord(haystack, candidate)) continue;
    const at = haystack.indexOf(candidate);
    if (at >= 0 && at < best) {
      best = at;
      hit = candidate;
    }
  }
  return hit;
}

function firstOf(haystack: string, candidates: readonly string[]): string | undefined {
  let hit: string | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const at = haystack.indexOf(candidate);
    if (at >= 0 && at < best) {
      best = at;
      hit = candidate;
    }
  }
  return hit;
}

/**
 * tag 里的人种锚点。只收**明确的族裔 tag**:写成 chinese 就足以按英文先验把脸拉到东亚
 * (MOSS 写实线规范的原话)。这张表同时也是「nl 里不该再出现什么」的对照面。
 */
const TAG_RACE_ANCHORS: readonly string[] = [
  'chinese',
  'east asian',
  'japanese',
  'korean',
  'taiwanese',
  'hongkonger',
  'southeast asian',
];

/**
 * nl 里的中文人种词。**故意只收带「人/女/男/面孔」等指人后缀的写法**,不收裸的「中国」「日本」——
 * 「中国城」「日本料理」是地点不是人种,拿裸词去判就是误杀。
 */
const NL_RACE_ZH: readonly string[] = [
  '中国人',
  '中国女人',
  '中国女孩',
  '中国姑娘',
  '中国女子',
  '中国男人',
  '中国男孩',
  '中国面孔',
  '东亚人',
  '东亚面孔',
  '东亚女孩',
  '日本女人',
  '日本女孩',
  '日本人',
  '韩国人',
  '韩国女人',
  '韩国女孩',
  '华人',
  '亚裔',
];

/** nl 里的英文人种写法:规范点名的那一句也正是 She is a Chinese woman of twenty。 */
const NL_RACE_EN =
  /(?:^|[^a-z])(?:a|an|the)?\s*(?:chinese|japanese|korean|east asian|taiwanese)\s+(?:woman|man|girl|boy|female|male|person|people)\b/i;

/** tag 里的年龄锚点:twenty years old / 18 years old 这类。 */
const TAG_AGE_ANCHOR =
  /\b(?:eighteen|nineteen|twenty(?:[\s-](?:one|two|three|four|five))?|thirty|forty|\d{1,3})[\s-]*years?[\s-]*old\b/i;

/** nl 里的中文年龄:二十岁 / 二十三岁 / 18 岁。 */
const NL_AGE_ZH = /(?:[零一二三四五六七八九十百两]{1,4}|\d{1,3})\s*岁/;

/** nl 里的英文年龄:规范给的句式 of twenty,以及 aged twenty / twenty-year-old。 */
const NL_AGE_EN =
  /\b(?:of|aged|turning)\s+(?:eighteen|nineteen|twenty(?:[\s-](?:one|two|three))?|thirty)\b|\b(?:eighteen|nineteen|twenty|thirty)[\s-]years?[\s-]*old\b/i;

interface ColorDef {
  /** tag 里的英文写法(整词命中)。 */
  en: readonly string[];
  /** nl 里的中文颜色字。 */
  zh: string;
}

const COLOR_TABLE: readonly ColorDef[] = [
  { en: ['white'], zh: '白' },
  { en: ['black'], zh: '黑' },
  { en: ['grey', 'gray'], zh: '灰' },
  { en: ['red'], zh: '红' },
  { en: ['blue'], zh: '蓝' },
  { en: ['navy'], zh: '藏青' },
  { en: ['beige'], zh: '米' },
  { en: ['pink'], zh: '粉' },
  { en: ['green'], zh: '绿' },
  { en: ['yellow'], zh: '黄' },
  { en: ['brown'], zh: '棕' },
];

interface GarmentDef {
  en: readonly string[];
  zh: readonly string[];
}

/** 品类表:只收**中英一一对应、中文写法不歧义**的品类。长写法排在前面,免得「裙」吃掉「连衣裙」。 */
const GARMENT_TABLE: readonly GarmentDef[] = [
  { en: ['dress'], zh: ['连衣裙', '半身裙', '长裙', '短裙', '裙'] },
  { en: ['camisole'], zh: ['吊带'] },
  { en: ['shirt'], zh: ['衬衫', '衬衣'] },
  { en: ['t-shirt', 'tshirt'], zh: ['T恤', '体恤'] },
  { en: ['shorts'], zh: ['短裤'] },
  { en: ['jeans'], zh: ['牛仔裤'] },
  { en: ['coat'], zh: ['大衣', '外套'] },
  { en: ['sweater'], zh: ['毛衣'] },
  { en: ['hoodie'], zh: ['卫衣'] },
  { en: ['uniform'], zh: ['校服', '制服'] },
  { en: ['swimsuit', 'bikini'], zh: ['泳衣', '比基尼'] },
  { en: ['stockings', 'tights'], zh: ['丝袜'] },
  { en: ['socks'], zh: ['袜子'] },
];

function zhGarmentPattern(def: GarmentDef): string {
  const aliases = [...def.zh].sort((left, right) => right.length - left.length).map(escapeRegExp);
  return '(?:' + aliases.join('|') + ')';
}

function raceIssue(tag: string, nl: string): LayerIssue | undefined {
  const anchor = firstWordOf(tag, TAG_RACE_ANCHORS);
  if (!anchor) return undefined;
  const zhHit = firstOf(nl, NL_RACE_ZH);
  const enHit = NL_RACE_EN.exec(nl)?.[0]?.trim();
  const evidence = zhHit ?? enHit;
  if (!evidence) return undefined;
  return {
    code: 'race-duplicated',
    level: 'block',
    message:
      'Ethnicity is already in the tag (' + anchor + ') and repeated in nl ("' + evidence + '").' +
      ' Writing the same fact twice stacks weight; the model may shift the camera to satisfy both.',
    fix:
      'Write ethnicity once, in the tag (chinese / east asian); do not restate it in any nl segment — ' +
      'including English body prose such as "a Chinese woman".',
  };
}

function ageIssue(tag: string, nl: string): LayerIssue | undefined {
  const anchor = TAG_AGE_ANCHOR.exec(tag)?.[0];
  if (!anchor) return undefined;
  const zhHit = NL_AGE_ZH.exec(nl)?.[0];
  const enHit = NL_AGE_EN.exec(nl)?.[0];
  const evidence = zhHit ?? enHit;
  if (!evidence) return undefined;
  return {
    code: 'age-duplicated',
    level: 'block',
    message:
      'Age is already in the tag (' + anchor + ') and repeated in nl ("' + evidence + '").' +
      ' Two age layers do not improve accuracy; the model averages them into a third persona.',
    fix: 'Write age once, in the tag (twenty years old); do not restate age in Chinese or English nl.',
  };
}

/** tag 里的年龄写法(含 twenty-eight 这种连字符词形,TAG_AGE_ANCHOR 认不出它)。 */
const TAG_AGE_ANY =
  /\b(?:(?:eighteen|nineteen|twenty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirty|forty|fifty)|\d{1,3})[\s-]*years?[\s-]*old\b/gi;

/** tag 里的**笼统**年龄词:与具体年龄同时出现时,等于给了模型两个人设。 */
const TAG_AGE_VAGUE = /\b(?:young adult|middle[\s-]aged|teenager|teen|adult|elderly|child)\b/i;

const WORD_AGE: Record<string, number> = {
  eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23,
  'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28,
  'twenty-nine': 29, thirty: 30, forty: 40, fifty: 50,
};

/** 从任意文本里抠出一个年龄数字(`twenty-eight years old` / `18-year-old`)。 */
function parseAge(text: string): number | undefined {
  const digits = /\b(\d{1,3})[\s-]*years?[\s-]*old\b/i.exec(text);
  if (digits) return Number(digits[1]);
  const words = new RegExp(TAG_AGE_ANY.source, 'i').exec(text);
  if (!words) return undefined;
  const head = words[0]
    .toLowerCase()
    .replace(/[\s-]*years?[\s-]*old$/, '')
    .trim()
    .replace(/\s+/g, '-');
  return WORD_AGE[head] ?? WORD_AGE[head.replace(/-.*$/, '')];
}

/**
 * tag **内部**的年龄冲突:同一行里出现两个年龄。
 *
 * 跨层闸(ageIssue)只比对 tag 与 nl,**tag 自己矛盾它一律看不见** —— 而模型会把这个矛盾
 * 折中成一个不属于任何人的年龄,连带脸一起漂。两种真实形态:
 *   - 笼统词 + 具体年龄:`young adult` 与 `twenty-eight years old` 并排;
 *   - 两个不同的具体年龄。
 * `young adult` 这类词在底模里几乎没有信息量,只会稀释具体年龄。
 */
function tagAgeConflict(tag: string): LayerIssue | undefined {
  const numeric = [...new Set(
    [...tag.matchAll(new RegExp(TAG_AGE_ANY.source, 'gi'))].map(match => match[0].toLowerCase()),
  )];
  const vague = TAG_AGE_VAGUE.exec(tag)?.[0]?.toLowerCase();
  if (numeric.length > 1) {
    return {
      code: 'age-conflict',
      level: 'block',
      message: 'The same tag contains two different ages (' + numeric.join(' and ') + ').' +
        ' The model will average them into an age that belongs to nobody, and the face drifts with it.',
      fix: 'Keep one age in the tag ethnicity/age slot; write none in either nl segment.',
    };
  }
  if (vague && numeric.length === 1) {
    return {
      code: 'age-conflict',
      level: 'block',
      message: 'The same tag has a vague age word (' + vague + ') and a concrete age (' + numeric[0] + '):' +
        ' that is two personas, so the model can only average them.',
      fix: 'Drop the vague word and keep the concrete age — young adult / adult add almost no signal and only dilute.',
    };
  }
  return undefined;
}

/**
 * 机械修掉 tag 里的年龄冲突,**不交给模型重写**。
 *
 * 上一版把 age-conflict 做成硬闸(判失败 → 重试 → 让模型自己改):实测重试两次仍可能交出
 * 两个年龄,最后整条链路直接失败,用户拿不到图 —— 等于用一个**确定能修**的文本问题
 * 挡住了一次出图。修法本来就完全确定:删掉笼统词、多个具体年龄只留第一个。
 * 这是几行字符串操作,不该赌模型。
 *
 * 只动「独立成段」的成分:按逗号切段后**整段命中**才删,不做子串删除 ——
 * `young adult leaning forward` 这种一段里既有人又有年龄的,原样留着交给告警。
 */
export function repairTagAges(tag: string): { tag: string; removed: string[] } {
  const source = typeof tag === 'string' ? tag : '';
  if (!source.trim()) return { tag: source, removed: [] };

  const segments = source.split(',').map(part => part.trim()).filter(Boolean);
  const ageWords = /^(?:young adult|middle[\s-]aged|teenager|teen|adult|elderly|child)$/i;
  const drop = new Set<number>();
  const removed: string[] = [];

  // ① 多个具体年龄:保留第一个,其余删掉。
  const numericAt: number[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (new RegExp(TAG_AGE_ANY.source, 'i').test(segments[index])) numericAt.push(index);
  }
  for (const index of numericAt.slice(1)) {
    drop.add(index);
    removed.push(segments[index]);
  }

  // ② 笼统年龄词:只要有具体年龄在,它就是纯噪声(底模里几乎没信息量)。
  if (numericAt.length) {
    for (let index = 0; index < segments.length; index += 1) {
      if (!ageWords.test(segments[index])) continue;
      drop.add(index);
      removed.push(segments[index]);
    }
  }

  if (!drop.size) return { tag: source, removed: [] };
  return {
    tag: segments.filter((_, index) => !drop.has(index)).join(', '),
    removed,
  };
}

/**
 * 服装复述:**颜色与品类必须同时命中**才算一条。
 *
 * 只命中一件(只有颜色、只有品类)一律不算 —— 「她穿着裙子」跟在 white camisole 后面完全可能是在说
 * 另一件衣服,拿它报「重复」就是误杀。中文侧还要求颜色与品类相邻(不超过 3 个汉字间隔),
 * 避免「白衬衫的下摆垂在黑色的裙子上」被拼成一个不存在的「白裙」。
 */
function garmentIssues(tag: string, nl: string): LayerIssue[] {
  const issues: LayerIssue[] = [];
  const seen = new Set<string>();
  for (const color of COLOR_TABLE) {
    const colorAnchor = color.en.find(word => hasWord(tag, word));
    if (!colorAnchor) continue;
    for (const garment of GARMENT_TABLE) {
      const garmentAnchor = garment.en.find(word => hasWord(tag, word));
      if (!garmentAnchor) continue;
      const key = colorAnchor + '/' + garmentAnchor;
      if (seen.has(key)) continue;
      const pattern = new RegExp(
        escapeRegExp(color.zh) + '(?:色)?[\\u4e00-\\u9fff]{0,3}' + zhGarmentPattern(garment),
      );
      const hit = pattern.exec(nl)?.[0];
      if (!hit) continue;
      seen.add(key);
      issues.push({
        code: 'garment-duplicated',
        level: 'warn',
        message:
          'Garment (' + colorAnchor + ' ' + garmentAnchor + ') is already in the tag and repeated in nl ("' + hit + '").' +
          ' Two layers of the same outfit stack weight; the model often changes style or camera to satisfy both.',
        fix:
          'Once the tag names a garment, nl should only describe its state now (wind-lifted hem, open collar, pressed folds),' +
          ' not restate color and category.',
      });
    }
  }
  return issues;
}

/**
 * 中文外貌段是「插件认人后拼进去的」,认人的唯一锚是**名字在 tag / nl 里字面出现**。
 * 名字没出现 → 这一段不会被任何角色认领,白占一段权重,模型可能把它摊到画面里的别人身上。
 */
function appearanceIssues(tag: string, nl: string, appearance: string): LayerIssue[] {
  if (!appearance) return [];
  const haystack = tag + '\n' + nl;
  const issues: LayerIssue[] = [];

  // ① 外貌段与 tag/nl 的**内容**重复:人种 / 年龄 / 体型总述。
  //
  // 跨层闸原有的三条(race / age / garment)只比对 tag ↔ nl,外貌段是第四条层,
  // 一直没有参与比对 —— 而它恰恰是最大的一条(实测一条串里能占到 63% 字符)。
  // 外貌段里重写人种或年龄,等于把同一个人设叠成两层;模型不知道哪层说了算,脸就漂。
  // 只判**高置信、无歧义**的写法:人种要求带指人后缀(同 NL_RACE_ZH 的口径),
  // 年龄要求带 year/岁 且与 tag 那个数字**不同**(相同不算冲突,只是复述,降为提示)。
  const raceZh = firstOf(appearance, NL_RACE_ZH);
  const raceEn = NL_RACE_EN.exec(appearance)?.[0]?.trim();
  if (raceZh || raceEn) {
    issues.push({
      code: 'race-in-appearance',
      level: 'warn',
      message:
        'Ethnicity is repeated in the Chinese appearance segment ("' + (raceZh ?? raceEn) + '"). The tag already has chinese / east asian;' +
        ' restating it stacks the same constraint twice, and this layer is not AI-controlled so it cannot self-correct.',
      fix: 'Remove ethnicity words from the character-library Chinese appearance; keep features/hair/skin/build there and leave ethnicity to the tag.',
    });
  }
  const tagAge = parseAge(tag);
  const apAge = /(\d{1,3})[\s-]*(?:year|岁)/i.exec(appearance);
  if (tagAge !== undefined && apAge) {
    const apValue = Number(apAge[1]);
    if (apValue !== tagAge) {
      issues.push({
        code: 'age-in-appearance',
        level: 'block',
        message:
          'Age mismatch: the tag says ' + tagAge + ' and the Chinese appearance says ' + apValue + '.' +
          ' Both enter the positive prompt, so the model averages two ages — that is how the face drifts.',
        fix: 'Delete age from the library Chinese appearance (age belongs in the tag only), or align the tag age with the profile.',
      });
    }
  }
  const orphans: string[] = [];
  const pattern = /(?:^|\s)([^\s:：]{1,16})[:：]/g;
  for (let match = pattern.exec(appearance); match; match = pattern.exec(appearance)) {
    const name = match[1].trim();
    if (!name || orphans.includes(name)) continue;
    if (haystack.includes(name)) continue;
    orphans.push(name);
  }
  if (orphans.length) {
    issues.push({
      code: 'missing-exclusion',
      level: 'warn',
      message:
        'Chinese appearance names "' + orphans.join(', ') + '" but that name never appears in tag or nl:' +
        ' the segment is unclaimed weight the model may smear onto someone else (face drift).',
      fix: 'Put the character name in the tag or nl (names are the only recognition anchor), or remove the unused appearance from the library.',
    });
  }
  return issues;
}

/**
 * 逐层比对,返回这一张图的全部重复项。**永不抛错**:任何形态的脏输入(null、缺字段、
 * 非对象、非字符串)都当作空结论返回,原路径照走。
 */
export function findCrossLayerDuplicates(input: LayerInput = {}): LayerIssue[] {
  const source = (input && typeof input === 'object' ? input : {}) as LayerInput;
  const tag = text(source.tag).toLowerCase();
  const nl = text(source.nl);
  const appearance = text(source.appearance);
  const only = text(source.only);
  if (!tag && !nl) return [];
  const issues: LayerIssue[] = [];
  // 顺序 = 承重墙优先(人种 > 年龄 > 服装 > 外貌空转),与 shotspec 的「block 在前」同口径。
  const race = raceIssue(tag, nl);
  if (race) issues.push(race);
  const age = ageIssue(tag, nl);
  if (age) issues.push(age);
  // 只查 tag 自身矛盾时(调用方手里没有真正同源的外貌段),这里就给全量 —— 它不依赖任何其他层。
  const own = tagAgeConflict(tag);
  if (own) issues.push(own);
  if (only === 'tag') return issues;
  issues.push(...garmentIssues(tag, nl));
  issues.push(...appearanceIssues(tag, nl, appearance));
  return issues;
}

/** 生成链路里的一张图(只取判定用得上的字段,免得把协议类型拖进来)。 */
export interface AuditableLayerFrame {
  tag?: string;
  nl?: string;
  appearance?: string;
  /** 见 LayerInput.only:'tag' = 只做不依赖其它层的判定。 */
  only?: 'tag';
}

export interface LayerAudit {
  /** 图在本次输出里的序号(0-based)。 */
  index: number;
  issues: LayerIssue[];
  /** 是否存在 block 级问题 —— **只影响日志措辞,不影响任何流程分支**。 */
  hasBlocking: boolean;
}

/**
 * 逐张体检,但**永不抛错、永不返回失败**:这不是闸门,是一面镜子(同 shotspec 的 auditFrames)。
 *
 * 为什么不在这里拦:判定只读文本,误判方向永远是「太严」;拿一个可能太严的词表去掐断出图,
 * 比放过一张两层重复的图坏得多。故 level 在这里一律降级成一条可丢弃的文本结论,
 * 要不要用、写到哪里,由调用方定。
 */
export function auditLayers(frames: readonly AuditableLayerFrame[]): LayerAudit[] {
  if (!Array.isArray(frames)) return [];
  const audits: LayerAudit[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    try {
      const issues = findCrossLayerDuplicates({
        tag: frame?.tag,
        nl: frame?.nl,
        appearance: frame?.appearance,
      });
      audits.push({ index, issues, hasBlocking: issues.some(issue => issue.level === 'block') });
    } catch {
      // 判定本身出错(不该发生):当作这一张没有结论,绝不让它影响出图。
      audits.push({ index, issues: [], hasBlocking: false });
    }
  }
  return audits;
}

/** 一行中文结论;没有问题时返回空串(调用方据此不写空日志)。 */
export function formatLayerAudit(audit: LayerAudit | null | undefined): string {
  const issues = audit?.issues ?? [];
  if (!issues.length) return '';
  const head = 'Image ' + ((audit?.index ?? 0) + 1);
  const parts = issues.map(issue => {
    const label = issue.level === 'block' ? 'Duplicate conflict' : 'Duplicate note';
    const more = issue.fix ? ' → ' + issue.fix : '';
    return label + '[' + issue.code + '] ' + issue.message + more;
  });
  return head + ':' + parts.join(' | ');
}

/** 把一批结论拼成可写进日志/告警通道的多行文本;全无问题时返回空串。 */
export function formatLayerAudits(audits: readonly LayerAudit[]): string {
  if (!Array.isArray(audits)) return '';
  const lines: string[] = [];
  for (const audit of audits) {
    const line = formatLayerAudit(audit);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
