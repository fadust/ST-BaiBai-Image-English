import type { ComfyImageResult } from '@/backends/comfyui';
import { utf8ToBase64 } from '@/base64';
import { normalizeImagePath } from '@/floor/missingImages';
import { deleteUploadedFile, uploadBase64File } from '@/floor/upload';
import type { GenerationMeta } from '@/generationMeta';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { deleteUserImage, uploadUserImage } from '@/st/images';
import { settings } from '@/state/settings';

/**
 * Storage layer for floor card results (DESIGN-FLOOR-UI.md §7).
 *
 * Two separate layers:
 * - new image binaries → the ST file system (user/images/柏宝绘_<character name>/); extra only stores the pointer path.
 *   Old user/files images stay where they are: not migrated, not deleted.
 * - metadata → message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }
 *   bucketed by swipeId (swipes don't contaminate each other); under each promptHash key is a history list (chronological,
 *   newest last, browsed by paging in the card); on hydration the hash is recomputed from the current tag text for stale detection.
 *
 * Folder names are sanitised by ST's upload endpoint; files inside keep their original naming:
 *   bbi_<characterNameHash>_<swipeId>_<promptHash>-<generationId>.<ext>
 *
 * There is also a third layer, the sidecar (see sidecarFileName): a .json with the same name as the image, stored in user/files.
 * It only serves the gallery: the gallery lists images by folder across all chats, while prompts only live in one chat's extra,
 * and scanning all JSONL files to look them up is infeasible (measured: a single character folder reached GB scale, and /api/chats/get has no pagination).
 */

export interface BbiImageEntry {
  /** Unique id for this generation. */
  generationId: string;
  /** ST static path /user/images/... or legacy /user/files/... (referenced directly by <img src>). */
  path: string;
  /** Full raw tag text used for generation (including the <bbi_image> wrapper), identical to the promptHash input. */
  prompt: string;
  /** Seed for this generation; fixed at null until the step-4 seed strategy lands. */
  seed: number | null;
  status: 'ready' | 'error';
  createdAt: number;
  /** Slot index at generation time (the Nth tag on the floor). Multi-tag floors isolate results by position;
   *  falls back to 0 via entrySeq() for old data that lacks it. */
  slotSeq?: number;
  /** Generation metadata (artist string/vibes/sampling parameters). The gallery's fast path for the current chat reads it instead of fetching each sidecar;
   *  old data lacks this key. */
  meta?: GenerationMeta;
}

/** [swipeId][promptHash] = list of history entries. */
export type BbiImageStore = Record<string, Record<string, BbiImageEntry[]>>;

export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';

/* —— Hashing and naming —— */

/** Derived from cyrb53: synchronous, deterministic, well distributed for chat-level prompts; outputs 14 hex digits. */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function generationId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Flat file name: the character card name is hashed so CJK names aren't replaced by runs of underscores. */
export function imageFileName(
  characterName: string,
  swipeId: number,
  hash: string,
  genId: string,
  ext: string,
): string {
  const characterHash = promptHash(characterName.trim() || 'unknown');
  return `bbi_${characterHash}_${swipeId}_${hash}-${genId}.${ext}`;
}

/* —— Sidecar metadata —— */

/** Content of the sidecar json. v is the version number, used later to tell old files apart if backend/model are added. */
export interface BbiImageSidecar {
  v: 1 | 2;
  /** Readable character name (the one in the image file name is a hash and can't be recovered). */
  character: string;
  /** Full raw tag text used for generation (including the <bbi_image> wrapper), from the same source as entry.prompt. */
  prompt: string;
  seed: number | null;
  createdAt: number;
  /** Since v2: information not in the tag text, such as artist string/vibes/sampling parameters. Old files lack this key. */
  meta?: GenerationMeta;
}

