<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import { confirmDialog } from '@/components/confirm';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  builtinComfyPromptPair,
  comfyPromptSetFor,
  defaultComfyPromptPair,
  newComfyPromptSet,
  settings,
  type ComfyPromptPair,
  type ComfyWorkflowPreset,
} from '@/state/settings';

const props = defineProps<{ workflow: ComfyWorkflowPreset }>();
const selected = computed(() => comfyPromptSetFor(props.workflow));
const choices = computed(() => [
  { value: '', label: 'Dialect defaults' },
  ...settings.comfyui.promptSets
    .filter(set => set.dialect === props.workflow.specDialect)
    .map(set => ({ value: set.id, label: set.name })),
]);
const builtins = computed(() => builtinComfyPromptPair(props.workflow.specDialect));
const draft = ref<(ComfyPromptPair & { id: string; name: string }) | null>(null);
const title = computed(() => draft.value?.id ? 'Edit prompt set' : 'New prompt set');
const nameInput = ref<HTMLInputElement | null>(null);
const addButton = ref<HTMLButtonElement | null>(null);
const editButton = ref<HTMLButtonElement | null>(null);
let trigger: HTMLButtonElement | null = null;

function openEditor(edit: boolean) {
  const existing = selected.value;
  const source = existing ?? defaultComfyPromptPair(props.workflow.specDialect, settings.autoTag.prompts);
  draft.value = {
    id: edit && existing ? existing.id : '',
    name: edit && existing ? existing.name : '',
    specification: source.specification.trim() ? source.specification : builtins.value.specification,
    thinking: source.thinking.trim() ? source.thinking : builtins.value.thinking,
  };
  trigger = edit ? editButton.value : addButton.value;
  nextTick(() => nameInput.value?.focus());
}

function closeEditor() {
  draft.value = null;
  trigger?.focus();
  trigger = null;
}

function saveSet() {
  const edits = draft.value;
  if (!edits?.name.trim()) return;
  const { name, id, specification, thinking } = edits;
  const prompts = {
    specification: specification.trim() === builtins.value.specification.trim() ? '' : specification,
    thinking: thinking.trim() === builtins.value.thinking.trim() ? '' : thinking,
  };
  if (id) {
    const set = settings.comfyui.promptSets.find(set => set.id === id);
    if (!set) return;
    Object.assign(set, prompts, { name: name.trim() });
  } else {
    const set = newComfyPromptSet(name.trim(), props.workflow.specDialect, prompts);
    settings.comfyui.promptSets.push(set);
    props.workflow.promptSetId = set.id;
  }
  closeEditor();
}

async function deleteSet() {
  const set = selected.value;
  if (!set || draft.value?.id !== set.id) return;
  const confirmed = await confirmDialog({
    title: 'Delete prompt set',
    text: `Delete “${set.name}”? Workflows using it will return to their dialect defaults.`,
    confirmText: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;
  settings.comfyui.promptSets = settings.comfyui.promptSets.filter(item => item.id !== set.id);
  for (const workflow of settings.comfyui.workflows) {
    if (workflow.promptSetId === set.id) workflow.promptSetId = '';
  }
  trigger = addButton.value;
  closeEditor();
}
</script>

<template>
  <div class="prompt-set">
    <span class="bbi-field-label">Prompt set</span>
    <div class="prompt-set-picker">
      <BbiSelect
        :model-value="selected?.id ?? ''"
        :options="choices"
        aria-label="Prompt set"
        @update:model-value="workflow.promptSetId = $event"
      />
      <button
        ref="addButton"
        class="bbi-icon-btn"
        type="button"
        title="New prompt set"
        aria-label="New prompt set"
        @click="openEditor(false)"
      >
        <Icon name="plus" :size="14" />
      </button>
      <button
        ref="editButton"
        class="bbi-icon-btn"
        type="button"
        title="Edit prompt set"
        aria-label="Edit prompt set"
        :disabled="!selected"
        @click="openEditor(true)"
      >
        <Icon name="edit" :size="14" />
      </button>
    </div>
    <p class="bbi-field-hint">Share writing rules and a planning checklist across workflows that use this dialect.</p>
  </div>

  <ModalMask :open="!!draft" @close="closeEditor">
    <form
      v-if="draft"
      class="bbi-modal prompt-set-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      @submit.prevent="saveSet"
      @keydown.esc.stop.prevent="closeEditor"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">{{ title }}</span>
        <button class="bbi-icon-mini" type="button" aria-label="Close" title="Close" @click="closeEditor">
          <Icon name="close" />
        </button>
      </header>
      <label class="bbi-modal-field">
        <span class="bbi-modal-label">Name</span>
        <input ref="nameInput" v-model="draft.name" class="bbi-input" type="text" required />
      </label>
      <label class="bbi-modal-field">
        <span class="bbi-modal-label">Prompt specification</span>
        <BbiTextarea v-model="draft.specification" :rows="6" :max-rows="10" mono />
      </label>
      <label class="bbi-modal-field">
        <span class="bbi-modal-label">Planning checklist</span>
        <BbiTextarea v-model="draft.thinking" :rows="5" :max-rows="8" mono />
      </label>
      <p class="bbi-field-hint">Leave either field blank to use the built-in text. Edits apply to every workflow using this set.</p>
      <footer class="bbi-modal-foot">
        <button v-if="draft.id" class="bbi-btn bbi-btn-danger prompt-set-delete" type="button" @click="deleteSet">
          Delete set
        </button>
        <button class="bbi-btn" type="button" @click="closeEditor">Cancel</button>
        <button class="bbi-btn bbi-btn-primary" type="submit" :disabled="!draft.name.trim()">Save set</button>
      </footer>
    </form>
  </ModalMask>
</template>

<style scoped>
.prompt-set-picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.prompt-set-picker :deep(.bbi-select-box) {
  width: 100%;
  min-width: 0;
}
.prompt-set-modal {
  max-width: 680px;
}
.prompt-set-modal .bbi-modal-field {
  gap: 6px;
}
.prompt-set-modal .bbi-field-hint {
  margin: 0;
}
.prompt-set-modal .bbi-modal-foot {
  flex-wrap: wrap;
}
.prompt-set-delete {
  margin-right: auto;
  color: var(--bbi-danger);
}
.prompt-set-delete:hover {
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
</style>
