import { h, render, watch, type VNode } from 'vue';

import Card from '@/floor/Card.vue';
import { clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { cardStyleSheet, cardStyleTextFallback } from '@/floor/cardStyles';
import { onChatMutation } from '@/floor/chatObserver';
import { setNaiConcurrency } from '@/floor/genQueue';
import { clearAllGen, pruneGenSlots } from '@/floor/genState';
import { clearAllTagPlans } from '@/floor/tagPlanState';
import { SlotRegistry } from '@/floor/registry';
import { checkSlotHealth, floorIdOf } from '@/floor/slotHealth';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import { BBI_SLOT_SELECTOR, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

/**
 * Floor hydration framework (DESIGN-FLOOR-UI.md §5.2 / §6).
 *
 * Render event fires → locate the floor's .mes_text → pair the anchor list (DOM order) one-to-one, in order, with the
 * tag list parsed by parseImageTags(message.mes) → mount one card per anchor.
 * Anchors are rebuilt on every render and hydration on every event; the whole process is idempotent.
 *
 * Cards render into each anchor's own **shadow root** (not the anchor itself): floors live in ST's light DOM,
 * where ST's global styles and users' custom themes would restyle the cards directly. The shadow boundary isolates both ways,
 * the same shape as the main window in index.ts, just going from "one big host" to "one small host per slot".
 *
 * [Two trigger layers; both are required]
 * 1. Event layer (bindFloorHydration): ST's render events cover the normal path, cheaply and promptly;
 * 2. Self-healing layer (bindSlotSelfHealing): a MutationObserver catches paths that **fire no event**.
 *
 * Layer 2 is not mainly a defence against third-party plugins but against ST itself: updateMessageBlock directly calls
 * `.mes_text.html(...)` without any event, messageEditCancel/Done use `.empty()`,
 * and swipe-right generation writes `.mes_text.html('...')`. The anchor lives **inside** .mes_text, so all of these paths
 * delete it together with its shadow root, and the event layer never notices. Users' report of
 * "the image is generating but the floor shows no UI" was exactly this: genState is module-level, so generation finishes even though the card died.
 *
 * The neighbouring BaiBai Book doesn't have this problem, not because it is sturdier, but because its host hangs **outside** .mes_text
 * as a sibling node, and `.html()`/`.empty()` only clear innerHTML, never touching siblings. This plugin's cards must
 * sit at the tag's inline position (multi-tag floors render an image per position), so they can't move out; the same constraint
 * also ruled out the official extra.media approach back then (architecture.md §6). So self-healing is the only solution under the position constraint.
 */

export const slotRegistry = new SlotRegistry();

let bound = false;
let healingBound = false;

/**
 * Inheritable typography properties: shadow DOM does not isolate inheritance, so these leak in from ST through the host.
 * Same job as INHERITED_RESET in index.ts (that one is the main window host, this one is each card's host);
 * cards must **follow the chat font size**, so font-size is not pinned, only the properties that would break layout and colours.
 */
const CARD_INHERITED_RESET: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': '400',
  'font-variant': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'line-height': '1.6',
  direction: 'ltr',
};

/**
 * Prepares the anchor's shadow root: attaches styles + pins inherited properties (idempotent).
 * Anchors are new elements on every floor render, but events like MESSAGE_UPDATED may reuse the same element,
 * so shadowRoot is checked before attachShadow; attaching twice throws.
 */
function ensureShadow(anchor: HTMLElement): ShadowRoot {
  const existing = anchor.shadowRoot;
  if (existing) return existing;

  const shadow = anchor.attachShadow({ mode: 'open' });
  const sheet = cardStyleSheet();
  if (sheet) {
    // All cards share one CSSStyleSheet object: N cards, zero duplication, zero repeated parsing
    shadow.adoptedStyleSheets = [sheet];
  } else {
    // Fallback for old browsers: one <style> per shadow root
    const style = document.createElement('style');
    style.textContent = cardStyleTextFallback();
    shadow.appendChild(style);
  }

  for (const [prop, value] of Object.entries(CARD_INHERITED_RESET)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  return shadow;
}

/** The floor's .mes_text element; null when the floor isn't in the DOM (not rendered/lazily rendered in group chats). */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  // Explicit unmount: the anchor container may already be detached (ST rewrote .mes_text wholesale);
  // render(null, container) is still safe on detached elements.
  render(null, record.container);
  slotRegistry.delete(key);
}

/** Unmounts and clears all records (full rebuild after switching chats / deleting floors). */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

/**
 * Hydrates all slots of one message.
 *
 * Diff strategy (replacing the old "unmount everything, then mount everything"): same key and unchanged anchor element → render the same component type
 * as a props patch, keeping the component instance and DOM (especially <img>) intact; anchor changed (ST re-rendered and rebuilt
 * .mes_text) or a new slot → unmount the old record and remount; records this floor no longer needs (fewer tags / swipe switch /
 * floor off-screen / message deleted) are unmounted.
 *
 * Why it's worth it: a successful image on any slot re-hydrates this floor. The old implementation rebuilt every card's <img>,
 * and every image was requested again (ST's static server uses max-age=0, so each needs revalidation); the more images on the floor,
 * the bigger the request storm when one generation completes. On the patch path an unchanged src leaves the DOM untouched: zero requests.
 */
export function hydrateMessage(messageId: number, ctx: STContext): void {
  const chatId = ctx.getCurrentChatId();
  const message = ctx.chat[messageId];

  /** Slots that "should exist" after this hydration: key → {anchor, vnode}. Empty if the message is gone; unmounted together below. */
  const desired = new Map<string, { anchor: HTMLElement; vnode: VNode }>();

  if (message) {
    const tags = parseImageTags(message.mes);
    const swipeId = message.swipe_id ?? 0;
    // Slots may disappear entirely (user deleted a tag / swiped to a version with fewer tags): no card will ever reconcile those slots again,
    // so their runtime records would stay forever and later be wrongly claimed by a new card when the same key reappears. Prune those beyond the tag count.
    pruneGenSlots(chatId ?? '-', messageId, swipeId, tags.length);

    if (tags.length > 0) {
      const mesText = findMesText(messageId);
      // Floor not in the DOM (not rendered/lazily rendered in group chats): desired stays empty, this floor's old records are unmounted, and the next render event
      if (mesText) {
        const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
        if (anchors.length !== tags.length) {
          console.warn(
            `[BaiBai Image] Floor #${messageId} anchor point ${anchors.length} ≠ raw picture tag ${tags.length} , match according to the smallest number`,
          );
        }
        const count = Math.min(anchors.length, tags.length);

        for (let seq = 0; seq < count; seq++) {
          const key = slotRegistry.key(chatId, messageId, swipeId, seq);
          // Restore from extra: recompute the hash from the current raw tag and match same-slot history → ready (pageable);
          // no match but old-prompt results exist → stale (DESIGN-FLOOR-UI.md §7.1).
          const store = readStore(message);
          const hash = promptHash(tags[seq]);
          const history = historyEntries(store, swipeId, hash, seq);
          const entry = history.length ? history[history.length - 1] : null;
          const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq);
          const content = parseImageTagContent(tags[seq]);
          desired.set(key, {
            anchor: anchors[seq],
            vnode: h(Card, {
              prompt: content.tag,
              nl: content.nl,
              negative: content.negative,
              characters: content.characters,
              size: content.size,
              tag: tags[seq],
              messageId,
              seq,
              swipeId,
              history,
              staleEntry,
              // Part of the key: same placeholder rule as registry.key ('-' when chatId is missing)
              chatId: chatId ?? '-',
            }),
          });
        }
      }
    }
  }

  // Unmount this floor's old records not in the desired set (across swipeIds)
  for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
    if (!desired.has(key)) unmountKey(key);
  }

  // Mount or diff-update
  for (const [key, { anchor, vnode }] of desired) {
    const existing = slotRegistry.get(key);
    if (existing && existing.container.host === anchor) {
      // Same anchor: render the same component type → props patch, without remounting the DOM or rerunning onMounted.
      // autoGenerate marks are consumed by onMounted, but they only appear on anchors where "tags were just written"
      // (writing the text always triggers an ST re-render, so the anchor is always rebuilt), so this branch is never reached for them.
      existing.vnode = vnode;
      render(vnode, existing.container);
    } else {
      // Cards render into the anchor's shadow root, isolated both ways from ST's styles; the theme follows settings (default st = blends into the host's colours)
      if (existing) unmountKey(key);
      const shadow = ensureShadow(anchor);
      anchor.setAttribute('data-theme', settings.ui.cardTheme || 'st');
      render(vnode, shadow);
      slotRegistry.set(key, { container: shadow, vnode });
    }
  }
}

