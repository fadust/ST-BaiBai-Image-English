/**
 * Thin wrapper + types for SillyTavern's getContext().
 * The whole extension touches the host only through here: stable and single-point.
 * At runtime getContext hangs off window.SillyTavern (ST's stable extension API).
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  swipes?: string[];
  swipe_info?: Array<{ extra?: Record<string, unknown> }>;
  swipe_id?: number;
  send_date?: string;
  extra?: Record<string, unknown>;
}

/**
 * Whether a message is a "story message": everything except ST's true system messages, **including normal floors hidden with /hide**.
 *
 * The criterion is extra.type alone: ST only stamps it on true system messages such as narrator/comment/sys
 * (system-messages.js, /role system in slash-commands.js), while /hide only flips is_system
 * and never touches extra (hideChatMessageRange in chats.js). So hidden normal floors are true here:
 * hiding means "not sent in the prompt", not "not story", and ST itself agrees: messageFormatting
 * has `// Let hidden messages have markdown` for hidden floors, forcing isSystem back to false
 * so they still get markdown and regexes (our anchor regex only works on hidden floors because of this).
 *
 * **There is only this one copy**: floor-button visibility, the auto-tag target gate and history-context selection all share it.
 * Writing one each produced a real bug: the old actionButton read the DOM's is_system attribute directly,
 * so hidden floors never got a button while the runner actually let them through; users saw "some floors have no button".
 */
export function isStoryMessage(message: STMessage | undefined): message is STMessage {
  if (!message || typeof message.mes !== 'string' || !message.mes.trim()) return false;
  return !(message.is_system && typeof message.extra?.type === 'string');
}

/** AI floors among story messages (user floors excluded). The target-floor criterion for floor buttons and auto-tag. */
export function isAiStoryMessage(message: STMessage | undefined): message is STMessage {
  return isStoryMessage(message) && !message.is_user;
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  CHAT_CHANGED: string;
  MESSAGE_EDITED: string;
  MESSAGE_UPDATED: string;
  MESSAGE_SWIPED: string;
  MESSAGE_DELETED: string;
  [k: string]: string;
}

/** Character card (very few fields used; avatar is the stable unique key, name may be duplicated) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  characters?: STCharacter[];
  /** Index of the current character in characters (string/number); empty in group chats */
  characterId?: string | number;
  /** Current group id; empty outside group chats */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveChat: () => Promise<void>;
  reloadCurrentChat?: () => Promise<void>;
  updateMessageBlock?: (
    messageId: number,
    message: STMessage,
    options?: { rerenderMessage?: boolean },
  ) => unknown;
  /** Global extension settings object (= extension_settings, written to the server's settings.json, synced across devices). Stable ST API. */
  extensionSettings?: Record<string, unknown>;
  /** Debounced save of global settings (writes extensionSettings to the server too). Stable ST API. */
  saveSettingsDebounced?: () => void;
  /**
   * Sends a one-off completion with the "current main API" (the chat/text completion settings in use on the main screen). From script.js, stable ST API.
   * When prompt is a message array, only those messages are sent, without chat history/character card; api defaults to main_api (the user's current main API).
   * Internally uses sendOpenAIRequest('quiet', …); quiet forces non-streaming and returns the whole cleaned text.
   */
  generateRaw?: (params: {
    prompt: Array<{ role: string; content: string }> | string;
    api?: string | null;
    systemPrompt?: string;
    responseLength?: number | null;
    prefill?: string;
    jsonSchema?: unknown;
  }) => Promise<string>;
  /** Expands macros such as {{char}}/{{user}}. Character card fields may contain macros, so they are restored with it. Stable ST API. */
  substituteParams?: (content: string) => string;
  /**
   * Counts tokens with the current tokenizer. Stable ST API (tokenizers.js).
   * [Caveat] It uses the tokenizer of **the main screen's current API/model**, which may not match the secondary API channel's model,
   * so the result is only an estimate (marked with ≈ in the UI) and must not be confused with the real usage returned upstream.
   */
  getTokenCountAsync?: (str: string, padding?: number) => Promise<number>;
  /**
   * Activates lorebook entries from text (keyword triggers + constant entries). Stable ST API (world-info.js).
   * chat is the array of texts to scan (oldest to newest); isDryRun=true only scans, without firing side-effect events.
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** @depth entries: {depth, role, entries: string[]}. Many blue-light (constant) entries are here */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** Before/after author's note entries (array of content strings) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** File names of all loaded lorebooks (global + character-bound). Stable ST API. */
  getWorldInfoNames?: () => string[];
  /** Maximum tokens of the main context (budget parameter for getWorldInfoPrompt) */
  maxContext?: number;
  // Compatibility with old-style naming
  event_types?: STEventTypes;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
}

