import { utf8ToBase64 } from '@/base64';
import { deleteUploadedFile, uploadBase64File } from '@/floor/upload';
import type { NaiVibe, NaiVibeData, NaiVibeEncodings } from '@/state/settings';
import { randomUuid } from '@/randomUuid';

const FETCH_TIMEOUT_MS = 20_000;
const LOCAL_DB_NAME = 'baibai_image_vibes';
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = 'vibes';
const LOCAL_PATH_PREFIX = 'idb:';

let localDbPromise: Promise<IDBDatabase> | null = null;

function openLocalDb(): Promise<IDBDatabase> {
  if (localDbPromise) return localDbPromise;
  localDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local vibe storage'));
    request.onblocked = () => reject(new Error('Local vibe storage is blocked by another page'));
  });
  return localDbPromise;
}

async function writeLocalData(key: string, data: NaiVibeData): Promise<string> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).put(data, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not write to local vibe storage'));
  });
  return `${LOCAL_PATH_PREFIX}${key}`;
}

async function readLocalData(path: string): Promise<NaiVibeData> {
  const db = await openLocalDb();
  const key = path.slice(LOCAL_PATH_PREFIX.length);
  return new Promise((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readonly').objectStore(LOCAL_STORE_NAME).get(key);
    request.onsuccess = () => {
      const data = request.result as NaiVibeData | undefined;
      if (data) resolve(data);
      else reject(new Error('Local vibe data does not exist'));
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read local vibe storage'));
  });
}

async function deleteLocalData(path: string): Promise<void> {
  const db = await openLocalDb();
  const key = path.slice(LOCAL_PATH_PREFIX.length);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE_NAME, 'readwrite').objectStore(LOCAL_STORE_NAME).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete local vibe data'));
  });
}

function safeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function storageFileName(path?: string, key = ''): string {
  const current = path?.split('/').pop();
  return current || `bbi-vibe-${safeFileKey(key) || randomUuid()}.json`;
}

function thumbnailFileName(dataUrl: string, path?: string, key = ''): string {
  const current = path?.split('/').pop();
  if (current) return current;
  const format = dataUrl.match(/^data:image\/([^;,]+)/i)?.[1]?.toLowerCase();
  const extension = format === 'jpeg' ? 'jpg' : format || 'jpg';
  return `bbi-vibe-thumb-${safeFileKey(key) || randomUuid()}.${extension}`;
}

function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export const DEFAULT_VIBE_STRENGTH = 0.6;

/**
 * The single rule for vibe strength: clamped to 0–1; anything not recognised as a number falls back to the default.
 *
 * There used to be four separate implementations (settings deserialisation / .naiv4vibe parsing / Chiehime import / panel input),
 * three of which wrote `Number(v)`, and `Number(null)` and `Number('')` are both 0;
 * so "field missing" was silently judged as "strength 0", and a vibe was attached with no effect on the image at all, very hard to trace.
 * This only accepts real numbers and strings that parse into numbers (the panel's <input> gives strings);
 * everything else (null / '' / whitespace strings / booleans / objects) falls back to the default.
 */
export function clampVibeStrength(raw: unknown, def = DEFAULT_VIBE_STRENGTH): number {
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : def;
}

export function vibeFingerprint(encodings: NaiVibeEncodings): string {
  return Object.keys(encodings)
    .sort()
    .map(key => `${key}:${encodings[key].encoding.slice(0, 64)}`)
    .join('|');
}

export function vibeMetaFromData(
  id: string,
  name: string,
  dataPath: string,
  thumbnailPath: string,
  data: NaiVibeData,
  strength: number,
  enabled: boolean,
  group = '',
): NaiVibe {
  return {
    id,
    name,
    dataPath,
    thumbnailPath,
    modelKeys: Object.keys(data.encodings),
    hasImage: !!data.image,
    fingerprint: vibeFingerprint(data.encodings),
    strength,
    enabled,
    group,
  };
}

export async function saveVibeData(data: NaiVibeData, currentPath = '', key = ''): Promise<string> {
  const json = JSON.stringify(data);
  return uploadBase64File(storageFileName(currentPath, key), utf8ToBase64(json));
}

export async function saveVibeFiles(
  data: NaiVibeData,
  current: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'> | null = null,
  key = '',
): Promise<{ dataPath: string; thumbnailPath: string }> {
  const localKey = current?.dataPath.startsWith(LOCAL_PATH_PREFIX)
    ? current.dataPath.slice(LOCAL_PATH_PREFIX.length)
    : safeFileKey(key) || randomUuid();
  if (current?.dataPath.startsWith(LOCAL_PATH_PREFIX)) {
    return { dataPath: await writeLocalData(localKey, data), thumbnailPath: current.thumbnailPath };
  }
  try {
    return await saveServerVibeFiles(data, current, localKey);
  } catch (error) {
    if (current) throw error;
    console.warn('[BaiBai Image] Vibe failed to write to ST file storage, and fell back to the browser IndexedDB:', error);
    return { dataPath: await writeLocalData(localKey, data), thumbnailPath: '' };
  }
}

async function saveServerVibeFiles(
  data: NaiVibeData,
  current: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'> | null,
  key: string,
): Promise<{ dataPath: string; thumbnailPath: string }> {
  const dataPath = await saveVibeData(data, current?.dataPath, key);
  if (current?.thumbnailPath) return { dataPath, thumbnailPath: current.thumbnailPath };
  if (!data.thumbnail) return { dataPath, thumbnailPath: current?.thumbnailPath ?? '' };
  try {
    const thumbnailPath = await uploadBase64File(
      thumbnailFileName(data.thumbnail, current?.thumbnailPath, key),
      dataUrlBase64(data.thumbnail),
    );
    return { dataPath, thumbnailPath };
  } catch (error) {
    if (!current?.dataPath) await deleteUploadedFile(dataPath).catch(() => {});
    throw error;
  }
}

export async function loadVibeData(vibe: Pick<NaiVibe, 'dataPath' | 'name'>): Promise<NaiVibeData> {
  if (!vibe.dataPath) throw new Error(`Vibe "${vibe.name}" is missing its data file`);
  if (vibe.dataPath.startsWith(LOCAL_PATH_PREFIX)) return readLocalData(vibe.dataPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(vibe.dataPath, { signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to read vibe "${vibe.name}" (${response.status})`);
    const data = (await response.json()) as Partial<NaiVibeData>;
    if (!data || typeof data !== 'object' || !data.encodings || typeof data.encodings !== 'object') {
      throw new Error(`Vibe "${vibe.name}" has an invalid data format`);
    }
    return {
      image: typeof data.image === 'string' ? data.image : '',
      thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : '',
      encodings: data.encodings as NaiVibeEncodings,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteVibeData(vibe: Pick<NaiVibe, 'dataPath' | 'thumbnailPath'>): Promise<void> {
  let firstError: unknown = null;
  for (const path of [vibe.dataPath, vibe.thumbnailPath]) {
    if (!path) continue;
    try {
      if (path.startsWith(LOCAL_PATH_PREFIX)) await deleteLocalData(path);
      else await deleteUploadedFile(path);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
