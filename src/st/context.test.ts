import { describe, expect, it } from 'vitest';

import { isAiStoryMessage, isStoryMessage, type STMessage } from '@/st/context';

function msg(over: Partial<STMessage> = {}): STMessage {
  return { name: 'Char', is_user: false, is_system: false, mes: '她推开门。', ...over };
}

describe('isStoryMessage', () => {
  it('accepts ordinary AI and user floors', () => {
    expect(isStoryMessage(msg())).toBe(true);
    expect(isStoryMessage(msg({ is_user: true, name: 'User' }))).toBe(true);
  });

  it('accepts a floor hidden by /hide — is_system alone is not a system message', () => {
    // ST's /hide only flips is_system and never touches extra (hideChatMessageRange in chats.js);
    // it means "not sent in the prompt", not "not story". Floor buttons and auto-tag must both keep working.
    expect(isStoryMessage(msg({ is_system: true }))).toBe(true);
  });

  it('rejects real ST system messages (they carry a string extra.type)', () => {
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'comment' } }))).toBe(false);
  });

  it('ignores extra.type on a floor that is not is_system', () => {
    // /role assistant deletes extra.type, but old messages may have leftovers; with is_system=false it is not a system floor
    expect(isStoryMessage(msg({ extra: { type: 'narrator' } }))).toBe(true);
  });

  it('rejects missing, empty and blank text', () => {
    expect(isStoryMessage(undefined)).toBe(false);
    expect(isStoryMessage(msg({ mes: '' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: '  \n ' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: undefined as unknown as string }))).toBe(false);
  });
});

describe('isAiStoryMessage', () => {
  it('is isStoryMessage minus user floors', () => {
    expect(isAiStoryMessage(msg())).toBe(true);
    expect(isAiStoryMessage(msg({ is_system: true }))).toBe(true);
    expect(isAiStoryMessage(msg({ is_user: true }))).toBe(false);
    expect(isAiStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isAiStoryMessage(undefined)).toBe(false);
  });
});
