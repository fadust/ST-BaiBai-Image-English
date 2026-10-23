import type { Orientation } from '@/backends/size';
import type { BackendId } from '@/state/settings';
import type { CharTagField } from '@/state/charTags';

/**
 * Data structures (DTOs) of the BaiBai Image public API. **The contract surface for third-party plugins.**
 *
 * Rules (same as BaiBai Book's src/public/types.ts, so third-party authors learn one set):
 * - apiVersion is independent of pluginVersion: the former is the version of **the structures in this file**; the plugin version goes up all the time,
 *   apiVersion doesn't. Third parties judge compatibility by apiVersion and should not parse pluginVersion's meaning.
 * - Add only; never change or delete: adding optional fields is safe; changing a field's meaning / deleting a field always bumps apiVersion.
 *   So this file deliberately **does not expose** every field of the internal types; once exposed, it can never be taken back
 *   (e.g. CharTagEntry.history holds 50 change records that third parties have no use for, so it's withheld for now).
 * - Always **plain cloneable objects**: no functions, no Vue reactive proxies, no class instances.
 *   instanceof never works across plugin bundle boundaries, so errors also use a code field rather than custom Error subclasses.
 */

export const PUBLIC_API_VERSION = 1 as const;

export interface PublicCapabilities {
  /** globalThis.STBaiBaiImage is available. */
  globalApi: true;
  /** Can read the character library (getCharacters). */
  characterLibrary: true;
  /** Can call image generation (generate). */
  generate: true;
  /** Generated images can be saved into the BaiBai Image gallery (generate's save option). */
  saveToGallery: true;
  /** ready/changed events are available. */
  events: true;
}

/** A character's appearance fields. Keys map one-to-one to the "Character library" on the BaiBai Image settings page. */
export type PublicCharacterFields = Record<CharTagField, string>;

export interface PublicCharacter {
  /** Character name. **Verbatim**, never transliterated or normalised (image tags and story text are aligned by it). */
  name: string;
  /**
   * Complete tag string usable directly for image generation.
   * Built from fields in a fixed order (fandom identity → sex → hair → eyes → skin → body → signature features → outfit);
   * for old entries with only a whole raw string, it is raw itself. **Use this directly**; don't assemble fields yourself.
   */
  tag: string;
  /** Appearance split by field (only needed if you want to pick and choose). */
  fields: PublicCharacterFields;
  /** Natural-language appearance description (may be empty). */
  nl: string;
  /**
   * Where this profile came from:
   * - 'manual' written / edited by the user
   * - 'ai'     created or changed by the AI during the story
   * - 'book'   synced from BaiBai Book's character memory
   */
  source: 'book' | 'manual' | 'ai';
  /**
   * Scope:
   * - 'global' global character library (across chats, maintained only by the user by hand; the AI can't change it)
   * - 'chat'   this chat's profile (manual baseline + replay of the AI's changes on floors)
   */
  scope: 'global' | 'chat';
  /** The "why it looks like this" sentence from profile creation (usually an empty string). */
  desc: string;
}

export interface GetCharactersOptions {
  /**
   * Gets a character-library snapshot "before floor number floor" (ST's zero-based mesid, excluding that floor).
   *
   * Why you'd need it: profiles evolve with the story (the AI changed a character's hair colour on some floor); to generate an image
   * for **a past floor** you need the profile as it was then; using the current library would draw later changes too.
   * Omitted = the current library (all floors replayed).
   */
  floor?: number;
}

export interface PublicCharacterList {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /** Increments on every character-library change; use it for cache invalidation. */
  revision: number;
  /** Floor the snapshot belongs to (null = current when floor is omitted). */
  floor: number | null;
  characters: PublicCharacter[];
}

export interface PublicBackendStatus {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /** Image backend the user currently selected. */
  backend: BackendId;
  /** Whether the backend is fully configured and can generate. When false, generate throws code='not_configured'. */
  configured: boolean;
  /** Model name for NAI; current workflow preset name for ComfyUI. **Never includes the server address or API key.** */
  model: string;
  /**
   * Whether the current backend supports characters (multi-character prompts).
   * true for NAI 4.5/V5; **always false for ComfyUI**: passed values are silently dropped,
   * so check here before drawing several characters rather than finding out after generation.
   */
  supportsCharacters: boolean;
  /** Human-readable reason when configured=false (can be shown to the user directly); empty string when ready. */
  reason: string;
}

/** One character in a multi-character prompt (NAI 4.5/V5 Character Prompt). */
export interface PublicCharacterPrompt {
  /** Character name, for identification only; not part of the prompt. */
  name: string;
  /** This character's tags (usually PublicCharacter.tag). */
  tag: string;
  /** This character's natural-language description (may be empty). */
  nl?: string;
}

