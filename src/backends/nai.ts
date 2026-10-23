import { unzipSync } from 'fflate';
import { randomUuid } from '@/randomUuid';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import {
  parseRetryAfter,
  runNaiWithRetry,
  type NaiRetryInfo,
} from '@/backends/naiRateLimit';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { clampVibeStrength, loadVibeData } from '@/backends/vibeStore';
import type { GenerationArtist, GenerationMeta, GenerationParams, GenerationVibe } from '@/generationMeta';
import type {
  NaiArtistPreset,
  NaiSettings,
  NaiVibe,
  NaiVibeData,
  NaiVibeEncodings,
} from '@/state/settings';

/**
 * NovelAI image backend (direct browser connection, protocol identical to the official image.novelai.net).
 * url can point to any compatible site: official/mirror/third-party relay; the /ai prefix is added to endpoints automatically.
 *
 * Follows st-chatu8's implementation:
 * - generation is POST {base}/ai/generate-image, body {input, model, action:'generate', parameters}.
 * - the response is a zip (stream: 'msgpack'); the first image is extracted.
 * - NAI3 vibes send the original reference image directly; NAI4/4.5 must first be encoded via /ai/encode-vibe,
 *   then layered at generation as reference_image_multiple_cached (uuid + encoded data).
 * - the .naiv4vibe file format is interchangeable with the official one (encodings grouped by model key).
 */

export class NaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * Milliseconds converted from the peer's Retry-After (null if not given).
     * naiRateLimit's retrier uses it as the backoff floor: it is the most authoritative first-hand information on "how long to wait",
     * and discarding it leaves only blind exponential backoff.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'NaiError';
  }
}

/* ============ Constant tables (same as st-chatu8 / the official NAI frontend) ============ */

