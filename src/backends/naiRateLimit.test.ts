import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NAI_MAX_ATTEMPTS,
  NAI_MIN_INTERVAL_MS,
  NAI_RATE_LIMIT_COOLDOWN_MS,
  isAbortError,
  isRetryableNaiStatus,
  naiCooldownRemainingMs,
  naiPacingDelayMs,
  noteNaiRateLimited,
  noteNaiRequestStart,
  parseRetryAfter,
  resetNaiPacing,
  retryDelayMs,
  runNaiWithRetry,
  setNaiMinInterval,
  shouldRetryNai,
} from '@/backends/naiRateLimit';

/** A minimal stand-in shaped like NaiError: the executor only duck-type reads status / retryAfterMs. */
function httpError(status: number, retryAfterMs: number | null = null): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs });
}

function abortError(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' });
}

describe('NAI retry policy', () => {
  it('408/429/5xx are retryable; 501 and 4xx configuration errors are not', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 520, 522]) {
      expect(isRetryableNaiStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 402, 403, 404, 501]) {
      expect(isRetryableNaiStatus(status)).toBe(false);
    }
    expect(isRetryableNaiStatus(undefined)).toBe(false);
  });

  it('user cancels are never retried (even with a retryable status code)', () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(shouldRetryNai(abortError(), 429)).toBe(false);
  });

  it('without a status code: fetch TypeError retries, our own validation errors do not', () => {
    expect(shouldRetryNai(new TypeError('Failed to fetch'), undefined)).toBe(true);
    expect(shouldRetryNai(new Error('zip 包内没有图片文件'), undefined)).toBe(false);
  });
});

describe('Retry-After parsing', () => {
  it('seconds form', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(' 5 ')).toBe(5000);
  });

  it('HTTP date form computes the difference from now', () => {
    const now = Date.parse('2026-08-30T00:00:00Z');
    expect(parseRetryAfter('Sun, 30 Aug 2026 00:00:20 GMT', now)).toBe(20_000);
    // Expired dates are clamped to 0, so there is no negative wait
    expect(parseRetryAfter('Sun, 30 Aug 2026 00:00:00 GMT', now + 5000)).toBe(0);
  });

  it('empty/junk values → null; overlong values clamped to the 60s cap', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('3600')).toBe(60_000);
  });
});

describe('backoff duration', () => {
  it('exponential growth, jitter within 50%–100%', () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(1000);
    expect(retryDelayMs(1, null, () => 1)).toBe(2000);
    expect(retryDelayMs(2, null, () => 0)).toBe(2000);
    expect(retryDelayMs(2, null, () => 1)).toBe(4000);
    expect(retryDelayMs(3, null, () => 0)).toBe(4000);
  });

  it('Retry-After as the floor: when longer than the backoff it wins', () => {
    expect(retryDelayMs(1, 30_000, () => 0)).toBe(30_000);
    // Shorter than the backoff, it doesn't weaken the backoff
    expect(retryDelayMs(3, 1000, () => 1)).toBe(8000);
  });

  it('a single wait never exceeds 60s', () => {
    expect(retryDelayMs(10, null, () => 1)).toBe(60_000);
    expect(retryDelayMs(1, 999_999, () => 1)).toBe(60_000);
  });
});

