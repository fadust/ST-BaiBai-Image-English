import { naiDefaultUndesired, parseNaiv4vibe } from '@/backends/nai';
import {
  clampVibeStrength,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import { getContext } from '@/st/context';
import { newNaiArtist, type NaiArtistPreset, type NaiVibe } from '@/state/settings';

/**
 * Compatible vibe import from Chiehime (st-chatu8) (read-only; never writes any Chiehime data).
 *
 * chatu8's vibe storage model:
 * - in extension_settings['st-chatu8']:
 *   - vibePresets: { [preset name]: { vibeDataId, strength, model, ... } } (Vibe generator presets)
 *   - vibeGroups: { [group name]: { vibes: [{ vibeDataId, strength }] } } (NAI4/4.5 vibe groups)
 *   - configImageStorage: { [id]: { path } }: path mapping when stored on the SillyTavern server
 * - the vibe data itself is a JSON string in .naiv4vibe format, in one of two places:
 *   a) a file on the SillyTavern server (configImageStorage[id].path can be fetched directly);
 *   b) the config_images table of the IndexedDB database "chatu8_config_images" (records {id, data}).
 * The format matches ours (both are the official novelai-vibe-transfer), so parsing reuses parseNaiv4vibe directly.
 */

/** Chiehime's namespace key in extension_settings. */
export const CHATU8_SETTINGS_KEY = 'st-chatu8';
const CHATU8_DB_NAME = 'chatu8_config_images';
const CHATU8_STORE_NAME = 'config_images';
const FETCH_TIMEOUT_MS = 20_000;

export { vibeFingerprint } from '@/backends/vibeStore';

export interface Chatu8VibeRef {
  vibeDataId: string;
  strength: number;
  /** Source name: preset name or group name (used to name the imported entry). */
  source: string;
  kind: 'preset' | 'group';
}

export interface Chatu8ArtistRef {
  /** Source preset name in st-chatu8. */
  source: string;
  /** Leading fixed positive (fixedPrompt) → target artist-string slot (start of the positive, matching Chiehime's assembly position). */
  prompt: string;
  /** Trailing fixed positive (fixedPrompt_end) → target positive quality-tag slot (end of the positive, matching Chiehime's assembly position). */
  quality: string;
  /** Fixed negative (negativePrompt); on import the current model's official baseline is prepended (same as Chiehime: official UCP + user negative). */
  negative: string;
  /** Whether this is the currently selected NovelAI prompt preset in st-chatu8. */
  active: boolean;
}

/** Collect every shared st-chatu8 prompt preset; the source does not track per-backend ownership. */
export function collectChatu8ArtistRefs(chatu8: unknown): Chatu8ArtistRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  if (!root.yushe || typeof root.yushe !== 'object') return [];
  const activeName = typeof root.yusheid_novelai === 'string' ? root.yusheid_novelai : '';
  const refs: Chatu8ArtistRef[] = [];
  for (const [source, value] of Object.entries(root.yushe)) {
    if (!value || typeof value !== 'object') continue;
    const preset = value as Record<string, unknown>;
    refs.push({
      source,
      prompt: typeof preset.fixedPrompt === 'string' ? preset.fixedPrompt.trim() : '',
      quality: typeof preset.fixedPrompt_end === 'string' ? preset.fixedPrompt_end.trim() : '',
      negative: typeof preset.negativePrompt === 'string' ? preset.negativePrompt.trim() : '',
      active: source === activeName,
    });
  }
  return refs;
}

export interface Chatu8ArtistDetectInfo {
  found: boolean;
  total: number;
}

export function detectChatu8Artists(chatu8: unknown): Chatu8ArtistDetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0 };
  return { found: true, total: collectChatu8ArtistRefs(chatu8).length };
}

