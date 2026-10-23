import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NAI_MIN_INTERVAL_MS,
  noteNaiRateLimited,
  setNaiMinInterval,
} from '@/backends/naiRateLimit';
import { acquireNaiSlot, naiSlotBusy, resetNaiGate, setNaiConcurrency } from '@/floor/genQueue';

describe('NAI concurrency gate', () => {
  beforeEach(() => {
    resetNaiGate();
    // This group only checks concurrency, with pacing turned off; pacing has its own group (see below).
    setNaiMinInterval(0);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
  });

  it('default limit 1: the second request waits for the first release', async () => {
    const release1 = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);

    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    // Not released yet, so the second shouldn't get a slot
    await Promise.resolve();
    expect(granted).toBe(false);

    release1();
    const release2 = await pending;
    expect(granted).toBe(true);
    release2();
    expect(naiSlotBusy()).toBe(false);
  });

  it('requests within the limit pass immediately', async () => {
    setNaiConcurrency(2);
    const a = await acquireNaiSlot();
    const b = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
    b();
    expect(naiSlotBusy()).toBe(false);
  });

  it('raising the limit releases waiting tasks immediately', async () => {
    const first = await acquireNaiSlot();
    let granted = false;
    const pending = acquireNaiSlot().then(release => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    setNaiConcurrency(3);
    const second = await pending;
    expect(granted).toBe(true);
    first();
    second();
  });

  it('an already aborted signal throws directly without taking a slot', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireNaiSlot(controller.signal)).rejects.toThrow();
    expect(naiSlotBusy()).toBe(false);
  });

  it('cancelled while queued: throws and is removed from the queue, never taking a slot later', async () => {
    const release1 = await acquireNaiSlot();
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    // Cancel while still queued
    controller.abort();
    await expect(pending).rejects.toThrow();

    // After releasing the first, the cancelled one shouldn't quietly take the slot
    release1();
    expect(naiSlotBusy()).toBe(false);
    const release2 = await acquireNaiSlot();
    release2();
  });

  it('release is idempotent: repeated calls never push the count below zero', async () => {
    const release = await acquireNaiSlot();
    release();
    release();
    release();
    expect(naiSlotBusy()).toBe(false);
    // The count wasn't driven negative → still only 1 concurrent allowed
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });

  it('concurrency limit is at least 1 (fallback for invalid values)', async () => {
    setNaiConcurrency(0);
    const a = await acquireNaiSlot();
    expect(naiSlotBusy()).toBe(true);
    a();
  });
});

describe('NAI global pacing (gate side)', () => {
  /** Runs a real clock with small intervals: better than a fake clock at verifying the real order of "waiting while holding a slot". */
  const INTERVAL = 40;

  beforeEach(() => {
    resetNaiGate();
    setNaiMinInterval(INTERVAL);
  });

  afterEach(() => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    resetNaiGate();
  });

  it('the first request does not wait', async () => {
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeLessThan(INTERVAL);
    release();
  });

  it('at least one minimum interval between two consecutive requests', async () => {
    const first = await acquireNaiSlot();
    first();
    const started = Date.now();
    const second = await acquireNaiSlot();
    // 5ms margin for clock precision
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    second();
  });

  it('pacing waits while holding the slot: with limit 2 the second still queues after the first, never released together', async () => {
    setNaiConcurrency(2);
    const started = Date.now();
    const [a, b] = await Promise.all([acquireNaiSlot(), acquireNaiSlot()]);
    // Both are within the limit, but the second must still wait out the interval, otherwise "concurrency 2" would equal "send 2 at once"
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERVAL - 5);
    a();
    b();
  });

  it('a 429 cooldown blocks new tasks from taking a slot', async () => {
    noteNaiRateLimited(120);
    const started = Date.now();
    const release = await acquireNaiSlot();
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
    release();
  });

  it('cancelled during the pacing wait: throws and returns the slot (no leak)', async () => {
    noteNaiRateLimited(5000);
    const controller = new AbortController();
    const pending = acquireNaiSlot(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    // At this point it holds a slot and is waiting out the cooldown
    expect(naiSlotBusy()).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The slot was returned, otherwise concurrency would permanently lose one
    expect(naiSlotBusy()).toBe(false);
  });
});
