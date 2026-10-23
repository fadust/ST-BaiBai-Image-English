import { watch } from 'vue';

import { charTagLib } from '@/state/charTags';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import {
  bumpPublicRevision,
  clonePublic,
  generate,
  getBackendStatus,
  getCharacters,
  getPublicRevision,
} from './api';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GetCharactersOptions,
  type PublicCapabilities,
  type PublicChangeListener,
  type PublicChangeNotice,
  type STBaiBaiImageApi,
} from './types';

/**
 * Registration and event surface of the public API (same as BaiBai Book's src/public/register.ts, so third parties learn one set).
 *
 * How third parties get the API: **both routes must be provided**, because plugin load order is not fixed:
 * - it loads after BaiBai Image: globalThis.STBaiBaiImage is simply there;
 * - it loads before BaiBai Image: it reads undefined and has to wait for window's 'st-baibai-image:ready'.
 * Providing only one would force third parties to poll in the other case; that would be our fault, not theirs.
 */

export const PUBLIC_READY_EVENT = 'st-baibai-image:ready';
export const PUBLIC_CHANGED_EVENT = 'st-baibai-image:changed';

const capabilities: PublicCapabilities = {
  globalApi: true,
  characterLibrary: true,
  generate: true,
  saveToGallery: true,
  events: true,
};

const listeners = new Set<PublicChangeListener>();
let registered = false;
let ready = false;
let changeQueued = false;

function chatId(): string | null {
  return getContext()?.getCurrentChatId?.() ?? null;
}

function notice(type: PublicChangeNotice['type']): PublicChangeNotice {
  return {
    type,
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chatId: chatId(),
    capabilities: clonePublic(capabilities),
  };
}

/**
 * Sends a notification. **Each receiver gets its own deep copy**: when one detail object goes to N subscribers,
 * if the first changes it, the rest receive tampered content (and neither side knows what happened).
 * A subscriber callback throwing is only logged to the console: one crashing third party must not stop the others from being notified.
 */
function emitNotice(type: PublicChangeNotice['type']): void {
  const detail = notice(type);
  for (const listener of listeners) {
    try {
      listener(clonePublic(detail));
    } catch (error) {
      console.warn('[BaiBai Image] Public interface subscription callback exception', error);
    }
  }
  const eventName = type === 'ready' ? PUBLIC_READY_EVENT : PUBLIC_CHANGED_EVENT;
  window.dispatchEvent(new CustomEvent(eventName, { detail: clonePublic(detail) }));
}

/**
 * Waits one microtask before sending. recomputeCharTags() replaces entries wholesale,
 * and switching chats/deleting floors/swiping trigger several recomputations in a row; without batching, a third party would get a dozen identical
 * notifications within a second, each possibly prompting a full refresh.
 */
function queueChangedNotice(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    bumpPublicRevision();
    if (ready) emitNotice('changed');
  });
}

function createApi(): STBaiBaiImageApi {
  // Frozen: if a third party (or a library it uses) attaches things to the API object or replaces generate,
  // another third party arriving later would get the modified API. Freezing makes such changes fail outright instead of silently taking effect.
  return Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    get capabilities() {
      return clonePublic(capabilities);
    },
    getCharacters: (options?: GetCharactersOptions) => getCharacters(options),
    getBackendStatus: () => getBackendStatus(),
    generate: (request: GenerateRequest, options?: GenerateOptions) => generate(request, options),
    subscribe(listener: PublicChangeListener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/**
 * Registers the public API. **Must be called after hydrateSettings()**:
 * before settings are restored they are still in-memory defaults, and getBackendStatus() would report "a user who is in fact configured"
 * as not_configured, so third parties would simply not offer an image entry point.
 */
export function registerPublicInterface(): void {
  if (registered) return;
  registered = true;

  bumpPublicRevision();
  const api = createApi();
  (globalThis as typeof globalThis & { STBaiBaiImage?: STBaiBaiImageApi }).STBaiBaiImage = api;

  // The character library is a reactive derived result, so watch it directly instead of subscribing to each event that **causes** it to change
  // (CHAT_CHANGED / floor deletion / swipe / manual user edits / BaiBai Book sync…; missing one means one missed notification).
  watch(() => charTagLib.entries, queueChangedNotice, { deep: true });

  ready = true;
  emitNotice('ready');
  console.log('[BaiBai Image] The public interface is ready', clonePublic(capabilities));
}
