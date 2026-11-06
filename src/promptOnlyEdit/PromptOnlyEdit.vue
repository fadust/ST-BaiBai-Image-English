<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import type { ImageTagContent } from '@/st/imageTagRegex';
import { editPromptOnly } from './edit';
const props = defineProps<{ draft: ImageTagContent; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'result', value: ImageTagContent): void; (e: 'busy', value: boolean): void }>();
const hint = ref(''); const running = ref(false); const done = ref(false);
let controller: AbortController | null = null;
async function run() {
  if (running.value || props.disabled || !hint.value.trim()) return;
  controller = new AbortController(); const signal = controller.signal;
  running.value = true; done.value = false; emit('busy', true);
  try { const result = await editPromptOnly(props.draft, hint.value, signal); if (!signal.aborted) { emit('result', result); done.value = true; } }
  catch (error) { if (!signal.aborted) toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image'); }
  finally { running.value = false; controller = null; emit('busy', false); }
}
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <section class="bbi-prompt-only">
    <label>Changes to this prompt<BbiTextarea v-model="hint" :rows="2" :max-rows="5" :disabled="running" placeholder="For example: change the lighting to moonlight and keep everything else." /></label>
    <p class="bbi-field-hint">Sends only this draft and your instructions. Story text, character cards, and planning presets are not included.</p>
    <button v-if="!running" type="button" class="bbi-btn bbi-btn-sm" :disabled="disabled || !hint.trim()" @click="run">Edit prompt only</button>
    <button v-else type="button" class="bbi-btn bbi-btn-sm" @click="controller?.abort()">Cancel prompt edit</button>
    <p v-if="done" class="bbi-field-hint">The edited prompt is in the fields below. Review it, then choose Apply or Apply and regenerate.</p>
  </section>
</template>
