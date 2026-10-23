<script setup lang="ts">
import {
  CHATU8_SETTINGS_KEY,
  detectChatu8Artists,
  detectChatu8Vibes,
  importArtistsFromChatu8,
  importVibesFromChatu8,
  planPrefixGroups,
  type Chatu8ArtistDetectInfo,
  type Chatu8ArtistImportResult,
  type Chatu8DetectInfo,
} from '@/backends/chatu8Vibe';
import {
  buildNaiv4vibe,
  BUILTIN_NAI_ARTISTS,
  encodeVibeImage,
  isBuiltinNaiArtist,
  isNai5,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiSamplers,
  naiSupportsVibes,
  NAI_NOISE_SCHEDULES,
  parseNaiv4vibe,
  testNaiConnection,
  vibeModelKey,
} from '@/backends/nai';
import {
  clampVibeStrength,
  deleteVibeData,
  loadVibeData,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import NaiArtistManager from '@/pages/backend/panels/NaiArtistManager.vue';
import { acquireNaiSlot } from '@/floor/genQueue';
import { makeJpegThumbnail } from '@/st/imageFile';
import { deleteUserImage } from '@/st/images';
import {
  groupKey,
  groupVibes,
  isGroupActive,
  matchVibe,
  GROUP_PREFIX,
  NEW_GROUP,
  UNGROUPED,
  type VibeGroup,
} from '@/backends/vibeGroups';
import Collapsible from '@/components/Collapsible.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { getContext } from '@/st/context';
import {
  activeNaiArtist,
  activeNaiEndpoint,
  effectiveNai,
  isOfficialNaiEndpoint,
  newNaiArtist,
  newNaiEndpoint,
  NAI_MODELS,
  NAI_OFFICIAL_URL,
  ORIENTATION_LOCKS,
  settings,
  type NaiArtistPreset,
  type NaiEndpoint,
  type NaiVibe,
} from '@/state/settings';
import { computed, nextTick, onMounted, ref } from 'vue';

/** Whether this channel is the current image channel; the "Use this channel" button, the settings page selector and the tab badge are one switch. */
const inUse = computed(() => settings.defaultBackend === 'nai');

const testing = ref(false);
const showKey = ref(false);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Operation canceled';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    // Tests the currently selected endpoint (not the channel-level legacy url/key), the same connection used for generation
    const result = await testNaiConnection(effectiveNai());
    toastr.success(result.message, `NAI connection · ${endpoint.value.name}`);
  } catch (error) {
    toastr.error(errorMessage(error), `NAI connection failed · ${endpoint.value.name}`);
  } finally {
    testing.value = false;
  }
}

/* ============ Endpoint library (address + key; same shape as the artist string row below) ============ */

/**
 * Multiple endpoints solve "switching between community-run sites": the same image parameters, a different exit.
 * So this only handles url/key; model/sampler/size all stay at the channel level, and switching sites needs no reconfiguration.
 */
const endpoint = computed<NaiEndpoint>(() => activeNaiEndpoint());

/** The official one is read-only: its name/address can't be changed or deleted; only duplicated copies can be changed freely. */
const isOfficialEndpoint = computed(() => isOfficialNaiEndpoint(endpoint.value.id));

const endpointOptions = computed(() =>
  settings.nai.endpoints.map(e => ({ value: e.id, label: e.name || 'Unnamed access point' })),
);

/** The dropdown takes "the one actually in effect", not the stored id: when dangling, activeNaiEndpoint falls back to the first, and the dropdown must follow. */
const activeEndpointId = computed<string>({
  get: () => endpoint.value.id,
  set: id => {
    settings.nai.activeEndpointId = id;
  },
});

/** Renaming is rare: normally only the dropdown shows; clicking "Rename" swaps the picker in place for an input box (same as the artist string row). */
const renamingEndpoint = ref(false);
const endpointNameDraft = ref('');
const endpointNameInput = ref<HTMLInputElement | null>(null);
const endpointDeleteOpen = ref(false);

function startRenameEndpoint() {
  if (isOfficialEndpoint.value) return; // The official entry is read-only (the button is already disabled; belt and braces)
  endpointNameDraft.value = endpoint.value.name;
  renamingEndpoint.value = true;
  nextTick(() => endpointNameInput.value?.focus());
}

/** Enter / blur both confirm; Esc sets false directly without going through here, which is cancel. */
function commitRenameEndpoint() {
  if (renamingEndpoint.value && !isOfficialEndpoint.value) {
    endpoint.value.name = endpointNameDraft.value.trim() || endpoint.value.name;
  }
  renamingEndpoint.value = false;
}

