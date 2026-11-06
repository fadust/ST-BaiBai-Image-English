import type { Passage } from './passage';



const STORAGE_KEY = 'bbi-passage-pick-drafts';
const MAX_DRAFTS = 30;

export interface PickDraft {
  regen: boolean;

  groups: string[][];
  extra: string;
  savedAt: number;
}

type Drafts = Record<string, PickDraft>;

function load(): Drafts {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Drafts) : {};
  } catch {
    return {};
  }
}

function store(drafts: Drafts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {

  }
}

function isDraft(value: unknown): value is PickDraft {
  const draft = value as PickDraft;
  return (
    !!draft &&
    typeof draft.regen === 'boolean' &&
    typeof draft.extra === 'string' &&
    Array.isArray(draft.groups) &&
    draft.groups.every(group => Array.isArray(group) && group.every(text => typeof text === 'string'))
  );
}


export function draftFrom(regen: boolean, groups: string[][], extra: string, passages: Passage[], now = Date.now()): PickDraft {
  const text = new Map(passages.map(p => [p.id, p.text]));
  return {
    regen,
    groups: groups.map(group => group.map(id => text.get(id)).filter((t): t is string => t !== undefined)),
    extra,
    savedAt: now,
  };
}


export function draftPick(
  draft: PickDraft | undefined,
  regen: boolean,
  passages: Passage[],
): { groups: string[][]; extra: string } | undefined {
  if (!isDraft(draft) || draft.regen !== regen) return undefined;
  const used = new Set<string>();
  const groups = draft.groups
    .map(group =>
      group
        .map(text => passages.find(p => p.text === text && !used.has(p.id))?.id)
        .filter((id): id is string => {
          if (!id) return false;
          used.add(id);
          return true;
        }),
    )
    .filter(group => group.length);
  if (!groups.length && !draft.extra) return undefined;
  return { groups: groups.length ? groups : [[]], extra: draft.extra };
}

export function readDraft(key: string): PickDraft | undefined {
  const draft = load()[key];
  return isDraft(draft) ? draft : undefined;
}

export function saveDraft(key: string, draft: PickDraft): void {
  const drafts = load();
  delete drafts[key];
  drafts[key] = draft;
  const keys = Object.keys(drafts);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DRAFTS))) delete drafts[old];
  store(drafts);
}

export function clearDraft(key: string): void {
  const drafts = load();
  if (!(key in drafts)) return;
  delete drafts[key];
  store(drafts);
}
