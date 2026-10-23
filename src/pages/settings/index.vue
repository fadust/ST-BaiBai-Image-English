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

// Image backend options: same rule as the channel page tabs, hiding the unreleased webui
const BACKEND_OPTIONS = BACKENDS.filter(b => b.value !== 'webui');

/**
 * Reasoning-effort candidates: the union of values across providers, **not** any one provider's official list.
 * auto is an explicit option (value empty string = don't send the parameter), not "left blank";
 * BbiSelect rather than the typable BbiCombo: on mobile tapping an input pops up the keyboard, which is intrusive.
 * Values aren't validated and are sent to the endpoint as-is (see ApiChannel.reasoningEffort).
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

/* —— v-model adapters for the custom dropdown (BbiSelect): the component sends and receives strings; here they are narrowed back to the specific union types —— */
const themeSel = computed<string>({
  get: () => ui.theme,
  set: v => (ui.theme = v as ThemeName),
});
const navSel = computed<string>({
  get: () => ui.navPosition,
  set: v => (ui.navPosition = v as NavPosition),
});
// The floor card theme is no longer a setting: since cards became borderless they always follow the ST theme.
// The settings.ui.cardTheme field and its hydrate read are kept (values old users changed still apply, harmlessly).
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

// Secondary API "used for generating tags": empty string = follow the main API; otherwise a channel id.
// Adding/deleting/renaming channels must reflect in the options live, hence computed rather than a static constant.
const tagGenSel = computed<string>({
  get: () => settings.assignments.tagGen,
  set: v => (settings.assignments.tagGen = v),
});
const TAG_GEN_OPTIONS = computed(() => [
  { value: '', label: 'Follow main API' },
  ...settings.channels.map(c => ({ value: c.id, label: c.name || 'Unnamed channel' })),
]);

/* —— Channels: the list is read-only; editing/creating happens in a dialog, avoiding mis-taps on a long flat list.
   The channel list is shared with BaiBai Book (see shared storage in state/settings.ts); a change on either side syncs automatically. —— */
// editingId: id of the "existing channel" being edited; null when creating. Only used to locate the write-back target on "Done".
const editingId = ref<string | null>(null);
// Editing uses a "draft copy": all v-model changes go to the draft, and only "Done" writes back to settings (avoiding a save on every keystroke).
// The dialog's open state follows it too: draft exists = dialog open.
const editingChannel = ref<ApiChannel | null>(null);
// Deep-copy the channel (plain data, JSON is enough), cutting the reference to the real settings object
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// The key is hidden by default; reset on every open/close so the key never stays visible by accident
const showKey = ref(false);

function normalizeAutoTagNumbers(changed?: 'minImages' | 'maxImages' | Event) {
  settings.autoTag.contextMessages = Math.max(1, Math.floor(Number(settings.autoTag.contextMessages) || 1));
  let minImages = Math.max(0, Math.floor(Number(settings.autoTag.minImages) || 0));
  let maxImages = Math.max(1, Math.floor(Number(settings.autoTag.maxImages) || 1));
  // When the user raises the minimum, the maximum rises with it; when the user lowers the maximum, the minimum drops with it.
  // That way the cell being edited always keeps the user's intent, and a momentary min > max dirty config never occurs.
  if (changed === 'minImages') maxImages = Math.max(maxImages, minImages);
  else minImages = Math.min(minImages, maxImages);
  settings.autoTag.minImages = minImages;
  settings.autoTag.maxImages = maxImages;
  settings.autoTag.retryCount = Math.min(5, Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0)));
}

/* —— Custom prompts (UI copied from BaiBai Book): the list is read-only; editing happens in a dialog.
   Empty string = fall back to the built-in default; "customised" means non-empty after trim. —— */
interface TagPromptMeta {
  key: keyof AutoTagPrompts;
  label: string;
  hint: string;
  builtin: string;
  macros: { token: string; desc: string }[];
}

