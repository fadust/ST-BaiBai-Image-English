import { h, render } from 'vue';

import ConfirmDialog from '@/components/ConfirmDialog.vue';

export interface ConfirmOptions {
  title: string;
  /** Body (plain text) */
  text: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'danger';
}

// Keep in sync with HOST_ID in index.ts: the plugin host element, whose shadow root holds dist/index.css
// and the --bbi-* theme variables; dialogs must mount there to be styled (mounting on document.body renders them unstyled).
const HOST_ID = 'bbi-app-host';

/**
 * Imperative confirm dialog for the chat side (floor buttons and other code outside templates), replacing the browser's native confirm.
 * Mounted in the plugin host's shadow root. When the plugin window is open, ConfirmDialog teleports to
 * modalHost (floating above the window); when it is closed, teleport is disabled and it renders in place. Both states work.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) {
    // No host means no dialog can open. Returning false would be treated by callers as "user cancelled" and silently dropped,
    // so at least log a line; otherwise the symptom is "clicked, nothing happened" with nothing to debug.
    console.warn('[BaiBai Image] The plug-in host is not available, and the confirmation pop-up window cannot be called out.', { hostId: HOST_ID, title: options.title });
    return Promise.resolve(false);
  }

  const container = document.createElement('div');
  root.appendChild(container);
  return new Promise(resolve => {
    const settle = (result: boolean) => {
      render(null, container);
      container.remove();
      resolve(result);
    };
    render(
      h(
        ConfirmDialog,
        {
          open: true,
          title: options.title,
          confirmText: options.confirmText,
          cancelText: options.cancelText,
          tone: options.tone,
          // When opened from the chat side it may sit above the plugin window or other dialogs
          topLayer: true,
          onConfirm: () => settle(true),
          onCancel: () => settle(false),
        },
        { default: () => options.text },
      ),
      container,
    );
  });
}
