<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import {
  BACKENDS,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  IMAGE_DISPLAY_SIZES,
  newChannel,
  sanitizeTagName,
  settings,
  type ApiChannel,
  type AutoTagPrompts,
  type BackendId,
  type ImageDisplaySize,
} from '@/state/settings';
import { getContext } from '@/st/context';
import {
  ORB_SHAPES,
  THEMES,
  ui,
  type NavPosition,
  type OrbShape,
  type ThemeName,
} from '@/state/ui';
import { checkForUpdate, performUpdate, updateState } from '@/update';
import { computed, nextTick, onMounted, ref } from 'vue';

const NAV_OPTIONS: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
];

// 出图后端可选项:与渠道页页签同口径,藏掉未开放的 webui
const BACKEND_OPTIONS = BACKENDS.filter(b => b.value !== 'webui');

/**
 * 思考强度候选:各家取值的并集,**不是**某一家的官方列表。
 * auto 是显式选项(值为空串 = 不发送该参数),不是「留空」——
 * 用 BbiSelect 而非可输入的 BbiCombo:移动端点输入框会弹出输入法,很打扰。
 * 取值不做校验,原样发给端点(见 ApiChannel.reasoningEffort)。
 */
const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'auto' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

/* —— 自绘下拉(BbiSelect)的 v-model 适配:组件按 string 收发,这里收窄回具体联合类型 —— */
const themeSel = computed<string>({
  get: () => ui.theme,
  set: v => (ui.theme = v as ThemeName),
});
const navSel = computed<string>({
  get: () => ui.navPosition,
  set: v => (ui.navPosition = v as NavPosition),
});
// 楼层卡片主题不再提供设置项:卡片无边框化后恒跟随 ST 主题。
// settings.ui.cardTheme 字段与 hydrate 读取保留(旧用户已改的值继续生效,无害)。
const orbShapeSel = computed<string>({
  get: () => ui.orbShape,
  set: v => (ui.orbShape = v as OrbShape),
});
const backendSel = computed<string>({
  get: () => settings.defaultBackend,
  set: v => (settings.defaultBackend = v as BackendId),
});
const imageDisplaySel = computed<string>({
  get: () => settings.ui.imageDisplaySize,
  set: v => (settings.ui.imageDisplaySize = v as ImageDisplaySize),
});
const IMAGE_DISPLAY_OPTIONS = IMAGE_DISPLAY_SIZES.map(o => ({ value: o.value, label: o.label }));

// 副 API「生成 tag 使用」:空串 = 跟随主 API,其余为渠道 id。
// 渠道增删改名要实时反映到选项里,故用 computed 而非静态常量。
const tagGenSel = computed<string>({
  get: () => settings.assignments.tagGen,
  set: v => (settings.assignments.tagGen = v),
});
const TAG_GEN_OPTIONS = computed(() => [
  { value: '', label: 'Follow main API' },
  ...settings.channels.map(c => ({ value: c.id, label: c.name || 'Unnamed channel' })),
]);

/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   渠道列表与柏宝书共享(见 state/settings.ts 的共享存储),任一端改动自动同步。 —— */
// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
// 编辑用「草稿副本」:v-model 全改在草稿上,只有点「完成」才写回 settings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝渠道(纯数据,JSON 即可),切断与 settings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

function normalizeAutoTagNumbers(changed?: 'minImages' | 'maxImages' | Event) {
  settings.autoTag.contextMessages = Math.max(1, Math.floor(Number(settings.autoTag.contextMessages) || 1));
  let minImages = Math.max(0, Math.floor(Number(settings.autoTag.minImages) || 0));
  let maxImages = Math.max(1, Math.floor(Number(settings.autoTag.maxImages) || 1));
  // 用户抬高下限时顺带抬高上限;用户压低上限时顺带压低下限。
  // 这样正在编辑的那一格始终保留用户意图,不会出现 min > max 的瞬时脏配置。
  if (changed === 'minImages') maxImages = Math.max(maxImages, minImages);
  else minImages = Math.min(minImages, maxImages);
  settings.autoTag.minImages = minImages;
  settings.autoTag.maxImages = maxImages;
  settings.autoTag.retryCount = Math.min(5, Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0)));
}

/* —— 自定义提示词(UI 照搬柏宝书):列表只读展示,编辑在弹窗里进行。
   空串 = 回落内置默认;是否已自定义按 trim 非空判定。 —— */
interface TagPromptMeta {
  key: keyof AutoTagPrompts;
  label: string;
  hint: string;
  builtin: string;
  macros: { token: string; desc: string }[];
}

