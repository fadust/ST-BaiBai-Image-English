<script setup lang="ts">
import {
  COMFY_TEMPLATE_OPTIONS,
  COMFY_TEMPLATES,
  isComfyTemplateId,
  simpleDefaults,
  validateSimpleConfig,
  type ComfyPresetMode,
} from '@/backends/comfyTemplates';
import {
  FALLBACK_SAMPLERS,
  FALLBACK_SCHEDULERS,
  fetchComfyModelLists,
  type ComfyModelLists,
} from '@/backends/comfyObjectInfo';
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import {
  configureWorkflowWithAi,
  type WorkflowAssistResult,
  type WorkflowBindingPurpose,
} from '@/backends/comfyWorkflowAssistant';
import BbiCombo from '@/components/BbiCombo.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  activeComfyPreset,
  effectiveComfyConn,
  newComfyWorkflow,
  ORIENTATION_LOCKS,
  settings,
} from '@/state/settings';
import { computed, nextTick, ref, watch } from 'vue';

const testing = ref(false);
const configuring = ref(false);
const assistOpen = ref(false);
const assistDraft = ref('');
const assistResult = ref<WorkflowAssistResult | null>(null);
/** AI 预览针对哪一套:预览期间用户可能切走或删掉,应用时按 id 回写而不是写「当前」。 */
const assistTargetId = ref('');
const confirmDeleteOpen = ref(false);

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

/* ============ 工作流库 ============ */

/** 当前预设。settings 是 reactive,直接把它的字段绑 v-model 即可就地编辑。 */
const active = computed(() => activeComfyPreset());

const workflowOptions = computed(() =>
  settings.comfyui.workflows.map(w => ({ value: w.id, label: w.name || 'Unnamed workflow' })),
);

/**
 * 下拉的值取「实际生效的那一套」而非存的 id:存的 id 悬空时
 * activeComfyPreset 会回落第一条,下拉也该跟着显示第一条,不能显示空白。
 */
const activeId = computed<string>({
  get: () => active.value.id,
  set: id => {
    settings.comfyui.activeWorkflowId = id;
  },
});

/** 只剩一套时不给删:workflows 恒非空是全局不变式,禁用比「点了没反应」诚实。 */
const canRemove = computed(() => settings.comfyui.workflows.length > 1);

function switchTo(preset: { id: string }) {
  settings.comfyui.activeWorkflowId = preset.id;
}

/** 改名是低频操作:平时只显示下拉,点「改名」才把选择器原地换成输入框,省掉常驻的名称行。 */
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename() {
  renameDraft.value = active.value.name;
  renaming.value = true;
  nextTick(() => renameInput.value?.focus());
}

/** Enter / 失焦都算确认;Esc 直接置 renaming=false 不经过这里,即为取消。 */
function commitRename() {
  if (renaming.value) active.value.name = renameDraft.value.trim();
  renaming.value = false;
}

function addWorkflow() {
  const preset = newComfyWorkflow(`Workflow ${settings.comfyui.workflows.length + 1}`);
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}

function duplicateWorkflow() {
  // 拷全部字段(JSON/开关/尺寸一起复制),只换 id 与名字;id 生成仍由 settings 统一口径。
  // simple 是嵌套对象(含 loras 数组),必须深拷——浅拷会让两套预设共享同一份参数。
  const preset = {
    ...active.value,
    id: newComfyWorkflow().id,
    name: `${active.value.name} copy`,
    simple: {
      ...active.value.simple,
      loras: active.value.simple.loras.map(lora => ({ ...lora })),
    },
  };
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}

function confirmRemoveWorkflow() {
  confirmDeleteOpen.value = false;
  const list = settings.comfyui.workflows;
  if (list.length <= 1) return;
  const index = list.findIndex(w => w.id === active.value.id);
  if (index < 0) return;
  list.splice(index, 1);
  // 删掉的是当前项:接位到原位置那一条(已是最后一条则退一格)
  settings.comfyui.activeWorkflowId = list[Math.min(index, list.length - 1)].id;
}

/* ============ 简易模式:选模型填参数 ============ */

