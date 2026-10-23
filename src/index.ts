import App from '@/App.vue';
import { bindAutoTagging } from '@/autoTag/runner';
import { bindTagActionButtons } from '@/floor/actionButton';
import { bindFloorHydration } from '@/floor/hydrate';
import { injectMenuButton } from '@/menu';
import { registerPublicInterface } from '@/public/register';
import { bindCharTagSync } from '@/state/charTags';
import { initGlobalCharTags } from '@/state/globalCharTags';
import { hydrateSettings } from '@/state/settings';
import { ui } from '@/state/ui';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { ensureImageTagRegexRegistered } from '@/st/imageTagRegex';
import { syncTopBarButton } from '@/topbar';
import { checkForUpdate } from '@/update';
import { versionedAssetUrl } from '@/version';
// These two lines make Vite bundle the global styles into dist/index.css (later injected into the shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import '@/styles/english.css';
import { createApp, watch } from 'vue';

const HOST_ID = 'bbi-app-host';

/**
 * Inheritable typography properties: shadow DOM does not isolate inheritance, so these leak in from ST through the host.
 * Pinned with inline !important on the host to cut the inheritance chain at the root.
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'font-variant': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  color: '#1c242c',
  direction: 'ltr',
};

function mount() {
  // The host element stays in ST's light DOM; the whole Vue app lives in its shadow root.
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  // The host takes no part in layout (the window uses fixed positioning inside) and cuts inheritance
  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.textContent = '';
  guardEditableArrowKeys(shadow);

  // Inject our built dist/index.css into the shadow root with a <link>,
  // so the styles apply only inside this shadow tree: ST's global styles can't get in, and ours can't get out.
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // index.js and index.css sit side by side in dist; derived from the current module URL, independent of deployment path.
  link.href = versionedAssetUrl('./index.css', import.meta.url);
  shadow.appendChild(link);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const app = createApp(App);
  app.mount(container);

  $(window).on('pagehide', () => app.unmount());
}

$(() => {
  mount();
  injectMenuButton();
  // Top-bar quick-open button: injected/removed per its toggle. The watch syncs whenever the toggle changes (including hydrate restoring the real value).
  syncTopBarButton(ui.showTopBar);
  watch(
    () => ui.showTopBar,
    on => syncTopBarButton(on),
  );
  // Hydrate settings only once ST's getContext is ready (poll when load order is uncertain)
  hydrateWhenReady();
});

async function hydrateWhenReady(attempt = 0) {
  if ((window as unknown as { SillyTavern?: { getContext?: unknown } }).SillyTavern?.getContext) {
    try {
      await hydrateSettings();
      // The global library must be initialised before bindCharTagSync: the first recomputation already merges global entries into the derived library
      initGlobalCharTags();
      bindCharTagSync();
      ensureImageTagRegexRegistered();
      bindAutoTagging();
      bindFloorHydration();
      bindTagActionButtons();
      // The public API must come after hydrateSettings: before settings are restored, getBackendStatus() reads
      // defaults and would report a configured user as "not configured". Coming after bindCharTagSync ensures
      // the revision in the ready event already matches the real character library.
      registerPublicInterface();
      void checkForUpdate();
      console.log(`[BaiBai Image] Loaded v${__BBI_VERSION__}, settings synchronized`);
    } catch (e) {
      console.error('[BaiBai Image] Settings failed to load', e);
    }
    return;
  }
  if (attempt > 40) return; // At most about 20s
  setTimeout(() => hydrateWhenReady(attempt + 1), 500);
}