/** Where one preset goes (one-to-one with the order of collectChatu8ArtistRefs; shared by preview badges and saving). */
export interface Chatu8ArtistPlan {
  source: string;
  /** Leading fixed positive (for preview). */
  prompt: string;
  /** Trailing fixed positive (for preview). */
  quality: string;
  /** Original fixed negative text (for preview; the saved value is in preset, with the official baseline already prepended). */
  negative: string;
  active: boolean;
  /** import = new entry; overwrite = replace the existing entry with the same name; skip = identical content, skipped. */
  state: 'import' | 'overwrite' | 'skip';
  /** Target entry id: overwrite/skip point to the existing entry; import points to the new entry. */
  targetId: string;
  /** Carries the final value to save for import/overwrite (for overwrite, id = the existing entry's id). */
  preset?: NaiArtistPreset;
}

export interface Chatu8ArtistImportResult {
  found: boolean;
  imported: number;
  overwritten: number;
  duplicates: number;
  plans: Chatu8ArtistPlan[];
  /** Matching target id for the source's active NovelAI preset; the caller decides whether to select it. */
  activeArtistId: string;
}

/**
 * Moves all of Chiehime's prompt presets into the artist-string library (pure function; never writes Chiehime).
 *
 * Mapping (one-to-one with Chiehime's assembly positions at generation):
 * - fixedPrompt (leading fixed positive) → target prompt (artist-string slot, start of the positive);
 * - fixedPrompt_end (trailing fixed positive) → target quality (positive quality-tag slot, end of the positive);
 * - negativePrompt (fixed negative) → target negative. Chiehime's rule is "official UCP + user negative",
 *   so when the user negative is non-empty, the current model's official baseline is baked in front of it (fixed at import, not following later model switches);
 *   when the user negative is empty it stays empty and uses the fallback chain, so the baseline still follows the model, the same as Chiehime using only UCP with an empty negative.
 *
 * Same name means the same recipe: different content → overwrite (entries from the old migration, which stuffed the whole positive into the artist string,
 * are fixed by re-importing); identical → skip. Idempotent; can be run again at any time.
 */
export function importArtistsFromChatu8(
  existing: readonly NaiArtistPreset[],
  chatu8: unknown = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY],
  model: string,
): Chatu8ArtistImportResult {
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, overwritten: 0, duplicates: 0, plans: [], activeArtistId: '' };
  }

  // Same-name overwrite targets "the first entry with that name" (the library allows duplicate names and is keyed by id; other same-name entries are untouched).
  const byName = new Map<string, NaiArtistPreset>();
  for (const preset of existing) {
    const name = preset.name.trim();
    if (name && !byName.has(name)) byName.set(name, preset);
  }

  const bakeNegative = (ref: Chatu8ArtistRef): string =>
    ref.negative ? [naiDefaultUndesired(model), ref.negative].filter(Boolean).join(', ') : '';

  const buildPreset = (ref: Chatu8ArtistRef, negative: string): NaiArtistPreset => {
    const preset = newNaiArtist(ref.source);
    preset.prompt = ref.prompt;
    preset.quality = ref.quality;
    preset.negative = negative;
    return preset;
  };

  const result: Chatu8ArtistImportResult = {
    found: true,
    imported: 0,
    overwritten: 0,
    duplicates: 0,
    plans: [],
    activeArtistId: '',
  };

  for (const ref of collectChatu8ArtistRefs(chatu8)) {
    const negative = bakeNegative(ref);
    const sameContent = (p: NaiArtistPreset) =>
      p.prompt.trim() === ref.prompt && p.quality.trim() === ref.quality && p.negative.trim() === negative;

    const existingPreset = byName.get(ref.source.trim());
    if (existingPreset) {
      if (sameContent(existingPreset)) {
        result.duplicates++;
        result.plans.push({ ...ref, negative, state: 'skip', targetId: existingPreset.id });
      } else {
        const preset = buildPreset(ref, negative);
        preset.id = existingPreset.id;
        result.overwritten++;
        result.plans.push({ ...ref, negative, state: 'overwrite', targetId: existingPreset.id, preset });
      }
      if (ref.active) result.activeArtistId = existingPreset.id;
      continue;
    }

    const preset = buildPreset(ref, negative);
    result.imported++;
    result.plans.push({ ...ref, negative, state: 'import', targetId: preset.id, preset });
    if (ref.active) result.activeArtistId = preset.id;
  }
  return result;
}

