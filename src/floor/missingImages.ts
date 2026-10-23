import { reactive } from 'vue';

import { probeUserImage } from '@/st/images';

/**
 * Register of image paths whose "file is gone" (module-level, valid for the session).
 *
 * Why it's needed: the gallery can now delete files under user/images directly, but the image's pointer still sits in some chat's
 * `message.extra.bbiImage`. The gallery lists images by **folder** while pointers live in **some chat**, with no reverse
 * index between them, and scanning everything to look them up is infeasible (measured: one user's chats folder was 7 GB / 1243 jsonl files, and /api/chats/get
 * has no pagination). So deleting a file always leaves a broken pointer, and the card side can only degrade by "discovering the 404 at runtime".
 *
 * Why it must live outside the component: same as collapseState.ts / genState.ts. Card lifetimes are decided by hydration;
 * any sibling slot's image rebuilds the whole floor's cards, and a mark kept in a component ref would let the broken image come back to life after a rebuild.
 *
 * Why not write back to extra: that needs a saveChat(), while "the file is gone" is an objective disk state, not chat data;
 * and users may well restore the file. Remembering for the session is enough; after a reload <img>'s @error rediscovers it.
 */

/** Set of normalised paths. reactive so cards' computed values recompute with it. */
const missing = reactive(new Set<string>());

/**
 * Normalises image paths so "path in extra" and "src built by the gallery" can compare equal.
 * **Both read and write sides of this register, and the gallery's prompt cache key, share this one rule**: if the two forms don't reconcile,
 * cards still show broken images after the gallery deletes them.
 *
 * The two sides differ by nature: entry.path in extra is the **unencoded** path returned as-is by the server's clientRelativePath
 * (often CJK), while the gallery's src is encodeURIComponent'd segment by segment; a leading slash may or may not be present
 * (that is why the delete branch in storage.ts has `/^\/?user\/images\//`). Compare after decoding and stripping the leading slash.
 */
export function normalizeImagePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* Half-done percent encoding: if it can't be decoded, compare the raw text; better than throwing */
  }
  return decoded.replace(/^\/+/, '');
}

/** Records that this image's file is gone (the caller must first confirm a real 404; don't record network glitches as deletions). */
export function markImageMissing(path: string): void {
  if (path) missing.add(normalizeImagePath(path));
}

/** Batch version (the gallery deletes several at once). */
export function markImagesMissing(paths: Iterable<string>): void {
  for (const path of paths) markImageMissing(path);
}

export function isImageMissing(path: string): boolean {
  return !!path && missing.has(normalizeImagePath(path));
}

/** Paths being confirmed: multiple errors for the same image are probed only once (re-hydration remounts <img>, so error fires again). */
const probing = new Set<string>();

/**
 * Called after `<img>` reports an error: **confirm a real 404 before marking**.
 *
 * Can't mark it missing on every error: `<img>`'s error can't tell "file gone" from "network down/server 500",
 * and recording a disconnect as a deletion would show users a screen full of "file deleted" on every network blip, unfixable until reload.
 * So a HEAD request is made here: only an explicit 404 from the server gets recorded; if unclear (probe returns null) nothing happens,
 * leaving the browser's broken-image placeholder, which naturally retries on the next remount.
 *
 * Only images under user/images count: this plugin never deletes old images in user/files, so there is no "deleted by the gallery" path for them.
 */
export async function confirmImageMissing(path: string): Promise<boolean> {
  if (!path || !/^\/?user\/images\//.test(normalizeImagePath(path))) return false;
  const key = normalizeImagePath(path);
  if (missing.has(key)) return true;
  if (probing.has(key)) return false;
  probing.add(key);
  try {
    const probe = await probeUserImage(path);
    // null = unclear; never recorded
    if (probe && !probe.exists) {
      missing.add(key);
      return true;
    }
    return false;
  } finally {
    probing.delete(key);
  }
}

/** Tests only: clears this register. */
export function resetMissingImages(): void {
  missing.clear();
  probing.clear();
}
