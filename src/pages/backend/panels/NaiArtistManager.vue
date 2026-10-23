<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import { newNaiArtist, settings, type NaiArtistPreset } from '@/state/settings';

/**
 * Artist-string library manager (opened by the NAI panel's "Manage" button).
 *
 * Division: the panel's dropdown handles "frequent switching"; this handles "infrequent management": search, preview images,
 * check-and-bulk-delete, editing/duplicating/deleting one by one.
 *
 * Interaction conventions:
 * - clicking a card body = enable that entry (clicking the current one again = disable, back to "None");
 * - the checkbox at top left = management multi-select, only for bulk deletion, unrelated to the enabled state;
 * - built-in entries (bi_*) update with plugin versions and are read-only: no checkbox, can't be deleted or edited; "Duplicate" is the only way to customise;
 * - uploaded preview images are compressed to a jpeg with a 512 longest edge, saved to user/images/柏宝绘_画师串/<entry id>.jpg,
 *   with the path recorded in the entry's previewPath and no extra index; changing the image overwrites the same name, and deleting the entry deletes the file.
 */

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

function close() {
  emit('update:open', false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** List entries: the built-in library first (same order as the dropdown), with a read-only flag. */
interface ManagerItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

const search = ref('');
/** Management checked set (user entry ids only; built-in entries can't be checked, so they never get in). */
const selected = ref<ReadonlySet<string>>(new Set());

// Every opening starts clean: the search text and checks are temporary state for "this management round" and shouldn't carry over.
watch(
  () => props.open,
  open => {
    if (!open) return;
    search.value = '';
    selected.value = new Set();
  },
);

const items = computed<ManagerItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...settings.nai.artistPresets.map(p => ({ preset: p, builtin: false })),
]);

const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

/** Checkable (user) entries in the current filter results: select-all/count are based on these; built-in entries take no part in bulk actions. */
const selectableFiltered = computed(() => filtered.value.filter(i => !i.builtin));

const allFilteredSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every(i => selected.value.has(i.preset.id)),
);

const activeId = computed(() => settings.nai.activeArtistId);

/** Clicking a card: enable; clicking the current one again: disable (back to "None", a meaningful stored value). */
function toggleActive(item: ManagerItem) {
  settings.nai.activeArtistId = item.preset.id === activeId.value ? '' : item.preset.id;
}

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

function toggleSelectAllFiltered() {
  const next = new Set(selected.value);
  if (allFilteredSelected.value) {
    for (const i of selectableFiltered.value) next.delete(i.preset.id);
  } else {
    for (const i of selectableFiltered.value) next.add(i.preset.id);
  }
  selected.value = next;
}

/** New: add to the library + set as current + open the editor dialog directly, all in one step. */
function addArtist() {
  const preset = newNaiArtist(`Artist Tags ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  settings.nai.activeArtistId = preset.id;
  openEdit({ preset, builtin: false });
}

/**
 * Duplicate: the preview image doesn't go with the copy; the preview file is deleted with the original entry, and sharing one path would break the copy's image later.
 * It doesn't switch the current entry either: duplicating in the manager is often for building up variants in bulk, and which one is enabled is the user's explicit card click.
 */
function duplicate(item: ManagerItem) {
  const src = item.preset;
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} copy`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  settings.nai.artistPresets.push(preset);
  toastr.success(`Copied as "${preset.name}"`, 'Artist Tags');
}

/* ============ Preview images ============ */

/** Longest edge of preview images: cards display about 200px wide; 512 leaves ample room for high-DPI screens without bloating user/images. */
const PREVIEW_MAX_EDGE = 512;

const previewFileInput = ref<HTMLInputElement | null>(null);
/** Which entry this upload changes the image for; the file input is one shared element, so this finds the target on change. */
let previewTarget: NaiArtistPreset | null = null;
const uploadingId = ref<string | null>(null);

/**
 * After overwriting a same-name file the URL is unchanged, and the browser cache would keep showing the old image on the card;
 * this component keeps an id → version number map, bumped after a successful upload; adding it as a query to <img src> busts the cache.
 */
const previewVersions = ref<ReadonlyMap<string, number>>(new Map());

function previewSrc(preset: NaiArtistPreset): string {
  if (!preset.previewPath) return '';
  const v = previewVersions.value.get(preset.id);
  return v ? `${preset.previewPath}?v=${v}` : preset.previewPath;
}

function pickPreview(preset: NaiArtistPreset) {
  if (uploadingId.value) return;
  previewTarget = preset;
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = previewTarget;
  previewTarget = null;
  if (!file || !target) return;
  uploadingId.value = target.id;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, PREVIEW_MAX_EDGE, 0.85);
    const base64 = jpeg.split(',')[1] ?? '';
    // File name = entry id: changing the image overwrites the same name, so no orphan files pile up
    target.previewPath = await uploadUserImage(ARTIST_PREVIEW_FOLDER, target.id, base64, 'jpg');
    previewVersions.value = new Map(previewVersions.value).set(target.id, Date.now());
    toastr.success(`Preview for "${target.name || 'Unnamed artist string'}" updated`, 'Artist Tags');
  } catch (error) {
    toastr.error(errorMessage(error), 'Preview upload failed');
  } finally {
    uploadingId.value = null;
  }
}