export const NAI_SAMPLERS: { value: string; label: string }[] = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES: { value: string; label: string }[] = [
  { value: 'karras', label: 'Karras(recommended)' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** Official quality tags per model, appended to the end of the positive prompt; if the user changed them in the panel, their override is used. */
const QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/**
 * Official Heavy negative tags per model, the universal default needing no user choice; if the user changed them, their override is used.
 * 5-full appends a plugin-curated general negative layer after the official baseline: it only excludes **defects** such as quality/anatomy/watermarks,
 * never subjects, styles, body types or artist preferences, which would fight the user's positive tags and artist strings in the long run.
 * Other models keep the official baseline unchanged.
 */
const DEFAULT_UNDESIRED_CONTENT: Record<string, string> = {
  'nai-diffusion-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, watermark, signature, username, artist name, bad anatomy, bad hands, bad feet, extra digits, fewer digits, extra fingers, fused fingers, extra limbs, missing limbs, long neck, blurry, poorly drawn, unfinished, plastic skin, waxy skin, oversaturated, washed out',
  'nai-diffusion-5-curated':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-3':
    'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  'nai-diffusion-4-full':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-4-5-curated':
    'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
};

/**
 * A model's official quality tags / official Heavy negative tags. The panel uses them as the display content when "not customised"
 * and as the target for "restore defaults", so they must be exported; otherwise users can't see the tags actually in effect (the old problem before this change).
 */
export function naiDefaultQualityTags(model: string): string {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model: string): string {
  return DEFAULT_UNDESIRED_CONTENT[model] ?? '';
}

/** Magic constant for variety boost (same as st-chatu8): scaled by pixel count relative to a reference resolution. */
const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

export function naiSupportsVibes(model: string): boolean {
  return isNai3(model) || isNai4Family(model) || isNai5(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);

export function naiSamplers(model: string): { value: string; label: string }[] {
  return isNai5(model) ? NAI_SAMPLERS.filter(sampler => NAI_V5_SAMPLERS.has(sampler.value)) : NAI_SAMPLERS;
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

/**
 * Whether the model uses the "Base Prompt + native Character Prompts + natural language" protocol.
 *
 * The boundary is 4.5, not the whole v4 family: natural language arrived in 4.5, and the original NAI4
 * (nai-diffusion-4-full / 4-curated-preview) only takes tags. Sending it English nl sentences
 * is unverified behaviour, so it stays on the single-string tag specification.
 *
 * ⚠ Do not change this back to isNai5: the field holding char_captions is literally named v4_prompt; this structure is the V4-era
 * protocol and V5 merely inherits it. It was once gated on isNai5, so 4.5 supported it yet could not send a single character prompt.
 */
export function naiSupportsCharacterPrompts(model: string): boolean {
  return isNai45(model) || isNai5(model);
}

export function isNai4Family(model: string): boolean {
  return model.includes('nai-diffusion-4');
}

function isNai3(model: string): boolean {
  return model === 'nai-diffusion-3';
}

/** skip_cfg_above_sigma: computed from size and model when variety boost is on; off → null. */
export function skipCfgAboveSigma(width: number, height: number, model: string, varietyBoost: boolean): number | null {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============ Addresses and basic helpers ============ */

/**
 * Builds an endpoint: strips the trailing slash from base and appends /ai/<path>; if base is already a full endpoint
 * (ending in /ai/<path> or /<path>) it is used as-is, so third-party sites can give a whole URL.
 */
export function naiEndpoint(url: string, path: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('Please fill in the NAI interface address first');
  const seg = path.replace(/^\/+/, '');
  if (base.endsWith(`/ai/${seg}`) || base.endsWith(`/${seg}`)) return base;
  return `${base}/ai/${seg}`;
}

export interface NaiSize {
  width: number;
  height: number;
}

/** Parses "832×1216 / 832x1216"; width and height must be multiples of 64, 256–2048. */
export function parseResolution(text: string): NaiSize {
  const size = parseSize(text);
  if (!size) throw new NaiError(`Invalid resolution format: ${text || '(empty)'}; it should look like 832×1216`);
  const { width, height } = size;
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new NaiError(`resolution ${width}×${height} Not a multiple of 64, NAI requires both width and height to be multiples of 64`);
  }
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new NaiError(`resolution ${width}×${height} Out of NAI allowable range (256–2048)`);
  }
  return { width, height };
}

/** NAI seeds are 32-bit unsigned integers (unlike ComfyUI's 2^53; randomSeed can't be reused). */
export function naiRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ Payload construction (pure functions, testable) ============ */

export interface NaiGenerateValues {
  /** Positive tags (without quality tags). */
  prompt: string;
  nl?: string;
  characters?: ImageCharacterPrompt[];
  /** Seed; random when omitted. */
  seed?: number;
  /** Frame orientation; portrait when omitted (matching the fixed default before the change). */
  size?: Orientation;
}

/**
 * Built-in artist-string recipes: read-only and **kept out of settings**; changing them = changing the constants here, effective on release.
 *
 * Why not "seed them into settings on first launch": the moment they are written into settings, the defaults freeze on
 * every user's device (and sync across devices with extension_settings); any later change could only be made via
 * fingerprint migration "compared byte by byte with the old seed", carrying one more old seed per change. Built into the code,
 * the defaults always follow the version, and installed users' settings don't change by a byte.
 *
 * Rules:
 * - ids use the bi_ prefix (user entries are always art_*), never colliding with the user library;
 * - read-only: the panel allows no renaming/deleting; to customise, "Duplicate" into a user entry and edit that;
 * - quality/negative follow the same fallback chain as user entries; blank = follow the channel level;
 * - new users have the first one selected by default (see naiDefaults in settings.ts); old users'
 *   activeArtistId is stored in settings and unaffected by this;
 * - to retire a built-in recipe, keep it for at least one version before deleting: users who have it selected go through the existing
 *   "dangling id → cleared to none" logic, and their style changes silently, so be careful.
 */
export const BUILTIN_NAI_ARTISTS: readonly NaiArtistPreset[] = [
  {
    id: 'bi_default',
    name: 'Default artist tags',
    prompt:
      '0.8::nnmbpx::,0.8::artist:yalmyu::,0.1::smilesmile1312,::,  artist:sh_(shinh), 0.4::chen bin::,0.4::dayama::,healthyman,bacheally,',
    quality: '',
    negative: '',
  },
];

/** Whether the id is a built-in recipe (the panel makes it read-only accordingly; user entry ids are always art_*, so they can't collide). */
export function isBuiltinNaiArtist(id: string): boolean {
  return BUILTIN_NAI_ARTISTS.some(a => a.id === id);
}

type JsonObject = Record<string, unknown>;

/**
 * The style recipe currently in effect; none selected / pointing at a deleted entry → null.
 * Lookup domain = user library ∪ built-in library (user library first; the id prefixes differ, so in practice they can't collide).
 *
 * It deliberately takes nai rather than reading global settings: this file's assembly functions are pure and unit-testable, and reading globals would stop tests
 * controlling input via the nai() factory. It also deliberately doesn't import activeNaiArtist from state/settings:
 * settings.ts already imports this module's naiDefaultUndesired, and a reverse value dependency would create a runtime cycle (TDZ hazard).
 * The duplicated one-line find is intentional.
 */
function naiActivePreset(nai: NaiSettings): NaiArtistPreset | null {
  if (!nai.activeArtistId) return null;
  return (
    nai.artistPresets.find(a => a.id === nai.activeArtistId) ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === nai.activeArtistId) ??
    null
  );
}

/** Snapshot of the artist string in effect (id / name / text). None selected or text entirely blank → null.
 *  Both assembly (naiArtistPrompt) and recording with the image (usage in generateNaiImage) go through here, ensuring
 *  "the artist string actually sent" and "the artist string recorded" always share one source. */
export function naiArtistUsage(nai: NaiSettings): GenerationArtist | null {
  const preset = naiActivePreset(nai);
  const prompt = preset?.prompt.trim() ?? '';
  // An all-blank preset must become null: '   ' is truthy, and a downstream filter(Boolean) can't catch it
  if (!preset || !prompt) return null;
  return { id: preset.id, name: preset.name, prompt };
}

/** The artist string in effect: the selected entry's text; none selected / pointing at a deleted entry / content all blank → empty string. */
export function naiArtistPrompt(nai: NaiSettings): string {
  return naiArtistUsage(nai)?.prompt ?? '';
}

/**
 * Positive quality-tag resolution chain: recipe's bound value → channel override (qualityTags) → built-in default.
 * An empty (or whitespace-only) string at any level = follow the next level. The built-in default is currently the model's official tags;
 * if the plugin later switches to its own curated defaults, only naiDefaultQualityTags changes; the chain structure stays the same.
 */
export function naiQualityTags(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.quality.trim();
  return bound || nai.qualityTags.trim() || naiDefaultQualityTags(nai.model);
}

/** Negative prompt resolution chain: recipe's bound value → channel override (undesiredContent) → built-in default (the model's official negative tags). */
export function naiUndesiredContent(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.negative.trim();
  return bound || nai.undesiredContent.trim() || naiDefaultUndesired(nai.model);
}

/**
 * Full positive prompt: artist string first, image tags in the middle, quality tags last.
 * - artist string = the entry currently selected in the style recipe library (none if not selected). It goes first because it sets the whole image's style,
 *   and NAI weights earlier tags more heavily;
 * - quality tags = the recipe's bound value first, then the channel override (qualityTags); if both are blank, the model's official tags
 *   (see naiQualityTags).
 *
 * ⚠ This function is called once each in buildNaiParameters (the source of v4_prompt) and for generateNaiImage's top-level input
 * field, and the two must share one source. Keep every assembly change inside this function: adding extras at one call site would give
 * NAI3 (reads input) and NAI4/4.5 (read v4_prompt) different prompts, and the difference would only show up on NAI3.
 */
export function fullPositivePrompt(nai: NaiSettings, prompt: string, nl = ''): string {
  const artist = naiArtistPrompt(nai);
  const quality = naiQualityTags(nai);
  const tags = [artist, prompt.trim(), quality].filter(Boolean).join(', ');
  return naiSupportsCharacterPrompts(nai.model) && nl.trim() ? `${tags}. ${nl.trim()}` : tags;
}

function characterCaption(character: ImageCharacterPrompt): string {
  // Character Prompts identify one subject: library count tags (1girl/1boy) become girl/boy here.
  const tag = character.tag
    .split(',')
    .map(part => {
      const value = part.trim();
      if (/^\d+\s*girls?$/i.test(value)) return 'girl';
      if (/^\d+\s*boys?$/i.test(value)) return 'boy';
      return value;
    })
    .filter(Boolean)
    .join(', ');
  return character.nl.trim() ? `${tag}. ${character.nl.trim()}` : tag;
}

/**
 * Full negative prompt = recipe's bound value → channel override (undesiredContent) → the model's official negative tags
 * (see naiUndesiredContent). To exclude something extra, append it to the value at any level.
 */
export function fullNegativePrompt(nai: NaiSettings): string {
  return naiUndesiredContent(nai);
}

/**
 * Builds parameters. v4-family models carry the v4_prompt/v4_negative_prompt structure; NAI3 doesn't.
 * Vibes are not layered here (see applyVibes), keeping "one generation = build + applyVibes" as two steps.
 */
export function buildNaiParameters(nai: NaiSettings, values: NaiGenerateValues): JsonObject {
  // Frame size takes the user's cell for the orientation; falls back to the portrait default if blank
  const orientation = values.size ?? 'portrait';
  const { width, height } = parseResolution(pickSize(nai, orientation) || '832×1216');
  // Explicitly passed > panel fixed seed > random
  const seed = values.seed ?? (nai.seed > 0 ? nai.seed : naiRandomSeed());
  const prompt = fullPositivePrompt(nai, values.prompt, values.nl);
  const negative = fullNegativePrompt(nai);
  const skipCfg = skipCfgAboveSigma(width, height, nai.model, nai.varietyBoost);
  const sampler = isNai5(nai.model) && !NAI_V5_SAMPLERS.has(nai.sampler) ? 'k_euler_ancestral' : nai.sampler;

  const params: JsonObject = {
    params_version: isNai5(nai.model) ? 4 : 3,
    width,
    height,
    scale: nai.scale,
    sampler,
    steps: nai.steps,
    n_samples: 1,
    // The prompt is already assembled from local fixed defaults; protocol fields keep the official frontend's conventions.
    ucPreset: 3,
    qualityToggle: true,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: nai.cfgRescale,
    noise_schedule: nai.noiseSchedule,
    skip_cfg_above_sigma: skipCfg,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negative,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: nai.normalizeRefStrength,
    use_coords: false,
  };

  if (isNai3(nai.model)) {
    // NAI3: vibes send the original reference image directly; SME/SMEA are not offered yet (fixed off)
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4/4.5/V5: v4 caption structure; Vibe uses a model-specific cached encoding.
    params.reference_image_multiple_cached = [];
    const charCaptions = naiSupportsCharacterPrompts(nai.model)
      ? (values.characters ?? []).map(character => ({
          char_caption: characterCaption(character),
          centers: [{ x: 0.5, y: 0.5 }],
        }))
      : [];
    params.characterPrompts = [];
    params.v4_prompt = {
      caption: { base_caption: prompt, char_captions: charCaptions },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: {
        base_caption: negative,
        char_captions: charCaptions.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })),
      },
      legacy_uc: false,
    };
  }

  if (sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  return params;
}

