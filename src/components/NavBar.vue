<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closePanel, ui } from '@/state/ui';
import { updateState } from '@/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// Mobile: tapping the current page's nav button again closes the whole window (saves reaching for the × at top right); other pages switch normally.
// Controlled by the ui.navTapClose toggle (on by default; users worried about mis-taps can turn it off in settings).
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closePanel();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav class="bbi-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbi-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbi-nav-icon-wrap">
        <Icon :name="p.id" class="bbi-nav-icon" />
        <span v-if="showUpdateDot(p.id)" class="bbi-nav-dot" aria-label="Updates available"></span>
      </span>
      <!-- Top bar shows labels; but on narrow (mobile) screens the top bar shows icons only, otherwise a row of labelled pills overflows and pushes later items off screen -->
      <span v-if="placement === 'top' && !narrow" class="bbi-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbi-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— Top: segmented pills, icon + label in a row —— */
.bbi-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbi-line);
}
.bbi-nav.is-top .bbi-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: transparent;
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-top .bbi-nav-item:hover {
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
}
.bbi-nav.is-top .bbi-nav-item.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.bbi-nav.is-top .bbi-nav-icon {
  font-size: 17px;
}

/* —— Top + narrow screen (mobile): degrade to icons only, styled exactly like the bottom nav (size/colour/selected state),
   just positioned at the top, so labelled pills don't overflow and push later items off screen —— */
.bbi-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.bbi-nav.is-top.is-narrow .bbi-nav-item {
  flex: 1;
  justify-content: center;
  gap: 0;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item:hover {
  background: transparent;
  color: var(--bbi-ink-muted);
}
.bbi-nav.is-top.is-narrow .bbi-nav-item.is-active {
  background: transparent;
  color: var(--bbi-accent);
}
.bbi-nav.is-top.is-narrow .bbi-nav-icon {
  font-size: 23px;
}

/* —— Bottom: icons only, equal widths, large touch targets —— */
.bbi-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--bbi-line);
  background: var(--bbi-surface);
}
.bbi-nav.is-bottom .bbi-nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease);
}
.bbi-nav.is-bottom .bbi-nav-icon {
  font-size: 23px;
}
.bbi-nav.is-bottom .bbi-nav-item.is-active {
  color: var(--bbi-accent);
}

.bbi-nav-item:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
  border-radius: var(--bbi-radius-sm);
}

.bbi-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bbi-nav-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-danger);
  box-shadow: 0 0 0 1.5px var(--bbi-surface);
  pointer-events: none;
}

</style>
