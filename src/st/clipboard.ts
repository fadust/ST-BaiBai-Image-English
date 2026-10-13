/**
 * 复制到剪贴板 —— 全项目统一入口。
 *
 * 手机常用局域网 HTTP 地址访问 ST，此时异步 Clipboard API 不可用；回退到隐藏
 * textarea + execCommand，和 ST 自身的复制工具保持同一兼容策略。
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
    toastr.error('Copy failed, please select text manually', 'BaiBai Image');
    return false;
  }
}