/** Remove preview: clear the field first (the UI responds immediately); file deletion is best-effort, and failure only warns without rolling back. */
async function removePreview(preset: NaiArtistPreset) {
  const path = preset.previewPath;
  if (!path) return;
  preset.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`Preview image reference removed, but file cleanup failed: ${errorMessage(error)}`, 'Artist Tags');
  }
}

/* ============ Delete (single and bulk share the confirm dialog) ============ */

const deleteOpen = ref(false);
const deleteList = ref<NaiArtistPreset[]>([]);
const deleting = ref(false);

function askDelete(presets: NaiArtistPreset[]) {
  if (!presets.length) return;
  deleteList.value = presets;
  deleteOpen.value = true;
}

function askDeleteSelected() {
  const byId = new Map(settings.nai.artistPresets.map(p => [p.id, p]));
  askDelete([...selected.value].map(id => byId.get(id)).filter((p): p is NaiArtistPreset => !!p));
}

async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  const ids = new Set(deleteList.value.map(p => p.id));
  const plan = planArtistRemoval(settings.nai.artistPresets, ids, activeId.value);
  // Preview file cleanup is best-effort: a file that wasn't deleted doesn't block deleting the entry (orphan files can be cleaned by hand; an entry that can't be deleted is what's annoying)
  let fileFailures = 0;
  for (const p of plan.removed) {
    if (!p.previewPath) continue;
    try {
      await deleteUserImage(p.previewPath);
    } catch {
      fileFailures += 1;
    }
  }
  settings.nai.artistPresets = plan.remaining;
  settings.nai.activeArtistId = plan.nextActiveId;
  const nextSelected = new Set(selected.value);
  for (const id of ids) nextSelected.delete(id);
  selected.value = nextSelected;
  deleteOpen.value = false;
  deleting.value = false;
  if (fileFailures) {
    toastr.warning(
      `Deleted ${plan.removed.length} Article, but ${fileFailures} Cleaning of preview image file failed`,
      'Artist Tags',
    );
  } else {
    toastr.success(`Deleted ${plan.removed.length} strip artist tags`, 'Artist Tags');
  }
}

/* ============ Edit/view dialog (built-in entries read-only) ============ */

const editItem = ref<ManagerItem | null>(null);
const editName = ref('');
const editPrompt = ref('');

function openEdit(item: ManagerItem) {
  editItem.value = item;
  editName.value = item.preset.name;
  editPrompt.value = item.preset.prompt;
}

function closeEdit() {
  editItem.value = null;
}

function saveEdit() {
  const item = editItem.value;
  if (!item || item.builtin) return; // Built-ins are read-only (the button is already hidden; belt and braces)
  item.preset.name = editName.value.trim();
  item.preset.prompt = editPrompt.value;
  closeEdit();
}

/** Duplicating a built-in entry in the edit dialog: once the copy is in the library close the view window, so the user returns to the grid and sees the new card. */
function duplicateFromEdit() {
  const item = editItem.value;
  if (!item) return;
  duplicate(item);
  closeEdit();
}
</script>

