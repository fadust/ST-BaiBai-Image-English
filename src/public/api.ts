import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { normalizeOrientation } from '@/backends/size';
import { NaiError } from '@/backends/nai';
import { ComfyUIError } from '@/backends/comfyui';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import type { GenerationMeta } from '@/generationMeta';
import { saveExternalImage } from '@/floor/storage';
import { getContext } from '@/st/context';
import { serializeImageTag } from '@/st/imageTagRegex';
import {
  buildEntryTag,
  charTagLib,
  charTagsBeforeFloor,
  lockedCharTagNames,
  type CharTagEntry,
} from '@/state/charTags';
import { PLUGIN_VERSION } from '@/version';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type GetCharactersOptions,
  type PublicBackendStatus,
  type PublicCharacter,
  type PublicCharacterList,
  type PublicError,
  type PublicErrorCode,
  type PublicGenerateProgress,
} from './types';

/**
 * Implementation layer of the public API. **All the dirty work at the cross-plugin boundary is kept here.**
 *
 * Three rules, each matching a class of problems that really bite:
 *
 * 1. **Deep-copy all outgoing data**. charTagLib.entries is a Vue reactive array;
 *    handing it out as-is also hands over write access to the character library. A third party changing it casually is at best
 *    silently overwritten by the next recomputeCharTags() (users see "my changes vanished again"), at worst pulls the reactive
 *    proxy into its own reactivity system, with both sides triggering each other's updates.
 *
 * 2. **Normalise every error into a plain Error with a code**. instanceof for NaiError / ComfyUIError / DOMException
 *    always fails across bundles (two copies of each constructor), leaving third parties to match message text,
 *    which is human-readable and changes between versions. So a code is attached here, and the docs say plainly "branch on code".
 *
 * 3. **Convert every image to a data URL before handing it out**. The ComfyUI direct mode returns a blob: URL, which needs a matching
 *    revokeObjectURL: if the third party forgets, it leaks; if we revoke on its behalf, its <img> goes blank.
 *    A data URL has no owner and no lifetime; the cost is a larger string, and that cost is worth it.
 */

export function clonePublic<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* —— Revision: +1 on every character-library change; third parties use it for cache invalidation —— */

let revision = 0;

export function getPublicRevision(): number {
  return revision;
}

export function bumpPublicRevision(): number {
  revision += 1;
  return revision;
}

/* —— Error normalisation —— */

/**
 * Builds an Error with a code. **No Error subclass**: subclass instanceof doesn't work across bundles,
 * and third parties can't get at the type information anyway, so it would only fool ourselves.
 */
export function publicError(code: PublicErrorCode, message: string): PublicError {
  const error = new Error(message) as PublicError;
  error.code = code;
  return error;
}

/** Is it already one of ours with a valid code (to avoid double-wrapping and losing the original code)? */
function hasPublicCode(error: unknown): error is PublicError {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return (
    code === 'aborted' ||
    code === 'not_configured' ||
    code === 'invalid_args' ||
    code === 'rate_limited' ||
    code === 'backend_error'
  );
}

/**
 * Translates internal errors into public codes.
 *
 * Cancellation is detected by `name === 'AbortError'`, not instanceof DOMException:
 * the abort may come from the third party's own AbortController, whose DOMException comes from **its** realm,
 * so instanceof is false on our side, and a user cancellation would be reported as backend_error.
 *
 * rate_limited and backend_error are separate because they are **handled** differently: the former should wait and try again
 * (BaiBai Image's automatic backoff is already exhausted); the latter is a configuration/network problem and retrying gives the same error.
 */