// Specifications and thought chains are listed in pairs per backend: they must be used together (fields the thought chain's slots fill
// need criteria and a vocabulary in the same backend's specification); listing them together lets you see one while changing the other.
// Not filtered by the current backend: filtering would make "which one is in use now" implicit state, which is harder to debug.
//
// ⚠ NAI lists only one pair, stored as naiV5Spec / naiV5Thinking (V5 in the key names is historical baggage; see settings.ts).
// The single-string tag naiSpec / naiThinking for models below 4.5 retired together with the narrowed model list and are no longer listed:
// only 4.5/V5 remain selectable, so those two are never reached, and listing them would only suggest a second set of rules to maintain.
//
// Natural-language conditional sections (expandNlSections in autoTag/prompt.ts) expand in both backends' specifications and thought chains,
// so all four carry this macro set; the two built-in NAI texts rely on it to serve both sides of the "Generate Natural Language" toggle with one text.
const NL_SECTION_MACROS = [
  { token: '{{#nl}}', desc: 'Starts a conditional section: the content up to {{/nl}} is kept only when "Generate natural language" is on.' },
  { token: '{{^nl}}', desc: 'Starts a conditional section: the content up to {{/nl}} is kept only when "Generate natural language" is off.' },
  { token: '{{/nl}}', desc: 'Ends a conditional section opened by {{#nl}} or {{^nl}}; nesting is not supported.' },
];

const TAG_PROMPT_METAS: TagPromptMeta[] = [
  {
    key: 'jailbreak',
    label: 'Core Prompt',
    hint: 'Pinned as the first system message of every automatic tag request. Defines the planner role and the content boundaries that no card, lorebook or chat can override. Leave it blank to use the built-in default. Common to all backends.',
    builtin: DEFAULT_JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'naiV5Spec',
    label: 'NAI Specification',
    hint: 'Added to automatic tag requests when the default backend is NAI. Defines the Base Prompt, native Character Prompts and English natural language (nl is always written in English). NAI 4.5 and V5 share this one specification: char_captions is the v4-era protocol, so both use the same rules. Content between {{#nl}}\u2026{{/nl}} is kept only when "Generate natural language" is on in the NAI panel; content between {{^nl}}\u2026{{/nl}} only when it is off. Leave blank to use the built-in default.',
    builtin: DEFAULT_NAI_V5_SPEC,
    macros: NL_SECTION_MACROS,
  },
  {
    key: 'naiV5Thinking',
    label: 'NAI Thought Chain',
    hint: 'The pre-output checklist used when the default backend is NAI, sent as a system message after the task message (the thinking block is stripped when parsing). Its slot blocks are "one Base block + one block per character", matching the characters[] protocol, so it is not shared with the single-string ComfyUI form. Like the NAI Specification, it supports {{#nl}}…{{/nl}} / {{^nl}}…{{/nl}} conditional sections. Leave blank to use the built-in default.',
    builtin: DEFAULT_NAI_V5_THINKING,
    macros: NL_SECTION_MACROS,
  },
  {
    key: 'comfySpec',
    label: 'ComfyUI Specification',
    hint: 'Added to automatic tag requests when the default backend is ComfyUI. Sets the writing rules for tag / nl. Supports {{#nl}}…{{/nl}} / {{^nl}}…{{/nl}} conditional sections, chosen by the current workflow\'s "Generate natural language" toggle. Leave blank to use the built-in default.',
    builtin: DEFAULT_COMFY_SPEC,
    macros: [
      {
        token: '{{nl}}',
        desc: 'The natural-language rules. Expands when "Generate natural language" is on in the ComfyUI panel, and to nothing when off. If this macro is absent, the rules are appended to the end when the toggle is on.',
      },
      ...NL_SECTION_MACROS,
    ],
  },
  {
    key: 'comfyThinking',
    label: 'ComfyUI Thought Chain',
    hint: 'The pre-output checklist used when the default backend is ComfyUI, sent as a system message after the task message (the thinking block is stripped when parsing). Pairs with the ComfyUI Specification and also supports {{#nl}}…{{/nl}} / {{^nl}}…{{/nl}} conditional sections. Leave blank to use the built-in default.',
    builtin: DEFAULT_COMFY_THINKING,
    macros: NL_SECTION_MACROS,
  },
];

// The prompt being edited; draft is the draft, written back to settings only on "Done" (discarded on cancel).
const editingTagPrompt = ref<TagPromptMeta | null>(null);
const tagPromptDraft = ref('');
const tagPromptArea = ref<InstanceType<typeof BbiTextarea> | null>(null);

// Whether this entry is customised (non-empty means it overrides the built-in)
function isTagPromptCustom(key: keyof AutoTagPrompts): boolean {
  return settings.autoTag.prompts[key].trim().length > 0;
}

