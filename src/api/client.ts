import { getContext } from '@/st/context';
import type { ApiChannel } from '@/state/settings';
import {
  beginLlm,
  failLlm,
  finishLlm,
  patchLlmTokens,
  safeHistory,
  FOLLOW_MAIN_API,
} from '@/state/history';

/**
 * Calls any OpenAI-compatible endpoint through SillyTavern's server-side proxy.
 * (Same origin as BaiBai Book's src/api/client.ts; behaviour is kept identical.)
 *
 * Key point: uses chat_completion_source='openai' + reverse_proxy (base url) + proxy_password (key)
 * via /api/backends/chat-completions/generate. The ST server forwards the request,
 * so there is no browser CORS problem, and the key need not be stored in ST's secrets.
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Normalises an OpenAI-compatible base url:
 * - if the user entered the full /chat/completions, only the endpoint suffix is removed;
 * - a bare domain gets /v1 appended;
 * - addresses that already carry a path are kept as-is, so custom routes such as /v2/coding are not broken.
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** Fallback /v1 form when testing a channel. Only tried when the first address explicitly returns 404/405. */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * Purpose label, used only for display on the request history page (e.g. "Auto tag").
   * Omitting it doesn't affect the request itself; history shows it as "Unmarked".
   */
  source?: string;
  /**
   * Caller validation callback: runs after the text arrives and before it is recorded in history.
   *
   * In history, "success" means "the caller's validation passed", not "HTTP returned text";
   * otherwise "returned but the protocol failed to parse → caller retries" would leave two green success records,
   * and readers of the history would think a success was called twice. A validation throw = recorded as failed and the error rethrown as-is,
   * leaving the caller to decide whether to retry or give up.
   */
  validate?: (content: string) => void;
}

/* ============ Request history tracking (purely auxiliary; never allowed to affect the main flow) ============ */

/** Reads OpenAI-standard usage from the response body. ST's proxy passes the upstream JSON through unchanged on the non-streaming branch, so this is the real value. */
function readUsage(data: any): { prompt: number | null; completion: number | null } {
  const usage = data?.usage;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
  };
}

/**
 * Local token estimate (fallback when no real value is available): neither streaming nor "follow main API" has usage.
 *
 * Uses ST's getTokenCountAsync, but that uses the tokenizer of **the main screen's current model**,
 * which may not match the secondary API channel's model, so the result is only an estimate, marked with ≈ in the UI.
 * Any failure degrades to null (no number shown) without throwing.
 */
