import { describe, expect, it } from 'vitest';

import { isCollapsed, setCollapsed } from '@/floor/collapseState';

describe('collapseState', () => {
  it('slots never set manually fall back to the default', () => {
    expect(isCollapsed('c|1|0|0', false)).toBe(false);
    expect(isCollapsed('c|1|0|0', true)).toBe(true);
  });

  it('a manual setting overrides the default', () => {
    setCollapsed('c|2|0|1', true);
    expect(isCollapsed('c|2|0|1', false)).toBe(true);

    setCollapsed('c|3|0|0', false);
    expect(isCollapsed('c|3|0|0', true)).toBe(false);
  });

  it('different slots do not affect each other', () => {
    setCollapsed('c|4|0|0', true);
    expect(isCollapsed('c|4|0|1', false)).toBe(false);
    // swipeId is part of the key: switching swipe is another slot
    expect(isCollapsed('c|4|1|0', false)).toBe(false);
  });
});