function openTagPrompt(meta: TagPromptMeta) {
  editingTagPrompt.value = meta;
  // Customised → load the user's content; not customised → prefill the built-in template so it can be edited directly
  tagPromptDraft.value = settings.autoTag.prompts[meta.key].trim() || meta.builtin;
}
function closeTagPrompt() {
  editingTagPrompt.value = null;
  tagPromptDraft.value = '';
}
function saveTagPrompt() {
  const meta = editingTagPrompt.value;
  if (!meta) return;
  // Draft identical to the built-in → store an empty string (fall back to built-in), avoiding storing a redundant template in settings and allowing "Default" to show
  const v = tagPromptDraft.value.trim();
  settings.autoTag.prompts[meta.key] = v === meta.builtin.trim() ? '' : tagPromptDraft.value;
  closeTagPrompt();
}
// "Restore default": resets the draft to the built-in template (after saving it falls back to built-in)
function resetTagPromptDraft() {
  if (editingTagPrompt.value) tagPromptDraft.value = editingTagPrompt.value.builtin;
}
// Clicking a macro chip → inserts at the text box caret (appends to the end without focus); caret handling is inside the component
function insertTagMacro(token: string) {
  tagPromptArea.value?.insertAtCursor(token);
}

// Excluded parameters: stored internally as string[]; edited as a comma-separated single line, converted both ways on read/write.
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
  editingId.value = null; // null = new; pushed on Done
  editingChannel.value = newChannel(); // Draft, not yet in settings
}
function openChannel(id: string) {
  const src = settings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // Edit a draft copy, leaving the real object alone
}
/** Cancel (× / click mask): discard the draft without writing back to settings (changes are void whether creating or editing). */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** Done: write the draft back to settings: push when creating, overwrite by id when editing. Only now is a save triggered. */
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
      else list.push(draft); // If something odd happened while editing, such as the original channel being deleted → fall back to adding it
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// Second confirmation before deleting a channel: clicking delete opens a confirm dialog first, and deletion happens only after confirming.
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // Deletion targets an "existing channel" (editingId); a new draft isn't in the library yet, so it's the same as discarding the draft
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const list = settings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // Clean up assignments: if tag generation was assigned to this channel, clear it (fall back to following the main API)
  if (settings.assignments.tagGen === id) settings.assignments.tagGen = '';
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = 'Testing…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// Model lists fetched per channel + fetch state
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

/* —— Excluded characters: in chats with the checked character names (including same-name cards), the whole auto-tag flow is disabled.
   The list is shared with BaiBai Book (see shared storage in state/settings.ts); a change on either side syncs automatically.
   Excluded by "name", so same-name cards are excluded together. Long lists can lag, so: ① character names are fetched/deduplicated only while the dialog is open;
   ② a search box filters; ③ v-show + substring matching keeps rendering in step with the search. —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// When the dialog opens, compute the deduplicated character names once (sorted by name); not held after closing, avoiding a permanent large list.
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

// Filtering: empty search shows everything; otherwise case-insensitive substring match
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

/* —— Excluded lorebooks: the tag-generation secondary API omits entries from these whole lorebooks. Copies the excluded-characters search+check dialog;
   lorebook names come from ST's getWorldInfoNames() (all loaded lorebook files). —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// Old ST (e.g. 1.13.5) has no getWorldInfoNames in getContext(), so fall back to reading option text from the main page's lorebook
// dropdown #world_editor_select (value="" is a placeholder; skipped).
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// When the dialog opens, fetch lorebook names once (deduplicated, blanks removed, sorted by name); not held after closing.
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

/* —— Excluded lorebook entries: filtered by entry name (comment), copying the cleanup-tag input + chips.
   Rules are regexes; a plain name is a contains-match; on compile failure it degrades to substring matching. —— */
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

/* —— Custom cleanup tags: the user enters a tag name (e.g. snow), and cleaning story text removes the whole <snow>…</snow> block.
   The list is shared with BaiBai Book (cleanup tags set in BaiBai Book apply here too). —— */
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

