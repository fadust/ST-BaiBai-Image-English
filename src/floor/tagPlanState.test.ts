import { beforeEach, describe, expect, it } from 'vitest';

import { awaitTagPlan, clearAllTagPlans, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';

const KEY = 'c|1|0|0';

/** A deferred with manually controlled completion (no timers, so tests don't rely on sleeping) */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('tagPlanState', () => {
  beforeEach(() => {
    clearAllTagPlans();
  });

  it('rewriting as soon as it runs, cleared after finishing', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    expect(isTagPlanning(KEY)).toBe(true);
    gate.resolve();
    await task;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('an old task finishing must not clear the new task record', async () => {
    const first = deferred();
    const second = deferred();
    const firstTask = runTagPlan(KEY, () => first.promise);
    const secondTask = runTagPlan(KEY, () => second.promise);
    first.resolve();
    await firstTask;
    // The first one started has finished, but the key now holds the later one, so the display state must stay lit
    expect(isTagPlanning(KEY)).toBe(true);
    second.resolve();
    await secondTask;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  /**
   * The crux of the dialog's "rejoin": closing the dialog doesn't interrupt the rewrite, and reopening must be able to await the same in-flight request.
   * If this didn't return the same promise, the reopened dialog would just spin forever and never see completion.
   */
  it('awaitTagPlan gets back the same in-flight promise', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    const rejoined = awaitTagPlan(KEY);
    expect(rejoined).toBe(task);
    gate.resolve();
    await task;
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  it('awaitTagPlan returns null with no in-flight task', () => {
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  /** A failed request must also remove the runtime state, otherwise that slot would be stuck in "Rewriting" forever and never clickable again. */
  it('clears runtime state even when run throws, and rethrows the error to the caller', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    gate.reject(new Error('boom'));
    await expect(task).rejects.toThrow('boom');
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('clearAllTagPlans clears every slot', () => {
    runTagPlan(KEY, () => deferred().promise);
    runTagPlan('c|2|0|0', () => deferred().promise);
    clearAllTagPlans();
    expect(isTagPlanning(KEY)).toBe(false);
    expect(isTagPlanning('c|2|0|0')).toBe(false);
  });
});