/** One activated lorebook entry (an entry object returned by checkWorldInfo; only the fields used for rendering/joining). */
export interface WorldInfoEntry {
  /** Lorebook file it belongs to */
  world?: string;
  /** Entry memo/title */
  comment?: string;
  /** Entry content */
  content?: string;
  [k: string]: unknown;
}

/** Return structure of checkWorldInfo (only the fields we use are declared). */
interface CheckWorldInfoResult {
  /** All activated entries (scanning/recursion/budget done; the final set that belongs in the prompt) */
  allActivatedEntries?: Set<WorldInfoEntry> | Map<string, WorldInfoEntry>;
  [k: string]: unknown;
}

type CheckWorldInfoFn = (
  chat: string[],
  maxContext: number,
  isDryRun: boolean,
  globalScanData?: Record<string, unknown>,
) => Promise<CheckWorldInfoResult>;

/**
 * Gets ST's checkWorldInfo (not exposed by getContext; loaded dynamically from /scripts/world-info.js).
 * Unlike getWorldInfoPrompt, it returns **a collection of entry objects** (with world/comment/content),
 * which allows rendering entry by entry; getWorldInfoPrompt only emits a pre-joined string and loses all metadata.
 * Returns null when unavailable (old versions/path changes), so the caller falls back to getWorldInfoPrompt.
 */
export async function getCheckWorldInfo(): Promise<CheckWorldInfoFn | null> {
  try {
    // The path is held in a variable so Vite/vue-tsc don't resolve it as a local module
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    const fn = mod.checkWorldInfo;
    return typeof fn === 'function' ? (fn as CheckWorldInfoFn) : null;
  } catch {
    return null;
  }
}

/**
 * The executor interface ST-Prompt-Template (the prompt template plugin) puts on globalThis (see its exports.ts).
 * Only prepareContext + evalTemplate are used: the former prepares an env with variable/lorebook context,
 * the latter runs EJS on text containing <% %>. This lets the lorebook seen by the secondary API be the "executed" result rather than the raw text.
 * When the plugin isn't installed, globalThis.EjsTemplate is undefined and the caller degrades accordingly.
 */
export interface EjsTemplateApi {
  prepareContext: (context?: Record<string, unknown>, end?: number) => Promise<Record<string, unknown>>;
  evalTemplate: (
    code: string,
    context?: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
}

/** Gets the template executor exposed by ST-Prompt-Template; null when not installed/incomplete (the caller degrades to not running EJS). */
export function getEjsTemplate(): EjsTemplateApi | null {
  const api = (globalThis as { EjsTemplate?: Partial<EjsTemplateApi> }).EjsTemplate;
  if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') {
    return api as EjsTemplateApi;
  }
  return null;
}

interface SillyTavernGlobal {
  getContext?: () => STContext;
}

/** Gets the ST context; null when ST isn't ready yet (the caller polls/defers). */
export function getContext(): STContext | null {
  try {
    const st = (window as unknown as { SillyTavern?: SillyTavernGlobal }).SillyTavern;
    return st?.getContext?.() ?? null;
  } catch {
    return null;
  }
}