function addEndpoint() {
  const preset = newNaiEndpoint(`access point ${settings.nai.endpoints.length + 1}`);
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function duplicateEndpoint() {
  // The official entry goes through here too: the copy is a normal entry with an editable address; a shortcut for "make a mirror based on the official one"
  const src = endpoint.value;
  const preset: NaiEndpoint = { ...newNaiEndpoint(), name: `${src.name} copy`, url: src.url, key: src.key };
  settings.nai.endpoints.push(preset);
  settings.nai.activeEndpointId = preset.id;
}

function confirmRemoveEndpoint() {
  endpointDeleteOpen.value = false;
  if (isOfficialEndpoint.value) return; // The official entry can't be deleted: it guarantees endpoints is never empty
  const list = settings.nai.endpoints;
  const index = list.findIndex(e => e.id === endpoint.value.id);
  if (index < 0) return;
  list.splice(index, 1);
  // The entry at the original position takes its place (step back one if it was the last). **Unlike** the artist string, it doesn't fall back to an empty string:
  // the address is essential, and without one no image can be generated; same rule as the workflow library.
  settings.nai.activeEndpointId = list[Math.min(index, list.length - 1)].id;
}

/* ============ Artist string library (same shape as the ComfyUI workflow library) ============ */

/**
 * The currently selected artist string; null = none used (empty library, the user actively chose "None", or a dangling id).
 * settings is reactive, so its fields can be bound with v-model directly for in-place editing.
 */
const artist = computed<NaiArtistPreset | null>(() => activeNaiArtist());

/** Whether the current model is V5: controls the V5 difference reminder in the artist string editing area. */
const isV5Model = computed(() => isNai5(settings.nai.model));

/** Dropdown value for "None". Preset ids always have the art_* / bi_* shape, so an empty string can't collide with any entry; no boxing needed. */
const NO_ARTIST = '';

const artistOptions = computed(() => [
  { value: NO_ARTIST, label: 'Not used' },
  // Built-in recipes go before the user library: new users have a built-in entry selected by default, which sits most naturally next to "None";
  // a built-in note in parentheses after the name sets it apart from user-made entries with the same name
  ...BUILTIN_NAI_ARTISTS.map(a => ({ value: a.id, label: `${a.name}(built-in)` })),
  ...settings.nai.artistPresets.map(a => ({ value: a.id, label: a.name || 'Unnamed artist string' })),
]);

/**
 * The dropdown's value takes "the one actually in effect", not the stored id: when the stored id dangles, activeNaiArtist returns null,
 * and the dropdown should show "None" accordingly, not a blank.
 */
const activeArtistId = computed<string>({
  get: () => artist.value?.id ?? NO_ARTIST,
  set: id => {
    settings.nai.activeArtistId = id;
  },
});

/** Rename/duplicate/delete only make sense when an entry is really selected; all are disabled when "None" is chosen. */
const hasArtist = computed(() => artist.value !== null);

/** The current selection is a built-in recipe: read-only (rename/delete/content editing disabled); "Duplicate" is the only way to customise. */
const isBuiltinArtist = computed(() =>
  artist.value ? isBuiltinNaiArtist(artist.value.id) : false,
);

/** Renaming is a rare action: normally only the dropdown shows; clicking "Rename" swaps the picker in place for an input box. */
const renamingArtist = ref(false);
const artistNameDraft = ref('');
const artistNameInput = ref<HTMLInputElement | null>(null);
const artistDeleteOpen = ref(false);
/** Manager dialog: search/preview images/bulk deletion by ticking are all there; the dropdown here keeps only frequent switching. */
const artistManagerOpen = ref(false);

function startRenameArtist() {
  if (!artist.value || isBuiltinArtist.value) return; // Built-ins are read-only (the button is already disabled; belt and braces)
  artistNameDraft.value = artist.value.name;
  renamingArtist.value = true;
  nextTick(() => artistNameInput.value?.focus());
}

/** Enter / blur both confirm; Esc sets renamingArtist=false directly without going through here, which is cancel. */
function commitRenameArtist() {
  if (renamingArtist.value && artist.value) artist.value.name = artistNameDraft.value.trim();
  renamingArtist.value = false;
}

function addArtist() {
  const preset = newNaiArtist(`Artist Tags ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

function duplicateArtist() {
  const src = artist.value;
  if (!src) return;
  // Change only the id and name; id generation still follows settings' single rule.
  // Built-in recipes go through here too: the copy is a normal user entry, freely editable; this is the only customisation path for built-ins.
  // Explicit field-by-field copy, without previewPath: the preview file is deleted with the original entry, and sharing one path would break the copy's image later.
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} copy`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
}

async function confirmRemoveArtist() {
  artistDeleteOpen.value = false;
  const list = settings.nai.artistPresets;
  const index = list.findIndex(a => a.id === artist.value?.id);
  if (index < 0) return;
  // The preview image file is cleaned up along with it, best-effort (same rule as deleting in the manager: a file that can't be deleted doesn't block deleting the entry)
  const previewPath = list[index].previewPath;
  if (previewPath) {
    try {
      await deleteUserImage(previewPath);
    } catch (error) {
      toastr.warning(`The entry was deleted, but the preview file cleanup failed: ${errorMessage(error)}`, 'Artist Tags');
    }
  }
  list.splice(index, 1);
  // The entry at the original position takes its place (step back one if it was the last); when emptied, go back to "None":
  // `?? ''` is exactly the dividing line between the artist string library and the workflow library (that one is never empty and falls back to [0]); it can't be dropped.
  settings.nai.activeArtistId = list[Math.min(index, list.length - 1)]?.id ?? '';
}

/* ============ Migrate prompt presets from Chiehime ============ */

/**
 * Moves Chiehime (st-chatu8)'s prompt presets over in one batch, mapped the same way Chiehime assembles them:
 * leading fixed positive → artist string, trailing fixed positive → positive quality tags, fixed negative → negative prompt (prefixed with the current model's official baseline).
 * Same principle as vibe migration: only copies are made, the source data is untouched; re-importing a same-name entry overwrites and updates it
 * (entries where the old migration stuffed the whole positive into the artist string are fixed by re-importing), entries with identical content are skipped, and it can be rerun any time.
 * The pure logic is in chatu8Vibe.ts (the collect/detect/import trio); here it only handles detection display, the dialog preview and saving.
 *
 * There is deliberately no permanent "N left to import" hint: the dedup key is name + content, and once the user edits or deletes
 * a local copy the keys no longer match, so the hint would keep coming back, which is noisy. The entry point is tucked into the "Migrate from Chiehime"
 * fold below; the preview is only computed when the dialog is opened manually, and whether there are new presets is clear at a glance.
 */
const chatu8ArtistDetect = ref<Chatu8ArtistDetectInfo>({ found: false, total: 0 });
/** Preview result computed once when the dialog opens (pure function, nothing saved); plans carries a badge state per entry. */
const artistImportResult = ref<Chatu8ArtistImportResult | null>(null);
const artistImportOpen = ref(false);
/** Whether to set the preset Chiehime currently uses as BaiBai Image's current artist string after importing. */
const switchActiveArtist = ref(true);

const chatu8ActiveRef = computed(() => artistImportResult.value?.plans.find(p => p.active) ?? null);

function openArtistImport() {
  const chatu8 = getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY];
  artistImportResult.value = importArtistsFromChatu8(settings.nai.artistPresets, chatu8, settings.nai.model);
  switchActiveArtist.value = true;
  artistImportOpen.value = true;
}

/** Purely synchronous: the result was computed when the dialog opened; confirming is only push/overwrite + an optional switch. */
function runArtistImport() {
  const result = artistImportResult.value;
  artistImportOpen.value = false;
  if (!result || (result.imported === 0 && result.overwritten === 0)) return;
  for (const plan of result.plans) {
    if (plan.state === 'import') {
      settings.nai.artistPresets.push(plan.preset!);
    } else if (plan.state === 'overwrite') {
      const target = settings.nai.artistPresets.find(p => p.id === plan.targetId);
      if (target && plan.preset) {
        target.prompt = plan.preset.prompt;
        target.quality = plan.preset.quality;
        target.negative = plan.preset.negative;
      }
    }
  }
  if (switchActiveArtist.value && result.activeArtistId) {
    settings.nai.activeArtistId = result.activeArtistId;
  }
  const parts = [`${result.imported} new`];
  if (result.overwritten) parts.push(`Overwrite updates ${result.overwritten} items`);
  if (result.duplicates) parts.push(`same skip ${result.duplicates}`);
  if (switchActiveArtist.value && result.activeArtistId) {
    parts.push('Switched to the default currently used by Tomoehime');
  }
  toastr.success(parts.join(', '), 'Imported from Chiehime');
  artistImportResult.value = null;
}

/* ============ Prompts: positive/negative words in tiers: artist string bound value → channel override → built-in default ============ */

/**
 * Edit target for one positive/negative entry; the channel level and the artist-string binding level share one dialog.
 *
 * fallback = the next level's value followed when left blank (channel level → the model's official words; binding level → channel value → official words).
 * The dialog is prefilled with it: an empty box would just move the old problem of "can't see what is actually in effect" somewhere else;
 * on save, a value equal to the fallback is stored as an empty string (same rule as the settings page's saveTagPrompt: the next level's value isn't stored redundantly,
 * keeping the "follow" meaning, so it changes along when the next level changes).
 *
 * fallback must be a function, not a constant: it changes with settings.nai.model / the channel override and must be evaluated when read.
 */
interface NaiPromptTarget {
  key: 'quality' | 'negative';
  label: string;
  hint: string;
  /** A built-in recipe's binding slots are read-only: the dialog is view-only and can't save (writing into a module constant would be bad). */
  readonly?: boolean;
  fallback: () => string;
  read: () => string;
  write: (v: string) => void;
}

/** The two channel-level entries: in effect when the artist string doesn't bind the matching field; left blank too, the model's official words are used. */
const CHANNEL_PROMPT_TARGETS: NaiPromptTarget[] = [
  {
    key: 'quality',
    label: 'positive quality words',
    hint: 'After the picture tag (the overall sequence: artist string → picture tag → quality word). When the quality word is set in the artist string, the artist string will be used, and the one here will not take effect.',
    fallback: () => naiDefaultQualityTags(settings.nai.model),
    read: () => settings.nai.qualityTags,
    write: v => (settings.nai.qualityTags = v),
  },
  {
    key: 'negative',
    label: 'negative cue words',
    hint: 'Leave blank = get the official negative words according to the model; if you want to exclude anything else, add it directly to this one. When negative words are set in the artist string, the artist string will be used, and the one here will not take effect.',
    fallback: () => naiDefaultUndesired(settings.nai.model),
    read: () => settings.nai.undesiredContent,
    write: v => (settings.nai.undesiredContent = v),
  },
];

/**
 * The current artist string's two binding slots; read/write land directly on the selected entry (settings is reactive; edited in place).
 * They exist only when an entry is really selected (with "None" there is no bound object, and the whole list isn't rendered).
 */
const artistBoundTargets = computed<NaiPromptTarget[]>(() => {
  const a = artist.value;
  if (!a) return [];
  const readonly = isBuiltinArtist.value;
  return [
    {
      key: 'quality',
      label: 'positive quality words',
      readonly,
      hint: readonly
        ? 'The binding bit of the built-in artist tags is updated with the plug-in version and cannot be changed; it can be customized after copying it to my artist tags. Leave it blank = use channel level settings (if the channel level is also left blank, the official word will be taken according to the model).'
        : 'This quality word switches with the current artist string. Leave it blank = use channel level settings (if the channel level is also left blank, the official word will be taken according to the model).',
      fallback: () => settings.nai.qualityTags.trim() || naiDefaultQualityTags(settings.nai.model),
      read: () => a.quality,
      write: v => (a.quality = v),
    },
    {
      key: 'negative',
      label: 'negative cue words',
      readonly,
      hint: readonly
        ? 'The binding bit of the built-in artist tags is updated with the plug-in version and cannot be changed; it can be customized after copying it to my artist tags. Leave blank = use channel level settings (if channel level is also left blank, official negative words will be taken according to the model).'
        : 'This negative word switches with the current artist string. Leave blank = use channel level settings (if channel level is also left blank, official negative words will be taken according to the model).',
      fallback: () =>
        settings.nai.undesiredContent.trim() || naiDefaultUndesired(settings.nai.model),
      read: () => a.negative,
      write: v => (a.negative = v),
    },
  ];
});

/** Whether this entry already has a custom value (non-empty counts as overriding the next level). */
function isTargetCustom(target: NaiPromptTarget): boolean {
  return target.read().trim().length > 0;
}

/** Whether the current artist string binds this field: when bound, the channel value is overridden, and the channel list's badge should say so. */
function isShadowedByArtist(key: NaiPromptTarget['key']): boolean {
  const a = artist.value;
  if (!a) return false;
  return key === 'quality' ? !!a.quality.trim() : !!a.negative.trim();
}

// The entry being edited; draft is the draft, written back to settings only on "Done" (discarded on cancel).
const editingNaiPrompt = ref<NaiPromptTarget | null>(null);
const naiPromptDraft = ref('');

function openNaiPrompt(target: NaiPromptTarget) {
  editingNaiPrompt.value = target;
  // Customised → load the user's content; not customised → prefill the next level's fallback, for easy editing on top of it
  naiPromptDraft.value = target.read().trim() || target.fallback();
}
function closeNaiPrompt() {
  editingNaiPrompt.value = null;
  naiPromptDraft.value = '';
}
function saveNaiPrompt() {
  const target = editingNaiPrompt.value;
  if (!target || target.readonly) return; // A built-in recipe's binding slots are read-only (the button is already hidden; belt and braces)
  const v = naiPromptDraft.value.trim();
  target.write(v === target.fallback().trim() ? '' : naiPromptDraft.value);
  closeNaiPrompt();
}
/** "Restore default": resets the draft to the fallback (after saving it goes back to "follow the next level") */
function resetNaiPromptDraft() {
  const target = editingNaiPrompt.value;
  if (target) naiPromptDraft.value = target.fallback();
}

/* ============ Vibe library ============ */

const vibeEncoding = ref(false);
const vibeFileInput = ref<HTMLInputElement | null>(null);
const vibeImportInput = ref<HTMLInputElement | null>(null);

let vibeSeq = 0;

/** The current model's vibe encoding key; vibes missing this key are skipped during generation, and the list offers an "Add encoding" entry. */
const currentVibeKey = computed(() => vibeModelKey(settings.nai.model));
const vibesSupported = computed(() => naiSupportsVibes(settings.nai.model));
const samplerOptions = computed(() => naiSamplers(settings.nai.model));

/** BbiSelect's modelValue is a string, while nai.model is a literal union; this get/set only bridges them.
 *  Checked against NAI_MODELS before writing: the dropdown only emits valid values anyway, but without this the type assertion would be an empty promise. */
const modelSel = computed<string>({
  get: () => settings.nai.model,
  set: v => {
    const hit = NAI_MODELS.find(m => m.value === v);
    if (hit) settings.nai.model = hit.value;
  },
});

/** Generates the vibe list thumbnail (a jpeg data URL with a longest side of 96px); returns an empty string on failure, which the importer treats as "no thumbnail". */
async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    return await makeJpegThumbnail(dataUrl, 96);
  } catch {
    return '';
  }
}

