/**
 * The shared middle of "one image generation": the single generation entry point for floor cards and the public API.
 *
 * This work used to live entirely in Card.vue's generate(), tangled up with slot runtime state (beginGen/failGen),
 * saving (saveImageResult) and re-hydration (hydrateMessage). The public API lets third parties
 * "decide for themselves where the image shows", and what they need is precisely **the middle with head and tail removed**:
 *
 *   before (caller): register runtime state / validate parameters
 *   ★ middle (this module): NAI gate → dispatch by backend → get the image
 *   after (caller): save, display, final tracking
 *
 * **The gate cannot be bypassed**, which is the main reason this module exists: calling generateNaiImage in backends/nai.ts directly
 * would run outside the concurrency gate and global pacing in floor/genQueue.ts, and 0.2.0's entire
 * NAI rate-limit self-healing (global 429 cooldown, minimum interval between requests, backoff retries) would be gone at once. Concurrent third-party calls
 * are normal, and the symptom of bypassing is the user's NAI account eating a burst of 429s, while the user just thinks BaiBai Image is broken.
 * So the public API and cards share this function, and the gate is sealed in here.
 *
 * This module deliberately **does not touch**: floor coordinates, genState, extra, hydration, request-history tracking.
 * Leaving tracking to callers is intentional: what counts as "success" for a history record differs per caller. Floor cards only count it once
 * saveImageResult has saved successfully, and must record "got the image but discarded it because the task was superseded" as cancelled;
 * this module only knows whether the request itself succeeded, and concluding on the caller's behalf would misreport those two cases as success.
 * Hence decideSeed is exported separately: the caller fixes the seed first (tracking needs it), then passes it in explicitly.
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { comfySimpleParams, composeNegative, composePositive, validateSimpleConfig, type SimpleGenValues } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { generateNaiImage, naiRandomSeed, naiSupportsCharacterPrompts } from '@/backends/nai';
import { effectiveOrientation, parseSize, pickSize, type Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import type { GenerationMeta } from '@/generationMeta';
import { activeComfyPreset, activeNaiEndpoint, activeOrientationLock, effectiveComfyConn, effectiveNai, settings, type BackendId } from '@/state/settings';

/** Input for one generation. Same shape as the protocol layer's ImageInsertion, but without story-text position info. */
export interface GenerateInput {
  /** Positive short danbooru tags. */
  prompt: string;
  /** Natural-language part (optional). */
  nl?: string;
  /** Per-image dynamic negative (optional). ComfyUI uses %negative_prompt%; NAI takes its negative from the channel config and ignores this. */
  negative?: string;
  /** NAI 4.5/V5 native multi-character prompts; ComfyUI does not support them (see charactersApplied). */
  characters?: ImageCharacterPrompt[];
  /**
   * Frame orientation; defaults to portrait. Exact pixels come from the channel's portrait/landscape sizes.
   * If the channel locks orientation (activeOrientationLock), the locked orientation always applies and whatever is passed here is ignored.
   */
  size?: Orientation;
  /** Seed for this run. Fixed beforehand by the caller via decideSeed() (tracking needs it before the request is sent). */
  seed: number;
}

/** Progress reports during generation (the card uses them to show queue position and backoff progress). */
export interface GenerateProgress {
  /** A gate slot has been acquired and the request is about to go out (when NAI moves from "queued" to "generating"). */
  onStart?: () => void;
  /** How many tasks are ahead in the ComfyUI server queue; null = unknown. */
  onQueue?: (ahead: number | null) => void;
  /** NAI rate-limit backoff progress; null means no longer backing off. */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** The seed actually used (passed back as-is, so the caller need not keep track). */
  seed: number;
  /** The orientation actually rendered (the locked orientation when the channel is locked; may differ from the size passed in). */
  size: Orientation;
  backend: BackendId;
  /**
   * Whether characters was actually sent to the backend.
   * The ComfyUI path **does not support** multi-character prompts (comfyui.ts / comfyTemplates.ts never read the field),
   * so passing them is silently dropped. It is reported explicitly so callers can decide whether to tell the user to switch backends.
   * No "degrade by merging into the prompt" here: that is exactly the overlapping-torso problem fixed in 0.2.3 (several full appearances in one image).
   */
  charactersApplied: boolean;
  /**
   * The artist string / vibes / sampling parameters / model actually used, saved with the image (see generationMeta.ts).
   * NAI's artist string and vibes are not in the tag text; if they don't bubble up here they are lost for good.
   */
  meta: GenerationMeta;
}

/** Backend readiness status. */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** Model name for NAI; current workflow preset name for ComfyUI. */
  model: string;
  /** Whether the current backend supports characters (true for NAI 4.5/V5, always false for ComfyUI). */
  supportsCharacters: boolean;
  /** Human-readable reason when configured=false; empty string when ready. */
  reason: string;
}

