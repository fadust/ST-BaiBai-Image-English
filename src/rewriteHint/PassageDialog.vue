<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import ModalMask from '@/components/ModalMask.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import type { Passage } from './passage';
const props = defineProps<{ passages: Passage[]; existing: number; initial?: string[][]; initialHint?: string; drawn: Record<string, number[]> }>();
const emit = defineEmits<{ (e: 'submit', groups: string[][], hint: string): void; (e: 'close'): void; (e: 'save', groups: string[][], hint: string): void }>();
const open = ref(false);
const groups = ref<string[][]>(props.initial?.length ? props.initial.map(g => [...g]) : [[]]);
const active = ref(0);
const hint = ref(props.initialHint ?? '');
const count = computed(() => groups.value.filter(g => g.length).length);
function save() { emit('save', groups.value, hint.value); }
function toggle(id: string) {
  const group = groups.value[active.value];
  const index = group.indexOf(id);
  if (index >= 0) group.splice(index, 1); else group.push(id);
  save();
}
function removeGroup(i: number) {
  groups.value.splice(i, 1); if (!groups.value.length) groups.value.push([]);
  active.value = Math.min(active.value, groups.value.length - 1); save();
}
function key(event: KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); emit('close'); } }
onMounted(() => { document.addEventListener('keydown', key, true); requestAnimationFrame(() => open.value = true); });
onBeforeUnmount(() => document.removeEventListener('keydown', key, true));
</script>
<template>
  <ModalMask :open="open" top-layer @close="emit('close')">
    <div class="bbi-modal bbi-scenes" role="dialog" aria-modal="true" aria-label="Choose scenes to illustrate">
      <header class="bbi-modal-head"><span class="bbi-modal-title">{{ existing ? 'Add illustrations' : 'Choose scenes to illustrate' }}</span><button class="bbi-btn" @click="emit('close')">Close</button></header>
      <p>Select passages for each image. Each group produces one image. {{ existing ? 'Existing illustrations and their history are kept.' : '' }}</p>
      <div class="bbi-scene-groups">
        <span v-for="(group, i) in groups" :key="i">
          <button class="bbi-btn" :aria-pressed="active === i" @click="active = i">Image {{ i + 1 }} · {{ group.length }} selected</button>
          <button class="bbi-btn" :aria-label="`Remove image group ${i + 1}`" @click="removeGroup(i)">×</button>
        </span>
        <button class="bbi-btn" @click="groups.push([]); active = groups.length - 1; save()">+ Image group</button>
      </div>
      <div class="bbi-scene-passages">
        <label v-for="passage in passages" :key="passage.id" class="bbi-scene-passage">
          <input type="checkbox" :checked="groups[active].includes(passage.id)" @change="toggle(passage.id)" />
          <span><b>{{ passage.id }}</b><small v-if="drawn[passage.id]"> · Illustrated in image {{ drawn[passage.id].join(', ') }}</small><br />{{ passage.text }}</span>
        </label>
        <p v-if="!passages.length">No story passages are available in this message.</p>
      </div>
      <label>Additional instructions (optional)<BbiTextarea v-model="hint" :rows="2" :max-rows="5" placeholder="For example: focus on the reunion and keep both characters in frame." @update:model-value="save" /></label>
      <p class="bbi-field-hint">Selections are saved on this browser so you can return later.</p>
      <footer class="bbi-modal-foot">
        <button class="bbi-btn" @click="groups = [[]]; active = 0; hint = ''; save()">Clear selection</button>
        <button class="bbi-btn bbi-btn-primary" :disabled="!count" @click="emit('submit', groups, hint)">Generate {{ count }} {{ count === 1 ? 'image' : 'images' }}</button>
      </footer>
    </div>
  </ModalMask>
</template>
<style scoped>
.bbi-scenes { max-width: 900px; }
.bbi-scene-groups { display:flex; flex-wrap:wrap; gap:8px; }
.bbi-scene-groups [aria-pressed="true"] { border-color:var(--bbi-accent); }
.bbi-scene-passages { overflow:auto; min-height:120px; max-height:45vh; }
.bbi-scene-passage { display:flex; align-items:flex-start; gap:10px; padding:10px; border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent); white-space:pre-wrap; cursor:pointer; }
.bbi-scene-passage input { margin-top:5px; }
</style>
