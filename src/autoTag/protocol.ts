import { normalizeOrientation, type Orientation } from '@/backends/size';
import type { TargetSegment } from '@/autoTag/clean';
import { FORBIDDEN_SUBTAG, serializeImageTag } from '@/st/imageTagRegex';
import {
  CHAR_TAG_FIELDS,
  type CharTagField,
  type CharTagHistoryField,
} from '@/state/charTags';

export interface ImageCharacterPrompt {
  name: string;
  tag: string;
  nl: string;
}

export interface ImageInsertion {
  /** Target story-text position ID chosen by the model. */
  position: string;
  /** Original physical line for the position ID (0-based, plugin-internal only). */
  sourceLine: number;
  /** Short danbooru tag part (required). */
  tag: string;
  /** Natural-language part (optional; output by the model when ComfyUI "Generate Natural Language" is on). */
  nl: string;
  /** Per-image dynamic negative tags (optional; only requested when the ComfyUI workflow uses %negative_prompt%). */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** Frame orientation: the model only decides landscape/portrait; exact pixels are configured by the user in the backend panel. Missing or invalid values fall back to portrait. */
  size: Orientation;
}

export interface ImagePlan {
  images: ImageInsertion[];
  /** Character library changes reported by the AI (profile creation/field updates); the caller applies them. */
  changes: CharChange[];
}

/** A single character change output by the AI (loose shape; kept only if every field parses as valid). */
export interface CharChange {
  name: string;
  /** 'new' = create profile; otherwise a field name/whole string/natural language. */
  field: CharTagHistoryField;
  value: string;
  /** Natural-language appearance sentence (may accompany a 'new' profile). */
  nl?: string;
  reason: string;
  /**
   * Position where a permanent change takes effect. Profile creation (new) is exempt: a character's fixed appearance holds
   * for the whole floor and is not a change "starting somewhere"; here it is only recorded and used for ordering.
   */
  position: string;
  /** Original physical line for position (0-based, plugin-internal only). */
  sourceLine: number;
}

const HISTORY_FIELDS: ReadonlySet<string> = new Set([
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
  'new',
  'raw',
  'nl',
]);

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(cleaned);

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function parseObject(raw: string): Record<string, unknown> {
  for (const candidate of jsonObjects(raw)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate JSON block.
    }
  }
  throw new Error('AI did not return a parsable JSON object');
}

