import { openPanel } from '@/state/ui';
import { ensureIconFallback } from '@/st/iconFallback';

const BTN_ID = 'bbi-topbar-button';
const STYLE_ID = 'bbi-topbar-style';

function ensureStyle(): void {
  // Custom themes may blank the top-bar icon glyphs; restore them with a high-specificity selector (see iconFallback)
  ensureIconFallback(STYLE_ID, `#top-settings-holder #${BTN_ID} .drawer-icon.fa-solid`);
}

/**
 * Injects a drawer button into ST's top bar (#top-settings-holder) for quickly opening BaiBai Image,
 * positioned left of "Persona Management" (#persona-management-button).
 *
 * The injected button **is not in the shadow DOM**: it uses ST's .drawer / .drawer-icon classes directly,
 * following the SillyTavern theme. Clicking only opens the BaiBai Image window and expands no drawer (hence no .drawer-toggle,
 * so ST's doNavbarIconClick doesn't treat it as a drawer to open/close).
 *
 * Controlled by a settings toggle: on → ensure it's injected; off → remove it. Polls until the top bar appears (the top bar loads lazily).
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'drawer';
  btn.innerHTML = `
    <div class="drawer-toggle">
      <div class="drawer-icon fa-solid fa-palette fa-fw closedIcon" title="BaiBai Image"></div>
    </div>
  `;
  // Only opens the window, without ST's drawer open/close logic (hence doNavbarIconClick from .drawer-toggle isn't attached)
  btn.querySelector('.drawer-toggle')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openPanel();
  });
  return btn;
}

/** Performs the insertion: returns true on success or if it already exists, false if the top bar isn't ready (retried by polling). */
function tryInject(): boolean {
  const holder = document.getElementById('top-settings-holder');
  if (!holder) return false;
  if (document.getElementById(BTN_ID)) return true;

  ensureStyle();
  const btn = buildButton();
  // Insert left of "Persona Management"; if that hasn't rendered yet, fall back to appending to the end of the top bar.
  const persona = document.getElementById('persona-management-button');
  if (persona) persona.before(btn);
  else holder.appendChild(btn);
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
}

/** Syncs the top-bar button's presence with the toggle. Just call it when the toggle changes (idempotent). */
export function syncTopBarButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    removeButton();
    return;
  }
  if (tryInject()) return;
  // The top bar loads lazily: poll until it appears. It is static structure in index.html, so it usually hits on the first try and the timer never starts;
  // if it never appears, give up after a cap of ~20s (40 tries), never spinning idle forever (same pattern as bindMemoryWhenReady in index.ts).
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 500);
}