/* —— Searchable model dropdown (combobox): the input is both the current value and the filter; focusing pops up the filtered list —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // Filter text typed after focusing; cleared on blur
// Fetched model list for the current channel
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// Filtering: with a query, filter by substring (case-insensitive); empty shows everything. Capped at 200 for performance, avoiding lag with very long lists.
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
// Delay closing on blur so an option's mousedown/click takes effect first
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
    toastr?.success?.('Updated. Refreshing the page…', 'BaiBai Image');
  } catch (error) {
    toastr?.error?.(`Update failed: ${error instanceof Error ? error.message : String(error)}`, 'BaiBai Image');
  }
}
</script>

<template>
  <section class="bbi-page">
    <!-- The version number shows at the right end of the title row; an update button appears beside it when an update exists. -->
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
          {{ updateState.updating ? 'Updating…' : 'Update' }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- Master switch: the main control of the whole plugin. The page's only large slide switch, set apart in rank from the small checkboxes below. -->
    <div class="bbi-master" :class="{ 'is-off': !settings.enabled }">
      <span class="bbi-master-spine" aria-hidden="true"></span>
      <span class="bbi-master-title">BaiBai Image · Text to Image</span>
      <button
        type="button"
        role="switch"
        class="bbi-toggle"
        :class="{ 'is-on': settings.enabled }"
        :aria-checked="settings.enabled"
        :title="settings.enabled ? 'Click to turn off' : 'Click to turn on'"
        @click="settings.enabled = !settings.enabled"
      >
        <span class="bbi-toggle-knob"></span>
      </button>
    </div>

    <div class="bbi-sections">
      <!-- Basic settings: UI items such as theme / navigation / entry points / floating orb, placed first -->
      <Collapsible title="Basic settings" :open="false">
        <div class="bbi-select-row">
          <span class="bbi-field-label">Theme</span>
          <BbiSelect v-model="themeSel" :options="THEMES" aria-label="Theme" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Navigation position</span>
          <BbiSelect v-model="navSel" :options="NAV_OPTIONS" aria-label="Navigation position" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Image backend</span>
          <BbiSelect v-model="backendSel" :options="BACKEND_OPTIONS" aria-label="Image backend" />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Save new images as JPG</span>
          <input v-model="settings.storage.saveAsJpeg" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          About 10–20% of the PNG size. The trade-off: generation parameters are no longer embedded in the image (prompts and seeds stay in the chat history).
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Collapse floor images by default</span>
          <input v-model="settings.ui.autoCollapseImages" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          When on, images show as a thin bar and expand on click, handy in public. Cards you expand/collapse by hand keep that state (reset when the page refreshes).
        </p>

        <div class="bbi-select-row">
          <span class="bbi-field-label">Floor image display size</span>
          <BbiSelect v-model="imageDisplaySel" :options="IMAGE_DISPLAY_OPTIONS" aria-label="Floor image display size" />
        </div>
        <p class="bbi-field-hint">
          Sets how large images show in the chat, mainly for wide desktop screens. It never changes the image resolution, orientation or file.
          Narrow screens such as phones are limited by width anyway and barely change. &quot;Fill the floor width&quot; is the old behaviour.
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Tap current page to close on mobile</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">On mobile, tap the current page’s navigation button again to close the window. Disable this if you close it accidentally.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Show button in ST top bar</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">Adds a button to SillyTavern's top bar that opens BaiBai Image. The wand menu entry at the bottom left stays.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Show floating button</span>
          <input v-model="ui.showOrb" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">Shows a draggable floating button that opens BaiBai Image. Drop it mid-screen to leave it there, or near the left/right edge to dock it.</p>

        <!-- Floating-orb appearance: many options, tucked into a small group only once enabled -->
        <Collapsible v-if="ui.showOrb" title="Floating button appearance" :open="false">
          <div class="bbi-select-row">
            <span class="bbi-field-label">Shape</span>
            <BbiSelect v-model="orbShapeSel" :options="ORB_SHAPES" aria-label="Floating button shape" />
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
            <p class="bbi-field-hint">Opacity of the floating button at rest; it is always fully visible when summoned or dragged.</p>
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Custom icon</span>
            </div>
            <input class="bbi-input" type="text" v-model="ui.orbImage" placeholder="Image path on the ST server" spellcheck="false" />
            <p class="bbi-field-hint">Leave blank to use the default brush icon.</p>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- Secondary API: the model channels used to generate image tags (channel list shared with BaiBai Book) -->
      <Collapsible title="Secondary API" :open="false">
        <!-- Task assignment: there is only one task, generating tags -->
        <div class="bbi-field bbi-assign">
          <div class="bbi-assign-row">
            <span class="bbi-field-label">Tag generation</span>
            <BbiSelect v-model="tagGenSel" :options="TAG_GEN_OPTIONS" aria-label="API channel for tag generation" />
          </div>
        </div>
        <p class="bbi-field-hint">With no channel assigned, it follows the main API: the API your main chat uses (chat or text completion) writes the image tags, with no extra setup. To use a different model, add a secondary channel below and assign it. The channel list is shared with BaiBai Book, and changes on either side sync automatically.</p>

        <hr class="bbi-rule" />

        <!-- Channels: add button at the top + compact read-only list (click a row to edit in a dialog), no longer one long flat list -->
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">Channels</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addChannel()">
            <Icon name="plus" /> Add channel
          </button>
        </div>

        <ul v-if="settings.channels.length" class="bbi-channel-list">
          <li v-for="ch in settings.channels" :key="ch.id" class="bbi-channel-item">
            <button class="bbi-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbi-channel-item-name">{{ ch.name || 'Unnamed channel' }}</span>
              <span class="bbi-channel-item-model">{{ ch.model || 'No model set' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">No channels yet. Click &quot;Add channel&quot; to set up an API for tag generation.</p>
      </Collapsible>

      <Collapsible title="Automatic tags" :open="false">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Generate tags automatically</span>
          <input v-model="settings.autoTag.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">After AI text is generated, it judges whether the floor needs images and, if so, writes image tags.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Generate images automatically</span>
          <input v-model="settings.autoTag.autoGenerate" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">After tags are written, images are generated with the current image channel. When off, only tags are written, and you generate from the card.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Recent AI floors to include</span>
          <input
            v-model.number="settings.autoTag.contextMessages"
            class="bbi-input bbi-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">Counts AI story floors; user floors in between are included too.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Minimum images per floor</span>
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
          <span class="bbi-field-label">Maximum images per floor</span>
          <input
            v-model.number="settings.autoTag.maxImages"
            class="bbi-input bbi-num"
            type="number"
            :min="Math.max(1, settings.autoTag.minImages)"
            step="1"
            @change="normalizeAutoTagNumbers('maxImages')"
          />
        </label>
        <p class="bbi-field-hint">A minimum of 0 allows floors with no image; the plugin always enforces the maximum.</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">Automatic retries on failure</span>
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
        <p class="bbi-field-hint">Retries the secondary API automatically when the request fails or the response cannot be parsed. 0 = no retry; up to 5.</p>
      </Collapsible>

      <!-- Excluded characters: list shared with BaiBai Book (see shared storage in state/settings.ts); a change on either side syncs automatically -->
      <Collapsible title="Excluded characters" :open="false">
        <p class="bbi-field-hint">Chats with a listed character get no automatic image tags. The list is shared with BaiBai Book, and changes on either side sync automatically.</p>
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
        <p v-else class="bbi-field-hint">The list is empty; auto-tagging is on for every character.</p>
      </Collapsible>

      <!-- Excluded lorebook content: same lists shared with BaiBai Book -->
      <Collapsible title="Exclude lorebook content" :open="false">
        <p class="bbi-field-hint">
          Removes lorebook entries that are useless for images from the tag-generation context, saving tokens and avoiding noise. Shared with BaiBai Book; affects only the secondary API.
        </p>

        <!-- Whole-book exclusion: copies the excluded-characters search+check dialog -->
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
        <p v-else class="bbi-field-hint">No lorebooks are excluded; every activated entry is sent for tag generation.</p>

        <hr class="bbi-rule" />

        <!-- Filter by entry name: copies the cleanup-tag input + chips -->
        <div class="bbi-field-head">
          <span class="bbi-field-label">Filter by entry name</span>
        </div>
        <p class="bbi-field-hint">
          Matches entry names by <strong>substring</strong> (case-insensitive) and supports regular expressions (such as <code>^Rules</code>).
          The preset <code>\[mvu[\s\S]*?\]</code> filters MVU system entries; delete it if you do not need it.
        </p>
        <div class="bbi-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="bbi-input"
            type="text"
            placeholder="Entry name or regex, e.g. append or ^Rules"
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
        <p v-else class="bbi-field-hint">No entry-name rules.</p>
      </Collapsible>

      <!-- Custom cleanup tags: same list shared with BaiBai Book -->
      <Collapsible title="Custom cleanup tags" :open="false">
        <p class="bbi-field-hint">
          Enter a tag name (such as <code>snow</code>) and every <code>&lt;snow&gt;…&lt;/snow&gt;</code> block is removed from the story text and lorebook before scanning. The list is shared with BaiBai Book.
        </p>
        <div class="bbi-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbi-input"
            type="text"
            placeholder="Tag name, e.g. snow"
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

      <!-- Custom prompts (same entry point as BaiBai Book, in its own section) -->
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

    <!-- ===== Excluded characters dialog: search + checklist ===== -->
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
          <p v-if="!charNames.length" class="bbi-field-hint">No character list found. Load a character card in ST first.</p>
          <p v-else-if="!filteredCharNames.length" class="bbi-field-hint">No match &quot;{{ excludeSearch }}” role.</p>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-exclude-count">total {{ charNames.length }} characters · excluded {{ settings.excludes.excludedChars.length }}</span>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeExclude">Done</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Excluded lorebooks dialog: search + checklist (copying excluded characters) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Edit excluded lorebooks">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Excluded lorebooks</span>
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
          <p v-if="!worldNames.length" class="bbi-field-hint">No lorebooks found. Load or attach a lorebook in ST first.</p>
          <p v-else-if="!filteredWorldNames.length" class="bbi-field-hint">No match &quot;{{ excludeWorldSearch }}” lorebook.</p>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-exclude-count">total {{ worldNames.length }} This · Excluded {{ settings.excludes.excludedWorldNames.length }}</span>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeExcludeWorld">Done</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Channel editor dialog ===== -->
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
          <input v-model="editingChannel.url" class="bbi-input" placeholder="e.g. https://api.openai.com/v1" />
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
            <!-- Searchable combobox: with a fetched model list, focusing pops up a filtered menu; without one it's a plain input -->
            <div class="bbi-combo">
              <input
                v-model="editingChannel.model"
                class="bbi-input"
                :placeholder="modelList.length ? 'Search or enter model name…' : 'Model name, e.g. gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- Custom dropdown arrow (purely decorative, pointer-events:none → clicks pass through to the input to focus and open as usual); only shown when models are available -->
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
              :title="loadingModels[editingChannel.id] ? 'Fetching…' : 'Fetch models'"
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
          <!-- Reasoning effort uses BbiSelect (pure selection, no keyboard pop-up); it has a built-in fixed width of 180px,
               and here it must share space evenly with the other three, so :deep inside .bbi-mini-field releases the width -->
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
          <span class="bbi-modal-label">Exclude parameters</span>
          <input
            v-model="excludeParamsText"
            class="bbi-input"
            type="text"
            placeholder="Comma-separated, e.g. temperature, max_tokens"
          />
          <span class="bbi-field-hint">These parameters are removed from the request body before sending, for endpoints that do not accept them. Separate names with commas; leave blank to exclude nothing.</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbi-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbi-modal-foot">
          <!-- Delete on the left, apart from the main actions on the right, so the destructive action isn't next to "Done", reducing mis-taps.
               Delete: always shows text; Test: shows "Test channel" on PC and just "Test" on mobile (short version, saving space) -->
          <button class="bbi-btn bbi-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> Delete
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" title="Test channel" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbi-btn-label-full">Test channel</span><span class="bbi-btn-label-short">Test</span>
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmChannel">Done</button>
        </footer>

        <!-- Second confirmation for deleting a channel: stacked above the channel dialog. Placed inside the v-if="editingChannel" block,
             so nothing renders when the channel is null, which is semantically right and also narrows the type of editingChannel.name.
             ConfirmDialog teleports itself + uses the top layer, so placing it here doesn't affect its rendering layer. -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Delete channel"
          confirm-text="Delete"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          Delete channel &quot;{{ editingChannel.name || 'Unnamed channel' }}&quot;? This cannot be undone, and any task assigned to it is unassigned.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== Custom prompt editor dialog (UI copied from BaiBai Book) ===== -->
    <ModalMask :open="!!editingTagPrompt" @close="closeTagPrompt">
      <div
        v-if="editingTagPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`Edit ${editingTagPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Edit {{ editingTagPrompt.label }}</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeTagPrompt"><Icon name="close" /></button>
        </header>

        <p class="bbi-modal-label">{{ editingTagPrompt.hint }}</p>

        <!-- Available macros: click to insert at the caret (all four specifications and thought chains have natural-language conditional sections; the ComfyUI specification also has {{nl}};
             entries without macros don't show this bar) -->
        <div v-if="editingTagPrompt.macros.length" class="bbi-macro-bar">
          <span class="bbi-macro-tip">Click to insert a macro:</span>
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
      confirm-text="Update"
      busy-text="Updating…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      Current version v{{ updateState.current || '—' }}, latest version v{{ updateState.latest }}.<br />
      Update now? The page refreshes automatically when the update finishes.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbi-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* —— Version tag: solid accent background + inverted text; click to check again —— */
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

