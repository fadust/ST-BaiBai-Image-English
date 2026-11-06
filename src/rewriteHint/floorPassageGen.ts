import { h, render } from 'vue';
import { requestFocusedTags } from '@/autoTag/runner';
import { ensureChatObserver, onChatMutation } from '@/floor/chatObserver';
import { getContext, isAiStoryMessage } from '@/st/context';
import { parseImageTags } from '@/st/imageTagRegex';
import { isCurrentChatExcluded, settings } from '@/state/settings';
import PassageDialog from './PassageDialog.vue';
import { floorPassages, passageGroupsHint } from './passage';
import { drawnPassages } from './sources';
import { clearDraft, draftFrom, draftPick, readDraft, saveDraft } from './pickDraft';

let closeCurrent: (() => void) | null = null;
export function openPassageGenFor(floor: number): void {
  const context = getContext();
  const message = context?.chat?.[floor];
  const root = document.getElementById('bbi-app-host')?.shadowRoot;
  if (!context || !message || !root || !isAiStoryMessage(message) || !settings.enabled || isCurrentChatExcluded()) return;
  closeCurrent?.();
  const chatId = context.getCurrentChatId();
  const swipeId = message.swipe_id ?? 0;
  const source = message.mes;
  const key = `${chatId}\u0000${floor}\u0000${swipeId}`;
  const passages = floorPassages(floor);
  const saved = draftPick(readDraft(key), false, passages);
  const container = document.createElement('div'); root.appendChild(container);
  const close = () => { render(null, container); container.remove(); if (closeCurrent === close) closeCurrent = null; };
  closeCurrent = close;
  render(h(PassageDialog, {
    passages, existing: parseImageTags(source).length, drawn: drawnPassages(floor), initial: saved?.groups, initialHint: saved?.extra,
    onClose: close,
    onSave: (groups: string[][], hint: string) => saveDraft(key, draftFrom(false, groups, hint, passages)),
    onSubmit: (groups: string[][], hint: string) => {
      const now = getContext();
      if (!now || now.getCurrentChatId() !== chatId || now.chat[floor] !== message || (message.swipe_id ?? 0) !== swipeId || message.mes !== source) {
        toastr.warning('This message changed. Reopen scene selection before generating.', 'BaiBai Image'); return;
      }
      const chosen = groups.map(ids => passages.filter(p => ids.includes(p.id))).filter(g => g.length);
      const focus = [passageGroupsHint(chosen), hint.trim() ? `Additional instructions: ${hint.trim()}` : ''].filter(Boolean).join('\n\n');
      close();
      void requestFocusedTags(floor, focus).then(saved => { if (saved) clearDraft(key); });
    },
  }), container);
}
let bound = false;
export function bindPassageGenButtons(): void {
  if (bound || !ensureChatObserver()) return; bound = true;
  const sync = () => {
    const chat = getContext()?.chat;
    for (const el of document.querySelectorAll<HTMLElement>('#chat .mes')) {
      const floor = Number(el.getAttribute('mesid'));
      const host = el.querySelector('.extraMesButtons'); if (!host) continue;
      let button = host.querySelector<HTMLElement>('.bbi-scene-action');
      const wanted = settings.enabled && !isCurrentChatExcluded() && isAiStoryMessage(chat?.[floor]);
      if (!wanted) { button?.remove(); continue; }
      if (!button) {
        const created = document.createElement('div');
        created.className = 'mes_button fa-solid fa-crop-simple bbi-scene-action';
        created.setAttribute('role', 'button'); created.tabIndex = 0;
        created.addEventListener('click', () => openPassageGenFor(floor));
        created.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPassageGenFor(floor); } });
        host.appendChild(created); button = created;
      }
      button.title = parseImageTags(chat?.[floor]?.mes ?? '').length ? 'Add illustrations from selected passages' : 'Illustrate selected passages';
    }
  };
  onChatMutation(sync); sync();
}
