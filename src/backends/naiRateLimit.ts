/**
 * NAI rate-limit self-healing: retry policy + global pacing state.
 *
 * Why: generate-image is a blocking POST over a direct browser connection, with no server-side queue. Previously a 429
 * just marked the card red and left it to the user to click, and errors were **isolated per slot**: while rate-limited the gate kept
 * pumping one after another (release → pump → immediately send the next → another 429), producing a burst of dense failed requests,
 * which looks exactly like abuse. Three things are added here:
 *
 * 1. **Error classification**: only 429 / 5xx / network-level failures are retried; configuration errors such as 400/401/402 throw immediately.
 *    Without classification, a mistyped key would be amplified by backoff retries into four times the requests.
 * 2. **Backoff retries**: exponential backoff + jitter, with the peer's Retry-After as the floor.
 * 3. **Global cooldown**: a 429 does not just back off the current request; it puts **the whole gate** on cooldown
 *    (floor/genQueue.ts waits after taking a slot), otherwise the other slots would hit it again in the same second.
 *
 * A minimum interval between adjacent requests is also added, covering cases where normal generation time doesn't create a gap (small images/few steps/fast failure resends).
 *
 * State is deliberately module-level: pacing applies per **account**, not per card, so the gate (floor) and the backend (backends/nai)
 * must read and write the same copy. Every timestamp is injectable, so the whole policy layer is unit-testable without a fake clock.
 */

/** Maximum total attempts (including the first): 1 first attempt + 3 retries. */
export const NAI_MAX_ATTEMPTS = 4;

/** Minimum interval between two adjacent NAI requests. Normal generation takes far longer; it only matters for bursts/fast failures. */
export const NAI_MIN_INTERVAL_MS = 1500;

/** Default global cooldown after a 429 when the peer gave no Retry-After. */
export const NAI_RATE_LIMIT_COOLDOWN_MS = 15_000;

/** Backoff base. */
const BACKOFF_BASE_MS = 2000;

/**
 * Cap on a single wait, also the cap on how much Retry-After is trusted.
 * Reason for a cap: if the peer (or a third-party mirror) sends Retry-After: 3600, a card should not silently hang for an hour;
 * if waiting up to the cap still fails, throw the error to the user and let them decide.
 */
const MAX_WAIT_MS = 60_000;

/* ============ Pure policy ============ */

/**
 * User cancellation: never retried.
 * Duck-typed by name rather than `instanceof DOMException`: this module's input may be the browser's
 * DOMException or a plain Error wrapped by fetch/upstream; checking the name covers both.
 */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
}

/**
 * Whether this status code is worth retrying.
 * 408/429 clearly mean "slow down/try again"; 5xx are temporary server faults (including Cloudflare 52x, common with third-party mirrors).
 * 501 is the exception: it means "not implemented at all", and retrying until the end of the world gives the same answer.
 */
export function isRetryableNaiStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/**
 * Whether to retry. **Deliberately takes raw values only** (error object + status code) and does not know NaiError;
 * otherwise naiRateLimit ↔ nai would import each other in a cycle.
 *
 * Without a status code there are two cases: fetch's TypeError is a network-level failure (offline/CORS/connection refused) and worth retrying;
 * our own validation/parse errors ("no image in the zip" and the like) give the same result after ten thousand retries, so no retry.
 */
export function shouldRetryNai(error: unknown, status: number | undefined): boolean {
  if (isAbortError(error)) return false;
  if (status !== undefined) return isRetryableNaiStatus(status);
  return error instanceof TypeError;
}

/**
 * Parses the Retry-After response header: supports both "seconds" and "HTTP date" forms; returns null if unavailable.
 * The result is clamped to [0, MAX_WAIT_MS].
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, MAX_WAIT_MS) : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_WAIT_MS);
}

/**
 * How long to wait before retry number attempt (from 1).
 *
 * Jitter only ranges over 50%–100%: the floor keeps the basic backoff strength, and randomisation stops several cards from waking together and colliding again.
 * Retry-After is used as the **floor**: the peer said how long to wait, so we must not knock earlier than that.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), MAX_WAIT_MS);
  const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), MAX_WAIT_MS);
}

/* ============ Global pacing state ============ */

let cooldownUntil = 0;
/**
 * When the last request was sent. Initialised to -Infinity rather than 0: 0 means "sent once in 1970",
 * which only happens to equal "never sent" when now is far beyond the minimum interval. -Infinity makes "never sent → no wait"
 * hold regardless of the clock value.
 */
let lastStartAt = Number.NEGATIVE_INFINITY;
let minIntervalMs = NAI_MIN_INTERVAL_MS;

/** Floor of the 429 cooldown: see noteNaiRateLimited. */
const MIN_COOLDOWN_MS = 1000;

