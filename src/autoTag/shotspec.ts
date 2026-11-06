/**
 * 构图闸(shot spec)—— 把「镜头怎么架」从散文里拎出来,变成结构化、可校验的一行。
 *
 * 为什么需要它:插件这一层没有任何「构图生成」能力。生图串的机位、景别、遮挡关系全部由
 * LLM 在 tag / nl 里自由发挥,而**散文天生不闭环** —— 同一张图里能同时出现「中近景」与
 * 「前景/中景/背景三层」,或者「正侧机位」与「两个人贴身到可以看见舌面」。这些矛盾不会报错,
 * 模型只会折中,出来就是"画面不对"。
 *
 * 本模块把三件可在文本层判定的事变成硬约束:
 *   1. **景别与机位的词表归并**(中近景 / medium close-up / MCU 是同一个东西,不许在一张图里出现两个);
 *   2. **空间可行性**:景别装得下几个人、几层纵深;正侧机位在贴身接触时必被近侧身体遮挡;
 *   3. **承重墙顺序**:人数 → 景别 → 机位朝向 → 机位高度 → 地点 → 光的方向,写进 tag 的最前面。
 *
 * 纯函数、无 IO、不 import settings —— 与 `charAnchors` / `generationGate` 同一条纪律:
 * 判定与提示词注入分离,单测可直接跑。
 */

/** 景别(由远到近)。 */
export type ShotSizeId =
  | 'extreme-wide'
  | 'wide'
  | 'full'
  | 'medium'
  | 'medium-close'
  | 'upper-body'
  | 'close'
  | 'extreme-close';

/** 机位朝向。 */
export type ShotAngleId = 'front' | 'three-quarter' | 'profile' | 'back';

/** 机位高度。 */
export type ShotHeightId = 'high' | 'eye' | 'low';

/** 两人之间的关系紧密度,决定"这个机位框不框得住接触点"。 */
export type ContactLevel = 'none' | 'near' | 'body';

interface VocabDef<T extends string> {
  id: T;
  /** 规范写法(写进 tag 用的那一个)。 */
  zh: string;
  /** 所有可识别写法(中英混排),解析时按长度从长到短匹配。 */
  aliases: string[];
}

interface SizeDef extends VocabDef<ShotSizeId> {
  /** 这个景别里能同时放进画面、且每个人都还辨认得出的**上限**人数。 */
  capacity: number;
  /** 这个景别装得下几层纵深(前景 / 中景 / 背景)。 */
  layers: number;
}

/**
 * 景别表。数值是拍摄常识的离散化,不是精确光学:
 * 中近景装不下第三层纵深,近景装不下两个人的全身关系 —— 这类判定足够拦住绝大多数矛盾串。
 */
export const SIZE_TABLE: readonly SizeDef[] = [
  {
    id: 'extreme-wide',
    zh: '大远景',
    aliases: ['大远景', '极大远景', 'extreme wide shot', 'extreme wide', 'ews'],
    capacity: 99,
    layers: 3,
  },
  {
    id: 'wide',
    zh: '远景',
    aliases: ['远景', 'wide shot', 'long shot', 'ls'],
    capacity: 8,
    layers: 3,
  },
  {
    id: 'full',
    zh: '全景',
    aliases: ['全景', '全身', 'full shot', 'full body', 'fs'],
    capacity: 5,
    layers: 3,
  },
  {
    id: 'medium',
    zh: '中景',
    aliases: ['中景', 'medium shot', 'ms'],
    capacity: 3,
    layers: 2,
  },
  {
    id: 'medium-close',
    zh: '中近景',
    aliases: ['中近景', 'medium close-up', 'medium closeup', 'mcu'],
    capacity: 2,
    layers: 2,
  },
  {
    id: 'upper-body',
    zh: '半身',
    // upper body 是各线规范与破限词里**实际在用**的词(见 settings.ts 的景别词表),
    // 而这张表原先认不出它 —— 模型照着规范写 upper body,构图闸就当没看见,
    // 「半身里塞了三个人的空间关系」这类问题一条都报不出来。半身装得下两个人的
    // 上半身,装不下三层纵深,故与中近景同档。
    aliases: ['半身', '上半身', 'upper body', 'upper-body', 'bust shot'],
    capacity: 2,
    layers: 2,
  },
  {
    id: 'close',
    zh: '近景',
    aliases: ['近景', 'close-up', 'closeup', 'cu'],
    capacity: 2,
    layers: 1,
  },
  {
    id: 'extreme-close',
    zh: '特写',
    aliases: ['特写', '大特写', '局部特写', 'extreme close-up', 'extreme closeup', 'ecu'],
    capacity: 1,
    layers: 1,
  },
] as const;