/* —— Master switch card —— */
/* An accent-coloured spine on the left edge; when disabled the whole card fades and the spine turns grey, making the state obvious */
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

/* —— Slide switch: used only by the master switch on this page —— */
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

/* ============ Secondary API: channels (same as BaiBai Book) ============ */

/* Task assignment */
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
/* Assignment dropdown: one size smaller than the global BbiSelect, aligned right and not filling half the row (same as BaiBai Book).
   BbiSelect has a built-in fixed width of 180px; here it is narrowed and max-width released to fit mobile. */
.bbi-assign-row :deep(.bbi-select-box) {
  width: 160px;
  max-width: 60%;
}
.bbi-assign-row :deep(.bbi-select-trigger) {
  font-size: 12px;
}

/* Channels: top action bar (label + add button) */
.bbi-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* Channels: compact read-only list, one row per channel; click a row to edit in a dialog */
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
/* Row body: clickable as a whole, name on the left, model on the right */
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
/* Channel name: shown in full, may wrap, takes the remaining space */
.bbi-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* Model name: secondary information, truncated when too long, never crowding the name */
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

/* —— Channel editor dialog —— */
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

/* —— Searchable model combobox —— */
.bbi-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbi-combo .bbi-input {
  width: 100%;
  padding-right: 26px; /* Make room for the custom arrow on the right so text doesn't run under it */
}
/* Custom dropdown arrow: the same SVG as native <select>, centred on the right; flips when open. A decorative element that doesn't block clicks */
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
/* Filter menu: absolutely positioned just below the input, height-capped with scrolling, so long lists don't blow up the dialog */
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

