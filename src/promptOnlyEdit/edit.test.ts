import { describe, expect, it, vi } from 'vitest';
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/state/settings', () => ({ getTagGenChannel: () => null }));
import { editPromptOnly, parsePromptOnlyReply, promptOnlyMessages } from './edit';
import { requestViaMainApi } from '@/api/client';
const original = { tag: '1woman, red hair', nl: 'A woman waits at sunset.', negative: '', characters: [{ name: '小雪', tag: 'red hair', nl: '' }], size: 'portrait' as const };
describe('prompt-only editing', () => {
  it('sends only the current prompt and instructions, with English prose rules and unchanged names', () => {
    const messages = promptOnlyMessages(original, 'Use moonlight.');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('Do not convert MOSS prose into Danbooru tags');
    expect(messages[1].content).toContain('Requested changes:\nUse moonlight.');
    expect(messages[1].content).toContain('小雪');
  });
  it('updates supplied fields without mutating the original or dropping omitted fields', () => {
    const before = JSON.stringify(original);
    expect(parsePromptOnlyReply('{"nl":"A woman waits in moonlight."}', original)).toEqual({ ...original, nl: 'A woman waits in moonlight.' });
    expect(JSON.stringify(original)).toBe(before);
  });
  it('reports malformed or empty prompts and rejects embedded image markup', () => {
    expect(() => parsePromptOnlyReply('done', original)).toThrow('did not return');
    expect(() => parsePromptOnlyReply('{bad}', original)).toThrow('invalid prompt JSON');
    expect(() => parsePromptOnlyReply('{"tag":""}', original)).toThrow('empty');
    expect(() => parsePromptOnlyReply('{"tag":"<nl>text</nl>"}', original)).toThrow('markup');
  });
  it('rejects identity changes instead of silently renaming an existing character', () => {
    expect(() => parsePromptOnlyReply('{"tag":"portrait","characters":[{"name":"Snow","tag":"red hair"}]}', original)).toThrow('character identity');
  });
  it('cancels locally even when the main API transport cannot be interrupted', async () => {
    vi.mocked(requestViaMainApi).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const task = editPromptOnly(original, 'Use moonlight.', controller.signal);
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  });
});
