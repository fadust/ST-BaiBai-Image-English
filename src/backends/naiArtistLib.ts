import type { NaiArtistPreset } from '@/state/settings';

/**
 * Pure logic for managing the artist-string library (search matching / planning the replacement after deletion).
 * Decoupled from interaction for unit testing; NaiArtistManager.vue only handles interaction and saving.
 */

/**
 * Search matching: name + artist-string content, case-insensitive substring match; an empty query always matches (= no filter).
 * Bound positive/negative tags are excluded: users remember a style by its name and its artist tags,
 * and the wider the match surface, the more surprises like "why does this match too" against "I clearly searched for it".
 */
export function matchArtist(
  preset: Pick<NaiArtistPreset, 'name' | 'prompt'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return preset.name.toLowerCase().includes(q) || preset.prompt.toLowerCase().includes(q);
}

export interface ArtistRemovalPlan {
  /** Library after deletion (original order kept). */
  remaining: NaiArtistPreset[];
  /** Entries actually deleted (the caller cleans up their preview image files). */
  removed: NaiArtistPreset[];
  /**
   * activeArtistId after deletion: current entry untouched → unchanged;
   * current entry deleted → the entry now at its position takes over (or the previous one if it was last); library empty → '' (= none).
   * Same takeover rule as single deletion in NaiPanel; deliberately does **not** fall back to [0] (a silent style switch is impossible to trace).
   */
  nextActiveId: string;
}

/**
 * Plans one deletion (shared by single and bulk). Entries outside removedIds are untouched;
 * activeId is kept as-is if it is not in the deletion set (built-in bi_* entries are never in it; the manager gives them no checkbox).
 */
export function planArtistRemoval(
  list: readonly NaiArtistPreset[],
  removedIds: ReadonlySet<string>,
  activeId: string,
): ArtistRemovalPlan {
  const removed = list.filter(a => removedIds.has(a.id));
  const remaining = list.filter(a => !removedIds.has(a.id));
  let nextActiveId = activeId;
  if (removedIds.has(activeId)) {
    const index = list.findIndex(a => removedIds.has(a.id));
    nextActiveId = remaining[Math.min(index, remaining.length - 1)]?.id ?? '';
  }
  return { remaining, removed, nextActiveId };
}
