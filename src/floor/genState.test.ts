import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeGenCount,
  beginGen,
  cancelGen,
  clearAllGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  pruneGenSlots,
  reconcileGen,
  setGenPhase,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';

const KEY = slotKey('chat1', 3, 0, 0);

describe('genState', () => {
  beforeEach(() => {
    clearAllGen();
  });

  it('slotKey distinguishes chat / floor / swipe / slot', () => {
    expect(slotKey('c', 1, 0, 0)).toBe('c|1|0|0');
    expect(slotKey('c', 1, 0, 1)).not.toBe(slotKey('c', 1, 0, 0));
    expect(slotKey('c', 1, 1, 0)).not.toBe(slotKey('c', 1, 0, 0));
    expect(slotKey('d', 1, 0, 0)).not.toBe(slotKey('c', 1, 0, 0));
  });

  it('beginGen registers runtime state and gives a non-aborted signal', () => {
    const { signal } = beginGen(KEY, 'hash1');
    expect(signal.aborted).toBe(false);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', error: '', hash: 'hash1' });
  });

  it('beginGen again on the same slot aborts the previous task', () => {
    const first = beginGen(KEY, 'hash1');
    const second = beginGen(KEY, 'hash1');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('each task gets a different ticket', () => {
    const a = beginGen(KEY, 'hash1');
    const b = beginGen(KEY, 'hash1');
    expect(a.token).not.toBe(b.token);
    expect(isCurrentGen(KEY, a.token)).toBe(false);
    expect(isCurrentGen(KEY, b.token)).toBe(true);
  });

  it('cancelGen aborts the in-flight request and clears the record', () => {
    const { signal } = beginGen(KEY, 'hash1');
    cancelGen(KEY);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('failGen keeps the error phase and message (still visible after re-hydration)', () => {
    const { token } = beginGen(KEY, 'hash1');
    failGen(KEY, token, '出图失败了');
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'error', error: '出图失败了' });
  });

  it('clearGen clears the record and the card falls back to derived state', () => {
    const { token } = beginGen(KEY, 'hash1');
    clearGen(KEY, token);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  it('setGenPhase / setQueueAhead update display state in place', () => {
    const { token } = beginGen(KEY, 'hash1', 'queued');
    expect(getGenRecord(KEY)?.phase).toBe('queued');
    setGenPhase(KEY, token, 'generating');
    setQueueAhead(KEY, token, 2);
    expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', queueAhead: 2 });
  });

  it('reconcileGen: voids the in-flight task only when the hash changed', () => {
    const { signal } = beginGen(KEY, 'hash1');
    // Same hash: untouched
    expect(reconcileGen(KEY, 'hash1')).toBe(false);
    expect(signal.aborted).toBe(false);
    // The hash changed (the user edited the tag): the old task is voided
    expect(reconcileGen(KEY, 'hash2')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(getGenRecord(KEY)).toBeUndefined();
  });

  /**
   * Regression: an old task's late callback must not land on the new task.
   * Typical trigger: A fails with a non-AbortError after being aborted (HTTP 500/429 colliding with the abort),
   * and without a ticket check its catch would mark the running B as error.
   */
  describe('ticket isolation (old tasks must not pollute new ones)', () => {
    it('old task failGen does not affect the new task', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      failGen(KEY, a.token, 'A 的报错');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'generating', token: b.token });
      expect(getGenRecord(KEY)?.error).toBe('');
    });

    it('old task clearGen does not clear the new task', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h');
      clearGen(KEY, a.token);
      expect(getGenRecord(KEY)?.token).toBe(b.token);
    });

    it('old task setQueueAhead / setGenPhase ignored', () => {
      const a = beginGen(KEY, 'h');
      const b = beginGen(KEY, 'h', 'queued');
      setQueueAhead(KEY, a.token, 99);
      setGenPhase(KEY, a.token, 'error');
      expect(getGenRecord(KEY)).toMatchObject({ phase: 'queued', queueAhead: null, token: b.token });
    });

    it('isCurrentGen lets an old task give itself up before saving', () => {
      const a = beginGen(KEY, 'h');
      expect(isCurrentGen(KEY, a.token)).toBe(true);
      cancelGen(KEY);
      // The record was cleared: the late A shouldn't save any more
      expect(isCurrentGen(KEY, a.token)).toBe(false);
    });
  });

  it('reconcileGen is a safe no-op for slots without records', () => {
    expect(reconcileGen(KEY, 'hash1')).toBe(false);
  });

  it('clearAllGen aborts everything and clears it (chat switch/floor delete)', () => {
    const a = beginGen(slotKey('c', 1, 0, 0), 'h');
    const b = beginGen(slotKey('c', 2, 0, 0), 'h');
    clearAllGen();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(activeGenCount()).toBe(0);
  });

  it('activeGenCount counts only in-flight tasks, not errors', () => {
    beginGen(slotKey('c', 1, 0, 0), 'h');
    beginGen(slotKey('c', 2, 0, 0), 'h', 'queued');
    const failed = slotKey('c', 3, 0, 0);
    const { token } = beginGen(failed, 'h');
    failGen(failed, token, 'boom');
    expect(activeGenCount()).toBe(2);
  });

  describe('pruneGenSlots', () => {
    it('deletes out-of-range slots (those gone after tags decreased), keeping ones that still exist', () => {
      const kept = slotKey('c', 5, 0, 0);
      const gone = slotKey('c', 5, 0, 2);
      const { signal: keptSignal } = beginGen(kept, 'h');
      const { signal: goneSignal } = beginGen(gone, 'h');
      // The text now has only 1 tag → everything with seq >= 1 should be cleared
      pruneGenSlots('c', 5, 0, 1);
      expect(getGenRecord(kept)).toBeDefined();
      expect(keptSignal.aborted).toBe(false);
      expect(getGenRecord(gone)).toBeUndefined();
      expect(goneSignal.aborted).toBe(true);
    });

    it('clears errors left by vanished slots, so a reappearing key never claims an old error', () => {
      const key = slotKey('c', 5, 0, 1);
      const { token } = beginGen(key, 'h');
      failGen(key, token, '上一轮的报错');
      // All tags deleted
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(key)).toBeUndefined();
    });

    it('never hits other floors / other swipes', () => {
      const otherFloor = slotKey('c', 6, 0, 3);
      const otherSwipe = slotKey('c', 5, 1, 3);
      beginGen(otherFloor, 'h');
      beginGen(otherSwipe, 'h');
      pruneGenSlots('c', 5, 0, 0);
      expect(getGenRecord(otherFloor)).toBeDefined();
      expect(getGenRecord(otherSwipe)).toBeDefined();
    });

    it('does nothing when keepCount covers every slot (the routine re-hydration after a successful image)', () => {
      const a = slotKey('c', 5, 0, 0);
      const b = slotKey('c', 5, 0, 1);
      const { signal: aSignal } = beginGen(a, 'h');
      const { signal: bSignal } = beginGen(b, 'h');
      // Key regression: re-hydration must not abort sibling slots that are generating
      pruneGenSlots('c', 5, 0, 2);
      expect(aSignal.aborted).toBe(false);
      expect(bSignal.aborted).toBe(false);
      expect(activeGenCount()).toBe(2);
    });
  });
});