/** Vibe model key: the grouping key of encodings (same as the official .naiv4vibe). */
export function vibeModelKey(model: string): string {
  if (model.includes('nai-diffusion-5-curated')) return 'v5curated';
  if (model.includes('nai-diffusion-5-full')) return 'v5full';
  if (model.includes('4-5-curated')) return 'v4-5curated';
  if (model.includes('4-5-full')) return 'v4-5full';
  if (model.includes('4-curated')) return 'v4curated';
  if (model.includes('4-full')) return 'v4full';
  if (model.includes('diffusion-3')) return 'v3';
  return 'v4-5full';
}

/** The result of one applyVibes. */
export interface VibeApplication {
  /** Vibes actually layered into parameters (with configured strength and actually sent strength). */
  applied: GenerationVibe[];
  /** Names of vibes skipped for missing the current model's encoding / missing the original image / unsupported model (for toastr). */
  skipped: string[];
}

/**
 * Layers the enabled vibes into parameters.
 * - NAI3: original reference images go into reference_image_multiple (with information extracted 1 + strength);
 * - NAI4/4.5: encoded data goes into reference_image_multiple_cached (random cache key), strengths into
 *   reference_strength_multiple; when the total strength exceeds 1 and normalisation is on, they are scaled back to 1 proportionally.
 * Returns the vibes actually layered (recorded with the image) and the names of skipped vibes (the caller warns about them).
 */
