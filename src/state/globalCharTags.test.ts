import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration test for the global character library (state/globalCharTags.ts).
 * Feeds an in-memory extensionSettings/chatMetadata via a fake window.SillyTavern.getContext,
 * verifying: CRUD saving, history stripping, merging into the derived library, locked names blocking AI ops, and the promote/copy migration paths.
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
}

let ctx: FakeCtx;
// Re-imported dynamically after each resetModules, keeping module-level state (fingerprint/baseEntries) clean
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');

function makeEntry(name: string, fields: Record<string, string>) {
  return {
    name,
    fields: { ...charTags.emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  };
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    saveChat: vi.fn(() => Promise.resolve()),
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  charTags = await import('@/state/charTags');
  globalTags = await import('@/state/globalCharTags');
  globalTags.initGlobalCharTags();
  charTags.hydrateCharTags();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('global char tag store', () => {
  it('upsert saves to extensionSettings, strips history and merges into the derived library', () => {
    const ok = globalTags.upsertGlobalCharTag({
      ...makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }),
      history: [{ field: 'hair', from: 'a', to: 'b', reason: 'x', floor: 1, at: 1 }],
    });
    expect(ok).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].history).toEqual([]);
    // The derived library (when this chat is empty) contains the global entries directly
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['玩家']);
    const stored = ctx.extensionSettings['baibai_image_char_global'] as {
      schemaVersion: number;
      entries: Array<{ name: string; history: unknown[] }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.entries[0].name).toBe('玩家');
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('same name is an overwriting update; oldName renames; remove deletes', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', eyes: 'red eyes' }));
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].fields.eyes).toBe('red eyes');

    globalTags.upsertGlobalCharTag(makeEntry('冒险者', { sex: '1boy' }), '玩家');
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['冒险者']);

    expect(globalTags.removeGlobalCharTag('冒险者')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
    expect(globalTags.removeGlobalCharTag('不存在')).toBe(false);
  });

  it('rejects empty entries (no fields and no whole string)', () => {
    expect(globalTags.upsertGlobalCharTag(makeEntry('空', {}))).toBe(false);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
  });

  it('init adopts the global library already in extensionSettings', async () => {
    ctx.extensionSettings['baibai_image_char_global'] = {
      schemaVersion: 1,
      revision: 3,
      entries: [makeEntry('老玩家', { sex: '1girl' })],
    };
    vi.resetModules();
    charTags = await import('@/state/charTags');
    globalTags = await import('@/state/globalCharTags');
    globalTags.initGlobalCharTags();
    charTags.hydrateCharTags();
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
  });
});

describe('locking and merge semantics', () => {
  it('characters unique to global are locked: AI floor ops in this chat have no effect on them', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short black hair');
    expect([...charTags.lockedCharTagNames()]).toEqual(['玩家']);
  });

  it('a same-name entry made by hand in this chat = overrides global and unlocks, so AI can change it as usual', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    charTags.upsertCharTag(makeEntry('玩家', { sex: '1boy', hair: 'long white hair' }));
    // Unlocked
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    // This chat's value takes priority
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long white hair');
    // AI change applies
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long red hair');
    // The global library itself isn't polluted
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short black hair');
  });
});

describe('promote to global / copy to this chat', () => {
  it('promote: snapshots the current effective value (including AI changes) into global, clearing this chat copy and floor ops', () => {
    charTags.upsertCharTag(makeEntry('小雪', { sex: '1girl', hair: 'long black hair' }));
    const dye = charTags.createCharTagSetOp('小雪', 'hair', 'short red hair', '剪发染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.findCharTag('小雪')?.fields.hair).toBe('short red hair');

    expect(globalTags.promoteCharTagToGlobal('小雪')).toBe(true);
    // Global gets the current effective value
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short red hair');
    // This chat's baseline copy is deleted and floor ops cleared
    expect(charTags.charTagBaseNames.has('小雪')).toBe(false);
    const floorExtra = (ctx.chat[0] as { extra?: Record<string, unknown> }).extra;
    expect(floorExtra?.[charTags.BBI_CHAR_EXTRA_KEY]).toBeUndefined();
    // From now on the name is locked
    expect([...charTags.lockedCharTagNames()]).toEqual(['小雪']);
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short red hair');
  });

  it('copy to this chat: global kept, this chat copy takes over and is unlocked', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    expect(globalTags.copyGlobalCharTagToChat('玩家')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.findCharTag('玩家')?.fields.sex).toBe('1boy');
  });
});
