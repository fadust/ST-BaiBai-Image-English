import { describe, expect, it } from 'vitest';

import {
  effectiveOrientation,
  normalizeOrientation,
  normalizeOrientationLock,
  parseSize,
  pickSize,
} from '@/backends/size';

describe('normalizeOrientation', () => {
  it('recognises standard values and case/whitespace variants', () => {
    expect(normalizeOrientation('portrait')).toBe('portrait');
    expect(normalizeOrientation('landscape')).toBe('landscape');
    expect(normalizeOrientation('  LANDSCAPE  ')).toBe('landscape');
  });

  it('recognises common synonyms and Chinese', () => {
    expect(normalizeOrientation('horizontal')).toBe('landscape');
    expect(normalizeOrientation('wide')).toBe('landscape');
    expect(normalizeOrientation('横屏')).toBe('landscape');
    expect(normalizeOrientation('landscape shot')).toBe('landscape');
    expect(normalizeOrientation('l')).toBe('landscape');
    expect(normalizeOrientation('vertical')).toBe('portrait');
  });

  it('recognises ratio/size forms, judging by the width/height relation', () => {
    expect(normalizeOrientation('16:9')).toBe('landscape');
    expect(normalizeOrientation('9:16')).toBe('portrait');
    expect(normalizeOrientation('1216x832')).toBe('landscape');
    expect(normalizeOrientation('832×1216')).toBe('portrait');
    expect(normalizeOrientation('1:1')).toBe('portrait');
  });

  it('missing or unrecognised always degrades to portrait (keeping the fixed default from before the change)', () => {
    expect(normalizeOrientation(undefined)).toBe('portrait');
    expect(normalizeOrientation(null)).toBe('portrait');
    expect(normalizeOrientation('')).toBe('portrait');
    expect(normalizeOrientation('   ')).toBe('portrait');
    expect(normalizeOrientation(42)).toBe('portrait');
    expect(normalizeOrientation({ size: 'landscape' })).toBe('portrait');
    expect(normalizeOrientation('随便写点什么')).toBe('portrait');
  });
});

describe('parseSize', () => {
  it('parses various separators', () => {
    expect(parseSize('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseSize('1216x832')).toEqual({ width: 1216, height: 832 });
    expect(parseSize('1024 * 1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('unparseable or out of range returns null; the caller decides between an error and degrading', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('竖版')).toBeNull();
    expect(parseSize('8000×8000')).toBeNull();
    expect(parseSize('32×32')).toBeNull();
  });

  it('does not force multiples of 64 (that is an NAI-only limit, checked separately by parseResolution)', () => {
    expect(parseSize('830×1216')).toEqual({ width: 830, height: 1216 });
  });
});

describe('pickSize', () => {
  const pair = { portraitSize: '832×1216', landscapeSize: '1216×832' };

  it('takes the cell for the orientation', () => {
    expect(pickSize(pair, 'portrait')).toBe('832×1216');
    expect(pickSize(pair, 'landscape')).toBe('1216×832');
  });

  it('returns an empty string when unset, leaving the fallback to the caller', () => {
    expect(pickSize({ portraitSize: '  ', landscapeSize: '' }, 'portrait')).toBe('');
    expect(pickSize({ portraitSize: '', landscapeSize: '' }, 'landscape')).toBe('');
  });
});

describe('normalizeOrientationLock', () => {
  it('only recognises the two orientation values', () => {
    expect(normalizeOrientationLock('portrait')).toBe('portrait');
    expect(normalizeOrientationLock('landscape')).toBe('landscape');
    expect(normalizeOrientationLock('auto')).toBe('auto');
  });

  it('old data with missing fields or junk values is always auto (keeping the pre-change behaviour of letting the AI decide)', () => {
    expect(normalizeOrientationLock(undefined)).toBe('auto');
    expect(normalizeOrientationLock(null)).toBe('auto');
    expect(normalizeOrientationLock('')).toBe('auto');
    // No lenient recognition like normalizeOrientation: this is a setting the user clicked, not the model's free output
    expect(normalizeOrientationLock('横屏')).toBe('auto');
    expect(normalizeOrientationLock('LANDSCAPE')).toBe('auto');
    expect(normalizeOrientationLock(true)).toBe('auto');
  });
});

describe('effectiveOrientation', () => {
  it('auto uses the orientation recorded in the tag', () => {
    expect(effectiveOrientation('auto', 'portrait')).toBe('portrait');
    expect(effectiveOrientation('auto', 'landscape')).toBe('landscape');
  });

  it('locked ignores the orientation recorded in the tag', () => {
    expect(effectiveOrientation('portrait', 'landscape')).toBe('portrait');
    expect(effectiveOrientation('landscape', 'portrait')).toBe('landscape');
    expect(effectiveOrientation('landscape', 'landscape')).toBe('landscape');
  });
});
