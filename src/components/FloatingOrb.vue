<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { openPanel, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

/**
 * Floating orb: BaiBai Image's "bookmark charm" reaching into the host page.
 *
 * Shape: a vertical ribbon with a swallowtail notch at the bottom (clip-path), echoing the brand's bookmark icon; custom images are
 * clipped to the same bookmark outline, so any image fits the unified shape (the signature touch that sets it apart from "yet another round fab").
 *
 * Behaviour (as users asked): free dragging; dropped mid-screen it stays mid-screen; only near the left/right edge does it snap to the edge.
 * When snapped it half-hides at the edge (only a narrow strip shows) and slides fully out on hover/focus/touch; mid-screen it is always shown.
 *
 * Position is stored in local localStorage (purely visual, and screen sizes differ per device; syncing would push it off screen).
 * The toggle and custom icon (ui.orbImage, a server path) sync across devices via settings.
 */

// Size follows shape + the user's base size (ui.orbSize): the bookmark uses a 0.78 width-to-height ratio (tall rectangle); circle/square are equal-sided.
// Drag/snap calculations and inline sizes all read it.
const orbW = computed(() => (ui.orbShape === 'bookmark' ? Math.round(ui.orbSize * 0.78) : ui.orbSize));
const orbH = computed(() => ui.orbSize);
const SNAP_ZONE = 56; // On release, within this distance of the left/right edge it snaps to the edge
const CLICK_SLOP = 6; // Movement below this counts as a click, not a drag
const POS_KEY = 'bbi.orb.pos.v1';

type Dock = 'left' | 'right' | 'none';
interface OrbPos {
  dock: Dock;
  /** Meaningless when snapped; in free mode it is the top-left x (px) */
  x: number;
  /** Top-left y (px), used in all three states */
  y: number;
}

function loadPos(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* ignore */
  }
  // Default: snapped to the right edge, vertically a little below centre
  return { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.6) };
}

const pos = reactive<OrbPos>(loadPos());
const dragging = ref(false);
const awake = ref(false); // hover/focus/drag → a snapped orb slides fully out
let activePointer: number | null = null;
let startX = 0;
let startY = 0;
let moved = 0; // Accumulated movement, for telling a click from a drag

// After entering the viewport, clamp the coordinates into the visible area (so it doesn't end up off screen after switching to a smaller screen/rotating)
function clampToViewport(): void {
  const maxY = Math.max(0, window.innerHeight - orbH.value);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - orbW.value);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// —— Positioning styles: snapped uses left/right anchoring + translateX for hide/show; free uses absolute x/y ——
const orbStyle = computed(() => {
  const base: Record<string, string> = {
    top: `${pos.y}px`,
    width: `${orbW.value}px`,
    height: `${orbH.value}px`,
    // Resting opacity goes through a CSS variable; the summoned/dragging states override it back to fully visible via classes
    '--orb-rest-opacity': String(Math.min(100, Math.max(20, ui.orbOpacity)) / 100),
    // Icon font size scales with the base size (the original 48 orb ≈ 22px), keeping the icon in proportion to the orb
    '--orb-icon-size': `${Math.round(ui.orbSize * 0.46)}px`,
  };
  if (pos.dock === 'left') {
    base.left = '0px';
    // Half-hidden at rest (~40% showing); slides fully out when dragged/summoned
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(-58%)';
  } else if (pos.dock === 'right') {
    base.right = '0px';
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(58%)';
  } else {
    base.left = `${pos.x}px`;
    base.transform = 'translateX(0)';
  }
  return base;
});

const orbImage = computed(() => ui.orbImage.trim());

// —— Dragging ——
function onDown(e: PointerEvent) {
  activePointer = e.pointerId;
  dragging.value = true;
  moved = 0;
  startX = e.clientX;
  startY = e.clientY;
  // Record the grab point of the finger relative to the top-left corner, kept while dragging
  grabDX = e.clientX - currentLeft();
  grabDY = e.clientY - pos.y;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

let grabDX = 0;
let grabDY = 0;

/** Actual x of the current top-left corner (in the edge-docked state converted from right/translate to absolute pixels, used to start a drag) */
function currentLeft(): number {
  if (pos.dock === 'right') return window.innerWidth - orbW.value;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function onMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY));
  // While dragging always switch to free and follow the finger (fully visible)
  pos.dock = 'none';
  pos.x = e.clientX - grabDX;
  pos.y = e.clientY - grabDY;
  clampToViewport();
}

function onUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;

  if (moved < CLICK_SLOP) {
    // Treated as a click → open BaiBai Image (the edge-docked state is kept)
    openPanel();
    return;
  }

  // Snap check on release: dock only near the left/right edge, otherwise stay where it is (in the middle)
  const left = pos.x;
  const right = window.innerWidth - (pos.x + orbW.value);
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  savePos();
}

// —— Keyboard access ——
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPanel();
  }
}

const onResize = () => {
  clampToViewport();
  savePos();
};
onMounted(() => {
  clampToViewport();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div
    class="bbi-orb"
    :class="[`shape-${ui.orbShape}`, { 'is-dragging': dragging, 'has-image': !!orbImage }]"
    :style="orbStyle"
    role="button"
    tabindex="0"
    aria-label="Open BaiBai Image"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerenter="awake = true"
    @pointerleave="awake = false"
    @focus="awake = true"
    @blur="awake = false"
    @keydown="onKey"
  >
    <img v-if="orbImage" :src="orbImage" class="bbi-orb-img" alt="" draggable="false" />
    <Icon v-else name="palette" class="bbi-orb-icon" />
  </div>
</template>

<style scoped>
.bbi-orb {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbi-surface);
  color: var(--bbi-accent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* drop-shadow follows the outline of both clip-path (bookmark) and border-radius (circle/square), so it is used for all */
  filter: drop-shadow(0 6px 14px oklch(0 0 0 / 0.28));
  opacity: var(--orb-rest-opacity, 0.62);
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    opacity var(--bbi-dur) var(--bbi-ease);
}

/* —— Shapes —— */
/* Bookmark: ribbon outline + swallowtail notch at the bottom. clip-path naturally clips custom images. */
.bbi-orb.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
}
/* Circle / square: border-radius + overflow clip custom images */
.bbi-orb.shape-circle {
  border-radius: 999px;
  overflow: hidden;
}
.bbi-orb.shape-square {
  border-radius: 12px;
  overflow: hidden;
}

/* Invoked (hover/focus/drag) or resting mid-screen (free) → fully shown */
.bbi-orb:hover,
.bbi-orb:focus-visible,
.bbi-orb.is-dragging {
  opacity: 1;
}
.bbi-orb:focus-visible {
  outline: none;
  color: var(--bbi-accent);
}
.bbi-orb:active {
  cursor: grabbing;
}

.bbi-orb-icon {
  font-size: var(--orb-icon-size, 22px);
  pointer-events: none;
}
/* Bookmark: icon moved up to avoid the swallowtail notch at the bottom (circle/square have no notch; centred is fine) */
.bbi-orb.shape-bookmark .bbi-orb-icon {
  margin-bottom: 6px;
}

.bbi-orb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bbi-orb {
    transition: none;
  }
}
</style>
