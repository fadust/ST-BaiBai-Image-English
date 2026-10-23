import { getContext } from '@/st/context';
import { reactive } from 'vue';
import {
  findCharTag,
  normalizeCharTagStore,
  recomputeCharTags,
  removeCharTag,
  setGlobalCharTagSource,
  upsertCharTag,
  type CharTagEntry,
} from '@/state/charTags';

/**
 * Global character fixed-appearance library: a "read-only template" that applies across all chats.
 *
 * Purpose: characters such as the player character who "have the same face in every chat" get a profile once and it applies everywhere.
 * Hard constraint: **the AI can never write it** (charTags.applyCharTagOps discards changes by locked name);
 * only manual add/edit/delete by the user, or "promote to global" from a chat character, writes it. Users fix tag problems themselves.
 *
 * Storage: extensionSettings[GLOBAL_KEY] (→ the server's settings.json, synced across devices),
 * with revision + broadcast events, the same protocol as the shared channels/exclusion lists in settings.ts.
 * Entries reuse CharTagEntry but **keep no history** (there are no floors across chats, and no AI changes to roll back).
 *
 * Dependency direction: this module → charTags (normalize/CRUD/recompute); charTags → this module only through
 * the read-only getter injected via setGlobalCharTagSource, so there is no module cycle.
 */

const GLOBAL_KEY = 'baibai_image_char_global';
const GLOBAL_EVENT = 'st-baibai-image:char-global-changed';
const SCHEMA_VERSION = 1;

interface GlobalCharTagStore {
  schemaVersion: number;
  revision: number;
  entries: CharTagEntry[];
}

export const globalCharTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
let fingerprint = '';
let revision = 0;
let listenerBound = false;

function fingerprintOf(entries: CharTagEntry[]): string {
  return JSON.stringify(entries);
}

/** Global entries never carry history (no automatic changes to roll back, manual edits leave no trace; kept simple). */
function normalizeGlobalEntries(raw: unknown): CharTagEntry[] {
  return normalizeCharTagStore(raw).map(entry => ({ ...entry, history: [] }));
}

function readStore(raw: unknown): GlobalCharTagStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<GlobalCharTagStore>;
  if (!Array.isArray(store.entries)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    entries: normalizeGlobalEntries({ version: 3, entries: store.entries }),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: GlobalCharTagStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(globalCharTagLib.entries)) as CharTagEntry[],
  };
  ctx.extensionSettings[GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: GlobalCharTagStore): void {
  const next = fingerprintOf(store.entries);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  globalCharTagLib.entries = store.entries;
  fingerprint = next;
  // The derived library (merged seed + locked names) refreshes immediately when the global library changes
  recomputeCharTags();
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(GLOBAL_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/**
 * Startup initialisation: inject the entry source (must come before bindCharTagSync, since the first recomputation already includes the global library),
 * then adopt existing data from extensionSettings and attach the broadcast listener.
 */
export function initGlobalCharTags(): void {
  setGlobalCharTagSource(() => globalCharTagLib.entries);
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[GLOBAL_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
}

export function findGlobalCharTag(name: string): CharTagEntry | undefined {
  const clean = name.trim();
  return globalCharTagLib.entries.find(entry => entry.name === clean);
}

/** Adds/overwrites a global entry (called only on the user's manual path; oldName is for renaming). */
export function upsertGlobalCharTag(entry: CharTagEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  const [normalized] = normalizeGlobalEntries({ version: 3, entries: [{ ...entry, name }] });
  if (!normalized) return false;
  if (oldName && oldName !== name) {
    const oldIndex = globalCharTagLib.entries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) globalCharTagLib.entries.splice(oldIndex, 1);
  }
  const index = globalCharTagLib.entries.findIndex(candidate => candidate.name === name);
  if (index >= 0) globalCharTagLib.entries[index] = normalized;
  else globalCharTagLib.entries.push(normalized);
  persist();
  recomputeCharTags();
  return true;
}

export function removeGlobalCharTag(name: string): boolean {
  const clean = name.trim();
  const index = globalCharTagLib.entries.findIndex(entry => entry.name === clean);
  if (index < 0) return false;
  globalCharTagLib.entries.splice(index, 1);
  persist();
  recomputeCharTags();
  return true;
}

/**
 * Snapshots a chat character's **currently effective value** (including results the AI already produced in this chat) into the global library,
 * deletes this chat's copy and clears the character's floor ops in this chat; the global library then takes over,
 * every chat (including this one) follows the global value, and AI changes for that name are always ignored.
 */
export function promoteCharTagToGlobal(name: string): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (!upsertGlobalCharTag({ ...current, fields: { ...current.fields }, history: [] })) return false;
  removeCharTag(name);
  return true;
}

/**
 * The reverse exit: copies a global entry into this chat as a local copy. This chat then follows the copy (overriding global),
 * the name leaves the locked set, and the AI may change it in this chat as usual; other chats are unaffected.
 */
export function copyGlobalCharTagToChat(name: string): boolean {
  const global = findGlobalCharTag(name);
  if (!global) return false;
  return upsertCharTag(
    { ...global, fields: { ...global.fields }, history: [] },
    undefined,
    { recordChanges: false },
  );
}
