import { formatPromptText, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

/** 单条已占用画面摘要的截断长度:清单只是给模型「别撞车」用的,不是让它照抄的提示词。 */
const MAX_SUMMARY = 160;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
 * 纯函数、无宿主依赖:runner 在发请求前拼好传进 buildAutoTagMessages 的 taskNote。
 */
export function buildSlotTaskNote(rawSource: string, seq: number, maxSummary = MAX_SUMMARY): string {
  const tags = parseImageTags(rawSource ?? '');
  const occupied: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    if (index === seq) continue;
    const summary = summarize(tags, index, maxSummary);
    occupied.push(`- Image ${index + 1}: ${summary || '(no prompt)'}`);
  }

  // 目标槽位的当前提示词:锚点,不截断——要模型照着同一个画面重写,就得给它全文。
  const current = tags[seq] === undefined
    ? ''
    : formatPromptText(parseImageTagContent(tags[seq])).trim();

  const lines = [
    `【Rewrite only image ${seq + 1}'s prompt】`,
    'Keep the original moment: **Do not choose another scene, change the main subject or interaction, or move the image elsewhere in the text**.',
    'Rewrite the prompt for this same image: make it more accurate and specific, supply missing visual details, and remove ambiguity or contradictions with the story.',
    'The images array must return exactly 1 item.',
  ];
  if (current) {
    lines.push('', 'Current prompt for this image (preserve its depicted moment):', current);
  }
  if (occupied.length) {
    lines.push('', 'Other images in this message (do not take over their scenes or change their prompts):', ...occupied);
  }
  return lines.join('\n');
}
