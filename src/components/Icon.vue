<script setup lang="ts">
import { computed } from 'vue';

/**
 * Inline SVG icons: no icon-font dependency, naturally works across the shadow DOM.
 * Unified 24×24 viewBox, stroke style (currentColor + stroke),
 * inheriting size and colour via CSS color / font-size (1em = current font size).
 * To add an icon: add a name -> inner <path>/<circle> markup entry to PATHS.
 */
const props = defineProps<{ name: string; size?: number | string }>();

// Path data only; the shared svg wrapper is in the template. Stroke style.
const PATHS: Record<string, string> = {
  // Channels page: plug/connection
  backend:
    '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-5.5 5.5A5.5 5.5 0 0 1 6.5 11.5V8z"/><path d="M12 17v4"/>',
  // Generate page: image (mountain + sun, the classic image icon)
  generate:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5 10 12l4 4 3-3 3.5 3.5"/>',
  // Prompts page: magic wand (automatic generation)
  prompt:
    '<path d="M6 21 17.5 9.5"/><path d="M15 4.5v3M15 12v.5M19.5 9h-3M11 9h-.5M17.7 5.3l-1.4 1.4M17.7 12.7l-1.4-1.4M12.3 5.3l1.4 1.4"/>',
  // WebUI page: server/chassis
  webui:
    '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4"/>',
  // ComfyUI page: connected nodes (workflow)
  comfyui:
    '<rect x="3.5" y="4" width="6" height="6" rx="1.2"/><rect x="14.5" y="14" width="6" height="6" rx="1.2"/><rect x="14.5" y="4" width="6" height="6" rx="1.2"/><path d="M9.5 7h5M17.5 10v4M12 17h2.5M6.5 10v4.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  // NAI page: quill
  nai: '<path d="M20 4c-5 0-11 3-13 9-1.2 3.6-1 5.5-1 7l-2 1"/><path d="M20 4c1 5-1 11-7 13-2 .8-4 .8-6 .5"/><path d="M20 4 9 15"/>',
  // Brush (brand mark/default floating-orb icon)
  palette:
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.4-2.2-.6-1.3.2-2.3 1.6-2.3h1.5a4 4 0 0 0 4-4C20.5 7.3 16.7 3.5 12 3.5z"/><circle cx="8" cy="9.5" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16" cy="9.5" r="1.1"/>',
  // Summary: document + text lines
  summary:
    '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h6M9 9h2"/>',
  // Characters: portrait
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // Request history: clock + rewind arrow at top left (time running backwards). Ink spans 3.5~20.5, the same scale as characters/settings
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 7.5V12l3 1.8"/>',
  // Gallery: stacked images (back card's edge showing + front card with mountain and sun), distinct from generate's single image
  gallery:
    '<path d="M7.5 3.5H19a1.5 1.5 0 0 1 1.5 1.5v11"/><rect x="3.5" y="6.5" width="13.5" height="12" rx="1.5"/><circle cx="7.3" cy="10.3" r="1.2"/><path d="M4 15.8 8 12l2.8 2.8 2-2 3.7 3.7"/>',
  // NPC roster (navigation): two portraits, distinct from the single-person characters
  npcs:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 4.8"/><path d="M17 14.8c2.3.5 3.9 2.3 3.9 4.7"/>',
  // Following: pushpin (mark/unmark companion)
  pin: '<path d="M12 2.5 9 5.5l1 1L7 13l-3 .5 3.5 3.5L11 14l6.5-3 1 1 3-3-6.5-6.5z"/><path d="M5 19l3.2-3.2"/>',
  // Main character: five-pointed star (outline = unmarked, can be lit)
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>',
  // Scene: mountain + sun
  scenes:
    '<circle cx="8" cy="8" r="2"/><path d="M3.5 19.5 9 12l4 5"/><path d="M11.5 19.5 16 13.5l4.5 6"/><path d="M3.5 19.5h17"/>',
  // Items: cube
  items:
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  // Settings: sliders
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // Variables: braces { }, for custom JSON variables, distinct from the settings sliders
  vars:
    '<path d="M9 4.5c-2 0-2 2.4-2 4 0 1.8-.8 2.9-2.5 3 1.7.1 2.5 1.2 2.5 3 0 1.6 0 4 2 4"/><path d="M15 4.5c2 0 2 2.4 2 4 0 1.8.8 2.9 2.5 3-1.7.1-2.5 1.2-2.5 3 0 1.6 0 4-2 4"/>',
  // Export/share: arrow up out of a tray
  upload: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // Import: arrow down into a tray
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // Copy: overlapping documents
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/>',
  // Bookmark (brand mark)
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  // Moon
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // Sun
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // Close
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // Check mark: confirm/save
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  // Add/plus
  plus: '<path d="M12 5v14M5 12h14"/>',
  // Show (open eye)
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // Hide (closed/struck-through eye)
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 5.8A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.8 15.8 0 0 1-3.3 3.9"/><path d="M6.3 8.1A15.9 15.9 0 0 0 2.5 12S6 18.5 12 18.5a8.5 8.5 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  // Down arrow (collapse indicator)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // Text lines: prompt panel toggle (floating button on floor cards)
  text: '<path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"/>',
  // More actions: vertical three dots (touch overflow button on floor cards; opens a vertical menu).
  // The component root is fill=none stroke style; the dots are too small and a stroke would make hollow rings, so this one overrides to solid.
  more: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none"/>',
  // Go to location: right arrow with a long shaft, distinct from the collapse chevron
  navigate: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/>',
  // Search: magnifying glass
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // Multi-select: checklist (check marks on the left + lines on the right, clearly "check several")
  checklist: '<path d="M3.5 6.5 5 8l2.5-2.5M3.5 12.5 5 14l2.5-2.5M3.5 18.5 5 20l2.5-2.5"/><path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5"/>',
  // Grid: library management entry (card grid), distinct from gallery's stacked images
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  // Lightning: instant (summarise now). The original y range was too full (top to bottom, looking tall);
  // compressed slightly around centre y=12 to ~4.0~20.0, matching the visual height of the magnifier/checklist (compressing too much looks short; middle ground).
  bolt: '<path d="M13 4 5 13h6l-1 7 8-9h-6z"/>',
  // Plans/suspense: flag
  plans: '<path d="M6 21V4M6 4.5h11l-2.5 3.5L17 11.5H6"/>',
  // Connect/test
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // Refresh/fetch
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // Delete/trash can: ink spans x 4~20 / y 4.5~19.5, aligned in optical size with copy (4~19 / 4~20) and download (4~20 / 4~20).
  // It used to reach only y 6~18.5, so next to copy/download in the same button group it looked a size smaller,
  // noticeable even with identical button pixel sizes. The body still narrows downward to lighten its visual weight.
  trash: '<path d="M4 6.5h16M9.5 6.5v-2h5v2M6.5 6.5l.9 13h9.2l.9-13"/>',
  // Edit/pencil: diagonal across 4.5~19.5, ink filling more than before, matching the trash can's visual weight (otherwise the pencil looks a size smaller)
  edit: '<path d="M4.5 19.5h4L19 9 15 5 4.5 15.5z"/><path d="M13 7 17 11"/>',
  // Sparkle/dreamy (pastel theme)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbi-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbi-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
