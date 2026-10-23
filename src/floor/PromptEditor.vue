<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { activeOrientationLock } from '@/state/settings';
import { containsTagMarkup, type ImageTagContent } from '@/st/imageTagRegex';

/**
 * Dialog for manually editing an image prompt (the pencil button in the floor card's ⋯ menu).
 *
 * [Why edit structured fields rather than one big text box]
 * The card's promptText (Card.vue) is a display string assembled for people, with prefixes such as "Role: 小雪" and "Negative: ",
 * and it **cannot be parsed back**. Here the five fields of ImageTagContent are edited separately and serialised together by
 * serializeImageTag on save; fields without an editor are carried back unchanged, so characters is never silently dropped.
 *
 * [This component is mounted imperatively (floor/promptEditor.ts) and outlives the card]
 * Any sibling slot's image re-hydrates and destroys cards while the dialog stays open. So floor coordinates are always snapshotted by the caller
 * and passed in; the component never reads the card's props. The same discipline as Lightbox.
 */

const props = defineProps<{
  /** Original content when opened (parse result); the draft is compared against it to decide "was anything really changed". */
  content: ImageTagContent;
  /** How many images exist for the current prompt (>1 warns that changing the prompt collapses them into one). */
  historyCount: number;
  /** Whether the backend is configured ("Apply and regenerate" is disabled when not). */
  configured: boolean;
  /** Busy (write-back in progress): disables the bottom buttons to avoid writing twice on double clicks. */
  busy?: boolean;
  /**
   * An AI prompt rewrite is in flight (its runtime state is in floor/tagPlanState.ts and **does not belong to this dialog**).
   * Closing the dialog doesn't interrupt the rewrite, and a reopened dialog still sees it lit, so the caller passes it in from the store.
   */
  rewriting?: boolean;
  /** An AI rewrite has already been saved in this dialog: the inputs below hold the **saved** version; say so plainly. */
  rewritten?: boolean;
  /**
   * The caller requests closing: once true, this component plays its leave animation.
   * **Never get the component instance via ref instead**: this component is mounted imperatively with render(h(...)),
   * has no parent component instance, and `ref`'s owner is null: Vue silently skips it on mount (guarded by parentComponent),
   * but on unmount there is no such guard, and reading owner.refs throws "Cannot read properties of null".
   * All state goes through props/emit; don't use ref as an escape hatch.
   */
  closing?: boolean;
}>();

const emit = defineEmits<{
  /** Apply; regenerate=true means start generating right after write-back. */
  (e: 'apply', value: ImageTagContent, regenerate: boolean): void;
  /** Requests an AI rewrite of this image's prompt (the caller saves and generates; this component only reads the result back into the draft). */
  (e: 'rewrite'): void;
  /** Cancels the in-flight AI rewrite. */
  (e: 'cancel-rewrite'): void;
  /** Whether the draft was changed (the caller uses it to decide whether to ask "Discard changes?" before closing). */
  (e: 'dirty', value: boolean): void;
  (e: 'close'): void;
}>();

/**
 * Visibility. **The initial value must be false**: Vue's <Transition> doesn't animate the first render by default (no appear),
 * so if it were true on mount the dialog would just pop up abruptly. Flipping to true after mount gives the enter animation,
 * matching the settings page dialogs whose open flips up from false.
 */
const open = ref(false);

const tag = ref(props.content.tag);
const nl = ref(props.content.nl);
const negative = ref(props.content.negative);
const size = ref<Orientation>(props.content.size);
const characters = ref<ImageCharacterPrompt[]>(
  props.content.characters.map(character => ({ ...character })),
);

/**
 * The current channel's orientation lock (null = unlocked; see activeOrientationLock in settings.ts).
 * When locked, the orientation buttons show the locked value and are disabled: generation always follows the lock (generate.ts), so letting people choose here
 * would be a switch with no effect. The draft's size is untouched: the orientation recorded in the text stays, and switching the channel back to "Auto" restores it.
 */
const lockedSize = computed<Orientation | null>(() => {
  const lock = activeOrientationLock();
  return lock === 'auto' ? null : lock;
});