/**
 * Takes a gate slot to run one vibe encoding.
 *
 * Encoding is a real NAI request, so it shares the same gate as floor cards (floor/genQueue.ts):
 * otherwise "generating and encoding at once" would be two concurrent requests on the account, bypassing the 429 cooldown entirely.
 * The cost is that clicking encode while an image is generating waits for the image first; that is correct, and the button shows a vibeEncoding spinner.
 */
async function encodeVibeGated(imageBase64: string): Promise<string> {
  const release = await acquireNaiSlot();
  try {
    return await encodeVibeImage(effectiveNai(), imageBase64, settings.nai.model);
  } finally {
    release();
  }
}

/** Upload a reference image → call /ai/encode-vibe to encode it (for the current model) → add it to the library. */
async function onVibeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
    const imageBase64 = dataUrl.split(',')[1] ?? '';
    const encoding = await encodeVibeGated(imageBase64);
    const thumbnail = await makeThumbnail(dataUrl);
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = {
      image: imageBase64,
      thumbnail,
      encodings: { [currentVibeKey.value]: { encoding, infoExtracted: 1 } },
    };
    const paths = await saveVibeFiles(data, null, id);
    settings.nai.vibes.push(
      vibeMetaFromData(
        id,
        file.name.replace(/\.[^.]+$/, '') || `Vibe ${settings.nai.vibes.length + 1}`,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        0.6,
        true,
      ),
    );
    toastr.success(`Pressed ${settings.nai.model} Coding and adding to Vibe library`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe encoding failed');
  } finally {
    vibeEncoding.value = false;
  }
}

/** Adds a vibe's missing encoding for the current model on its own (common after switching models). */
async function reencodeVibe(vibe: NaiVibe) {
  if (!vibe.hasImage || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const data = await loadVibeData(vibe);
    if (!data.image) throw new Error('The Vibe does not refer to the original image');
    const encoding = await encodeVibeGated(data.image);
    data.encodings[currentVibeKey.value] = { encoding, infoExtracted: 1 };
    const paths = await saveVibeFiles(data, vibe, vibe.id);
    vibe.dataPath = paths.dataPath;
    vibe.thumbnailPath = paths.thumbnailPath;
    vibe.modelKeys = Object.keys(data.encodings);
    vibe.fingerprint = vibeFingerprint(data.encodings);
    toastr.success(`Added ${settings.nai.model} encoding for "${vibe.name}"`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe encoding failed');
  } finally {
    vibeEncoding.value = false;
  }
}

/* ============ Vibe groups ============ */

/** The pure logic for gathering/search/effective checks is in backends/vibeGroups.ts; this only handles interaction and saving. */
const vibeSearch = ref('');
/** Set of collapsed group keys (all expanded by default; only "collapsed" is stored, so new groups are naturally expanded). */
const collapsedGroups = ref<Set<string>>(new Set());

const vibeGroups = computed(() => groupVibes(settings.nai.vibes, vibeSearch.value));

/** Total search hits: for the "no matches" empty state, without computing the list again. */
const matchedCount = computed(() =>
  settings.nai.vibes.reduce((n, v) => n + (matchVibe(v, vibeSearch.value) ? 1 : 0), 0),
);

/** Group names already in the library (deduplicated, for the "Move to group" dropdown; based on the whole library, not search results). */
const groupNames = computed(() => {
  const names = new Set<string>();
  for (const vibe of settings.nai.vibes) {
    const name = vibe.group.trim();
    if (name) names.add(name);
  }
  return [...names];
});

/** "Group" dropdown options for a single vibe: ungrouped + existing groups + new (group names are boxed to avoid clashing with sentinels). */
const groupOptions = computed(() => [
  { value: UNGROUPED, label: 'Ungrouped' },
  ...groupNames.value.map(name => ({ value: `${GROUP_PREFIX}${name}`, label: name })),
  { value: NEW_GROUP, label: '+ Create new group…' },
]);

/** Choosing "New group" asks for a name on the spot; on cancel or an empty name the old value stays (the dropdown is controlled, so it must be written back). */
function onGroupPick(vibe: NaiVibe, value: string) {
  if (value === UNGROUPED) {
    vibe.group = '';
    return;
  }
  if (value.startsWith(GROUP_PREFIX)) {
    vibe.group = value.slice(GROUP_PREFIX.length);
    return;
  }
  const name = window.prompt('New group name')?.trim();
  if (name) vibe.group = name;
}

function isGroupCollapsed(key: string): boolean {
  return collapsedGroups.value.has(key);
}

function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (!next.delete(key)) next.add(key);
  collapsedGroups.value = next;
}

