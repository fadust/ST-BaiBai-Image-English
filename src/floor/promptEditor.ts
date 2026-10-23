import { h, render } from 'vue';

import PromptEditor from '@/floor/PromptEditor.vue';
import { cancelFloorTags, requestSlotTag } from '@/autoTag/runner';
import { markForAutoGenerate, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { awaitTagPlan, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';
import { slotKey } from '@/floor/genState';
import { confirmDialog } from '@/components/confirm';
import { getContext } from '@/st/context';
import {
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  type ImageTagContent,
} from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';

/**
 * Opens the "Edit prompt" dialog imperatively (called by floor cards).
 *
 * Mount point is the same as components/confirm.ts and floor/lightbox.ts: the plugin host's shadow root,
 * which holds dist/index.css and the --bbi-* theme variables; mounting on document.body would render it unstyled.
 * Deliberately **not** mounted in the card's own shadow root: the dialog is a fixed full-screen layer, while the card lives inside .mes_text,
 * whose stacking context and overflow would clip it (same as the lightbox; see lightbox.ts).
 *
 * [The story text is the prompt's source of truth]
 * The raw tag text lives in message.mes, not in extra or a store. So "edit prompt" is really a
 * write-back of the text: serialise the new tag → replace tag number seq in place → applyMessageText (identity CAS) →
 * re-hydrate. A new tag yields a new promptHash, and old images fall into the stale bucket automatically (the card already has an "old prompt" badge
 * and hint line), so "Apply" needs no extra persistence logic.
 */

// Matches HOST_ID in index.ts
const HOST_ID = 'bbi-app-host';

/** Snapshot of floor coordinates. The dialog outlives the card, so these are all read when it opens; callbacks never read props. */
export interface PromptEditorAt {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  /** Raw tag text when the dialog opened: used before write-back to confirm seq still points at the same tag. */
  rawTag: string;
}

export interface PromptEditorOptions {
  at: PromptEditorAt;
  /** Parsed original content (the dialog's initial value and the baseline for "was anything really changed"). */
  content: ImageTagContent;
  /** How many images exist for the current prompt. */
  historyCount: number;
  /** Whether the backend is configured. */
  configured: boolean;
}

/** Only one editor dialog at a time; a repeat call closes the old one first. */
let closeCurrent: (() => void) | null = null;

/** Leave-animation duration, matching .bbi-modal-enter/leave-active (0.15s) in base.css. */
const LEAVE_MS = 160;

/** Delay for the follow-up hydration, same rule as LATE_HYDRATION_DELAY in hydrate.ts. */
const LATE_HYDRATION_MS = 100;

/** What to tell the user when write-back fails (exhaustive: adding an ApplyMessageResult branch makes this fail to compile). */
function failureReason(result: Exclude<ApplyMessageResult, 'saved'>): string {
  switch (result) {
    case 'chat-changed':
      return 'The chat has been switched and the prompt words have not been saved.';
    case 'floor-changed':
      return 'The floor has changed and the prompt word has not been saved.';
    case 'swipe-changed':
      return 'Switched to another swipe, prompt word not saved';
    case 'build-failed':
      return 'This article tag in the text has been changed, please close the pop-up window and edit it again';
    case 'unavailable':
      return 'SillyTavern The context is not available and the prompt word is not saved.';
  }
}

/**
 * Writes back the story text. Returns true once saved.
 *
 * Every failure shows a toast and returns false, **without closing the dialog**: the user may have just typed dozens of tags,
 * and swallowing the draft because of a swipe switch is unacceptable.
 */
async function writeBack(
  at: PromptEditorAt,
  content: ImageTagContent,
  regenerate: boolean,
): Promise<boolean> {
  const context = getContext();
  if (!context) {
    toastr.error('SillyTavern context is not available', 'BaiBai Image');
    return false;
  }
  const message = context.chat?.[at.messageId];
  if (!message) {
    toastr.error('The floor no longer exists and the prompt word is not saved.', 'BaiBai Image');
    return false;
  }

  const nextTag = serializeImageTag(content);
  // The mark must be set **before** writing back: write-back triggers re-hydration, and the card consumes the mark on mount (same as autoTag/runner.ts).
  // force mode always starts: the user clicked "Regenerate", even if this prompt produced images before.
  if (regenerate) {
    markForAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq, 'force');
  }

  let result: Awaited<ReturnType<typeof applyMessageText>>;
  try {
    result = await applyMessageText(
      at.messageId,
      currentText => {
        // The dialog may stay open for minutes. The identity CAS only checks chat/floor/swipe and **deliberately does not compare the text**
        // (that is key to coexisting with other text-editing plugins), so "the tag count changed / someone else edited this tag"
        // can't be caught there; it has to be checked here against the original text: does seq still point at the same tag.
        if (parseImageTags(currentText)[at.seq] !== at.rawTag) return null;
        return replaceImageTagAt(currentText, at.seq, nextTag);
      },
      at.chatId,
      at.swipeId,
      message,
    );
  } catch (error) {
    // Revoke the mark: take back only our own one; clearAutoGenerateForFloor can't be used (it would hit sibling slots on the same floor)
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image');
    return false;
  }

  if (result !== 'saved') {
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.warning(failureReason(result), 'BaiBai Image');
    return false;
  }

  // applyMessageText internally fires MESSAGE_EDITED / MESSAGE_UPDATED, so the floor usually re-hydrates by itself;
  // but while ST's edit box is open it takes the settleActiveEditor branch (**no MESSAGE_UPDATED**), and nobody hydrates,
  // so we do it here. Twice, for the same reason as scheduleHydration in hydrate.ts: other ST listeners may replace .mes_text
  // after this; if the anchor hasn't changed, the late run is just a cheap props patch (zero rebuilds, no mark consumed twice).
  hydrateMessage(at.messageId, context);
  setTimeout(() => {
    const later = getContext();
    if (!later || later.getCurrentChatId() !== at.chatId) return;
    hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
}

/**
 * Re-reads tag number seq from the story text and works out what the dialog should switch to after a rewrite is saved (pure function, easy to unit test).
 *
 * Returns null = touch nothing: the text can't be read, seq no longer exists, or the raw text didn't change at all. No guessing, no fallback:
 * the story text is the prompt's single source of truth (see the file header), and if it can't be read, what the user sees should stay.
 *
 * **rawTag and content must change together**: changing only content (refilling the input) without rawTag means the user's next click on
 * "Apply" runs into "this tag has been changed", and the change was our own rewrite.
 */
export function nextEditorState(
  text: string | undefined,
  seq: number,
  currentRawTag: string,
): { rawTag: string; content: ImageTagContent } | null {
  if (typeof text !== 'string') return null;
  const nextRaw = parseImageTags(text)[seq];
  if (nextRaw === undefined || nextRaw === currentRawTag) return null;
  return { rawTag: nextRaw, content: parseImageTagContent(nextRaw) };
}

export function openPromptEditor(options: PromptEditorOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);
  let busy = false;
  /** Whether the draft was changed: pushed up by the component's emit('dirty'). */
  let dirty = false;
  /** Close requested: once set, re-render once so the component plays its leave animation, then really unmount after LEAVE_MS. */
  let closing = false;
  /** Asking "Discard changes?": ConfirmDialog doesn't handle Esc itself, while this dialog's capture listener is still active;
   *  without blocking, repeated Esc presses would stack several confirm dialogs. */
  let asking = false;
  /**
   * Content the dialog currently shows. After an AI rewrite is saved it switches to the new version from the text, and the component's watch refills the input.
   * Kept apart from options.content: that is the snapshot from opening and must not change.
   */
  let content: ImageTagContent = options.content;
  /**
   * Raw tag text used for the write-back CAS. **It must switch to the new one after a rewrite is saved**;
   * otherwise the user's next click on "Apply" runs into "this tag has been changed", and the change was ours.
   */
  let rawTag = options.at.rawTag;
  /**
   * An AI rewrite has already been saved in this dialog. The dialog doesn't close automatically, and the prompt the user sees is one "already saved in the text",
   * which looks the same as a draft they typed and haven't applied; without saying so, there is no way to tell which one is in effect.
   */
  let rewritten = false;
  /** This slot's runtime key, same shape as genState / tagPlanState. */
  const planKey = slotKey(options.at.chatId, options.at.messageId, options.at.swipeId, options.at.seq);
  /**
   * This dialog is closed (including being replaced by a newer one). **Late callbacks must never render again**:
   * the rewrite runs in tagPlanState and outlives the dialog, so its finish callback can arrive after the dialog closed.
   *
   * This gate is not fussiness: the container is removed, but ModalMask teleports to modalHost, so
   * **a detached container does not mean invisible**. Rendering once into the detached container brings the dialog back on screen,
   * as a brand-new instance (the closing watch has no immediate, so mounting with closing=true doesn't hide itself),
   * and then requestClose / onApply both bail out early on closing → the ×, Cancel and Apply all stop working, and the dialog can't be closed.
   */
  let closed = false;

  const close = () => {
    if (closeCurrent !== close) return; // Already replaced by a newer one; don't clean up twice
    closeCurrent = null;
    // Let the component play its leave animation first (ModalMask's Transition needs the container still attached), then really unmount
    closing = true;
    paint();
    setTimeout(() => {
      // closed must be set **before** render(null): if a late paint slipped in between them,
      // the instance being unmounted would be the one it just remounted, and the close would be wasted.
      closed = true;
      render(null, container);
      container.remove();
    }, LEAVE_MS);
  };
  closeCurrent = close;

  /**
   * After a rewrite finishes: re-reads this slot's tag from the **current text** and refills the input.
   * The decision is in nextEditorState (pure function, unit tested); this only fetches the text and assigns.
   * Returns true = the prompt really changed (used to show a one-line "saved" note).
   */
  const refreshFromMessage = (): boolean => {
    const next = nextEditorState(
      getContext()?.chat?.[options.at.messageId]?.mes,
      options.at.seq,
      rawTag,
    );
    if (!next) return false;
    rawTag = next.rawTag;
    content = next.content;
    rewritten = true;
    return true;
  };

  /**
   * Actually starts the rewrite.
   *
   * Runs in tagPlanState rather than this dialog: **closing the dialog does not interrupt the rewrite** (an explicit user requirement).
   * The runner saves and force-generates by itself, so this only reads the new prompt back after it finishes and re-renders.
   * The dialog **does not close automatically**: vanishing after one click looks like a crash.
   */
  const startRewrite = (): void => {
    if (busy || closing || isTagPlanning(planKey)) return;
    const task = runTagPlan(planKey, () => requestSlotTag(options.at.messageId, options.at.seq));
    paint();
    void task
      .catch(() => {
        // The runner already showed the failure reason as a toast; this only stops the spinner
      })
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  };

  /**
   * The "AI rewrite prompt" button.
   *
   * If the draft was changed, ask first: the rewrite **really saves**, and after it finishes the draft is necessarily replaced by the new prompt
   * (not replacing it would be worse: the user's next click on "Apply" would overwrite the fresh rewrite with the old draft). Silently swallowing
   * a long hand-typed draft in one click is data loss, same rule as requestClose; sharing asking prevents stacking several confirm dialogs.
   */
  const rewrite = (): void => {
    if (busy || asking || closing || isTagPlanning(planKey)) return;
    if (!dirty) {
      startRewrite();
      return;
    }
    asking = true;
    void confirmDialog({
      title: 'AI Rewrite prompt word',
      text: 'The content you modified manually has not been applied yet. AI will be saved directly after rewriting and these changes will be pushed out.',
      confirmText: 'rewrite',
    }).then(ok => {
      asking = false;
      if (ok) startRewrite();
    });
  };

  // When the dialog reopens, resume the in-flight rewrite: the request belongs to the store, and closing the dialog didn't interrupt it.
  // Don't start another; just wait for it to finish and refill as usual (the "resume" users want).
  const rejoin = awaitTagPlan(planKey);
  if (rejoin) {
    void rejoin
      .catch(() => {})
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  }

  /** Close request: if the draft was changed, ask first, so a long hand-typed draft isn't swallowed by one Esc. */
  const requestClose = () => {
    if (busy || asking || closing) return;
    if (!dirty) {
      close();
      return;
    }
    asking = true;
    void confirmDialog({
      title: 'Abandon changes',
      text: 'The changes to the prompt word have not been applied and will be lost after closing.',
      confirmText: 'give up',
      cancelText: 'Continue editing',
      tone: 'danger',
    }).then(ok => {
      asking = false;
      if (ok) close();
    });
  };

  /**
   * Re-renders (props patch; the component instance and draft are kept, so users don't lose input if write-back fails).
   *
   * **No ref to get the component instance**: an imperative render has no parent component, so `ref`'s owner is null;
   * on mount Vue silently skips it because of the parentComponent guard, and on unmount, with no guard, it throws
   * "Cannot read properties of null (reading 'refs')"; the ref never takes effect
   * → no instance → the dialog can't be closed. All state goes through props/emit.
   */
  const paint = () => {
    // Late re-renders are always discarded (see the comment on closed): the container is detached, but ModalMask teleports out,
    // so rendering into it would stick the closed dialog back on screen, and it could never be closed again.
    if (closed) return;
    render(
      h(PromptEditor, {
        content,
        historyCount: options.historyCount,
        configured: options.configured,
        busy,
        rewriting: isTagPlanning(planKey),
        rewritten,
        closing,
        onDirty: (value: boolean) => {
          dirty = value;
        },
        onRewrite: rewrite,
        onCancelRewrite: () => cancelFloorTags(options.at.messageId),
        onApply: (value: ImageTagContent, regenerate: boolean) => {
          if (busy || closing) return;
          busy = true;
          paint();
          void writeBack({ ...options.at, rawTag }, value, regenerate).then(ok => {
            busy = false;
            if (ok) close();
            else paint();
          });
        },
        onClose: requestClose,
      }),
      container,
    );
  };
  paint();
}
