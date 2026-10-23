/**
 * Shared helpers for frame orientation (landscape/portrait) and size parsing.
 *
 * Division of labour: the model only decides "landscape or portrait"; the user configures a pixel pair (portrait size/landscape size) in each backend panel.
 * Different checkpoints suit different resolutions, and hard-coding one ratio would hurt half the scenes.
 *
 * This module deliberately does not import settings: both the image backends and the protocol layer use it,
 * and depending on the concrete Settings type would create a circular import. Size-by-orientation inputs are expressed as structural constraints.
 */

export type Orientation = 'portrait' | 'landscape';

export interface ImageSize {
  width: number;
  height: number;
}

/** Landscape abbreviations matched exactly only (too short for substring matching, which would hit words other than landscape). */
const LANDSCAPE_CODES = new Set(['l', 'h', 'w']);

/** Keywords that mean landscape when present (substring match, covering phrases like "横屏构图" and "landscape shot"). */
const LANDSCAPE_WORDS = ['landscape', 'horizontal', 'widescreen', 'wide', '横', '宽屏'];

/**
 * Lenient normalisation: anything unrecognised becomes 'portrait'.
 *
 * Portrait was the plugin's original fixed default (832×1216); degrading to it = keeping the status quo,
 * so a missing or invalid value from the model should not throw; a throw in parseImagePlan would waste the runner's retries.
 * Ratio forms such as "16:9 / 1216x832" are also recognised: width > height means landscape.
 */
export function normalizeOrientation(value: unknown): Orientation {
  if (typeof value !== 'string') return 'portrait';
  const text = value.trim().toLowerCase();
  if (!text) return 'portrait';
  if (LANDSCAPE_CODES.has(text)) return 'landscape';

  // Ratio/size forms: 16:9, 1216x832, 1216×832 → compare width and height
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*[:：×xX*]\s*(\d+(?:\.\d+)?)/);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      return a > b ? 'landscape' : 'portrait';
    }
  }

  return LANDSCAPE_WORDS.some(word => text.includes(word)) ? 'landscape' : 'portrait';
}

/**
 * Lenient size parsing: "1216×832 / 1216x832 / 1216*832" → {width, height}.
 * Only generic lower-bound checks (integer, 64–4096); backend-specific limits (e.g. NAI's multiples of 64,
 * maximum 2048) are added by the caller on top, which also supplies the error message to fit the backend's context.
 * Returns null if it can't parse, leaving the caller to decide between an error and a fallback.
 */
export function parseSize(text: string): ImageSize | null {
  const match = (text ?? '').match(/(\d{2,4})\s*[×xX*]\s*(\d{2,4})/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 64 || height < 64 || width > 4096 || height > 4096) return null;
  return { width, height };
}

/** A pair of frame-size settings (each image backend holds one). */
export interface SizePair {
  /** Portrait size, e.g. 832×1216. */
  portraitSize: string;
  /** Landscape size, e.g. 1216×832. */
  landscapeSize: string;
}

/** Returns the user-configured size string for an orientation (empty string if unset; the caller decides the fallback). */
export function pickSize(pair: SizePair, orientation: Orientation): string {
  const text = orientation === 'landscape' ? pair.landscapeSize : pair.portraitSize;
  return (text ?? '').trim();
}

/**
 * Orientation lock: 'auto' = auto-tag decides landscape/portrait per image (default, i.e. the behaviour before this change);
 * 'portrait' / 'landscape' = the channel always renders that orientation.
 *
 * Owned like the size pair (one per NAI channel, one per ComfyUI workflow) and shown next to the sizes in the panel:
 * it really means "use only one cell of this size pair". The old workaround was filling both cells with the same size;
 * output was unified, but the AI still framed by the landscape/portrait criteria (planning wide group shots even when locked to portrait).
 */
export type OrientationLock = 'auto' | Orientation;

/** Lenient normalisation: only the two orientation values are recognised; anything else (including old data missing the field) becomes 'auto' = behaviour before this change. */
export function normalizeOrientationLock(value: unknown): OrientationLock {
  return value === 'portrait' || value === 'landscape' ? value : 'auto';
}

/**
 * Actual output orientation: the locked orientation if locked, otherwise the one recorded in the tag (AI decision or user edit).
 *
 * Overrides only at generation time; **the tag text is not rewritten**: promptHash hashes the raw tag text, and a bulk rewrite would turn old images
 * into "old prompt" for no reason; after unlocking, each image still renders in its own recorded orientation.
 */
export function effectiveOrientation(lock: OrientationLock, size: Orientation): Orientation {
  return lock === 'auto' ? size : lock;
}
