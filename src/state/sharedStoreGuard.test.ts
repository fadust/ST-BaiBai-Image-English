import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the shared-storage "empty seed" incident:
 * old versions of Image created the shared storage (occupying baibai_exclude_settings) with empty lists even when there was no exclusion data at all,
 * Book adopted the empty store on startup → both sides synced each other to empty, and the user's config was wiped out.
 * The current contract: a side without user data never creates the store; a side with data self-heals by writing back when it meets an "empty seed store".
 *
 * This file only tests the pure logic helpers (a same-structure implementation of excludesHasUserData); the hydrate chain in settings.ts
 * depends on ST getContext and is hard to instantiate fully in a node environment.
 */

const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];

interface ExcludesLike {
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

function excludesHasUserData(ex: ExcludesLike): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

const emptySeeded = (): ExcludesLike => ({
  excludedChars: [],
  excludedWorldNames: [],
  excludedWorldInfoPatterns: [...DEFAULT_WI_PATTERNS],
  customStripTags: [],
});

describe('empty-seed guard for the shared exclusion-list storage', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('empty lists + only built-in default rules = no user data (the empty seed old Image wrote looks like this)', () => {
    expect(excludesHasUserData(emptySeeded())).toBe(false);
  });

  it('all-empty lists (user just installed the plugin) = no user data', () => {
    expect(
      excludesHasUserData({
        excludedChars: [],
        excludedWorldNames: [],
        excludedWorldInfoPatterns: [],
        customStripTags: [],
      }),
    ).toBe(false);
  });

  it('has excluded characters = has user data', () => {
    const ex = emptySeeded();
    ex.excludedChars = ['小雪'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('has whole-book excluded lorebooks = has user data', () => {
    const ex = emptySeeded();
    ex.excludedWorldNames = ['设定集'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('has custom entry-name rules (besides the built-in mvu) = has user data', () => {
    const ex = emptySeeded();
    ex.excludedWorldInfoPatterns.push('^\\[状态');
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('has custom cleanup tags = has user data', () => {
    const ex = emptySeeded();
    ex.customStripTags = ['snow'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('only the built-in mvu rule (user deleted all custom items) = no user data, never misjudged as an empty seed and overwritten', () => {
    // After the user deliberately empties the custom items on either side, the store holds only built-in rules → consistent with local,
    // so the self-healing guard doesn't fire (Book's side requires excludesHasUserData(apiSettings) to be false)
    const ex = emptySeeded();
    expect(excludesHasUserData(ex)).toBe(false);
  });
});
