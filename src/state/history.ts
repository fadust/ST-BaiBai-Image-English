import { reactive } from 'vue';

import type { ChatMsg } from '@/api/client';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';

/**
 * Module-level in-memory store of request history (secondary API inference + image generation).
 *
 * **Deliberately not persisted**: cleared on page reload; not in settings, not in localStorage.
 * It is a debugging aid, for looking back at what this round sent and received when something goes wrong, not an asset to keep long-term.
 * To keep evidence, copy it out from the page.
 *
 * Why module-level rather than in a component: requests are started by autoTag/Card and others, and the history page may never have been opened;
 * records must outlive every component. Same shape as floor/genState.ts.
 *
 * [Important] Every write function in this module must be "never throws": callers are on real business paths
 * (sending requests, generating images), and a history failure must never drag down the main flow. So record() swallows exceptions internally,
 * and callers should still wrap with safe*() (see usage in api/client.ts).
 */

/** Record cap. Secondary API prompts are large (lorebook + character library + story text); uncapped, a few dozen records means dozens of MB. */
const MAX_RECORDS = 50;

/**
 * Per-record text cap. Longer text is truncated with the original length noted:
 * the system prompt built by buildAutoTagMessages easily exceeds ten thousand characters, and keeping 50 in full is too much memory.
 */
const MAX_CONTENT = 20_000;

export type HistoryKind = 'llm' | 'image';

/** running = in progress; aborted = user cancelled (separate from error; not a fault). */
export type HistoryStatus = 'running' | 'ok' | 'error' | 'aborted';

interface BaseRecord {
  /** Incrementing sequence number, **not Date.now()**: several concurrent requests within the same millisecond would collide on one id. */
  id: number;
  kind: HistoryKind;
  status: HistoryStatus;
  startedAt: number;
  /** Only present once finished; null while running. */
  durationMs: number | null;
  /** Error message when status='error'; empty string otherwise. */
  error: string;
}

export interface LlmRecord extends BaseRecord {
  kind: 'llm';
  /** Purpose label such as 'Auto tag' / 'Character appearance transformation' / 'ComfyUI workflow configuration', passed in by the call site. */
  source: string;
  /** Channel name; FOLLOW_MAIN_API when no channel is assigned (following the main API). */
  channelName: string;
  model: string;
  stream: boolean;
  /** Full prompt (truncated per MAX_CONTENT). */
  messages: ChatMsg[];
  /** Returned text (truncated). */
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * Whether the token count is a local estimate.
   * Real values are only available with "own channel + non-streaming" (the ST proxy passes upstream usage through unchanged);
   * streaming and following the main API can only estimate with ST's tokenizer, which is the tokenizer of **the main screen's current model**,
   * not necessarily the same as the secondary API channel's model. So the UI must distinguish it with ≈ and never mix it with real values.
   */
  tokensEstimated: boolean;
}

export interface ImageRecord extends BaseRecord {
  kind: 'image';
  backend: 'nai' | 'comfyui';
  /** NAI model name / current ComfyUI workflow preset name. */
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  /** Floor coordinates: the details use them to point back to which floor and slot. The image itself is not stored (see the file header). */
  floor: number;
  seq: number;
}

export type HistoryRecord = LlmRecord | ImageRecord;

/** Channel-name placeholder when following the main API. */
export const FOLLOW_MAIN_API = 'Follow main API';

/**
 * All records, **newest first** (the page uses v-for directly without reversing each time).
 * So "drop the oldest" = pop from the end.
 */
export const records = reactive<HistoryRecord[]>([]);

let nextId = 1;

/** Truncates overly long text and notes its original length; short text is returned as-is (no new string). */
export function truncate(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_CONTENT) return text;
  return `${text.slice(0, MAX_CONTENT)}\n…(truncated, original length ${text.length} characters)`;
}

/** CJK ideographs/kana/hangul/full-width punctuation: roughly 1 character = 1 token for these. */
const CJK_PATTERN =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/**
 * Rough token estimate for one text segment (synchronous, purely local).
 *
 * Why not ST's getTokenCountAsync: that is async HTTP (hitting /api/tokenizers/…),
 * so expanding an 8-segment record would be 8 requests; and these numbers are only used for **comparing segments against each other**
 * ("which segment blew up the prompt"), so precision isn't needed.
 *
 * Rule: CJK at 1 character per token, everything else (Latin letters/digits/symbols) at 4 characters per token,
 * the usual rule of thumb for BPE tokenizers. **It will differ from real usage**, so the UI always shows it with ≈,
 * and the sum of segments shouldn't be compared with the real value on the title row (that is upstream usage, measured differently).
 */
