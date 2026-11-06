import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { getTagGenChannel } from '@/state/settings';
import { containsTagMarkup, type ImageTagContent } from '@/st/imageTagRegex';



const SYSTEM = [
  'Edit the supplied image-prompt JSON according to the requested changes. You have no story or character-card context.',
  'Preserve all details and fields not affected by the request. Preserve character names exactly, in their original language.',
  'Use English for generated prompt text. Preserve the input style: comma-separated tags remain tags; natural-language descriptions remain coherent prose. Do not convert MOSS prose into Danbooru tags.',
  'tag is the positive image prompt; nl is its optional natural-language description; negative contains additional negative terms.',
  'characters contains objects with name, tag, and nl. Keep the existing identities and edit only the relevant character fields.',
  'Keep empty nl and negative fields empty unless the request explicitly asks to add them. size must be portrait or landscape.',
  'Do not include XML/image-tag markup in any field. Return only the complete revised JSON object with the same fields, without commentary or code fences.',
].join('\n');

export function promptOnlyMessages(content: ImageTagContent, hint: string): ChatMsg[] {
  const current = {
    tag: content.tag,
    nl: content.nl,
    negative: content.negative,
    characters: content.characters.map(({ name, tag, nl }) => ({ name, tag, nl })),
    size: content.size,
  };
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Current image prompt:\n${JSON.stringify(current, null, 2)}\n\nRequested changes:\n${hint.trim()}` },
  ];
}

function oneLine(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : fallback;
}


export function parsePromptOnlyReply(raw: string, original: ImageTagContent): ImageTagContent {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI did not return an edited prompt.');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('The AI returned invalid prompt JSON.');
  }
  const characters: ImageCharacterPrompt[] = Array.isArray(data.characters)
    ? data.characters
        .map(item => {
          const c = (item ?? {}) as Record<string, unknown>;
          const name = oneLine(c.name, '');
          const previous = original.characters.find(character => character.name === name);
          return { name, tag: oneLine(c.tag, previous?.tag ?? ''), nl: oneLine(c.nl, previous?.nl ?? '') };
        })
        .filter(c => c.name && c.tag)
    : original.characters.map(c => ({ ...c }));
  if (characters.length !== original.characters.length || original.characters.some(character => !characters.some(next => next.name === character.name))) {
    throw new Error('The AI changed or removed a character identity. The draft was kept unchanged.');
  }
  const next: ImageTagContent = {
    tag: oneLine(data.tag, original.tag),
    nl: oneLine(data.nl, original.nl),
    negative: oneLine(data.negative, original.negative),
    characters,
    size: data.size === 'portrait' || data.size === 'landscape' ? data.size : original.size,
  };
  if (!next.tag) throw new Error('The edited image prompt is empty.');
  const all = [next.tag, next.nl, next.negative, ...characters.flatMap(c => [c.name, c.tag, c.nl])];
  if (all.some(value => value && containsTagMarkup(value))) throw new Error('The edited prompt contains image-tag markup.');
  return next;
}


export async function editPromptOnly(
  content: ImageTagContent,
  hint: string,
  signal: AbortSignal,
): Promise<ImageTagContent> {
  signal.throwIfAborted();
  const messages = promptOnlyMessages(content, hint);
  const parsed: { value: ImageTagContent | null } = { value: null };
  const validate = (raw: string) => {
    signal.throwIfAborted();
    parsed.value = parsePromptOnlyReply(raw, content);
  };
  const channel = getTagGenChannel();
  const opts = { signal, source: 'Edit prompt without story context', validate };
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Prompt editing cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // generateRaw cannot stop its transport, but a cancelled edit must never refill the draft later.
    await Promise.race([channel ? requestCompletion(channel, messages, opts) : requestViaMainApi(messages, opts), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (!parsed.value) throw new Error('The AI did not return an edited prompt.');
  return parsed.value;
}
