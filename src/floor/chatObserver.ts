/**
 * The **single** MutationObserver for changes in the `#chat` subtree.
 *
 * Why share one: floor-button reconciliation and card self-healing watch the same tree with the same childList+subtree.
 * With a separate observer each, the browser collects and dispatches the same batch of MutationRecords twice,
 * and the real cost is on the collection side, not the callback side. With one combined, the marginal cost of another subscriber
 * is just one more function call in the callback. That is also the answer to "will self-healing cause constant lag": no, because
 * this observation cost has been paid since the day floor buttons shipped.
 *
 * Throttled with rAF: during streaming, mutations are extremely dense (one per token), so consecutive changes within a frame
 * merge into one callback. Subscriber callbacks must be "cheap reconciliation": read attributes only, touch the DOM only
 * when there really is a difference, and never do full rebuilds inside.
 */

type ChatMutationListener = () => void;

const listeners = new Set<ChatMutationListener>();

let observer: MutationObserver | null = null;
let scheduled = false;

function flush(): void {
  scheduled = false;
  for (const listener of listeners) {
    // One subscriber throwing must not take down the others (above all, it must not take the whole self-healing chain with it)
    try {
      listener();
    } catch (error) {
      console.error('[BaiBai Image] #chat Change callback exception', error);
    }
  }
}

/**
 * Binds the observer (idempotent). `#chat` is in ST's static template; if it can't be found, the host environment is broken, so give up.
 * When it returns false, callers **should not** fall back to polling on their own: that costs far more than an observer.
 */
export function ensureChatObserver(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;

  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  // Only childList+subtree: attribute changes (/hide flipping is_system, or our own data-theme
  // and inline styles on anchors) are all kept out. The latter matters most: observing attributes would let self-healing's attribute writes
  // wake the observer again, creating a self-exciting loop.
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}

/** Subscribes to `#chat` changes (ensures the observer is bound). Returns an unsubscribe function. */
export function onChatMutation(listener: ChatMutationListener): () => void {
  listeners.add(listener);
  ensureChatObserver();
  return () => listeners.delete(listener);
}