// 分段开关文案要短(括注会让小药丸挤变形),含义靠下方的表单本身说明;
// 顺序:默认项 custom 在左(与「存量预设/新预设都是自定义工作流」的口径一致)
const modeOptions: Array<{ value: ComfyPresetMode; label: string }> = [
  { value: 'custom', label: 'Custom workflow' },
  { value: 'simple', label: 'Simple parameters' },
];

const templateOptions = COMFY_TEMPLATE_OPTIONS;

/** 当前模板的元数据(决定表单显示哪些字段)。 */
const meta = computed(() => COMFY_TEMPLATES[active.value.simple.template] ?? COMFY_TEMPLATES.checkpoint);

const lists = ref<ComfyModelLists | null>(null);
const fetching = ref(false);
const fetchError = ref('');

async function onFetchModels(silent = false) {
  if (fetching.value) return;
  fetching.value = true;
  fetchError.value = '';
  try {
    lists.value = await fetchComfyModelLists(settings.comfyui.url, { force: !!lists.value });
    if (!silent) {
      toastr.success(
        lists.value.mode === 'server'
          ? 'The model list has been pulled (ST forwarded; LoRA/CLIP needs to enter the file name manually)'
          : 'Pulled model list',
        'BaiBai Image',
      );
    }
  } catch (error) {
    fetchError.value = errorMessage(error);
    if (!silent) toastr.error(fetchError.value, 'Failed to pull model list');
  } finally {
    fetching.value = false;
  }
}

// 进入简易模式且手上没有列表时自动拉一次(静默,失败只在状态行留原因)
watch(
  () => [active.value.id, active.value.mode] as const,
  () => {
    if (active.value.mode === 'simple' && !lists.value && !fetching.value && settings.comfyui.url.trim()) {
      void onFetchModels(true);
    }
  },
  { immediate: true },
);

// 状态行只在「有话要说」时出现:直连拉成功是常态,静默(候选已进 datalist);
// 转发模式要提醒 LoRA/CLIP 拿不到;失败要留原因。手动点按钮的正反馈由 toastr 负责。
const fetchStatus = computed(() => {
  if (fetchError.value) return `Pull failed:${fetchError.value}`;
  if (!lists.value || lists.value.mode === 'browser') return '';
  return 'ST forwarding cannot get the LoRA/CLIP list, these two items need to be entered manually (ComfyUI plus --enable-cors-header can be directly connected)';
});

const modelOptions = computed(() => {
  if (!lists.value) return [];
  return meta.value.modelKind === 'checkpoint'
    ? lists.value.checkpoints
    : [...lists.value.unets, ...lists.value.ggufs];
});
const vaeOptions = computed(() => lists.value?.vaes ?? []);
const clipOptions = computed(() => lists.value?.clips ?? []);
const loraOptions = computed(() => lists.value?.loras ?? []);
const samplerOptions = computed(() =>
  lists.value?.samplers.length ? lists.value.samplers : FALLBACK_SAMPLERS,
);
const schedulerOptions = computed(() =>
  lists.value?.schedulers.length ? lists.value.schedulers : FALLBACK_SCHEDULERS,
);

// 选了列表里的 GGUF 文件自动勾选 GGUF;选回普通 unet 自动取消(手输的名字不动开关)
watch(
  () => active.value.simple.model,
  name => {
    if (!lists.value || meta.value.modelKind !== 'unet') return;
    if (lists.value.ggufs.includes(name)) active.value.simple.gguf = true;
    else if (lists.value.unets.includes(name)) active.value.simple.gguf = false;
  },
);

/**
 * 切架构模板:采样参数换成新模板推荐值,模型/VAE/CLIP 清空(列表不同源),
 * LoRA 与固定正负词保留(与架构无关)。尺寸若还是旧模板默认值则跟着换,
 * 用户自己改过的尺寸不动。
 */
function onTemplateChange(id: string) {
  if (!isComfyTemplateId(id)) return;
  const current = active.value.simple;
  if (current.template === id) return;
  const prevMeta = COMFY_TEMPLATES[current.template];
  const nextMeta = COMFY_TEMPLATES[id];
  if (active.value.portraitSize === prevMeta.portraitSize) active.value.portraitSize = nextMeta.portraitSize;
  if (active.value.landscapeSize === prevMeta.landscapeSize) active.value.landscapeSize = nextMeta.landscapeSize;
  active.value.simple = {
    ...simpleDefaults(id),
    loras: current.loras,
    positive: current.positive,
    negative: current.negative,
  };
}

