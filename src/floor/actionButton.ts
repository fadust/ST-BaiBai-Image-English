import { requestFloorTags } from '@/autoTag/runner';
import { confirmDialog } from '@/components/confirm';
import { ensureChatObserver, onChatMutation } from '@/floor/chatObserver';
import { isCurrentChatExcluded, settings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import { hasImageTagTrace } from '@/st/imageTagRegex';

/**
 * Injects the floor "Generate image tags" button.
 *
 * Appends a palette button to each story floor's .extraMesButtons (ST's extension button area, expanded by "⋯")
 * (same icon as the extension menu entry):
 * - floor without tags: analyse and write tags directly;
 * - floor with tags: first shows the plugin's own confirm dialog; on confirmation, removes the old tags and re-analyses and writes
 *   (old images stay in the card history; cards for the new tags show old images via the stale mechanism).
 *
 * Who gets a button is decided **only by isAiStoryMessage in st/context.ts**, the same predicate as the auto flow and the runner's
 * safety gate: AI floors get one; user floors and true ST system floors don't; normal floors hidden with /hide
 * still do, since they are still story floors and the runner lets them through. The old version read the DOM's is_system attribute directly, so hidden floors
 * never had a button (exactly what users reported), and attribute changes are outside the observer's scope,
 * so one chat showed two behaviours: "floors rendered before hiding keep the button; floors re-rendered after hiding lose it".
 *
 * The button is plain DOM (fa icon, same look as ST's native extension buttons) and stays outside the Vue tree.
 * ST re-rendering rebuilds floor DOM; the shared #chat observer (floor/chatObserver.ts) reconciles idempotently
 * (adds what should exist, removes what shouldn't).
 */

const BUTTON_CLASS = 'bbi-tag-action';
// Same palette icon as the extension menu entry
const ICON_CLASS = 'fa-palette';

let bound = false;

function setRunning(button: HTMLElement, running: boolean): void {
  button.dataset.running = running ? '1' : '';
  button.classList.toggle(ICON_CLASS, !running);
  button.classList.toggle('fa-spinner', running);
  button.classList.toggle('fa-spin', running);
}

async function onActivate(button: HTMLElement): Promise<void> {
  if (button.dataset.running === '1') return;
  const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
  const context = getContext();
  const message = Number.isInteger(floor) ? context?.chat?.[floor] : undefined;
  // A click must lead somewhere: a silent return is, to the user, "clicked the button, nothing happened", without even a log
  if (!context || !message) {
    console.warn('[BaiBai Image] The corresponding message cannot be found for the floor button', { mesid: button.closest('.mes')?.getAttribute('mesid') });
    toastr.warning('No news found on this floor, please refresh the page and try again', 'BaiBai Image');
    return;
  }
  if (!settings.enabled) {
    toastr.warning('BaiBai Image has been disabled. Please enable it in the plug-in settings first.', 'BaiBai Image');
    return;
  }

  const hasTags = hasImageTagTrace(message.mes ?? '');
  if (hasTags) {
    const ok = await confirmDialog({
      title: 'Rebuild tag',
      text: 'This building already has a picture of tag. Regeneration will first delete the original tag and then write the new one; the generated pictures will be retained in the card history and will not be lost.',
      confirmText: 'Regenerate',
    });
    if (!ok) return;
  }

  setRunning(button, true);
  try {
    await requestFloorTags(floor, { replace: hasTags });
  } finally {
    // ST may have re-rendered and removed this button while running; changing classes on a detached element is a safe no-op
    setRunning(button, false);
  }
}

function createButton(): HTMLDivElement {
  const button = document.createElement('div');
  // mes_button matches ST's native extension buttons in .extraMesButtons (menu_button is the generic menu button, styled differently)
  button.className = `mes_button fa-solid ${ICON_CLASS} ${BUTTON_CLASS}`;
  button.title = 'Generate raw image tag (regenerate if tag already exists)';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');

  const activate = () => void onActivate(button);
  button.addEventListener('click', activate);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

/**
 * Reconciles buttons with "who should have one" (idempotent, both ways): adds what should exist, removes what shouldn't.
 *
 * Both ways is required: if it only added, a changed criterion (this character added to the exclusion list, /role turning a floor into a system floor)
 * would only take effect after a full re-render, and the leftover buttons would meanwhile just run into the runner's safety gate when clicked.
 * The one currently running isn't removed: its spinner and running mark must stay until this request finishes.
 */
function syncButtons(): void {
  const chat = getContext()?.chat;
  // Context not ready yet: do nothing; "who should have one" can't be judged now, and reconciling against an empty chat would remove every button
  if (!chat) return;
  // Excluded character: the whole auto-tag pipeline is disabled for this chat (same list as BaiBai Book), and manual buttons are removed too
  const excluded = isCurrentChatExcluded();
  for (const mesEl of document.querySelectorAll<HTMLElement>('#chat .mes')) {
    const extra = mesEl.querySelector('.extraMesButtons');
    if (!extra) continue;
    const floor = Number(mesEl.getAttribute('mesid'));
    // The criterion uses the message objects in chat, not the DOM's is_system attribute (see the file header comment).
    // A side benefit: /hide only flips the attribute without touching the DOM tree, so it could never trigger the observer anyway, and now it doesn't need to.
    const wanted = !excluded && Number.isInteger(floor) && isAiStoryMessage(chat[floor]);
    const existing = extra.querySelector<HTMLElement>(`.${BUTTON_CLASS}`);
    if (wanted && !existing) extra.appendChild(createButton());
    else if (!wanted && existing && existing.dataset.running !== '1') existing.remove();
  }
}

/** Binds floor-button injection (idempotent). #chat is in ST's static template; if it doesn't exist when binding, the environment is broken, so give up. */
export function bindTagActionButtons(): boolean {
  if (bound) return true;
  // The observer is shared with card self-healing (floor/chatObserver.ts): don't observe the same tree twice;
  // the cost is on the browser's side of collecting MutationRecords, not on the callback side.
  if (!ensureChatObserver()) return false;
  bound = true;
  onChatMutation(syncButtons);
  syncButtons();
  return true;
}