/** 机位朝向表。**正侧(profile)是最容易出事的一档** —— 见 `inspectFrame` 的遮挡判定。 */
export const ANGLE_TABLE: readonly VocabDef<ShotAngleId>[] = [
  { id: 'three-quarter', zh: '四分之三侧面', aliases: ['四分之三侧面', '四分之三侧', 'three-quarter view', 'three quarter view', '3/4 view'] },
  { id: 'front', zh: '正面', aliases: ['正面机位', '正面', '正面朝向', 'front view', 'frontal'] },
  { id: 'profile', zh: '正侧', aliases: ['正侧机位', '正侧面', '正侧', '侧面机位', 'side view', 'profile view'] },
  { id: 'back', zh: '背面', aliases: ['背面机位', '背部机位', '背面', '背影', 'back view', 'from behind'] },
] as const;

/** 机位高度表。 */
export const HEIGHT_TABLE: readonly VocabDef<ShotHeightId>[] = [
  { id: 'high', zh: '俯拍', aliases: ['俯拍', '俯视', '高位机位', 'high angle', 'from above'] },
  { id: 'eye', zh: '平视', aliases: ['平视', '平位机位', 'eye level', 'eye-level'] },
  { id: 'low', zh: '仰拍', aliases: ['仰拍', '仰视', '低位机位', 'low angle', 'from below'] },
] as const;

export interface ShotSpec {
  size?: ShotSizeId;
  angle?: ShotAngleId;
  height?: ShotHeightId;
}

export type IssueLevel = 'block' | 'warn';

export interface ShotIssue {
  code: string;
  level: IssueLevel;
  message: string;
  fix: string;
}

/**
 * 按写法长度从长到短匹配,命中后把那一段**抹掉**再继续 —— 否则「四分之三侧面」里的「侧面」
 * 会被再算一次「正侧」,「中近景」里的「中景」会被再算一次「中景」。这是这套词表唯一的实现陷阱。
 *
 * 第二个陷阱是短缩写:`ls` / `ms` / `cu` 这类两三个字母的英文缩写会落在别的词肚子里 ——
 * `2girls, close-up` 里的 `girls` 含 `ls`(long shot),一次误命中就把这张图判成「远景 + 近景」
 * 两个互斥景别,体检直接报一条假的 block。故**纯字母数字的短缩写必须整词命中**(两侧不能紧贴
 * 字母或数字);「medium shot」「close-up」「3/4 view」这种带空格或连字符的写法照旧按子串匹配。
 */
