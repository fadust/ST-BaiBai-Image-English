import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';

/**
 * Character fixed-appearance library.
 *
 * Three layers of truth:
 * - global library (across chats): extensionSettings, managed by globalCharTags.ts, maintained only by the user by hand;
 *   AI changes never apply to locked names; injected via setGlobalCharTagSource, so this module doesn't depend back on it.
 * - manual entries/legacy snapshots: chatMetadata[META_KEY], not removed with floors.
 * - automatic profiles and changes: extra[BBI_CHAR_EXTRA_KEY] of the target message, saved and deleted together with the message/swipe.
 *
 * charTagLib is only a reactive derived cache: merged baseline (this chat first, global fills missing names) + replay of automatic changes in physical floor order.
 */

export type CharTagField = 'fandom' | 'sex' | 'hair' | 'eyes' | 'skin' | 'body' | 'extra' | 'outfit';

export const CHAR_TAG_FIELDS: readonly CharTagField[] = [
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
];

export const CHAR_TAG_FIELD_LABELS: Record<CharTagField, string> = {
  fandom: 'Fan-work identity tag',
  sex: 'Gender',
  hair: 'Hair',
  eyes: 'Eyes',
  skin: 'Skin',
  body: 'Build',
  extra: 'Distinctive features',
  outfit: 'Signature outfit',
};

export type CharTagSource = 'book' | 'manual' | 'ai';
export type CharTagHistoryField = CharTagField | 'new' | 'raw' | 'nl';

export interface CharTagChangeRecord {
  field: CharTagHistoryField;
  from: string;
  to: string;
  reason: string;
  /** Automatic changes get the current physical floor number on replay; manual edits/rollbacks use -1. */
  floor: number;
  at: number;
}

export interface CharTagEntry {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  source: CharTagSource;
  desc: string;
  history: CharTagChangeRecord[];
}

export interface CharTagNewOp {
  kind: 'new';
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  source: 'book' | 'ai';
  desc: string;
  reason: string;
  at: number;
}

export interface CharTagSetOp {
  kind: 'set';
  name: string;
  field: CharTagField | 'raw' | 'nl';
  value: string;
  reason: string;
  at: number;
}

export type CharTagAutoOp = CharTagNewOp | CharTagSetOp;

export interface CharTagFloorDelta {
  v: 1;
  swipe: number;
  ops: CharTagAutoOp[];
}

export const BBI_CHAR_EXTRA_KEY = 'bbiCharChanges';
const META_KEY = 'baibai_image_char_tags';
const HISTORY_CAP = 50;

interface CharTagStore {
  version: 3;
  entries: CharTagEntry[];
}

export const charTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
/** Names in this chat's baseline (manual layer), reactive; the UI uses it to tell "this chat overrides global". Synced on recompute. */
export const charTagBaseNames = reactive<Set<string>>(new Set());
let baseEntries: CharTagEntry[] = [];

/**
 * Entry source for the global character library (across chats), injected by globalCharTags.ts at startup.
 * Injected rather than imported: the global module needs normalize/CRUD from here, and importing both ways would create a module cycle.
 */
let globalCharTagSource: () => CharTagEntry[] = () => [];

export function setGlobalCharTagSource(provider: () => CharTagEntry[]): void {
  globalCharTagSource = provider;
}

/**
 * Derivation seed = this chat's baseline + global library filling missing names (same-name entries in this chat win, i.e. "this chat overrides global").
 */
export function mergeCharTagSeed(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): CharTagEntry[] {
  if (!globalEntries.length) return chatBaseEntries;
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return [...chatBaseEntries, ...globalEntries.filter(entry => !chatNames.has(entry.name))];
}

/**
 * Locked name set: characters present in the global library with no same-name entry in this chat's baseline.
 * AI changes never apply to locked names: global entries are maintained only by the user, who fixes any tag problems themselves.
 * Creating a same-name entry manually in this chat unlocks it (the "this chat overrides" the user explicitly asked for; the AI may change it as usual).
 */
export function computeLockedCharTagNames(
  chatBaseEntries: CharTagEntry[],
  globalEntries: CharTagEntry[],
): Set<string> {
  if (!globalEntries.length) return new Set();
  const chatNames = new Set(chatBaseEntries.map(entry => entry.name));
  return new Set(
    globalEntries.filter(entry => !chatNames.has(entry.name)).map(entry => entry.name),
  );
}

function mergedSeedEntries(): CharTagEntry[] {
  return mergeCharTagSeed(baseEntries, globalCharTagSource());
}

/** Currently effective locked name set (global ⊖ this chat's baseline). */
export function lockedCharTagNames(): ReadonlySet<string> {
  return computeLockedCharTagNames(baseEntries, globalCharTagSource());
}