/**
 * Whether the current backend can generate images. **The single criterion**, shared by cards (configured) and the public API.
 *
 * ComfyUI is validated per mode (custom needs workflow JSON; simple needs model/VAE/CLIP all selected,
 * using the same validateSimpleConfig as assembly, avoiding "the card is clickable but generation errors"); NAI needs url + key.
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = settings.nai.model;
    // Support depends only on the model, not on whether configuration is complete: third parties need to know whether to pass characters before generating
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    // The address and key come from **the current endpoint** (see effectiveNai); channel-level nai.url/nai.key are legacy fields.
    // The reason deliberately **omits the endpoint name**: it is passed to third parties as-is through getBackendStatus, and the name is
    // typed by the user; some use the site domain as the name, so including it would leak the address into a public return value (see the allowlist in public/api.ts).
    // Without the name it is still easy to locate: it is the one selected in the panel dropdown.
    const conn = activeNaiEndpoint();
    if (!conn.url.trim()) {
      return { ...base, configured: false, reason: 'The current NAI endpoint has no API address' };
    }
    if (!conn.key.trim()) {
      return { ...base, configured: false, reason: 'The current NAI endpoint has no API key' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    if (!settings.comfyui.url.trim()) {
      return { ...base, configured: false, reason: 'The ComfyUI address is empty' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: 'The current workflow preset has no workflow JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  // webui only survives as a legacy type (settings migration normalises it to comfyui/nai); if it shows up, it means "no backend selected"
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: 'No image backend is selected. Choose one on the "Backend" page of BaiBai Image.',
  };
}

/**
 * Fixes the seed for this run. **It must be fixed before the request is sent**: first, some sampler nodes don't accept -1 for auto-random;
 * second, tracking and saving (entry.seed) both record it, which is what makes "another one with the same seed" possible later.
 *
 * Rule: explicitly given > NAI panel fixed seed (>0) > random.
 * NAI and ComfyUI have different random upper bounds (each protocol's valid range), so they are drawn separately.
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return settings.nai.seed > 0 ? settings.nai.seed : naiRandomSeed();
  return randomSeed();
}

/**
 * Generates one image with the current settings. **The single generation path for floor cards and the public API.**
 *
 * Does not save, display, register runtime state or track; those are the caller's job.
 * signal is passed all the way down to fetch/polling; on cancel it throws AbortError (DOMException).
 *
 * Gate discipline (see floor/genQueue.ts): the NAI path must hold a slot while sending, with release in finally;
 * missing one release permanently loses one unit of concurrency.
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // Safety net: the card side already blocks the button via configured, and the public API reports not_configured first.
  // Reaching here means the upstream criterion drifted; better to say so than send a request certain to fail with 401/404.
  if (!status.configured) throw new Error(status.reason || 'The image backend is not configured');

  const isNai = status.backend === 'nai';
  const characters = input.characters ?? [];
  // The backend decides support: ComfyUI never supports it; NAI depends on whether the model is 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  let release: (() => void) | null = null;
  try {
    // Hold the slot: once acquired, this function holds it until finally releases it
    if (isNai) release = await acquireNaiSlot(signal);
    progress.onStart?.();

    // The orientation lock applies here for everyone (cards and the public API both go through this function): it only decides which size cell this run uses;
    // the orientation recorded in the tag stays untouched, since promptHash hashes the raw tag and rewriting it would make old images stale for no reason.
    const size = effectiveOrientation(activeOrientationLock(), input.size ?? 'portrait');
    let result: ComfyImageResult;
    let meta: GenerationMeta;
    if (isNai) {
      const output = await generateNaiImage(
        effectiveNai(),
        // characters passes through unchanged: buildNaiParameters filters it out for unsupported models itself (same rule,
        // naiSupportsCharacterPrompts); filtering again here would only add another criterion that can drift
        { prompt: input.prompt, nl: input.nl ?? '', characters, seed: input.seed, size },
        signal,
        { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
      );
      result = output.result;
      meta = { backend: 'nai', model: status.model, ...output.usage };
    } else {
      const conn = effectiveComfyConn();
      result = await generateComfyImage(
        conn,
        {
          prompt: input.prompt,
          nl: input.nl ?? '',
          negative_prompt: input.negative ?? '',
          seed: input.seed,
          size,
        },
        signal,
        { onQueue: ahead => progress.onQueue?.(ahead) },
      );
      // ComfyUI has no runtime-skip concept; the whole recipe is in the preset, so it can be snapshotted here directly.
      // Size parsing follows generateComfyImage (0 when unparsed = use the workflow's own size).
      const px = parseSize(pickSize(conn, size));
      const width = px?.width ?? 0;
      const height = px?.height ?? 0;
      const simpleValues: SimpleGenValues = {
        prompt: input.prompt,
        nl: input.nl,
        negative: input.negative,
        seed: input.seed,
        width,
        height,
      };
      meta = {
        backend: 'comfyui',
        model: status.model,
        width,
        height,
        // In custom mode the prompt is decided by placeholders in the workflow, so the full text can't be built here; left empty.
        positive: conn.mode === 'simple' ? composePositive(conn.simple, simpleValues) : '',
        negative: conn.mode === 'simple' ? composeNegative(conn.simple, simpleValues) : '',
        artist: null,
        vibes: [],
        params: conn.mode === 'simple' ? comfySimpleParams(conn.simple) : { mode: 'custom' },
      };
    }

    // Backoff text stops here: the image is in hand and saving takes a moment; "retrying shortly" should no longer show
    progress.onRetry?.(null);
    return { result, seed: input.seed, size, backend: status.backend, charactersApplied, meta };
  } finally {
    release?.();
  }
}
