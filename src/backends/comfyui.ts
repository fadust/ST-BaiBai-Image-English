import { buildSimpleWorkflow } from '@/backends/comfyTemplates';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';
import { type ComfyRunConn } from '@/state/settings';

type JsonObject = Record<string, unknown>;
export type ComfyWorkflow = Record<string, JsonObject>;

export interface ComfyTemplateValues {
  prompt: string;
  negative_prompt?: string;
  seed?: number;
  /** Natural-language part; only written into workflows that explicitly contain %nl%, never merged into %prompt% automatically. Where one input holds both, the nl replaces the tags. */
  nl?: string;
  /** Image width/height; only written into workflows that explicitly contain %width%/%height%; otherwise the sizes hard-coded in the workflow apply. */
  width?: number;
  height?: number;
  /** Frame orientation; generateComfyImage resolves width/height from the channel config with it. */
  size?: Orientation;
}

export interface ComfyImageResult {
  url: string;
  filename: string;
  format: string;
  /** Frees resources when the direct browser connection uses an object URL; data URLs need no freeing. */
  revoke(): void;
}

const SUPPORTED_PLACEHOLDERS = new Set(['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height']);
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;
const SERVER_BASE = '/api/sd/comfy';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Generates a random seed (0 ≤ seed < 2^53, the same range as Python random.randint(0, 2**53 - 1)).
 * It must be generated and passed explicitly when generation starts: some nodes (such as certain sampler wrappers) do not accept -1 for auto-random.
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 53);
}

export class ComfyUIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parses and does minimal structural validation of an API workflow. */
export function parseWorkflowTemplate(template: string): ComfyWorkflow {
  if (!template.trim()) throw new ComfyUIError('Paste a ComfyUI API-format workflow first');

  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Common typo: a placeholder written as a bare value (seed: %seed%); in JSON it must be a string ("%seed%")
    const hint = detail.includes('%')
      ? '; placeholders must be written as strings, e.g. "seed": "%seed%" (with quotes)'
      : '';
    throw new ComfyUIError(`Workflow JSON format error: ${detail}${hint}`);
  }

  if (!isObject(parsed) || Object.keys(parsed).length === 0) {
    throw new ComfyUIError('Workflow must be a non-null JSON object');
  }

  const hasApiNode = Object.values(parsed).some(
    node => isObject(node) && typeof node.class_type === 'string' && isObject(node.inputs),
  );
  if (!hasApiNode) {
    throw new ComfyUIError('No API-format nodes found; export with "Save (API Format)" in ComfyUI');
  }

  return parsed as ComfyWorkflow;
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPlaceholders(item, found));
    return;
  }
  if (isObject(value)) Object.values(value).forEach(item => collectPlaceholders(item, found));
}

export function getWorkflowPlaceholders(template: string): string[] {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);
  return [...found].sort();
}

function replacePlaceholders(value: unknown, replacements: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^%([a-z][a-z0-9_]*)%$/);
    if (exact && Object.hasOwn(replacements, exact[1])) return replacements[exact[1]];

    return value.replace(PLACEHOLDER_PATTERN, (marker, name: string) =>
      Object.hasOwn(replacements, name) ? String(replacements[name]) : marker,
    );
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, replacements));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, replacements)]));
  }
  return value;
}

/**
 * When one text input holds both %prompt% and %nl% and an nl exists, that input gets the nl alone, as simple mode does.
 * Tags placed before prose prime a natural-language encoder: "1girl 1boy" reads as a young girl and boy and outweighs the ages the nl states.
 * Separate inputs are untouched, so a workflow that sends tags and prose to different encoders still gets both.
 */
function dropTagsBesideNl(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('%prompt%') || !value.includes('%nl%')) return value;
    return value
      .replace(/(,\s*)?%prompt%(\s*,\s*)?/g, (_m, before?: string, after?: string) => (before && after ? ', ' : ''))
      .replace(/^\s+/, '');
  }
  if (Array.isArray(value)) return value.map(dropTagsBesideNl);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dropTagsBesideNl(item)]));
  return value;
}

/**
 * Renders a template into a submittable workflow. Parses first, then replaces recursively, so quotes and newlines in prompts can't break the JSON;
 * strings exactly equal to %seed% / %width% / %height% are replaced with numbers, not strings
 * (EmptyLatentImage's width/height must be numbers).
 *
 * Frame size is opt-in: a workflow without %width%/%height% is completely unaffected and the workflow decides its own size;
 * only when they are present but no valid size is available does it error, pointing to the panel to fill in the config; silently generating with defaults would make users think the setting worked.
 */
