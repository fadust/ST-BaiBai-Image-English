/**
 * Criteria for "is the card still alive" (pure functions, easy to unit test).
 *
 * Background: the anchor `<div data-bbi-slot>` lives **inside** the floor's `.mes_text`, and ST has several
 * paths that rewrite `.mes_text` wholesale, a good number of which **fire no event at all**:
 * - `updateMessageBlock` (script.js) `.mes_text.html(...)`, no event;
 * - `.mes_text.empty()` in `messageEditCancel` / `messageEditDone`;
 * - `.mes_text.html('...')` during swipe-right generation;
 * - third-party plugins (prompt-template types) calling `container.html(newContent)` in their own render hooks.
 * Purely event-driven hydration misses all of these: the anchor is deleted along with its shadow root and the card vanishes,
 * while genState is module-level, so in-flight generation finishes anyway; users see exactly "the image is generating, but the floor has no UI".
 *
 * The other kind is **not deleted, but invisible**: `.mes_text.inline_media { display:none }` (style.css).
 * Whenever this floor's `extra.media` is non-empty and `extra.inline_image === false`, ST gives `.mes_text`
 * the `inline_media` class, hiding the whole text (our cards included). ST's native image extension and captioning extensions
 * both write this combination. In that case the anchor and shadowRoot exist, and remounting any number of times won't help.
 *
 * So there are two verdicts with different remedies:
 * - `detached`: the anchor left the document → re-hydrate this floor (rebuild anchor relations and remount cards);
 * - `hidden-by-host`: the anchor exists but an ancestor is hidden by host CSS → remounting is useless; the hiding must be lifted.
 */

/** Health-check verdict for one mounted slot. */
export type SlotHealth = 'ok' | 'detached' | 'hidden-by-host';

/**
 * The class the host adds when hiding the whole `.mes_text` (`display:none` in style.css).
 * Only this one is recognised: users' custom CSS varies endlessly and can't be enumerated; `display` on the host is the fallback
 * (see pinHostDisplay).
 */
export const HOST_HIDE_CLASS = 'inline_media';

/**
 * Health-checks one anchor. Pass the anchor element itself as `host` (i.e. the shadow root's host).
 *
 * Mind the order: check detached first. On a detached element `closest()` can still walk up the disconnected subtree
 * and may really find a `.mes_text` with the class (the copy ST swapped out). Checking hidden first
 * would misreport "a floor already deleted" as "hidden", so it neither remounts nor helps, changing the class of a node
 * that isn't in the document, and the card never comes back.
 */
export function checkSlotHealth(host: Element | null | undefined): SlotHealth {
  if (!host || !host.isConnected) return 'detached';
  const mesText = host.closest('.mes_text');
  if (mesText?.classList.contains(HOST_HIDE_CLASS)) return 'hidden-by-host';
  return 'ok';
}

/**
 * Finds the floor number (`.mes[mesid]`) an anchor belongs to. Returns null if not found.
 * Self-healing only remounts **the affected floor**, never a full rebuild: a full rebuild runs
 * parseImageTags + readStore + promptHash for every message, which in a rAF callback means real lag.
 */
export function floorIdOf(host: Element | null | undefined): number | null {
  const mes = host?.closest('.mes');
  const raw = mes?.getAttribute('mesid');
  // Empty/whitespace-only strings must be rejected first: Number('') and Number(' ') are both 0, which would treat a ".mes shell with no mesid"
  // as floor 0, and self-healing would re-hydrate an unrelated floor.
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}
