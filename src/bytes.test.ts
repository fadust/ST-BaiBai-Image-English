import { describe, expect, it } from 'vitest';

import { formatBytes } from '@/bytes';

describe('formatBytes', () => {
  it('converts to a suitable unit in base 1024', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(311300)).toBe('304 KB');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('one decimal below 10, none at 10 and above', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(9.94 * 1024)).toBe('9.9 KB');
    // Past 10 no decimals are given: that digit is just noise in a badge
    expect(formatBytes(10.4 * 1024)).toBe('10 KB');
  });

  it('plain bytes get no decimals', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('capped at TB, never overflowing the unit table', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });

  it('non-finite values and negatives return an empty string, never pretending to be 0 B', () => {
    // "Not computed yet" must be distinguishable from "computed as empty", so there is no fallback value
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(Infinity)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});
