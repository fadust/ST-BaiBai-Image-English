import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ output: '', started: null as (() => void) | null, release: null as (() => void) | null }));
vi.mock('@/api/client', () => ({
  requestCompletion: vi.fn(async (_channel, _messages, options) => { api.started?.(); if (api.release) await new Promise<void>(resolve => { api.release = resolve; }); options.validate(api.output); return api.output; }),
  requestViaMainApi: vi.fn(async (_messages, options) => { options.validate(api.output); return api.output; }),
}));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: () => null }));
vi.mock('@/autoTag/prompt', () => ({
  autoTagProfile: () => ({ nl: false, naiCharPrompts: false, lockedSize: null, dialect: 'comfy', layoutLock: 'auto' }),
  buildAutoTagMessages: vi.fn(async (_context, _floor, _settings, _memory, _prepared, _anchors, task) => [{ role: 'user', content: task }]),
}));
vi.mock('@/floor/hydrate', () => ({ hydrateMessage: vi.fn() }));
import { requestFocusedTags } from './runner';
import { settings } from '@/state/settings';
import { BBI_CHAR_EXTRA_KEY, BBI_CHAR_EXTRA_KEY as DELTA_KEY } from '@/state/charTags';
import { parseImageTags } from '@/st/imageTagRegex';
import { buildAutoTagMessages } from './prompt';
import { passageGroupsHint } from '@/rewriteHint/passage';
import { consumeAutoGenerate } from '@/floor/autoGenerate';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  settings.enabled = true;
  settings.autoTag.retryCount = 0;
  settings.autoTag.autoGenerate = false;
  api.started = null; api.release = null;
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() });
});
function setup(text: string, fail = false) {
  const message = { name: 'Narrator', is_user: false, is_system: false, mes: text, swipes: [text], swipe_id: 0, extra: {} as Record<string, unknown> };
  const context = { name1: 'Player', name2: 'Narrator', chat: [message], chatMetadata: {}, extensionSettings: {}, getCurrentChatId: () => 'focused-scene-test', saveChat: vi.fn(async () => { if (fail) throw new Error('Save failed'); }), eventSource: {}, eventTypes: {} };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  return { context, message };
}
const focus = passageGroupsHint([[{ id: 'P1', text: 'Mary waits by the river.' }]]);
describe('selected scene planning without NPC Codex installed', () => {
  it('creates a first illustration and profiles characters through the normal planner', async () => {
    const { message } = setup('Mary waits by the river.');
    api.output = JSON.stringify({ images: [{ position: 'P1', tag: '1woman, red hair, river', size: 'portrait' }], changes: [{ name: 'Mary', field: 'new', fields: { sex: '1woman', hair: 'red hair', eyes: 'green eyes' }, position: 'P1', reason: 'First appearance' }] });
    expect(await requestFocusedTags(0, focus)).toBe(true);
    expect(parseImageTags(message.mes)).toHaveLength(1);
    expect(message.extra[BBI_CHAR_EXTRA_KEY]).toBeDefined();
    expect(consumeAutoGenerate('focused-scene-test', 0, 0, 0)).toBeTruthy();
    expect(vi.mocked(buildAutoTagMessages).mock.calls.at(-1)?.[6]).toContain('Return exactly 1 image');
  });
  it('adds an illustration without overwriting existing tags or character changes', async () => {
    const old = '<bbi_image>old portrait</bbi_image>';
    const { message } = setup(`Mary waits by the river.\n${old}`);
    const delta = { v: 1, swipe: 0, ops: [] };
    message.extra[DELTA_KEY] = delta;
    api.output = JSON.stringify({ images: [{ position: 'P1', tag: 'river, moonlight' }], changes: [{ name: 'Mary', field: 'hair', value: 'blue hair', position: 'P1', reason: 'Unwanted repeat update' }] });
    expect(await requestFocusedTags(0, focus)).toBe(true);
    expect(parseImageTags(message.mes)).toContain(old);
    expect(parseImageTags(message.mes)).toHaveLength(2);
    expect(message.extra[DELTA_KEY]).toEqual(delta);
  });
  it('keeps the original message when saving fails and reports an unsuccessful result', async () => {
    const text = 'Mary waits by the river.';
    const { message } = setup(text, true);
    api.output = JSON.stringify({ images: [{ position: 'P1', tag: 'river, moonlight' }], changes: [] });
    expect(await requestFocusedTags(0, focus)).toBe(false);
    expect(message.mes).toBe(text);
    expect(message.extra).toEqual({});
  });
});
