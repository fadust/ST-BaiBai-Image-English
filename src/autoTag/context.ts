import type { STContext, STMessage, WorldInfoEntry } from '@/st/context';
import { getCheckWorldInfo, getContext, getEjsTemplate } from '@/st/context';
import { isWorldInfoEntryExcluded, sortWorldInfoEntriesLikeST } from '@/autoTag/excludes';
import { stripCustomTags } from '@/autoTag/clean';
import { settings } from '@/state/settings';

/**
 * Context assembly for standalone requests: lorebook / character card description / user persona.
 * The logic matches BaiBai Book (fetchWorldInfo / fetchCharCard / fetchUserPersona in src/memory/engine.ts).
 * BaiBai Book has already hit the pitfalls in production, so the secondary API reuses the same rules:
 *   - lorebook: checkWorldInfo returns entry objects → expand macros per entry (+ run EJS via ST-Prompt-Template) → separate system message;
 *   - character card: description/personality/scenario of characters[characterId];
 *   - persona: the {{persona}} macro.
 * If any block can't be fetched → return an empty string; the main flow is unaffected.
 */

/* ============ Scan-text cleanup (matches the core behaviour of BaiBai Book's clampToTimeTags) ============ */

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;

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
      // Stray open tag: remove only the tag itself, keep the content
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

/**
 * Lorebook scan-text cleanup: removes noise tags as whole blocks, then trims to the <bbs_start>…</bbs_end> story section.
 * Same rule as BaiBai Book's clampToTimeTags (including its user-defined tag configuration; the list uses shared storage).
 */
function cleanScanText(mes: string): string {
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, '') // Thought chain
    .replace(/<!--[\s\S]+?-->/g, '') // HTML comments
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, ''); // Old horae format
  s = stripCustomTags(s, settings.excludes.customStripTags); // User-defined tags (same list as BaiBai Book)
  s = stripManagedTags(s);

  // Position of the last <bbs_start>: scan globally and take the final occurrence
  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let m = startRe.exec(s); m; m = startRe.exec(s)) lastStart = m.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  // The first </bbs_end> (searched in the string already trimmed of its prefix)
  const endMatch = s.match(/<\/bbs_end>/i);
  if (endMatch && endMatch.index !== undefined) {
    s = s.slice(0, endMatch.index + endMatch[0].length);
  }
  // Normalise whitespace
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============ Lorebook ============ */

/** Deduplicates and joins segments after removing empty ones. Every lorebook activation source funnels through here (same as BaiBai Book). */
function joinWorldInfoChunks(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const t = c?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join('\n\n').trim();
}

/**
 * Text to scan this round: each floor's text cleaned, with a speaker-name prefix to help keywords hit character names.
 * Same shape as BaiBai Book's buildScanText.
 */
function buildScanText(chat: STMessage[], targets: number[], name1: string, name2: string): string[] {
  return targets
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      return `${who}: ${cleanScanText(m.mes)}`;
    })
    .filter(Boolean);
}

// ST internally: the real WI budget = world_info_budget (default 25%) × maxContext; entries beyond it are cut (blue-light ones included).
// Summarisation needs "not one activated entry missed", so a huge maxContext is passed, making the budget too large to overflow.
const HUGE_WI_CONTEXT = 1_000_000_000;

/**
 * Renders lorebook entry content so the secondary API gets the "executed" result rather than the raw text:
 *   ① substituteParams expands {{macros}};
 *   ② if ST-Prompt-Template (the prompt template plugin) is installed and the text contains <% %>, its executor runs EJS.
 * Reproduces the order of BaiBai Book's renderWorldInfoContent (macros first, then EJS).
 */