export function emptyCharFields(): Record<CharTagField, string> {
  return { fandom: '', sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' };
}

export function charFieldsEmpty(fields: Record<CharTagField, string>): boolean {
  return CHAR_TAG_FIELDS.every(field => !(fields[field] ?? '').trim());
}

export function buildEntryTag(entry: Pick<CharTagEntry, 'fields' | 'raw'>): string {
  if (entry.raw.trim() && charFieldsEmpty(entry.fields)) return entry.raw.trim();
  return CHAR_TAG_FIELDS.map(field => (entry.fields[field] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function isHistoryField(value: string): value is CharTagHistoryField {
  return (CHAR_TAG_FIELDS as readonly string[]).includes(value) || value === 'new' || value === 'raw' || value === 'nl';
}

function isSetField(value: string): value is CharTagSetOp['field'] {
  return (CHAR_TAG_FIELDS as readonly string[]).includes(value) || value === 'raw' || value === 'nl';
}

function normalizeHistory(raw: unknown): CharTagChangeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CharTagChangeRecord[] = [];
  for (const item of raw.slice(-HISTORY_CAP)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<CharTagChangeRecord>;
    const field = typeof record.field === 'string' ? record.field : '';
    if (!isHistoryField(field)) continue;
    out.push({
      field,
      from: typeof record.from === 'string' ? record.from : '',
      to: typeof record.to === 'string' ? record.to : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      floor: typeof record.floor === 'number' && Number.isFinite(record.floor) ? record.floor : -1,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    });
  }
  return out;
}

function normalizeFields(raw: unknown): Record<CharTagField, string> {
  const fields = emptyCharFields();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
  for (const field of CHAR_TAG_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string') fields[field] = value.trim();
  }
  return fields;
}

function normalizeEntry(raw: unknown): CharTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagEntry> & { tags?: unknown };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const fields = normalizeFields(value.fields);
  const legacyTags = typeof value.tags === 'string' ? value.tags.trim() : '';
  const rawTag = typeof value.raw === 'string' ? value.raw.trim() : legacyTags;
  if (!rawTag && charFieldsEmpty(fields)) return null;
  return {
    name,
    fields,
    raw: rawTag,
    nl: typeof value.nl === 'string' ? value.nl.trim() : '',
    source: value.source === 'book' || value.source === 'ai' ? value.source : 'manual',
    desc: typeof value.desc === 'string' ? value.desc : '',
    history: normalizeHistory(value.history),
  };
}

function cloneEntry(entry: CharTagEntry): CharTagEntry {
  return {
    ...entry,
    fields: { ...entry.fields },
    history: entry.history.map(record => ({ ...record })),
  };
}

export function normalizeCharTagStore(raw: unknown): CharTagEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as Partial<CharTagStore>).entries;
  if (!Array.isArray(entries)) return [];
  const out: CharTagEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = normalizeEntry(item);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

function normalizeAutoOp(raw: unknown): CharTagAutoOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
  if (!name) return null;
  if (value.kind === 'new') {
    const fields = normalizeFields(value.fields);
    const rawTag = typeof value.raw === 'string' ? value.raw.trim() : '';
    if (!rawTag && charFieldsEmpty(fields)) return null;
    return {
      kind: 'new',
      name,
      fields,
      raw: rawTag,
      nl: typeof value.nl === 'string' ? value.nl.trim() : '',
      source: value.source === 'book' ? 'book' : 'ai',
      desc: typeof value.desc === 'string' ? value.desc : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
      at,
    };
  }
  const field = typeof value.field === 'string' ? value.field : '';
  const next = typeof value.value === 'string' ? value.value.trim() : '';
  if (value.kind !== 'set' || !isSetField(field) || !next) return null;
  return {
    kind: 'set',
    name,
    field,
    value: next,
    reason: typeof value.reason === 'string' ? value.reason : '',
    at,
  };
}