/** Collects all vibe references from chatu8 settings (presets + groups), deduplicated by vibeDataId (presets first, for nicer names). */
export function collectChatu8VibeRefs(chatu8: unknown): Chatu8VibeRef[] {
  if (!chatu8 || typeof chatu8 !== 'object') return [];
  const root = chatu8 as Record<string, unknown>;
  const refs: Chatu8VibeRef[] = [];
  const seen = new Set<string>();
  const push = (vibeDataId: unknown, strength: unknown, source: string, kind: Chatu8VibeRef['kind']) => {
    if (typeof vibeDataId !== 'string' || !vibeDataId || seen.has(vibeDataId)) return;
    seen.add(vibeDataId);
    refs.push({ vibeDataId, strength: clampVibeStrength(strength), source, kind });
  };

  const presets = root.vibePresets;
  if (presets && typeof presets === 'object') {
    for (const [name, preset] of Object.entries(presets)) {
      const p = preset as Record<string, unknown> | null;
      if (p && typeof p === 'object') push(p.vibeDataId, p.strength, name, 'preset');
    }
  }
  const groups = root.vibeGroups;
  if (groups && typeof groups === 'object') {
    for (const [groupName, group] of Object.entries(groups)) {
      const g = group as { vibes?: unknown } | null;
      if (!g || !Array.isArray(g.vibes)) continue;
      for (const vibe of g.vibes) {
        const v = vibe as Record<string, unknown> | null;
        if (v && typeof v === 'object') push(v.vibeDataId, v.strength, groupName, 'group');
      }
    }
  }
  return refs;
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return '';
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  return header.includes(';base64') ? base64ToUtf8(data) : decodeURIComponent(data);
}