function harvest<T extends string>(text: string, table: readonly VocabDef<T>[]): { ids: T[]; rest: string } {
  let rest = String(text ?? '').toLowerCase();
  const hits: { id: T; at: number }[] = [];
  const pairs: { alias: string; id: T; wholeWord: boolean }[] = [];
  for (const entry of table) {
    for (const alias of entry.aliases) {
      const lowered = alias.toLowerCase();
      pairs.push({ alias: lowered, id: entry.id, wholeWord: /^[a-z0-9]+$/.test(lowered) && lowered.length <= 4 });
    }
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length);
  for (const pair of pairs) {
    let from = 0;
    for (;;) {
      const at = rest.indexOf(pair.alias, from);
      if (at < 0) break;
      const before = at > 0 ? rest[at - 1] : ' ';
      const after = rest[at + pair.alias.length] ?? ' ';
      const hitWholeWord = !pair.wholeWord || (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after));
      if (!hitWholeWord) {
        from = at + 1;
        continue;
      }
      hits.push({ id: pair.id, at });
      rest = rest.slice(0, at) + ' '.repeat(pair.alias.length) + rest.slice(at + pair.alias.length);
      break;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const ids: T[] = [];
  for (const hit of hits) if (!ids.includes(hit.id)) ids.push(hit.id);
  return { ids, rest };
}

/** 解析一段文字里的景别 / 机位朝向 / 机位高度。多值全部返回,由 `inspectFrame` 判冲突。 */
export function parseShot(text: string): {
  sizes: ShotSizeId[];
  angles: ShotAngleId[];
  heights: ShotHeightId[];
  spec: ShotSpec;
} {
  const sizes = harvest(text, SIZE_TABLE).ids;
  const angles = harvest(text, ANGLE_TABLE).ids;
  const heights = harvest(text, HEIGHT_TABLE).ids;
  return {
    sizes,
    angles,
    heights,
    spec: { size: sizes[0], angle: angles[0], height: heights[0] },
  };
}

/** 承重墙一行的规范顺序:人数 → 景别 → 机位朝向 → 机位高度。缺项跳过,不补默认值。 */
const COUNT_ZH = ['零个人', '一个人', '两个人', '三个人', '四个人', '五个人', '六个人'];

export function emitShotTag(spec: ShotSpec & { people?: number }): string {
  const parts: string[] = [];
  if (typeof spec.people === 'number' && spec.people > 0) {
    parts.push(COUNT_ZH[spec.people] ?? `${spec.people}个人`);
  }
  const size = SIZE_TABLE.find((entry) => entry.id === spec.size);
  if (size) parts.push(size.zh);
  const angle = ANGLE_TABLE.find((entry) => entry.id === spec.angle);
  if (angle) parts.push(angle.zh + '机位');
  const height = HEIGHT_TABLE.find((entry) => entry.id === spec.height);
  if (height) parts.push(height.zh);
  return parts.join(',');
}

/** 从画面串里粗判"两个人贴到什么程度" —— 只认最硬的几个动词,不追求语义理解。 */
export function inferContact(text: string): ContactLevel {
  const body = /舌|嘴|唇|含|吞|舔|抵|插入|插进|贴合|贴住|骑|跨坐|口交|性交|penis|shaft|glans|mouth|tongue/i;
  const near = /拥抱|抱住|搂|靠在|倚|贴|肩|握着|牵手|hug|embrace|hold/i;
  const raw = String(text ?? '');
  if (body.test(raw)) return 'body';
  if (near.test(raw)) return 'near';
  return 'none';
}

export interface InspectOptions {
  /** 这张图里有几个可辨认的人。不传则从「两个人」这类词里推断,推不出就不判人数。 */
  people?: number;
  /** 纵深层数(前景 / 中景 / 背景)。不传则按关键词数一遍。 */
  layers?: number;
  /** 接触紧密度。不传则用 `inferContact` 从画面串推断。 */
  contact?: ContactLevel;
  /** 画幅方向,影响"横排多人"的判定。 */
  orientation?: 'portrait' | 'landscape';
}

/**
 * 卧姿:身体长轴**横向展开**的姿势。竖画幅判定(⑥½)靠它。
 *
 * 只收明确写了「躺着」的写法:standing / kneeling / crouching 这些都不算
 * —— 它们的长轴本来就是竖的,竖幅没问题。
 */
const LYING_BODY =
  /(?:侧躺|侧卧|仰躺|平躺|趴着|趴在床|卧在床|躺在床|躺倒)|\b(?:lying (?:on|with|beside|in)|laid out|supine|prone|reclining|sprawled (?:across|on))\b/i;

function countLayers(text: string): number {
  const raw = String(text ?? '');
  let layers = 0;
  if (/前景/.test(raw)) layers += 1;
  if (/中景/.test(raw)) layers += 1;
  if (/背景|后景/.test(raw)) layers += 1;
  return layers;
}

function countPeople(text: string): number | undefined {
  const raw = String(text ?? '');
  const zh = ['一个人', '两个人', '三个人', '四个人', '五个人'];
  for (let index = 0; index < zh.length; index += 1) {
    if (raw.includes(zh[index])) return index + 1;
  }
  const en = /(\d+)\s*(?:girls?|boys?|people|persons)/i.exec(raw);
  if (en) return Number(en[1]);
  return undefined;
}

/**
 * 逐条判定一张图的构图是否自洽。
 *
 * 判定只读文本,不看剧情,所以**误判只可能是"太严"而不是"看漏"**;需要放行的场合把
 * 对应 issue 的 code 忽略掉即可。返回顺序 = 严重度优先(block 在前)。
 */
export function inspectFrame(
  frame: { tag?: string; nl?: string },
  options: InspectOptions = {},
): { spec: ShotSpec; issues: ShotIssue[] } {
  const tag = String(frame.tag ?? '');
  const nl = String(frame.nl ?? '');
  const both = `${tag}\n${nl}`;

  const parsed = parseShot(both);
  const spec = parsed.spec;
  const issues: ShotIssue[] = [];

  // ① 同一张图里出现两个互斥景别:模型会折中成一个既不是 A 也不是 B 的构图。
  // medium / medium-close / upper-body 三者是同一档的三种写法(规范里的景别词表本身就把
  // 「medium shot, upper body」当同类),同时出现不算互斥;其余组合才判冲突。
  const nearDupe = new Set<string>(['medium', 'medium-close', 'upper-body']);
  const sizeIds = parsed.sizes.filter((id, index) => {
    if (!nearDupe.has(id)) return true;
    return parsed.sizes.findIndex(other => nearDupe.has(other)) === index;
  });
  if (parsed.sizes.length > 1) {
    const labels = parsed.sizes
      .map((id) => SIZE_TABLE.find((entry) => entry.id === id)?.zh ?? id)
      .join(' / ');
    issues.push({
      code: 'size-conflict',
      level: 'block',
      message: `This image has two mutually exclusive shot sizes: ${labels}. When prose does not close the loop the model will average them,` +
        ' so the result is neither medium nor medium close-up and spatial relations drift.',
      fix: `Keep one shot size. If this panel needs both "two-person relationship" and "contact detail",` +
        ' split it into two panels instead of asking for both in one.',
    });
  }
  void sizeIds;

  // ② 机位朝向冲突(正面 + 背面这种组合几乎只会出现在模型复述多个参考时)。
  if (parsed.angles.length > 2 || (parsed.angles.includes('front') && parsed.angles.includes('back'))) {
    issues.push({
      code: 'angle-conflict',
      level: 'block',
      message: 'Camera angles contradict each other (front and back at once).',
      fix: 'Keep a single camera angle; three-quarter view usually shows both faces and body contact best.',
    });
  }

  const size = SIZE_TABLE.find((entry) => entry.id === spec.size);
  const people = options.people ?? countPeople(tag) ?? countPeople(nl);
  const layers = options.layers ?? countLayers(nl);
  const contact = options.contact ?? inferContact(nl);

  // ③ 景别装不下人数:中近景里塞三个人,必定有人变成背景里的一个色块。
  if (size && typeof people === 'number' && people > size.capacity) {
    issues.push({
      code: 'size-crowded',
      level: 'block',
      message: `${size.zh} can hold at most ${size.capacity} recognizable people; this panel wrote ${people}.` +
        ' Extra people collapse into background blobs or get cropped out.',
      fix: 'Widen the shot size, or move secondary people out of frame — do not solve it by crowding.',
    });
  }

  // ④ 景别装不下纵深:近景/中近景 + 三层环境,模型会牺牲人物去保景深,人就被推远。
  if (size && layers > size.layers) {
    issues.push({
      code: 'size-overlayered',
      level: 'warn',
      message: `${size.zh} cannot hold ${layers} depth layers (foreground/midground/background).` +
        ' Writing three layers only makes the model pull the camera back, and the shot size will not hold.',
      fix: `Cut to ${size.layers} layer(s): keep the one that best explains space; leave the rest for the next panel.`,
    });
  }

  // ⑤ 正侧机位 + 贴身接触 = 接触点必被近侧身体挡住。这是"画面不对"里出现频率最高的一条。
  if (spec.angle === 'profile' && contact !== 'none') {
    issues.push({
      code: 'profile-occlusion',
      level: 'block',
      message: 'Profile view conflicts with close contact: both bodies sit on the same sightline,' +
        ' so the near body hides the contact point and the model reshapes the frame (often moving them onto a bed or dropping the contact).',
      fix: 'Switch to three-quarter view (~45°), or offset the camera 15°–30° vertically (slight high/low);' +
        ' if you must stay in profile, use a wider panel for relative position and a separate close-up for the contact.',
    });
  }

  // ⑥½ 横躺的身体塞进竖画幅:模型只能把身体折起来、或者把伸出画面的那一截裁掉。
  //
  // 这条是从一次真实崩图里长出来的:侧躺在床上的两个人,画幅 832×1216(竖),景别中近景,
  // 出来时主角少了一条腿。规范第五节自己写着「横向展开的身体塞进竖构图会被压扁」,
  // 但此前没有任何代码把这句话变成判据 —— 它只对 AI 生效,而在手写串的链路里没有 AI。
  if (options.orientation === 'portrait' && LYING_BODY.test(nl)) {
    issues.push({
      code: 'portrait-lying',
      level: 'warn',
      message: "A lying/side-lying body in a portrait frame: the body's long axis is perpendicular to the frame," +
        ' so the model folds the body or crops the overhang — legs are usually first to go.',
      fix: 'Switch this shot to landscape; if portrait is required, crop to a vertical slice (head-shoulders, upper torso, or two upper bodies)' +
        ' and do not expect a full lying-body relationship to fit.',
    });
  }

  // ⑥ 竖画幅里横排多人:人被挤成一排小人,是竖图最常见的构图崩法。
  if (options.orientation === 'portrait' && typeof people === 'number' && people >= 3) {
    issues.push({
      code: 'portrait-row',
      level: 'warn',
      message: 'Three or more people side-by-side in a portrait frame get crushed into a row of tiny figures; nobody stays readable.',
      fix: 'Solve it with depth: stagger the second and third people front-to-back with scale and occlusion; do not line them up sideways.',
    });
  }

  // ⑦ 特写却要求两个人的空间关系:特写里塞进第二个人,只会得到半个肩膀。
  if (size && (size.id === 'close' || size.id === 'extreme-close') && typeof people === 'number' && people > 1) {
    issues.push({
      code: 'closeup-relationship',
      level: 'warn',
      message: `${size.zh} only fits part of one person; it cannot express spatial relations among ${people} people.`,
      fix: 'Close-ups should cover one detail + one expression; leave two-person relationships to a wider shot.',
    });
  }

  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1));
  return { spec, issues };
}