async function renderWorldInfoContent(
  content: string,
  entry: WorldInfoEntry | undefined,
  floor: number | undefined,
): Promise<string> {
  const ctx = getContext();
  // ① Expand macros (keep the raw text when substituteParams doesn't exist)
  let text = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(content) : content;
  // ② Without EJS tags the template plugin needn't be called (saving prepareContext/sandbox overhead)
  if (!text.includes('<%')) return text;
  const ejs = getEjsTemplate();
  if (!ejs) return text; // ST-Prompt-Template not installed: only macros were expanded
  try {
    // Second argument end=floor: evaluates getvar against the variable snapshot "as of that floor"; when undefined the API defaults to the latest floor
    const env = await ejs.prepareContext({ world_info: entry }, floor);
    const out = await ejs.evalTemplate(text, env);
    if (typeof out === 'string') text = out;
  } catch (e) {
    console.log('[BaiBai Image] World Info EJS rendering failed (unexecuted text returned):', e);
  }
  return text;
}

/**
 * Fallback path: uses ST's exposed getWorldInfoPrompt (only a pre-joined string).
 * Only used when checkWorldInfo is unavailable: no entry objects, so no per-entry rendering, but the request still carries the lorebook without crashing.
 * Blue-light/relevant entries may land in before, after, depth (@depth) or author's note; all are extracted.
 */
async function fetchWorldInfoViaPrompt(
  scanText: string[],
  refFloor: number | undefined,
): Promise<string> {
  const fn = getContext()?.getWorldInfoPrompt;
  if (typeof fn !== 'function') return '';
  const res = await fn(scanText, HUGE_WI_CONTEXT, true);
  if (!res) return '';
  const chunks: string[] = [];
  if (typeof res.worldInfoBefore === 'string') chunks.push(res.worldInfoBefore);
  if (typeof res.worldInfoAfter === 'string') chunks.push(res.worldInfoAfter);
  for (const d of res.worldInfoDepth ?? []) {
    for (const e of d?.entries ?? []) if (typeof e === 'string') chunks.push(e);
  }
  for (const e of res.anBefore ?? []) if (typeof e === 'string') chunks.push(e);
  for (const e of res.anAfter ?? []) if (typeof e === 'string') chunks.push(e);
  // Render block by block (macros + EJS); this path has no entry objects, so EJS only gets the current state context (no world_info), but variables are still read at refFloor
  const rendered = await Promise.all(chunks.map(c => renderWorldInfoContent(c, undefined, refFloor)));
  return joinWorldInfoChunks(rendered);
}

/**
 * Activates lorebook entries from this round's scan text (keyword triggers + constant blue-light entries) and returns the settings text.
 * Prefers checkWorldInfo: it returns **entry objects**, which can be rendered entry by entry (macros + EJS),
 * and filtered by "whole-book exclusion" + "entry-name rules" (shared-storage lists, same rule as BaiBai Book) to drop unwanted entries.
 * checkWorldInfo unavailable (old version/path change) → falls back to getWorldInfoPrompt (no filtering, but at least carries the book without crashing).
 * No activated entries / character card without a lorebook / error → returns an empty string (the main flow is unaffected).
 */
export async function fetchWorldInfo(
  chat: STMessage[],
  targets: number[],
  name1: string,
  name2: string,
): Promise<string> {
  const scanText = buildScanText(chat, targets, name1, name2);
  if (!scanText.length) return '';
  // Floor representing the variable timepoint: the **last target floor** of this batch. getvar in EJS reads that floor's historical variable snapshot.
  const refFloor = targets.length ? targets[targets.length - 1] : undefined;
  try {
    const check = await getCheckWorldInfo();
    if (!check) return fetchWorldInfoViaPrompt(scanText, refFloor);

    const res = await check(scanText, HUGE_WI_CONTEXT, true);
    const activated = res?.allActivatedEntries;
    if (!activated) return '';
    // allActivatedEntries may be a Set<entry> or Map<key,entry>; take values either way;
    // then order them like ST's main prompt (scan-hit order has no sorting; same rule as BaiBai Book),
    // then filter by the shared exclusion lists (whole book/entry name), and finally render each entry (macros + EJS).
    const entries = sortWorldInfoEntriesLikeST(
      activated instanceof Map ? [...activated.values()] : [...activated],
    );
    const chunks = await Promise.all(
      entries
        .filter(e => e && !isWorldInfoEntryExcluded(e, settings.excludes))
        .map(e => renderWorldInfoContent(typeof e.content === 'string' ? e.content : '', e, refFloor)),
    );
    return joinWorldInfoChunks(chunks);
  } catch (e) {
    console.log('[BaiBai Image] World Info activation failed (downgraded to no settings):', e);
    return '';
  }
}