async function estimateTokens(id: number, messages: ChatMsg[], response: string): Promise<void> {
  try {
    const count = getContext()?.getTokenCountAsync;
    if (typeof count !== 'function') return;
    const promptText = messages.map(m => m.content).join('\n');
    const prompt = await count(promptText);
    const completion = response ? await count(response) : 0;
    safeHistory(() =>
      patchLlmTokens(
        id,
        typeof prompt === 'number' ? prompt : null,
        typeof completion === 'number' ? completion : null,
      ),
    );
  } catch (e) {
    console.debug('[BaiBai Image] token estimation failed (ignored)', e);
  }
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * Applies a timeout to the whole request lifecycle: not only the fetch connection, but also non-streaming JSON reading and streaming SSE reading.
 * The external signal can still cancel early; only when this timer fires is it turned into an explicit timeout error.
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label} timed out (>${timeoutSec} seconds)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Sends one completion request and returns the text content.
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * Builds the request body sent to the ST proxy (pure function, so both branches' output can be tested).
 *
 * Two branches, chosen by whether the channel sets a reasoning effort:
 *
 * ① Not set (reasoningEffort empty = auto): uses `chat_completion_source: 'openai'`,
 *    **byte-for-byte identical** to before this feature apart from the fixed `tool_choice` below, so existing users see no change.
 *
 * ② Set: uses `'custom'`. ST's proxy gates reasoning_effort on the openai source with a **model-name allowlist**
 *    (OPENAI_REASONING_EFFORT_MODELS in src/constants.js, exact matches for the o1/o3/gpt-5 family);
 *    a non-matching model name is silently dropped while still returning 200 (confirmed by testing), so users set it with no effect and can't tell.
 *    The custom source's custom_include_body is merged into the upstream body directly by the server's mergeObjectWithYaml,
 *    without any allowlist, so any field/nested object passes through.
 *
 * Both paths still go through ST's server-side forwarding (the same /generate endpoint), with no direct browser connection,
 * so CORS, keeping keys out of the browser, SSE forwarding and the like are completely unchanged.
 *
 * Two pitfalls of the custom source (both avoided):
 * - it **doesn't read proxy_password**, only ST's own stored Custom key, so the key must be injected as Authorization via
 *   custom_include_headers (the server's `...headers` comes after the default
 *   Authorization, so the override holds);
 * - custom_include_* are YAML strings and **parse failures are silently ignored** (the catch in util.js is empty).
 *   A key containing `:` `#` `{` or starting with `*` breaks YAML parsing → the header isn't injected →
 *   it falls back to ST's Custom key, possibly sending the user's key for another provider to this endpoint.
 *   So they are always generated with JSON.stringify (YAML is a superset of JSON), leaving escaping to it rather than hand-building them.
 *
 * Also: the body always carries `tool_choice: 'none'`, a declarative pass-through handshake for third-party fetch interceptors.
 * SillyTavern helper preset scripts (such as the Kemini Dramatron panel) may monkey-patch `window.parent.fetch`,
 * intercepting all `/api/backends/…/generate` requests and injecting synthetic tools + control messages so the model stuffs its whole output
 * into a tool call. For requests like image tags that need a strict JSON protocol, it inserts control messages into the conversation,
 * nudging the model to use tool calls instead of outputting JSON directly, slowing things several times or forcing retries.
 * Such interceptors commonly support "let it through if the caller brings its own tool_choice" (Dramatron's callerControlsTools
 * explicitly bypasses 'none'), so we declare up front that we don't use tools.
 * No upstream effect: the ST server only forwards tool_choice when tools is a non-empty array
 * (src/endpoints/backends/chat-completions.js), and this function never sends tools, so the field never reaches the provider.
 *
 * (Same origin as the function of the same name in BaiBai Book's src/api/client.ts; behaviour is kept identical.)
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // No tools: see the function header comment; stops third-party fetch interceptors from rewriting image tags into tool calls
    tool_choice: 'none',
    // Quiet: doesn't affect the main chat state
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // Excluded parameters: delete the user-specified fields from the body, avoiding errors from compatible endpoints that reject them.
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern context is not available');
  if (!channel.url || !channel.model) throw new ApiError('The secondary API channel is incomplete (missing url or model)');

  const stream = channel.stream ?? false;
  const body = buildRequestBody(channel, messages, reverseProxy, stream);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);

  // History tracking: registered before the request is actually sent, so failures/timeouts leave a trace too (the failed one is often exactly what you need to inspect).
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || 'Unmarked',
      channelName: channel.name || channel.model || '(Unnamed channel)',
      model: channel.model,
      stream,
      messages,
    }),
  );

  try {
    const result = await withTimeout(timeoutSec, opts.signal, 'Auxiliary API request', async signal => {
      const resp = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new ApiError(`Secondary API request failed (${resp.status}): ${text.slice(0, 300)}`, resp.status);
      }

      // Streaming: concatenate SSE increments; non-streaming: parse JSON directly.
      if (stream) {
        const streamed = await readSseContent(resp);
        if (!streamed) throw new ApiError('The secondary API returned no content');
        // Streaming has no usage: ST builds the upstream body from a field allowlist without stream_options,
        // so the upstream can't be asked to send a usage chunk at the end. Only a local estimate afterwards is possible.
        return { content: streamed, usage: { prompt: null, completion: null } };
      }

      const data = await resp.json();
      if (data?.error) {
        throw new ApiError(data.error.message || 'The secondary API returned an error');
      }

      const parsed = extractContent(data);
      if (!parsed) throw new ApiError('The secondary API returned no content');
      // ST's proxy non-streaming branch passes through with response.send(json), so usage is the real upstream value.
      return { content: parsed, usage: readUsage(data) };
    });

    // Validation comes before recording history: a failed validation → falls into catch and is recorded as a failure, never giving the false impression of "HTTP success"
    opts.validate?.(result.content);

    if (historyId !== null) {
      const hasReal = result.usage.prompt !== null;
      safeHistory(() =>
        finishLlm(historyId, {
          response: result.content,
          promptTokens: result.usage.prompt,
          completionTokens: result.usage.completion,
          tokensEstimated: false,
        }),
      );
      // Only estimate when there is no real value (streaming). The estimate is async and not awaited, so it can't slow the main flow.
      if (!hasReal) void estimateTokens(historyId, messages, result.content);
    }
    return result.content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/**
 * Reads an SSE stream (text/event-stream) and concatenates delta.content.
 * With stream=true, ST's generate endpoint passes the upstream SSE through: each line is `data: {json}`, ending with `data: [DONE]`.
 * Reasoning-model thought increments (delta.reasoning etc.) are buffered separately and only used as a fallback when content is entirely empty,
 * avoiding mixing the thought chain into the text when content is normal.
 */
