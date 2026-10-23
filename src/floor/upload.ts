import { getContext } from '@/st/context';

/**
 * Upload/delete wrappers for ST file storage (user/files).
 *
 * Does not rely on ST's internal uploadFileAttachment (chats.js:274 is not exposed to third-party extensions,
 * and on failure it swallows the error, returns undefined and shows a toastr). This is an exactly equivalent
 * POST /api/files/upload implementation that exposes the status code and response body; callers present errors.
 */

export class FileStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FileStoreError';
  }
}

async function postFile(endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new FileStoreError('SillyTavern context is not available');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/** Uploads a base64 file and returns an accessible relative path (/user/files/...). Throws on failure. */
export async function uploadBase64File(name: string, base64: string): Promise<string> {
  const { ok, status, text } = await postFile('/api/files/upload', { name, data: base64 });
  if (!ok) {
    throw new FileStoreError(`File upload failed (${status})${text ? `: ${text.slice(0, 300)}` : ''}`, status);
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* Response is not JSON; falls through to the shared error below */
  }
  if (!path) throw new FileStoreError('File upload failed: The server did not return the path');
  return path;
}

/** Uploads an image. */
export function uploadImageFile(name: string, base64: string): Promise<string> {
  return uploadBase64File(name, base64);
}

/** Deletes an uploaded file. Returns false if the file did not exist (nothing to clean up). */
export async function deleteUploadedFile(path: string): Promise<boolean> {
  const { ok, status, text } = await postFile('/api/files/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new FileStoreError(`File deletion failed (${status})${text ? `: ${text.slice(0, 300)}` : ''}`, status);
}

/** Deletes an uploaded image. */
export function deleteImageFile(path: string): Promise<boolean> {
  return deleteUploadedFile(path);
}
