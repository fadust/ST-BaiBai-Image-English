import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareTargetText } from '@/autoTag/clean';
import { parseImageTags, stripImageTags } from '@/st/imageTagRegex';
import { BBI_IMAGE_EXTRA_KEY, promptHash, type BbiImageEntry } from '@/floor/storage';
import { applyMessageText } from '@/st/messageEdit';
import { PROMPT_MEMO_KEY, slotVersions } from '@/promptVersions/versions';
import { addFocusedTags, addedExtraUpdates, dropAddedMark, pinFocusPosition } from './move';
import { focusGroups, focusImageCount, passageGroupsHint, passageTaskNote } from './passage';
import { draftFrom, draftPick } from './pickDraft';

afterEach(() => { dropAddedMark(); vi.unstubAllGlobals(); });

describe('selected scenes and existing image preservation', () => {
  const oldA = '<bbi_image>old portrait</bbi_image>';
  const oldB = '<bbi_image>old reunion</bbi_image>';
  const added = '<bbi_image>new fight</bbi_image>';
  const text = `Mary arrives.\n${oldA}\nPeter fights.\nMary returns.\n${oldB}`;
  const entry = (prompt: string, slotSeq: number): BbiImageEntry => ({ generationId: String(slotSeq), path: `images/${slotSeq}.png`, prompt, seed: 1, status: 'ready', createdAt: 1, slotSeq });
  function setup(fail = false) {
    const message = { name: 'Story', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], extra: {
      [BBI_IMAGE_EXTRA_KEY]: { '0': { [promptHash(oldA)]: [entry(oldA, 0)], [promptHash(oldB)]: [entry(oldB, 1)] } },
      [PROMPT_MEMO_KEY]: { '0': { '1': [{ prompt: '<bbi_image>earlier reunion</bbi_image>', at: 2 }] } },
    } };
    const context = { chat: [message], getCurrentChatId: () => 'scene-test', saveChat: vi.fn(async () => { if (fail) throw new Error('Disk unavailable'); }), eventSource: {}, eventTypes: {} };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
    vi.stubGlobal('document', { querySelector: () => null });
    return { message, context };
  }
  it('inserts after the selected passage and keeps old images and prompt-only revisions attached to their original slots', async () => {
    const { message } = setup();
    const before = JSON.stringify(message.extra);
    expect(await applyMessageText(0, current => addFocusedTags(current, { chatId: 'scene-test', floor: 0, swipeId: 0 }, [{ tag: added, passageId: 'P2' }]), 'scene-test', 0, message, addedExtraUpdates(0))).toBe('saved');
    expect(parseImageTags(message.mes)).toEqual([oldA, added, oldB]);
    expect(message.mes).toContain(`Peter fights.\n${added}`);
    const store = message.extra[BBI_IMAGE_EXTRA_KEY];
    expect(store['0'][promptHash(oldA)][0]).toMatchObject({ slotSeq: 0, path: 'images/0.png' });
    expect(store['0'][promptHash(oldB)][0]).toMatchObject({ slotSeq: 2, path: 'images/1.png' });
    expect(slotVersions(store, message.extra, 0, 2, oldB).map(v => v.prompt)).toContain('<bbi_image>earlier reunion</bbi_image>');
    expect(before).not.toBe(JSON.stringify(message.extra));
  });
  it('rolls back message text and every affected metadata key together when saving fails', async () => {
    const { message } = setup(true); const before = JSON.stringify(message);
    await expect(applyMessageText(0, current => addFocusedTags(current, { chatId: 'scene-test', floor: 0, swipeId: 0 }, [{ tag: added, passageId: 'P2' }]), 'scene-test', 0, message, addedExtraUpdates(0))).rejects.toThrow('Disk unavailable');
    expect(JSON.stringify(message)).toBe(before);
  });
  it('places multiple new illustrations independently without disturbing old tags', () => {
    setup();
    const next = addFocusedTags(text, { chatId: 'scene-test', floor: 0, swipeId: 0 }, [{ tag: added, passageId: 'P2' }, { tag: '<bbi_image>arrival detail</bbi_image>', passageId: 'P1' }]);
    expect(parseImageTags(next)).toHaveLength(4);
    expect(parseImageTags(next).filter(tag => tag === oldA || tag === oldB)).toEqual([oldA, oldB]);
    expect(stripImageTags(next).replace(/\s+/g, ' ').trim()).toBe(stripImageTags(text).replace(/\s+/g, ' ').trim());
  });
  it('uses English group instructions and pins each planned image to its selected scene', () => {
    const passages = prepareTargetText('Arrival.\nFight.\nReunion.', []).segments;
    const hint = passageGroupsHint([[passages[0]], [passages[1], passages[2]]]);
    expect(focusGroups(hint)).toEqual([['P1'], ['P2', 'P3']]);
    expect(focusImageCount(hint)).toBe(2);
    expect(passageTaskNote(hint)).toContain('Return exactly 2 images');
    expect(passageTaskNote(hint)).not.toMatch(/\p{Script=Han}/u);
    const images = [{ position: 'P1', sourceLine: 0 }, { position: 'P2', sourceLine: 1 }];
    pinFocusPosition(images, passages, hint);
    expect(images.map(image => image.position)).toEqual(['P1', 'P3']);
  });
  it('restores draft selections by passage text after paragraph numbers change', () => {
    const saved = draftFrom(false, [['P1']], 'Keep the evening light.', [{ id: 'P1', text: 'Mary arrives.' }]);
    expect(draftPick(saved, false, [{ id: 'P2', text: 'Mary arrives.' }])).toEqual({ groups: [['P2']], extra: 'Keep the evening light.' });
  });
});
