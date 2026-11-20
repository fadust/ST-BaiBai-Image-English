import { h, render } from 'vue';
import { rememberPrompt } from '@/promptVersions/restore';

import PromptEditor from '@/floor/PromptEditor.vue';
import { cancelFloorTags, previewSlotRewrite, type SlotRewritePreview } from '@/autoTag/runner';
import { markForAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { awaitTagPlan, discardTagPreview, getTagPreview, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';
import { slotKey } from '@/floor/genState';
import { confirmDialog } from '@/components/confirm';
import { backendStatus } from '@/generate';
import { getContext } from '@/st/context';
import {
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
      return 'The chat was switched, so the prompt was not saved.';
    case 'floor-changed':
      return 'The floor changed, so the prompt was not saved.';
    case 'swipe-changed':
      return 'Switched to another swipe, so the prompt was not saved.';
    case 'build-failed':
      return 'This tag was changed in the text. Close the dialog and edit it again.';
    case 'unavailable':
      return 'The SillyTavern context is unavailable, so the prompt was not saved.';
  }
}

/**
 * Writes back the story text. Returns true once saved.
 *
 * Every failure shows a toast and returns false, **without closing the dialog**: the user may have just typed dozens of tags,
 * and swallowing the draft because of a swipe switch is unacceptable.
 */
export async function writeBack(
  at: PromptEditorAt,
  content: ImageTagContent,
  regenerate: boolean,
  preview?: SlotRewritePreview,
): Promise<boolean> {
  const context = getContext();
  if (!context) {
    toastr.error('SillyTavern context is not available', 'BaiBai Image');
    return false;
  }
  const message = context.chat?.[at.messageId];
  if (!message) {
    toastr.error('The floor no longer exists, so the prompt was not saved.', 'BaiBai Image');
    return false;
  }

  const nextTag = serializeImageTag(content);
  if (regenerate && !backendStatus().configured) {
    toastr.warning('Configure an image backend before redrawing.', 'BaiBai Image');
    return false;
  }

  let sceneChanged = false;
  let result: Awaited<ReturnType<typeof applyMessageText>>;
  try {
    result = await applyMessageText(
      at.messageId,
      currentText => {
        // The dialog may stay open for minutes. The identity CAS only checks chat/floor/swipe and **deliberately does not compare the text**
        // (that is key to coexisting with other text-editing plugins), so "the tag count changed / someone else edited this tag"
        // can't be caught there; it has to be checked here against the original text: does seq still point at the same tag.
        if (parseImageTags(currentText)[at.seq] !== at.rawTag) return null;
        if (preview && !preview.matchesScene(currentText)) {
          sceneChanged = true;
          return null;
        }
        return replaceImageTagAt(currentText, at.seq, nextTag);
      },
      at.chatId,
      preview ? preview.swipeId : at.swipeId,
      preview?.message ?? message,
      rememberPrompt(message, at.swipeId, at.seq, at.rawTag),
    );
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image');
    return false;
  }

  if (result !== 'saved') {
    toastr.warning(sceneChanged ? 'The scene or its appearance reference changed. Discard this preview and rewrite it again.' : failureReason(result), 'BaiBai Image');
    return false;
  }

  // Schedule drawing only after the chat save succeeds. Remount just the selected slot to consume the mark.
  const current = getContext();
  const saved = current?.chat?.[at.messageId];
  if (!current || current.getCurrentChatId() !== at.chatId || !saved || (saved.swipe_id ?? 0) !== at.swipeId
    || parseImageTags(saved.mes)[at.seq] !== nextTag) return true;
  if (regenerate) markForAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq, 'force');
  hydrateMessage(at.messageId, current, regenerate ? at.seq : undefined);
  setTimeout(() => {
    const later = getContext();
    if (!later || later.getCurrentChatId() !== at.chatId) return;
    hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
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

  const watchRewrite = (task: Promise<void>) => {
    void task.catch(() => {}).finally(() => paint());
  };

  const rewrite = () => {
    if (busy || closing || isTagPlanning(planKey) || getTagPreview(planKey)) return;
    watchRewrite(runTagPlan(planKey, () => previewSlotRewrite(options.at)));
    paint();
  };

  const rejoin = awaitTagPlan(planKey);
  if (rejoin) watchRewrite(rejoin);

  const apply = (value: ImageTagContent, regenerate: boolean, preview?: SlotRewritePreview) => {
    if (busy || closing || isTagPlanning(planKey)) return;
    busy = true;
    paint();
    void writeBack(options.at, value, regenerate, preview).then(ok => {
      busy = false;
      if (ok) {
        discardTagPreview(planKey);
        close();
      } else {
        paint();
      }
    });
  };

  /** Close request: if the draft was changed, ask first, so a long hand-typed draft isn't swallowed by one Esc. */
  const requestClose = () => {
    if (busy || asking || closing) return;
    if (!dirty) {
      close();
      return;
    }
    asking = true;
    void confirmDialog({
      title: 'Discard changes',
      text: 'Your prompt changes are not applied and will be lost when you close.',
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
    const preview = getTagPreview(planKey);
    if (!closing && preview && preview.rawTag !== options.at.rawTag) discardTagPreview(planKey);
    render(
      h(PromptEditor, {
        content: options.content,
        historyCount: options.historyCount,
        configured: options.configured,
        busy,
        rewriting: isTagPlanning(planKey),
        preview: preview?.rawTag === options.at.rawTag ? preview.content : undefined,
        closing,
        onDirty: (value: boolean) => {
          dirty = value;
        },
        onRewrite: rewrite,
        onCancelRewrite: () => cancelFloorTags(options.at.messageId),
        onApply: (value: ImageTagContent, regenerate: boolean) => apply(value, regenerate),
        onApplyPreview: (regenerate: boolean) => {
          const preview = getTagPreview(planKey);
          if (preview?.rawTag === options.at.rawTag) apply(preview.content, regenerate, preview);
        },
        onDiscardPreview: () => {
          discardTagPreview(planKey);
          paint();
        },
        onClose: requestClose,
      }),
      container,
    );
  };
  paint();
}
