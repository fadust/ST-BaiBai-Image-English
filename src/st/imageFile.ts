/**
 * Reading and resizing image files (a small DOM-side helper, kept apart from the network layer in st/images.ts).
 *
 * Shared by NaiPanel's vibe thumbnails and artist-string preview images: redraws on a canvas as jpeg,
 * which both shrinks the size and normalises png/webp/gif to a static jpeg (gif animation is lost; previews don't care).
 */

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image loading failed'));
    img.src = src;
  });
}

/** Scales a dataURL image so its longest edge is within maxEdge and re-encodes it as a jpeg dataURL. */
export async function makeJpegThumbnail(
  dataUrl: string,
  maxEdge: number,
  quality = 0.8,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