/**
 * Derives the sidecar file name from the image file name (just swapping the extension). **The single rule for both reading and writing**.
 *
 * Why it can be computed without maintaining an index: /api/files/upload saves with `path.join(dir, body.name)` as-is
 * (files.js, validating without sanitising), so whatever name is given on upload can be computed back later with the same pure function.
 * And the image name bbi_<hash>_<swipe>_<promptHash>-<genId> falls entirely within
 * validateAssetFileName's allowlist /^[a-zA-Z0-9_\-.]+$/, compliant by construction.
 *
 * Sidecars can only go in user/files: /api/images/upload requires format to be a media extension, json isn't one,
 * so they can't go into the image's own folder.
 */
export function sidecarFileName(imageFile: string): string {
  const base = imageFile.replace(/\.[^./]*$/, '');
  return `${base}.json`;
}

/** Derives the sidecar's accessible path from the image path (/user/images/…); returns an empty string for images not from this plugin. */
export function sidecarPathFor(imagePath: string): string {
  const file = imagePath.split('/').pop() ?? '';
  // Only our own naming counts: a name computed from a foreign file is certain to 404, wasting a round of requests
  if (!/^bbi_[a-zA-Z0-9_]+-[a-zA-Z0-9]+\.[a-z0-9]+$/i.test(file)) return '';
  return `/user/files/${sidecarFileName(file)}`;
}

/* —— extra read/write (pure functions) —— */

export function readStore(message: STMessage): BbiImageStore | null {
  const extra = message.extra;
  if (!extra || typeof extra[BBI_IMAGE_EXTRA_KEY] !== 'object' || extra[BBI_IMAGE_EXTRA_KEY] === null) {
    return null;
  }
  return extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
}

/** The latest result matching the hash (card ready). */
/** Old data (without the slotSeq field) falls back to slot 0. */
function entrySeq(entry: BbiImageEntry): number {
  return entry.slotSeq ?? 0;
}

/** All history for the same slot (chronological, newest last). Used for card paging. */
export function historyEntries(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry[] {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list) return [];
  return list.filter(entry => entrySeq(entry) === seq);
}

/** The latest result matching the hash in the same slot (card ready). */
export function latestEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (entrySeq(list[i]) === seq) return list[i];
  }
  return null;
}

/** When the current hash has no result for this slot, the latest result of another prompt (stale) in the same slot (card stale).
 *  Only the same slot: results of neighbouring tags are never mistaken for this tag's history. */
export function latestStaleEntry(
  store: BbiImageStore | null,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const bucket = store?.[String(swipeId)];
  if (!bucket) return null;
  let latest: BbiImageEntry | null = null;
  for (const [key, list] of Object.entries(bucket)) {
    if (key === hash || list.length === 0) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (entrySeq(list[i]) !== seq) continue;
      const candidate = list[i];
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
      break; // The newest one in this bucket is enough
    }
  }
  return latest;
}

/** Appends one history entry immutably (returns a new store; the original is untouched). */
export function appendEntry(
  store: BbiImageStore,
  swipeId: number,
  hash: string,
  entry: BbiImageEntry,
): BbiImageStore {
  const swipeKey = String(swipeId);
  const next: BbiImageStore = { ...store };
  next[swipeKey] = { ...(store[swipeKey] ?? {}) };
  next[swipeKey][hash] = [...(store[swipeKey]?.[hash] ?? []), entry];
  return next;
}

/* —— CAS write-back —— */

/**
 * Read-modify-write loop: mutate returns a new store from the current one; before writing back it checks the reference wasn't
 * replaced by a concurrent write, and on conflict retries from the latest store (DESIGN-FLOOR-UI.md §7.2).
 */
