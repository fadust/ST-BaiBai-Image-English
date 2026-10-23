import cardCss from '@/floor/card.css?raw';
import themeCss from '@/styles/theme.css?raw';

/**
 * Card stylesheet: built once and shared with every card's shadow root via adoptedStyleSheets.
 * N cards share the same CSSStyleSheet object: zero duplication, zero parse overhead.
 *
 * Why theme.css is included: tokens are defined under `.bbi-root[data-theme=…]` selectors,
 * but a card's shadow root has no .bbi-root ancestor (the shadow boundary blocks selector matching,
 * even though custom properties themselves inherit). So theme.css selectors are rewritten to :host,
 * and the tokens land on the card's own shadow root node.
 *
 * Rewrite rule: `.bbi-root[data-theme='x']` → `:host([data-theme='x'])`.
 * hydrate.ts writes data-theme on the host element, hence the attribute-selector form.
 * Descendant rules such as `.bbi-root[data-theme='pastel'] .bbi-checkbox` are converted along the way
 * (cards have no checkboxes, so they are harmless; not special-casing them is simpler).
 */

let sheet: CSSStyleSheet | null = null;
let fallbackCss: string | null = null;

function buildCss(): string {
  const scopedTheme = themeCss
    // Theme blocks with data-theme: .bbi-root[data-theme='night'] → :host([data-theme='night'])
    .replace(/\.bbi-root\[data-theme=('|")([a-z]+)\1\]/g, ':host([data-theme=$1$2$1])')
    // Bare .bbi-root (shared token block for fonts/radii/spacing) → :host
    .replace(/\.bbi-root(?![\w[-])/g, ':host');
  return `${scopedTheme}\n${cardCss}`;
}

/**
 * Gets the shared stylesheet. Environments supporting adoptedStyleSheets get a CSSStyleSheet;
 * otherwise null, and the caller falls back to cloning a <style> (see cardStyleTextFallback).
 */
export function cardStyleSheet(): CSSStyleSheet | null {
  if (sheet) return sheet;
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return null;
  try {
    const created = new CSSStyleSheet();
    created.replaceSync(buildCss());
    sheet = created;
    return sheet;
  } catch {
    return null;
  }
}

/** Fallback for old browsers: the style text, which the caller puts into a <style> in the shadow root. */
export function cardStyleTextFallback(): string {
  fallbackCss ??= buildCss();
  return fallbackCss;
}
