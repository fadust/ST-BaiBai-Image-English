/**
 * Saves a stored generation result to the local device.
 *
 * Images are **same-origin real files** (/user/files/bbi_*.png), so `<a download>` works directly
 * without fetching into a blob first. That saves a full-size transfer and avoids managing blob URL lifetimes.
 *
 * Two pitfalls:
 * - the `<a>` must be attached to the document before clicking: some browsers ignore synthetic clicks on detached nodes;
 * - mobile Safari ignores the download attribute and falls back to "open in new tab". Users can still long-press to save,
 *   an acceptable degradation (cards and the lightbox have their own long-press save path; see the top comment in Lightbox.vue).
 */
export function saveImageFile(src: string, filename?: string): void {
  if (!src) return;
  const link = document.createElement('a');
  link.href = src;
  link.download = filename || src.split('/').pop() || 'bbi-image.png';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function imageDownloadFileName(
  src: string,
  characterName: string,
  generationId: string,
): string {
  const name = characterName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'image';
  const extension = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1] || 'png';
  return `bbi_${name}_${generationId}.${extension}`;
}
