import { formatPromptText, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

/** Truncation length for each occupied-frame summary: the list only helps the model avoid collisions; it is not a prompt to copy. */
const MAX_SUMMARY = 160;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Display-style summary of one slot (squeezed onto one line); empty string if out of range or empty. */
function summarize(tags: string[], index: number, maxSummary: number): string {
  const raw = tags[index];
  if (raw === undefined) return '';
  const summary = formatPromptText(parseImageTagContent(raw)).replace(/\s*\n+\s*/g, ' / ').trim();
  return summary ? truncate(summary, maxSummary) : '';
}

/**
 * Task note for a single-slot rewrite (requestSlotTag in autoTag/runner.ts).
 *
 * It means **rewrite the prompt**, not change the scene: this image still depicts the original moment; only the prompt is rewritten
 * (more accurate, more detailed, fixing mismatches with the story). The write-back side is pinned in place anyway: the runner's slot branch
 * calls replaceImageTagAt(seq) directly and the model's returned position plays no part in write-back, so this wording
 * is the **only** thing deciding whether the scene changes. The old version said "choose another moment clearly different from them",
 * so the button said "Rewrite prompt" while the model was told "change the scene"; the two ends didn't match.
 *
 * That is why this slot's **current prompt is fed back verbatim** as the anchor: without it, the model could only guess from the whole floor's text
 * "which moment this image depicts", and a wrong guess would again become a scene change. Other slots are still listed, but for a different purpose:
 * not "don't pick them", but "don't take over scenes that belong to them".
 *
 * Slot order comes from one source only: parseImageTags (the same rule as the text, cards and hydration).
 * Summaries are squeezed onto one line with the display-style formatPromptText and truncated: the model gets an index of "what already exists",
 * not text to compare word for word. The target slot is the only exception; it needs exactly a word-for-word comparison.
 *
 * Pure function with no host dependency: the runner builds it before sending and passes it to buildAutoTagMessages as taskNote.
 */
export function buildSlotTaskNote(rawSource: string, seq: number, maxSummary = MAX_SUMMARY): string {
  const tags = parseImageTags(rawSource ?? '');
  const occupied: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    if (index === seq) continue;
    const summary = summarize(tags, index, maxSummary);
    occupied.push(`- Image ${index + 1}: ${summary || '(no prompt)'}`);
  }

  // The target slot's current prompt: the anchor, not truncated; to have the model rewrite the same scene, it needs the full text.
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