export function applyVibes(
  params: JsonObject,
  nai: NaiSettings,
  dataById: ReadonlyMap<string, NaiVibeData>,
): VibeApplication {
  const active = nai.vibes.filter(v => v.enabled);
  if (!active.length) return { applied: [], skipped: [] };
  if (!naiSupportsVibes(nai.model)) return { applied: [], skipped: active.map(vibe => vibe.name) };
  const applied: GenerationVibe[] = [];
  const skipped: string[] = [];
  const strengths = params.reference_strength_multiple as number[];

  if (isNai3(nai.model)) {
    const images = params.reference_image_multiple as string[];
    const infos = params.reference_information_extracted_multiple as number[];
    for (const vibe of active) {
      const data = dataById.get(vibe.id);
      if (!data?.image) {
        skipped.push(vibe.name);
        continue;
      }
      images.push(data.image);
      infos.push(1);
      strengths.push(vibe.strength);
      applied.push(vibeUsage(vibe, vibe.strength));
    }
    return { applied, skipped };
  }

  const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
  const modelKey = vibeModelKey(nai.model);
  const picked: NaiVibe[] = [];
  for (const vibe of active) {
    const enc = dataById.get(vibe.id)?.encodings[modelKey];
    if (!enc?.encoding) {
      skipped.push(vibe.name);
      continue;
    }
    cached.push({ cache_secret_key: randomUuid(), data: enc.encoding });
    picked.push(vibe);
  }
  // Normalisation: when the total strength > 1, scale back to 1 proportionally (same as st-chatu8; with normalisation on for 4.5 the official side handles it automatically too)
  const total = picked.reduce((sum, vibe) => sum + vibe.strength, 0);
  const scale = nai.normalizeRefStrength && total > 1 ? 1 / total : 1;
  for (const vibe of picked) {
    const effective = vibe.strength * scale;
    strengths.push(effective);
    applied.push(vibeUsage(vibe, effective));
  }
  return { applied, skipped };
}

