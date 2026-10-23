/**
 * Copy to clipboard: the single entry point for the whole project.
 *
 * Phones often reach ST over a LAN HTTP address, where the async Clipboard API is unavailable; fall back to a hidden
 * textarea + execCommand, the same compatibility strategy as ST's own copy helper.
 */
function legacyCopy(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);

  try {
    textArea.focus({ preventScroll: true });
    textArea.select();
    textArea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}

export async function copyText(text: string, okMessage = 'Copied'): Promise<boolean> {
  if (!text) return false;

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!legacyCopy(text)) throw new Error('Clipboard copy failed');
      }
    } else if (!legacyCopy(text)) {
      throw new Error('Clipboard copy failed');
    }

    toastr.success(okMessage, 'BaiBai Image');
    return true;
  } catch {
    toastr.error('Copy failed; select the text by hand', 'BaiBai Image');
    return false;
  }
}