export function renderWorkflowTemplate(template: string, values: ComfyTemplateValues): ComfyWorkflow {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);

  const unsupported = [...found].filter(name => !SUPPORTED_PLACEHOLDERS.has(name));
  if (unsupported.length) throw new ComfyUIError(`The workflow contains placeholders that are not supported yet: ${unsupported.map(x => `%${x}%`).join(', ')}`);
  if (!found.has('prompt') && !found.has('nl')) throw new ComfyUIError('%prompt% or %nl% placeholder missing from workflow');

  const needsSize = found.has('width') || found.has('height');
  if (needsSize && !(values.width && values.height)) {
    throw new ComfyUIError('The workflow uses %width%/%height%. Fill in the portrait and landscape sizes (e.g. 832×1216) on the ComfyUI channel page first.');
  }

  const seed = values.seed ?? randomSeed();
  const nlText = values.nl?.trim() ?? '';
  return replacePlaceholders(nlText ? dropTagsBesideNl(workflow) : workflow, {
    prompt: values.prompt,
    negative_prompt: values.negative_prompt ?? '',
    nl: values.nl?.trim() || (!found.has('prompt') ? values.prompt : ''),
    width: values.width ?? 0,
    height: values.height ?? 0,
    seed,
  }) as ComfyWorkflow;
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`, response.status);
}

/**
 * Automatic request-channel selection. Strategy:
 * 1. direct browser connection first (lowest latency, does not load the ST server);
 * 2. only on a network-level failure where the request "never reached the backend" (fetch TypeError: CORS block/connection refused/offline)
 *    fall back to forwarding via the ST backend;
 * 3. HTTP status errors are real server feedback and are not retried; forwarding would give the same result;
 * 4. user cancellation (AbortError) is always rethrown directly.
 * When both channels work, "prefer the direct connection" holds naturally: if direct succeeds, forwarding is never tried; no probing, no stale cache.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

function requireContext() {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern context is not available');
  return context;
}

export interface ComfyTestResult {
  /** The channel that actually connected: browser = direct browser connection; server = forwarded via the ST backend */
  mode: 'browser' | 'server';
}

export async function testComfyConnection(conn: ComfyRunConn, signal?: AbortSignal): Promise<ComfyTestResult> {
  if (!conn.url.trim()) throw new ComfyUIError('Enter the ComfyUI address first');

  // Direct browser connection first; only network-level failures (CORS/connection refused) fall back to forwarding via the ST backend
  try {
    const response = await fetch(endpoint(conn.url, 'system_stats'), { signal });
    if (!response.ok) throw await responseError(response, 'Browser connection failed ComfyUI');
    return { mode: 'browser' };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
  }

  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/ping`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({ url: conn.url.trim() }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ST backend connection ComfyUI failed');
  return { mode: 'server' };
}

interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

function findOutputFile(item: unknown): ComfyOutputFile | null {
  if (!isObject(item) || !isObject(item.outputs)) return null;
  for (const output of Object.values(item.outputs)) {
    if (!isObject(output)) continue;
    for (const key of ['images', 'gifs']) {
      const files = output[key];
      if (!Array.isArray(files)) continue;
      const file = files.find(x => isObject(x) && typeof x.filename === 'string');
      if (file) return file as unknown as ComfyOutputFile;
    }
  }
  return null;
}

function executionError(item: unknown): string | null {
  if (!isObject(item) || !isObject(item.status)) return null;
  if (item.status.status_str !== 'error') return null;
  const messages = item.status.messages;
  if (!Array.isArray(messages)) return 'ComfyUI Workflow execution failed';

  const details = messages
    .filter(message => Array.isArray(message) && message[0] === 'execution_error' && isObject(message[1]))
    .map(message => {
      const data = message[1] as JsonObject;
      return `${String(data.node_type ?? 'node')} [${String(data.node_id ?? '?')}]: ${String(data.exception_message ?? data.exception_type ?? 'Execution failed')}`;
    });
  return details.length ? details.join('\n') : 'ComfyUI Workflow execution failed';
}

function executionCompleted(item: unknown): boolean {
  return isObject(item) && isObject(item.status) && item.status.completed === true;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fileFormat(filename: string, mime = ''): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && /^[a-z0-9]+$/.test(extension)) return extension;
  return mime.split('/').pop()?.toLowerCase() || 'png';
}

