import { describe, expect, it, vi } from 'vitest';
import { codexAppearance } from './codexAppearance';
import { buildAutoTagMessages } from './prompt';
import { resolveCharAnchors } from './charAnchors';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { settings } from '@/state/settings';
import type { STContext } from '@/st/context';

const context = { chat: [{ mes: 'Ari Vale waits by the river.', is_user: false }], name1: 'Kai', name2: 'Ari Vale', chatMetadata: {}, getCurrentChatId: () => 'chat-a' } as STContext;
const appearance = 'Subject: female, apparent age 22. Appearance: red hair and green eyes. Clothing: blue coat.';
const actor = { id: 'vale', name: 'Ari Vale', aliases: ['Ari'], appearance, archived: false };
const snapshot = () => ({ apiVersion: 1, chatId: 'chat-a', groupId: null, floor: 0, revision: 3, actors: [actor] });
const entry = (name = 'Ari Vale', source: CharTagEntry['source'] = 'ai'): CharTagEntry => ({ name, fields: { ...emptyCharFields(), hair: 'white hair' }, raw: '', nl: 'A white-haired woman.', source, desc: '', history: [] });

describe('Codex image appearance references', () => {
  it('uses accepted semantic appearance instead of an unlocked render profile, without saving anything', async () => {
    const entries = [entry()];
    const before = JSON.stringify(entries);
    const bridge = { imageActors: vi.fn(() => snapshot()) };
    const result = codexAppearance(context, 0, context.chat[0].mes, entries, new Set(), [], bridge);
    expect(result.entries[0].raw).toBe(appearance);
    expect(result.locked.has('Ari Vale')).toBe(true);
    expect(result.locked.has('ari')).toBe(true);
    expect(result.isCurrent()).toBe(true);
    const anchors = resolveCharAnchors(result.entries, result.locked);
    const messages = await buildAutoTagMessages(context, 0, settings.autoTag, null, undefined, anchors.text, '', { nl: true, naiCharPrompts: false, lockedSize: null }, result.note);
    expect(messages.some(message => message.role === 'system' && message.content.includes('NPC Codex appearance authority'))).toBe(true);
    expect(messages.at(-1)?.content).toContain(appearance);
    expect(messages.at(-1)?.content).not.toContain('white hair');
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('preserves manual and global render overrides', () => {
    for (const [entries, locked] of [[ [entry('Ari Vale', 'manual')], new Set<string>() ], [ [entry()], new Set(['Ari Vale']) ]] as const) {
      const result = codexAppearance(context, 0, context.chat[0].mes, [...entries], locked, [], { imageActors: snapshot });
      expect(result.note).toBe('');
      expect(result.entries[0].fields.hair).toBe('white hair');
    }
  });

  it('does not resolve a shared alias or a substring as a distinct identity', () => {
    const shared = { ...snapshot(), actors: [actor, { ...actor, id: 'senn', name: 'Ari Senn' }] };
    expect(codexAppearance(context, 0, 'Ari waits.', [], new Set(), [], { imageActors: () => shared }).entries).toEqual([]);
    const ann = { ...snapshot(), actors: [{ ...actor, name: 'Ann', aliases: [] }] };
    expect(codexAppearance(context, 0, 'Joanne waits.', [], new Set(), [], { imageActors: () => ann }).entries).toEqual([]);
  });

  it('falls back when the exact floor/chat context is unavailable; rejects an in-flight appearance change', () => {
    for (const value of [null, { ...snapshot(), chatId: 'other' }, { ...snapshot(), floor: 9 }]) {
      expect(codexAppearance(context, 0, 'Ari Vale waits.', [], new Set(), [], { imageActors: () => value }).note).toBe('');
    }
    let value = snapshot();
    const result = codexAppearance(context, 0, 'Ari Vale waits.', [], new Set(), [], { imageActors: () => value });
    value = { ...value, revision: 4 };
    expect(result.isCurrent()).toBe(true); // Unrelated dossier changes do not invalidate this appearance.
    value = { ...value, actors: [{ ...actor, appearance: 'Now wearing a red coat.' }] };
    expect(result.isCurrent()).toBe(false);
  });
});
