import { getContext } from '@/st/context';

/**
 * Upload/delete/list wrappers for ST image storage (user/images), matching the server's /api/images/*.
 *
 * Division with /api/files/* in floor/upload.ts: files is a flat folder without subfolders;
 * images supports ch_name subfolders (created recursively by the server's ensureDirectoryExistence),
 * so resources grouped by "folder" (artist-string previews, generated chat images) go here.
 *
 * Returned paths look like /user/images/<folder>/<file name> and can be used directly as <img src>.
 */

export class ImageStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImageStoreError';
  }
}

/**
 * Fixed subfolder for artist-string preview images (under user/images).
 * Constant name: CJK + underscore survive the server's sanitize-filename unchanged.
 * Dynamic character folder names are also sanitised by the upload endpoint, so no extra sanitize-filename request is needed.
 */
export const ARTIST_PREVIEW_FOLDER = '柏宝绘_画师串';

async function postImage(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new ImageStoreError('SillyTavern context is not available');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/**
 * Uploads a base64 image to user/images/<folder>/ and returns an accessible relative path (/user/images/...).
 *
 * filename may carry an extension; the server replaces it with format. Same names are silently overwritten,
 * so callers using a stable file name (such as the artist-string id) get "change preview image" overwriting in place without piling up orphan files.
 */
export async function uploadUserImage(
  folder: string,
  filename: string,
  base64: string,
  format: string,
): Promise<string> {
  const { ok, status, text } = await postImage('/api/images/upload', {
    image: base64,
    format,
    ch_name: folder,
    filename,
  });
  if (!ok) {
    throw new ImageStoreError(
      `Image upload failed (${status})${text ? `: ${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* Response is not JSON; falls through to the shared error below */
  }
  if (!path) throw new ImageStoreError('Image upload failed: the server returned no path.');
  return path;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Lists first-level subfolder names under user/images (the gallery's only source of names for grouping by character).
 *
 * The character name in saved file names is a hash (see imageFileName in floor/storage.ts); the readable name can only be recovered from the folder name,
 * so the gallery must fetch folders first and then list images per folder, never the other way round from file names.
 */
export async function listUserImageFolders(): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/folders', {});
  if (!ok) {
    throw new ImageStoreError(
      `Failed to read image directory (${status})${text ? `: ${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/**
 * Lists image file names in a folder (names only, no path), in the server's sort order.
 *
 * ⚠ The server creates nonexistent folders recursively with mkdir (images.js /list), so only list folders
 * returned by listUserImageFolders(); guessing folder names would pile up empty folders under user/images.
 */
export async function listUserImages(
  folder: string,
  options: { sortField?: 'date' | 'name'; sortOrder?: 'asc' | 'desc' } = {},
): Promise<string[]> {
  const { ok, status, text } = await postImage('/api/images/list', {
    folder,
    sortField: options.sortField ?? 'date',
    sortOrder: options.sortOrder ?? 'desc',
  });
  if (!ok) {
    throw new ImageStoreError(
      `Failed to read image list (${status})${text ? `: ${text.slice(0, 300)}` : ''}`,
      status,
    );
  }
  return parseJsonArray(text).filter((name): name is string => typeof name === 'string');
}

/**
 * Probes an image's existence and size: HEAD on the static route reads Content-Length without downloading the image.
 *
 * Why it must be HEAD: `/api/images/list` **returns only file names**, with neither size nor mtime
 * (the server's util.js getImages only maps dirent.name), while the gallery must show sizes and cards must decide
 * "is this image really gone"; both can only ask image by image. Measured: HEAD goes through users.js createRouteHandler →
 * res.sendFile, responds in 1~2ms with no body, far cheaper than reworking the list endpoint.
 *
 * Uses a bare fetch without headers: static routes need no auth headers (same as loadVibeData in backends/vibeStore.ts).
 *
 * The return value is deliberately three-way:
 * - `{ exists: true, size }`   file exists; size in bytes (null if Content-Length is missing);
 * - `{ exists: false }`        the server explicitly says it doesn't exist (404);
 * - `null`                     **can't tell** (network error/timeout/5xx).
 *
 * The third state is key: cards rely on it to decide whether to mark the image "deleted". Treating one disconnect as a deletion
 * would show users a screen full of "file deleted" on every network blip.
 */
export async function probeUserImage(
  path: string,
  timeoutMs = 8000,
): Promise<{ exists: true; size: number | null } | { exists: false } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method: 'HEAD', signal: controller.signal });
    if (response.status === 404) return { exists: false };
    if (!response.ok) return null;
    // Check for null before converting to a number: when the header is missing get() returns null, and `Number(null)` is **0**, not NaN;
    // converting directly would misreport "size unknown" as "0 bytes", undercounting a group's size by one image.
    const raw = response.headers.get('content-length');
    const length = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return { exists: true, size: Number.isFinite(length) && length >= 0 ? length : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Deletes an image under user/images. Returns false if the file did not exist (nothing to clean up). */
export async function deleteUserImage(path: string): Promise<boolean> {
  const { ok, status, text } = await postImage('/api/images/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new ImageStoreError(
    `Image deletion failed (${status})${text ? `: ${text.slice(0, 300)}` : ''}`,
    status,
  );
}