/** Folds newlines into spaces: same rule as oneLine in parseImageTagContent (newlines mean nothing in a prompt). */
function oneLine(text: string): string {
  return text.trim().replace(/[\r\n]+/g, ' ');
}

/** Normalised draft: both saving and "was anything changed" use it; the two must not compute it separately. */
const draft = computed<ImageTagContent>(() => ({
  tag: oneLine(tag.value),
  nl: oneLine(nl.value),
  negative: oneLine(negative.value),
  characters: characters.value
    .map(character => ({
      name: oneLine(character.name),
      tag: oneLine(character.tag),
      nl: oneLine(character.nl),
    }))
    // Same rule as parseImageTagContent: an entry missing name or tag is dropped (blank rows never reach the text)
    .filter(character => character.name && character.tag),
  size: size.value,
}));

function sameCharacters(a: ImageCharacterPrompt[], b: ImageCharacterPrompt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, index) =>
      item.name === b[index].name && item.tag === b[index].tag && item.nl === b[index].nl,
  );
}

/**
 * Whether the draft matches the original content. **Compares field by field, not the serialised result**:
 * parsing is lenient (accepts bare text / explicit <tag> / missing sub-tags) while serialisation is canonical,
 * so opening a hand-written non-canonical tag and saving it unchanged would change the serialised raw text → promptHash changes →
 * nothing was changed, yet every old image becomes "old prompt".
 */
const dirty = computed(() => {
  const next = draft.value;
  return (
    next.tag !== props.content.tag ||
    next.nl !== props.content.nl ||
    next.negative !== props.content.negative ||
    next.size !== props.content.size ||
    !sameCharacters(next.characters, props.content.characters)
  );
});

/** Validation: tag is required + no field may contain sub-tag literals (same rule as the AI side). */
const error = computed(() => {
  const next = draft.value;
  if (!next.tag) return 'Image tags cannot be empty';
  const fields: Array<[string, string]> = [
    ['Image tags', next.tag],
    ['Natural Language', next.nl],
    ['Negative prompt', next.negative],
  ];
  for (const character of next.characters) {
    fields.push([`Character "${character.name}"`, `${character.name} ${character.tag} ${character.nl}`]);
  }
  for (const [label, value] of fields) {
    if (value && containsTagMarkup(value)) {
      return `${label} cannot contain <bbi_image> / <tag> / <nl> / <negative> / <characters> / <size> tags`;
    }
  }
  return '';
});

const canApply = computed(() => !error.value && !props.busy && !props.rewriting);

/**
 * After an AI rewrite is saved, reads the new prompt back into the input box.
 *
 * The rewrite is **really saved** (the runner writes the text + generates the image), so a change in content means "this is the version
 * now in the text"; the dialog's draft must follow, otherwise clicking "Apply" would overwrite the fresh rewrite with the old draft.
 * It deliberately doesn't ask "discard the draft?": the user clicked the rewrite themselves, and the draft content lies unchanged in the input box below,
 * where they can see it and edit it again at any time.
 */
watch(
  () => props.content,
  next => {
    tag.value = next.tag;
    nl.value = next.nl;
    negative.value = next.negative;
    size.value = next.size;
    characters.value = next.characters.map(character => ({ ...character }));
  },
);

function addCharacter(): void {
  characters.value.push({ name: '', tag: '', nl: '' });
}

function removeCharacter(index: number): void {
  characters.value.splice(index, 1);
}

function apply(regenerate: boolean): void {
  if (!canApply.value) return;
  emit('apply', draft.value, regenerate);
}

function rewrite(): void {
  if (props.busy || props.rewriting || !props.configured) return;
  emit('rewrite');
}

/**
 * Discard confirmation before closing is left to the caller (it has confirmDialog, and decides by dirty whether to ask).
 * Closing is allowed as usual while a rewrite is in flight: the request belongs to tagPlanState, not this dialog, so closing doesn't interrupt it,
 * and reopening can rejoin it (see rejoin in promptEditor.ts).
 */
