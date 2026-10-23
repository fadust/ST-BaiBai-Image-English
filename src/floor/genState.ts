import { reactive } from 'vue';

/**
 * Module-level store for floor cards' "generation runtime state".
 *
 * Why it must live outside the component: card lifetimes are decided by hydration, not by the card. A successful image on any slot
 * calls hydrateMessage to re-hydrate, and re-hydration unmounts the **whole floor's** cards (hydrate.ts); when ST re-renders a floor,
 * the anchor DOM itself is rebuilt too. If runtime state lived in a component ref, it would reset whenever a card is rebuilt: a sibling card's
 * "Generating…" would vanish and fall back to pending, while its autoGenerate mark was already consumed and won't run again.
 * Moving phase/error/controller here turns the card into a pure display layer that reclaims its state by key after rebuilding.
 *
 * key = chatId|messageId|swipeId|seq, the same shape as floor/registry.ts and floor/autoGenerate.ts
 * (the "task identity" in DESIGN-FLOOR-UI.md §8.1).
 */

/** Runtime phase. Derived states (pending/ready/stale) are judged by the card from props and kept out of the store. */
export type GenPhase = 'queued' | 'generating' | 'error';

export interface GenRecord {
  phase: GenPhase;
  /** Error message in the error phase; empty string in other phases. */
  error: string;
  /**
   * How many tasks are ahead in the queue (ComfyUI server queue).
   * 0 = our turn to run; null = unknown (NAI has no queue concept, or the queue endpoint is unavailable).
   */
  queueAhead: number | null;
  /**
   * Rate-limit backoff progress: non-null means the request failed and is waiting to retry (see backends/naiRateLimit.ts).
   * Users must see this; otherwise the card shows a motionless "Generating…" for tens of seconds,
   * users assume it froze and click again, piling one more request on for nothing.
   */
  retry: { attempt: number; max: number } | null;
  /**
   * promptHash at launch. After re-hydration the card uses it to confirm "the in-flight task belongs to the current prompt":
   * if the user changed the tag midway, the key stays the same but the hash changes, and the old task's result is meaningless (see reconcile).
   */
  hash: string;
  /**
   * Unique ticket for this task. **The key is not enough to identify a task**: one slot can run several tasks in turn
   * (redraw after cancel, retry after reconcile), all sharing the key. Late callbacks from an old task must claim by ticket,
   * or they would modify the new task's record. For example, if A is aborted and then fails with a non-AbortError (HTTP 500/429
   * colliding with the abort), its catch would mark **the running B** as error: the UI shows a red error,
   * the "Cancel" button turns back into "Redraw", and the user can start yet another task on top of B.
   */
  token: number;
}