/** Sub-tag literals not allowed inside tag / nl / negative content (rules in st/imageTagRegex.ts). */

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} Must not contain bbi_image/tag/nl/negative/size tag`);
  }
  return text;
}

function sanitizeCharacters(value: unknown, imageIndex: number): ImageCharacterPrompt[] {
  if (!Array.isArray(value)) return [];
  const characters: ImageCharacterPrompt[] = [];
  for (let index = 0; index < value.length && characters.length < 32; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    try {
      const name = sanitizeContent(item.name, `characters[${index}].name`, imageIndex);
      const tag = sanitizeContent(item.tag ?? item.prompt, `characters[${index}].tag`, imageIndex);
      const nl = sanitizeContent(item.nl, `characters[${index}].nl`, imageIndex);
      if (name && tag) characters.push({ name, tag, nl });
    } catch {
      // A malformed character prompt must not discard an otherwise valid image plan.
    }
  }
  return characters;
}

function sanitizePosition(value: unknown, index: number): string {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!position) throw new Error(`images[${index}].position cannot be empty`);
  if (!/^P\d+$/.test(position)) throw new Error(`images[${index}].position must be the P number in the target body`);
  return position;
}

/**
 * Parses and strictly validates the model's list of "target position ID + prompt". tag is required; nl/negative optional.
 * size is always tolerated: if it can't be normalised it is treated as portrait; throwing over it would waste the runner's retries.
 * Images beyond the maximum are truncated locally; fewer than the minimum the user explicitly set throws, handing it to the runner to retry.
 * changes are tolerated throughout: a bad item is dropped and never affects images; missing one character profile only means that character
 * isn't anchored this round, while discarding the whole output for it would lose the images too, which is worse.
 */
export function parseImagePlan(
  raw: string,
  segments: TargetSegment[],
  minImages: number,
  maxImages: number,
): ImagePlan {
  const parsed = parseObject(raw);
  const sourceText = segments.map(segment => segment.text).join('\n');
  if (!Array.isArray(parsed.images)) throw new Error('AI returned JSON missing images array');
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`images[${index}].position=${position} Not in target body optional position`);
    }
    // Tolerates models returning a prompt key per the old protocol/habit
    const tag = sanitizeContent(entry.tag ?? entry.prompt, 'tag', index);
    if (!tag) throw new Error(`images[${index}].tag cannot be empty`);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    const negative = sanitizeContent(entry.negative ?? entry.negative_prompt, 'negative', index);
    const characters = sanitizeCharacters(entry.characters, index);
    for (const character of characters) character.name = sourceName(character.name, sourceText);
    // Tolerates models returning orientation / aspect keys out of habit
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    images.push({ position, sourceLine, tag, nl, negative, characters, size });
  }

  const limitedImages = images.slice(0, normalizedMax);
  if (limitedImages.length < normalizedMin) {
    throw new Error(
      `AI returned ${limitedImages.length} pictures, less than the minimum number of pictures set ${normalizedMin}`,
    );
  }

  return {
    images: limitedImages,
    changes: parseChanges(parsed.changes, positions).map(change => ({
      ...change,
      name: sourceName(change.name, sourceText),
    })),
  };
}

// Models often straighten apostrophes or lowercase names; recover only an unambiguous source spelling.
function sourceName(name: string, source: string): string {
  if (source.includes(name)) return name;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['‘’]/g, "['‘’]").replace(/[-‐‑–—]/g, '[-‐‑–—]');
  const matches = new Set(source.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu')) ?? []);
  return matches.size === 1 ? [...matches][0] : name;
}

/**
 * Parses where a change takes effect. A profile creation (new) without a position is not an error: it applies to the whole floor anyway;
 * if unparseable it falls back to the first position, used only for ordering.
 */
function parsePosition(
  value: unknown,
  positions: Map<string, number>,
): { position: string; sourceLine: number } | null {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^P\d+$/.test(position)) return null;
  const sourceLine = positions.get(position);
  if (sourceLine === undefined) return null;
  return { position, sourceLine };
}

function firstPosition(positions: Map<string, number>): { position: string; sourceLine: number } {
  for (const [position, sourceLine] of positions) return { position, sourceLine };
  return { position: '', sourceLine: 0 };
}

/** Profile creation fields: hair and eyes are the identity anchors of anime characters; if either is missing the profile is unusable (the caller discards it). */
function parseNewFields(raw: Record<string, unknown>): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  if (!fields.hair || !fields.eyes) return null;
  return JSON.stringify(fields);
}

function parseChanges(raw: unknown, positions: Map<string, number>): CharChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CharChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const fieldRaw = typeof o.field === 'string' ? o.field.trim() : '';
    if (!name || !HISTORY_FIELDS.has(fieldRaw)) continue;
    const field = fieldRaw as CharTagHistoryField;
    const parsedPosition = parsePosition(o.position ?? o.at, positions);
    // Profile creation applies to the whole floor and the position is only recorded, falling back to the first if missing; a permanent change must know where it takes effect, so a bad position = discarded
    if (!parsedPosition && field !== 'new') continue;
    const { position, sourceLine } = parsedPosition ?? firstPosition(positions);
    let value = typeof o.value === 'string' ? o.value.trim() : '';
    const fields =
      o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
        ? (o.fields as Record<string, unknown>)
        : null;
    if (field === 'new') {
      const parsedFields = fields ? parseNewFields(fields) : null;
      if (!parsedFields) continue;
      value = parsedFields;
    }
    const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!value && !nl) continue;
    out.push({ name, field, value, nl: nl || undefined, reason, position, sourceLine });
  }
  return out;
}

/** Keeps the original text and its line breaks unchanged, inserting tags only after the source line of the position ID the model chose. */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    if (!Number.isInteger(image.sourceLine) || image.sourceLine < 0 || image.sourceLine >= lines.length) {
      throw new Error(`Location ${image.position} The corresponding original physical row has expired`);
    }
    const line = image.sourceLine;
    const list = byLine.get(line) ?? [];
    list.push(image);
    byLine.set(line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // For the serialisation rule see serializeImageTag in st/imageTagRegex.ts (shared with the manual editor dialog;
    // if the two drifted, "parsed fields" and "raw text written to the story" wouldn't match, and promptHash hashes the raw text).
    for (const image of inserted) {
      output += `${insertedEol}${serializeImageTag(image)}`;
    }
    output += line.eol;
  }
  return output;
}