function addLora() {
  active.value.simple.loras.push({ name: '', strength: 1 });
}

function removeLora(index: number) {
  active.value.simple.loras.splice(index, 1);
}

/** 简易模式状态药丸:与出图组装同一口径(validateSimpleConfig)。 */
const simpleState = computed(() => {
  const invalid = validateSimpleConfig(active.value.simple);
  return invalid
    ? { tone: 'error', text: 'Not ready', detail: invalid }
    : { tone: 'ok', text: 'valid', detail: '' };
});

const nlHint = computed(() =>
  active.value.mode === 'simple'
    ? 'Generate an additional natural language description; in simple mode, it takes precedence over tag as a positive prompt word (Flux/Anima is recommended to be turned on)'
    : 'Generate an additional natural language description and inject it into the workflow with %nl%',
);

/** 药丸只显示一个词,具体原因放 title 悬浮提示,不占版面。 */
const workflowState = computed(() => {
  if (!active.value.workflow.trim()) return { tone: 'muted', text: 'Not filled in', detail: '' };
  try {
    const placeholders = getWorkflowPlaceholders(active.value.workflow);
    if (!placeholders.includes('prompt')) {
      return { tone: 'error', text: 'Missing %prompt%', detail: 'JSON is valid but missing the required %prompt% placeholder' };
    }
    const unknown = placeholders.filter(
      name => !['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height'].includes(name),
    );
    if (unknown.length) {
      return {
        tone: 'error',
        text: 'Placeholder is not supported',
        detail: `Not supported yet:${unknown.map(name => `%${name}%`).join('、')}`,
      };
    }
    return {
      tone: 'ok',
      text: 'valid',
      detail: `Recognized ${placeholders.map(name => `%${name}%`).join('、')}`,
    };
  } catch (error) {
    return { tone: 'error', text: 'JSON is invalid', detail: errorMessage(error) };
  }
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Operation canceled';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testComfyConnection(effectiveComfyConn());
    toastr.success(result.mode === 'server' ? 'ComfyUI connection is normal (ST backend forwarding)' : 'ComfyUI connection is normal (browser direct connection)');
  } catch (error) {
    toastr.error(errorMessage(error), 'ComfyUI connection failed');
  } finally {
    testing.value = false;
  }
}

const purposeLabels: Record<WorkflowBindingPurpose, string> = {
  positive_tag: 'Forward tag',
  positive_nl: 'independent natural language',
  positive_combined: 'Forward tag + natural language sharing',
  negative: 'negative cue words',
  seed: 'random seed',
  width: 'Main canvas width',
  height: 'Main canvas height',
};

async function onAutoConfigure() {
  if (configuring.value || !active.value.workflow.trim()) return;
  configuring.value = true;
  const targetId = active.value.id;
  try {
    const result = await configureWorkflowWithAi(active.value.workflow);
    if (!result.changes.length) {
      toastr.info('The dynamic parameters in the workflow have been configured and do not need to be modified.', 'BaiBai Image');
      return;
    }
    assistResult.value = result;
    assistDraft.value = result.workflow;
    assistTargetId.value = targetId;
    assistOpen.value = true;
  } catch (error) {
    toastr.error(errorMessage(error), 'AI Failed to configure workflow');
  } finally {
    configuring.value = false;
  }
}

function closeAssist() {
  assistOpen.value = false;
  assistResult.value = null;
  assistDraft.value = '';
  assistTargetId.value = '';
}