// 规范与思维链按后端成对排列:两者必须配对使用(思维链槽位要填的字段,
// 得在同后端规范里有判据和词表),列在一起是为了改一个时能看见另一个。
// 不按当前后端过滤——过滤会让「现在用的是哪份」变成隐式状态,反而更难排查。
//
// ⚠ NAI 只列一对,存的是 naiV5Spec / naiV5Thinking(键名带 V5 是历史包袱,见 settings.ts)。
// 4.5 以下那套单串 tag 的 naiSpec / naiThinking 已随模型列表收窄一起下线,不再列出:
// 可选模型只剩 4.5/V5,那两份永远走不到,列出来只会让人以为还有第二种口径要维护。
//
// 自然语言条件段(autoTag/prompt.ts 的 expandNlSections)对两个后端的规范与思维链都展开,
// 故这四份都挂上这组宏;内置的 NAI 两份正是靠它一份文本兼顾「生成自然语言」开关两侧。
const NL_SECTION_MACROS = [
  { token: '{{#nl}}', desc: 'The beginning of the conditional section: The content up to {{/nl}} is only retained when "Generate Natural Language" is turned on.' },
  { token: '{{^nl}}', desc: 'The beginning of the conditional section: the content up to {{/nl}} is only retained when "Generate Natural Language" is turned off.' },
  { token: '{{/nl}}', desc: 'End of conditional section, paired with {{#nl}} or {{^nl}}; nesting is not supported.' },
];

const TAG_PROMPT_METAS: TagPromptMeta[] = [
  {
    key: 'jailbreak',
    label: 'Breaking word',
    hint: 'As a pinned system, it is appended to the automatic tag request to reduce the secondary API rejection rate. Leave it blank to use the built-in default (the same text as BaiBai Book). Common to all backends.',
    builtin: DEFAULT_JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'naiV5Spec',
    label: 'NAI \u89c4\u8303',
    hint: '\u9ed8\u8ba4\u540e\u7aef\u4e3a NAI \u65f6\u62fc\u8fdb\u81ea\u52a8 tag \u8bf7\u6c42\uff0c\u5b9a\u4e49 Base Prompt\u3001\u539f\u751f Character Prompts \u4e0e\u82f1\u6587\u81ea\u7136\u8bed\u8a00\uff08nl \u4e00\u5f8b\u5199\u82f1\u6587\uff09\u30024.5 \u4e0e V5 \u5171\u7528\u8fd9\u4e00\u4efd\uff1achar_captions \u672c\u5c31\u662f v4 \u65f6\u4ee3\u7684\u534f\u8bae\uff0c\u4e24\u4ee3\u5199\u6cd5\u53e3\u5f84\u76f8\u540c\u3002{{#nl}}\u2026{{/nl}} \u4e4b\u95f4\u7684\u5185\u5bb9\u53ea\u5728 NAI \u9762\u677f\u5f00\u542f\u300c\u751f\u6210\u81ea\u7136\u8bed\u8a00\u300d\u65f6\u4fdd\u7559\uff0c{{^nl}}\u2026{{/nl}} \u4e4b\u95f4\u7684\u53ea\u5728\u5173\u95ed\u65f6\u4fdd\u7559\u3002\u7559\u7a7a\u7528\u5185\u7f6e\u9ed8\u8ba4\u3002',
    builtin: DEFAULT_NAI_V5_SPEC,
    macros: NL_SECTION_MACROS,
  },
  {
    key: 'naiV5Thinking',
    label: 'NAI Thought Chain',
    hint: 'The pre-output thought list used when the default backend is NAI, as system is pressed after the task message (the think block is automatically stripped off when parsing). The slot block is "Base block + one block for each character", which corresponds to the characters[] protocol and is not common with the single string form of ComfyUI. Matched with the "NAI specification", the same selection should be made according to the {{#nl}}...{{/nl}} / {{^nl}}...{{/nl}} conditional section. Leave blank to use the built-in default.',
    builtin: DEFAULT_NAI_V5_THINKING,
    macros: NL_SECTION_MACROS,
  },
  {
    key: 'comfySpec',
    label: 'ComfyUI Specifications',
    hint: 'When the default backend is ComfyUI, automatic tag requests are entered, constraining the writing specifications of tag / nl. You can also use {{#nl}}…{{/nl}} / {{^nl}}…{{/nl}} conditional segments, and select according to the "Generate Natural Language" switch of the current workflow. Leave blank to use the built-in default.',
    builtin: DEFAULT_COMFY_SPEC,
    macros: [
      {
        token: '{{nl}}',
        desc: 'Natural language specification; the ComfyUI panel is expanded when "Generate Natural Language" is turned on, and left blank when it is closed. When this macro is not written, the enable switch will be automatically appended to the end.',
      },
      ...NL_SECTION_MACROS,
    ],
  },
  {
    key: 'comfyThinking',
    label: 'ComfyUI Thought Chain',
    hint: 'The pre-output thought list used when the default backend is ComfyUI, as system is pressed after the task message (thought blocks are automatically stripped off when parsing). Compatible with the "ComfyUI specification", it also supports {{#nl}}...{{/nl}} / {{^nl}}...{{/nl}} conditional segments. Leave blank to use the built-in default.',
    builtin: DEFAULT_COMFY_THINKING,
    macros: NL_SECTION_MACROS,
  },
];

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 settings(取消则丢弃)。
const editingTagPrompt = ref<TagPromptMeta | null>(null);
const tagPromptDraft = ref('');
const tagPromptArea = ref<InstanceType<typeof BbiTextarea> | null>(null);

