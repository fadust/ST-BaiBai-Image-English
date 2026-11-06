import { promptHash, type BbiImageStore } from '@/floor/storage';



export const PROMPT_MEMO_KEY = 'bbiPromptMemo';
const MAX_MEMO = 10;

export interface MemoItem {
  prompt: string;
  at: number;
}

export type PromptMemo = Record<string, Record<string, MemoItem[]>>;

export interface PromptVersion {
  hash: string;

  prompt: string;

  count: number;

  thumb?: string;
  lastAt: number;
}

function isMemoItem(value: unknown): value is MemoItem {
  return !!value && typeof (value as MemoItem).prompt === 'string' && typeof (value as MemoItem).at === 'number';
}


export function memoItems(extra: Record<string, unknown> | undefined, swipeId: number, seq: number): MemoItem[] {
  const memo = extra?.[PROMPT_MEMO_KEY];
  if (!memo || typeof memo !== 'object') return [];
  const list = (memo as Record<string, Record<string, unknown>>)[String(swipeId)]?.[String(seq)];
  return Array.isArray(list) ? list.filter(isMemoItem) : [];
}

function hasImages(store: BbiImageStore | null, swipeId: number, seq: number, hash: string): boolean {
  return (store?.[String(swipeId)]?.[hash] ?? []).some(entry => (entry.slotSeq ?? 0) === seq);
}


export function rememberedMemo(
  extra: Record<string, unknown> | undefined,
  store: BbiImageStore | null,
  swipeId: number,
  seq: number,
  prompt: string,
  now = Date.now(),
): PromptMemo | undefined {
  if (!prompt || hasImages(store, swipeId, seq, promptHash(prompt))) return undefined;
  const old = memoItems(extra, swipeId, seq);
  if (old.some(item => item.prompt === prompt)) return undefined;
  const raw = extra?.[PROMPT_MEMO_KEY];
  const memo: PromptMemo = raw && typeof raw === 'object' ? (raw as PromptMemo) : {};
  return {
    ...memo,
    [String(swipeId)]: {
      ...(memo[String(swipeId)] ?? {}),
      [String(seq)]: [...old, { prompt, at: now }].slice(-MAX_MEMO),
    },
  };
}


export function slotVersions(
  store: BbiImageStore | null,
  extra: Record<string, unknown> | undefined,
  swipeId: number,
  seq: number,
  currentTag: string,
): PromptVersion[] {
  const current = promptHash(currentTag);
  const versions = new Map<string, PromptVersion>();
  for (const [hash, list] of Object.entries(store?.[String(swipeId)] ?? {})) {
    if (hash === current || !Array.isArray(list)) continue;
    const mine = list.filter(entry => (entry.slotSeq ?? 0) === seq && typeof entry.prompt === 'string' && entry.prompt);
    if (!mine.length) continue;
    const ready = mine.filter(entry => entry.status === 'ready' && entry.path);
    const latest = mine.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    versions.set(hash, {
      hash,
      prompt: latest.prompt,
      count: ready.length,
      thumb: ready.reduce<(typeof ready)[number] | undefined>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), undefined)
        ?.path,
      lastAt: latest.createdAt,
    });
  }
  for (const item of memoItems(extra, swipeId, seq)) {
    const hash = promptHash(item.prompt);
    if (hash === current) continue;
    const known = versions.get(hash);
    if (known) known.lastAt = Math.max(known.lastAt, item.at);
    else versions.set(hash, { hash, prompt: item.prompt, count: 0, lastAt: item.at });
  }
  return [...versions.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function tagList(prompt: string): string[] {
  const inner = prompt.replace(/^<bbi_image[^>]*>/i, '').replace(/<\/bbi_image>\s*$/i, '').split(/<(?:nl|negative|characters|size)>/i)[0] ?? '';
  return inner
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
}


export function tagDiff(currentTag: string, oldTag: string): { added: string[]; removed: string[] } {
  const now = new Set(tagList(currentTag));
  const old = new Set(tagList(oldTag));
  return {
    added: [...old].filter(tag => !now.has(tag)),
    removed: [...now].filter(tag => !old.has(tag)),
  };
}