export interface GenerateRequest {
  /** Positive short danbooru tags. **Required and must not be empty** (an empty string throws code='invalid_args'). */
  prompt: string;
  /** Natural-language description (may be empty). */
  nl?: string;
  /**
   * Dynamic negative for this image (may be empty).
   * Only applies to ComfyUI (filled into the workflow's %negative_prompt%); NAI takes its negative from the user's channel config.
   */
  negative?: string;
  /**
   * Multi-character prompts. Only take effect when supportsCharacters is true;
   * charactersApplied in the result says plainly whether they were actually used this time.
   */
  characters?: PublicCharacterPrompt[];
  /** Frame orientation; defaults to 'portrait'. Exact pixels come from the portrait/landscape sizes the user set on the channel page. */
  size?: Orientation;
  /** Explicit seed (positive integer). Omitted = decided by user settings (the NAI panel's fixed seed, otherwise random). */
  seed?: number;
  /**
   * Save into the BaiBai Image gallery, **default true**.
   *
   * true: the image is stored in user/images/柏宝绘_<character>/ with a sidecar json, so
   *       the user can see it grouped by character on the BaiBai Image gallery page, together with its prompt.
   * false: only returns dataUrl and never touches disk, suited to "preview and discard" use.
   *
   * ⚠ Saving **does not write chat history**: the image appears in no floor's text and takes no floor card.
   *   Where the image shows is up to you; that is exactly why this API exists.
   */
  save?: boolean;
  /**
   * Which character name to save under (the gallery's group name, i.e. folder 柏宝绘_<character>).
   * Omitted = the current chat's character name. Meaningless when save=false.
   */
  character?: string;
}

export interface GenerateOptions {
  /** Cancels this generation. Throws code='aborted' when cancelled. */
  signal?: AbortSignal;
  /** Progress callback (optional). An error thrown by any callback is only logged to the console and doesn't affect generation. */
  onProgress?: (progress: PublicGenerateProgress) => void;
}

export interface PublicGenerateProgress {
  /**
   * - 'queued'     queued in BaiBai Image's NAI concurrency gate (waiting for another request to free a slot)
   * - 'generating' request sent; the backend is drawing
   * - 'queued-remote' in the ComfyUI **server** queue (ahead = how many are in front)
   * - 'retrying'   rate-limited; backing off and retrying (attempt/max)
   * - 'saving'     image received; saving to disk
   */
  phase: 'queued' | 'generating' | 'queued-remote' | 'retrying' | 'saving';
  /** How many are ahead when phase='queued-remote'; null if unknown. */
  ahead?: number | null;
  /** Attempt number / total when phase='retrying'. */
  attempt?: number;
  max?: number;
}

export interface GenerateResult {
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  /**
   * Image data URL (like data:image/png;base64,…), usable directly as <img src>.
   *
   * A data URL rather than a blob URL on purpose: blobs need a matching revokeObjectURL;
   * forgetting leaks, and revoking on your behalf would blank your <img> suddenly. Data URLs have none of these pitfalls;
   * the cost is a large string, so don't keep it in memory long-term.
   */
  dataUrl: string;
  /** Image format, such as 'png' / 'jpg'. */
  format: string;
  /**
   * ST static path after saving (like /user/images/柏宝绘_小雪/bbi_….png), usable directly as <img src>.
   * null when save=false or saving failed. **A failed save does not throw**: the image is already in dataUrl,
   * and failing to store it in the gallery must not cost you the image itself.
   */
  path: string | null;
  /** The seed actually used (given even when random; to reproduce, pass it back as seed). */
  seed: number;
  /** Backend that actually generated the image. */
  backend: BackendId;
  /**
   * Whether characters was actually sent to the backend.
   * You passed characters but this is false = they were dropped (usually because the user is on ComfyUI).
   * BaiBai Image **deliberately does not degrade by merging characters into the prompt**: that draws images with several overlapping torsos.
   */
  charactersApplied: boolean;
}

/**
 * The code attached to the Error thrown on failure. **Branch on code; don't match the message text**
 * (message is human-readable text that changes between versions; and don't use instanceof, which never works across bundles).
 */
export type PublicErrorCode =
  /** User cancelled (the signal you passed fired). */
  | 'aborted'
  /** The user hasn't configured an image backend yet; the reason is in getBackendStatus(). */
  | 'not_configured'
  /** Invalid arguments (empty prompt, seed not a number, and so on). */
  | 'invalid_args'
  /** Rate-limited by the backend, and BaiBai Image's automatic backoff retries are exhausted. */
  | 'rate_limited'
  /** Backend error (network down, workflow problems, invalid API key…). */
  | 'backend_error';

/** An Error with code attached. Check with `'code' in error`, not instanceof. */
export interface PublicError extends Error {
  code: PublicErrorCode;
}

export interface PublicChangeNotice {
  type: 'ready' | 'changed';
  apiVersion: typeof PUBLIC_API_VERSION;
  pluginVersion: string;
  revision: number;
  chatId: string | null;
  capabilities: PublicCapabilities;
}

export type PublicChangeListener = (notice: PublicChangeNotice) => void;

export interface STBaiBaiImageApi {
  /** Version of this API's data structures. Third parties judge compatibility by it (currently always 1). */
  readonly apiVersion: typeof PUBLIC_API_VERSION;
  /** BaiBai Image plugin version (for display/debugging only; don't parse it for compatibility decisions). */
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  /** Gets the character list BaiBai Image has recorded (including tags ready for generation). Returns a deep copy; changing it doesn't affect BaiBai Image. */
  getCharacters(options?: GetCharactersOptions): PublicCharacterList;
  /** Ask before generating: is the backend configured, does it support multiple characters. */
  getBackendStatus(): PublicBackendStatus;
  /** Calls BaiBai Image to generate an image. The image is returned to you; where it shows is up to you. */
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>;
  /** Subscribes to character-library changes; returns an unsubscribe function. */
  subscribe(listener: PublicChangeListener): () => void;
}