export async function mutateStore(
  ctx: STContext,
  messageId: number,
  mutate: (store: BbiImageStore) => BbiImageStore,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const message = ctx.chat[messageId];
    if (!message) return false;
    if (!message.extra) message.extra = {};
    let store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore | undefined;
    if (!store) {
      // First creation: write back an empty object synchronously to establish the reference (no await, no race window)
      message.extra[BBI_IMAGE_EXTRA_KEY] = {};
      store = message.extra[BBI_IMAGE_EXTRA_KEY] as BbiImageStore;
    }
    const next = mutate(store);
    if (message.extra[BBI_IMAGE_EXTRA_KEY] !== store) continue; // Concurrent write; retry
    message.extra[BBI_IMAGE_EXTRA_KEY] = next;
    await ctx.saveChat();
    return true;
  }
  console.warn('[BaiBai Image] extra Exhausted write retries, give up this write');
  return false;
}

/* —— Save flow —— */

async function resultToBase64(result: ComfyImageResult): Promise<string> {
  if (result.url.startsWith('data:')) {
    // Server proxy mode: strip the data URL prefix and use it directly
    const comma = result.url.indexOf(',');
    return result.url.slice(comma + 1);
  }
  // Direct browser mode: blob URL → blob → base64 (chunked concatenation prevents stack overflow)
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`Failed to read image (${response.status})`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* —— Optional JPG conversion (settings.storage.saveAsJpeg) —— */

/** Conversion quality: the visually lossless setting. No slider: the rare user who is unhappy can simply turn the toggle off, saving a setting. */
const JPEG_QUALITY = 0.9;

function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new FileReader();
  return new Promise((resolve, reject) => {
    buffer.onload = () => {
      const dataUrl = String(buffer.result ?? '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('The image format is invalid after conversion'));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    buffer.onerror = () => reject(new Error('Could not read the image after conversion'));
    buffer.readAsDataURL(blob);
  });
}

/**
 * Re-encodes the original image as JPG (fixed quality 0.9, redrawn from scratch to remove alpha).
 * PNG → canvas → JPEG: drops the embedded generation parameters (NAI tEXt / ComfyUI workflow chunk) in exchange for
 * a file about 10–20% of the original size; a deliberate trade-off, with the toggle off by default.
 * Note: canvas decoding already strips all metadata, so no extra "scrubbing" step is needed.
 */
async function reencodeAsJpeg(source: Blob): Promise<Blob> {
  // createImageBitmap is faster than <img> and stays out of the DOM; but some environments (e.g. old iOS Safari)
  // handle EXIF orientation differently, so imageOrientation: 'none' is set explicitly to keep pixels as they are
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D context not available');
    // JPG has no alpha channel: paint a white background before drawing, otherwise transparent areas become black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('JPG encoding failed'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Prepares the image to save per settings: re-encoded as JPG when the toggle is on, returned as-is when off.
 * Any failure in the conversion chain falls back to the original format: better to use more disk than to break or lose the image.
 */
export async function prepareImageForStorage(result: ComfyImageResult): Promise<{
  base64: string;
  format: string;
}> {
  if (settings.storage.saveAsJpeg) {
    try {
      // Both data URLs and blob URLs can be fetched into a Blob
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`Failed to read image (${response.status})`);
      const original = await response.blob();
      // Already JPG (webp and the like can't be compressed further): skip re-encoding to avoid a second lossy pass
      if (result.format !== 'jpg' && result.format !== 'jpeg') {
        const jpeg = await reencodeAsJpeg(original);
        return { base64: await blobToBase64(jpeg), format: 'jpg' };
      }
      return { base64: await blobToBase64(original), format: result.format };
    } catch (error) {
      console.warn('[BaiBai Image] JPG transcoding failed, this time it will fall back and save the original format.', error);
    }
  }
  return { base64: await resultToBase64(result), format: result.format };
}

/**
 * Saves the image binary + sidecar json. **The single physical path for storing images**, shared by floors and the public API.
 *
 * Doesn't touch chat history: the floor side writes its own extra pointer afterwards, and the public API side has no pointer to write at all
 * (third parties decide where images show; images enter no floor text).
 *
 * File names and folders must go through here, never a separate scheme:
 * - the folder `柏宝绘_<character name>` is the gallery's **only** grouping basis (index.vue only lists folders starting with FOLDER_PREFIX);
 *   with a different prefix, the image is saved but invisible in the gallery;
 * - the file name `bbi_…-<genId>.<ext>` must be recognisable by sidecarPathFor's regex, otherwise it returns an empty string
 *   and the gallery never requests the sidecar; the symptom is the image is there, the prompt is blank, **and there is no error at all**.
 */
async function uploadImageWithSidecar(
  characterName: string,
  swipeId: number,
  hash: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
): Promise<{ path: string; genId: string; createdAt: number; imageFile: string }> {
  const genId = generationId();
  // Decide the save format per settings first (re-encoded as JPG when the toggle is on); the file extension follows the actual format
  const { base64, format } = await prepareImageForStorage(result);
  const imageFile = imageFileName(characterName, swipeId, hash, genId, format);
  const path = await uploadUserImage(`柏宝绘_${characterName}`, imageFile, base64, format);
  const createdAt = Date.now();

  // Sidecar: when the gallery browses across chats, prompts can only come from here.
  // **Failure only warns, never throws**: the image is already saved, and one auxiliary json must never fail the whole save;
  // users would rather miss a prompt than lose the image.
  const sidecar: BbiImageSidecar = {
    v: 2,
    character: characterName,
    prompt: tag,
    seed,
    createdAt,
    ...(meta ? { meta } : {}),
  };
  try {
    await uploadBase64File(sidecarFileName(imageFile), utf8ToBase64(JSON.stringify(sidecar)));
  } catch (error) {
    console.warn('[BaiBai Image] Failed to write profile metadata (does not affect pictures)', error);
  }

  return { path, genId, createdAt, imageFile };
}

/**
 * Saves an image that **belongs to no floor** (the save path of the public API STBaiBaiImage.generate).
 *
 * Division with saveImageResult: that one, after saving, also writes the extra pointer and triggers re-hydration so the floor card shows it;
 * this one is done once the file is in the gallery: the third-party plugin decides where the image shows (exactly the point of the public API),
 * and BaiBai Image puts nothing into chat history on its behalf.
 *
 * swipeId is fixed at 0: that cell in the file name is "which swipe of the same floor", and external images have no floor coordinates;
 * 0 only keeps the file name in the same format (the gallery and sidecarPathFor both recognise images by format).
 * Uniqueness is guaranteed by genId, not this cell.
 */
export async function saveExternalImage(
  characterName: string,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
): Promise<string> {
  const name = characterName.trim() || '未命名角色';
  const { path } = await uploadImageWithSidecar(name, 0, promptHash(tag), tag, seed, result, meta);
  return path;
}

/**
 * Full save flow (DESIGN-FLOOR-UI.md §7.6):
 * save the image binary → write the pointer in extra (file first, then pointer, avoiding orphan pointers);
 * if writing the pointer fails, the file is left as an orphan for later cleanup.
 */
export async function saveImageResult(
  messageId: number,
  swipeId: number,
  seq: number,
  tag: string,
  seed: number,
  result: ComfyImageResult,
  meta?: GenerationMeta,
): Promise<BbiImageEntry> {
  const ctx = getContext();
  if (!ctx?.saveChat) throw new Error('SillyTavern context is not available');
  const chatId = ctx.getCurrentChatId();
  if (!chatId) throw new Error('The current chat is unavailable');

  const hash = promptHash(tag);
  const characterName = ctx.chat[messageId]?.name?.trim() || ctx.name2?.trim() || '未命名角色';
  const { path, genId, createdAt } = await uploadImageWithSidecar(
    characterName,
    swipeId,
    hash,
    tag,
    seed,
    result,
    meta,
  );

  const entry: BbiImageEntry = {
    generationId: genId,
    path,
    prompt: tag,
    // The seed actually used for this generation (passed in by the caller after generating; -1 isn't supported)
    seed,
    status: 'ready',
    createdAt,
    slotSeq: seq,
    ...(meta ? { meta } : {}),
  };

  const saved = await mutateStore(ctx, messageId, store => appendEntry(store, swipeId, hash, entry));
  if (!saved) {
    console.warn('[BaiBai Image] The picture has been uploaded but extra failed to write, and the file is left as an orphan.', path);
    throw new Error('The image was uploaded, but the chat history could not be saved.');
  }
  return entry;
}

/**
 * Deletes an image's **file itself** (together with its sidecar json), without touching any chat history. Used by gallery bulk deletion.
 *
 * Division with deleteImageResult: that is "delete a result from a floor", removing the extra pointer before deleting the file;
 * this is "delete a file from the gallery", with **no pointer to remove**: the gallery lists by folder while pointers are scattered across chats'
 * extra, with no reverse index between them, and scanning everything is infeasible (measured: chats folder 7 GB / 1243 jsonl files,
 * and /api/chats/get has no pagination). So broken pointers are inevitably left behind, handled by runtime degradation on the floor card side
 * (floor/missingImages.ts + Card.vue's @error).
 *
 * A failed sidecar deletion only warns: old images never had sidecars, so 404 is the expected norm (deleteUploadedFile returns
 * false on 404 without throwing); a real failure just leaves an orphan json of a few KB, not worth failing the whole deletion.
 *
 * Entry goes through `normalizeImagePath` first: callers hold both forms; the gallery's src is encodeURIComponent'd
 * segment by segment, while extra/folder listings hold the raw text. ST's /api/images/delete and
 * /api/files/delete both path.join body.path onto the root directly **without URL decoding**,
 * so an encoded path would only 404 and be silently swallowed by deleteUserImage as "didn't exist";
 * the symptom is the image isn't deleted while the sidecar really is.
 */
export async function deleteImageFileOnly(path: string): Promise<void> {
  const target = normalizeImagePath(path);
  await deleteUserImage(target);
  const sidecar = sidecarPathFor(target);
  if (!sidecar) return;
  try {
    await deleteUploadedFile(sidecar);
  } catch (error) {
    console.warn('[BaiBai Image] Failed to delete profile metadata (left as an orphan)', error);
  }
}

/**
 * Deletes one result: first removes the pointer from extra and saves, then deletes the file once that succeeds (the reverse order would leave
 * broken pointers to deleted files; if the file deletion fails it is left as an orphan for cleanup).
 * Only deletes files under user/images (together with their sidecar json);
 * old user/files images only have their record removed, keeping the original file.
 */
export async function deleteImageResult(
  messageId: number,
  swipeId: number,
  hash: string,
  genId: string,
): Promise<boolean> {
  const ctx = getContext();
  if (!ctx?.saveChat) return false;
  let pathToDelete = '';
  const removed = await mutateStore(ctx, messageId, store => {
    const bucket = store[String(swipeId)];
    const list = bucket?.[hash];
    if (!list) return store;
    const index = list.findIndex(entry => entry.generationId === genId);
    if (index < 0) return store;
    pathToDelete = list[index].path;
    const nextList = list.filter((_, i) => i !== index);
    const next: BbiImageStore = { ...store };
    next[String(swipeId)] = { ...bucket };
    if (nextList.length) {
      next[String(swipeId)][hash] = nextList;
    } else {
      delete next[String(swipeId)][hash];
    }
    return next;
  });
  if (!removed) return false;
  if (/^\/?user\/images\//.test(pathToDelete)) {
    try {
      await deleteUserImage(pathToDelete);
    } catch (error) {
      console.warn('[BaiBai Image] Failed to delete picture files (left as orphans)', error);
    }
    // The sidecar goes along. deleteUploadedFile returns false on 404 without throwing (old images never had sidecars; that's normal)
    const sidecar = sidecarPathFor(pathToDelete);
    if (sidecar) {
      try {
        await deleteUploadedFile(sidecar);
      } catch (error) {
        console.warn('[BaiBai Image] Failed to delete profile metadata (left as an orphan)', error);
      }
    }
  }
  return true;
}