function groupActive(group: VibeGroup): boolean {
  return isGroupActive(group, settings.nai.vibes);
}

/** Enable only this group: clears ticks outside the group and enables this group. Solves the pain of clicking one by one to "switch to another set". */
function soloGroup(group: VibeGroup) {
  const ids = new Set(group.all.map(v => v.id));
  for (const vibe of settings.nai.vibes) vibe.enabled = ids.has(vibe.id);
}

/** Enable all/disable all only touches this group, never others; to stack two groups, click "Enable all" on each. */
function setGroupEnabled(group: VibeGroup, enabled: boolean) {
  for (const vibe of group.all) vibe.enabled = enabled;
}

const enabledCount = computed(() => settings.nai.vibes.filter(v => v.enabled).length);

function groupEnabledCount(group: VibeGroup): number {
  return group.all.filter(v => v.enabled).length;
}

/** Renames a whole group: assigns the members' group field in bulk, leaving no dangling references. */
function renameGroup(group: VibeGroup) {
  if (!group.name) return;
  const name = window.prompt('Rename group', group.name)?.trim();
  if (!name || name === group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = name;
  }
  // The collapsed state follows the rename (the set stores boxed keys), otherwise the group would inexplicably expand after renaming
  const from = groupKey(group.name);
  if (collapsedGroups.value.has(from)) {
    const next = new Set(collapsedGroups.value);
    next.delete(from);
    next.add(groupKey(name));
    collapsedGroups.value = next;
  }
}

/** Disbands a group: only clears the group field; the vibes themselves and their enabled state are untouched (it isn't deletion). */
function dissolveGroup(group: VibeGroup) {
  if (!group.name) return;
  for (const vibe of settings.nai.vibes) {
    if (vibe.group.trim() === group.name) vibe.group = '';
  }
}

/**
 * The old version, when migrating from Chiehime, joined the group name into the display name ("group name · original name"), losing the group structure.
 * This restores it by prefix: only ungrouped entries are touched, never overwriting groups the user already sorted by hand.
 * The button only appears when there really are entries to tidy; a button that does nothing when clicked is worse than none.
 */
const prefixGroupPlans = computed(() => planPrefixGroups(settings.nai.vibes));

function applyPrefixGroups() {
  const plans = prefixGroupPlans.value;
  if (!plans.length) return;
  const byId = new Map(settings.nai.vibes.map(v => [v.id, v]));
  for (const plan of plans) {
    const vibe = byId.get(plan.id);
    if (!vibe) continue;
    vibe.group = plan.group;
    vibe.name = plan.name;
  }
  const groups = new Set(plans.map(p => p.group)).size;
  toastr.success(`Already put ${plans.length} Vibe sorted into ${groups} groups`, 'Vibe');
}

/* ============ Migrate from Chiehime ============ */

/**
 * Chiehime vibe detection: done once when the panel mounts (it reads the reference list in settings; synchronous and cheap).
 * No "ask only once" logic: the section is permanent, migration is idempotent (deduplicated by content fingerprint), and users can rerun it any time.
 */
const chatu8Detect = ref<Chatu8DetectInfo>({ found: false, total: 0, presets: 0, groups: 0 });
onMounted(() => {
  chatu8Detect.value = detectChatu8Vibes(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
  chatu8ArtistDetect.value = detectChatu8Artists(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
});

const migrateConfirmOpen = ref(false);
const migrating = ref(false);
const migrateMsg = ref('');

async function runMigrate() {
  migrateConfirmOpen.value = false;
  if (migrating.value) return;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const result = await importVibesFromChatu8(settings.nai.vibes, {
      onProgress: (current, total) => {
        migrateMsg.value = `Migrating ${current}/${total}…`;
      },
    });
    settings.nai.vibes.push(...result.vibes);
    const parts = [`${result.imported} new`];
    if (result.duplicates) parts.push(`${result.duplicates} duplicates skipped`);
    if (result.failed) parts.push(`${result.failed} failed`);
    migrateMsg.value = `Migration completed: ${parts.join(' / ')}. `;
    if (result.imported) migrateMsg.value += 'Newly migrated vibes are disabled by default; enable them as needed. ';
    if (result.failed) migrateMsg.value += 'Failed items may not be in this browser, or saving the file failed.';
    toastr.success(migrateMsg.value, 'Migrate from Chiehime');
  } catch (error) {
    migrateMsg.value = `Migration failed: ${errorMessage(error)}`;
  } finally {
    migrating.value = false;
  }
}

async function onVibeImportChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = parseNaiv4vibe(await file.text());
    const id = `vibe_${Date.now()}_${++vibeSeq}`;
    const data = { image: parsed.image, thumbnail: parsed.thumbnail, encodings: parsed.encodings };
    const paths = await saveVibeFiles(data, null, id);
    settings.nai.vibes.push(
      vibeMetaFromData(id, parsed.name, paths.dataPath, paths.thumbnailPath, data, parsed.strength, true),
    );
    toastr.success(`Imported "${parsed.name}"`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe import failed');
  }
}