export async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // Can't read as a stream (shouldn't happen): fall back to treating it as a whole JSON
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let reasoningOut = '';
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Parse line by line, keeping the last incomplete line for next time
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || 'The secondary API returned an error');
        const choice = json?.choices?.[0];
        const src = choice?.delta ?? choice?.message;
        const piece = textOf(src?.content) || textOf(choice?.text);
        if (piece) out += piece;
        const reasoningPiece =
          textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
        if (reasoningPiece) reasoningOut += reasoningPiece;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // Ignore lines that fail to parse (may be comment lines/heartbeats)
      }
    }
  }
  return out.trim() || reasoningOut.trim();
}

/** Converts a value that may be a string / content-parts array / other type into text; non-string parts are always dropped. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

/**
 * Extracts the answer text from the response body.
 * Standard chain: message.content / choices[0].text / data.content;
 * reasoning models (such as deepseek-v4-flash) may put the whole answer (thought chain + final JSON) into
 * reasoning / reasoning_content / thinking with content empty; when the whole standard chain is empty it falls back to those,
 * and the mixed-in thought chain is naturally stripped by parseImagePlan's JSON block scan.
 */
export function extractContent(data: any): string {
  const msg = data?.choices?.[0]?.message;
  const content =
    textOf(msg?.content) || textOf(data?.choices?.[0]?.text) || textOf(data?.content);
  if (content.trim()) return content.trim();
  return (
    textOf(msg?.reasoning) || textOf(msg?.reasoning_content) || textOf(msg?.thinking)
  ).trim();
}

/* ============ Follow main API (the API settings currently in use on the main screen) ============ */

/** Response limit when following the main API: enough for the thought chain + output, avoiding truncation by the main API's default max tokens. */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * Whether "follow main API" is possible: it is enough that ST exposes generateRaw (stable API).
 * No longer depends on connection management/connection profiles; it simply borrows the API currently in use on the main screen.
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * Sends one completion with the "current main API" (the chat/text completion settings in use on the main screen).
 * Uses ST's generateRaw: sends only the messages we give, without chat history/character card; no connection profile needed.
 * The quiet type forces non-streaming internally and returns the whole cleaned text; failures throw ApiError.
 *
 * ⚠️ On this path ST builds the request body, so `tool_choice: 'none'` can't be included, and third-party fetch interceptors
 * (such as Kemini's anti-truncation script) may still rewrite it. For tag generation, prefer assigning a secondary API channel, which uses buildRequestBody.
 */
export async function requestViaMainApi(messages: ChatMsg[], opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('This ST version lacks generateRaw, so it cannot follow the main API');
  }

  // History tracking. Following the main API goes through ST's internal black box with no usage available, so tokens are always estimated.
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || 'Unmarked',
      channelName: FOLLOW_MAIN_API,
      model: '',
      stream: false,
      messages,
    }),
  );

  try {
    const content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
    if (!content) throw new ApiError('The main API returned no content');
    // Same rule as the secondary API: a failed validation is recorded as a failure, not a "success"
    opts.validate?.(content);
    if (historyId !== null) {
      safeHistory(() =>
        finishLlm(historyId, {
          response: content,
          promptTokens: null,
          completionTokens: null,
          tokensEstimated: true,
        }),
      );
      void estimateTokens(historyId, messages, content);
    }
    return content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/** Connectivity test: sends a very short request */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: 'Reply with exactly "ok".' }],
      primaryUrl,
      { source: 'Connectivity test' },
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `Connection successful${changed ? `, using: ${primaryUrl}` : ''}, response: ${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: 'Reply with exactly "ok".' }],
        fallbackUrl,
        { source: 'Connectivity test (alternate address)' },
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `Connection successful; automatically switched to: ${fallbackUrl}, response: ${reply.slice(0, 40)}`,
      };
    } catch {
      // If the fallback address fails too, keep the first error, so real problems such as the model name aren't disguised as path errors.
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * Fetches the channel's available model list (via ST's /status proxy, standard /v1/models).
 * Only needs url + key; model doesn't have to be filled in first.
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern context is not available');
  if (!channel.url) throw new ApiError('Enter the API URL first');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, 'Fetch models', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`Failed to fetch models (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || 'Failed to fetch models');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
