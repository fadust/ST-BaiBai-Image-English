<script setup lang="ts">
import { ref } from 'vue';

import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { copyText } from '@/st/clipboard';

import { formatCharForCopy, parseCharPaste, pasteKeyLabel, type CharCopyKey, type CharCopySource } from './format';


const props = defineProps<{ source: CharCopySource }>();

const emit = defineEmits<{ (e: 'apply', values: Partial<Record<CharCopyKey, string>>): void }>();

const pasteOpen = ref(false);
const pasteText = ref('');

function copy(): void {
  void copyText(formatCharForCopy(props.source), 'Appearance copied. Review it with an image-capable AI, then paste the revised profile here.');
}

async function openPaste(): Promise<void> {
  pasteText.value = '';
  pasteOpen.value = true;

  try {
    if (window.isSecureContext && navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text && !pasteText.value) pasteText.value = text;
    }
  } catch {

  }
}

function apply(): void {
  const { values, name } = parseCharPaste(pasteText.value);
  const keys = Object.keys(values) as CharCopyKey[];
  if (!keys.length) {
    toastr.warning('No profile fields found. Keep the field labels, such as [Hair], when pasting a profile.', 'BaiBai Image');
    return;
  }
  emit('apply', values);
  pasteOpen.value = false;
  const nameNote = name && name !== props.source.name.trim() ? ` (the pasted profile is for ${name}; the character name was kept)` : '';
  toastr.success(
    `Updated ${keys.length} fields: ${keys.map(pasteKeyLabel).join(', ')}${nameNote}. Review the draft, then save the character.`,
    'BaiBai Image',
  );
}
</script>

<template>
  <div class="bbi-char-copy">
    <button
      class="bbi-btn bbi-btn-sm"
      type="button"
      title="Copy a labeled profile for review against a reference image"
      @click="copy"
    >
      <Icon name="copy" /> Copy appearance
    </button>
    <button
      class="bbi-btn bbi-btn-sm"
      type="button"
      title="Paste a revised profile into the matching draft fields"
      @click="openPaste"
    >
      <Icon name="edit" /> Paste appearance
    </button>
  </div>

  <ConfirmDialog
    v-model:open="pasteOpen"
    title="Paste appearance profile"
    confirm-text="Update draft"
    top-layer
    @confirm="apply"
  >
    Paste the complete revised profile below. Field labels determine where values go. Omitted fields stay unchanged; write None to clear a field.
    <BbiTextarea
      v-model="pasteText"
      class="bbi-char-copy__input"
      :rows="8"
      :max-rows="14"
      mono
      placeholder="[Gender] 1woman&#10;[Hair] long black hair&#10;[Appearance description] An adult woman with …"
    />
  </ConfirmDialog>
</template>

<style scoped>
.bbi-char-copy {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.bbi-char-copy__input {
  display: block;
  width: 100%;
  margin-top: 8px;
}
</style>
