<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import ModalMask from '@/components/ModalMask.vue';
import { copyText } from '@/st/clipboard';

import type { PromptVersion } from './versions';


const props = defineProps<{
  floor: number;
  seq: number;
  current: string;
  versions: Array<PromptVersion & { text: string; diff: { added: string[]; removed: string[] } }>;
  closing?: boolean;
}>();

const emit = defineEmits<{
  (e: 'restore', hash: string): void;
  (e: 'close'): void;
}>();

const open = ref(false);
const expanded = ref<string | null>(null);

function when(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function copy(text: string): void {
  void copyText(text);
}

function hideBroken(event: Event): void {
  (event.target as HTMLElement).style.visibility = 'hidden';
}

watch(
  () => props.closing,
  value => {
    if (value) open.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  emit('close');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  requestAnimationFrame(() => {
    open.value = true;
  });
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <ModalMask :open="open" top-layer @close="emit('close')">
    <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Prompt history">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">Prompt history · Message {{ floor }}, image {{ seq + 1 }}</span>
      </header>
      <p class="bbi-pv__tip">Restore a previous prompt to see its associated images again. The current version is kept so you can switch back.</p>
      <section class="bbi-pv__item bbi-pv__item--now">
        <div class="bbi-pv__meta"><b>Current prompt</b></div>
        <p class="bbi-pv__text">{{ current }}</p>
      </section>
      <p v-if="!versions.length" class="bbi-pv__tip">No earlier prompt versions for this image.</p>
      <section v-for="version in versions" :key="version.hash" class="bbi-pv__item">
        <div class="bbi-pv__row">
          <img v-if="version.thumb" class="bbi-pv__thumb" :src="version.thumb" alt="" loading="lazy" @error="hideBroken" />
          <div class="bbi-pv__body">
            <div class="bbi-pv__meta">
              {{ when(version.lastAt) }} · {{ version.count ? `${version.count} generated images` : 'No images generated' }}
            </div>
            <div v-if="version.diff.added.length" class="bbi-pv__diff bbi-pv__diff--add">Only in this version: {{ version.diff.added.join(', ') }}</div>
            <div v-if="version.diff.removed.length" class="bbi-pv__diff bbi-pv__diff--del">Only in the current version: {{ version.diff.removed.join(', ') }}</div>
          </div>
        </div>
        <p
          class="bbi-pv__text"
          :class="{ 'is-open': expanded === version.hash }"
          @click="expanded = expanded === version.hash ? null : version.hash"
        >
          {{ version.text }}
        </p>
        <div class="bbi-pv__actions">
          <button class="bbi-btn" type="button" @click="copy(version.text)">Copy</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="emit('restore', version.hash)">Restore version</button>
        </div>
      </section>
      <footer class="bbi-modal-foot">
        <span class="bbi-pv__spacer"></span>
        <button class="bbi-btn" type="button" @click="emit('close')">Close</button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbi-pv__tip {
  margin: 0;
  font-size: 12.5px;
  opacity: 0.8;
}

.bbi-pv__item {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 10px;
}

.bbi-pv__item--now {
  border-color: var(--bbi-accent, #7c9cff);
}

.bbi-pv__row {
  display: flex;
  gap: 10px;
}

.bbi-pv__thumb {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 6px;
}

.bbi-pv__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.bbi-pv__meta {
  font-size: 12.5px;
  opacity: 0.8;
}

.bbi-pv__diff {
  font-size: 12px;
  word-break: break-word;
}

.bbi-pv__diff--add {
  color: #3aa66b;
}

.bbi-pv__diff--del {
  color: #d9534f;
}

.bbi-pv__text {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  font-size: 12.5px;
  word-break: break-word;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  cursor: pointer;
}

.bbi-pv__text.is-open {
  display: block;
}

.bbi-pv__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.bbi-pv__spacer {
  flex: 1 1 auto;
}
</style>