<template>
  <ModalMask :open="open" @close="close">
    <div class="bbi-modal am-modal" role="dialog" aria-modal="true" aria-label="Painter library">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">Painter library</span>
        <button class="bbi-icon-mini" type="button" title="Close" aria-label="Close" @click="close">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-toolbar">
        <input
          class="bbi-input am-search"
          type="search"
          v-model="search"
          placeholder="Search name or artist string content..."
          spellcheck="false"
          aria-label="Search artist string"
        />
        <span class="am-count">total {{ items.length }} entries</span>
        <button class="bbi-btn bbi-btn-primary" type="button" @click="addArtist">
          <Icon name="plus" /> New
        </button>
      </div>

      <div v-if="selected.size" class="am-batch">
        <span class="am-batch-count">Selected {{ selected.size }} entries</span>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="toggleSelectAllFiltered">
          {{ allFilteredSelected ? 'Deselect all' : `Select all current results (${selectableFiltered.length})` }}
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="selected = new Set()">Clear</button>
        <span class="am-batch-spacer"></span>
        <button
          class="bbi-btn bbi-btn-sm am-btn-danger"
          type="button"
          @click="askDeleteSelected"
        >
          <Icon name="trash" :size="12" /> Delete selected
        </button>
      </div>

      <div class="am-scroll">
        <p v-if="!filtered.length" class="am-empty">
          <template v-if="items.length">No match &quot;{{ search }}&quot;The painter's string.</template>
          <template v-else>There is no artist string yet, click &quot;New&quot; in the upper right corner to start.</template>
        </p>

        <div v-else class="am-grid">
          <div
            v-for="item in filtered"
            :key="item.preset.id"
            class="am-card"
            :class="{
              'is-active': item.preset.id === activeId,
              'is-selected': selected.has(item.preset.id),
            }"
            :title="item.preset.id === activeId ? 'Current artist string, click to deactivate' : 'Click to set as current artist string'"
            @click="toggleActive(item)"
          >
            <div class="am-art">
              <img
                v-if="item.preset.previewPath"
                class="am-art-img"
                :src="previewSrc(item.preset)"
                :alt="item.preset.name"
                loading="lazy"
                decoding="async"
              />
              <button
                v-else-if="!item.builtin"
                class="am-art-empty"
                type="button"
                :disabled="uploadingId === item.preset.id"
                title="Upload preview image"
                @click.stop="pickPreview(item.preset)"
              >
                <Icon name="generate" :size="20" />
                <span>{{ uploadingId === item.preset.id ? 'Uploading…' : 'Add preview image' }}</span>
              </button>
              <div v-else class="am-art-empty am-art-empty--static">
                <Icon name="nai" :size="22" />
              </div>

              <label
                v-if="!item.builtin"
                class="am-check"
                title="After checking, you can delete them in batches"
                @click.stop
              >
                <input
                  type="checkbox"
                  class="bbi-checkbox"
                  :checked="selected.has(item.preset.id)"
                  aria-label="Select this artist string"
                  @change="toggleSelect(item.preset.id)"
                />
              </label>

              <span v-if="item.preset.id === activeId" class="am-badge is-on">In use</span>
              <span v-else-if="item.builtin" class="am-badge">Built-in</span>

              <button
                v-if="!item.builtin && item.preset.previewPath"
                class="am-art-change"
                type="button"
                :disabled="uploadingId === item.preset.id"
                @click.stop="pickPreview(item.preset)"
              >
                {{ uploadingId === item.preset.id ? 'Uploading…' : 'Change preview image' }}
              </button>
            </div>

            <div class="am-body">
              <div class="am-name-row">
                <!-- Radio circle: makes it explicit that "enabling is a single-choice switch"; the whole card is clickable, the circle only visualises state and hints -->
                <span
                  class="am-radio"
                  :class="{ 'is-on': item.preset.id === activeId }"
                  aria-hidden="true"
                >
                  <Icon v-if="item.preset.id === activeId" name="check" :size="9" />
                </span>
                <div class="am-name" :title="item.preset.name">
                  {{ item.preset.name || 'Unnamed artist string' }}
                </div>
              </div>
              <div class="am-prompt" :title="item.preset.prompt">
                {{ item.preset.prompt || '(empty)' }}
              </div>
              <div class="am-ops" @click.stop>
                <button
                  class="am-op"
                  type="button"
                  :title="item.builtin ? 'View content (built-in read-only)' : 'Edit name and content'"
                  :aria-label="item.builtin ? 'View content' : 'Edit'"
                  @click="openEdit(item)"
                >
                  <Icon name="edit" :size="13" />
                </button>
                <button
                  class="am-op"
                  type="button"
                  title="Copy as my artist tags"
                  aria-label="Copy"
                  @click="duplicate(item)"
                >
                  <Icon name="copy" :size="13" />
                </button>
                <button
                  v-if="!item.builtin"
                  class="am-op am-op-danger"
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  @click="askDelete([item.preset])"
                >
                  <Icon name="trash" :size="13" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="bbi-modal-foot am-foot">
        <span class="am-foot-hint">Click the card or radio button to enable/disable; check the box in the upper left corner to delete in batches.</span>
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="close">Close</button>
      </footer>
    </div>
  </ModalMask>

  <!-- Delete confirmation: shared by single and bulk; stacked above the manager -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    top-layer
    title="Delete artist string"
    :confirm-text="deleting ? 'Deleting…' : 'Delete'"
    confirm-icon="trash"
    tone="danger"
    :busy="deleting"
    @confirm="confirmDelete"
  >
    <template v-if="deleteList.length === 1">
      Confirm to delete the artist string &quot;{{ deleteList[0]?.name || 'Unnamed artist string' }}&quot;?It cannot be restored after deletion.
    </template>
    <template v-else>
      Confirm to delete selected {{ deleteList.length }} The stripe artist string cannot be restored after deletion.
    </template>
  </ConfirmDialog>

  <!-- Edit/view: name + content + preview image; bound positive/negative tags are still edited in the panel with "current entry" -->
  <ModalMask :open="!!editItem" top-layer @close="closeEdit">
    <div
      v-if="editItem"
      class="bbi-modal am-edit"
      role="dialog"
      aria-modal="true"
      :aria-label="editItem.builtin ? 'View artist string' : 'Edit artist tags'"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">{{ editItem.builtin ? 'View artist string (built-in)' : 'Edit artist tags' }}</span>
        <button class="bbi-icon-mini" type="button" title="Close" aria-label="Close" @click="closeEdit">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-edit-preview">
        <img
          v-if="editItem.preset.previewPath"
          class="am-edit-thumb"
          :src="previewSrc(editItem.preset)"
          :alt="editItem.preset.name"
        />
        <div v-else class="am-edit-thumb am-edit-thumb--empty"><Icon name="generate" /></div>
        <div v-if="!editItem.builtin" class="am-edit-preview-ops">
          <button
            class="bbi-btn bbi-btn-sm"
            type="button"
            :disabled="uploadingId === editItem.preset.id"
            @click="pickPreview(editItem.preset)"
          >
            <Icon name="upload" :size="12" />
            {{ uploadingId === editItem.preset.id ? 'Uploading…' : editItem.preset.previewPath ? 'Change preview image' : 'Upload preview image' }}
          </button>
          <button
            v-if="editItem.preset.previewPath"
            class="bbi-btn bbi-btn-sm am-btn-danger"
            type="button"
            @click="removePreview(editItem.preset)"
          >
            <Icon name="trash" :size="12" /> Remove preview
          </button>
        </div>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Name</span>
        <input
          class="bbi-input"
          type="text"
          v-model="editName"
          :readonly="editItem.builtin"
          placeholder="Artist Tags name"
          spellcheck="false"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Painter string (spelled at the front of the positive prompt word)</span>
        <BbiTextarea
          v-model="editPrompt"
          :rows="4"
          :max-rows="12"
          mono
          :readonly="editItem.builtin"
          placeholder="artist:xxx, artist:yyy"
        />
      </div>

      <p class="bbi-modal-label">
        Bound positive quality words &quot;{{ editItem.preset.quality.trim() ? 'Already set' : 'not set' }}”, negative prompt words “{{
          editItem.preset.negative.trim() ? 'Already set' : 'not set'
        }}&quot;; To change them, first set this as the current artist string in the panel, and then click the corresponding line in the prompt area.
      </p>

      <footer class="bbi-modal-foot">
        <button class="bbi-btn" type="button" @click="toggleActive(editItem)">
          {{ editItem.preset.id === activeId ? 'Disable this' : 'Set as current artist tags' }}
        </button>
        <template v-if="editItem.builtin">
          <button class="bbi-btn" type="button" @click="duplicateFromEdit">
            <Icon name="copy" /> Copy as my artist tags
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeEdit">Close</button>
        </template>
        <template v-else>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeEdit">Cancel</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">Done</button>
        </template>
      </footer>
    </div>
  </ModalMask>

  <input
    ref="previewFileInput"
    type="file"
    accept="image/*"
    hidden
    @change="onPreviewFileChange"
  />
