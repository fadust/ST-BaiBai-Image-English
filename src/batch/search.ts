import { reactive } from 'vue';

import { IMAGE_TAG_FIND_REGEX } from '@/st/imageTagRegex';
import { isAiStoryMessage, type STMessage } from '@/st/context';




export const BUILTIN_STRIP_TAGS = ['think', 'thinking', 'reasoning', 'reflection', 'analysis'];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


export function splitNames(text: string): string[] {
  const trimmed = String(text ?? '').trim();
  const parts = trimmed.split(/[,，、;；|\n]+/);
  return [...new Set(parts.map(part => part.trim()).filter(Boolean))];
}


export function stripTagList(...lists: string[][]): string[] {
  const all = [BUILTIN_STRIP_TAGS, ...lists].flat();
  return [
    ...new Set(
      all
        .map(tag => String(tag).trim().replace(/^<\/?/, '').replace(/\/?>$/, ''))
        .filter(Boolean),
    ),
  ];
}


export function searchableText(mes: string, stripTags: string[]): string {
  let text = String(mes ?? '')
    .replace(new RegExp(IMAGE_TAG_FIND_REGEX.source, 'gi'), '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of stripTags) {
    const name = escapeRegex(tag);
    text = text.replace(new RegExp(`<${name}(?=[\\s>/])[^>]*>[\\s\\S]*?</${name}\\s*>`, 'gi'), '');

    if (!BUILTIN_STRIP_TAGS.includes(tag.toLowerCase())) continue;

    const close = new RegExp(`</${name}\\s*>`, 'i').exec(text);
    if (close) text = text.slice(close.index + close[0].length);

    const open = new RegExp(`<${name}(?=[\\s>/])[^>]*>`, 'i').exec(text);
    if (open) text = text.slice(0, open.index);
  }
  return text;
}

export interface NameHits {
  name: string;

  floors: number[];
}

export interface SearchResult {

  rows: NameHits[];

  together: number[];
}

export function searchNames(
  chat: STMessage[],
  names: string[],
  options: { withUser: boolean; stripTags: string[] },
): SearchResult {
  const unique = [...new Set(names.map(name => name.trim()).filter(Boolean))];
  const needles = unique.map(name => name.toLowerCase());
  const hits = unique.map(() => [] as number[]);
  const together: number[] = [];
  chat.forEach((message, floor) => {
    if (!message || typeof message.mes !== 'string') return;
    if (message.is_user ? !options.withUser : !isAiStoryMessage(message)) return;
    const text = searchableText(message.mes, options.stripTags).toLowerCase();
    let all = true;
    needles.forEach((needle, index) => {
      if (text.includes(needle)) hits[index].push(floor);
      else all = false;
    });
    if (all && unique.length > 1) together.push(floor);
  });
  const rows = unique
    .map((name, index) => ({ name, floors: hits[index] }))
    .sort((left, right) => (left.floors[0] ?? Infinity) - (right.floors[0] ?? Infinity));
  return { rows, together };
}


export const searchState = reactive({
  query: '',
  withUser: false,

  names: [] as string[],
  result: null as SearchResult | null,
});
