import { h, render } from 'vue';

import Lightbox from '@/floor/Lightbox.vue';

/**
 * Opens the image lightbox imperatively (called by floor cards).
 *
 * Mount point is the same as components/confirm.ts: the plugin host's shadow root, which holds dist/index.css
 * and the --bbi-* theme variables. Mounting on document.body would render it unstyled.
 *
 * Deliberately **not** mounted in the card's own shadow root: the lightbox is a fixed full-screen layer, while the card lives
 * inside .mes_text, whose stacking context and overflow would clip it.
 */

// Matches HOST_ID in index.ts
const HOST_ID = 'bbi-app-host';

export interface LightboxOptions {
  src: string;
  prompt?: string;
  filename?: string;
  /** The delete button only shows when this is provided; clicking delete closes the lightbox first, then calls back. */
  onDelete?: () => void;
}

/** Only one lightbox at a time; a repeat call closes the old one first. */
let closeCurrent: (() => void) | null = null;

export function openLightbox(options: LightboxOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);

  const close = () => {
    if (closeCurrent !== close) return; // Already replaced by a newer one; don't clean up twice
    closeCurrent = null;
    render(null, container);
    container.remove();
  };
  closeCurrent = close;

  render(
    h(Lightbox, {
      src: options.src,
      prompt: options.prompt,
      filename: options.filename,
      deletable: !!options.onDelete,
      onClose: close,
      onDelete: () => {
        close();
        options.onDelete?.();
      },
    }),
    container,
  );
}