describe('global pacing state', () => {
  beforeEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  afterEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  it('initially no wait needed', () => {
    expect(naiPacingDelayMs(1000)).toBe(0);
  });

  it('just sent a request → wait until the minimum interval is up', () => {
    noteNaiRequestStart(1000);
    expect(naiPacingDelayMs(1000)).toBe(NAI_MIN_INTERVAL_MS);
    expect(naiPacingDelayMs(1000 + NAI_MIN_INTERVAL_MS - 200)).toBe(200);
    expect(naiPacingDelayMs(1000 + NAI_MIN_INTERVAL_MS)).toBe(0);
  });

  it('429 without Retry-After → default cooldown', () => {
    noteNaiRateLimited(null, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(NAI_RATE_LIMIT_COOLDOWN_MS);
    expect(naiPacingDelayMs(1000)).toBe(NAI_RATE_LIMIT_COOLDOWN_MS);
  });

  it('429 with Retry-After → wait as the server says', () => {
    noteNaiRateLimited(40_000, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(40_000);
  });

  it('cooldown only extends, never shortens: a later short cooldown cannot wipe out an earlier long one', () => {
    noteNaiRateLimited(40_000, 1000);
    noteNaiRateLimited(2000, 1500);
    expect(naiCooldownRemainingMs(1000)).toBe(40_000);
  });

  it('Retry-After: 0 still brakes a little (floor 1s), otherwise retry immediately would snowball into a burst', () => {
    noteNaiRateLimited(0, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(1000);
  });

  it('cooldown capped at 60s: an absurd Retry-After from the server cannot hang the card', () => {
    noteNaiRateLimited(999_999, 1000);
    expect(naiCooldownRemainingMs(1000)).toBe(60_000);
  });

  it('cooldown and minimum interval take the larger', () => {
    noteNaiRequestStart(1000);
    noteNaiRateLimited(30_000, 1000);
    expect(naiPacingDelayMs(1000)).toBe(30_000);
  });

  it('reset clears the cooldown and interval baseline', () => {
    noteNaiRequestStart(1000);
    noteNaiRateLimited(30_000, 1000);
    resetNaiPacing();
    expect(naiPacingDelayMs(1000)).toBe(0);
  });
});

describe('retry executor', () => {
  /** Records each wait duration without really sleeping. */
  function fakeDelay() {
    const waits: number[] = [];
    return {
      waits,
      delay: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  beforeEach(() => {
    resetNaiPacing();
    setNaiMinInterval(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetNaiPacing();
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    vi.restoreAllMocks();
  });

  it('first send succeeds: no retry, no wait', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => 'ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('success after 429: returns after one retry', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce('ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
  });

  it('429 every time: sends only NAI_MAX_ATTEMPTS in total and throws the original error', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw httpError(429);
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('HTTP 429');
    expect(run).toHaveBeenCalledTimes(NAI_MAX_ATTEMPTS);
    expect(waits).toHaveLength(NAI_MAX_ATTEMPTS - 1);
  });

  it('a 429 also puts the global gate on cooldown', async () => {
    const { delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce('ok');
    await runNaiWithRetry(run, { delay });
    expect(naiCooldownRemainingMs()).toBeGreaterThan(0);
  });

  it('401 throws immediately, never retried', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw httpError(401);
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('HTTP 401');
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    // Configuration errors shouldn't pollute global pacing
    expect(naiCooldownRemainingMs()).toBe(0);
  });

  it('cancel throws immediately, no retry', async () => {
    const { delay } = fakeDelay();
    const run = vi.fn(async () => {
      throw abortError();
    });
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('已取消');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Retry-After raises the wait duration', async () => {
    const { waits, delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429, 45_000))
      .mockResolvedValueOnce('ok');
    await runNaiWithRetry(run, { delay });
    expect(waits[0]).toBe(45_000);
  });

  it('every retry reports progress', async () => {
    const { delay } = fakeDelay();
    const onRetry = vi.fn();
    const run = vi.fn(async () => {
      throw httpError(503);
    });
    await expect(runNaiWithRetry(run, { delay, onRetry })).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(NAI_MAX_ATTEMPTS - 1);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2, 3]);
    expect(onRetry.mock.calls[0][0].max).toBe(NAI_MAX_ATTEMPTS - 1);
  });

  it('network-level failures (TypeError) are retried too', async () => {
    const { delay } = fakeDelay();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce('ok');
    await expect(runNaiWithRetry(run, { delay })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancelled during the wait: the wait throws and stops on the spot, without running again', async () => {
    const run = vi.fn(async () => {
      throw httpError(429);
    });
    const delay = async () => {
      throw abortError();
    };
    await expect(runNaiWithRetry(run, { delay })).rejects.toThrow('已取消');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
