<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import NavBar from '@/components/NavBar.vue';
import FloatingOrb from '@/components/FloatingOrb.vue';
import { getPage } from '@/pages/registry';
import { closePanel, cycleTheme, lastOpenedAt, modalHost, THEMES, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';

// Title-bar theme button: shows the icon and name of the "next" theme; clicking switches to it
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// Whether the screen is narrow (mobile): used for nav 'auto' orientation + the drawer gesture switch.
// Vue doesn't track matchMedia changes automatically; a ref bridges it into reactivity.
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));

// —— Mask click closes: only when both press and release happen on the mask itself.
// Avoids: 1) the synthetic click from the mobile open gesture passing through and closing instantly; 2) pressing inside the window, dragging outside and closing by mistake.
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closePanel();
  pressedOnOverlay = false;
}

// —— Mobile: swipe down to close the drawer ——
const dragY = ref(0); // Current pull-down offset (px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // Releasing beyond this offset closes

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // Only follows downward offset
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closePanel();
  }
  dragY.value = 0;
}

// Drawer follow-the-finger style: transitions off while dragging, on for the spring-back after release
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbi-root" :data-theme="ui.theme">
    <!-- Dialog Teleport host: direct child of .bbi-root, outside the .bbi-body scroll container.
         Dialogs from every page teleport here, avoiding iOS's "fixed descendants misplaced inside a scrollable ancestor" (see state/ui.ts). -->
    <div ref="modalHost"></div>
    <!-- Floating orb: must stay inside the shadow root to use the --bbi-* theme variables; it is position:fixed to the edge itself, unaffected by the host -->
    <FloatingOrb v-if="ui.showOrb" />
    <Transition name="bbi-fade">
      <div
        v-if="ui.open"
        class="bbi-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        @keydown.esc="closePanel"
        tabindex="-1"
      >
        <!-- The window lives permanently inside the mask (no separate v-if, no nested Transition):
             with nested Transitions, when parent and child v-if flip at the same time the child's leave doesn't fire (measured: the window was removed with the parent,
             with no animation at all). Instead the mask Transition's classes drive the window's enter/leave animation as descendant selectors
             (see .bbi-window under .bbi-fade-enter-from/.bbi-fade-leave-to in <style>). -->
        <div class="bbi-window" :style="windowStyle" role="dialog" aria-modal="true" aria-label="BaiBai Image">
            <!-- Mobile grab handle: swipe down to close -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbi-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbi-grabber-bar"></span>
            </div>

            <!-- Title bar -->
            <header class="bbi-head">
              <span class="bbi-brand-name">BaiBai Image</span>
              <div class="bbi-head-actions">
                <button class="bbi-icon-btn" type="button" :title="`Switch theme: ${nextTheme.label}`" @click="cycleTheme">
                  <Icon :name="nextTheme.icon" />
                </button>
                <button class="bbi-icon-btn" type="button" title="Close" @click="closePanel">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" :narrow="narrowFlag" />

            <main class="bbi-body">
              <Transition name="bbi-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" :narrow="narrowFlag" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— Mobile grab handle: hidden on desktop —— */
.bbi-grabber {
  display: none;
}

.bbi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  flex: 0 0 auto;
}

.bbi-brand-name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--bbi-ink);
}

.bbi-head-actions {
  display: flex;
  gap: 8px;
}
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
.bbi-icon-btn:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}

/* —— Transitions: the mask fades in/out; the window follows via the mask's transition classes (see below) —— */
.bbi-fade-enter-active,
.bbi-fade-leave-active {
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-fade-enter-from,
.bbi-fade-leave-to {
  opacity: 0;
}

/* Window enter/leave: driven by the mask Transition's classes as descendant selectors (the window no longer has its own Transition:
   when parent and child v-if flip together, the child Transition's leave doesn't fire; measured, the window was removed without animation).
   The same transform at both ends → symmetrical. On PC a slight rise + slight scale; on mobile the media query changes it to sliding back to the bottom. */
.bbi-fade-enter-from .bbi-window,
.bbi-fade-leave-to .bbi-window {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbi-page-enter-active,
.bbi-page-leave-active {
  transition:
    opacity 0.13s var(--bbi-ease),
    transform 0.13s var(--bbi-ease);
}
.bbi-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbi-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* Window transition: shared by enter/leave (transform+opacity) and drag spring-back (transform);
   while dragging, an inline transition:none overrides it; the spring-back after release uses this one again. */
.bbi-window {
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    opacity var(--bbi-dur) var(--bbi-ease);
}

/* ============ Mobile: grab handle + drawer slide-up entrance ============ */
@media (max-width: 640px) {
  .bbi-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbi-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbi-radius-pill);
    background: var(--bbi-line-strong);
  }
  .bbi-head {
    padding: 4px 16px 12px;
  }
  /* Drawer slides in from / back to the bottom (pure translation, no fading) */
  .bbi-fade-enter-from .bbi-window,
  .bbi-fade-leave-to .bbi-window {
    opacity: 1;
    transform: translateY(100%) scale(1);
  }
  /* The mask's leave fade is delayed: the drawer slides back to the bottom first and the backdrop leaves after; otherwise the window turns transparent with the mask,
     and the slide can't be seen (the window is a child of the mask, and the parent's opacity composites onto the child). */
  .bbi-fade-leave-active {
    transition: opacity 0.16s var(--bbi-ease) 0.18s;
  }
  /* The window's slide back to the bottom runs the full --bbi-dur, unaffected by the mask's shorter duration above (each transition is independent; just emphasised here) */
}
</style>