/** Builds one vibe usage record: strength = the panel's configured value, effectiveStrength = the value actually sent. */
function vibeUsage(vibe: NaiVibe, effectiveStrength: number): GenerationVibe {
  return {
    id: vibe.id,
    name: vibe.name,
    group: vibe.group,
    strength: vibe.strength,
    effectiveStrength,
  };
}

/* ============ Network requests ============ */

async function naiHttpError(resp: Response, label: string): Promise<NaiError> {
  const text = (await resp.text().catch(() => '')).trim();
  let detail = text;
  try {
    const json = JSON.parse(text);
    if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* Non-JSON error bodies use the raw text directly */
  }
  // Retry-After goes along too: the retrier uses it as the backoff floor (see NaiError.retryAfterMs)
  const retryAfterMs = parseRetryAfter(resp.headers?.get('Retry-After'));
  switch (resp.status) {
    case 400:
      return new NaiError(`${label}: request validation failed: ${detail.slice(0, 300)}`, resp.status, retryAfterMs);
    case 401:
      return new NaiError(`${label}:API Key Wrong or invalid`, resp.status, retryAfterMs);
    case 402:
      return new NaiError(`${label}:Requires valid subscription (402)`, resp.status, retryAfterMs);
    case 429:
      return new NaiError(
        `${label}: The request is too frequent (429), and it has automatically backed off and tried again; if it still fails, please lower the "Number of simultaneous images" or try again later.`,
        resp.status,
        retryAfterMs,
      );
    default:
      return new NaiError(`${label} (${resp.status}): ${detail.slice(0, 300)}`, resp.status, retryAfterMs);
  }
}

/** Tests the connection: prefers /user/subscription to verify the key; third-party sites without this endpoint (404) only verify that the address is reachable. */
export async function testNaiConnection(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!nai.key.trim()) throw new NaiError('Please fill in API Key first');
  const resp = await fetch(naiEndpoint(nai.url, 'user/subscription'), {
    headers: { Authorization: `Bearer ${nai.key.trim()}` },
    signal,
  });
  if (resp.status === 404) {
    return { message: 'The address is reachable, but there is no subscription interface (third-party site); please verify with actual pictures' };
  }
  if (!resp.ok) throw await naiHttpError(resp, 'Failed to connect to NAI');
  const data = (await resp.json().catch(() => null)) as {
    tier?: number;
    active?: boolean;
    subscription?: { tier?: number; active?: boolean; expiresAt?: number };
  } | null;
  const tier = data?.subscription?.tier ?? data?.tier;
  const active = data?.subscription?.active ?? data?.active;
  const tierName = ['Free', 'Tablet', 'Scroll', 'Opus'][Number(tier)] ?? `Tier ${tier}`;
  return {
    message: `Connection OK: ${tierName}${active === false ? ' (subscription not active)' : ''}`,
  };
}