function applyAssist() {
  try {
    const target = settings.comfyui.workflows.find(w => w.id === assistTargetId.value);
    if (!target) throw new Error('The target workflow has been deleted, please reconfigure it');
    const placeholders = getWorkflowPlaceholders(assistDraft.value);
    if (!placeholders.includes('prompt')) throw new Error('Preview workflow is missing %prompt% placeholder');
    target.workflow = assistDraft.value;
    const name = target.name;
    closeAssist();
    toastr.success(`Workflow with AI configuration applied (${name}）`, 'BaiBai Image');
    if (placeholders.includes('nl') && !target.naturalLanguage) {
      toastr.info('Workflow has been configured %nl%; please turn on "Generate Natural Language" if needed', 'BaiBai Image');
    }
  } catch (error) {
    toastr.error(errorMessage(error), 'Workflow cannot be applied');
  }
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="Config" :open="false">
        <div class="api-row">
          <span class="bbi-field-label">URL</span>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.comfyui.url"
            placeholder="http://127.0.0.1:8188"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> Active image backend</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'comfyui'"
          >
            Use this channel to publish pictures
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? 'Connecting…' : 'Test connection' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="Workflow" :open="false">
        <div class="wf-row">
          <span class="bbi-field-label">Current workflow</span>
          <input
            v-if="renaming"
            ref="renameInput"
            class="bbi-input"
            type="text"
            v-model="renameDraft"
            placeholder="Workflow name"
            spellcheck="false"
            title="Enter confirmed, Esc canceled"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.stop.prevent="renaming = false"
            @blur="commitRename"
          />
          <BbiSelect
            v-else
            class="wf-select"
            v-model="activeId"
            :options="workflowOptions"
            aria-label="Current workflow"
          />
          <span v-if="!renaming" class="wf-ops">
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="Rename current workflow"
              aria-label="Rename current workflow"
              @click="startRename"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="Create a new empty workflow"
              aria-label="Create a new empty workflow"
              @click="addWorkflow"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="Copy current workflow (including switches and dimensions)"
              aria-label="Copy current workflow"
              @click="duplicateWorkflow"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op wf-remove"
              type="button"
              :disabled="!canRemove"
              :title="canRemove ? 'Delete current workflow' : 'Keep at least one set of workflows'"
              aria-label="Delete current workflow"
              @click="confirmDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <!-- 分界:线以下的开关、尺寸与 JSON 均跟随当前选中的这一套 -->
        <hr class="wf-divider" />

        <!-- 配置方式:分段开关二选一(复用全局 bbi-segmented;两个选项用下拉太重),状态药丸居右 -->
        <div class="wf-mode-bar">
          <div class="bbi-segmented" role="tablist" aria-label="Configuration method">
            <button
              v-for="opt in modeOptions"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': active.mode === opt.value }"
              type="button"
              role="tab"
              :aria-selected="active.mode === opt.value"
              @click="active.mode = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <span
            v-if="active.mode === 'simple'"
            class="bbi-prompt-state wf-state"
            :class="`is-${simpleState.tone}`"
            :title="simpleState.detail || undefined"
          >
            {{ simpleState.text }}
          </span>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Generate natural language</span>
          <input v-model="active.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint wf-switch-hint">{{ nlHint }}</p>

        <div class="bbi-num-row">
          <span class="bbi-field-label">Portrait size (width × height)</span>
          <input
            class="bbi-input wf-size"
            type="text"
            v-model="active.portraitSize"
            list="comfy-portrait-presets"
            placeholder="832×1216"
            spellcheck="false"
          />
          <datalist id="comfy-portrait-presets">
            <option value="832×1216">vertical version</option>
            <option value="1024×1536">Large vertical version</option>
            <option value="1024×1024">square diagram</option>
          </datalist>
        </div>

        <div class="bbi-num-row">
          <span class="bbi-field-label">Landscape size (width × height)</span>
          <input
            class="bbi-input wf-size"
            type="text"
            v-model="active.landscapeSize"
            list="comfy-landscape-presets"
            placeholder="1216×832"
            spellcheck="false"
          />
          <datalist id="comfy-landscape-presets">
            <option value="1216×832">Horizontal version</option>
            <option value="1536×1024">Large horizontal version</option>
            <option value="1024×1024">square diagram</option>
          </datalist>
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Frame direction</span>
          <div class="bbi-segmented" role="tablist" aria-label="Workflow frame direction">
            <button
              v-for="opt in ORIENTATION_LOCKS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': active.orientationLock === opt.value }"
              type="button"
              role="tab"
              :aria-selected="active.orientationLock === opt.value"
              @click="active.orientationLock = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="bbi-field-hint wf-switch-hint">
          &quot;Automatic&quot; uses the automatic tag to determine the horizontal and vertical orientation according to the screen; after locking, every picture in this workflow will be drawn in this direction, and the automatic tag will also compose the picture according to this frame.
          The direction already noted in the text will not be overwritten and will be restored by changing it back to &quot;Auto&quot;.
        </p>

        <!-- 简易模式:选模型填参数,JSON 由插件按模板组装。
             分组排布(模型/LoRA/采样/提示词),字段行统一「短标签列 + 输入列」网格,避免长标签把输入框挤得参差不棁。 -->
        <template v-if="active.mode === 'simple'">
          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">Model</span>
              <span class="wf-group-tools">
                <span v-if="fetchStatus" class="bbi-field-hint">{{ fetchStatus }}</span>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  :disabled="fetching"
                  @click="onFetchModels()"
                >
                  <Icon name="refresh" :size="12" />
                  {{ fetching ? 'Retrieving…' : lists ? 'Refresh list' : 'Pull model list' }}
                </button>
              </span>
            </div>

            <div class="wf-field">
              <span class="wf-field-tag">Architecture</span>
              <BbiSelect
                class="wf-tpl"
                :model-value="active.simple.template"
                :options="templateOptions"
                aria-label="Model architecture"
                @update:model-value="onTemplateChange"
              />
            </div>
            <div class="wf-field">
              <span class="wf-field-tag">Model</span>
              <BbiCombo
                v-model="active.simple.model"
                :options="modelOptions"
                placeholder="safetensors / gguf file name"
                aria-label="model file"
              />
              <label
                v-if="meta.modelKind === 'unet'"
                class="wf-gguf"
                title="Model is in GGUF format (loaded with UnetLoaderGGUF); selection from list will automatically recognize"
              >
                <input v-model="active.simple.gguf" type="checkbox" class="bbi-checkbox" />
                GGUF
              </label>
            </div>
            <div class="wf-field">
              <span class="wf-field-tag">VAE</span>
              <BbiCombo
                v-model="active.simple.vae"
                :options="vaeOptions"
                :placeholder="meta.vaePlaceholder"
                aria-label="VAE file"
              />
            </div>
            <div v-for="clip in meta.clips" :key="clip.key" class="wf-field">
              <span class="wf-field-tag">{{ clip.label }}</span>
              <BbiCombo
                v-model="active.simple[clip.key]"
                :options="clipOptions"
                placeholder="clip file name"
                :aria-label="clip.label"
              />
            </div>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">LoRA</span>
              <button
                class="bbi-icon-btn wf-op"
                type="button"
                title="Add LoRA (multiple can be connected in series)"
                aria-label="Add LoRA"
                @click="addLora"
              >
                <Icon name="plus" :size="14" />
              </button>
            </div>
            <div v-for="(lora, index) in active.simple.loras" :key="index" class="wf-lora-row">
              <BbiCombo
                v-model="lora.name"
                :options="loraOptions"
                placeholder="lora file name"
                aria-label="LoRA file"
              />
              <input
                class="bbi-input wf-lora-str"
                type="number"
                v-model.number="lora.strength"
                min="0"
                max="2"
                step="0.05"
                title="intensity"
                aria-label="LoRA Strength"
              />
              <button
                class="bbi-icon-btn wf-op wf-remove"
                type="button"
                title="Delete this LoRA"
                aria-label="Delete this LoRA"
                @click="removeLora(index)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </div>
            <p v-if="active.simple.loras.length" class="bbi-field-hint wf-lora-hint">
              The trigger words of LoRA should be written into the fixed front or tag by yourself.
            </p>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">sampling</span>
            </div>
            <div class="wf-params">
              <label class="wf-param">
                <span>number of steps</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.steps" min="1" max="150" />
              </label>
              <label class="wf-param" v-if="active.simple.template !== 'flux'">
                <span>CFG</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.cfg" min="1" max="30" step="0.5" />
              </label>
              <label class="wf-param" v-if="active.simple.template === 'flux'" title="FluxGuidance strength;1 = do not add this node">
                <span>Guidance</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.guidance" min="1" max="10" step="0.1" />
              </label>
              <label class="wf-param" v-if="active.simple.template === 'anima'" title="ModelSamplingAuraFlow of shift">
                <span>Shift</span>
                <input class="bbi-input" type="number" v-model.number="active.simple.shift" min="0" max="10" step="0.1" />
              </label>
              <label class="wf-param">
                <span>sampler</span>
                <BbiCombo v-model="active.simple.sampler" :options="samplerOptions" placeholder="euler" aria-label="sampler" />
              </label>
              <label class="wf-param">
                <span>scheduler</span>
                <BbiCombo v-model="active.simple.scheduler" :options="schedulerOptions" placeholder="normal" aria-label="scheduler" />
              </label>
            </div>
          </section>

          <section class="wf-group">
            <div class="wf-group-head">
              <span class="bbi-field-label">prompt word</span>
            </div>
            <div class="wf-prompts">
              <BbiTextarea
                v-model="active.simple.positive"
                :rows="2"
                :max-rows="6"
                placeholder="Fixed front: quality words/style words, etc., spelled before the content generated by AI"
              />
              <BbiTextarea
                v-if="meta.supportsNegative"
                v-model="active.simple.negative"
                :rows="2"
                :max-rows="6"
                placeholder="Fixed negative: universal negative words; dynamic negative words generated by AI are appended at the end"
              />
            </div>
          </section>

        </template>

        <!-- 自定义模式:粘贴 API 格式 JSON -->
        <template v-else>
        <div class="wf-json-head">
          <span class="bbi-field-label">Workflow JSON</span>
          <span class="wf-json-tools">
            <span
              class="bbi-prompt-state wf-state"
              :class="`is-${workflowState.tone}`"
              :title="workflowState.detail || undefined"
            >
              {{ workflowState.text }}
            </span>
            <button
              class="bbi-btn bbi-btn-primary bbi-btn-sm"
              type="button"
              :disabled="configuring || !active.workflow.trim()"
              title="AI determines the node usage and automatically configures the placeholder; the workflow node, model name and local path will be sent to API in the settings page &quot;Generate tag for use&quot;"
              @click="onAutoConfigure"
            >
              <Icon name="sparkles" :size="12" />
              {{ configuring ? 'Analyzing…' : 'AI automatic configuration' }}
            </button>
          </span>
        </div>
        <BbiTextarea
          v-model="active.workflow"
          :rows="8"
          :max-rows="24"
          mono
          placeholder='{"3": {"class_type": "KSampler", ...}, ...}'
        />
        <p class="bbi-field-hint wf-hint">
          &quot;Save (API Format)&quot; export; available %prompt% %negative_prompt% %seed% %nl% %width% %height%
        </p>
        </template>
      </Collapsible>
    </div>

    <ConfirmDialog
      v-model:open="confirmDeleteOpen"
      title="Delete workflow"
      confirm-text="Delete"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveWorkflow"
    >
      Confirm deletion workflow&quot;{{ active.name || 'Unnamed workflow' }}”? It cannot be restored after deletion.
    </ConfirmDialog>

    <ModalMask :open="assistOpen" @close="closeAssist">
      <div
        v-if="assistResult"
        class="bbi-modal workflow-assist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Preview workflow for AI configuration"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Preview workflow modifications</span>
          <button class="bbi-icon-btn" type="button" aria-label="Close" @click="closeAssist">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-field-hint">The original text and macros are rebuilt locally, AI only returns node usage; please check before applying.</p>
        <div class="workflow-change-list">
          <div
            v-for="change in assistResult.changes"
            :key="`${change.node}:${change.input}`"
            class="workflow-change"
          >
            <span class="workflow-change-role">{{ purposeLabels[change.purpose] }}</span>
            <code>{{ change.node }}.inputs.{{ change.input }}</code>
          </div>
        </div>

        <BbiTextarea v-model="assistDraft" :rows="10" :max-rows="24" mono />

        <p v-if="assistResult.nlMode !== 'none'" class="workflow-detection">
          Natural language:{{ assistResult.nlMode === 'combined' ? 'Shared input with forward tag' : 'Use independent input' }}
        </p>
        <p v-if="assistResult.hasNegative" class="workflow-detection">
          Dynamic negative words have been configured; when generating tag, the supplementary negative tag will be output according to the screen.
        </p>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeAssist">Cancel</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="applyAssist">
            <Icon name="check" />
            Apply workflow
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* 工作流选择行:grid 而非 flex——靠 flex-basis 撑出的对齐一 wrap 就散,
   固定首列宽让标签列与下方 switch/num 行的标签列同起点。 */
.wf-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.wf-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.wf-row > .bbi-input {
  min-width: 0;
}
/* 下拉不吃满:名称通常很短,拉满只会拖出半截空白(子组件根类默认 180px/不伸缩,此处 0,2,0 压过) */
.wf-row > .wf-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.wf-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* 四个操作是低频且同级的,图标化后整行只剩下拉一个视觉重点;
   文案退到 title/aria-label,不损失可达性。 */
.wf-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.wf-op:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 选择器与预设内容的分界:线以下均跟随当前这套工作流 */
.wf-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 4px 0;
}
/* 开关自带下留白,说明文字只需补一点上间距(base.css 的 .bbi-input + hint 规则不覆盖此组合) */
.wf-switch-hint {
  margin: 2px 0 6px;
}
/* 尺寸输入:比 .bbi-num 宽一点(要装「1024×1536」),但不右对齐——「宽×高」是文本不是数值 */
.wf-size {
  width: 130px;
  flex: 0 0 auto;
}
/* 配置方式:分段开关在左、状态药丸在右 */
.wf-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0 6px;
}
/* 架构下拉不吃满(同 .wf-select 的理由) */
.wf-tpl {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
/* 简易模式分组:组标题带虚线分隔,组间距固定;组内字段行统一「短标签列+输入列+尾部」网格 */
.wf-group {
  padding: 10px 0 2px;
}
.wf-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--bbi-line);
}
.wf-group-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.wf-group-tools .bbi-field-hint {
  margin: 0;
}
.wf-field {
  display: grid;
  grid-template-columns: 4.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.wf-field-tag {
  color: var(--bbi-ink-soft);
  font-size: 12px;
  white-space: nowrap;
}
.wf-gguf {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
/* LoRA 行:文件名吃满、强度定宽、删除收尾(与字段行同节奏) */
.wf-lora-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 30px;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
}
.wf-lora-hint {
  margin: 4px 0 2px;
}
/* 采样参数:多列网格,标签在上输入在下(与 NaiPanel 的 be-row 同款语义) */
.wf-params {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 12px;
}
.wf-param {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.wf-param > span {
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.wf-prompts {
  display: grid;
  gap: 8px;
}
@media (max-width: 640px) {
  .wf-params {
    grid-template-columns: repeat(2, 1fr);
  }
}
/* JSON 头部行:标签在左,状态药丸与 AI 按钮作为「工具组」在右(textarea 是块级,头部行即它的工具栏) */
.wf-json-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 0 10px;
}
.wf-json-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-hint {
  margin-top: 8px;
}
/* 危险操作按钮:平时与其它图标钮同样低调,hover 才显红(与 ConfirmDialog 同口径)。
   图标钮无描边,故 hover 只换底色与前景色,不碰 border。 */
.wf-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.wf-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
/* AI 预览弹窗关闭钮:.bbi-icon-btn 只在 App.vue 里声明(scoped 不跨组件),此处补一份 */
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
/* JSON 状态药丸:复用全局 bbi-prompt-state 基样式,此处只按 tone 上色 */
.wf-state.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.wf-state.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}
.workflow-assist-modal {
  width: min(720px, calc(100vw - 32px));
}
.workflow-change-list {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.workflow-change {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.workflow-change-role {
  flex: 0 0 118px;
  color: var(--bbi-ink);
  font-weight: 600;
}
.workflow-change code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bbi-accent);
  font-family: var(--bbi-font-mono);
}
.workflow-detection {
  margin: 9px 0 0;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  line-height: 1.5;
}
/* URL 标签与输入框同行:标签靠左不压缩,输入框吃满剩余宽度 */
.api-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.api-row .bbi-field-label {
  flex: 0 0 auto;
}
.api-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
/* 左侧「使用此渠道 / 当前出图渠道」与右侧测试连接分据两端 */
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
@media (max-width: 640px) {
  /* 窄屏:四个图标钮 + 标签会把下拉挤成一条缝,标签独占首行,下拉与操作组同行分据两端 */
  .wf-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .wf-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .wf-row > .wf-select {
    max-width: none;
  }
  .workflow-change {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  .workflow-change-role {
    flex-basis: auto;
  }
}
</style>
