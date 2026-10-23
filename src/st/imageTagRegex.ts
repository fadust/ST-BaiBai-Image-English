import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { normalizeOrientation, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';

/**
 * The two managed regexes for BaiBai Image tags (DESIGN-FLOOR-UI.md §4):
 *
 * - bbi-image-tag-slot (markdownOnly): the display path replaces the whole <bbi_image>…</bbi_image>
 *   with an empty anchor <div data-bbi-slot=""></div>, so the prompt never enters the DOM.
 * - bbi-image-tag-hide (promptOnly): the prompt path replaces the same tag with an empty string.
 *
 * Both rules share the same find and apply on mutually exclusive paths (the engine conditions markdownOnly&&isMarkdown and
 * promptOnly&&isPrompt never match at the same time), so they coexist safely.
 */

export const IMAGE_TAG_FIND_REGEX_LITERAL = '/<bbi_image>[\\s\\S]+?<\\/bbi_image>/gi';

/** Runtime regex from the same source as the managed scripts: parses tags in the raw message.mes (for hydration pairing). */
export const IMAGE_TAG_FIND_REGEX = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;

/** DOM selector for display-side anchors (anchors use only a data attribute; DOMPurify would prefix classes with custom-). */
export const BBI_SLOT_SELECTOR = 'div[data-bbi-slot]';

export const IMAGE_TAG_SLOT_REGEX_ID = 'bbi-image-tag-slot';
export const IMAGE_TAG_HIDE_REGEX_ID = 'bbi-image-tag-hide';

// regex_placement: 0=MD_DISPLAY (deprecated) / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND.
// The display path's placement varies by message type (getRegexPlacement in script.js):
// user messages → 1, AI floors → 2, and **floors with extra.type === 'narrator' → 3**;
// the prompt path (Generate in script.js) only chooses by is_user, so it is only ever 1 or 2.
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;
/**
 * Display placement for narrator floors (extra.type='narrator' from /narrator, /sys and the like).
 *
 * It must be included: a floor created by `/narrator` is `is_system:false` + `extra.type:'narrator'`,
 * so isAiStoryMessage in st/context.ts **treats it as a story floor**, and auto-tag will write tags into it.
 * The display side's getRegexPlacement assigns such floors 3, so with only [1,2] the anchor regex never matches:
 * the raw tag isn't replaced, DOMPurify strips the unknown `<bbi_image>` wrapper and leaves the prompt inside as body text,
 * users see a string of danbooru tags directly, and no anchor = no card.
 * The invariant "tags never enter the DOM" is broken on this kind of floor.
 *
 * The prompt-side rule (hide) includes it too: it is promptOnly and only applies when isPrompt, and ST itself
 * never uses the (SLASH_COMMAND, isPrompt) combination, so it is a no-op for existing paths. It is included so that
 * "tags never enter the prompt" still holds when a third party calls getRegexedString; replaceString is empty,
 * so covering one more placement has no side effect. Keeping both rules' placements identical is also easier to reason about.
 */
const PLACEMENT_SLASH_COMMAND = 3;

const DISPLAY_AND_PROMPT_PLACEMENTS = [
  PLACEMENT_USER_INPUT,
  PLACEMENT_AI_OUTPUT,
  PLACEMENT_SLASH_COMMAND,
];

export interface ManagedRegexScript extends Record<string, unknown> {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
}

/** Display side: image tag → empty anchor (the Vue card renders into the anchor during hydration). */
export function imageTagSlotScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_SLOT_REGEX_ID,
    scriptName: 'BaiBai Image · Picture label placeholder',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: '<div data-bbi-slot=""></div>',
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** Prompt side: image tag → empty string (removed entirely from the prompt path; never leaks). */
export function imageTagHideScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_HIDE_REGEX_ID,
    scriptName: 'BaiBai Image · Hidden Picture Tags',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: '',
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** Parses all image tags from the raw message in order of appearance; returns an empty array if there are none. */
export function parseImageTags(mes: string): string[] {
  return mes.match(IMAGE_TAG_FIND_REGEX) ?? [];
}

/**
 * Whether the text shows any trace of an image tag, **including stray half-tags (lone open/close tags)**.
 *
 * **There is only this one copy**: the floor button deciding "ask for regenerate confirmation first" and the runner deciding "skip floors
 * that already have tags" share it. When each side had its own regex: the button's only recognised open tags, so with only a
 * `</bbi_image>` left in the text the button thought there was no tag (no confirmation, replace=false), while the runner's recognised both and
 * thought there was a tag and silently gave up; users saw "the button never does anything".
 */
export function hasImageTagTrace(mes: string): boolean {
  return /<\/?bbi_image\b/i.test(mes ?? '');
}

/**
 * Removes all image tags from a message (used before regenerating).
 * Tags injected by the plugin sit on their own line (injected form: line text + newline + tag), so they are removed together with the preceding newline,
 * restoring exactly the original text before injection; hand-written inline tags have no preceding newline, so only the tag itself is removed.
 *
 * Why not just `.replace(find regex, '')`: that regex is non-greedy, so when the text contains an extra half
 * `<bbi_image>` (the AI imitated the context and wrote only half, or another plugin truncated a tag), it would eat from that
 * fragment all the way to the next `</bbi_image>`, deleting the text in between together with the real tag after it.
 * So it scans token by token instead: a close tag pairs with **the nearest unpaired open tag** (the whole span is removed), and lone
 * open/close tags left after the scan remove only themselves. Fragments must be cleaned up completely; left behind, ST's equally non-greedy anchor regex
 * on the display side would swallow body text into the anchor (broken image).
 */
export function stripImageTags(mes: string): string {
  const source = String(mes ?? '');
  // Created in place: a module-level /g regex instance has stateful lastIndex, so exec loops can't share it (same as replaceImageTagAt)
  const tokens = /<\/?bbi_image\b[^>]*>/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  const openStack: Array<{ start: number; end: number }> = [];
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0][1] === '/') {
      const open = openStack.pop();
      ranges.push({ start: open ? open.start : start, end });
    } else {
      openStack.push({ start, end });
    }
  }
  for (const open of openStack) ranges.push(open);
  if (!ranges.length) return source;

  ranges.sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    // With nesting like `O O C C` the outer span already swallowed the inner one; skip it
    if (range.start < cursor) continue;
    out += source.slice(cursor, range.start).replace(/(?:\r\n|\n|\r)$/, '');
    cursor = range.end;
  }
  return out + source.slice(cursor);
}