/** 只有 block 级才值得拦;warn 一律回执提示,不阻断出图。 */
export function blockingIssues(issues: readonly ShotIssue[]): ShotIssue[] {
  return issues.filter((issue) => issue.level === 'block');
}

/** 生成链路里的一张图(只取体检用得上的字段,免得把协议类型拖进来)。 */
export interface AuditableFrame {
  tag?: string;
  nl?: string;
  /** 画幅方向,MOSS 线用 'portrait' | 'landscape';其余后端也会填。 */
  size?: string;
}

export interface FrameAudit {
  /** 图在本次输出里的序号(0-based)。 */
  index: number;
  spec: ShotSpec;
  issues: ShotIssue[];
  /** 是否存在 block 级问题 —— **只影响日志措辞,不影响任何流程分支**。 */
  hasBlocking: boolean;
}

/**
 * 逐张体检,但**永不抛错、永不返回失败**:这不是闸门,是一面镜子。
 *
 * 为什么不在这里拦:生成链路一拦就要走重试甚至整体失败,而本模块的判定只读文本 ——
 * 误判的方向永远是「太严」。拿一个可能太严的词表去掐断出图,比放过一张构图有矛盾的图坏得多。
 * 故 block 级问题在这里一律降级成一条可丢弃的文本结论,要不要用、写到哪里,由调用方定。
 *
 * 任何形态的脏输入(缺字段、类型不对、null)都不抛错:体检失败时返回空结论,原路径照走。
 */
