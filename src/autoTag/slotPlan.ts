import { formatPromptText, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

/** 单条已占用画面摘要的截断长度:清单只是给模型「别撞车」用的,不是让它照抄的提示词。 */
const MAX_SUMMARY = 160;

/**
 * 「修改意见」的截断上限。
 *
 * 备注是**指令**,不是改稿说明:用户写「机位别贴这么近」应该原样送到,但一条几千字的
 * 影评/整段重写会把这楼的备注撑成正文,模型反而抓不住「只改这一处」这个前提。
 * export 出来是为了让提示词弹窗的输入框也能按同一口径给字数提示(两侧不能各算一个数)。
 */
export const MAX_INSTRUCTION = 500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 归一「修改意见」:trim 后按 {@link MAX_INSTRUCTION} 截断,空/脏输入一律返回空串。
 *
 * 空串是**逐字保持原输出的开关**:调用方没填意见时,备注必须与加这个参数之前一模一样
 * (既有单测逐条盯着),所以这里不返回任何占位表述,只在真有文本时才让调用处插一段。
 * 不做换行折叠:意见里的换行是用户的排版,原样带过去即可(它进的是任务备注,不是 tag/nl,
 * 不会被序列化进正文)。
 */
function sanitizeInstruction(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  return text ? truncate(text, MAX_INSTRUCTION) : '';
}

/** 某一槽位的展示口径摘要(压成单行);越界或无内容时返回空串。 */
function summarize(tags: string[], index: number, maxSummary: number): string {
  const raw = tags[index];
  if (raw === undefined) return '';
  const summary = formatPromptText(parseImageTagContent(raw)).replace(/\s*\n+\s*/g, ' / ').trim();
  return summary ? truncate(summary, maxSummary) : '';
}

/**
 * 单槽重写(autoTag/runner.ts 的 requestSlotTag)的任务备注。
 *
 * 语义是**重写提示词**,不是换画面:这一张画的还是原来那个瞬间,只是提示词重写一遍
 * (写得更准、更细、修掉与正文不符的地方)。写回侧本就钉死原位——runner 的 slot 分支
 * 直接 replaceImageTagAt(seq),模型返回的 position 压根不参与写回——所以这里的措辞
 * 是**唯一**决定它换不换画面的东西。旧版写的是「另选一个与它们明显不同的瞬间」,
 * 于是按钮写着「重写提示词」、模型收到的却是「换一个画面」,两头对不上。
 *
 * 为此要把该槽位**当前的提示词原样喂回去**当锚点:不给它,模型只能从整楼正文里猜
 * 「这一张画的是哪个瞬间」,猜偏了就又变成换画面。其余槽位仍然报上去,但用途变了——
 * 不是「别选中它们」,而是「别把本该属于它们的画面抢过来」。
 *
 * 槽位顺序只取一份数据:parseImageTags(与正文、卡片、水合同一口径)。
 * 摘要用展示口径 formatPromptText 压成单行并截断:给模型的是「已有什么」的索引,
 * 不是要它逐字对照的原文。目标槽位是唯一的例外,它要的就是逐字对照。
 *
 * 【修改意见:options.instruction】
 * 弹窗里可以让用户写一句具体意见(「机位别贴这么近」「裙子是浅灰不是白色」)。它是**附加约束**,
 * 不改变上面那套「画面不变」的语义——意见与「画面不变」冲突时以意见为准,但仍不得改到别的槽位。
 * 没有意见(没传 / 空串 / 纯空白)时**一个字都不多写**:输出与加这个参数之前逐字一致。
 * 因此意见不塞进 maxSummary 那个数字位,走 options 对象。
 *
 * 纯函数、无宿主依赖:runner 在发请求前拼好传进 buildAutoTagMessages 的 taskNote。
 */
export function buildSlotTaskNote(
  rawSource: string,
  seq: number,
  maxSummary = MAX_SUMMARY,
  options: { instruction?: string } = {},
): string {
  const tags = parseImageTags(rawSource ?? '');
  // 用户这次想改什么。空串 = 纯重写(旧行为),只有非空时才在下面多插一段。
  const instruction = sanitizeInstruction(options.instruction);
  const occupied: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    if (index === seq) continue;
    const summary = summarize(tags, index, maxSummary);
    occupied.push(`- 第 ${index + 1} 张：${summary || '（无提示词）'}`);
  }

  // 目标槽位的当前提示词:锚点,不截断——要模型照着同一个画面重写,就得给它全文。
  const current = tags[seq] === undefined
    ? ''
    : formatPromptText(parseImageTagContent(tags[seq])).trim();

  const lines = [
    `【本次只重写第 ${seq + 1} 张的提示词】`,
    '这一张画的仍然是它原本的那个瞬间：**不要另选画面、不要换构图主体、不要挪到正文别处**。',
    '你的任务是把这同一个画面的提示词重写一遍——依据正文把它写得更准确、更具体，补上漏掉的关键信息，修掉与正文不符或含糊的部分。',
    'images 数组必须恰好返回 1 项。',
  ];
  if (current) {
    lines.push('', '这一张当前的提示词（要重写的就是它，画面以它为准）：', current);
  }
  // 意见紧跟在**目标提示词**之后、「本楼其余画面」之前:模型读到这里时手里正好是待改的那串,
  // 改哪一处一目了然。放到整段末尾容易和「别抢别人的画面」混成一条约束。
  if (instruction) {
    lines.push(
      '',
      '【本次重写必须满足的修改意见】',
      instruction,
      '① 只按这条意见改；意见没提到的部分保持原样，不要顺手把整个画面重写一遍。',
      '② 这条意见与上面「画面不变」冲突时以意见为准，但仍然不得改动本楼别的槽位的画面。',
    );
  }
  if (occupied.length) {
    lines.push('', '本楼其余画面（它们各自的提示词已经确定，不要把它们的画面抢过来，也不要改动它们）：', ...occupied);
  }
  return lines.join('\n');
}