/**
 * Sub-tag literals not allowed in tag / nl / negative content (they would corrupt bbi_image's internal parsing).
 *
 * Single rule: shared by the AI side (sanitizeContent in autoTag/protocol.ts) and the manual-input side (prompt editor dialog).
 * **Never copy it a second time**: the find regex `<bbi_image>…</bbi_image>` is non-greedy,
 * so one `</bbi_image>` in the content truncates the tag early and leaks the rest into the DOM and the prompt,
 * breaking exactly the invariant "tags never enter the DOM, never enter the prompt".
 */
export const FORBIDDEN_SUBTAG = /<\/?(?:bbi_image|tag|nl|negative|characters|size)\b/i;

/** Whether text contains bbi_image sub-tag literals (for manual-input validation; same rule as the AI side). */
export function containsTagMarkup(text: string): boolean {
  return FORBIDDEN_SUBTAG.test(text);
}

export interface ImageTagContent {
  /** Short danbooru tag part: content of an explicit <tag> sub-tag, or the bare text with sub-tags removed (legacy format). */
  tag: string;
  /** Natural-language part: content of the <nl> sub-tag, or empty string if none. */
  nl: string;
  /** Per-image dynamic negative tags: content of the <negative> sub-tag, or empty string if none. */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** Frame orientation: content of the <size> sub-tag; missing/unrecognisable means portrait (legacy tags go this way, same behaviour as before the change). */
  size: Orientation;
}

/**
 * Parses the inner content of a raw tag (including the <bbi_image> wrapper). One lenient rule covers three forms:
 * - <bbi_image>xxxx</bbi_image>                    bare text = tag (legacy compatible)
 * - <bbi_image>xxxx<nl>yyyy</nl></bbi_image>       bare text = tag, <nl> = nl
 * - <bbi_image><tag>x</tag><negative>y</negative></bbi_image> explicit sub-tags (hand-written tolerance)
 * When bare text and an explicit <tag> both exist, they merge into the tag part as "bare text first" joined with ", ", losing nothing.
 * <size>/<nl>/<negative> must be stripped first and must not leak into the positive prompt.
 */
export function parseImageTagContent(raw: string): ImageTagContent {
  // Content is folded into a single line: hand-written tags may span lines, and newlines mean nothing in a prompt
  const oneLine = (text: string) => text.trim().replace(/[\r\n]+/g, ' ');
  const inner = raw.replace(/^<bbi_image[^>]*>/i, '').replace(/<\/bbi_image>$/i, '');
  const nlMatch = inner.match(/<nl>([\s\S]*?)<\/nl>/i);
  const nl = nlMatch ? oneLine(nlMatch[1]) : '';
  const negativeMatch = inner.match(/<negative>([\s\S]*?)<\/negative>/i);
  const negative = negativeMatch ? oneLine(negativeMatch[1]) : '';
  const charactersMatch = inner.match(/<characters>([\s\S]*?)<\/characters>/i);
  let characters: ImageCharacterPrompt[] = [];
  if (charactersMatch) {
    try {
      const parsed = JSON.parse(charactersMatch[1]);
      if (Array.isArray(parsed)) {
        characters = parsed.slice(0, 32).flatMap(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const rawItem = item as Record<string, unknown>;
          const name = oneLine(typeof rawItem.name === 'string' ? rawItem.name : '');
          const tag = oneLine(typeof rawItem.tag === 'string' ? rawItem.tag : '');
          const nl = oneLine(typeof rawItem.nl === 'string' ? rawItem.nl : '');
          return name && tag ? [{ name, tag, nl }] : [];
        });
      }
    } catch {
      // Invalid character JSON must not break the otherwise valid Base prompt.
    }
  }
  const sizeMatch = inner.match(/<size>([\s\S]*?)<\/size>/i);
  const size = normalizeOrientation(sizeMatch ? oneLine(sizeMatch[1]) : '');
  const withoutSubTags = inner
    .replace(/<nl>[\s\S]*?<\/nl>/gi, '')
    .replace(/<negative>[\s\S]*?<\/negative>/gi, '')
    .replace(/<characters>[\s\S]*?<\/characters>/gi, '')
    .replace(/<size>[\s\S]*?<\/size>/gi, '');
  const explicit = [...withoutSubTags.matchAll(/<tag>([\s\S]*?)<\/tag>/gi)]
    .map(match => oneLine(match[1]))
    .filter(Boolean);
  const bare = oneLine(withoutSubTags.replace(/<tag>[\s\S]*?<\/tag>/gi, ''));
  const tag = [...(bare ? [bare] : []), ...explicit].join(', ');
  return { tag, nl, negative, characters, size };
}

