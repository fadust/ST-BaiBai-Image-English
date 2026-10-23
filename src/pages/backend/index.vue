<script setup lang="ts">
import { BACKENDS, settings, type BackendId } from '@/state/settings';
import { computed, ref, watch, type Component } from 'vue';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import NaiPanel from './panels/NaiPanel.vue';
import WebUIPanel from './panels/WebUIPanel.vue';

// Channels page: the tabs only decide "which panel to view" (pure browsing, local state, initially follows the current image channel).
// The real choice is each panel's "Use this channel for images" button (shows "Current image channel" once selected)
// and the settings page's "Image backend" dropdown. Both read and write settings.defaultBackend, so a change in either is followed automatically.
// webui is not available yet: its entry is hidden (code kept for later); merge has migrated stored webui values away, so a matching tab always exists.
const VISIBLE_BACKENDS = BACKENDS.filter(b => b.value !== 'webui');

// Which channel tab was viewed last: same idea as activePage, purely local browsing state, stored in localStorage,
// not in settings.json (writing to the server on every tab switch is too frequent, and syncing across devices is pointless).
const TAB_STORAGE_KEY = 'bbi.backend.tab.v1';

function loadViewing(): BackendId | null {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return VISIBLE_BACKENDS.some(b => b.value === v) ? (v as BackendId) : null;
  } catch {
    return null;
  }
}

// Priority: last viewed tab > current image channel > first visible tab.
const viewing = ref<BackendId>(
  loadViewing() ??
    (VISIBLE_BACKENDS.some(b => b.value === settings.defaultBackend)
      ? settings.defaultBackend
      : VISIBLE_BACKENDS[0].value),
);

watch(viewing, v => {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, v);
  } catch {
    /* Silent when localStorage is unavailable */
  }
});

const PANELS: Record<BackendId, Component> = {
  webui: WebUIPanel,
  comfyui: ComfyUIPanel,
  nai: NaiPanel,
};
const activePanel = computed(() => PANELS[viewing.value]);
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Backend</h2>
      <div class="bbi-segmented" role="tablist" aria-label="Image backends">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': viewing === b.value }"
          type="button"
          role="tab"
          :aria-selected="viewing === b.value"
          @click="viewing = b.value"
        >
          {{ b.label }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive: keeps each panel's collapse/input state when switching channels -->
    <KeepAlive>
      <component :is="activePanel" :key="viewing" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* On narrow screens the title and channel segmented control take two rows instead of squeezing */
.bbi-page-head {
  flex-wrap: wrap;
}
</style>