/** Same as the server branch of chatu8's getConfigText: fetch the path, then try decoding as data:/JSON/base64. */
async function fetchServerText(path: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(path, { signal: controller.signal });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (text.startsWith('data:')) return decodeDataUrlText(text);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;
    try {
      return base64ToUtf8(trimmed);
    } catch {
      return text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads chatu8's IndexedDB (opened without a version number to avoid triggering an upgrade; reads a single record only).
 * data may be a string (text) or an ArrayBuffer (an image, never vibe text; ignored).
 */
let chatu8DbPromise: Promise<IDBDatabase | null> | null = null;

function openChatu8Db(): Promise<IDBDatabase | null> {
  if (chatu8DbPromise) return chatu8DbPromise;
  chatu8DbPromise = new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(CHATU8_DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHATU8_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
  });
  return chatu8DbPromise;
}

async function readChatu8Store(id: string): Promise<string | null> {
  const db = await openChatu8Db();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const get = db.transaction([CHATU8_STORE_NAME], 'readonly').objectStore(CHATU8_STORE_NAME).get(id);
      get.onsuccess = () => {
        const data = (get.result as { data?: unknown } | undefined)?.data;
        if (typeof data === 'string') resolve(data);
        else resolve(null);
      };
      get.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface Chatu8DetectInfo {
  /** Whether Chiehime settings were detected. */
  found: boolean;
  /** Total vibe references (presets + within groups, deduplicated by id). */
  total: number;
  presets: number;
  groups: number;
}

/** Chiehime vibe detection: reads only the reference list in settings (synchronous, cheap) for live display in the migration panel. */
export function detectChatu8Vibes(chatu8: unknown): Chatu8DetectInfo {
  if (!chatu8 || typeof chatu8 !== 'object') return { found: false, total: 0, presets: 0, groups: 0 };
  const refs = collectChatu8VibeRefs(chatu8);
  return {
    found: true,
    total: refs.length,
    presets: refs.filter(r => r.kind === 'preset').length,
    groups: refs.filter(r => r.kind === 'group').length,
  };
}

/** The old migration joined the group name into the display name with the separator " · ". */
const LEGACY_GROUP_SEPARATOR = ' · ';

export interface PrefixGroupPlan {
  id: string;
  /** Group name recognised from the name prefix. */
  group: string;
  /** Display name with the prefix removed. */
  name: string;
}

/**
 * Adds groups to an "already migrated" library: the old version joined names as "group name · original name"; this restores the prefix as group.
 *
 * Only touches entries with an empty group (never overriding groups the user set by hand), and only when both prefix and remainder are non-empty.
 * Pure function returning only the entries that need changes; the caller decides whether to save, since users must see "will tidy N" before clicking.
 */
export function planPrefixGroups(
  vibes: readonly Pick<NaiVibe, 'id' | 'name' | 'group'>[],
): PrefixGroupPlan[] {
  const plans: PrefixGroupPlan[] = [];
  for (const vibe of vibes) {
    if (vibe.group.trim()) continue;
    const at = vibe.name.indexOf(LEGACY_GROUP_SEPARATOR);
    if (at <= 0) continue;
    const group = vibe.name.slice(0, at).trim();
    const name = vibe.name.slice(at + LEGACY_GROUP_SEPARATOR.length).trim();
    if (!group || !name) continue;
    plans.push({ id: vibe.id, group, name });
  }
  return plans;
}

export interface Chatu8ImportResult {
  /** Whether chatu8 settings were detected. */
  found: boolean;
  imported: number;
  /** Skipped because the content duplicates the library (or something already imported in this run). */
  duplicates: number;
  /** The reference exists but the data couldn't be fetched/parsed. */
  failed: number;
  /** New entries to add (the caller pushes them into settings.nai.vibes). */
  vibes: NaiVibe[];
}

let importSeq = 0;

export interface Chatu8ImportOptions {
  onProgress?: (current: number, total: number) => void;
}

/**
 * Imports all vibes from st-chatu8. Pass the current library as existing (for content deduplication).
 * A single failure doesn't block the rest; a null result means chatu8 was not detected.
 */
export async function importVibesFromChatu8(
  existing: NaiVibe[],
  options: Chatu8ImportOptions = {},
): Promise<Chatu8ImportResult> {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  if (!chatu8 || typeof chatu8 !== 'object') {
    return { found: false, imported: 0, duplicates: 0, failed: 0, vibes: [] };
  }
  const refs = collectChatu8VibeRefs(chatu8);
  const serverMap =
    (chatu8 as Record<string, unknown>).configImageStorage &&
    typeof (chatu8 as Record<string, unknown>).configImageStorage === 'object'
      ? ((chatu8 as Record<string, unknown>).configImageStorage as Record<string, { path?: unknown }>)
      : {};

  const fingerprints = new Set(existing.map(v => v.fingerprint).filter(Boolean));
  const result: Chatu8ImportResult = { found: true, imported: 0, duplicates: 0, failed: 0, vibes: [] };

  for (const [index, ref] of refs.entries()) {
    options.onProgress?.(index + 1, refs.length);
    // Server first (same as chatu8), then IndexedDB if that fails
    const path = serverMap[ref.vibeDataId]?.path;
    let text = typeof path === 'string' && path ? await fetchServerText(path) : null;
    if (!text) text = await readChatu8Store(ref.vibeDataId);
    if (!text) {
      result.failed++;
      continue;
    }
    // IndexedDB may store a dataURL string; strip the wrapper first
    if (text.startsWith('data:')) text = decodeDataUrlText(text);
    try {
      const parsed = parseNaiv4vibe(text);
      const fingerprint = vibeFingerprint(parsed.encodings);
      if (fingerprints.has(fingerprint)) {
        result.duplicates++;
        continue;
      }
      const id = `vibe_${Date.now()}_${++importSeq}`;
      const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
      const paths = await saveVibeFiles(data, null, id);
      fingerprints.add(fingerprint);
      result.vibes.push(
        vibeMetaFromData(
          id,
          // Presets use the preset name (given by the user); group entries have no name, so the vibe file's original name is used (the group name already goes into the group field,
          // no longer joined into the display name, which would become a repetitive "group name · group name · xxx")
          ref.kind === 'preset' ? ref.source : parsed.name,
          paths.dataPath,
          paths.thumbnailPath,
          data,
          ref.strength,
          false,
          // Chiehime's group structure is kept as-is; presets belong to no group
          ref.kind === 'group' ? ref.source : '',
        ),
      );
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