async function exportVibe(vibe: NaiVibe) {
  try {
    const json = await buildNaiv4vibe(vibe, await loadVibeData(vibe));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vibe.name || 'vibe'}.naiv4vibe`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe export failed');
  }
}

/**
 * Strength values: the slider and number box share clampVibeStrength (the same rule as settings deserialisation and vibe import).
 * The slider's 0.01 step is only granularity that's "nice to drag"; the number box's step="any" is real free entry:
 * want 0.375, type 0.375, no longer snapped to multiples of 5 by the step.
 */
function setVibeStrength(vibe: NaiVibe, raw: unknown) {
  vibe.strength = clampVibeStrength(raw, vibe.strength);
}

/**
 * The number box uses change (not input): half-typed strings like "0." / "-" shouldn't be clamped to 0 immediately.
 * After clamping, input.value is written back: typing 5 is clamped to 1, and when the strength was already 1 the model value doesn't change,
 * Vue doesn't re-render, and a misleading "5" would stay in the box.
 */
function commitVibeStrength(vibe: NaiVibe, event: Event) {
  const input = event.target as HTMLInputElement;
  setVibeStrength(vibe, input.value);
  input.value = String(vibe.strength);
}

async function removeVibe(vibe: NaiVibe) {
  let deleteError: unknown = null;
  try {
    await deleteVibeData(vibe);
  } catch (error) {
    deleteError = error;
  }
  const index = settings.nai.vibes.indexOf(vibe);
  if (index >= 0) settings.nai.vibes.splice(index, 1);
  if (deleteError) toastr.warning(`Index deleted, but file cleanup failed: ${errorMessage(deleteError)}`, 'Vibe');
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      NovelAI image generation interface. The default address is official. Fill in the third-party compatible site (mirroring/forwarding) and go to the third party. The agreement is consistent.
    </p>

    <div class="bbi-sections">
      <Collapsible title="Config" :open="false">
        <!-- Endpoint library: people who rotate community relays have more than one exit, but switching sites only changes address + key;
             image parameters such as model/sampler/size all stay below, shared at channel level, so switching sites needs no reconfiguration -->
        <div class="art-row">
          <span class="bbi-field-label">access point</span>
          <input
            v-if="renamingEndpoint"
            ref="endpointNameInput"
            class="bbi-input"
            type="text"
            v-model="endpointNameDraft"
            placeholder="access point name"
            spellcheck="false"
            title="Enter confirmed, Esc canceled"
            @keydown.enter.prevent="commitRenameEndpoint"
            @keydown.esc.stop.prevent="renamingEndpoint = false"
            @blur="commitRenameEndpoint"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeEndpointId"
            :options="endpointOptions"
            aria-label="Current access point"
          />
          <span v-if="!renamingEndpoint" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? 'Official access points cannot be renamed' : 'Rename current access point'"
              aria-label="Rename current access point"
              @click="startRenameEndpoint"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="Create a new empty access point"
              aria-label="Create a new empty access point"
              @click="addEndpoint"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :title="
                isOfficialEndpoint
                  ? 'Copy the official one, and the copied address can be changed.'
                  : 'Copy the current access point (including address and key)'
              "
              aria-label="Copy current access point"
              @click="duplicateEndpoint"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="isOfficialEndpoint"
              :title="isOfficialEndpoint ? 'Official access points cannot be deleted' : 'Delete current access point'"
              aria-label="Delete current access point"
              @click="endpointDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">interface address</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="endpoint.url"
            :readonly="isOfficialEndpoint"
            :placeholder="NAI_OFFICIAL_URL"
            spellcheck="false"
            :title="isOfficialEndpoint ? 'The official access point address is fixed and cannot be modified.' : ''"
          />
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? 'The official access point has a fixed address; if you want to use a third-party site, please click "+" above to create a new one.'
                : 'Just fill in the domain name for the third-party website, and the /ai endpoint will be automatically completed.'
            }}
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="endpoint.key"
              placeholder="nai-..."
              spellcheck="false"
            />
            <button
              class="bbi-btn"
              type="button"
              :title="showKey ? 'hide' : 'show'"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
          <!-- The key travels with the entry rather than being shared at channel level: each community relay has its own key, and a shared one would mean re-entering it on every switch -->
          <p class="bbi-field-hint">
            {{
              isOfficialEndpoint
                ? 'Generated in NovelAI settings page. Each access point stores its own key.'
                : 'The station\'s own key; each access point stores its own, and switching back to the official one will not cause confusion.'
            }}
          </p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> Active image backend</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag writing specification will switch to NAI"
            @click="settings.defaultBackend = 'nai'"
          >
            Use this channel to publish pictures
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? 'Connecting…' : 'Test connection' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="prompt word" :open="false">
        <!-- Artist-string library: same layout as the ComfyUI workflow library, plus a "None" option -->
        <div class="art-row">
          <span class="bbi-field-label">Artist Tags</span>
          <input
            v-if="renamingArtist"
            ref="artistNameInput"
            class="bbi-input"
            type="text"
            v-model="artistNameDraft"
            placeholder="Artist Tags name"
            spellcheck="false"
            title="Enter confirmed, Esc canceled"
            @keydown.enter.prevent="commitRenameArtist"
            @keydown.esc.stop.prevent="renamingArtist = false"
            @blur="commitRenameArtist"
          />
          <BbiSelect
            v-else
            class="art-select"
            v-model="activeArtistId"
            :options="artistOptions"
            aria-label="Current artist string"
          />
          <span v-if="!renamingArtist" class="art-ops">
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="Manage artist string library: search, preview images, batch deletion"
              aria-label="Manage artist library"
              @click="artistManagerOpen = true"
            >
              <Icon name="grid" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? 'Unselected artist string'
                  : isBuiltinArtist
                    ? 'The built-in artist string cannot be renamed, click copy to create your own'
                    : 'Rename the current artist tags'
              "
              aria-label="Rename the current artist tags"
              @click="startRenameArtist"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              title="Create a new empty artist tags"
              aria-label="Create a new empty artist tags"
              @click="addArtist"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op"
              type="button"
              :disabled="!hasArtist"
              :title="
                !hasArtist
                  ? 'Unselected artist string'
                  : isBuiltinArtist
                    ? 'Copy it as my artist tags. You can change it as you like.'
                    : 'Copy current artist tags'
              "
              aria-label="Copy current artist tags"
              @click="duplicateArtist"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn art-op art-remove"
              type="button"
              :disabled="!hasArtist || isBuiltinArtist"
              :title="
                !hasArtist
                  ? 'Unselected artist string'
                  : isBuiltinArtist
                    ? 'The built-in artist tags cannot be deleted and will be updated with the plug-in version.'
                    : 'Delete the current artist string'
              "
              aria-label="Delete the current artist string"
              @click="artistDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <!-- The entry for importing prompt presets from Chiehime is in the "Migrate from Chiehime" section below; no permanent hint here -->

        <!-- Inline content editing: an artist string is usually just a few tags, so "which one is selected" and "what it says" are visible together -->
        <template v-if="artist">
          <BbiTextarea
            v-model="artist.prompt"
            :rows="3"
            :max-rows="8"
            mono
            :readonly="isBuiltinArtist"
            placeholder="artist:xxx, artist:yyy"
          />
          <p v-if="isBuiltinArtist" class="bbi-field-hint art-hint">
            The built-in artist string is updated with the plug-in version and cannot be modified directly; click the copy button above to create your own string and then modify it.
          </p>
          <!-- Only shown for V5 models: V5 and 4.5 respond to artist strings very differently; 4.5 and below don't need this noise -->
          <p v-if="isV5Model" class="bbi-field-hint art-hint art-hint-warn">
            The response of NAI 5 to the artist tags is very different from that of 4.5. The effect of direct application of the old artist tags may go wrong. It is recommended to re-debug.
          </p>

          <!-- Positive/negative tags that switch together with the artist string: if set, they override the channel level below; if not, the ones below apply -->
          <ul class="bbi-prompt-list art-bound-list">
            <li v-for="t in artistBoundTargets" :key="t.key" class="bbi-prompt-item">
              <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
                <span class="bbi-prompt-name">{{ t.label }}</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                  {{ isTargetCustom(t) ? 'Already set' : 'not set' }}
                </span>
                <Icon name="edit" class="bbi-prompt-edit" />
              </button>
            </li>
          </ul>
          <p class="bbi-field-hint art-hint">
            The prompt words set here will overwrite the ones below and switch with the artist string; if there is no setting here, the ones below will be used.
          </p>
        </template>
        <!-- No hint when no artist string is selected: "None" in the dropdown speaks for itself -->

        <hr class="art-divider" />

        <!-- Channel-level quality/negative tags: read-only list rows; click a row to edit in a dialog (same as "Custom prompts" on the settings page) -->
        <ul class="bbi-prompt-list">
          <li v-for="t in CHANNEL_PROMPT_TARGETS" :key="t.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openNaiPrompt(t)">
              <span class="bbi-prompt-name">{{ t.label }}</span>
              <span v-if="isShadowedByArtist(t.key)" class="bbi-prompt-state is-shadowed">
                Already covered by artist tags
              </span>
              <span v-else class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                {{ isTargetCustom(t) ? 'Customized' : 'Default' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
        <p class="bbi-field-hint art-hint">
          When there are no positive/negative words set in the artist string, the ones here will be used; if this is also left blank, the official words will be taken according to the model.
        </p>
      </Collapsible>

      <Collapsible title="Default parameters" :open="false">
        <!-- Compact semantically paired rows: two columns for two-field rows, four for numeric rows; descriptions go into a one-line hint below the row -->
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">Model</span>
          </div>
          <BbiSelect
            class="be-select"
            v-model="modelSel"
            :options="NAI_MODELS"
            aria-label="NAI model"
          />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Generate natural language</span>
          <input v-model="settings.nai.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          On: Automatically write an additional English description for the screen and each character; Off: Only write tag. The upper limit of prompt words for 4.5 is approximately 512 token
          (The screen is shared with all characters). Natural language takes up the most space. If it exceeds the limit, it will be truncated and the screen will be distorted. You can try turning it off.
          Only the newly written prompt words will be affected: the natural language already in the text will be sent as usual. If you want to compare, click &quot;AI Rewrite Prompt Word&quot; in &quot;Edit Prompt Word&quot;.
          Multi-character prompts are split by character as usual, except that each character also only writes tag.
        </p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Portrait size (width × height)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.portraitSize"
              list="nai-portrait-presets"
              placeholder="832×1216"
              spellcheck="false"
            />
            <datalist id="nai-portrait-presets">
              <option value="832×1216">vertical version</option>
              <option value="1024×1536">Large vertical version</option>
              <option value="1024×1024">square diagram</option>
            </datalist>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Landscape size (width × height)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.landscapeSize"
              list="nai-landscape-presets"
              placeholder="1216×832"
              spellcheck="false"
            />
            <datalist id="nai-landscape-presets">
              <option value="1216×832">Horizontal version</option>
              <option value="1536×1024">Large horizontal version</option>
              <option value="1024×1024">square diagram</option>
            </datalist>
          </div>
        </div>
        <div class="bbi-select-row">
          <span class="bbi-field-label">Frame direction</span>
          <div class="bbi-segmented" role="tablist" aria-label="NAI frame direction">
            <button
              v-for="opt in ORIENTATION_LOCKS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': settings.nai.orientationLock === opt.value }"
              type="button"
              role="tab"
              :aria-selected="settings.nai.orientationLock === opt.value"
              @click="settings.nai.orientationLock = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="bbi-field-hint">
          The vertical screen is used for single people, close-ups, and vertical paintings; the horizontal screen is used for group portraits, distant views, and panoramas. &quot;Auto&quot; is determined by automatic tag according to the screen;
          After locking, each picture will be taken out in this direction, and the automatic tag will also compose the picture according to this frame. The direction already noted in the text will not be overwritten and will be restored by changing it back to &quot;Auto&quot;.
        </p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">sampler</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.sampler"
              :options="samplerOptions"
              aria-label="sampler"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Noise table</span>
            </div>
            <BbiSelect
              class="be-select"
              v-model="settings.nai.noiseSchedule"
              :options="NAI_NOISE_SCHEDULES"
              aria-label="Noise table"
            />
          </div>
        </div>

        <div class="be-row be-row--nums">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">number of steps</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.steps" min="1" max="50" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Scale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.scale"
              min="0"
              max="35"
              step="0.1"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Rescale</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.cfgRescale"
              min="0"
              max="1"
              step="0.05"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">seeds</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.seed" min="0" />
          </div>
        </div>
        <p class="bbi-field-hint">Scale = prompt word relevance; Rescale = relevance adjustment; seed 0 = random.</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Variety Boost (Screen diversity, automatically calculated according to size)</span>
          <input v-model="settings.nai.varietyBoost" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-num-row">
          <span class="bbi-field-label">Number of images produced simultaneously</span>
          <input
            class="bbi-input bbi-num"
            type="number"
            v-model.number="settings.nai.concurrency"
            min="1"
            max="4"
          />
        </div>
        <p class="bbi-field-hint">
          NAI server does not queue, and high concurrency is easily limited (429). It is recommended to keep 1; excess requests will be automatically queued and waited.
          When the current is limited, it will automatically back off and retry (up to 3 times), and let all queued tasks cool down together without running into them.
        </p>
      </Collapsible>

      <Collapsible title="Vibe library (ambience transfer)" :open="false">
        <p v-if="vibesSupported" class="bbi-field-hint vibe-hint">
          Upload the reference image and superimpose its style/atmosphere when generating it; coding is performed according to the currently selected model, which will consume one interface call.
        </p>
        <p v-else class="bbi-field-hint vibe-hint">
          Current model does not support Vibe Transfer.
        </p>

        <div class="vibe-actions">
          <button class="bbi-btn" type="button" :disabled="vibeEncoding || !vibesSupported" @click="vibeFileInput?.click()">
            <Icon name="plus" />
            {{ vibeEncoding ? 'Encoding…' : 'Upload image encoding' }}
          </button>
          <button class="bbi-btn" type="button" @click="vibeImportInput?.click()">
            <Icon name="download" />
            Import .naiv4vibe
          </button>
          <label class="bbi-switch-row vibe-normalize">
            <span class="bbi-field-label">intensity normalization</span>
            <input v-model="settings.nai.normalizeRefStrength" type="checkbox" class="bbi-checkbox" :disabled="!vibesSupported" />
          </label>
          <input ref="vibeFileInput" type="file" accept="image/*" hidden @change="onVibeFileChange" />
          <input ref="vibeImportInput" type="file" accept=".naiv4vibe" hidden @change="onVibeImportChange" />
        </div>

        <p v-if="!settings.nai.vibes.length" class="bbi-field-hint">Not yet vibe; upload a reference image to get started.</p>

        <template v-else>
          <div class="vibe-toolbar">
            <input
              class="bbi-input vibe-search"
              type="search"
              v-model="vibeSearch"
              placeholder="Search for a name or group…"
              spellcheck="false"
              aria-label="Search Vibe"
            />
            <span class="vibe-count">
              total {{ settings.nai.vibes.length }} · Enabled {{ enabledCount }}
            </span>
            <button
              v-if="prefixGroupPlans.length"
              class="bbi-btn bbi-btn-sm"
              type="button"
              title="The old version of migration spelled the group name into the name. Click here to restore it to the real group."
              @click="applyPrefixGroups"
            >
              <Icon name="checklist" :size="12" />
              Organize into groups by name ({{ prefixGroupPlans.length }})
            </button>
          </div>

          <p v-if="!matchedCount" class="bbi-field-hint">No match &quot;{{ vibeSearch }}&quot;Vibe.</p>

          <div v-for="group in vibeGroups" :key="group.key" class="vibe-group">
            <div class="vibe-group-head">
              <button
                class="vibe-group-toggle"
                type="button"
                :aria-expanded="!isGroupCollapsed(group.key)"
                @click="toggleGroup(group.key)"
              >
                <Icon
                  name="chevron"
                  :size="14"
                  class="vibe-group-chevron"
                  :class="{ 'is-collapsed': isGroupCollapsed(group.key) }"
                />
                <span class="vibe-group-name">{{ group.label }}</span>
                <span class="vibe-group-meta">
                  {{ groupEnabledCount(group) }}/{{ group.all.length }}
                  <template v-if="group.items.length !== group.all.length">
                    · Display {{ group.items.length }}
                  </template>
                </span>
                <span v-if="groupActive(group)" class="bbi-prompt-state vibe-group-active">
                  Taking effect
                </span>
              </button>
              <span class="vibe-group-ops">
                <button
                  class="bbi-btn bbi-btn-sm bbi-btn-primary"
                  type="button"
                  title="Only superimpose this group: turn off all check boxes outside the group and turn on this group"
                  @click="soloGroup(group)"
                >
                  Only open this group
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="Open this group without affecting other groups (used to superimpose multiple groups)"
                  @click="setGroupEnabled(group, true)"
                >
                  Fully open
                </button>
                <button
                  class="bbi-btn bbi-btn-sm"
                  type="button"
                  title="Close this group"
                  @click="setGroupEnabled(group, false)"
                >
                  Completely closed
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="Rename group"
                  aria-label="Rename group"
                  @click="renameGroup(group)"
                >
                  <Icon name="edit" :size="12" />
                </button>
                <button
                  v-if="group.name"
                  class="bbi-icon-mini"
                  type="button"
                  title="Disband the group (only cancel the classification, do not delete Vibe)"
                  aria-label="Disband group"
                  @click="dissolveGroup(group)"
                >
                  <Icon name="close" :size="12" />
                </button>
              </span>
            </div>

            <div v-show="!isGroupCollapsed(group.key)" class="vibe-group-body">
              <div v-for="vibe in group.items" :key="vibe.id" class="vibe-item">
                <img
                  v-if="vibe.thumbnailPath"
                  class="vibe-thumb"
                  :src="vibe.thumbnailPath"
                  :alt="vibe.name"
                  loading="lazy"
                  decoding="async"
                />
                <div v-else class="vibe-thumb vibe-thumb--empty"><Icon name="generate" /></div>
                <div class="vibe-main">
                  <div class="vibe-head">
                    <input class="bbi-input vibe-name" type="text" v-model="vibe.name" spellcheck="false" />
                    <label class="vibe-enable" title="Overlay this vibe when generated">
                      <input v-model="vibe.enabled" type="checkbox" class="bbi-checkbox" />
                      Enable
                    </label>
                  </div>
                  <div class="vibe-strength">
                    <span class="vibe-strength-label">intensity</span>
                    <input
                      class="bbi-range"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      :value="vibe.strength"
                      aria-label="intensity"
                      @input="setVibeStrength(vibe, ($event.target as HTMLInputElement).value)"
                    />
                    <input
                      class="bbi-input vibe-strength-num"
                      type="number"
                      min="0"
                      max="1"
                      step="any"
                      :value="vibe.strength"
                      aria-label="Strength value"
                      @change="commitVibeStrength(vibe, $event)"
                    />
                  </div>
                  <div class="vibe-ops">
                    <BbiSelect
                      class="vibe-group-select"
                      :model-value="groupKey(vibe.group)"
                      :options="groupOptions"
                      aria-label="Group to which it belongs"
                      @update:model-value="onGroupPick(vibe, $event)"
                    />
                    <button
                      v-if="vibesSupported && !vibe.modelKeys.includes(currentVibeKey) && vibe.hasImage"
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      :disabled="vibeEncoding"
                      title="The vibe lacks the code of the current model and will be skipped when generating; click to fill in the code according to the current model"
                      @click="reencodeVibe(vibe)"
                    >
                      <Icon name="refresh" :size="12" /> Complement the current model encoding
                    </button>
                    <span v-else-if="!vibesSupported" class="vibe-missing">
                      The current model does not support Vibe yet
                    </span>
                    <span v-else-if="!vibe.modelKeys.includes(currentVibeKey)" class="vibe-missing">
                      The current model code is missing and there is no original image, so it cannot be used.
                    </span>
                    <button
                      class="bbi-btn bbi-btn-sm"
                      type="button"
                      title="Export .naiv4vibe"
                      @click="exportVibe(vibe)"
                    >
                      <Icon name="upload" :size="12" /> Export
                    </button>
                    <button class="bbi-btn bbi-btn-sm" type="button" title="Delete" @click="removeVibe(vibe)">
                      <Icon name="trash" :size="12" /> Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </Collapsible>

      <Collapsible title="Migrate from Chiehime" :open="false">
        <p class="bbi-field-hint vibe-hint">
          Copy vibe of Tomoehime (st-chatu8) to this library: only create a copy, do not change the source data, and duplicates will be automatically skipped.
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8Detect.found">Chiehime is not detected (plugin is not installed or enabled).</template>
          <template v-else-if="!chatu8Detect.total">Chie Kiri did not find vibe.</template>
          <template v-else>
            Chiehime has been detected {{ chatu8Detect.total }} vibe (default {{ chatu8Detect.presets }} individuals/group
            {{ chatu8Detect.groups }} ).
          </template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="migrating || !chatu8Detect.total"
            @click="migrateConfirmOpen = true"
          >
            <Icon name="download" />
            {{ migrating ? 'Migrating…' : 'Migrate Chiehime\'s vibe' }}
          </button>
        </div>
        <p v-if="migrateMsg" class="bbi-field-hint">{{ migrateMsg }}</p>

        <hr class="art-divider" />

        <!-- Prompt preset import: same section and level as vibes; whether new presets exist isn't reported here; open the dialog to see the preview -->
        <p class="bbi-field-hint vibe-hint">
          The prompt word preset is the same: fixed positive in the front → artist tags, fixed positive in the back → positive quality word, fixed negative → negative prompt word (automatically brought with the official baseline of the current model).
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8ArtistDetect.found">Chiehime is not detected (plugin is not installed or enabled).</template>
          <template v-else-if="!chatu8ArtistDetect.total">Chie Kiri No prompt word preset found.</template>
          <template v-else>Chiehime has been detected {{ chatu8ArtistDetect.total }} prompt word defaults.</template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="!chatu8ArtistDetect.total"
            @click="openArtistImport"
          >
            <Icon name="download" />
            Import Chiehime’s prompt word presets
          </button>
        </div>
      </Collapsible>
    </div>

    <ModalMask :open="migrateConfirmOpen" @close="migrateConfirmOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Migrate from Chiehime">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Migrated from Chiehime vibe</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="migrateConfirmOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          I will take Chiehime’s {{ chatu8Detect.total }} vibe copied to BaiBai Image Vibe
          The library only creates a copy and will not change Chiehime's data. Those with the same content will be automatically skipped, and repeated migration will not produce duplicate entries.
        </p>
        <p class="bbi-modal-label">
          Note: When Chiehime does not open &quot;Tavern Storage&quot;, vibe is stored in the browser's local storage and can only be read by this device and this browser.
        </p>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="migrateConfirmOpen = false">Cancel</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="runMigrate">Start migration</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Import prompt presets from Chiehime: preview + confirm (computed once on open; pure function, nothing saved) ===== -->
    <ModalMask :open="artistImportOpen" @close="artistImportOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="Import prompt word presets from Tomoehime">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">Import prompt word presets from Tomoehime</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="artistImportOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          Take all of Chiehime {{ artistImportResult?.plans.length ?? 0 }} The prompt words are copied to BaiBai Image by default. Only a copy is created and Chihuiji's data is not changed.
          Mapping: front fixed positive direction → artist tags, rear fixed positive direction → positive quality word, fixed negative direction → negative prompt word (the official baseline of the current model is automatically spelled in front).
          Entries with the same name will be overwritten and updated (previously imported entries can be directly re-imported for repair), and entries with identical content will be automatically skipped.
        </p>
        <ul class="art-import-list">
          <li v-for="(plan, i) in artistImportResult?.plans ?? []" :key="i" class="art-import-item">
            <div class="art-import-head">
              <span class="art-import-name" :title="plan.source">{{ plan.source || '(unnamed)' }}</span>
              <span class="art-import-badge" :class="`is-${plan.state}`">
                {{ plan.state === 'import' ? 'will import' : plan.state === 'overwrite' ? 'will overwrite' : 'Already exists' }}
              </span>
              <span v-if="plan.active" class="art-import-badge is-active">Currently in use</span>
            </div>
            <div class="art-import-fields">
              <code class="art-import-line" :title="plan.prompt"
                ><span class="art-import-key">Artist Tags</span>{{ plan.prompt || '(empty)' }}</code
              >
              <code class="art-import-line" :title="plan.quality"
                ><span class="art-import-key">forward</span>{{ plan.quality || '(empty)' }}</code
              >
              <code class="art-import-line" :title="plan.negative"
                ><span class="art-import-key">Negative</span>{{ plan.negative || '(empty)' }}</code
              >
            </div>
          </li>
        </ul>
        <label v-if="chatu8ActiveRef" class="art-import-switch">
          <input type="checkbox" v-model="switchActiveArtist" />
          <span>
            After importing, switch to the preset currently used by Tomoehime.
            <code>{{ chatu8ActiveRef.source }}</code>
          </span>
        </label>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="artistImportOpen = false">Cancel</button>
          <button
            class="bbi-btn bbi-btn-primary"
            type="button"
            :disabled="!artistImportResult || artistImportResult.imported + artistImportResult.overwritten === 0"
            @click="runArtistImport"
          >
            {{ artistImportResult && artistImportResult.imported + artistImportResult.overwritten === 0 ? 'all the same' : 'Start importing' }}
          </button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Artist-string library manager: search/preview images/check and bulk delete ===== -->
    <NaiArtistManager v-model:open="artistManagerOpen" />

    <ConfirmDialog
      v-model:open="endpointDeleteOpen"
      title="Delete access point"
      confirm-text="Delete"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveEndpoint"
    >
      Confirm to delete access point&quot;{{ endpoint.name || 'Unnamed access point' }}”? The address and API Key will be deleted together.
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="artistDeleteOpen"
      title="Delete artist string"
      confirm-text="Delete"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveArtist"
    >
      Confirm to delete the artist string &quot;{{ artist?.name || 'Unnamed artist string' }}”? It cannot be restored after deletion.
    </ConfirmDialog>

    <!-- ===== Quality/negative tag editor dialog (same as custom prompts on the settings page) ===== -->
    <ModalMask :open="!!editingNaiPrompt" @close="closeNaiPrompt">
      <div
        v-if="editingNaiPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`Edit${editingNaiPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingNaiPrompt.readonly ? 'View' : 'Edit' }}{{ editingNaiPrompt.label }}
          </span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeNaiPrompt">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-modal-label">{{ editingNaiPrompt.hint }}</p>

        <BbiTextarea
          v-model="naiPromptDraft"
          class="bbi-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
          :readonly="editingNaiPrompt.readonly"
        />

        <footer class="bbi-modal-foot">
          <template v-if="!editingNaiPrompt.readonly">
            <button class="bbi-btn bbi-btn-danger" type="button" @click="resetNaiPromptDraft">
              <Icon name="refresh" /> Restore Default
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="closeNaiPrompt">Cancel</button>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="saveNaiPrompt">Done</button>
          </template>
          <template v-else>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="closeNaiPrompt">Close</button>
          </template>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* Compact semantically paired rows for default parameters: two columns for two-field rows, four for numeric rows;
   on narrow screens two-field rows become one column and numeric rows 2×2.
   Vertical rhythm is managed by the row container (fields in a row have margin-bottom zeroed),
   not by .bbi-field's own :last-child rule, which would eat the bottom spacing of the last field in a row. */
