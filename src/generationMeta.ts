/**
 * Snapshot of the "recipe" actually used for one generation, saved with the image (sidecar json + floor extra),
 * so you can later check "which artist string / vibes / sampling parameters did this image use".
 *
 * Why a snapshot rather than just reference ids: artist-string recipes, vibe entries and workflow presets may later be
 * renamed or deleted, and with ids only, old images would point at nothing. That is exactly the pain of "drew an image I love but forgot which
 * artist string/vibe I used".
 *
 * Why a separate leaf module with zero imports:
 * - prompt / seed are already stored by BbiImageEntry and the sidecar; this only adds the part "not in the tag text"
 *   (artist string, vibes, sampling parameters, model);
 * - settings.ts → backends/nai.ts → this module: dependencies must flow one way. Importing settings'
 *   BackendId here would create a cycle (settings already imports nai's default negatives), so backend uses a literal union,
 *   the same workaround as ImageBegin in state/history.ts.
 */

/** Artist-string snapshot. Stores the text, not just the id: recipes may be renamed/deleted. */
export interface GenerationArtist {
  id: string;
  /** Display name the user gave the recipe. */
  name: string;
  /** Artist-string text (the thing actually used to reproduce it). */
  prompt: string;
}

/** One vibe actually layered into the request. */
export interface GenerationVibe {
  id: string;
  name: string;
  /** Snapshot of the group name; empty string = ungrouped. */
  group: string;
  /** Configured strength shown in the panel (the value users reopen with to reproduce). */
  strength: number;
  /**
   * Strength actually sent to the backend: scaled down proportionally when "normalise reference strength" is on and the total exceeds 1.
   * The UI marks it separately when it differs from strength.
   */
  effectiveStrength: number;
}

/**
 * Sampling-parameter snapshot. Every field is optional and each backend fills its own; adding keys extends it without changing the format version.
 * NAI and ComfyUI name the same concept differently (NAI's scale / ComfyUI's cfg); both map to cfg,
 * which reads more clearly; what really reproduces an image is the whole recipe, not protocol field names.
 */
export interface GenerationParams {
  /** ComfyUI: simple / custom; NAI has no such key. */
  mode?: string;
  /** ComfyUI simple template id (checkpoint / flux / anima). */
  template?: string;
  /** ComfyUI base model / UNet file name. */
  baseModel?: string;
  vae?: string;
  /** CLIP file names; multiple joined with ", ". */
  clips?: string;
  /** LoRA list, as "name×strength" joined with ", ". */
  loras?: string;
  sampler?: string;
  scheduler?: string;
  steps?: number;
  /** Prompt guidance (NAI's scale / ComfyUI's cfg). */
  cfg?: number;
  /** Quality tags appended to the end of the positive prompt (the actual value after NAI resolves it). */
  quality?: string;
  /** NAI prompt guidance rescale (cfg_rescale). */
  cfgRescale?: number;
  /** NAI noise schedule. */
  noiseSchedule?: string;
  /** NAI Variety Boost. */
  varietyBoost?: boolean;
  /** NAI reference-strength normalisation. */
  normalizeRefStrength?: boolean;
  /** ComfyUI Flux-only guidance strength. */
  guidance?: number;
  /** ComfyUI Anima-only shift. */
  shift?: number;
}

/** Complete generation metadata saved with the image. */
export interface GenerationMeta {
  backend: 'nai' | 'comfyui';
  /** NAI model name / ComfyUI workflow preset name. Vibe encodings are grouped by model, so they must be recorded together. */
  model: string;
  /** Frame pixels actually sent to the backend; 0 = the workflow's own size (when ComfyUI couldn't parse one). */
  width: number;
  height: number;
  /** Full positive prompt actually sent (NAI = artist string + tags + quality tags; ComfyUI simple mode = fixed positive + content). */
  positive: string;
  /** Negative prompt actually sent (empty string if unavailable; the negative is still in the tag text). */
  negative: string;
  /** NAI artist string; null for other backends. */
  artist: GenerationArtist | null;
  /** Vibes NAI actually layered (skipped ones excluded); empty array for other backends. */
  vibes: GenerationVibe[];
  params: GenerationParams;
}

/** Decimal display for strengths etc.: integers without a decimal point, others up to 3 places with trailing zeros removed. */
function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatVibe(vibe: GenerationVibe): string {
  const group = vibe.group ? `(${vibe.group})` : '';
  const normalized =
    Math.abs(vibe.effectiveStrength - vibe.strength) > 1e-6
      ? `(Actual ×${round(vibe.effectiveStrength)})`
      : '';
  return `${vibe.name}${group} ×${round(vibe.strength)}${normalized}`;
}

/**
 * Renders meta into a few lines of read-only text (shared by the gallery lightbox and floor cards, so the two can't drift apart).
 *
 * **Read-only display, never written back to the text**: the artist string/vibes are provenance for "how this image was made",
 * not an editable prompt. To change the prompt, use the prompt editor (that path only touches the tag text).
 */
export function formatGenerationMeta(meta: GenerationMeta): string {
  const lines: string[] = [];

  if (meta.artist) {
    lines.push(`Artist Tags: ${meta.artist.name}${meta.artist.prompt ? ` · ${meta.artist.prompt}` : ''}`);
  }
  if (meta.params.quality) {
    lines.push(`Quality word: ${meta.params.quality}`);
  }
  if (meta.vibes.length) {
    lines.push(`Vibe: ${meta.vibes.map(formatVibe).join(', ')}`);
  }
  lines.push(`Model: ${meta.model}`);
  if (meta.width > 0 && meta.height > 0) {
    lines.push(`Dimensions: ${meta.width}×${meta.height}`);
  }
  if (meta.negative) {
    lines.push(`Negative: ${meta.negative}`);
  }

  const p = meta.params;
  const sampling: string[] = [];
  if (p.template) sampling.push(`Template ${p.template}`);
  if (p.baseModel) sampling.push(`Base model ${p.baseModel}`);
  if (p.vae) sampling.push(`VAE ${p.vae}`);
  if (p.clips) sampling.push(`CLIP ${p.clips}`);
  if (p.loras) sampling.push(`LoRA ${p.loras}`);
  if (p.sampler) sampling.push(p.scheduler ? `${p.sampler}/${p.scheduler}` : p.sampler);
  if (typeof p.steps === 'number') sampling.push(`${p.steps} steps`);
  if (typeof p.cfg === 'number') sampling.push(`CFG ${round(p.cfg)}`);
  if (typeof p.cfgRescale === 'number' && p.cfgRescale > 0) sampling.push(`CFG-Rescale ${round(p.cfgRescale)}`);
  if (p.noiseSchedule) sampling.push(`Noise schedule ${p.noiseSchedule}`);
  if (p.varietyBoost) sampling.push('Variety Boost');
  if (typeof p.guidance === 'number') sampling.push(`Guidance ${round(p.guidance)}`);
  if (typeof p.shift === 'number') sampling.push(`Shift ${round(p.shift)}`);
  if (sampling.length) lines.push(`Sampling: ${sampling.join(' · ')}`);

  return lines.join('\n');
}
