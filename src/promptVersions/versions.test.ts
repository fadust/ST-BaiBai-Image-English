import { describe, expect, it } from 'vitest';

import { promptHash, type BbiImageEntry, type BbiImageStore } from '@/floor/storage';

import { memoItems, PROMPT_MEMO_KEY, rememberedMemo, slotVersions, tagDiff } from './versions';

const A = '<bbi_image>1girl, red hair<size>portrait</size></bbi_image>';
const B = '<bbi_image>1girl, blue hair, smile<size>portrait</size></bbi_image>';
const C = '<bbi_image>1girl, green hair<size>portrait</size></bbi_image>';

function entry(prompt: string, createdAt: number, slotSeq = 0, status: BbiImageEntry['status'] = 'ready'): BbiImageEntry {
  return { generationId: `g${createdAt}`, path: `/img/${createdAt}.png`, prompt, seed: 1, status, createdAt, slotSeq } as BbiImageEntry;
}

function storeOf(...entries: BbiImageEntry[]): BbiImageStore {
  const bucket: Record<string, BbiImageEntry[]> = {};
  for (const e of entries) (bucket[promptHash(e.prompt)] ??= []).push(e);
  return { '0': bucket };
}

describe('prompt revision history', () => {
  it('lists previous image-backed prompts newest first, excluding the current version', () => {
    const store = storeOf(entry(A, 1), entry(A, 2), entry(B, 3), entry(C, 4));
    const versions = slotVersions(store, undefined, 0, 0, C);
    expect(versions.map(v => v.prompt)).toEqual([B, A]);
    expect(versions[1]).toMatchObject({ count: 2, thumb: '/img/2.png', lastAt: 2 });
  });

  it('keeps other image slots separate', () => {
    const store = storeOf(entry(A, 1, 1), entry(B, 2, 0));
    expect(slotVersions(store, undefined, 0, 0, B)).toEqual([]);
  });

  it('accepts legacy chats without revision metadata', () => {
    expect(slotVersions(null, undefined, 0, 0, A)).toEqual([]);
    expect(slotVersions({ '0': { x: 'bad' as never } }, { [PROMPT_MEMO_KEY]: 'bad' }, 0, 0, A)).toEqual([]);
    expect(memoItems({ [PROMPT_MEMO_KEY]: { '0': { '0': [{ prompt: 1 }] } } }, 0, 0)).toEqual([]);
  });

  it('remembers prompts edited before an image was generated', () => {
    const memo = rememberedMemo(undefined, null, 0, 0, A, 5);
    expect(memo).toEqual({ '0': { '0': [{ prompt: A, at: 5 }] } });
    const versions = slotVersions(null, { [PROMPT_MEMO_KEY]: memo }, 0, 0, B);
    expect(versions).toEqual([{ hash: promptHash(A), prompt: A, count: 0, lastAt: 5 }]);
  });

  it('does not duplicate existing image-backed or memoized versions', () => {
    expect(rememberedMemo(undefined, storeOf(entry(A, 1)), 0, 0, A)).toBeUndefined();
    const extra = { [PROMPT_MEMO_KEY]: rememberedMemo(undefined, null, 0, 0, A, 1) };
    expect(rememberedMemo(extra, null, 0, 0, A, 2)).toBeUndefined();
  });

  it('keeps ten recent memos while preserving other slots and swipes', () => {
    let extra: Record<string, unknown> = { [PROMPT_MEMO_KEY]: { '1': { '0': [{ prompt: C, at: 0 }] } } };
    for (let i = 0; i < 12; i++) extra = { [PROMPT_MEMO_KEY]: rememberedMemo(extra, null, 0, 0, `<bbi_image>t${i}</bbi_image>`, i) };
    expect(memoItems(extra, 0, 0).map(item => item.at)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(memoItems(extra, 1, 0)).toEqual([{ prompt: C, at: 0 }]);
  });

  it('shows tag differences between a previous and the current version', () => {
    expect(tagDiff(A, B)).toEqual({ added: ['blue hair', 'smile'], removed: ['red hair'] });
  });
});