function requestClose(): void {
  if (props.busy) return;
  emit('close');
}

// Push draft changes to the caller (it has no component instance to read; see the comment on the closing prop)
watch(dirty, value => emit('dirty', value), { immediate: true });

// The caller asks to close → play the exit animation; the real unmount is done by the caller after the animation duration
watch(
  () => props.closing,
  value => {
    if (value) open.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // Capture phase: get Esc before ST's global shortcuts (otherwise it would close other things too)
  event.stopPropagation();
  requestClose();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  // Flipping open triggers the enter animation (see where open is declared); a change within the same tick doesn't count, so wait one frame
  requestAnimationFrame(() => {
    open.value = true;
  });
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <ModalMask :open="open" top-layer @close="requestClose">
    <div
      class="bbi-modal bbi-modal-wide"
      role="dialog"
      aria-modal="true"
      aria-label="Edit prompt"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">Edit prompt</span>
        <button class="bbi-icon-mini" type="button" title="Close" @click="requestClose">
          <Icon name="close" />
        </button>
      </header>

      <!-- AI rewrite: editing by hand and by AI are two means to the same end, so they share one dialog.
           When it finishes it saves and generates directly (see promptEditor.ts), and the result is refilled into the inputs below. -->
      <div class="bbi-rewrite-row">
        <button
          v-if="!rewriting"
          class="bbi-btn bbi-btn-sm"
          type="button"
          :disabled="busy || !configured"
          :title="
            configured
              ? 'Let AI reread this floor and rewrite this image\'s prompt'
              : 'Finish setup on the &quot;Backend&quot; page of BaiBai Image first.'
          "
          @click="rewrite"
        >
          <Icon name="sparkles" /> AI rewrite prompt
        </button>
        <template v-else>
          <span class="bbi-rewrite-busy">
            <span class="bbi-rewrite-spin" />
            AI is rewriting the prompt…
          </span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="emit('cancel-rewrite')">
            Cancel rewrite
          </button>
        </template>
      </div>
      <p v-if="rewriting" class="bbi-editor-note">
        When it finishes, the new prompt is saved and an image is generated from it. The result is filled into the boxes below.
        Closing this window will not stop it. Reopen it to see the progress.
      </p>
      <!-- Saved but the dialog is still open: the inputs below look the same as "something the user half-typed"; without saying which one is in effect,
           users would think they still need to click "Apply" (or, conversely, that the draft was saved too). -->
      <p v-else-if="rewritten" class="bbi-editor-note">
        AI rewrite done. The new prompt is saved and generating has started; it is filled in below. To adjust it, edit below and click &quot;Apply&quot;.
      </p>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Image tags (short danbooru tags, comma-separated)</span>
        <BbiTextarea
          v-model="tag"
          class="bbi-prompt-area"
          :rows="4"
          :max-rows="14"
          mono
          placeholder="1girl, long black hair, school uniform, classroom"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Natural language (optional; used by some backends/models)</span>
        <BbiTextarea
          v-model="nl"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          placeholder="A girl standing by the classroom window at sunset."
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Negative prompt for this image (optional; added to the channel negative prompt)</span>
        <BbiTextarea
          v-model="negative"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          mono
          placeholder="extra people, duplicate"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">Frame orientation (pixel sizes are set on the &quot;Backend&quot; page)</span>
        <div class="bbi-segmented" role="tablist" aria-label="Frame direction">
          <button
            class="bbi-seg"
            :class="{ 'is-on': (lockedSize ?? size) === 'portrait' }"
            type="button"
            role="tab"
            :aria-selected="(lockedSize ?? size) === 'portrait'"
            :disabled="!!lockedSize"
            @click="size = 'portrait'"
          >
            Portrait
          </button>
          <button
            class="bbi-seg"
            :class="{ 'is-on': (lockedSize ?? size) === 'landscape' }"
            type="button"
            role="tab"
            :aria-selected="(lockedSize ?? size) === 'landscape'"
            :disabled="!!lockedSize"
            @click="size = 'landscape'"
          >
            Landscape
          </button>
        </div>
        <span v-if="lockedSize" class="bbi-field-hint">
          The current channel is locked to {{ lockedSize === 'portrait' ? 'portrait' : 'landscape' }}, so every image uses that orientation.
          To use each image's own orientation, set the size lock on the &quot;Backend&quot; page back to &quot;Auto&quot;.
        </span>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">
          Character prompts (multiple characters; sent only by the NAI backend)
        </span>
        <div v-for="(character, index) in characters" :key="index" class="bbi-char-row">
          <input
            v-model="character.name"
            class="bbi-input bbi-char-name"
            type="text"
            placeholder="Character name"
          />
          <input
            v-model="character.tag"
            class="bbi-input bbi-char-tag"
            type="text"
            placeholder="tags (e.g. girl, black hair)"
          />
          <input
            v-model="character.nl"
            class="bbi-input bbi-char-nl"
            type="text"
            placeholder="Natural language (optional)"
          />
          <button
            class="bbi-icon-mini"
            type="button"
            title="Remove this character"
            @click="removeCharacter(index)"
          >
            <Icon name="trash" />
          </button>
        </div>
        <button class="bbi-btn bbi-btn-sm bbi-char-add" type="button" @click="addCharacter">
          <Icon name="plus" /> Add role
        </button>
        <span class="bbi-field-hint">A row applies only when both the character name and tags are filled in. Blank rows are dropped on save.</span>
      </div>

      <!-- Changing the prompt switches the promptHash bucket, and the stale state shows only the newest image with no pager.
           That is the existing storage design, but manual prompt edits turn it from an edge case into an everyday one, so it is stated explicitly. -->
      <p v-if="historyCount > 1" class="bbi-editor-note">
        The current prompt already has {{ historyCount }} images. After the change only the latest one is shown (no image is deleted;
        change the prompt back to recover them all).
      </p>

      <p v-if="error" class="bbi-editor-error">{{ error }}</p>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" :disabled="busy" @click="requestClose">Cancel</button>
        <button class="bbi-btn" type="button" :disabled="!canApply" @click="apply(false)">
          Apply
        </button>
        <button
          class="bbi-btn bbi-btn-primary"
          type="button"
          :disabled="!canApply || !configured"
          :title="configured ? 'Save the prompt and generate an image' : 'Finish setup on the &quot;Backend&quot; page of BaiBai Image first.'"
          @click="apply(true)"
        >
          <Icon name="palette" /> Apply and regenerate
        </button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
/* —— The four rules below aren't global in base.css, and scoped styles don't cross component boundaries, so each place keeps its own copy
      (same approach as ConfirmDialog.vue) —— */
.bbi-modal-wide {
  max-width: 680px;
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

.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— Character row: narrow name, tag and natural language take half each, delete button at the end —— */
.bbi-char-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.bbi-char-name {
  flex: 0 0 96px;
  min-width: 0;
}
.bbi-char-tag,
.bbi-char-nl {
  flex: 1 1 0;
  min-width: 0;
}
.bbi-char-add {
  align-self: flex-start;
  margin-top: 8px;
}

/* —— AI rewrite row: pinned below the title, separated from the field area below —— */
.bbi-rewrite-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.bbi-rewrite-busy {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  font-size: 12.5px;
  color: var(--bbi-ink-soft);
}

.bbi-rewrite-spin {
  width: 12px;
  height: 12px;
  border: 2px solid var(--bbi-line-strong);
  border-top-color: var(--bbi-accent);
  border-radius: 50%;
  animation: bbi-rewrite-spin 0.7s linear infinite;
}

@keyframes bbi-rewrite-spin {
  to {
    transform: rotate(360deg);
  }
}

.bbi-editor-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}

.bbi-editor-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-danger);
}

/* Narrow screens: the character row stacks vertically, otherwise the three inputs squeeze into slivers */
@media (max-width: 560px) {
  .bbi-char-row {
    flex-wrap: wrap;
  }
  .bbi-char-name {
    flex: 1 1 100%;
  }
  .bbi-char-tag,
  .bbi-char-nl {
    flex: 1 1 100%;
  }
}
</style>
