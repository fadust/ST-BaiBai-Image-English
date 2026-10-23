/**
 * Handshake for "auto-generate images after tags are written" (autoTag.autoGenerate, on by default).
 *
 * Sequence: before writing tags, the runner marks each new slot → applyMessageText internally fires
 * MESSAGE_EDITED / MESSAGE_UPDATED → the floor re-renders and cards hydrate and mount →
 * the card's onMounted consumes its slot's mark and starts generating.
 *
 * Marks are one-shot: consumed means deleted, so re-hydration never triggers twice. When floors render lazily (group chats etc.)
 * marks wait until the floor actually renders; on chat switch/floor deletion they are all cleared, so they never leak into other chats or old slots.
 *
 * Two modes (mode):
 * - 'auto': the automatic flow (runner finished writing tags). Only starts when "this prompt has no image yet";
 *   if a result or an in-flight task exists, it yields to the user's manual actions.
 * - 'force': the user explicitly clicked "Apply and regenerate" (prompt editor dialog). Always starts:
 *   after editing back to an old prompt the bucket may already have history (phase=ready), but the user wants a new image.
 */

/** Mark mode: see the file header comment. */
export type AutoGenerateMode = 'auto' | 'force';

/** Card display phase (same shape as Phase in Card.vue; only the values used for checks are listed). */
export type AutoGeneratePhase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const flags = new Map<string, AutoGenerateMode>();

function key(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

export function markForAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
  mode: AutoGenerateMode = 'auto',
): void {
  flags.set(key(chatId, messageId, swipeId, seq), mode);
}

/** Consumes this slot's auto-generate mark: if present, deletes it and returns its mode (fires only once); otherwise null. */
export function consumeAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
): AutoGenerateMode | null {
  const k = key(chatId, messageId, swipeId, seq);
  const mode = flags.get(k);
  if (mode === undefined) return null;
  flags.delete(k);
  return mode;
}

/**
 * Whether to actually start. **Deliberately a pure function**: Card.vue has no unit tests (the repo has no jsdom /
 * @vue/test-utils installed, and vitest runs in a node environment), so a check left inside the component couldn't be locked down.
 *
 * 'auto' lets through pending and **stale**: stale means exactly "the tag changed and the current prompt has no image yet",
 * which is precisely when an image should be generated automatically. This once let only pending through, so a floor's "regenerate tags"
 * silently did nothing on floors that already had images (new tags were written, but the card stayed on the old image); multi-tag floors were stranger still: slots
 * with old images were blocked while brand-new slots ran, so it looked like "half generating, half frozen".
 *
 * ready / queued / generating / error are still not let through: a result for this prompt already exists, a task is already in flight,
 * or the last round just failed (retrying is left to the user's click, so a bad config doesn't auto-retry and flood the backend).
 */
export function shouldAutoGenerate(mode: AutoGenerateMode, phase: AutoGeneratePhase): boolean {
  if (mode === 'force') return true;
  return phase === 'pending' || phase === 'stale';
}

/** Revokes all marks for a floor (called when writing back the text fails). */
export function clearAutoGenerateForFloor(chatId: string, messageId: number): void {
  const prefix = `${chatId}|${messageId}|`;
  for (const k of [...flags.keys()]) {
    if (k.startsWith(prefix)) flags.delete(k);
  }
}

/** Clears all marks (called on a full rebuild after switching chats / deleting floors). */
export function clearAutoGenerateFlags(): void {
  flags.clear();
}
