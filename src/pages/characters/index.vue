<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { computed, ref } from 'vue';

/**
 * Character management: two layers of fixed-appearance libraries:
 * - global library: read-only templates applying across all chats; the AI never changes them, maintained by hand only (suited to fixed looks such as the player character).
 * - this chat's library: current chat only; BaiBai Book creates profiles automatically and the AI changes them with the story; same names take precedence over global.
 * Appearance is recorded by field (sex/hair/eyes/...), and the joined result is the final tag; when generating tags the AI copies the library fields,
 * and leftover @name placeholders are replaced by the plugin as a fallback, so the appearance stays stable without drifting.
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName: name of the existing entry being edited; null = new. Whether the dialog is open is decided by whether draft exists.
const editingName = ref<string | null>(null);
// editingScope: layer of the entry being edited; draftScope: layer the draft saves to (only selectable when creating).
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// Draft source: manual edits switch it to manual; "Regenerate from BaiBai Book" switches it to book.
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// History panel toggle inside the dialog
const historyOpen = ref(false);
// Rollback confirmation
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: 'For fan-work characters: character name (copyright name), brackets not escaped; blank for originals',
  sex: 'e.g. 1girl / 1boy',
  hair: 'e.g. long black hair',
  eyes: 'e.g. red eyes',
  skin: 'e.g. pale skin (optional)',
  body: 'e.g. petite, slender',
  extra: 'e.g. heterochromia (optional)',
  outfit: 'Signature outfit (optional)',
};

/** Set of global library names (reactive), for sections and the "override" badge. */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * This chat's section = entries in the derived library that "belong to this chat":
 * those in this chat's baseline (including same-name entries overriding global) + non-global ones (profiles created on AI floors, etc.).
 * Purely global entries only appear in the global section.
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** Whole-string mode: has raw and no fields. */
const draftIsRaw = computed(
  () => !!draft.value && !!draft.value.raw.trim() && CHAR_TAG_FIELDS.every(f => !draft.value!.fields[f].trim()),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** Live history of the chat entry being edited (refreshes after rollback); global entries keep no history. */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** Field chips on the card: fields if present; whole-string mode falls back to the raw text (branched in the template). */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
}

/* —— Section collapsing (modelled on BaiBai Book's "Plans/Suspense") ——
 * The title row doubles as the collapse toggle; collapsed state is a local view preference, stored in localStorage, not in settings (syncing across devices is pointless). */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* When localStorage is unavailable it only lasts for this session */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// No entries means nothing to collapse: no arrow or count, and forced open (avoids getting stuck in a collapsed empty state after deleting everything)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** Manually edited field → the entry becomes manual (but the AI can still take it over with changes) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('Character name cannot be empty', 'BaiBai Image');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('Fill in at least one appearance field (or the whole tag string)', 'BaiBai Image');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) closeEntry();
}