/* Temperature/max tokens/timeout/reasoning effort: four short controls side by side, falling to 2×2 on narrow screens (see the media query) */
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
/* BbiSelect has a built-in fixed width of 180px (designed for the settings page's row layout); here it must share space evenly with the other three */
.bbi-mini-field :deep(.bbi-select-box) {
  width: 100%;
}
/* Same height as the neighbouring number inputs: the trigger's default padding is slightly smaller than .bbi-input's */
.bbi-mini-field :deep(.bbi-select-trigger) {
  padding: 7px 10px;
}
.bbi-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbi-ink-soft);
  word-break: break-all;
}

/* Dialog footer: the spacer pushes the delete button to the far left, separated from the actions on the right */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* Dangerous-action button: subtle outline, red only on hover, to avoid mis-clicks */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* Test button text: by default (PC) the full version shows and the short one hides; they swap on narrow screens in the media query */
.bbi-btn-label-short {
  display: none;
}

/* —— Custom prompt list (UI copied from BaiBai Book) —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* The whole row is clickable to open the editor dialog; layout follows the channel list's look (outline, accent on hover) */
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
/* The status pill (.bbi-prompt-state / .is-custom) has moved to global base.css: the channels page uses it too */
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

/* —— Prompt dialog: wider + large text box —— */
.bbi-modal-wide {
  max-width: 680px;
}
/* Macro chip bar: wraps horizontally; clicking a macro inserts it */
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

/* ============ Exclusion lists (chips + dialog list): same interaction as BaiBai Book, with class names switched to the bbi prefix ============ */
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

/* ============ Mobile: body text inside collapsible sections one size smaller, matching the narrow-screen title rhythm ============ */
@media (max-width: 640px) {
  .bbi-auto-grid {
    grid-template-columns: 1fr;
  }
  /* The four channel parameters: on narrow screens four in a row leaves each only a few dozen px, so they fall to 2×2 */
  .bbi-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .bbi-channel-item-name {
    font-size: 13px;
  }
  .bbi-channel-item-model {
    font-size: 11px;
  }
  /* Channel dialog footer: on narrow screens the test button shows only the short "Test"; PC shows the full "Test channel" */
  .bbi-btn-label-full {
    display: none;
  }
  .bbi-btn-label-short {
    display: inline;
  }
}
</style>
