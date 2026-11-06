import { getContext } from '@/st/context';
import { parseImageTagContent, parseImageTags, stripImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';
import { prepareTargetText } from '@/autoTag/clean';
import { focusGroups } from './passage';
import type { MessageExtraUpdate } from '@/st/messageEdit';

export const SOURCES_KEY = 'bbiPassageSources';

type SourceStore = Record<string, Record<string, string[]>>;

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const flat = (text: string | undefined) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function sourceKey(content: { tag: string; nl?: string }): string {
  return hash(`${flat(content.tag)}\u0001${flat(content.nl)}`);
}

/** Stored with the text so failed saves cannot leave phantom illustration markers. */
export function focusSourceUpdate(
  extra: Record<string, unknown> | undefined,
  swipeId: number,
  images: Array<{ tag: string; nl?: string; position: string }>,
  segments: Array<{ id: string; text: string }>,
  focus: string,
): MessageExtraUpdate {
  const store = (extra?.[SOURCES_KEY] ?? {}) as SourceStore;
  const groups = focusGroups(focus);
  const entries = images.map(image => {
    const ids = groups.find(group => group.includes(image.position)) ?? [];
    return [sourceKey(image), segments.filter(segment => ids.includes(segment.id)).map(segment => segment.text)];
  });
  return { key: SOURCES_KEY, value: { ...store, [String(swipeId)]: { ...store[String(swipeId)], ...Object.fromEntries(entries) } } };
}

export function drawnPassages(floor: number): Record<string, number[]> {
  const message = getContext()?.chat?.[floor];
  if (!message?.mes) return {};
  const bucket = (message.extra?.[SOURCES_KEY] as SourceStore | undefined)?.[String(message.swipe_id ?? 0)] ?? {};
  const segments = prepareTargetText(stripImageTags(message.mes), settings.excludes.customStripTags).segments;
  const out: Record<string, number[]> = {};
  parseImageTags(message.mes).forEach((raw, seq) => {
    for (const text of bucket[sourceKey(parseImageTagContent(raw))] ?? []) {
      const id = segments.find(s => s.text === text)?.id;
      if (id) (out[id] ??= []).push(seq + 1);
    }
  });
  return out;
}