/* —— Delete: second confirmation —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  closeEntry();
}

/* —— Promote to global / copy to this chat —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`"${editingName.value}" promoted to a global character; it applies in all chats`, 'BaiBai Image');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`Copied "${name}" to this chat; from now on this chat uses the copy.`, 'BaiBai Image');
  }
  closeEntry();
}

/* —— Create a profile from BaiBai Book's latest state: take the latest floor's character reference, find the same-name character's appearance record, convert to fields via the batch conversion endpoint —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('Fill in the character name first', 'BaiBai Image');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('No chat is open', 'BaiBai Image');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('BaiBai Book\'s latest state has no appearance for this character. Fill it in by hand.', 'BaiBai Image');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('The model returned no tags for this character. Try again or fill them in by hand.', 'BaiBai Image');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('Generated from BaiBai Book\'s latest appearance. Click "Done" to save.', 'BaiBai Image');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image');
  } finally {
    regenerating.value = false;
  }
}

/* —— History display and rollback (this chat's entries only) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return 'Profile created';
  if (field === 'raw') return 'Whole string';
  if (field === 'nl') return 'Natural language';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`Rolled back the ${fieldLabel(p.record.field)} change for "${p.name}"`, 'BaiBai Image');
  } else {
    toastr.warning('Rollback failed: the entry may have been deleted', 'BaiBai Image');
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? 'BaiBai Book' : entry.source === 'ai' ? 'AI' : 'Manual';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Characters</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      The appearance library keeps characters consistent. Image planning copies their saved features; legacy @name references use the latest saved appearance.
    </p>

    <!-- ===== Global character library ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? 'Collapse global character library' : 'Expand global character library') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">Global character library</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="Add global character" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr expand/collapse: height adapts, no hard-coded max-height needed -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            Applies in every chat and is maintained by hand only: the AI never changes global characters, which suits fixed designs such as the player character. If this chat has a character with the same name, this chat's entry wins.
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-char-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'global')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span class="bbi-char-pill is-global">Global</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="This chat has a character with the same name, so this chat uses its own entry.">
                    Overridden in this chat
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            No global characters yet. Click &quot;Promote to global&quot; when editing a chat character, or click &quot;+&quot; at the top right.
          </p>
        </div>
      </div>
    </div>

    <!-- ===== This chat's characters ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? 'Collapse chat characters' : 'Expand chat characters') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">Chat characters</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="Add chat character" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            Applies to this chat only. BaiBai Book characters are profiled automatically, and the AI records permanent changes as the story goes; history can be viewed and rolled back.
          </p>
          <ul v-if="chatEntries.length" class="bbi-char-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'chat')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >
                    {{ sourceLabel(entry) }}
                  </span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="Same name as a global character; this chat uses this entry">
                    Overrides global
                  </span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} change records; click the card to view`"
                  >
                    <Icon name="history" />{{ entry.history.length }}
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            This chat has no characters yet. They are created from BaiBai Book when tags are generated, or click &quot;+&quot; at the top right to add one by hand.
          </p>
        </div>
      </div>
    </div>

    <!-- ===== Character editor dialog ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="Edit character">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? 'Edit character' : 'Add character' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? 'Global' : 'This chat' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- Scope: only selectable when creating; existing entries change layer via "Promote to global / Copy to this chat" at the bottom -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">Save to</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              This chat
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              Global
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? 'Global: applies in all chats; the AI never changes it, so fix tags by hand if needed.' : 'This chat: applies here only; the AI can update it as the story goes.' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Character name</span>
          <input v-model="draft.name" class="bbi-input" placeholder="Same name as in the story/BaiBai Book" @input="markManual" />
        </label>
        <span class="bbi-field-hint">Use the exact name from the story or BaiBai Book. Names are matched verbatim; renaming an entry does not update earlier references.</span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">Appearance fields</span>
          <div class="bbi-char-form">
            <label
              v-for="f in CHAR_TAG_FIELDS"
              :key="f"
              class="bbi-char-form-row"
              :class="{ 'is-wide': f === 'outfit' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
              <input
                v-model="draft.fields[f]"
                class="bbi-input"
                :placeholder="FIELD_PLACEHOLDERS[f]"
                @input="markManual"
              />
            </label>
          </div>
        </div>
        <span class="bbi-field-hint">Save permanent features and signature outfits here. Temporary clothing, expressions, and actions come from the current scene.</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Custom tag string (optional)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="Blank = built from the fields above. If this is filled in and every field is empty, this whole string is used (old data format)"
            @input="markManual"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Natural language appearance (optional)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="A coherent English appearance description. Replaces @character name in nl in natural-language mode; blank = the tag string is used instead."
            @input="markManual"
          />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">Final tag preview</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(empty)' }}</code>
          <span v-if="draftIsRaw" class="bbi-char-preview-mode">Whole string mode</span>
        </div>

        <!-- Change history: this chat's entries only; global entries have no history (the AI can't change them, and manual edits leave no trace) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            Change history ({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `Floor ${record.floor}` : 'Manual' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="Roll back the field to its value before the change" @click="askRollback(record)">
                rollback
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> Delete
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            v-if="editingName && editingScope === 'chat'"
            class="bbi-btn"
            type="button"
            title="Snapshot the current appearance into the global library for all chats; this chat's copy and change history are cleared"
            @click="askPromote"
          >
            <Icon name="star" /> Promote to global
          </button>
          <button
            v-if="editingName && editingScope === 'global'"
            class="bbi-btn"
            type="button"
            title="Copy into this chat: from now on this chat uses the copy, and the AI can change it"
            @click="copyToChat"
          >
            <Icon name="copy" /> Copy to this chat
          </button>
          <button
            class="bbi-btn"
            type="button"
            title="Read this character's appearance from BaiBai Book's latest state and convert it into fields again"
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? 'Generating…' : 'Generate from BaiBai Book' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">Done</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Delete character"
          confirm-text="Delete"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          Delete the fixed appearance of &quot;{{ editingName }}&quot;? Later images will no longer anchor this character's appearance.
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="Promote to global"
          confirm-text="Promote"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          Save a snapshot of &quot;{{ editingName }}&quot;'s current appearance to the global library? All chats, this one included, will then use the global value.
          AI can no longer modify it; the copy and change history of this chat will be cleared.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== Rollback confirmation ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="Roll back change"
      confirm-text="Roll back"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        Roll back &quot;{{ fieldLabel(pendingRollback.record.field) }}&quot; for &quot;{{ pendingRollback.name }}&quot; from
        <code>{{ pendingRollback.record.to }}</code> to
        <code>{{ pendingRollback.record.from || '(empty)' }}</code> ?
        Rolling back a profile-creation record deletes the whole entry.
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* —— Count pill: same look as the version number on the settings page —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— Sections —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— Collapse toggle (modelled on BaiBai Book's "Plans/Suspense") ——
 * The whole title row is clickable: left arrow + title + count badge. Borderless and transparent; collapsing is a secondary action, the title stays the focus. */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* Collapse arrow: points down when expanded, rotated -90° to the right when collapsed. Stroke inherits currentColor (muted); hovering the row lights it with the accent colour. */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* Expandable container: grid 1fr↔0fr, height follows content, no hard-coded max-height needed */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Small "+" on the right of the section header: transparent background, lit only on hover, so it doesn't steal attention */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

/* —— Character card grid —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— Badge pills: global = solid accent; BaiBai Book/AI = light accent background; manual = muted; override = warning colour —— */
.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— Field chips: capped at two lines, overflow clipped —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* Whole-string mode: small mono text truncated to two lines */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— Wider dialog to fit a two-column field form —— */
.bbi-char-modal {
  max-width: 600px;
}

/* —— Field form: two-column grid; the fixed outfit takes a row of its own —— */
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— History panel inside the dialog —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— Final tag preview —— */
.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
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

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
