import { prepareTargetText } from '@/autoTag/clean';
import { getContext } from '@/st/context';
import { stripImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

export interface Passage { id: string; text: string }
export function floorPassages(floor: number | null): Passage[] {
  const text = floor === null ? '' : getContext()?.chat?.[floor]?.mes;
  return text ? prepareTargetText(stripImageTags(text), settings.excludes.customStripTags).segments.map(({ id, text }) => ({ id, text })) : [];
}
export const PASSAGE_HINT_PREFIX = 'Illustrate only these passages:';
export function passageGroupsHint(groups: Passage[][]): string {
  return groups.filter(group => group.length).map((group, i) =>
    `Image ${i + 1} — ${PASSAGE_HINT_PREFIX} ${group.map(p => `⟦${p.id}⟧`).join(' ')}\n` +
    group.map(p => `⟦${p.id}⟧ ${p.text}`).join('\n')
  ).join('\n\n');
}
export function focusGroups(hint: string | null | undefined): string[][] {
  return String(hint ?? '').split('\n').filter(line => /^Image \d+ — Illustrate only these passages:/.test(line))
    .map(line => [...line.matchAll(/⟦(P\d+)⟧/g)].map(m => m[1])).filter(ids => ids.length);
}
export function focusImageCount(hint: string | null | undefined): number { return Math.max(1, focusGroups(hint).length); }
export function passageTaskNote(hint: string): string {
  const count = focusImageCount(hint);
  return `The user selected ${count} ${count === 1 ? 'scene group' : 'scene groups'}. Return exactly ${count} ${count === 1 ? 'image' : 'images'}, one per group in the order below. Each image must depict one visible moment within its own selected passages. Choose its position from that group. Do not substitute scenes from other passages or combine separate groups into the same image. These scene choices override automatic scene selection; all other prompt and output rules still apply.\n\n${hint}`;
}