export function toPublicError(error: unknown): PublicError {
  if (hasPublicCode(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') {
    return publicError('aborted', message || 'Cancelled');
  }
  // NaiError carries status: 429/408 are rate limits (retryable); other 4xx/5xx are backend errors
  if (error instanceof NaiError) {
    const status = error.status;
    if (status === 429 || status === 408) return publicError('rate_limited', message);
    return publicError('backend_error', message);
  }
  if (error instanceof ComfyUIError) return publicError('backend_error', message);
  // The fallback also checks the text: the two instanceof checks above are reliable within the same bundle, but there are plain Errors thrown elsewhere
  // internally (such as uploadUserImage's ImageStoreError) that have no status to check
  if (/\b429\b|限流|rate limit/i.test(message)) return publicError('rate_limited', message);
  return publicError('backend_error', message || 'Build failed');
}

/* —— Character list —— */

function toPublicCharacter(entry: CharTagEntry, locked: ReadonlySet<string>): PublicCharacter {
  return {
    name: entry.name,
    // The tag is computed by buildEntryTag, not assembled here: it is the single rule for "fields → tag string"
    // (including the fallback for "old entries with only a whole raw string"); a second copy would inevitably drift from the string cards actually generate with
    tag: buildEntryTag(entry),
    fields: { ...entry.fields },
    nl: entry.nl,
    source: entry.source,
    // Locked name = present in the global library with no same-name override in this chat. That is exactly the criterion for a "global entry"
    // (see computeLockedCharTagNames in charTags.ts), so no separate flag is needed
    scope: locked.has(entry.name) ? 'global' : 'chat',
    desc: entry.desc,
    // history is deliberately withheld: 50 change records are useless to third parties, and **once given it can't be removed**
    // (removing a field means bumping apiVersion). If someone really needs it, add an options switch later.
  };
}

export function getCharacters(options: GetCharactersOptions = {}): PublicCharacterList {
  const floor = options.floor;
  if (floor !== undefined && !Number.isInteger(floor)) {
    throw publicError('invalid_args', 'floor must be an integer');
  }
  // A specific floor uses snapshot replay (the profile as it was on that floor); otherwise use the live reactive library
  const entries = floor === undefined ? charTagLib.entries : charTagsBeforeFloor(floor);
  const locked = lockedCharTagNames();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision,
    floor: floor ?? null,
    // The mapped objects are already new plain objects (fields spread too) with no reactive proxies
    characters: entries.map(entry => toPublicCharacter(entry, locked)),
  };
}

/* —— Backend status —— */

/**
 * Backend status. **The fields are an allowlist, not a denylist**: only these four go out,
 * rather than "hand over the whole status and delete sensitive fields", which would silently leak whenever fields are added to the internal structure later.
 * In particular settings.nai.key and each backend's url never appear here.
 */
export function getBackendStatus(): PublicBackendStatus {
  const status = backendStatus();
  return {
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    backend: status.backend,
    configured: status.configured,
    model: status.model,
    supportsCharacters: status.supportsCharacters,
    reason: status.reason,
  };
}

/* —— Generation —— */

/** characters passed in by third parties: each item is cleaned into the internal shape; items with an empty name or tag are dropped. */
function normalizeCharacters(raw: GenerateRequest['characters']): ImageCharacterPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
    const nl = typeof item.nl === 'string' ? item.nl.trim() : '';
    return name && tag ? [{ name, tag, nl }] : [];
  });
}

/**
 * Result image → data URL.
 *
 * In server-proxy mode result.url already is a data URL and is returned as-is (no extra fetch, saving a copy);
 * direct mode gives a blob: URL, which is read back and re-encoded. Reason: see point 3 in the file header.
 */