.be-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
  margin-bottom: 18px;
}

.be-row .bbi-field {
  margin-bottom: 0;
}

/* Custom dropdowns in the parameter area fill the field width, aligning left and right with the .bbi-input (model name/size) on the same row;
   the child's root class defaults to 180px/flex:none, overridden here. */
.be-select {
  width: 100%;
}

.be-row--nums {
  grid-template-columns: repeat(4, 1fr);
}

@media (max-width: 640px) {
  .be-row {
    grid-template-columns: 1fr;
  }

  .be-row--nums {
    grid-template-columns: repeat(2, 1fr);
  }
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
/* "Use this channel / Current image channel" on the left and Test connection on the right, at opposite ends */
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
.vibe-hint {
  margin-top: 0;
}

/* —— Artist-string library (layout copied from ComfyUIPanel's .wf-*) —— */
/* Selector row: grid rather than flex; alignment built from flex-basis falls apart as soon as it wraps,
   and a fixed first column makes the label column start where the labels of the rows below start. */
.art-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.art-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.art-row > .bbi-input {
  min-width: 0;
}
/* The dropdown doesn't fill the row: names are usually short, and stretching only drags out empty space (the child's root class defaults to 180px/no flex; 0,2,0 overrides it here) */
.art-row > .art-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.art-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* The four actions are rare and equal in rank; with icons the row has only the dropdown as its visual focus; text moves to title/aria-label */
.art-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.art-op:disabled {
  opacity: 0.4;
  cursor: default;
}
.art-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.art-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.art-hint {
  margin-top: 8px;
}

/* V5 artist-string difference warning: warning colour, set apart from regular hints */
.art-hint-warn {
  color: var(--bbi-warning);
}
/* Divider between the artist string and the quality/negative tags below */
.art-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 12px 0;
}
/* Some space between the bound list and the artist-string editor above; "overridden by artist string" uses the warning colour: the channel value is being overridden,
   and users who change the channel row without effect need to see why at a glance */
