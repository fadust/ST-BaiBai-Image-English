import { prepareTargetText } from '@/autoTag/clean';
import { consumeAutoGenerate, markForAutoGenerate } from '@/floor/autoGenerate';
import { getGenRecord, slotKey } from '@/floor/genState';
import { BBI_IMAGE_EXTRA_KEY, type BbiImageStore } from '@/floor/storage';
import type { MessageExtraUpdate } from '@/st/messageEdit';
import { getContext } from '@/st/context';
import { stripImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

import { focusGroups } from './passage';
import { PROMPT_MEMO_KEY, type PromptMemo } from '@/promptVersions/versions';

function maskTags(text: string): string {
  return text.replace(/<bbi_image>[\s\S]+?<\/bbi_image>/gi, m => m.replace(/[^\r\n]/g, ' '));
}

export function passageLine(text: string, id: string, stripTags: string[]): number | null {
  const shown = prepareTargetText(stripImageTags(text), stripTags).segments.find(s => s.id === id);
  if (!shown) return null;
  const segments = prepareTargetText(maskTags(text), stripTags).segments;
  const hit = segments.find(s => s.id === id && s.text === shown.text) ?? segments.find(s => s.text === shown.text);
  return hit ? hit.sourceLine : null;
}

function lineEnd(text: string, line: number): number | null {
  const newline = /\r\n|\n|\r/g;
  let current = 0;
  for (let match = newline.exec(text); match; match = newline.exec(text)) {
    if (current === line) return match.index;
    current += 1;
  }
  return current === line ? text.length : null;
}

function eolOf(text: string): string {
  return /\r\n|\n|\r/.exec(text)?.[0] ?? '\n';
}

export function moveTagAfterPassage(
  text: string,
  seq: number,
  nextTag: string,
  passageId: string,
  stripTags: string[],
): { text: string; seq: number } | null {
  const spans = [...text.matchAll(/<bbi_image>[\s\S]+?<\/bbi_image>/gi)];
  const span = spans[seq];
  if (!span || span.index === undefined) return null;
  let start = span.index;
  let end = start + span[0].length;

  const before = /(?:\r\n|\n|\r)$/.exec(text.slice(0, start));
  if (before) start -= before[0].length;
  else {
    const after = /^(?:\r\n|\n|\r)/.exec(text.slice(end));
    if (after) end += after[0].length;
  }
  const removed = text.slice(0, start) + text.slice(end);

  const line = passageLine(removed, passageId, stripTags);
  if (line === null) return null;
  const at = lineEnd(removed, line);
  if (at === null) return null;
  const out = `${removed.slice(0, at)}${eolOf(removed)}${nextTag}${removed.slice(at)}`;
  const newSeq = [...removed.slice(0, at).matchAll(/<bbi_image>[\s\S]+?<\/bbi_image>/gi)].length;
  return { text: out, seq: newSeq };
}

export function shiftedSeq(i: number, from: number, to: number): number {
  if (i === from) return to;
  const without = i > from ? i - 1 : i;
  return without >= to ? without + 1 : without;
}

export function remapStore(store: BbiImageStore | undefined, swipeId: number, from: number, to: number): BbiImageStore | undefined {
  if (!store || from === to) return store;
  const bucket = store[String(swipeId)];
  if (!bucket) return store;
  const next: Record<string, BbiImageStore[string][string]> = {};
  for (const [hash, list] of Object.entries(bucket)) {
    next[hash] = list.map(entry => ({ ...entry, slotSeq: shiftedSeq(entry.slotSeq ?? 0, from, to) }));
  }
  return { ...store, [String(swipeId)]: next };
}

interface PendingMove {
  floor: number;
  store: BbiImageStore | undefined;
  memo?: PromptMemo;
}

let pending: PendingMove | null = null;

function floorBusy(chatId: string, floor: number, swipeId: number, count: number): boolean {
  for (let i = 0; i < count; i += 1) {
    const phase = getGenRecord(slotKey(chatId, floor, swipeId, i))?.phase;
    if (phase === 'queued' || phase === 'generating') return true;
  }
  return false;
}

export function pinFocusPosition(
  images: Array<{ position: string; sourceLine: number }>,
  segments: Array<{ id: string; sourceLine: number }>,
  focus: string | undefined,
): void {
  const groups = focusGroups(focus);
  if (!groups.length) return;
  const owner = images.map(image => groups.findIndex(ids => ids.includes(image.position)));
  const taken = new Set<number>();
  owner.forEach((g, i) => {
    if (g < 0 || taken.has(g)) owner[i] = -1;
    else taken.add(g);
  });
  const free = groups.map((_, g) => g).filter(g => !taken.has(g));
  images.forEach((image, i) => {

    const g = owner[i] >= 0 ? owner[i] : (free.shift() ?? groups.length - 1);
    const ids = groups[g];
    const target = segments.find(s => s.id === ids[ids.length - 1]);
    if (!target) return;
    image.position = target.id;
    image.sourceLine = target.sourceLine;
  });
}

let addedMarks: Array<{ chatId: string; floor: number; swipeId: number; seq: number }> = [];

export function addFocusedTags(
  currentText: string,
  at: { chatId: string; floor: number; swipeId: number },
  added: Array<{ tag: string; passageId: string }>,
): string {
  pending = null;
  const original = getContext()?.chat?.[at.floor]?.extra?.[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined;
  let store = original;
  const oldMemo = getContext()?.chat?.[at.floor]?.extra?.[PROMPT_MEMO_KEY] as PromptMemo | undefined;
  let memo = oldMemo;
  let text = currentText;
  const count = [...currentText.matchAll(/<bbi_image>[\s\S]+?<\/bbi_image>/gi)].length;
  const busy = floorBusy(at.chatId, at.floor, at.swipeId, count);
  const seqs: number[] = [];
  for (const { tag, passageId } of added) {
    const total = count + seqs.length;
    const appended = `${text}${eolOf(text)}${tag}`;
    const result = !busy ? moveTagAfterPassage(appended, total, tag, passageId, settings.excludes.customStripTags) : null;
    const seq = result ? result.seq : total;
    if (seq !== total) {
      store = remapStore(store, at.swipeId, total, seq);
      if (memo?.[String(at.swipeId)]) {
        memo = { ...memo, [String(at.swipeId)]: Object.fromEntries(Object.entries(memo[String(at.swipeId)]).map(([key, value]) => [String(shiftedSeq(Number(key), total, seq)), value])) };
      }
      for (let i = 0; i < seqs.length; i++) seqs[i] = shiftedSeq(seqs[i], total, seq);
    }
    seqs.push(seq);
    text = result ? result.text : appended;
  }
  pending = { floor: at.floor, store, memo };

  addedMarks = seqs.map(seq => ({ ...at, seq }));
  for (const seq of seqs) markForAutoGenerate(at.chatId, at.floor, at.swipeId, seq, 'force');
  return text;
}

export function dropAddedMark(): void {
  for (const mark of addedMarks) consumeAutoGenerate(mark.chatId, mark.floor, mark.swipeId, mark.seq);
  addedMarks = [];
}

export function addedExtraUpdates(floor: number): MessageExtraUpdate[] {
  let captured: PendingMove | null | undefined;
  const get = () => {
    if (captured === undefined) { captured = pending?.floor === floor ? pending : null; pending = null; }
    return captured;
  };
  return [
    { key: BBI_IMAGE_EXTRA_KEY, get value() { return get()?.store ?? getContext()?.chat?.[floor]?.extra?.[BBI_IMAGE_EXTRA_KEY]; } },
    { key: PROMPT_MEMO_KEY, get value() { return get()?.memo ?? getContext()?.chat?.[floor]?.extra?.[PROMPT_MEMO_KEY]; } },
  ];
}
