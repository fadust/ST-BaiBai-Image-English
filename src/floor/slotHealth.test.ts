import { describe, expect, it } from 'vitest';

import { checkSlotHealth, floorIdOf, HOST_HIDE_CLASS } from '@/floor/slotHealth';

/**
 * The repo has no jsdom installed (vitest runs in node), so duck-typed fake nodes are used.
 * checkSlotHealth / floorIdOf deliberately touch only a tiny DOM surface (isConnected / closest /
 * classList.contains / getAttribute), precisely so the criteria can be locked down like this.
 */
function fakeHost(options: {
  connected?: boolean;
  /** Table of closest(selector) return values; missing selectors return null. */
  ancestors?: Record<string, unknown>;
}): Element {
  const { connected = true, ancestors = {} } = options;
  return {
    isConnected: connected,
    closest: (selector: string) => ancestors[selector] ?? null,
  } as unknown as Element;
}

function fakeMesText(classes: string[]): unknown {
  return { classList: { contains: (name: string) => classes.includes(name) } };
}

function fakeMes(mesid: string | null): unknown {
  return { getAttribute: (name: string) => (name === 'mesid' ? mesid : null) };
}

describe('checkSlotHealth', () => {
  it('reports ok for a connected anchor under a visible .mes_text', () => {
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('ok');
  });

  it('reports detached when the anchor left the document', () => {
    // The result of ST's updateMessageBlock / messageEditCancel rewriting .mes_text wholesale
    const host = fakeHost({ connected: false, ancestors: { '.mes_text': fakeMesText([]) } });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports detached for a missing host', () => {
    expect(checkSlotHealth(null)).toBe('detached');
    expect(checkSlotHealth(undefined)).toBe('detached');
  });

  it('reports hidden-by-host when the ancestor .mes_text carries the hide class', () => {
    // ST gives floors with "media and inline_image===false" the inline_media class, which is display:none in style.css
    const host = fakeHost({ ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) } });
    expect(checkSlotHealth(host)).toBe('hidden-by-host');
  });

  /**
   * Order lock: on an element detached from the document, closest() still walks up the **disconnected subtree**, and the .mes_text that ST
   * swapped out may well carry inline_media. If hidden were checked before detached,
   * such floors would be misdiagnosed as "only hidden", so instead of remounting it would just edit a node not in the document,
   * and the card would never come back. detached must take priority.
   */
  it('prefers detached over hidden when both look true', () => {
    const host = fakeHost({
      connected: false,
      ancestors: { '.mes_text': fakeMesText([HOST_HIDE_CLASS]) },
    });
    expect(checkSlotHealth(host)).toBe('detached');
  });

  it('reports ok when the anchor is connected but has no .mes_text ancestor', () => {
    // Don't treat "unrecognised structure" as an anomaly and keep remounting: when it's unclear how to fix it, do nothing
    expect(checkSlotHealth(fakeHost({}))).toBe('ok');
  });
});

describe('floorIdOf', () => {
  it('reads the floor number from the enclosing .mes', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('7') } }))).toBe(7);
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('0') } }))).toBe(0);
  });

  it('returns null when there is no enclosing .mes', () => {
    // The whole floor isn't in the document (chat switch/lazy-render unload): leave it to the render event; no guessing in self-healing
    expect(floorIdOf(fakeHost({}))).toBeNull();
    expect(floorIdOf(null)).toBeNull();
  });

  it('returns null for a missing or non-numeric mesid', () => {
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes(null) } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('') } }))).toBeNull();
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('abc') } }))).toBeNull();
    // Negative numbers aren't valid floor numbers; don't use them to index chat
    expect(floorIdOf(fakeHost({ ancestors: { '.mes': fakeMes('-1') } }))).toBeNull();
  });
});