/** Hydrate currently displayed messages without tearing down cards that still have the same anchors. */
function hydrateVisible(ctx: STContext): void {
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/** Full rebuild for chat changes or message deletion. */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  hydrateVisible(ctx);
}

const LATE_HYDRATION_DELAY = 100;

/**
 * Self-healing: health-checks mounted slots and remounts dead ones; those hidden wholesale by the host are only logged (see warnHiddenByHost).
 *
 * Being cheap is a hard requirement: it hangs on the rAF-throttled `#chat` observer and may run every frame during streaming.
 * The cost cap is O(mounted cards) (measured order <20), each doing only an `isConnected` property read +
 * one `closest()`; it **only touches the DOM when it really finds a problem**. Never call hydrateVisible here:
 * that runs parseImageTags + readStore + promptHash for every message, which is real lag.
 *
 * Remounts are deduplicated per floor: with several cards on one floor, `.mes_text` being replaced wholesale means all its slots died together,
 * and calling hydrateMessage for each would re-hydrate the same floor N times.
 *
 * No need to worry about a self-exciting loop: hydrateMessage writing to the DOM wakes this callback once more, but in that round's check
 * the slots are already ok (anchors in the document), so no more writes happen and the loop ends there. And the observer only subscribes to
 * childList, not attributes, so writing data-theme/inline styles never wakes it.
 */