export function auditFrames(
  frames: readonly AuditableFrame[],
  options: InspectOptions = {},
): FrameAudit[] {
  if (!Array.isArray(frames)) return [];
  const audits: FrameAudit[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const orientation = frame?.size === 'portrait' || frame?.size === 'landscape' ? frame.size : options.orientation;
    try {
      const result = inspectFrame(
        { tag: frame?.tag, nl: frame?.nl },
        { ...options, orientation },
      );
      audits.push({
        index,
        spec: result.spec,
        issues: result.issues,
        hasBlocking: result.issues.some((issue) => issue.level === 'block'),
      });
    } catch {
      // 判定本身出错(不该发生):当作这一张没体检结论,绝不让它影响出图。
      audits.push({ index, spec: {}, issues: [], hasBlocking: false });
    }
  }
  return audits;
}

/** 一行中文结论;没有问题时返回空串(调用方据此不写空日志)。 */
export function formatFrameAudit(audit: FrameAudit | null | undefined): string {
  const issues = audit?.issues ?? [];
  if (!issues.length) return '';
  const head = `Image ${(audit?.index ?? 0) + 1}`;
  const parts = issues.map((issue) => {
    const tag = issue.level === 'block' ? 'Composition conflict' : 'Composition note';
    const more = issue.fix ? ` → ${issue.fix}` : '';
    return `${tag}[${issue.code}] ${issue.message}${more}`;
  });
  return `${head}:${parts.join(' | ')}`;
}

/** 把一批体检结论拼成可写进日志/告警通道的多行文本;全无问题时返回空串。 */
export function formatFrameAudits(audits: readonly FrameAudit[]): string {
  if (!Array.isArray(audits)) return '';
  const lines: string[] = [];
  for (const audit of audits) {
    const line = formatFrameAudit(audit);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/** 一段可直接拼进 autoTag 规则表的构图约束(与 `prompt.ts` 的规则数组同形)。 */
export const SHOT_ORDER_RULE =
  '- Composition first: the tag must start with headcount, then shot size, then camera angle, then camera height,' +
  ' then place and light direction. **Only one shot size per image**,' +
  ' and only one camera angle; the first nl paragraph must match that order and must not contradict it.\n' +
  '   - Profile + close contact → occlusion: use three-quarter view, or offset the camera 15°–30° vertically.\n' +
  '   - Do not force what the shot size cannot hold: medium close-up allows at most two depth layers (foreground + subject); close-up / extreme close-up cover one person\'s detail only;' +
  ' writing three environment layers pushes the camera back and the shot size will not hold.';

