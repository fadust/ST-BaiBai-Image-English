/**
 * NAI concurrency gate + global pacing.
 *
 * Why only NAI needs it: the two backends queue differently:
 * - ComfyUI: POST /prompt returns a prompt_id and enters the **server-side** queue; each poll checks its own history,
 *   so everything is sent at once and ComfyUI runs it in order. A client-side queue on top is redundant and only slows things down.
 * - NAI: generate-image is one blocking POST that returns only when the image is ready; there is no queue concept.
 *   N concurrent requests means N connections hitting at once, which easily draws 429s (see the error mapping in backends/nai.ts).
 *
 * So the gate only wraps NAI, with a user-adjustable limit (default 1). The ComfyUI path does not pass through here.
 *
 * The gate only controls **how many at once**, not **how fast each one**: pump runs right after release, so the next task goes out
 * in the same tick. When rate-limited this fires a dense burst of failed requests (429 → release → immediately again → 429),
 * which looks exactly like abuse. So after taking a slot there is also a wait for global pacing (minimum interval between requests + 429 cooldown),
 * with the rules kept in backends/naiRateLimit.ts.
 */

import {
  abortableDelay,
  naiPacingDelayMs,
  noteNaiRequestStart,
  resetNaiPacing,
} from '@/backends/naiRateLimit';

let limit = 1;
let running = 0;
/** Wait queue: first in, first out; resolving grants the right to run. */
const waiting: Array<() => void> = [];

/** Sets the concurrency limit (minimum 1). Raising it immediately releases waiting tasks. */
export function setNaiConcurrency(value: number): void {
  limit = Math.max(1, Math.floor(value) || 1);
  pump();
}

function pump(): void {
  while (running < limit && waiting.length) {
    const next = waiting.shift();
    if (!next) break;
    running++;
    next();
  }
}

/**
 * Acquires an execution slot. Returns a release function that **must** be called in finally, or the gate leaks.
 * If signal is already aborted, throws AbortError directly without taking a slot.
 *
 * It also waits out global pacing (minimum interval + 429 cooldown) before returning, so the caller can send the request as soon as it has release.
 */
export async function acquireNaiSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');

  if (running < limit) {
    running++;
  } else {
    await new Promise<void>((resolve, reject) => {
      // Cancelled while queued: remove from the queue and throw, so it never takes a slot later
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  let released = false;
  const release = () => {
    if (released) return; // Idempotent: repeated release never drives running below zero
    released = true;
    running--;
    pump();
  };

  // The pacing wait happens **while holding the slot**, which is the key point: if it came before taking the slot, the N tasks within the limit would wait out the same period together
  // and then fire together, making throttling meaningless. Waiting while holding the slot is what makes task N really follow task N-1.
  // A loop, not a single wait: during the wait another slot may hit a 429 and push the cooldown further, so ask again on waking.
  try {
    for (let wait = naiPacingDelayMs(); wait > 0; wait = naiPacingDelayMs()) {
      await abortableDelay(wait, signal);
    }
  } catch (error) {
    // Cancelled while waiting: the slot must be returned. Leaking one permanently loses one unit of concurrency; leaking them all means no request can ever be sent.
    release();
    throw error;
  }
  noteNaiRequestStart();

  return release;
}

/** Whether queueing is currently needed (so the card shows "Queued" rather than "Generating"). */
export function naiSlotBusy(): boolean {
  return running >= limit;
}

/** For tests: resets the gate and global pacing. Waiters are released (not dropped) so no promise is left hanging forever. */
export function resetNaiGate(): void {
  limit = 1;
  running = 0;
  resetNaiPacing();
  const pending = waiting.splice(0, waiting.length);
  for (const grant of pending) grant();
}