.art-bound-list {
  margin-top: 10px;
}
.bbi-prompt-state.is-shadowed {
  color: var(--bbi-warning);
  background: transparent;
}

/* —— Migrate prompt presets from Chiehime —— */
.art-import-list {
  list-style: none;
  margin: 10px 0 4px;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.art-import-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.art-import-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.art-import-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.art-import-fields {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.art-import-line {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
.art-import-key {
  opacity: 0.55;
  margin-right: 6px;
}
.art-import-badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
  white-space: nowrap;
}
.art-import-badge.is-skip {
  background: var(--bbi-line);
  color: var(--bbi-ink-muted);
}
.art-import-badge.is-overwrite {
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
}
.art-import-badge.is-active {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
}
.art-import-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
  cursor: pointer;
}
.art-import-switch code {
  font-size: 12px;
  background: var(--bbi-surface-2);
  border-radius: 4px;
  padding: 0 4px;
}

/* Action button base class: .bbi-icon-btn is only declared in App.vue's scoped block, so a copy is added here
   (same handling as ComfyUIPanel; without it they render as native browser buttons, and the shadow DOM can't get ST's styles either) */
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

/* —— Quality/negative tag list rows + dialog: styled like "Custom prompts" on the settings page; scoped doesn't cross components, so a copy is added —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* The whole row is clickable to open the editor dialog (the .bbi-prompt-state status pill is global in base.css; no copy needed) */
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
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
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
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}
/* Dialog: wider + large text box */
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
/* Push "Restore default" to the far left (this file's migration dialog used this class name bare before, getting it right by luck via the footer's flex-end) */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* Danger button: same rule as the settings page/ConfirmDialog. The base rule can't be just :hover:
   scoped doesn't cross components and base.css doesn't have it, so with only hover it would be the default ink colour and turn red only on mouse-over. */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.migrate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.vibe-normalize {
  margin-left: auto;
}
.vibe-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--bbi-border, rgba(127, 127, 127, 0.2));
}
.vibe-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 auto;
}
.vibe-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.12);
  color: var(--bbi-ink-muted);
}
.vibe-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vibe-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.vibe-enable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-strength-label {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
  /* .bbi-range's margin is meant for the settings page's "one row per item"; it must be removed when sharing a row here */
  margin: 0;
}
/* Number box one step narrower: four decimals are enough; any wider and the slider gets squeezed out */
.vibe-strength-num {
  flex: 0 0 auto;
  width: 68px;
  padding: 4px 6px;
  font-size: 12px;
  text-align: right;
  -moz-appearance: textfield;
  appearance: textfield;
}
/* With step="any" browsers still draw the up/down arrows, but the spec makes stepUp/stepDown throw → pressing them does nothing.
   A pair of arrows that don't work is worse than none; use the slider on the left for fine adjustment (arrow keys step 0.01). */