export function healSlots(): void {
  let floorsToRehydrate: Set<number> | null = null;

  for (const record of slotRegistry.all()) {
    const host = record.container.host;
    const health = checkSlotHealth(host);
    if (health === 'ok') continue;

    if (health === 'hidden-by-host') {
      // The anchor and shadow root are still there, so remounting any number of times won't help: the ancestor .mes_text was hidden wholesale by
      // ST's inline_media rule (this floor has extra.media and inline_image === false;
      // the native image/captioning extensions write this combination). **Deliberately not forced back**; only logged, see warnHiddenByHost.
      warnHiddenByHost(host);
      continue;
    }

    const floor = floorIdOf(host);
    // Floor number not found: the whole floor isn't in the document (chat switch/lazy-render unload); just wait for the render event.
    // Records stay untouched: hydrateMessage reconciles them normally against the desired set when the floor returns.
    if (floor === null) continue;
    (floorsToRehydrate ??= new Set()).add(floor);
  }

  if (!floorsToRehydrate) return;
  const ctx = getContext();
  if (!ctx) return;
  for (const floor of floorsToRehydrate) hydrateMessage(floor, ctx);
}

/** Floors already reported (don't log a line for the same floor every frame). */
const hiddenWarned = new Set<number>();

/**
 * "Card hidden wholesale by the host" is only logged, not forced.
 *
 * Why not just pin a `display:block !important` to pull it back: that `display:none`
 * is intentional on ST's part: `extra.inline_image === false` means exactly "this floor shows only the image, not the text",
 * set by the user or another extension. Forcing it off would also bring back text someone deliberately hid, a visible regression for people
 * **without the problem now**; and once an inline style is pinned it can't be undone (ST later recomputes classes from extra,
 * but can't reach the style we wrote), exactly the kind of hidden trap that "can't be changed and keeps applying".
 *
 * Cards must sit at the tag's inline position (multi-tag floors render an image per position) and can't move out of .mes_text;
 * the same constraint once ruled out the official extra.media approach. So this case can only be reported truthfully:
 * the log gives the floor number and reason so a user report can pinpoint it in one sentence, without pretending it's fixed.
 */