// 该条是否已自定义(非空即视为已覆盖内置)
function isTagPromptCustom(key: keyof AutoTagPrompts): boolean {
  return settings.autoTag.prompts[key].trim().length > 0;
}

function openTagPrompt(meta: TagPromptMeta) {
  editingTagPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  tagPromptDraft.value = settings.autoTag.prompts[meta.key].trim() || meta.builtin;
}
function closeTagPrompt() {
  editingTagPrompt.value = null;
  tagPromptDraft.value = '';
}
function saveTagPrompt() {
  const meta = editingTagPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = tagPromptDraft.value.trim();
  settings.autoTag.prompts[meta.key] = v === meta.builtin.trim() ? '' : tagPromptDraft.value;
  closeTagPrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetTagPromptDraft() {
  if (editingTagPrompt.value) tagPromptDraft.value = editingTagPrompt.value.builtin;
}
// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾);光标定位由组件内部处理
function insertTagMacro(token: string) {
  tagPromptArea.value?.insertAtCursor(token);
}

// 排除参数:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel() {
  showKey.value = false;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 settings
}
function openChannel(id: string) {
  const src = settings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** 取消(× / 点遮罩):丢弃草稿,不写回 settings(无论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿写回 settings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = settings.channels;
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原渠道被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 删除渠道前的二次确认:点删除先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 删除针对「已有渠道」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const list = settings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:生成 tag 若指派了该渠道则清空(回落跟随主 API)
  if (settings.assignments.tagGen === id) settings.assignments.tagGen = '';
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = 'Testing…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = 'No models returned';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 排除角色:勾选的角色名(含重名卡)的聊天里,自动 tag 全流程停用。
   名单与柏宝书共享(见 state/settings.ts 的共享存储),任一端改动自动同步。
   按「名字」排除,同名卡是一批一起排除。列表很长时易卡,故:① 仅在弹窗打开时取/去重角色名;
   ② 带搜索框过滤;③ 用 v-show + 子串匹配,渲染量随搜索收敛。 —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// 弹窗打开时一次性算出去重后的角色名(按名排序),关闭后不再持有,避免常驻大列表。
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

// 过滤:空搜索显示全部;否则大小写不敏感子串匹配
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return settings.excludes.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = settings.excludes.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书:tag 生成副 API 不带这些整本世界书的条目。复刻排除角色的搜索+勾选弹窗;
   世界书名从 ST 的 getWorldInfoNames()(全部已加载的世界书文件)取。 —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// 旧版 ST(如 1.13.5)的 getContext() 没有 getWorldInfoNames,退而从主页面世界书
// 下拉框 #world_editor_select 读选项文本(value="" 是占位项,跳过)。
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// 弹窗打开时一次性取世界书名(去重去空、按名排序);关闭后不持有。
const worldNames = computed<string[]>(() => {
  if (!excludeWorldOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

const filteredWorldNames = computed<string[]>(() => {
  const q = excludeWorldSearch.value.trim().toLowerCase();
  if (!q) return worldNames.value;
  return worldNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExcludeWorld() {
  excludeWorldSearch.value = '';
  excludeWorldOpen.value = true;
}
function closeExcludeWorld() {
  excludeWorldOpen.value = false;
}
function isWorldExcluded(name: string): boolean {
  return settings.excludes.excludedWorldNames.includes(name);
}
function toggleWorldExcluded(name: string) {
  const list = settings.excludes.excludedWorldNames;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书条目:按条目名(comment)过滤,复刻清洗标签的输入框+chips。
   规则当正则,普通名字即包含匹配;编译失败降级子串。 —— */
const wiPatternDraft = ref('');
function addWiPattern() {
  const pat = wiPatternDraft.value.trim();
  if (!pat) {
    wiPatternDraft.value = '';
    return;
  }
  if (!settings.excludes.excludedWorldInfoPatterns.includes(pat)) {
    settings.excludes.excludedWorldInfoPatterns.push(pat);
  }
  wiPatternDraft.value = '';
}
function removeWiPattern(pat: string) {
  const idx = settings.excludes.excludedWorldInfoPatterns.indexOf(pat);
  if (idx >= 0) settings.excludes.excludedWorldInfoPatterns.splice(idx, 1);
}

/* —— 自定义清洗标签:用户填标签名(如 snow),清洗正文时把 <snow>…</snow> 整块删掉。
   与柏宝书同名单共享(柏宝书配的清洗标签,绘里同样生效)。 —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!settings.excludes.customStripTags.includes(tag)) settings.excludes.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = settings.excludes.customStripTags.indexOf(tag);
  if (idx >= 0) settings.excludes.customStripTags.splice(idx, 1);
}

/* —— 模型可搜索下拉(combobox):输入框既是当前值也是过滤词,聚焦弹出过滤列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 过滤:有 query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延迟关闭,让 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}

const updateConfirmOpen = ref(false);
onMounted(() => void checkForUpdate(true));

function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}

async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    toastr?.success?.('Update successful, refreshing the page...', 'BaiBai Image');
  } catch (error) {
    toastr?.error?.(`Update failed:${error instanceof Error ? error.message : String(error)}`, 'BaiBai Image');
  }
}
</script>

<template>
  <section class="bbi-page">
    <!-- 标题行右端显示版本号;有更新时旁边出现更新按钮。 -->
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Settings</h2>
      <div class="bbi-ver-row">
        <button
          class="bbi-ver"
          type="button"
          :disabled="updateState.checking"
          :title="updateState.checking ? 'Checking for updates' : 'Click to check for updates'"
          @click="checkForUpdate(true)"
        >
          v{{ updateState.current || '—' }}
        </button>
        <button
          v-if="updateState.available"
          class="bbi-btn bbi-btn-primary bbi-btn-sm"
          type="button"
          :disabled="updateState.updating"
          :title="`Upstream version v${updateState.latest}`"
          @click="openUpdateConfirm"
        >
          {{ updateState.updating ? 'Updating…' : 'Updated' }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- 总开关:整个插件的主控。全页唯一的大号滑动开关,与下方各项的小复选框拉开层级。 -->
    <div class="bbi-master" :class="{ 'is-off': !settings.enabled }">
      <span class="bbi-master-spine" aria-hidden="true"></span>
      <span class="bbi-master-title">BaiBai Image·Wen Sheng Tu</span>
      <button
        type="button"
        role="switch"
        class="bbi-toggle"
        :class="{ 'is-on': settings.enabled }"
        :aria-checked="settings.enabled"
        :title="settings.enabled ? 'Click to deactivate' : 'Click to enable'"
        @click="settings.enabled = !settings.enabled"
      >
        <span class="bbi-toggle-knob"></span>
      </button>
    </div>

    <div class="bbi-sections">
      <!-- 基本设置:主题 / 导航 / 入口 / 悬浮球等界面项,置于首位 -->
      <Collapsible title="Basic settings" :open="false">
        <div class="bbi-select-row">
          <span class="bbi-field-label">Theme</span>
          <BbiSelect v-model="themeSel" :options="THEMES" aria-label="Theme" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Navigation location</span>
          <BbiSelect v-model="navSel" :options="NAV_OPTIONS" aria-label="Navigation location" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Plot backend</span>
          <BbiSelect v-model="backendSel" :options="BACKEND_OPTIONS" aria-label="Plot backend" />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Save the new image as JPG</span>
          <input v-model="settings.storage.saveAsJpeg" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          The volume is about 10% to 20% of PNG; the price is that the generation parameters are no longer embedded in the image (the prompt words and seeds are still left in the chat history).
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Floor pictures are folded by default</span>
          <input v-model="settings.ui.autoCollapseImages" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          After turning it on, the picture will be a thin strip by default and will expand when you click it. It is suitable for preventing prying eyes when playing outside. Cards that have been manually expanded/collapsed will be subject to the manual status (reset after refreshing the page).
        </p>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Floor picture display size</span>
          <BbiSelect v-model="imageDisplaySel" :options="IMAGE_DISPLAY_OPTIONS" aria-label="Floor picture display size" />
        </div>
        <p class="bbi-field-hint">
          No matter how big the picture is displayed in the chat, it is mainly for computer wide screens; the resolution and orientation of the picture will not be changed, nor will the picture file itself be changed.
          Narrow screens such as mobile phones are inherently limited by width and are basically unaffected. &quot;Full floor width&quot; is the old version effect.
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Tap current page to close on mobile</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">On mobile, tap the current page’s navigation button again to close the window. Disable this if you close it accidentally.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Display button in ST top bar</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">Add a button to quickly open BaiBai Image in the navigation bar at the top of SillyTavern. The wand entrance in the lower left corner remains as before.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Show floating button</span>
          <input v-model="ui.showOrb" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">Hang a draggable floating ball on the edge of the screen and click to open BaiBai Image. Drag it to the center to permanently suspend it, and drag it close to the left and right edges to adsorb the edges.</p>

        <!-- 悬浮球外观:配置项多,开启后才收进小分组 -->
        <Collapsible v-if="ui.showOrb" title="Appearance of floating ball" :open="false">
          <div class="bbi-select-row">
            <span class="bbi-field-label">Shape</span>
            <BbiSelect v-model="orbShapeSel" :options="ORB_SHAPES" aria-label="suspended ball shape" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Size</span>
              <span class="bbi-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input class="bbi-range" type="range" min="32" max="80" step="1" v-model.number="ui.orbSize" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Idle opacity</span>
              <span class="bbi-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input class="bbi-range" type="range" min="20" max="100" step="1" v-model.number="ui.orbOpacity" />
            <p class="bbi-field-hint">The opacity of the floating ball when it is at rest; it will always be fully visible when raised/draged.</p>
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Custom icon</span>
            </div>
            <input class="bbi-input" type="text" v-model="ui.orbImage" placeholder="ST server image path" spellcheck="false" />
            <p class="bbi-field-hint">Leave blank to use the default brush icon.</p>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- 副 API:生成画图 tag 用的模型渠道(与柏宝书共享渠道列表) -->
      <Collapsible title="Auxiliary API" :open="false">
        <!-- 任务指派:只有一个任务——生成 tag -->
        <div class="bbi-field bbi-assign">
          <div class="bbi-assign-row">
            <span class="bbi-field-label">Generate tag using</span>
            <BbiSelect v-model="tagGenSel" :options="TAG_GEN_OPTIONS" aria-label="Generate tag using the API channel" />
          </div>
        </div>
        <p class="bbi-field-hint">Follow the main API when not assigning a channel: directly borrow the API (chat completion/text completion) currently used in your main interface to generate the drawing tag, no additional configuration is required. If you want to use different models, create a sub-channel assignment below. The channel list is shared with BaiBai Book, and changes at either end will be automatically synchronized to the other end.</p>

        <hr class="bbi-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表平铺 -->
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">Backend</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addChannel()">
            <Icon name="plus" /> Add channel
          </button>
        </div>

        <ul v-if="settings.channels.length" class="bbi-channel-list">
          <li v-for="ch in settings.channels" :key="ch.id" class="bbi-channel-item">
            <button class="bbi-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbi-channel-item-name">{{ ch.name || 'Unnamed channel' }}</span>
              <span class="bbi-channel-item-model">{{ ch.model || 'No model set up' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">There is no channel yet. Click &quot;Add Channel&quot; to configure API to be used to generate tag.</p>
      </Collapsible>

      <Collapsible title="Automatically generate tag" :open="false">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Automatically generate tag</span>
          <input v-model="settings.autoTag.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">AI After the text is generated, it will automatically determine whether the building needs illustrations, and if so, write the raw illustration tag.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Automatically generate pictures</span>
          <input v-model="settings.autoTag.autoGenerate" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">After writing tag, the picture will be automatically output according to the current picture output channel; if it is turned off, only tag will be written and generated manually on the card.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Carry the latest AI floor number</span>
          <input
            v-model.number="settings.autoTag.contextMessages"
            class="bbi-input bbi-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">Count according to the AI story floor, and the user floor in the middle is carried together.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Minimum number of pictures for a single floor</span>
          <input
            v-model.number="settings.autoTag.minImages"
            class="bbi-input bbi-num"
            type="number"
            min="0"
            :max="settings.autoTag.maxImages"
            step="1"
            @change="normalizeAutoTagNumbers('minImages')"
          />
        </label>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Maximum number of pictures on a single floor</span>
          <input
            v-model.number="settings.autoTag.maxImages"
            class="bbi-input bbi-num"
            type="number"
            :min="Math.max(1, settings.autoTag.minImages)"
            step="1"
            @change="normalizeAutoTagNumbers('maxImages')"
          />
        </label>
        <p class="bbi-field-hint">No picture is allowed when the minimum setting is 0; the maximum number is always hard-limited by the plug-in.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Number of failed automatic retries</span>
          <input
            v-model.number="settings.autoTag.retryCount"
            class="bbi-input bbi-num"
            type="number"
            min="0"
            max="5"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">Deputy API Automatically retry when the request fails or the response cannot be parsed; 0 = No retry, up to 5 times.</p>
      </Collapsible>

      <!-- 排除角色:名单与柏宝书共享(见 state/settings.ts 的共享存储),任一端改动自动同步 -->
      <Collapsible title="Excluded characters" :open="false">
        <p class="bbi-field-hint">Pictures of characters in the list are not automatically generated in the chat tag. The list is shared with BaiBai Book, and changes at either end are automatically synchronized.</p>
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">Excluded {{ settings.excludes.excludedChars.length }} items</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> edit list
          </button>
        </div>
        <ul v-if="settings.excludes.excludedChars.length" class="bbi-exclude-chips">
          <li v-for="name in settings.excludes.excludedChars" :key="name" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">{{ name }}</span>
            <button class="bbi-exclude-chip-x" type="button" title="Remove from list" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">List is empty, all characters have auto tag enabled.</p>
      </Collapsible>

      <!-- 排除世界书内容:与柏宝书同名单共享 -->
      <Collapsible title="Exclude lorebook content" :open="false">
        <p class="bbi-field-hint">
          Eliminate entries that are useless to the picture from the World Info that generated the tag reference, saving token and avoiding interference. List shared with Cypress; only affects deputy API.
        </p>

        <!-- 整本排除:复刻排除角色的搜索+勾选弹窗 -->
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">Exclude entire book · Selected {{ settings.excludes.excludedWorldNames.length }} Ben</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="openExcludeWorld">
            <Icon name="edit" /> edit list
          </button>
        </div>
        <ul v-if="settings.excludes.excludedWorldNames.length" class="bbi-exclude-chips">
          <li v-for="name in settings.excludes.excludedWorldNames" :key="name" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">{{ name }}</span>
            <button class="bbi-exclude-chip-x" type="button" title="Remove from list" @click="toggleWorldExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">No World Infos are excluded, and all activated entries will be generated in tag for reference.</p>

        <hr class="bbi-rule" />

        <!-- 按条目名过滤:复刻清洗标签的输入框 + chips -->
        <div class="bbi-field-head">
          <span class="bbi-field-label">Filter by entry comment</span>
        </div>
        <p class="bbi-field-hint">
          Note name by item<strong> substring</strong>Match (case-insensitive), support regular expressions (such as <code>^Rules</code>)。
          preset <code>\[mvu[\s\S]*?\]</code> Used to filter MVU mechanism entries and can be deleted if not required.
        </p>
        <div class="bbi-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="bbi-input"
            type="text"
            placeholder="Entry name or regular rule, such as append or ^ rule"
            @keydown.enter.prevent="addWiPattern"
          />
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addWiPattern">
            <Icon name="plus" /> Add
          </button>
        </div>
        <ul v-if="settings.excludes.excludedWorldInfoPatterns.length" class="bbi-exclude-chips">
          <li v-for="pat in settings.excludes.excludedWorldInfoPatterns" :key="pat" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">{{ pat }}</span>
            <button class="bbi-exclude-chip-x" type="button" title="Remove" @click="removeWiPattern(pat)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">There are no rules for entry names.</p>
      </Collapsible>

      <!-- 自定义清洗标签:与柏宝书同名单共享 -->
      <Collapsible title="Custom cleanup tags" :open="false">
        <p class="bbi-field-hint">
          Fill in the tag name (such as <code>snow</code>), the text and World Info will be scanned <code>&lt;snow&gt;…&lt;/snow&gt;</code> Delete the entire block. The list is shared with BaiBai Book.
        </p>
        <div class="bbi-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbi-input"
            type="text"
            placeholder="Tag name, such as snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> Add
          </button>
        </div>
        <ul v-if="settings.excludes.customStripTags.length" class="bbi-exclude-chips">
          <li v-for="tag in settings.excludes.customStripTags" :key="tag" class="bbi-exclude-chip">
            <span class="bbi-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbi-exclude-chip-x" type="button" title="Remove" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">No custom cleanup tags. Built-in cleanup still removes reasoning blocks, notes, and item annotations.</p>
      </Collapsible>

      <!-- 自定义提示词(与柏宝书同款入口,独立成区) -->
      <Collapsible title="Custom prompts" :open="false">
        <ul class="bbi-prompt-list">
          <li v-for="m in TAG_PROMPT_METAS" :key="m.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openTagPrompt(m)">
              <span class="bbi-prompt-name">{{ m.label }}</span>
              <span class="bbi-prompt-state" :class="{ 'is-custom': isTagPromptCustom(m.key) }">
                {{ isTagPromptCustom(m.key) ? 'Customized' : 'Default' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>
    </div>

    <!-- ===== 排除角色弹窗:搜索 + 勾选列表 ===== -->
    <ModalMask :open="excludeOpen" @close="closeExclude">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Edit exclusion list">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Excluded characters</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbi-input"
          type="search"
          placeholder="Search for character name…"
          spellcheck="false"
        />

        <div class="bbi-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbi-exclude-row">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbi-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbi-field-hint">The role list was not read. Please load the character card in ST first.</p>
          <p v-else-if="!filteredCharNames.length" class="bbi-field-hint">No match &quot;{{ excludeSearch }}” role.</p>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-exclude-count">total {{ charNames.length }} characters · excluded {{ settings.excludes.excludedChars.length }}</span>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeExclude">Done</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 排除世界书弹窗:搜索 + 勾选列表(复刻排除角色) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Edit Excluded lorebook List">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">The entire excluded lorebook</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeExcludeWorld"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeWorldSearch"
          class="bbi-input"
          type="search"
          placeholder="Search lorebook titles…"
          spellcheck="false"
        />

        <div class="bbi-exclude-list">
          <label v-for="name in filteredWorldNames" :key="name" class="bbi-exclude-row">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="isWorldExcluded(name)"
              @change="toggleWorldExcluded(name)"
            />
            <span class="bbi-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!worldNames.length" class="bbi-field-hint">The lorebook has not been read. Please load/mount the lorebook in ST first.</p>
          <p v-else-if="!filteredWorldNames.length" class="bbi-field-hint">No match &quot;{{ excludeWorldSearch }}” lorebook.</p>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-exclude-count">total {{ worldNames.length }} This · Excluded {{ settings.excludes.excludedWorldNames.length }}</span>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeExcludeWorld">Done</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 渠道编辑弹窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbi-modal" role="dialog" aria-modal="true" aria-label="Edit channel">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Edit channel</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Channel name</span>
          <input v-model="editingChannel.name" class="bbi-input" placeholder="Channel name" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API URL</span>
          <input v-model="editingChannel.url" class="bbi-input" placeholder="Such as https://api.openai.com/v1" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API Key</span>
          <div class="bbi-model-row">
            <input
              v-model="editingChannel.key"
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API Key"
            />
            <button
              class="bbi-icon-mini"
              type="button"
              :title="showKey ? 'Hide key' : 'Show key'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Model</span>
          <div class="bbi-model-row">
            <!-- 可搜索 combobox:已拉取到模型列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
            <div class="bbi-combo">
              <input
                v-model="editingChannel.model"
                class="bbi-input"
                :placeholder="modelList.length ? 'Search or enter model name…' : 'Model name, such as gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在有可选模型时显示 -->
              <span v-if="modelList.length" class="bbi-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbi-combo-menu">
                <li v-if="!filteredModels.length" class="bbi-combo-empty">No matching model</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbi-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbi-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? 'Retrieving…' : 'Fetch models'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbi-channel-row">
          <label class="bbi-mini-field">
            <span>Temperature</span>
            <input v-model.number="editingChannel.temperature" class="bbi-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbi-mini-field">
            <span>Max token</span>
            <input v-model.number="editingChannel.maxTokens" class="bbi-input" type="number" step="256" min="256" />
          </label>
          <label class="bbi-mini-field">
            <span>Timeout (s)</span>
            <input v-model.number="editingChannel.timeoutSec" class="bbi-input" type="number" step="10" min="1" />
          </label>
          <!-- 思考强度用 BbiSelect(纯选择,不唤起输入法);它自带 180px 固定宽,
               这里要跟其余三个等分,故在 .bbi-mini-field 内用 :deep 放开宽度 -->
          <div class="bbi-mini-field">
            <span>Reasoning effort</span>
            <BbiSelect
              v-model="editingChannel.reasoningEffort"
              :options="REASONING_EFFORT_OPTIONS"
              aria-label="Reasoning effort"
            />
          </div>
        </div>
        <span class="bbi-field-hint">Choose auto if unsure. The author recommends max for DeepSeek models.</span>
        <label class="bbi-switch-row">
          <span class="bbi-modal-label">Streaming</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbi-checkbox" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Exclude Params</span>
          <input
            v-model="excludeParamsText"
            class="bbi-input"
            type="text"
            placeholder="Comma separated, such as temperature, max_tokens"
          />
          <span class="bbi-field-hint">These parameters are removed from the request body before sending, for endpoints that do not accept them. Separate names with commas; leave blank to exclude nothing.</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbi-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbi-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。
               删除:始终显示文字;测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
          <button class="bbi-btn bbi-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> Delete
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" title="Test channel" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbi-btn-label-full">Test channel</span><span class="bbi-btn-label-short">Test</span>
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmChannel">Done</button>
        </footer>

        <!-- 删除渠道二次确认:叠在渠道弹窗之上。置于 v-if="editingChannel" 块内,
             渠道为 null 时整体不渲染——既合语义,也让 editingChannel.name 类型收窄。
             ConfirmDialog 自身 teleport + top-layer,放这儿不影响其渲染层级。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Delete channel"
          confirm-text="Delete"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          Confirm to delete channel &quot;{{ editingChannel.name || 'Unnamed channel' }}&quot;? This operation is irreversible, and the tasks assigned to this channel will be cleared.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 自定义提示词编辑弹窗(UI 照搬柏宝书) ===== -->
    <ModalMask :open="!!editingTagPrompt" @close="closeTagPrompt">
      <div
        v-if="editingTagPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`Edit${editingTagPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Edit{{ editingTagPrompt.label }}</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeTagPrompt"><Icon name="close" /></button>
        </header>

        <p class="bbi-modal-label">{{ editingTagPrompt.hint }}</p>

        <!-- 可用宏:点一下插入到光标处(规范与思维链四份都有自然语言条件段,ComfyUI 规范另有 {{nl}};
             无宏的条目不显示这一栏) -->
        <div v-if="editingTagPrompt.macros.length" class="bbi-macro-bar">
          <span class="bbi-macro-tip">Click to insert macro:</span>
          <button
            v-for="mac in editingTagPrompt.macros"
            :key="mac.token"
            class="bbi-macro"
            type="button"
            :title="mac.desc"
            @click="insertTagMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <BbiTextarea
          ref="tagPromptArea"
          v-model="tagPromptDraft"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
        />

        <footer class="bbi-modal-foot">
          <button class="bbi-btn bbi-btn-danger" type="button" @click="resetTagPromptDraft">
            <Icon name="refresh" /> Restore Default
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeTagPrompt">Cancel</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveTagPrompt">Done</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="New version found"
      confirm-text="Update instructions"
      busy-text="Updating…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      Current version v{{ updateState.current || '—' }}, the latest version v{{ updateState.latest }}。<br />
      Update now? The page will automatically refresh after the update is completed to take effect.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbi-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* —— 版本标签:实心强调底 + 反白字,点击可重新检查 —— */
.bbi-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  cursor: pointer;
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}
.bbi-ver:disabled {
  cursor: wait;
  opacity: 0.7;
}

/* —— 总开关主控卡 —— */
/* 左缘一道强调色竖脊;停用时整卡褪色、竖脊转灰,状态一眼可辨 */
.bbi-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  box-shadow: var(--bbi-shadow);
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-master.is-off .bbi-master-spine {
  background: var(--bbi-line-strong);
}
.bbi-master.is-off .bbi-master-title {
  opacity: 0.7;
}
.bbi-master-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--bbi-ink);
}

.bbi-auto-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 4px 0 8px;
}

/* —— 滑动开关:全页仅总开关一处使用 —— */
.bbi-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-line-strong);
  cursor: pointer;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on {
  background: var(--bbi-accent);
}
.bbi-toggle:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
.bbi-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbi-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on .bbi-toggle-knob {
  transform: translateX(20px);
}

/* ============ 副 API:渠道(与柏宝书同款) ============ */

/* 任务指派 */
.bbi-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* 指派下拉:比全局 BbiSelect 更窄小一号,与右侧对齐、不撑满半行(柏宝书同款)。
   BbiSelect 自带 180px 固定宽,这里收窄并放开 max-width 以适应移动端。 */
.bbi-assign-row :deep(.bbi-select-box) {
  width: 160px;
  max-width: 60%;
}
.bbi-assign-row :deep(.bbi-select-trigger) {
  font-size: 12px;
}

/* 渠道:顶部操作条(标签 + 添加按钮) */
.bbi-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.bbi-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.bbi-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-channel-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.bbi-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.bbi-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 渠道编辑弹窗 —— */
.bbi-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbi-model-row .bbi-input {
  flex: 1;
}
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* —— 模型可搜索 combobox —— */
.bbi-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbi-combo .bbi-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbi-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbi-combo-item:hover {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-active {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* 温度/最大 token/超时/思考强度:四个短控件并排,窄屏落到 2×2(见媒体查询) */
.bbi-channel-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.bbi-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
/* BbiSelect 自带 180px 固定宽(为设置页的行布局设计),这里要跟其余三个等分 */
.bbi-mini-field :deep(.bbi-select-box) {
  width: 100%;
}
/* 与相邻 number 输入等高:触发器默认 padding 比 .bbi-input 略小 */
.bbi-mini-field :deep(.bbi-select-trigger) {
  padding: 7px 10px;
}
.bbi-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbi-ink-soft);
  word-break: break-all;
}

/* 弹窗底部:spacer 把删除键推到最左,与右侧操作分隔 */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbi-btn-label-short {
  display: none;
}

/* —— 自定义提示词列表(UI 照搬柏宝书) —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
.bbi-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸(.bbi-prompt-state / .is-custom)已提到 base.css 全局:渠道页也用它 */
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.bbi-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbi-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbi-macro-tip {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  margin-right: 2px;
}
.bbi-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease), border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-macro:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* ============ 排除名单(chips + 弹窗列表):与柏宝书同款交互,类名换 bbi 前缀 ============ */
.bbi-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbi-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbi-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbi-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}
.bbi-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbi-striptag-bar .bbi-input {
  flex: 1;
  min-width: 0;
}
.bbi-striptag-bar .bbi-btn {
  flex: none;
}
.bbi-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbi-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbi-radius-sm);
  cursor: pointer;
}
.bbi-exclude-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .bbi-auto-grid {
    grid-template-columns: 1fr;
  }
  /* 渠道参数四连:窄屏一行四个每个只剩几十 px,落成 2×2 */
  .bbi-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .bbi-channel-item-name {
    font-size: 13px;
  }
  .bbi-channel-item-model {
    font-size: 11px;
  }
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .bbi-btn-label-full {
    display: none;
  }
  .bbi-btn-label-short {
    display: inline;
  }
}
</style>