/**
 * Serialises to raw tag text (including the <bbi_image> wrapper): the inverse of parseImageTagContent.
 *
 * **There is only one reader and writer of the format**: injection (injectImageTags in autoTag/protocol.ts) and manual editing
 * (floor/promptEditor.ts) share it. If they drifted, "parsed fields" and "raw text written to the story" would disagree,
 * and promptHash hashes exactly the raw text, so drift shows up as "nothing changed, yet everything turned stale".
 *
 * Standard form: the tag part stays bare text (matching the legacy format); nl/negative/characters are omitted entirely when empty.
 * size is **always written**: generation is deferred (images render only when the card is clicked), so the orientation must persist with the tag in the text.
 */
export function serializeImageTag(content: ImageTagContent): string {
  const nl = content.nl ? `<nl>${content.nl}</nl>` : '';
  const negative = content.negative ? `<negative>${content.negative}</negative>` : '';
  const characters = content.characters.length
    ? `<characters>${JSON.stringify(content.characters)}</characters>`
    : '';
  return `<bbi_image>${content.tag}${nl}${negative}${characters}<size>${content.size}</size></bbi_image>`;
}

/**
 * The **single display rule** for the full prompt text: shared by floor cards (copy / lightbox / expanded area) and the gallery.
 *
 * Division with serializeImageTag: that one produces the raw text for machines (consumed by promptHash),
 * this one produces plain text for people (blank lines between sections, character sections). Neither may keep its own second copy:
 * what the gallery shows must match the card word for word, otherwise the same image looks different in two places.
 *
 * size is deliberately left out: it is the frame orientation, not prompt content, and cards never show it either.
 */
export function formatPromptText(
  content: Pick<ImageTagContent, 'tag' | 'nl' | 'negative' | 'characters'>,
): string {
  return [
    content.tag,
    content.nl,
    ...content.characters.map(character =>
      [`Role: ${character.name}`, character.tag, character.nl].filter(Boolean).join('\n'),
    ),
    content.negative ? `Negative: ${content.negative}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Replaces tag number seq (0-based) in the text in place; the rest of the text and other tags stay untouched.
 * seq out of range returns null (the caller then abandons the write-back).
 *
 * Why not the module-level IMAGE_TAG_FIND_REGEX: it is a shared instance with /g, and lastIndex is stateful.
 * Existing callers all use .match()/.replace() (which reset lastIndex), so there is no conflict;
 * here the replace callback counts in order and the regex is still created locally, leaving later code no way to trip over it.
 */
export function replaceImageTagAt(mes: string, seq: number, nextTag: string): string | null {
  if (!Number.isInteger(seq) || seq < 0) return null;
  let index = 0;
  let replaced = false;
  const output = mes.replace(/<bbi_image>[\s\S]+?<\/bbi_image>/gi, match => {
    if (index++ !== seq) return match;
    replaced = true;
    return nextTag;
  });
  return replaced ? output : null;
}

const MANAGED_SCRIPTS: Array<() => ManagedRegexScript> = [
  imageTagSlotScript,
  imageTagHideScript,
];

/**
 * Registers BaiBai Image's managed rules in ST's global regex list.
 * Fixed ids make it idempotent: same-id rules from old versions or edited by the user are updated, other regexes are left as-is,
 * and nothing is added twice. The old single bbi-image-tag-hide rule (markdownOnly+promptOnly both on) is
 * overwritten in place by the new hide definition, and a slot rule is added, so existing users migrate seamlessly.
 */
export function ensureImageTagRegexRegistered(): boolean {
  const context = getContext();
  const extensionSettings = context?.extensionSettings;
  if (!extensionSettings) return false;
  if (!Array.isArray(extensionSettings.regex)) extensionSettings.regex = [];

  const list = extensionSettings.regex as Array<Record<string, unknown>>;
  for (const make of MANAGED_SCRIPTS) {
    const script = make();
    const index = list.findIndex(item => item?.id === script.id);
    if (index >= 0) list[index] = { ...list[index], ...script };
    else list.push(script);
  }
  context.saveSettingsDebounced?.();
  return true;
}
