import type { VNode } from 'vue';

/**
 * Mount registry for floor cards (DESIGN-FLOOR-UI.md §6.2).
 *
 * key = (chatId, mesid, swipeId, seq):
 * - mesid locates the message (floor); seq locates the Nth anchor in it (DOM order = tag index).
 * - swipeId is part of the key so each swipe's records stay separate when swiping.
 * - On re-hydration, slots at the same anchor are patched in place (hydrate.ts diff strategy); when the anchor changes or
 *   the slot disappears, the old vnode must be unmounted explicitly with render(null, container) before mounting the new tree.
 */
export interface SlotRecord {
  /**
   * Render container of the vnode: the anchor div's shadow root (hydrate.ts calls attachShadow on each anchor
   * to isolate the card and ST's global styles from each other). Unmount with render(null, container).
   */
  container: ShadowRoot;
  vnode: VNode;
}

export class SlotRegistry {
  private records = new Map<string, SlotRecord>();

  key(chatId: string | undefined, mesid: number, swipeId: number | undefined, seq: number): string {
    return `${chatId ?? '-'}|${mesid}|${swipeId ?? '-'}|${seq}`;
  }

  /** All slot keys of a message (across swipeIds). Used to clear old records before re-hydrating that message. */
  keysByMessage(chatId: string | undefined, mesid: number): string[] {
    const prefix = `${chatId ?? '-'}|${mesid}|`;
    return [...this.records.keys()].filter(key => key.startsWith(prefix));
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  get(key: string): SlotRecord | undefined {
    return this.records.get(key);
  }

  set(key: string, record: SlotRecord): void {
    this.records.set(key, record);
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  /** All records (iterated when unmounting). */
  all(): SlotRecord[] {
    return [...this.records.values()];
  }

  /** All keys (iterated when unmounting). */
  keys(): string[] {
    return [...this.records.keys()];
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