.vibe-strength-num::-webkit-inner-spin-button,
.vibe-strength-num::-webkit-outer-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.vibe-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vibe-missing {
  font-size: 12px;
  color: #c44747;
}

/* —— Groups —— */
/* Toolbar: the search box fills; the count and "Tidy groups" sit on the right. Long lists follow the settings page's exclusion dialog
   (search + substring matching keeps rendering small), so there is no pagination: vibes are recognised by thumbnail, and pages would only
   turn "which page is my image on" into a new memory burden. */
.vibe-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.vibe-search {
  flex: 1 1 160px;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
}
.vibe-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
/* Group header: a solid light background separating "group" from its entries visually; sticky so the group name stays visible when scrolling a long group */
.vibe-group {
  margin-top: 10px;
}
.vibe-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
/* The group name area is clickable as a whole (collapse): the button fills the remaining width, so clicking empty space also collapses */
.vibe-group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.vibe-group-chevron {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
/* Expanded points down (same rule as Collapsible: collapsed returns to the unrotated right/up) */
.vibe-group-chevron.is-collapsed {
  transform: rotate(-90deg);
}
.vibe-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vibe-group-meta {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
}
/* "Active" reuses the status pill base style, coloured the same as wf-state.is-ok */
.vibe-group-active {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.vibe-group-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
/* Entries in a group are indented one step so the hierarchy reads */
.vibe-group-body {
  padding-left: 10px;
}
/* The group header is itself a divider, so the first entry in a group draws no top border (otherwise there would be two lines against the header) */
.vibe-group-body > .vibe-item:first-child {
  border-top: 0;
}
.vibe-group-select {
  width: 130px;
}
/* Small icon buttons in group header actions: .bbi-icon-mini is only declared in other pages' scoped blocks, so a copy is added here */
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 12px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
@media (max-width: 640px) {
  /* Narrow screens: group header on two rows, name on one row and actions on another aligned right, so buttons don't squeeze the name into a slit */
  .vibe-group-ops {
    width: 100%;
    justify-content: flex-end;
  }
  .vibe-group-body {
    padding-left: 0;
  }
  /* Likewise: four icon buttons + a label would squeeze the artist-string dropdown into a slit, so the label takes the first row alone,
     and the dropdown and action group share a row at opposite ends */
  .art-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .art-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .art-row > .art-select {
    max-width: none;
  }
}
</style>
