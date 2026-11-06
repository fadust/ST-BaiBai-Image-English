<script setup lang="ts">
import { computed, ref } from 'vue';
import BbiCombo from '@/components/BbiCombo.vue';
import { FALLBACK_SAMPLERS, FALLBACK_SCHEDULERS, type ComfyModelLists } from '@/backends/comfyObjectInfo';
import { updateWorkflowField, workflowControls, type WorkflowField, type WorkflowModel } from '@/backends/comfyWorkflowControls';

const props = defineProps<{ modelValue: string; lists: ComfyModelLists | null; fetching: boolean; fetchStatus: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void; (e: 'fetch'): void }>();
const error = ref('');
const controls = computed(() => { try { return workflowControls(props.modelValue); } catch { return null; } });
const slots = computed(() => Array.from({ length: 6 }, (_, index) => controls.value?.loras[index]));
const samplers = computed(() => props.lists?.samplers.length ? props.lists.samplers : FALLBACK_SAMPLERS);
const schedulers = computed(() => props.lists?.schedulers.length ? props.lists.schedulers : FALLBACK_SCHEDULERS);
const loras = computed(() => ['None', ...(props.lists?.loras ?? []).filter(name => name !== 'None')]);
function models(model: WorkflowModel): string[] {
  return model.kind === 'checkpoint' ? props.lists?.checkpoints ?? [] : model.kind === 'gguf' ? props.lists?.ggufs ?? [] : props.lists?.unets ?? [];
}
function update(binding: WorkflowField, value: string | number) {
  try { const next = updateWorkflowField(props.modelValue, binding, value); error.value = ''; emit('update:modelValue', next); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function number(binding: WorkflowField, event: Event) {
  const input = event.target as HTMLInputElement;
  update(binding, input.value.trim() ? Number(input.value) : NaN);
  input.value = String(binding.value);
}
</script>
<template>
  <section class="workflow-controls">
    <div class="workflow-controls-head">
      <span class="bbi-field-label">Image generation controls</span>
      <button class="bbi-btn bbi-btn-sm" type="button" :disabled="fetching" @click="emit('fetch')">{{ fetching ? 'Loading lists…' : 'Refresh model and LoRA lists' }}</button>
    </div>
    <p class="bbi-field-hint">Changes save to this workflow. Keep the same model architecture when switching files.</p>
    <p v-if="fetchStatus" class="bbi-field-hint">{{ fetchStatus }}</p>
    <p v-if="!controls" class="bbi-field-hint">Paste valid API workflow JSON below to use these controls.</p>
    <template v-else>
      <label v-for="model in controls.models" :key="`${model.node}.${model.input}`" class="workflow-control-row">
        <span>{{ controls.models.length > 1 ? `Image model · ${model.title}` : 'Image model' }}</span>
        <BbiCombo :model-value="String(model.value)" :options="models(model)" placeholder="Model file name" :aria-label="controls.models.length > 1 ? `Image model · ${model.title}` : 'Image model'" @update:model-value="update(model, $event)" />
      </label>
      <p v-if="!controls.models.length" class="bbi-field-hint">No directly editable model loader was found. Linked model inputs stay in the JSON editor.</p>

      <div class="workflow-loras">
        <div v-for="(slot, index) in slots" :key="index" class="workflow-lora-row">
          <span>LoRA {{ index + 1 }}</span>
          <BbiCombo v-if="slot" :model-value="String(slot.name.value)" :options="loras" placeholder="None" :aria-label="`LoRA ${index + 1} file`" @update:model-value="update(slot.name, $event.trim() || 'None')" />
          <input v-else class="bbi-input" disabled value="No loader slot in this workflow" :aria-label="`LoRA ${index + 1} unavailable`" />
          <label class="workflow-strength">Strength<input class="bbi-input" type="number" step="0.05" :value="slot?.strength.value ?? 1" :disabled="!slot" :aria-label="`LoRA ${index + 1} strength`" @change="slot && number(slot.strength, $event)" /></label>
        </div>
      </div>
      <p class="bbi-field-hint">Choose None to disable a LoRA. Negative strengths are supported. LoRA order follows the workflow.</p>
      <p v-if="controls.loras.length < 6" class="bbi-field-hint">{{ controls.loras.length }} editable LoRA {{ controls.loras.length === 1 ? 'slot was' : 'slots were' }} found. To add more, add LoRA loaders in ComfyUI and export the workflow again.</p>
      <p v-if="controls.loras.length > 6" class="bbi-field-hint">Additional LoRA slots are preserved and can be edited in Workflow JSON.</p>

      <section v-for="(sampling, index) in controls.sampling" :key="index" class="workflow-sampling">
        <span class="bbi-field-label">{{ controls.sampling.length > 1 ? `Sampling · ${sampling.title}` : 'Sampling' }}</span>
        <div class="workflow-sampling-grid">
          <label v-if="sampling.sampler">Sampler<BbiCombo :model-value="String(sampling.sampler.value)" :options="samplers" :aria-label="`Sampler${controls.sampling.length > 1 ? ` ${index + 1}` : ''}`" @update:model-value="update(sampling.sampler, $event)" /></label>
          <label v-if="sampling.scheduler">Scheduler<BbiCombo :model-value="String(sampling.scheduler.value)" :options="schedulers" :aria-label="`Scheduler${controls.sampling.length > 1 ? ` ${index + 1}` : ''}`" @update:model-value="update(sampling.scheduler, $event)" /></label>
          <label v-if="sampling.steps">Steps<input class="bbi-input" type="number" min="1" step="1" :value="sampling.steps.value" :aria-label="`Steps${controls.sampling.length > 1 ? ` ${index + 1}` : ''}`" @change="number(sampling.steps, $event)" /></label>
          <label v-if="sampling.cfg">CFG<input class="bbi-input" type="number" min="0" step="0.1" :value="sampling.cfg.value" :aria-label="`CFG${controls.sampling.length > 1 ? ` ${index + 1}` : ''}`" @change="number(sampling.cfg, $event)" /></label>
        </div>
      </section>
      <p v-if="!controls.sampling.length" class="bbi-field-hint">No KSampler controls were found. Keep custom sampling nodes in Workflow JSON.</p>
    </template>
    <p v-if="error" class="workflow-controls-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.workflow-controls { display:flex; flex-direction:column; gap:12px; padding:14px; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:10px; margin-bottom:16px; }
.workflow-controls-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.workflow-control-row { display:grid; grid-template-columns:100px minmax(0,1fr); align-items:center; gap:10px; }
.workflow-loras { display:flex; flex-direction:column; gap:10px; }
.workflow-lora-row { display:grid; grid-template-columns:65px minmax(0,1fr) 110px; align-items:center; gap:10px; }
.workflow-strength { display:flex; flex-direction:column; gap:4px; font-size:12px; }
.workflow-strength input { width:100%; }
.workflow-sampling { display:flex; flex-direction:column; gap:8px; }
.workflow-sampling-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) 90px 90px; gap:10px; }
.workflow-sampling-grid label { display:flex; flex-direction:column; gap:5px; min-width:0; }
.workflow-controls-error { color:var(--bbi-danger,#d9534f); margin:0; }
@media(max-width:600px) { .workflow-control-row { grid-template-columns:1fr; } .workflow-lora-row { grid-template-columns:55px minmax(0,1fr); } .workflow-strength { grid-column:2; flex-direction:row; align-items:center; } .workflow-strength input { width:100px; } .workflow-sampling-grid { grid-template-columns:minmax(0,1fr) minmax(0,1fr); } }
</style>
