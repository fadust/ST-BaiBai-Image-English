import { reactive } from 'vue';

/**
 * Runtime state of "AI rewrite prompt" requests (module-level store).
 *
 * Must live outside the component for the same reason as genState: card lifetimes are decided by hydration, and any sibling slot's image
 * re-hydrates the whole floor, destroying cards together with their component refs. With a rewrite still in flight, the rebuilt card must be able to
 * reclaim "AI rewriting prompt…" and offer a cancel button.
 *
 * [Why the promise is stored too]
 * The entry point is in the prompt editor dialog (floor/promptEditor.ts), and **closing the dialog must not interrupt the rewrite**:
 * the request belongs to this store, not to the dialog. If the user closes the dialog midway and reopens it later, the dialog must be able to await the same
 * in-flight request and, once it finishes, read the new prompt back into the input ("resume"), instead of only seeing a spinner.
 * So what is stored here is {ticket, promise}, not a plain boolean.
 *
 * Kept apart from genState, not merged: genState handles image requests (queued/generating/error + hash
 * reconciliation); this handles LLM prompt requests. Each has its own concurrency/cancel semantics (cancelling an image must not kill a rewrite,
 * and vice versa); mixing them would only let the state machines contaminate each other. The key keeps the same shape as genState / registry / autoGenerate:
 * chatId|messageId|swipeId|seq.
 *
 * "Cancel" is not done here: aborting relies on cancelFloorTags in autoTag/runner.ts (one request lock per floor);
 * this store only handles display state and claiming the finish.
 */

interface TagPlanRecord {
  /** Ticket: identifies a "late finish"; an old task finishing must not clear a new task with the same key. */
  token: number;
  /** In-flight request. A reopened dialog awaits it to pick up this rewrite's finish. */
  promise: Promise<void>;
}

const planning = reactive(new Map<string, TagPlanRecord>());

let nextToken = 1;

export function isTagPlanning(key: string): boolean {
  return planning.has(key);
}

/**
 * Runs one rewrite and registers runtime state throughout. A repeated start on the same key goes by the new ticket (an old task's finish must not clear the new one).
 *
 * The returned promise is the same one registered: callers may await it or simply drop it;
 * the request's lifetime belongs to this store, not the caller (that is what lets closing the dialog not interrupt the rewrite).
 */
export function runTagPlan(key: string, run: () => Promise<void>): Promise<void> {
  const token = nextToken++;
  // Start run() first, then register: the .finally callback is a microtask, always later than the synchronous set on the line below
  const promise = run().finally(() => {
    if (planning.get(key)?.token === token) planning.delete(key);
  });
  planning.set(key, { token, promise });
  return promise;
}

/** Returns the in-flight rewrite's promise (null if none), so a reopened dialog can "resume". */
export function awaitTagPlan(key: string): Promise<void> | null {
  return planning.get(key)?.promise ?? null;
}

/** Clears everything (full rebuild after switching chats / deleting floors; in-flight requests are aborted by the runner's cancelAll). */
export function clearAllTagPlans(): void {
  planning.clear();
}