export function readCharTagFloorDelta(message: STMessage | undefined): CharTagFloorDelta | null {
  const raw = message?.extra?.[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return null;
  const swipe = typeof value.swipe === 'number' && Number.isInteger(value.swipe) ? value.swipe : 0;
  const ops = value.ops.map(normalizeAutoOp).filter((op): op is CharTagAutoOp => !!op);
  return { v: 1, swipe, ops };
}

function activeSwipe(message: STMessage): number {
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function pushHistory(entry: CharTagEntry, record: CharTagChangeRecord): void {
  entry.history.push(record);
  if (entry.history.length > HISTORY_CAP) entry.history.splice(0, entry.history.length - HISTORY_CAP);
}

export function createCharTagNewOp(
  entry: Pick<CharTagEntry, 'name' | 'fields' | 'raw' | 'nl' | 'source' | 'desc'>,
  reason = '',
  at = Date.now(),
): CharTagNewOp | null {
  const normalized = normalizeEntry({ ...entry, history: [] });
  if (!normalized) return null;
  return {
    kind: 'new',
    name: normalized.name,
    fields: normalized.fields,
    raw: normalized.raw,
    nl: normalized.nl,
    source: normalized.source === 'book' ? 'book' : 'ai',
    desc: normalized.desc,
    reason,
    at,
  };
}

export function createCharTagSetOp(
  name: string,
  field: CharTagSetOp['field'],
  value: string,
  reason = '',
  at = Date.now(),
): CharTagSetOp | null {
  const cleanName = name.trim();
  const cleanValue = value.trim();
  if (!cleanName || !cleanValue) return null;
  return { kind: 'set', name: cleanName, field, value: cleanValue, reason, at };
}

export function applyCharTagOps(
  entries: CharTagEntry[],
  ops: CharTagAutoOp[],
  floor: number,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  const out = entries.map(cloneEntry);
  for (const op of ops) {
    // Locked characters (global library) don't accept AI changes: both new and set are discarded
    if (locked?.has(op.name)) continue;
    if (op.kind === 'new') {
      if (out.some(entry => entry.name === op.name)) continue;
      const entry: CharTagEntry = {
        name: op.name,
        fields: { ...op.fields },
        raw: op.raw,
        nl: op.nl,
        source: op.source,
        desc: op.desc,
        history: [],
      };
      pushHistory(entry, {
        field: 'new',
        from: '',
        to: buildEntryTag(entry),
        reason: op.reason,
        floor,
        at: op.at,
      });
      out.push(entry);
      continue;
    }

    const entry = out.find(candidate => candidate.name === op.name);
    if (!entry) continue;
    if (op.field !== 'raw' && op.field !== 'nl' && entry.raw.trim() && charFieldsEmpty(entry.fields)) continue;
    const current = op.field === 'raw' ? entry.raw : op.field === 'nl' ? entry.nl : entry.fields[op.field];
    if (current === op.value) continue;
    if (op.field === 'raw') entry.raw = op.value;
    else if (op.field === 'nl') entry.nl = op.value;
    else entry.fields[op.field] = op.value;
    entry.source = 'ai';
    entry.desc = '';
    pushHistory(entry, {
      field: op.field,
      from: current,
      to: op.value,
      reason: op.reason,
      floor,
      at: op.at,
    });
  }
  return out;
}

export function deriveCharTags(
  seedEntries: CharTagEntry[],
  chat: STMessage[],
  upToExclusive = chat.length,
  locked?: ReadonlySet<string>,
): CharTagEntry[] {
  let entries = seedEntries.map(cloneEntry);
  const end = Math.min(Math.max(0, upToExclusive), chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readCharTagFloorDelta(message);
    if (!delta || delta.swipe !== activeSwipe(message)) continue;
    entries = applyCharTagOps(entries, delta.ops, floor, locked);
  }
  return entries;
}

export function charTagsBeforeFloor(floor: number): CharTagEntry[] {
  const chat = getContext()?.chat ?? [];
  return deriveCharTags(mergedSeedEntries(), chat, floor, lockedCharTagNames());
}

export function makeCharTagFloorDelta(ops: CharTagAutoOp[], swipe: number): CharTagFloorDelta | undefined {
  return ops.length ? { v: 1, swipe, ops } : undefined;
}

export function recomputeCharTags(): void {
  const chat = getContext()?.chat ?? [];
  charTagLib.entries = deriveCharTags(mergedSeedEntries(), chat, chat.length, lockedCharTagNames());
  charTagBaseNames.clear();
  for (const entry of baseEntries) charTagBaseNames.add(entry.name);
}

export function hydrateCharTags(): void {
  const raw = getContext()?.chatMetadata?.[META_KEY];
  // v2 whole-library snapshots can't reliably be traced back to source floors; they are kept as the baseline during migration so users' existing data isn't lost.
  baseEntries = normalizeCharTagStore(raw);
  recomputeCharTags();
}

function persistBase(): void {
  const context = getContext();
  if (!context?.chatMetadata) return;
  const store: CharTagStore = {
    version: 3,
    entries: baseEntries.map(cloneEntry),
  };
  context.chatMetadata[META_KEY] = store;
  context.saveMetadataDebounced?.();
}

function stripOpsFromExtra(extra: Record<string, unknown> | undefined, names: Set<string>): boolean {
  if (!extra) return false;
  const raw = extra[BBI_CHAR_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Partial<CharTagFloorDelta>;
  if (value.v !== 1 || !Array.isArray(value.ops)) return false;
  const nextOps = value.ops
    .map(normalizeAutoOp)
    .filter((op): op is CharTagAutoOp => !!op && !names.has(op.name));
  if (nextOps.length === value.ops.length) return false;
  if (nextOps.length) {
    extra[BBI_CHAR_EXTRA_KEY] = {
      v: 1,
      swipe: typeof value.swipe === 'number' ? value.swipe : 0,
      ops: nextOps,
    } satisfies CharTagFloorDelta;
  } else {
    delete extra[BBI_CHAR_EXTRA_KEY];
  }
  return true;
}

/**
 * A manual edit/deletion means the user takes over the current result: the character's past automatic floor operations are folded into the manual baseline,
 * and same-name operations in existing messages are cleared. Later new floors can still be changed by the AI.
 */
function detachFromExistingFloors(...rawNames: Array<string | undefined>): void {
  const names = new Set(rawNames.map(name => name?.trim()).filter((name): name is string => !!name));
  const context = getContext();
  if (!names.size || !context?.chat) return;
  let changed = false;
  for (const message of context.chat) {
    changed = stripOpsFromExtra(message.extra, names) || changed;
    for (const swipeInfo of message.swipe_info ?? []) {
      changed = stripOpsFromExtra(swipeInfo?.extra, names) || changed;
    }
  }
  if (changed) {
    void context.saveChat?.().catch(error => {
      console.warn('[BaiBai Image] Manual role change has taken effect, but clearing and saving the old floor role records failed', error);
    });
  }
}

export function findCharTag(name: string): CharTagEntry | undefined {
  return charTagLib.entries.find(entry => entry.name === name);
}

export interface UpsertOptions {
  recordChanges?: boolean;
}

export function upsertCharTag(
  entry: CharTagEntry,
  oldName?: string,
  opts: UpsertOptions = {},
): boolean {
  const name = entry.name.trim();
  if (!name || !buildEntryTag(entry)) return false;
  const previous = findCharTag(oldName ?? name);
  const next: CharTagEntry = {
    name,
    fields: normalizeFields(entry.fields),
    raw: entry.raw.trim(),
    nl: entry.nl.trim(),
    source: entry.source,
    desc: entry.desc,
    history: entry.history.length
      ? entry.history.map(record => ({ ...record }))
      : (previous?.history.map(record => ({ ...record })) ?? []),
  };
  if (opts.recordChanges && previous) {
    const at = Date.now();
    for (const field of CHAR_TAG_FIELDS) {
      if (previous.fields[field] !== next.fields[field]) {
        pushHistory(next, {
          field,
          from: previous.fields[field],
          to: next.fields[field],
          reason: 'Manual editing',
          floor: -1,
          at,
        });
      }
    }
    if (previous.raw !== next.raw && (previous.raw || next.raw)) {
      pushHistory(next, { field: 'raw', from: previous.raw, to: next.raw, reason: 'Manual editing', floor: -1, at });
    }
    if (previous.nl !== next.nl && (previous.nl || next.nl)) {
      pushHistory(next, { field: 'nl', from: previous.nl, to: next.nl, reason: 'Manual editing', floor: -1, at });
    }
  }

  detachFromExistingFloors(oldName, name);
  if (oldName && oldName !== name) {
    const oldIndex = baseEntries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) baseEntries.splice(oldIndex, 1);
  }
  const index = baseEntries.findIndex(candidate => candidate.name === name);
  if (index >= 0) baseEntries[index] = next;
  else baseEntries.push(next);
  persistBase();
  recomputeCharTags();
  return true;
}

export function removeCharTag(name: string): boolean {
  const cleanName = name.trim();
  if (!cleanName || !findCharTag(cleanName)) return false;
  detachFromExistingFloors(cleanName);
  const index = baseEntries.findIndex(entry => entry.name === cleanName);
  if (index >= 0) baseEntries.splice(index, 1);
  persistBase();
  recomputeCharTags();
  return true;
}

export function rollbackCharTag(name: string, record: CharTagChangeRecord): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (record.field === 'new') return removeCharTag(name);
  const next = cloneEntry(current);
  if (record.field === 'raw') next.raw = record.from;
  else if (record.field === 'nl') next.nl = record.from;
  else next.fields[record.field] = record.from;
  next.source = 'manual';
  next.desc = '';
  pushHistory(next, {
    field: record.field,
    from: record.to,
    to: record.from,
    reason: 'Manual rollback',
    floor: -1,
    at: Date.now(),
  });
  return upsertCharTag(next, name);
}

let bound = false;

export function bindCharTagSync(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, hydrateCharTags);
  const recomputeLater = () => setTimeout(recomputeCharTags, 0);
  if (context.eventTypes.MESSAGE_DELETED) {
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, recomputeLater);
  }
  if (context.eventTypes.MESSAGE_SWIPED) {
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, recomputeLater);
  }
  hydrateCharTags();
}
