/**
 * Icon-font fallback: some SillyTavern custom themes blank the icon-font glyphs of .drawer-icon.fa-solid::before (or similar)
 * in the top bar/chat box (content:'', color:transparent, font-size:0) and instead paste custom icons via background-image
 * **per button id**. Buttons we inject are not on their list and would turn blank.
 *
 * Here a higher specificity (ancestor id + own id) + !important overrides that generic rule and forces the glyph back.
 * \f53f = the Unicode for fa-palette (taken from ST's fontawesome.min.css; don't guess from memory).
 *
 * Shared by every injection point: pass your button id and the icon element's selector to generate a one-off <style>.
 */
const PALETTE = '\\f53f';
const injected = new Set<string>();

/**
 * Ensures a button's icon fallback style is injected (deduplicated by styleId, safe to call repeatedly).
 * @param styleId   id of the <style> element (dedup key)
 * @param selector  high-specificity selector matching the button icon's ::before (without ::before)
 */
export function ensureIconFallback(styleId: string, selector: string): void {
  if (injected.has(styleId) || document.getElementById(styleId)) {
    injected.add(styleId);
    return;
  }
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
${selector}::before {
  content: '${PALETTE}' !important;
  width: auto !important;
  height: auto !important;
  font-size: inherit !important;
  color: inherit !important;
  background: none !important;
}
`;
  document.head.appendChild(style);
  injected.add(styleId);
}
