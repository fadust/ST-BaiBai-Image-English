import type { WorldInfoEntry } from '@/st/context';
import type { ExcludesSettings } from '@/state/settings';

/**
 * Lorebook entry filtering and ordering (exactly the same rules as BaiBai Book's engine.ts; keep both in sync when changing):
 *   - isWorldInfoEntryExcluded: whole-book exclusion (world on the list) + entry name (comment) matching any rule;
 *   - sortWorldInfoEntriesLikeST: orders activated entries the same way as ST's main prompt.
 * The lists come from shared storage (settings.excludes), the same copy BaiBai Book uses.
 */

/**
 * Decides whether an entry should be excluded: ① whole-book exclusion (world on the list); ② entry name (comment) matches any rule.
 * Rules compile as regexes, **case-insensitive** (entering mvu matches [MVU]); a plain name naturally works as a contains-match.
 * If compiling fails, it degrades to a literal substring match (case-insensitive), so a plain name containing metacharacters (e.g. "(temp)")
 * does no harm; it just becomes a substring comparison. Same logic as isWorldInfoEntryExcluded in BaiBai Book's engine.ts.
 */
export function isWorldInfoEntryExcluded(entry: WorldInfoEntry, excludes: ExcludesSettings): boolean {
  const world = entry.world?.trim();
  if (world && excludes.excludedWorldNames.includes(world)) return true;
  const comment = entry.comment?.trim();
  if (!comment) return false;
  for (const raw of excludes.excludedWorldInfoPatterns) {
    const pat = raw.trim();
    if (!pat) continue;
    let hit = false;
    try {
      hit = new RegExp(pat, 'i').test(comment);
    } catch {
      hit = comment.toLowerCase().includes(pat.toLowerCase()); // Invalid regex → degrade to literal substring match
    }
    if (hit) return true;
  }
  return false;
}

// Lorebook entry insertion positions (mirrors ST world_info_position; unknown values go to "other" at the end, so no entry is lost)
const WI_POSITION_BEFORE = 0;
const WI_POSITION_AT_DEPTH = 4;

// Bucket order: reproduces the order in which entry types appear in ST's main prompt (insertion order in openai.js populateChatCompletion):
// worldInfoBefore (0, before char) → worldInfoAfter (1, after char) → before author's note (2) → after author's note (3) → @depth (4) → EM top (5) → EM bottom (6)
// The outlet (7) position is set by the PromptManager template and has no fixed order, so it goes to "other" at the end.
const WI_BUCKET_ORDER: Record<number, number> = {
  0: 0, // before: before char
  1: 1, // after: after char
  2: 2, // ANTop: before author's note
  3: 3, // ANBottom: after author's note
  4: 4, // atDepth: @depth
  5: 5, // EMTop: EM top anchor
  6: 6, // EMBottom: EM bottom anchor
  7: 99, // outlet: no fixed position, always goes to "other"
};

/** Default Order of a new ST entry (world-info.js newWorldInfoEntryDefinition.order.default) */
const WI_DEFAULT_ORDER = 100;

/** Default depth of a new ST entry (newWorldInfoEntryDefinition.depth.default = DEFAULT_DEPTH) */
const WI_DEFAULT_DEPTH = 4;

/**
 * Orders activated entries the same way as ST's main prompt (ascending order within a bucket + buckets by appearance):
 * ST internally (end of world-info.js) "iterates by descending order + unshift to the front" → equivalent to ascending order within a position;
 * the allActivatedEntries we receive are in scan-hit order (Set/Map insertion order) without that step, so it is reproduced here.
 * Buckets follow the order they enter the main prompt (before char → after char → before/after author's note → @depth → EM);
 * within the @depth bucket, sort by depth descending (deeper entries appear earlier in the prompt), then by order ascending.
 * Missing position/order/depth fall back to ST defaults (0/100/4); unknown positions go to "other" at the end.
 * Same logic as sortWorldInfoEntriesLikeST in BaiBai Book's engine.ts.
 */
export function sortWorldInfoEntriesLikeST(entries: WorldInfoEntry[]): WorldInfoEntry[] {
  return [...entries].sort((a, b) => {
    const pa = WI_BUCKET_ORDER[Number(a.position ?? WI_POSITION_BEFORE)] ?? 99;
    const pb = WI_BUCKET_ORDER[Number(b.position ?? WI_POSITION_BEFORE)] ?? 99;
    if (pa !== pb) return pa - pb;
    // Both @depth: deeper entries appear first (farther from the conversation in the prompt)
    if (pa === WI_BUCKET_ORDER[WI_POSITION_AT_DEPTH]) {
      const da = Number(a.depth ?? WI_DEFAULT_DEPTH);
      const db = Number(b.depth ?? WI_DEFAULT_DEPTH);
      if (da !== db) return db - da;
    }
    // Within a bucket: ascending order (the equivalent result of ST's descending iteration + unshift); non-numeric/missing values default to 100
    const oa = Number.isFinite(a.order as number) ? Number(a.order) : WI_DEFAULT_ORDER;
    const ob = Number.isFinite(b.order as number) ? Number(b.order) : WI_DEFAULT_ORDER;
    return oa - ob;
  });
}