</template>

<style scoped>
/* Manager dialog: one step wider than the generic dialog to fit a card grid; fixed height, the grid area scrolls inside, header/toolbar/footer pinned.
   .bbi-modal defaults to overflow-y:auto; here it becomes hidden, and scrolling is handed to .am-scroll. */
.am-modal {
  max-width: 760px;
  height: 86vh;
  height: 86dvh;
  overflow: hidden;
}

.am-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.am-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.am-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* Bulk action bar: only appears when something is checked; a light accent background separates it from regular content */
.am-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-accent-soft);
  font-size: 12px;
}
.am-batch-count {
  font-weight: 600;
  color: var(--bbi-accent);
  white-space: nowrap;
}
.am-batch-spacer {
  flex: 1 1 auto;
}

.am-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.am-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
  padding: 2px 2px 6px;
}

.am-empty {
  margin: 0;
  padding: 56px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-soft);
}

/* —— Cards: clicking the body = enable/disable; the selected state uses a light background (different from the enabled state's outline) —— */
.am-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.am-card:hover {
  border-color: var(--bbi-accent);
}
.am-card.is-active {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}
.am-card.is-selected {
  background: var(--bbi-accent-soft);
}

/* Preview area: fixed 4:3, placeholders and real images share the same geometry so card heights line up */
.am-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}
.am-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.am-art-empty {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  cursor: pointer;
}
.am-art-empty:hover {
  color: var(--bbi-accent);
}
.am-art-empty:disabled {
  cursor: default;
  opacity: 0.6;
}
.am-art-empty--static,
.am-art-empty--static:hover {
  cursor: default;
  color: var(--bbi-ink-muted);
}

