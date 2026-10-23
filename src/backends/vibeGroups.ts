import type { NaiVibe } from '@/state/settings';

/**
 * Pure logic for vibe groups (gathering, search, enabled-set checks), kept apart from NaiPanel's rendering.
 *
 * A group is a label for "enable together / collapse together", not separate state: generation still only reads each entry's enabled
 * (filter(v => v.enabled) in backends/nai.ts); a group's bulk action is simply a bulk assignment of its members'
 * enabled flags, so no second source of truth is introduced.
 *
 * Group names are arbitrary user input and cannot be used directly as keys/sentinels (they could clash with "Ungrouped" or "New group"),
 * so every name is boxed with a `g:` prefix: anything prefixed is a real group; the bare values UNGROUPED/NEW_GROUP are always sentinels.
 */

export const GROUP_PREFIX = 'g:';
export const UNGROUPED = 'ungrouped';
export const NEW_GROUP = 'new';

/** Group name → boxed key (an empty name is the "Ungrouped" sentinel). */
export function groupKey(name: string): string {
  return name.trim() ? `${GROUP_PREFIX}${name.trim()}` : UNGROUPED;
}

export interface VibeGroup {
  /** Boxed key, used for v-for keys and the collapsed set. */
  key: string;
  /** Display name. */
  label: string;
  /** Real group name (empty string when ungrouped), used when reassigning groups in bulk. */
  name: string;
  /** Members matching the search, used only for rendering. */
  items: NaiVibe[];
  /**
   * All members of the group (unaffected by search). Bulk actions and counts always use this:
   * if "enable only this group" acted only on the search-matched subset, it would also turn off group entries hidden by the search;
   * silently changing things the user can't see is the hardest kind of bug to trace, so rendering and semantics use two separate lists.
   */
  all: NaiVibe[];
}

/** Search match: substring match on the name or group name (same rule as the settings page's exclusion lists, case-insensitive). */
export function matchVibe(vibe: Pick<NaiVibe, 'name' | 'group'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return vibe.name.toLowerCase().includes(q) || vibe.group.toLowerCase().includes(q);
}

/**
 * Gathers by group. Order: named groups by first appearance in the library; "Ungrouped" always last,
 * since it isn't a group, just a holding area for uncategorised items; putting it first would look like a default group.
 *
 * Groups with no member matching the search don't appear; matching groups carry their full membership (all).
 */
export function groupVibes(vibes: readonly NaiVibe[], query = ''): VibeGroup[] {
  const map = new Map<string, VibeGroup>();
  for (const vibe of vibes) {
    if (!matchVibe(vibe, query)) continue;
    const name = vibe.group.trim();
    const key = groupKey(name);
    let group = map.get(key);
    if (!group) {
      group = { key, label: name || 'Ungrouped', name, items: [], all: [] };
      map.set(key, group);
    }
    group.items.push(vibe);
  }
  // Collect full membership separately: only added to groups that already appear, so groups unmatched by the search don't appear out of nowhere
  for (const vibe of vibes) {
    map.get(groupKey(vibe.group))?.all.push(vibe);
  }
  const groups = [...map.values()];
  return [...groups.filter(g => g.name), ...groups.filter(g => !g.name)];
}

/**
 * "Active" isn't stored; it's computed: true only when the current enabled set exactly equals all members of this group.
 * So when the user manually checks one more, it disappears by itself, never showing a misleading "active" that isn't true.
 * An empty group doesn't count as active (otherwise with an empty library every empty group would show active).
 */
export function isGroupActive(group: VibeGroup, vibes: readonly NaiVibe[]): boolean {
  if (!group.all.length) return false;
  const ids = new Set(group.all.map(v => v.id));
  return vibes.every(v => v.enabled === ids.has(v.id));
}