async function generateViaServer(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<ComfyImageResult> {
  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/generate`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
      url: conn.url.trim(),
      prompt: JSON.stringify({ prompt: workflow }),
    }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ComfyUI Picture generation failed');

  const data = (await response.json()) as { format?: unknown; data?: unknown };
  if (typeof data.data !== 'string' || !data.data) throw new ComfyUIError('The ST backend returned no image data');
  const format = typeof data.format === 'string' && data.format ? data.format.toLowerCase() : 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${data.data}`,
    filename: `comfy-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

async function queueDirect(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<string> {
  const queued = await fetch(endpoint(conn.url, 'prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!queued.ok) throw await responseError(queued, 'ComfyUI rejected workflow');
  const queuedData = (await queued.json()) as { prompt_id?: unknown; node_errors?: unknown };
  if (typeof queuedData.prompt_id !== 'string' || !queuedData.prompt_id) {
    throw new ComfyUIError(`ComfyUI did not return prompt_id${queuedData.node_errors ? `: ${JSON.stringify(queuedData.node_errors).slice(0, 500)}` : ''}`);
  }
  return queuedData.prompt_id;
}

/** GET /queue entries have the shape [number, prompt_id, prompt, extra_data, outputs_to_execute]. */
type QueueEntry = [number, string, ...unknown[]];

interface QueuePosition {
  /** The task is running. */
  running: boolean;
  /** How many tasks are ahead; 0 when running; null when the task is no longer in the queue (finished/removed). */
  ahead: number | null;
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return Array.isArray(value) && typeof value[1] === 'string';
}

/**
 * Looks up the task's position in the ComfyUI server queue.
 * Anything unavailable or unparseable returns null: queue position is display-only and not worth interrupting generation (degrade first).
 *
 * "How many ahead" compares the priority number (entry index 0), not the array index:
 * queue_pending is a raw snapshot of a heap, so list order is not execution order.
 */
async function fetchQueuePosition(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
): Promise<QueuePosition | null> {
  try {
    const response = await fetch(endpoint(conn.url, 'queue'), { signal });
    if (!response.ok) return null;
    const data = (await response.json()) as JsonObject;
    // Both keys must be arrays for a valid snapshot (an empty array = the queue really is empty, which is valid information).
    // Wrong shape = untrustworthy response; treat as "position unknown", never as "task finished",
    // or cancelling would only send delete and miss interrupting the running task.
    if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) return null;
    const running = data.queue_running.filter(isQueueEntry);
    const pending = data.queue_pending.filter(isQueueEntry);

    if (running.some(entry => entry[1] === promptId)) return { running: true, ahead: 0 };
    const mine = pending.find(entry => entry[1] === promptId);
    if (!mine) return { running: false, ahead: null };
    // The running task counts as ahead too
    const ahead = pending.filter(entry => entry[0] < mine[0]).length + running.length;
    return { running: false, ahead };
  } catch {
    return null;
  }
}

/**
 * Cancels a queued task.
 *
 * Cases must be handled separately: ComfyUI's two endpoints each cover one stage, and using the wrong one can cancel someone else's task:
 * - task still queued → POST /queue {delete:[id]} removes it from the queue; `/interrupt` has no effect on it.
 * - task running → POST /interrupt to interrupt it, with prompt_id.
 * - queue position unknown (endpoint 502/parse failure, position=null): **send both**.
 *   A delete that finds nothing is a harmless no-op; interrupt carries prompt_id, which newer versions check, so only a task that really is running
 *   gets interrupted. Sending only delete would miss "running but position unknown" and burn GPU until it finishes.
 *
 * Conversely, a blind /interrupt without checking the queue: when generating concurrently, cancelling a task further back
 * would interrupt **another** task that is running (old versions ignore prompt_id in the body; it always happens).
 *
 * Residual race (known, acceptable): there is one round trip between checking the queue and sending interrupt, during which our task may just finish
 * and the next one start; then old ComfyUI (ignoring prompt_id) would hit the next task by mistake.
 * Sending prompt_id makes new versions immune; old versions can't be fixed from the client (there is no "interrupt by id" endpoint),
 * so interrupt is only sent once we've confirmed we are running, keeping the window as small as possible.
 */
async function cancelPrompt(conn: ComfyRunConn, promptId: string): Promise<void> {
  // No signal here: the caller's signal is the cancellation itself, and passing it would abort the cleanup request on the spot.
  const position = await fetchQueuePosition(conn, promptId);
  const post = (path: string, body: JsonObject) =>
    fetch(endpoint(conn.url, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    if (position?.running) {
      await post('interrupt', { prompt_id: promptId });
      return;
    }
    if (position) {
      // Position confirmed: queued (ahead>=0) or finished (ahead=null); either way removing from the queue is enough
      await post('queue', { delete: [promptId] });
      return;
    }
    // Position unknown: send both; whichever takes effect wins
    await Promise.allSettled([
      post('queue', { delete: [promptId] }),
      post('interrupt', { prompt_id: promptId }),
    ]);
  } catch {
    /* Cancelling is best-effort: on network failure let it run to completion; nobody receives the result */
  }
}

export interface ComfyProgressHooks {
  /** Queue position change: 0 = running, n>0 = n tasks ahead, null = unknown. */
  onQueue?(ahead: number | null): void;
}

async function pollDirectResult(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  const onAbort = () => {
    void cancelPrompt(conn, promptId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const startedAt = Date.now();
    let file: ComfyOutputFile | null = null;
    // Once we see ourselves running, stop polling the queue: position no longer matters, saving one request per round
    let watchQueue = !!hooks?.onQueue;
    while (!file) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new ComfyUIError('Timeout waiting for ComfyUI result (10 minutes)');
      const historyResponse = await fetch(endpoint(conn.url, `history/${encodeURIComponent(promptId)}`), { signal });
      if (!historyResponse.ok) throw await responseError(historyResponse, 'Failed to read ComfyUI task status');
      const history = (await historyResponse.json()) as JsonObject;
      const item = history[promptId];
      const error = executionError(item);
      if (error) throw new ComfyUIError(error);
      file = findOutputFile(item);
      if (!file && executionCompleted(item)) {
        throw new ComfyUIError('The workflow ran but produced no image; make sure it has a SaveImage or PreviewImage node');
      }
      if (file) break;
      if (watchQueue) {
        const position = await fetchQueuePosition(conn, promptId, signal);
        hooks?.onQueue?.(position?.ahead ?? null);
        if (position?.running || position?.ahead === null) watchQueue = false;
      }
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }

    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    const imageResponse = await fetch(`${endpoint(conn.url, 'view')}?${query}`, { signal });
    if (!imageResponse.ok) throw await responseError(imageResponse, 'Failed to read ComfyUI output image');
    const blob = await imageResponse.blob();
    const url = URL.createObjectURL(blob);
    return {
      url,
      filename: file.filename,
      format: fileFormat(file.filename, blob.type),
      revoke: () => URL.revokeObjectURL(url),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function generateComfyImage(
  conn: ComfyRunConn,
  values: ComfyTemplateValues,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  if (!conn.url.trim()) throw new ComfyUIError('Enter the ComfyUI address first');
  if (!values.prompt.trim()) throw new ComfyUIError('The positive prompt cannot be empty');
  // Take the size for the orientation from the channel config; if it can't be parsed pass empty, and renderWorkflowTemplate decides between an error and ignoring it
  // (when the workflow doesn't use %width%/%height%, a misconfigured size shouldn't stop generation)
  const size = values.width && values.height
    ? { width: values.width, height: values.height }
    : parseSize(pickSize(conn, values.size ?? 'portrait'));
  // Fork point of the two mutually exclusive modes: simple assembles from a template (no placeholders), custom uses macro rendering.
  // The meeting point is "have a submittable JSON"; queueing/polling/cancelling after that is fully shared.
  let workflow: ComfyWorkflow;
  if (conn.mode === 'simple') {
    try {
      workflow = buildSimpleWorkflow(conn.simple, {
        prompt: values.prompt,
        nl: values.nl,
        negative: values.negative_prompt,
        seed: values.seed ?? randomSeed(),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      });
    } catch (error) {
      throw new ComfyUIError(error instanceof Error ? error.message : String(error));
    }
  } else {
    workflow = renderWorkflowTemplate(conn.workflow, { ...values, ...size });
  }

  // Automatic channel selection: direct browser connection first; only when the request never reached ComfyUI (network-level failure) does it fall back to forwarding via the ST backend.
  // Fallback only happens before "queueing": once a prompt_id is returned the task is queued, and no failure in the polling phase resends it, avoiding duplicate images.
  let queued = false;
  try {
    const promptId = await queueDirect(conn, workflow, signal);
    queued = true;
    return await pollDirectResult(conn, promptId, signal, hooks);
  } catch (error) {
    if (queued || signal?.aborted || !isNetworkError(error)) throw error;
    return generateViaServer(conn, workflow, signal);
  }
}
