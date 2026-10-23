import { describe, expect, it } from 'vitest';

import { mapLimit } from '@/pool';

/** Controlled promise: lets the test decide when each task completes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapLimit', () => {
  it('returns results in input order, not completion order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapLimit([0, 1, 2], 3, async i => {
      await gates[i].promise;
      return `r${i}`;
    });
    // Release in reverse: if collected in completion order, the result would be r2,r1,r0
    gates[2].resolve();
    gates[1].resolve();
    gates[0].resolve();
    expect(await run).toEqual(['r0', 'r1', 'r2']);
  });

  it('the number of tasks running at once never exceeds limit', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const run = mapLimit(gates, 2, async gate => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return 1;
    });
    // Let the first two start, then release one at a time; it should never exceed 2
    await Promise.resolve();
    gates.forEach(gate => gate.resolve());
    await run;
    expect(peak).toBe(2);
  });

  it('a slow task does not hold up a whole slice: each worker claims the next unclaimed index', async () => {
    const slow = deferred<void>();
    const order: number[] = [];
    const run = mapLimit([0, 1, 2, 3], 2, async i => {
      // Number 0 stays stuck; everything after number 1 should be done in turn by the other worker
      if (i === 0) await slow.promise;
      order.push(i);
      return i;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([1, 2, 3]);
    slow.resolve();
    expect(await run).toEqual([0, 1, 2, 3]);
  });

  it('empty input returns an empty array directly without starting workers', async () => {
    let calls = 0;
    expect(
      await mapLimit([], 4, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it.each([0, -3, NaN])('an invalid limit falls back to serial instead of deadlocking: %s', async limit => {
    expect(await mapLimit([1, 2, 3], limit, async n => n * 2)).toEqual([2, 4, 6]);
  });

  it('does not start extra workers when limit exceeds the item count', async () => {
    expect(await mapLimit([1, 2], 99, async n => n)).toEqual([1, 2]);
  });
});
