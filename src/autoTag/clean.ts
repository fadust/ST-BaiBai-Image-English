/**
 * Story-text cleanup helpers (exactly the same rules as stripCustomTags in BaiBai Book's timeTag.ts; keep both in sync when changing).
 * The list comes from shared storage (settings.excludes.customStripTags) and is sanitised by sanitizeTagName on input;
 * this module only builds the "remove whole block" regexes from tag names and runs them.
 */

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;
const RE_START = /<bbs_start\b[^>]*>([\s\S]*?)<\/bbs_start>/gi;
const RE_END = /<bbs_end\b[^>]*>([\s\S]*?)<\/bbs_end>/gi;

/**
 * Builds a "remove whole block" regex for a tag name (the tag itself plus its contents). The tag has had regex metacharacters
 * removed by sanitizeTagName, so it is safe inside a RegExp. The boundary uses the lookahead (?=[\s/>]) rather than \b: \b only knows
 * ASCII word characters, so a CJK tag (e.g. <雪>) has no word boundary between `雪` and `>` and would fail to match. The lookahead
 * "tag name must be followed by whitespace, slash or closing bracket" works for both CJK and Latin names,
 * and still stops <snow> from eating the <snowball> prefix. Removes paired blocks as well as stray self-closing/single tags.
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // Paired blocks
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // Stray open/close/self-closing tags
  ];
}

/** Removes the custom tags the user configured in settings (whole block: tag + inner content). Returns unchanged for an empty list. */
function replaceCustomTags(s: string, tags: string[], replacement: string): string {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, replacement);
  }
  return out;
}

export function stripCustomTags(s: string, tags: string[]): string {
  return replaceCustomTags(s, tags, '');
}

/** Removes BaiBai Book's managed trailing side-note blocks (bbs_items/bbs_vars, open/close tags paired on their own lines). */
function stripManagedBlock(s: string, tag: string): string {
  const openRe = new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, 'm');
  const closeRe = new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, 'm');
  let out = s;
  let open: RegExpMatchArray | null;
  while ((open = out.match(openRe))) {
    const start = open.index ?? 0;
    const rest = out.slice(start + open[0].length);
    const close = rest.match(closeRe);
    if (!close) {
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close.index ?? 0) + close[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function stripManagedTags(s: string): string {
  return stripManagedBlock(stripManagedBlock(s, 'bbs_items'), 'bbs_vars');
}

function clampToStoryBody(
  mes: string,
  tags: string[],
  preserveImageTags: boolean,
  noiseReplacement = '',
): string {
  const customTags = preserveImageTags
    ? tags.filter(tag => tag.toLowerCase() !== 'bbi_image')
    : tags;
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, noiseReplacement)
    .replace(/<!--[\s\S]+?-->/g, noiseReplacement)
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, noiseReplacement);
  s = replaceCustomTags(s, customTags, noiseReplacement);
  s = stripManagedTags(s);

  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let match = startRe.exec(s); match; match = startRe.exec(s)) lastStart = match.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  const endMatch = s.match(/<\/bbs_end>/i);
  if (endMatch?.index !== undefined) s = s.slice(0, endMatch.index + endMatch[0].length);

  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** History floors use the same rule as BaiBai Book's cleanBody; this plugin's bbi_image must be kept so character appearance can carry over. */
export function cleanHistoryText(mes: string, tags: string[]): string {
  return clampToStoryBody(mes, tags, true)
    .replace(RE_START, (_, value) => `(Start time:${String(value).trim()})`)
    .replace(RE_END, (_, value) => `(End time:${String(value).trim()})`);
}

interface RemovalRange {
  start: number;
  end: number;
}

interface SourceLineRange {
  index: number;
  start: number;
  end: number;
}

export interface TargetSegment {
  /** Short position ID sent to the model. */
  id: string;
  /** Physical line number in the original text (0-based, plugin-internal only). */
  sourceLine: number;
  /** The line's narrative text with noise removed. */
  text: string;
}

export interface PreparedTargetText {
  /** Target text with position IDs at the end of paragraphs. */
  promptText: string;
  /** Stable mapping from position ID to original physical line. */
  segments: TargetSegment[];
}