/* ============ Character card description + user persona (same as BaiBai Book's fetchCharCard / fetchUserPersona) ============ */

/**
 * Gets the current character card's persona fields (description / personality / scenario).
 * Some cards put the persona in the character description rather than a lorebook, and tag generation also needs it to understand the character's looks and behaviour.
 *   - all three fields are tried; empty ones are skipped automatically;
 *   - fields may contain {{char}}/{{user}} macros, expanded with substituteParams;
 *   - group chats (empty characterId) are left out for now: merging multiple members is complex; same as BaiBai Book.
 * Character unavailable / all empty → returns an empty string (degrades; the main flow is unaffected).
 */
export function fetchCharCard(context: STContext): string {
  if (!context || context.groupId) return ''; // Group chats left out for now
  const idx = context.characterId;
  if (idx === undefined || idx === null || idx === '') return '';
  const ch = context.characters?.[Number(idx)] as Record<string, unknown> | undefined;
  if (!ch) return '';
  const sub = typeof context.substituteParams === 'function' ? context.substituteParams : (s: string) => s;
  const fields: Array<[string, string]> = [
    ['Description', String(ch.description ?? '')],
    ['Personality', String(ch.personality ?? '')],
    ['Scenario', String(ch.scenario ?? '')],
  ];
  const parts: string[] = [];
  for (const [label, raw] of fields) {
    const t = sub(raw).trim();
    if (t) parts.push(`【${label}】\n${t}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * Gets the current user persona (persona / user settings).
 * Uses ST's stable macro {{persona}} (= power_user.persona_description), expanded with substituteParams;
 * doesn't dig into the global power_user, keeping "only touch the host through context".
 * Tag generation needs to know who the protagonist is (appearance/identity), otherwise the protagonist in the image can only be guessed.
 * No persona set / unavailable → empty string (degrades; the main flow is unaffected).
 */
export function fetchUserPersona(context: STContext): string {
  if (!context || typeof context.substituteParams !== 'function') return '';
  return context.substituteParams('{{persona}}').trim();
}

/* ============ System message wrappers (same text as the build*System functions in BaiBai Book's prompts.ts) ============ */

/** Wraps the lorebook settings as the content of a separate system message (callers should skip it when empty) */
export function buildWorldInfoSystem(worldInfo: string): string {
  return `【World setting (activated lorebook; read-only reference)】
Be sure to be consistent with the following settings, and do not make up contradictory content; but the setting itself is not what happened this round, so do not write it into the output.

${worldInfo.trim()}`;
}

/** Wraps the character card description as a separate system message (some cards put the persona in the description rather than a lorebook, and tag generation needs it to understand the character). */
export function buildCharCardSystem(charCard: string): string {
  return `【Character setting (character card; read-only reference)】
The following is the character setting of the current character, which is used to help you understand the appearance, words and deeds of the character; it is not something that happened this round, so do not write it into the output.

${charCard.trim()}`;
}

/** Wraps the user persona as a separate system message (to understand "who the protagonist is"). */
export function buildPersonaSystem(persona: string): string {
  return `【Protagonist persona (user-controlled protagonist; read-only reference)】
The following is the character setting of the protagonist (i.e. the "User/User" side in the dialogue) to help you understand the identity and appearance of the protagonist; it does not happen in this round, so do not write it into the output.

${persona.trim()}`;
}