/** Unpacks the zip NAI returns and converts the first image to base64. */
export function unzipNaiImage(buffer: ArrayBuffer): { base64: string; filename: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new NaiError('The response is not a valid zip packet (the third party site may have returned a different format)');
  }
  const name = Object.keys(files).find(n => /\.(png|jpe?g|webp)$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new NaiError('zip There is no image file in the package');
  return { base64: uint8ToBase64(files[name]), filename: name };
}

/** The full output of generateNaiImage: the image + metadata recorded with it. */
export interface NaiImageOutput {
  result: ComfyImageResult;
  /** The part of the recipe not in the tag text (artist string / vibes / sampling parameters / model-independent fields). */
  usage: Pick<GenerationMeta, 'positive' | 'negative' | 'width' | 'height' | 'artist' | 'vibes' | 'params'>;
}

/**
 * Generates an image. Returns the image and the artist string/vibes/sampling parameters actually used.
 *
 * 429/5xx/network-level failures back off and retry automatically (backends/naiRateLimit.ts); configuration errors
 * (wrong key, expired subscription, invalid parameters) throw immediately without pointless retries. onRetry reports the backoff
 * to the card for display; otherwise users see a motionless "Generating…" for tens of seconds, assume it froze and click again.
 */
export async function generateNaiImage(
  nai: NaiSettings,
  values: NaiGenerateValues,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<NaiImageOutput> {
  if (!nai.key.trim()) throw new NaiError('Please fill in first NAI API Key');
  if (!values.prompt.trim()) throw new NaiError('Positive prompt word cannot be empty');

  // The artist string is resolved once when the request is sent and snapshotted to be saved with the image: if the recipe is later deleted/renamed it isn't lost.
  const artist = naiArtistUsage(nai);
  const params = buildNaiParameters(nai, values);
  const activeVibes = naiSupportsVibes(nai.model) ? nai.vibes.filter(vibe => vibe.enabled) : [];
  const loaded = new Map<string, NaiVibeData>();
  for (const vibe of activeVibes) {
    try {
      const data = await loadVibeData(vibe);
      loaded.set(
        vibe.id,
        isNai3(nai.model)
          ? data
          : {
              image: '',
              thumbnail: '',
              encodings: data.encodings,
            },
      );
    } catch (error) {
      console.warn(`[BaiBai Image] Failed to read vibe "${vibe.name}":`, error);
    }
  }
  const { applied, skipped } = applyVibes(params, nai, loaded);
  if (skipped.length) {
    const reason = naiSupportsVibes(nai.model) ? 'Missing current model encoding' : 'Current model does not support Vibe Transfer';
    console.warn(`[BaiBai Image] The following vibes were skipped (${reason}):`, skipped);
    toastr.warning(`Vibe "${skipped.join(', ')}": ${reason}, skipped`, 'BaiBai Image');
  }

  const body = {
    input: fullPositivePrompt(nai, values.prompt, values.nl),
    model: nai.model,
    action: 'generate',
    parameters: params,
    use_new_shared_trial: true,
  };
  // Only "send the request + unpack" is wrapped in retries: assembling parameters and reading vibe data above are one-off work,
  // and rerunning them would both waste effort and pop the toastr warning about vibes missing encodings again.
  const result = await runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'generate-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'NAI Picture generation failed');

      const { base64, filename } = unzipNaiImage(await resp.arrayBuffer());
      const format = filename.split('.').pop()?.toLowerCase() || 'png';
      return {
        url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${base64}`,
        filename: `nai-${Date.now()}.${format}`,
        format,
        revoke() {},
      };
    },
    { signal, onRetry: opts.onRetry },
  );

  return {
    result,
    usage: {
      // positive is the full text in the top-level input / v4_prompt (including artist string and quality tags)
      positive: fullPositivePrompt(nai, values.prompt, values.nl),
      negative: fullNegativePrompt(nai),
      width: params.width as number,
      height: params.height as number,
      artist,
      vibes: applied,
      params: naiParamsSnapshot(params, nai),
    },
  };
}

/** Sampling-parameter snapshot: scalars only, without prompts or vibe binaries. */
function naiParamsSnapshot(params: JsonObject, nai: NaiSettings): GenerationParams {
  return {
    sampler: params.sampler as string,
    steps: params.steps as number,
    cfg: params.scale as number,
    cfgRescale: params.cfg_rescale as number,
    noiseSchedule: params.noise_schedule as string,
    quality: naiQualityTags(nai),
    varietyBoost: nai.varietyBoost,
    normalizeRefStrength: nai.normalizeRefStrength,
  };
}

/* ============ Vibe encoding and .naiv4vibe interchange ============ */

/** Fixed inner key of encoding in the official .naiv4vibe (same as st-chatu8). */
export const VIBE_ENCODING_KEY = 'b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f';

/**
 * Calls /ai/encode-vibe to encode a reference image into vibe data (base64).
 * NAI4/4.5 vibes must be encoded this way; NAI3 doesn't need it (sends the original image directly).
 *
 * Backoff retries just like generation: this is a real NAI request too, and on a 429 it shouldn't just show a red bar and give up.
 * (The concurrency slot is taken by the caller; see pages/backend/panels/NaiPanel.vue, the same discipline as cards.)
 */
export async function encodeVibeImage(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  imageBase64: string,
  model: string,
  infoExtracted = 1,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<string> {
  if (!nai.key.trim()) throw new NaiError('Please fill in first NAI API Key');
  return runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'encode-vibe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify({ image: imageBase64, information_extracted: infoExtracted, model }),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'vibe encoding failed');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length < 100) {
        throw new NaiError(`vibe encoding data abnormality (only ${bytes.length} bytes), the interface may have returned an error response`);
      }
      return uint8ToBase64(bytes);
    },
    { signal, onRetry: opts.onRetry },
  );
}

export interface ImportedVibe {
  name: string;
  image: string;
  thumbnail: string;
  encodings: NaiVibeEncodings;
  strength: number;
}

/** Parses .naiv4vibe file text (JSON) into a vibe entry (without id; the caller adds it). */
export function parseNaiv4vibe(text: string): ImportedVibe {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NaiError('Not a valid .naiv4vibe file (JSON parsing failed)');
  }
  if (json?.identifier !== 'novelai-vibe-transfer') {
    throw new NaiError('Not a NovelAI vibe file (missing novelai-vibe-transfer identifier)');
  }
  const encodings: NaiVibeEncodings = {};
  for (const [modelKey, group] of Object.entries(json.encodings ?? {})) {
    const first = Object.values(group as Record<string, any>)[0];
    if (typeof first?.encoding === 'string' && first.encoding) {
      encodings[modelKey] = {
        encoding: first.encoding,
        infoExtracted:
          typeof first.params?.information_extracted === 'number'
            ? first.params.information_extracted
            : 1,
      };
    }
  }
  if (!Object.keys(encodings).length) throw new NaiError('vibe No encoding data available in file');
  return {
    name: typeof json.name === 'string' && json.name ? json.name : 'Imported Vibe',
    image: typeof json.image === 'string' ? json.image : '',
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : '',
    encodings,
    strength: clampVibeStrength(json.importInfo?.strength),
  };
}

/** Exports official-compatible .naiv4vibe JSON (all encoded models included). */
export async function buildNaiv4vibe(vibe: NaiVibe, data: NaiVibeData): Promise<string> {
  const encodings: Record<string, unknown> = {};
  for (const [modelKey, enc] of Object.entries(data.encodings)) {
    encodings[modelKey] = {
      [VIBE_ENCODING_KEY]: {
        encoding: enc.encoding,
        params: { information_extracted: enc.infoExtracted },
      },
    };
  }
  const id = data.image ? await sha256Hex(data.image) : randomUuid();
  return JSON.stringify({
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: data.image,
    id,
    encodings,
    name: vibe.name,
    thumbnail: data.thumbnail,
    createdAt: Date.now(),
    importInfo: {
      model: Object.keys(data.encodings)[0] ?? '',
      information_extracted: 1,
      strength: vibe.strength,
    },
  });
}
