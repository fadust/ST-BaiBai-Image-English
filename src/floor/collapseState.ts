import { reactive } from 'vue';

/**
 * Module-level store for the "collapsed" state of floor cards.
 *
 * Why it must live outside the component: same reason as genState.ts. Card lifetimes are decided by hydration; swiping,
 * editing a message and ST re-rendering floors all change anchors and unmount/remount components. If collapsed state lived in a component ref,
 * images the user collapsed would pop open again. The key has the same shape as genState/registry (chatId|messageId|swipeId|seq),
 * so a rebuilt card reclaims its own collapsed state by key.
 *
 * Why not message.extra: collapsing is temporary-concealment UI state, not data. Writing extra would mean
 * a saveChat() on every collapse/expand, wrong in both cost and meaning. Remembering it for the session is enough;
 * after a reload it falls back to the setting "Collapse floor images by default" (settings.ui.autoCollapseImages).
 *
 * No active cleanup: each slot holds a single boolean, so leftovers from old chats/deleted slots are negligible;
 * and keeping the state when switching chats and back is actually what users expect.
 */

/** Slots whose collapsed state was set explicitly; others fall back to the "collapse by default" setting. */
const collapsed = reactive(new Map<string, boolean>());

/** Current collapsed state: a manual setting wins, otherwise the default (setting "Collapse floor images by default"). */
export function isCollapsed(key: string, defaultCollapsed: boolean): boolean {
  return collapsed.get(key) ?? defaultCollapsed;
}

/** Manually set collapsed/expanded (overrides the default, valid for the session). */
export function setCollapsed(key: string, value: boolean): void {
  collapsed.set(key, value);
}