/**
 * Records a 429: puts the whole gate on cooldown.
 *
 * **Only extends, never shortens**: with concurrency ≥2 several slots may hit it in turn, and a later short cooldown must not wipe out an earlier long one.
 * **Floor of 1s**: even if the peer sends `Retry-After: 0` (or an expired date), a 429 should always give the gate
 * a breather; a "retry immediately" 429 is the easiest way to spiral into a burst loop, which is exactly what this prevents.
 */
export function noteNaiRateLimited(
  retryAfterMs: number | null,
  now: number = Date.now(),
): void {
  const requested = retryAfterMs ?? NAI_RATE_LIMIT_COOLDOWN_MS;
  const until = now + Math.min(Math.max(requested, MIN_COOLDOWN_MS), MAX_WAIT_MS);
  if (until > cooldownUntil) cooldownUntil = until;
}

/** Records when a request was sent (the basis for the minimum interval). Record it after taking a slot and before every retry. */
export function noteNaiRequestStart(now: number = Date.now()): void {
  lastStartAt = now;
}

/** How long until the next request is allowed: the larger of remaining cooldown and remaining minimum interval. */
export function naiPacingDelayMs(now: number = Date.now()): number {
  return Math.max(0, cooldownUntil - now, lastStartAt + minIntervalMs - now);
}

/** Remaining cooldown (display/diagnostics only; the gate uses naiPacingDelayMs). */
export function naiCooldownRemainingMs(now: number = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

/**
 * The only knob for the minimum interval. Production code never calls it (the constant is the rule); it lets unit tests turn the interval off
 * so the "concurrency" and "pacing" test groups don't interfere with each other.
 */
export function setNaiMinInterval(ms: number): void {
  minIntervalMs = Math.max(0, ms);
}

/** Resets pacing state (leaves the minimum interval alone; that is setNaiMinInterval's job). */
export function resetNaiPacing(): void {
  cooldownUntil = 0;
  lastStartAt = Number.NEGATIVE_INFINITY;
}

/* ============ Cancellable wait ============ */

/**
 * A cancellable setTimeout: if the user clicks "Cancel" while waiting, AbortError must be thrown immediately;
 * a card showing "Cancel" must not sit through tens of seconds of backoff.
 *
 * (backends/comfyui.ts has a private implementation of the same shape. Deliberately not merged: that is another backend's internal helper,
 * and making comfy import nai's module for a 15-line promise primitive is not worth it.)
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ============ Retry executor ============ */

/** Retry progress report: the card uses it to replace "Generating…" with retry text. */
export interface NaiRetryInfo {
  /** Which retry is about to start (from 1). */
  attempt: number;
  /** Maximum number of retries. */
  max: number;
  /** How long to wait this time (ms). */
  waitMs: number;
  /** The error that triggered this retry. */
  error: unknown;
}

export interface NaiRetryOptions {
  signal?: AbortSignal;
  onRetry?: (info: NaiRetryInfo) => void;
  /** Wait implementation. Injectable for unit tests so a test run doesn't actually sleep for tens of seconds. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Duck-typed status code and Retry-After: does not import NaiError, avoiding a cycle (see shouldRetryNai). */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorRetryAfterMs(error: unknown): number | null {
  const ms = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === 'number' ? ms : null;
}

/**
 * Runs one NAI request; on a retryable failure it backs off and tries again, up to NAI_MAX_ATTEMPTS times.
 *
 * run must be **re-runnable**: the caller keeps "do once only" preparation (building parameters, reading vibe data)
 * outside and wraps only the part that actually sends the request.
 *
 * The wait is the larger of "this backoff" and "global pacing": with concurrency ≥2, another slot may have just hit a 429 and
 * set a longer cooldown, and this retry must respect it too; otherwise the cooldown would stop new tasks but not retries.
 */
export async function runNaiWithRetry<T>(
  run: () => Promise<T>,
  opts: NaiRetryOptions = {},
): Promise<T> {
  const { signal, onRetry, delay = abortableDelay } = opts;
  const maxRetries = NAI_MAX_ATTEMPTS - 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const status = errorStatus(error);
      // Not retryable (cancelled / wrong key / expired subscription / invalid parameters) or out of attempts: rethrow as-is,
      // keeping the original error message: users need to see "API key error", not "failed after 4 retries".
      if (attempt > maxRetries || !shouldRetryNai(error, status)) throw error;

      const retryAfterMs = errorRetryAfterMs(error);
      // 429 = the peer explicitly says "too fast". Besides backing off ourselves, put the whole gate on cooldown,
      // otherwise the other queued tasks would hit it again in the same second; that dense burst of failures is where the ban risk lies.
      if (status === 429) noteNaiRateLimited(retryAfterMs);

      const waitMs = Math.max(retryDelayMs(attempt, retryAfterMs), naiPacingDelayMs());
      onRetry?.({ attempt, max: maxRetries, waitMs, error });
      console.warn(
        `[BaiBai Image] NAI request failed, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxRetries}):`,
        error,
      );
      await delay(waitMs, signal);
      noteNaiRequestStart();
    }
  }
}