export function slotKey(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

/** Display state: in reactive, read directly by cards' computed values. */
const records = reactive(new Map<string, GenRecord>());

/**
 * AbortControllers are kept in a separate plain Map, outside reactive:
 * a controller isn't display data, and wrapping it in a Proxy only costs without benefit.
 */
const controllers = new Map<string, AbortController>();

export function getGenRecord(key: string): GenRecord | undefined {
  return records.get(key);
}

/** Monotonically increasing task ticket. */
let nextToken = 1;

/** Handle for this task: signal goes to the backend, token is used for every write-back (so old tasks can't overwrite new ones). */
export interface GenHandle {
  signal: AbortSignal;
  token: number;
}

/**
 * Starts a generation: registers runtime state and returns this task's handle.
 * If the same key already has an in-flight task, the old one is aborted first (one slot can't have two tasks at once; the later one wins).
 */
export function beginGen(key: string, hash: string, phase: GenPhase = 'generating'): GenHandle {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  const token = nextToken++;
  records.set(key, { phase, error: '', queueAhead: null, retry: null, hash, token });
  return { signal: controller.signal, token };
}

/** Ticket mismatch = the call comes from an old, superseded task; always ignored. */
function owned(key: string, token: number): GenRecord | null {
  const record = records.get(key);
  return record && record.token === token ? record : null;
}

/** Whether this task is still the slot's current task (self-check before saving, so an old task's image never goes into extra). */
export function isCurrentGen(key: string, token: number): boolean {
  return !!owned(key, token);
}

/** Phase advance (queued → generating): same task, only the display changes. */
export function setGenPhase(key: string, token: number, phase: GenPhase): void {
  const record = owned(key, token);
  if (record) record.phase = phase;
}

/** Updates queue position (reported during ComfyUI polling). */
export function setQueueAhead(key: string, token: number, ahead: number | null): void {
  const record = owned(key, token);
  if (record) record.queueAhead = ahead;
}

/** Updates rate-limit backoff progress (reported during NAI retries; null means no longer backing off). */
export function setGenRetry(
  key: string,
  token: number,
  retry: { attempt: number; max: number } | null,
): void {
  const record = owned(key, token);
  if (record) record.retry = retry;
}

/** Generation succeeded/abandoned: clears runtime state; the card falls back to derived state (ready/stale/pending). */
export function clearGen(key: string, token?: number): void {
  // Without token = clear unconditionally (cancel/full rebuild); with token, only clear if this task is still in place
  if (token !== undefined && !owned(key, token)) return;
  controllers.delete(key);
  records.delete(key);
}

/** Generation failed: keeps the error phase and message (still visible after re-hydration); the controller is no longer needed. */
export function failGen(key: string, token: number, message: string): void {
  const record = owned(key, token);
  if (!record) return;
  controllers.delete(key);
  record.phase = 'error';
  record.error = message;
  record.queueAhead = null;
  // Backoff is over (we only get here once retries are exhausted), so don't leave "retrying shortly" above the red error
  record.retry = null;
}

/** User cancel: aborts the in-flight request and clears runtime state. A safe no-op without an in-flight task. */
export function cancelGen(key: string): void {
  controllers.get(key)?.abort();
  clearGen(key);
}

/**
 * Reconciliation after the prompt changed: if the in-flight task's hash differs from the current card hash, the task belongs to the old prompt,
 * so it is aborted and cleared (the card then shows stale/pending). The error phase is voided likewise, otherwise after editing the tag
 * the previous version's error would still show. Returns true if something was actually cleared.
 */
export function reconcileGen(key: string, hash: string): boolean {
  const record = records.get(key);
  if (!record || record.hash === hash) return false;
  cancelGen(key);
  return true;
}

/** Aborts and clears everything (full rebuild after switching chats / deleting floors). */
export function clearAllGen(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  records.clear();
}

/**
 * Aborts and clears records of "slots that no longer exist" under a swipe (seq >= keepCount).
 *
 * Why it's needed: reconcileGen can only be triggered by **a mounted card**, but slots may disappear entirely:
 * the user deletes a tag from the text, or swipes to a version with fewer tags, and no card ever reconciles those slots again;
 * their records (especially errors left by failGen) would stay in the Map forever, and if the same key reappears later
 * (regenerating tags, back to the same messageId|swipeId|seq), a new card would claim the previous round's old error.
 *
 * **Only out-of-range slots are deleted**, never seq < keepCount: hydrateMessage runs after every successful image,
 * when sibling slots are often still generating; clearing them too would abort every in-flight request,
 * which is exactly the bug this refactor fixes, and it must not come back here in another form.
 */
export function pruneGenSlots(
  chatId: string,
  messageId: number,
  swipeId: number,
  keepCount: number,
): void {
  const prefix = `${chatId}|${messageId}|${swipeId}|`;
  for (const key of [...records.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const seq = Number(key.slice(prefix.length));
    if (Number.isInteger(seq) && seq >= keepCount) cancelGen(key);
  }
}

/** Number of currently in-flight (queued/generating) tasks, used for backend concurrency-gate statistics. */
export function activeGenCount(): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.phase === 'queued' || record.phase === 'generating') count++;
  }
  return count;
}