async function toDataUrl(url: string, format: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to read image (${response.status})`);
  const bytes = new Uint8Array(await (await response.blob()).arrayBuffer());
  let binary = '';
  // Chunked concatenation: one String.fromCharCode(...several MB) would blow the call stack
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = format === 'jpg' ? 'jpeg' : format;
  return `data:image/${mime};base64,${btoa(binary)}`;
}

/** Progress callback wrapper: a third party's callback throwing must not break generation (it only wanted to see progress). */
function safeProgress(
  onProgress: GenerateOptions['onProgress'],
): (progress: PublicGenerateProgress) => void {
  if (typeof onProgress !== 'function') return () => {};
  return progress => {
    try {
      onProgress(progress);
    } catch (error) {
      console.warn('[BaiBai Image] Public interface onProgress callback exception', error);
    }
  };
}

export async function generate(
  request: GenerateRequest,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  if (!request || typeof request !== 'object') {
    throw publicError('invalid_args', 'generate requires a parameter object');
  }
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt) throw publicError('invalid_args', 'prompt cannot be empty');
  if (request.seed !== undefined && (typeof request.seed !== 'number' || !Number.isFinite(request.seed))) {
    throw publicError('invalid_args', 'seed must be a number');
  }

  // Report not_configured first, so the third party doesn't wait for a request certain to 401
  const status = backendStatus();
  if (!status.configured) {
    throw publicError('not_configured', status.reason || 'The backend of BaiBai Image is not configured');
  }

  const report = safeProgress(options.onProgress);
  const signal = options.signal;
  const characters = normalizeCharacters(request.characters);
  const nl = typeof request.nl === 'string' ? request.nl.trim() : '';
  const negative = typeof request.negative === 'string' ? request.negative.trim() : '';
  // Tolerant orientation normalisation: an unrecognised value counts as portrait; one frame parameter shouldn't fail the whole generation
  const size = normalizeOrientation(request.size);
  const seed = decideSeed(status.backend, request.seed);

  // NAI must pass the concurrency gate and may queue for a while; ComfyUI sends directly, with the queue on the server
  report({ phase: status.backend === 'nai' ? 'queued' : 'generating' });

  let output;
  try {
    output = await generateImage({ prompt, nl, negative, characters, size, seed }, signal, {
      onStart: () => report({ phase: 'generating' }),
      onQueue: ahead => report({ phase: 'queued-remote', ahead }),
      onRetry: retry =>
        retry
          ? report({ phase: 'retrying', attempt: retry.attempt, max: retry.max })
          : report({ phase: 'generating' }),
    });
  } catch (error) {
    throw toPublicError(error);
  }

  const { result } = output;
  try {
    const dataUrl = await toDataUrl(result.url, result.format);
    // Saving is on by default (the user's chosen rule): images go into the gallery by default; a third party must pass false explicitly for "burn after reading"
    const wantSave = request.save !== false;
    let path: string | null = null;
    if (wantSave) {
      report({ phase: 'saving' });
      // Store the orientation actually generated: when the channel locks it, it differs from the requested size, and the gallery's tag must describe this image truthfully
      path = await saveToGallery(request, prompt, nl, negative, characters, output.size, seed, result, output.meta);
    }
    return {
      apiVersion: PUBLIC_API_VERSION,
      pluginVersion: PLUGIN_VERSION,
      dataUrl,
      format: result.format,
      path,
      seed: output.seed,
      backend: output.backend,
      charactersApplied: output.charactersApplied,
    };
  } catch (error) {
    throw toPublicError(error);
  } finally {
    // Revoke the blob URL once used: the dataUrl is already in hand, so keeping the original blob is a pure leak
    result.revoke();
  }
}

/**
 * Saves into the gallery. **Failure only warns, never throws**: the image is already in the dataUrl,
 * and denying the third party the image because it couldn't go into the gallery would put the cart before the horse (it may not care about the gallery at all).
 * Returns null so the caller can tell from path that it wasn't saved.
 */
async function saveToGallery(
  request: GenerateRequest,
  prompt: string,
  nl: string,
  negative: string,
  characters: ImageCharacterPrompt[],
  size: ReturnType<typeof normalizeOrientation>,
  seed: number,
  result: Parameters<typeof saveExternalImage>[3],
  meta: GenerationMeta,
): Promise<string | null> {
  // What is stored is the **raw tag text** (including the <bbi_image> wrapper), not the assembled display text:
  // the gallery's read side runs parseImageTagContent then formatPromptText (the same rule as floor cards),
  // so storing display text here would make the gallery parse out one clump of bare tags.
  const tag = serializeImageTag({ tag: prompt, nl, negative, characters, size });
  const name =
    (typeof request.character === 'string' ? request.character.trim() : '') ||
    getContext()?.name2?.trim() ||
    '未命名角色';
  try {
    return await saveExternalImage(name, tag, seed, result, meta);
  } catch (error) {
    console.warn('[BaiBai Image] The image generated by the public interface failed to be placed (the image itself has been returned to the caller)', error);
    return null;
  }
}
