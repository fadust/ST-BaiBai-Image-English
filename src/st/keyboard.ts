const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const guardedRoots = new WeakSet<ShadowRoot>();

function pathContainsEditable(event: KeyboardEvent): boolean {
  return event.composedPath().some(node =>
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    (node instanceof HTMLElement && node.isContentEditable),
  );
}

/**
 * Stops arrow keys in editing controls inside the Shadow DOM from bubbling to ST's global shortcuts.
 * Only stops propagation, never preventDefault, so caret movement, option switching and number stepping still work normally.
 */
export function guardEditableArrowKeys(root: ShadowRoot): void {
  if (guardedRoots.has(root)) return;
  guardedRoots.add(root);
  root.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent) || !ARROW_KEYS.has(event.key)) return;
    // ST itself ignores arrow keys with modifiers; letting them through avoids breaking other global key combinations.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (pathContainsEditable(event)) event.stopPropagation();
  });
}
