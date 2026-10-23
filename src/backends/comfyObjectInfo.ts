/**
 * Fetches model/LoRA/sampler lists from ComfyUI as candidates for the simple-mode form.
 *
 * Channel strategy matches generateComfyImage: direct browser connection first (one GET /object_info returns everything,
 * including LoRA and CLIP); only on network-level failure (CORS/connection refused) does it fall back to forwarding via the ST backend.
 *
 * The ST backend only has four endpoints, /api/sd/comfy/models|samplers|schedulers|vaes (each pulls /object_info server-side
 * and extracts a field); **there are no loras/clips endpoints**. Through the forwarding channel those two lists are empty,
 * the form degrades to manual input (datalist without candidates), and the status line explains why.
 *
 * Lists are cached per session: the full object_info response is several MB, and switching presets/reopening the panel should not refetch it;
 * when users add new models they click "Refresh" to force a refetch.
 */

import { ComfyUIError } from '@/backends/comfyui';
import { getContext } from '@/st/context';

export interface ComfyModelLists {
  checkpoints: string[];
  unets: string[];
  ggufs: string[];
  vaes: string[];
  clips: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
  /** The channel that actually connected: browser = full lists; server = forwarded, loras/clips empty. */
  mode: 'browser' | 'server';
  fetchedAt: number;
}

/** Common candidates when the forwarding channel cannot fetch lists (datalist fallback; manual input still allowed). */
export const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc'];
export const FALLBACK_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'];

const SERVER_BASE = '/api/sd/comfy';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

/** Gets the candidate list for one input of one node from object_info; missing nodes/mismatched shapes always give an empty array (degrade first). */
function optionList(info: JsonObject, nodeClass: string, input: string): string[] {
  const node = info[nodeClass];
  if (!isObject(node) || !isObject(node.input) || !isObject(node.input.required)) return [];
  const entry = node.input.required[input];
  if (!Array.isArray(entry)) return [];
  const options = entry[0];
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === 'string');
}

/** Full parse for the direct browser connection. clips is the union of CLIPLoader and DualCLIPLoader (same folder; their lists may differ by a version). */
export function parseObjectInfo(info: JsonObject): Omit<ComfyModelLists, 'mode' | 'fetchedAt'> {
  return {
    checkpoints: optionList(info, 'CheckpointLoaderSimple', 'ckpt_name'),
    unets: optionList(info, 'UNETLoader', 'unet_name'),
    ggufs: optionList(info, 'UnetLoaderGGUF', 'unet_name'),
    vaes: optionList(info, 'VAELoader', 'vae_name'),
    clips: [
      ...new Set([
        ...optionList(info, 'CLIPLoader', 'clip_name'),
        ...optionList(info, 'DualCLIPLoader', 'clip_name1'),
      ]),
    ],
    loras: optionList(info, 'LoraLoader', 'lora_name'),
    samplers: optionList(info, 'KSampler', 'sampler_name'),
    schedulers: optionList(info, 'KSampler', 'scheduler'),
  };
}

/**
 * Entries of ST's forwarded /models are {value: original file name, text: display name};
 * UNet/GGUF are told apart by text prefix ("UNet: xxx"/"GGUF: xxx"); the rest are checkpoints.
 */
function classifyServerModels(data: unknown): Pick<ComfyModelLists, 'checkpoints' | 'unets' | 'ggufs'> {
  const result = { checkpoints: [] as string[], unets: [] as string[], ggufs: [] as string[] };
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    if (!isObject(item) || typeof item.value !== 'string') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.startsWith('UNet: ')) result.unets.push(item.value);
    else if (text.startsWith('GGUF: ')) result.ggufs.push(item.value);
    else result.checkpoints.push(item.value);
  }
  return result;
}

function stringArray(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`, response.status);
}

async function fetchViaBrowser(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const response = await fetch(endpoint(url, 'object_info'), { signal });
  if (!response.ok) throw await responseError(response, 'Failed to read ComfyUI model list');
  const info = (await response.json()) as JsonObject;
  if (!isObject(info)) throw new ComfyUIError('object_info format returned by ComfyUI is abnormal');
  return { ...parseObjectInfo(info), mode: 'browser', fetchedAt: Date.now() };
}

async function fetchViaServer(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern context is not available');
  const post = async (path: string): Promise<unknown> => {
    const response = await fetch(`${SERVER_BASE}/${path}`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({ url: url.trim() }),
      signal,
    });
    if (!response.ok) throw await responseError(response, 'ST backend failed to read ComfyUI model list');
    return response.json();
  };
  const [models, samplers, schedulers, vaes] = await Promise.all([
    post('models'),
    post('samplers'),
    post('schedulers'),
    post('vaes'),
  ]);
  return {
    ...classifyServerModels(models),
    vaes: stringArray(vaes),
    clips: [],
    loras: [],
    samplers: stringArray(samplers),
    schedulers: stringArray(schedulers),
    mode: 'server',
    fetchedAt: Date.now(),
  };
}

const cache = new Map<string, ComfyModelLists>();

/** Fetches lists; the same url hits the cache and returns directly; force refetches (the "Refresh" button). */
export async function fetchComfyModelLists(
  url: string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<ComfyModelLists> {
  const key = url.trim();
  if (!key) throw new ComfyUIError('Please fill in the ComfyUI service address first');
  if (!options?.force && cache.has(key)) return cache.get(key)!;

  let lists: ComfyModelLists;
  try {
    lists = await fetchViaBrowser(key, options?.signal);
  } catch (error) {
    // Same rule as generation: only network-level failures fall back; HTTP errors are real server feedback, and forwarding would give the same result
    if (!isNetworkError(error)) throw error;
    lists = await fetchViaServer(key, options?.signal);
  }
  cache.set(key, lists);
  return lists;
}

/** For tests: clears the cache. */
export function clearComfyModelListsCache(): void {
  cache.clear();
}