export function roughTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  // for...of iterates by code point, so a surrogate pair (emoji/rare CJK character) counts as one character, not two
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return Math.round(cjk + rest / 4);
}

function truncateMessages(messages: ChatMsg[]): ChatMsg[] {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => ({ role: m.role, content: truncate(m.content) }));
}

/** Pushes one record and keeps the cap. New records go to the head; on overflow the tail (oldest) is dropped. */
function push(record: HistoryRecord): void {
  records.unshift(record);
  while (records.length > MAX_RECORDS) records.pop();
}

/**
 * Finds a record by id. undefined means it was pushed out by the cap:
 * if 50 new records arrive during a long request, it is gone, and finish/fail is then a safe no-op.
 */
function find(id: number): HistoryRecord | undefined {
  return records.find(r => r.id === id);
}

export interface LlmBegin {
  source: string;
  channelName: string;
  model: string;
  stream: boolean;
  messages: ChatMsg[];
}

/** Registers one secondary API request and returns an id for a later finish/fail. */
export function beginLlm(info: LlmBegin): number {
  const id = nextId++;
  push({
    id,
    kind: 'llm',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    source: info.source,
    channelName: info.channelName,
    model: info.model,
    stream: info.stream,
    messages: truncateMessages(info.messages),
    response: '',
    promptTokens: null,
    completionTokens: null,
    tokensEstimated: false,
  });
  return id;
}

export interface LlmFinish {
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensEstimated: boolean;
}

export function finishLlm(id: number, info: LlmFinish): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
  record.response = truncate(info.response);
  record.promptTokens = info.promptTokens;
  record.completionTokens = info.completionTokens;
  record.tokensEstimated = info.tokensEstimated;
}

/**
 * Request failed or was cancelled. aborted and error are separate: the former is a user cancel, not a fault,
 * so the UI uses a neutral colour, not red.
 */
export function failLlm(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** Late token estimate: when the request succeeded but the real value is unavailable, the estimate arrives after finishLlm. */
export function patchLlmTokens(id: number, promptTokens: number | null, completionTokens: number | null): void {
  const record = find(id);
  if (record?.kind !== 'llm') return;
  // Don't overwrite an existing real value (the non-streaming path got usage, so the estimate is void)
  if (!record.tokensEstimated && record.promptTokens !== null) return;
  record.promptTokens = promptTokens;
  record.completionTokens = completionTokens;
  record.tokensEstimated = true;
}

export interface ImageBegin {
  backend: 'nai' | 'comfyui';
  model: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
  floor: number;
  seq: number;
}

/** Registers one image request. Image results don't go into the store (data URLs would blow up memory, and the image is already saved into ST). */
export function beginImage(info: ImageBegin): number {
  const id = nextId++;
  push({
    id,
    kind: 'image',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    error: '',
    backend: info.backend,
    model: info.model,
    prompt: truncate(info.prompt),
    nl: truncate(info.nl),
    negative: truncate(info.negative),
    characters: info.characters.map(character => ({
      name: truncate(character.name),
      tag: truncate(character.tag),
      nl: truncate(character.nl),
    })),
    seed: info.seed,
    size: info.size,
    floor: info.floor,
    seq: info.seq,
  });
  return id;
}

export function finishImage(id: number): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = 'ok';
  record.durationMs = Date.now() - record.startedAt;
}

export function failImage(id: number, message: string, aborted = false): void {
  const record = find(id);
  if (record?.kind !== 'image') return;
  record.status = aborted ? 'aborted' : 'error';
  record.durationMs = Date.now() - record.startedAt;
  record.error = aborted ? '' : message;
}

/** Clears everything (the "Clear" button on the page). */
export function clearHistory(): void {
  records.splice(0, records.length);
}

/** For tests: resets to a clean state (including the id counter). */
export function resetHistory(): void {
  clearHistory();
  nextId = 1;
}

/** For tests: exposes the cap constant, so unit tests don't hardcode a number that drifts from the implementation. */
export const HISTORY_LIMITS = { MAX_RECORDS, MAX_CONTENT } as const;

/**
 * Shared wrapper for instrumentation calls: recording failures always degrade silently and **never throw upward**.
 *
 * History is a debugging aid, while every call site is on a real business path (sending requests, generating images);
 * letting recording logic break image or tag generation would put the cart before the horse. Every begin/finish/fail should go through here.
 */
export function safeHistory<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    console.debug('[BaiBai Image] Failed to request history (ignored)', e);
    return null;
  }
}