function warnHiddenByHost(host: Element): void {
  const floor = floorIdOf(host);
  const id = floor ?? -1;
  if (hiddenWarned.has(id)) return;
  hiddenWarned.add(id);
  console.warn(
    `[BaiBai Image] Floor #${floor ?? '?'} The card is mounted but not visible: The building .mes_text is replaced by ST ` +
      'The entire section of the inline_media rule is hidden (there is an attached picture in this building and extra.inline_image is false).' +
      'This is the intentional behavior of the host, and the plug-in will not forcefully cancel it; if you want to see the card, please let the building resume displaying the text.',
  );
}

/** Binds self-healing (idempotent). Returns false = `#chat` isn't in the document; the host environment is broken. */
export function bindSlotSelfHealing(): boolean {
  if (healingBound) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;
  healingBound = true;
  onChatMutation(healSlots);
  return true;
}

/**
 * Other ST listeners may still replace .mes_text after an event. Hydrate at the end of the
 * event loop, then check once more; an unchanged anchor only receives a cheap Vue props patch.
 */
function scheduleHydration(
  task: (ctx: STContext) => void,
  lateTask: (ctx: STContext) => void = task,
): void {
  const chatId = getContext()?.getCurrentChatId();
  const run = () => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    task(current);
  };
  setTimeout(run, 0);
  setTimeout(() => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    lateTask(current);
  }, LATE_HYDRATION_DELAY);
}

/**
 * Bind message rendering plus the two recovery events used by ST for generation finalization
 * and loading older history.
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    scheduleHydration(current => hydrateMessage(id, current));
  };
  const onVisibleReload = () => scheduleHydration(hydrateVisible);
  const onGenerationEnded = (messageCount: unknown) => {
    const id = Number(messageCount) - 1;
    if (Number.isInteger(id) && id >= 0) scheduleHydration(current => hydrateMessage(id, current));
    else onVisibleReload();
  };
  const onFullReload = () => {
    clearAutoGenerateFlags();
    // A deleted/switched chat no longer owns in-flight generation work.
    clearAllGen();
    // Prompt planning likewise: the old chat's in-flight planning is aborted by the runner's cancelAll; only display state is cleared here
    clearAllTagPlans();
    // Floor numbers point to other floors in the new chat, so the already-reported records are voided too, otherwise same-numbered floors in the new chat would stay silent forever
    hiddenWarned.clear();
    scheduleHydration(hydrateAll, hydrateVisible);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
  if (eventTypes.MORE_MESSAGES_LOADED) {
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, onVisibleReload);
  }
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  scheduleHydration(hydrateAll, hydrateVisible);

  // Self-healing layer: catches the paths in ST and third parties that "rewrite .mes_text without an event" (see the file header comment)
  bindSlotSelfHealing();

  // Card theme changed → update data-theme on each card host in place (no re-hydration needed; tokens are CSS variables and apply automatically)
  watch(
    () => settings.ui.cardTheme,
    theme => {
      for (const record of slotRegistry.all()) {
        const host = record.container.host;
        if (host instanceof HTMLElement) host.setAttribute('data-theme', theme || 'st');
      }
    },
  );
  // NAI concurrency limit → gate (ComfyUI has no concurrency limit; it relies on the server queue)
  watch(
    () => settings.nai.concurrency,
    value => setNaiConcurrency(value),
    { immediate: true },
  );
  return true;
}
