import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestViaMainApi } from '@/api/client';
import { previewSlotRewrite } from '@/autoTag/runner';
import { clearAutoGenerateFlags, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { writeBack } from '@/floor/promptEditor';
import { BBI_CHAR_EXTRA_KEY, hydrateCharTags } from '@/state/charTags';
import { activeComfyPreset, settings } from '@/state/settings';
import { parseImageTags } from '@/st/imageTagRegex';
import { PROMPT_MEMO_KEY } from '@/promptVersions/versions';

vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/floor/hydrate', () => ({ hydrateMessage: vi.fn() }));

const original = '<bbi_image>Mara at the river<nl>Mara waits by the river.</nl></bbi_image>';
const sibling = '<bbi_image>stone bridge</bbi_image>';
const story = 'Mara waits by the river.';
const text = [story, original, sibling].join('\n');
const target = { chatId: 'rewrite-fixture', messageId: 0, swipeId: 0, seq: 0, rawTag: original };
const revised = 'Mara, an elf with an oval face, waits by the river.';
const rendererMark = () => consumeAutoGenerate(target.chatId, target.messageId, target.swipeId, target.seq);

function fixture() {
  const delta = { v: 1, swipe: 0, ops: [] };
  const message = {
    name: 'Narrator', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text],
    extra: { [BBI_CHAR_EXTRA_KEY]: delta } as Record<string, unknown>,
  };
  const context = {
    chat: [message], name1: 'Player', name2: 'Narrator',
    chatMetadata: { baibai_image_char_tags: { version: 3, entries: [
      { name: 'Mara', fields: { race: 'elf', face: 'oval face' }, source: 'manual' },
    ] } },
    getCurrentChatId: () => target.chatId,
    saveChat: vi.fn(async () => {}),
    eventTypes: {},
  };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  hydrateCharTags();
  return { context, message, delta };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn() });
  settings.enabled = true;
  settings.assignments.tagGen = '';
  settings.defaultBackend = 'comfyui';
  settings.comfyui.url = 'http://localhost:8188';
  activeComfyPreset().mode = 'custom';
  activeComfyPreset().specDialect = 'moss-anime';
  activeComfyPreset().workflow = '{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"%nl%"}}}';
  settings.autoTag.autoGenerate = true;
  settings.autoTag.retryCount = 0;
  const response = JSON.stringify({
    images: [{ position: 'P1', tag: 'Mara at the river', nl: revised }],
    changes: [{ name: 'Mara', field: 'face', value: 'square jaw', position: 'P1' }],
  });
  vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
    options?.validate?.(response);
    return response;
  });
});

afterEach(() => {
  clearAutoGenerateFlags();
  vi.unstubAllGlobals();
});

describe('scene-aware rewrite preview', () => {
  it('sends the scene, current sheet and saved prompt without committing a change', async () => {
    const { context, message, delta } = fixture();
    const preview = await previewSlotRewrite(target);
    expect(preview?.content.nl).toBe(revised);
    const prompt = vi.mocked(requestViaMainApi).mock.calls[0][0].map(part => part.content).join('\n');
    expect(prompt).toContain(story);
    expect(prompt).toContain('Mara at the river');
    expect(prompt).toContain('Race=elf');
    expect(prompt).toContain('Face=oval face');
    expect(message.mes).toBe(text);
    expect(message.extra).toEqual({ [BBI_CHAR_EXTRA_KEY]: delta });
    expect(context.saveChat).not.toHaveBeenCalled();
    expect(rendererMark()).toBeNull();
  });

  it('applies only the selected prompt and records the old version without redrawing', async () => {
    const { context, message, delta } = fixture();
    const preview = (await previewSlotRewrite(target))!;
    expect(await writeBack(target, preview.content, false, preview)).toBe(true);
    expect(context.saveChat).toHaveBeenCalledOnce();
    expect(parseImageTags(message.mes)).toEqual([expect.stringContaining(revised), sibling]);
    expect(message.extra[PROMPT_MEMO_KEY]).toEqual({ '0': { '0': [{ prompt: original, at: expect.any(Number) }] } });
    expect(message.extra[BBI_CHAR_EXTRA_KEY]).toEqual(delta);
    expect(rendererMark()).toBeNull();
  });

  it('queues a redraw only after the save succeeds', async () => {
    const { context } = fixture();
    const preview = (await previewSlotRewrite(target))!;
    context.saveChat.mockImplementationOnce(async () => {
      expect(rendererMark()).toBeNull();
    });
    expect(await writeBack(target, preview.content, true, preview)).toBe(true);
    expect(rendererMark()).toBe('force');
    expect(hydrateMessage).toHaveBeenCalledWith(0, context, 0);
  });

  it('rejects a preview if the scene changed while it was open', async () => {
    const { context, message } = fixture();
    const preview = (await previewSlotRewrite(target))!;
    message.mes = text.replace(story, 'Mara walks through a market.');
    expect(await writeBack(target, preview.content, true, preview)).toBe(false);
    expect(context.saveChat).not.toHaveBeenCalled();
    expect(parseImageTags(message.mes)).toEqual([original, sibling]);
    expect(rendererMark()).toBeNull();
  });

  it('keeps the original prompt and avoids a redraw when a save fails', async () => {
    const { context, message, delta } = fixture();
    const preview = (await previewSlotRewrite(target))!;
    context.saveChat.mockRejectedValueOnce(new Error('Save failed'));
    expect(await writeBack(target, preview.content, true, preview)).toBe(false);
    expect(message.mes).toBe(text);
    expect(message.extra).toEqual({ [BBI_CHAR_EXTRA_KEY]: delta });
    expect(rendererMark()).toBeNull();
  });
});