/* The checkbox sits on a patch of surface background so it stays legible over the image */
.am-check {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  padding: 2px;
  border-radius: 6px;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  cursor: pointer;
}
.am-check .bbi-checkbox {
  width: 15px;
  height: 15px;
}

.am-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink-muted);
  border: 1px solid var(--bbi-line);
}
.am-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  border-color: transparent;
}

/* "Change preview image": a centred pill that appears only on hover, not covering the image normally;
   touch has no hover, so it uses the same button in the editor dialog (two channels; never hidden away) */
.am-art-change {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  padding: 4px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.am-card:hover .am-art-change,
.am-art-change:focus-visible,
.am-art-change:disabled {
  opacity: 1;
}
.am-art-change:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.am-body {
  padding: 8px 10px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.am-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* Radio circle: shaped differently from the checkbox (square, bulk), conveying "enabling is a mutually exclusive single choice" */
.am-radio {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-accent-ink);
}
.am-radio.is-on {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.am-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Content summary: monospace, truncated to two lines; min-height keeps cards without content aligned */
.am-prompt {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  min-height: 2.9em;
}

.am-ops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}
.am-op {
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
}
.am-op:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
/* Delete pushed to the end of the row, away from the two "constructive" actions edit/duplicate */
.am-op-danger {
  margin-left: auto;
}
.am-op-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.am-foot {
  align-items: center;
}
.am-foot-hint {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— Edit/view dialog —— */
.am-edit {
  max-width: 560px;
}
.am-edit-preview {
  display: flex;
  align-items: center;
  gap: 12px;
}
.am-edit-thumb {
  width: 112px;
  height: 84px;
  object-fit: cover;
  border-radius: var(--bbi-radius-sm);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}
.am-edit-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-muted);
  font-size: 20px;
}
.am-edit-preview-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* Danger button: same rule as the settings page/ConfirmDialog; scoped doesn't cross components, so a copy is added */
.am-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.am-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* Small icon buttons in group headers/dialogs: same as NaiPanel; scoped doesn't cross components, so a copy is added */
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
  .am-modal {
    max-width: 100%;
  }
  .am-grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  }
  .am-foot-hint {
    display: none;
  }
}
</style>
