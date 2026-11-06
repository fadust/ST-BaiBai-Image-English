import { h, render } from 'vue';

import { hydrateMessage } from '@/floor/hydrate';
import { readStore } from '@/floor/storage';
import { getContext, type STMessage } from '@/st/context';
import { formatPromptText, parseImageTagContent, parseImageTags, replaceImageTagAt } from '@/st/imageTagRegex';
import { applyMessageText, type MessageExtraUpdate } from '@/st/messageEdit';

import { PROMPT_MEMO_KEY, rememberedMemo, slotVersions, tagDiff } from './versions';
import VersionsDialog from './VersionsDialog.vue';

const HOST_ID = 'bbi-app-host';
const LEAVE_MS = 160;
const LATE_HYDRATION_MS = 100;

export interface SlotAt {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
}


export function rememberPrompt(
  message: STMessage,
  swipeId: number,
  seq: number,
  oldTag: string,
): MessageExtraUpdate | undefined {
  const memo = rememberedMemo(message.extra, readStore(message), swipeId, seq, oldTag);
  return memo ? { key: PROMPT_MEMO_KEY, value: memo } : undefined;
}


export function hasSlotVersions(at: SlotAt, tag: string): boolean {
  const message = getContext()?.chat?.[at.messageId];
  return !!message && slotVersions(readStore(message), message.extra, at.swipeId, at.seq, tag).length > 0;
}

function promptText(tag: string): string {
  return formatPromptText(parseImageTagContent(tag));
}


async function restore(at: SlotAt, rawTag: string, prompt: string): Promise<boolean> {
  const context = getContext();
  const message = context?.chat?.[at.messageId];
  if (!context || !message) {
    toastr.error('This message no longer exists.', 'BaiBai Image');
    return false;
  }
  let result;
  try {
    result = await applyMessageText(
      at.messageId,
      text => (parseImageTags(text)[at.seq] !== rawTag ? null : replaceImageTagAt(text, at.seq, prompt)),
      at.chatId,
      at.swipeId,
      message,
      rememberPrompt(message, at.swipeId, at.seq, rawTag),
    );
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image');
    return false;
  }
  if (result !== 'saved') {
    toastr.warning(
      result === 'build-failed' ? 'This prompt changed while the dialog was open. Close it and try again.' : 'The chat or message changed, so the prompt was not restored.',
      'BaiBai Image',
    );
    return false;
  }

  hydrateMessage(at.messageId, context);
  setTimeout(() => {
    const later = getContext();
    if (later?.getCurrentChatId() === at.chatId) hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
}

let closeCurrent: (() => void) | null = null;


export function openSlotVersions(at: SlotAt, onRestored?: () => void): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  const message = getContext()?.chat?.[at.messageId];
  const rawTag = message ? parseImageTags(message.mes ?? '')[at.seq] : undefined;
  if (!root || !message || !rawTag) return;
  closeCurrent?.();
  const versions = slotVersions(readStore(message), message.extra, at.swipeId, at.seq, rawTag).map(version => ({
    ...version,
    text: promptText(version.prompt),
    diff: tagDiff(rawTag, version.prompt),
  }));

  const container = document.createElement('div');
  root.appendChild(container);
  let closing = false;
  let busy = false;
  const close = () => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    closing = true;
    paint();
    setTimeout(() => {
      render(null, container);
      container.remove();
    }, LEAVE_MS);
  };
  closeCurrent = close;

  const paint = () =>
    render(
      h(VersionsDialog, {
        floor: at.messageId,
        seq: at.seq,
        current: promptText(rawTag),
        versions,
        closing,
        onClose: close,
        onRestore: (hash: string) => {
          const version = versions.find(v => v.hash === hash);
          if (!version || busy) return;
          busy = true;
          void restore(at, rawTag, version.prompt).then(ok => {
            busy = false;
            if (!ok) return;
            toastr.success(version.count ? 'Prompt restored. The card now shows images made with this version.' : 'Prompt restored.', 'BaiBai Image');
            close();
            onRestored?.();
          });
        },
      }),
      container,
    );
  paint();
}
