import { openPanel } from '@/state/ui';

const MENU_ITEM_ID = 'bbi-menu-item';

/**
 * Injects the "BaiBai Image" entry at the end of ST's #extensionsMenu (wand menu).
 * The menu is lazy-loaded, so we poll until it appears; injecting once is enough.
 */
export function injectMenuButton() {
  const tryInject = () => {
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) return false;
    if ($(`#${MENU_ITEM_ID}`).length > 0) return true;

    const $item = $(`
      <div class="extension_container interactable" tabindex="0">
        <a id="${MENU_ITEM_ID}" class="list-group-item" href="#" title="BaiBai Image">
          <i class="fa-solid fa-palette"></i>
          <span> BaiBai Image </span>
        </a>
      </div>
    `);

    $item.on('click', (e: { preventDefault: () => void }) => {
      e.preventDefault();
      openPanel();
      // Close the wand menu after clicking, matching native behaviour
      $('#extensionsMenu').hide();
    });

    $menu.append($item);
    return true;
  };

  if (tryInject()) return;
  const timer = setInterval(() => {
    if (tryInject()) clearInterval(timer);
  }, 500);
}