function rangesForRegex(source: string, pattern: RegExp): RemovalRange[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  return [...source.matchAll(regex)]
    .filter(match => match.index !== undefined && match[0].length > 0)
    .map(match => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function mergeRanges(ranges: RemovalRange[]): RemovalRange[] {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RemovalRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function maskedSource(source: string, ranges: RemovalRange[]): string {
  if (!ranges.length) return source;
  const chars = source.split('');
  for (const range of mergeRanges(ranges)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function sourceLineRanges(source: string): SourceLineRange[] {
  const lines: SourceLineRange[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let index = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ index, start, end: match.index });
    start = match.index + match[0].length;
    index += 1;
  }
  lines.push({ index, start, end: source.length });
  return lines;
}

function retainedLineText(source: string, line: SourceLineRange, ranges: RemovalRange[]): string {
  const pieces: string[] = [];
  let cursor = line.start;
  for (const range of ranges) {
    if (range.end <= line.start) continue;
    if (range.start >= line.end) break;
    if (range.start > cursor) pieces.push(source.slice(cursor, Math.min(range.start, line.end)));
    cursor = Math.max(cursor, range.end);
    if (cursor >= line.end) break;
  }
  if (cursor < line.end) pieces.push(source.slice(cursor, line.end));
  return pieces.join(' ').replace(/[ \t]+/g, ' ').trim();
}

function targetRemovalRanges(source: string, tags: string[]): RemovalRange[] {
  const noise: RemovalRange[] = [
    ...rangesForRegex(source, RE_THINK_BLOCK),
    ...rangesForRegex(source, /<!--[\s\S]+?-->/g),
    ...rangesForRegex(source, /<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi),
  ];
  for (const tag of [...tags, 'bbs_items', 'bbs_vars']) {
    if (!tag) continue;
    for (const regex of blockStripRegexes(tag)) noise.push(...rangesForRegex(source, regex));
  }

  const masked = maskedSource(source, noise);
  const crop: RemovalRange[] = [];
  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let match = startRe.exec(masked); match; match = startRe.exec(masked)) lastStart = match.index;
  if (lastStart >= 0) crop.push({ start: 0, end: lastStart });

  const bodyStart = Math.max(0, lastStart);
  const endMatch = masked.slice(bodyStart).match(/<\/bbs_end>/i);
  const bodyEnd = endMatch?.index === undefined
    ? source.length
    : bodyStart + endMatch.index + endMatch[0].length;
  if (bodyEnd < source.length) crop.push({ start: bodyEnd, end: source.length });

  // Match BaiBai Book's order: crop to the story time range before removing time tags.
  // A format example before the story must not pair with the real closing tag and swallow the prose.
  const timeTags: RemovalRange[] = [];
  const body = masked.slice(bodyStart, bodyEnd);
  for (const tag of ['bbs_start', 'bbs_end']) {
    for (const regex of blockStripRegexes(tag)) {
      timeTags.push(...rangesForRegex(body, regex).map(range => ({
        start: bodyStart + range.start,
        end: bodyStart + range.end,
      })));
    }
  }
  return mergeRanges([...noise, ...crop, ...timeTags]);
}

/**
 * Removes the same noise and time tags from the target text, and appends a paragraph-end position ID only to the non-empty physical lines kept.
 * Each ID stores the original sourceLine directly, so the model no longer has to copy the original text, and nothing depends on looking up the cleaned text.
 */
export function prepareTargetText(mes: string, tags: string[]): PreparedTargetText {
  const source = String(mes ?? '');
  const ranges = targetRemovalRanges(source, tags);
  const segments = sourceLineRanges(source)
    .map(line => ({ sourceLine: line.index, text: retainedLineText(source, line, ranges) }))
    .filter(segment => !!segment.text)
    .map((segment, index) => ({ id: `P${index + 1}`, ...segment }));
  return {
    promptText: segments.map(segment => `${segment.text} ⟦${segment.id}⟧`).join('\n\n'),
    segments,
  };
}

/** Cleaned target text without position markers, for debugging/tests. */
export function cleanTargetText(mes: string, tags: string[]): string {
  return prepareTargetText(mes, tags).segments.map(segment => segment.text).join('\n\n');
}
