import { getContext, type STContext, type STMessage } from '@/st/context';

function findMessage(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function activeEditorText(floor: number): string | null {
  return findMessage(floor)?.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value ?? null;
}

function currentSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function setMessageText(message: STMessage, text: string): void {
  message.mes = text;
  const swipeId = currentSwipeId(message);
  if (swipeId === null || !message.swipes || swipeId < 0 || swipeId >= message.swipes.length) return;
  message.swipes[swipeId] = text;
}

function settleActiveEditor(floor: number, text: string): boolean {
  const message = findMessage(floor);
  const editor = message?.querySelector<HTMLTextAreaElement>('#curEditTextarea');
  if (!message || !editor) return false;

  editor.value = text;
  message.querySelector<HTMLElement>('.mes_edit_cancel')?.click();
  return true;
}

async function emitMessageEvent(context: STContext, event: string | undefined, floor: number): Promise<void> {
  if (event && context.eventSource.emit) await context.eventSource.emit(event, floor);
}

async function refreshRenderedMessage(context: STContext, message: STMessage, floor: number): Promise<void> {
  if (!findMessage(floor)) return;
  if (typeof context.updateMessageBlock === 'function') {
    try {
      await context.updateMessageBlock(floor, message);
      return;
    } catch {
      // If the partial refresh fails, fall back to reloading the whole chat.
    }
  }
  await context.reloadCurrentChat?.();
}

export type ApplyMessageResult =
  | 'saved'
  | 'chat-changed'
  | 'floor-changed'
  | 'swipe-changed'
  | 'build-failed'
  | 'unavailable';

export interface MessageExtraUpdate {
  key: string;
  /** undefined = delete the key. */
  value: unknown;
}

/**
 * Checks whether the message in the slot is still the one from when the request started.
 *
 * No object-reference comparison: other plugins that edit the text often replace the whole message object (chat[i] = {...chat[i], mes}),
 * and a reference check would mistake "same message, new shell" for a floor change and discard the whole analysis.
 * send_date is fixed at creation and unchanged by edits; together with name it identifies the message. When deleting a floor shifts the indices,
 * send_date necessarily differs, so the right cases are still blocked. Old messages without send_date fall back to reference comparison.
 */
function isSameMessage(message: STMessage, expected: STMessage): boolean {
  if (message === expected) return true;
  if (!expected.send_date) return false;
  return message.send_date === expected.send_date && message.name === expected.name;
}

/**
 * Modifies the message text and one extra key compare-and-swap style.
 *
 * Writes only if identity checks (chat / message / swipe) match; the text content itself is **not** compared. The text is
 * computed by buildNext from "the real text at the moment of writing", so edits other plugins made during the analysis are preserved
 * instead of being overwritten by the stale snapshot from request start. buildNext returning null means it decided not to write.
 * On save failure both the text and extra are rolled back, so no half-written state remains.
 */
export async function applyMessageText(
  floor: number,
  buildNext: (currentText: string) => string | null,
  expectedChatId: string,
  expectedSwipeId: number | null,
  expectedMessage?: STMessage,
  extraUpdate?: MessageExtraUpdate,
): Promise<ApplyMessageResult> {
  const context = getContext();
  if (!context?.saveChat) return 'unavailable';
  if (context.getCurrentChatId?.() !== expectedChatId) return 'chat-changed';

  const message = context.chat?.[floor];
  if (!message) return 'unavailable';
  if (expectedMessage && !isSameMessage(message, expectedMessage)) return 'floor-changed';
  if (currentSwipeId(message) !== expectedSwipeId) return 'swipe-changed';

  // While the edit box is open it holds the live text (the user changed it but hasn't confirmed), so it is the base for writing
  const nextText = buildNext(activeEditorText(floor) ?? message.mes);
  if (nextText === null) return 'build-failed';

  const previousText = message.mes;
  const previousExtra = message.extra;
  const swipeId = currentSwipeId(message);
  const previousSwipeText = swipeId !== null ? message.swipes?.[swipeId] : undefined;
  setMessageText(message, nextText);
  if (extraUpdate) {
    const nextExtra = { ...(message.extra ?? {}) };
    if (extraUpdate.value === undefined) delete nextExtra[extraUpdate.key];
    else nextExtra[extraUpdate.key] = extraUpdate.value;
    message.extra = nextExtra;
  }

  try {
    await context.saveChat();
  } catch (error) {
    message.mes = previousText;
    message.extra = previousExtra;
    if (swipeId !== null && message.swipes && swipeId >= 0 && swipeId < message.swipes.length) {
      message.swipes[swipeId] = previousSwipeText ?? previousText;
    }
    throw error;
  }

  await emitMessageEvent(context, context.eventTypes.MESSAGE_EDITED, floor).catch(error => {
    console.warn('[BaiBai Image] tag has been saved, but the MESSAGE_EDITED event failed to be sent', error);
  });
  if (!settleActiveEditor(floor, message.mes)) {
    await refreshRenderedMessage(context, message, floor).catch(error => {
      console.warn('[BaiBai Image] tag has been saved, but the floor refresh failed', error);
    });
    await emitMessageEvent(context, context.eventTypes.MESSAGE_UPDATED, floor).catch(error => {
      console.warn('[BaiBai Image] tag has been saved, but the MESSAGE_UPDATED event failed to be sent.', error);
    });
  }
  return 'saved';
}
