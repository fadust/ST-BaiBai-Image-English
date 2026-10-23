<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { cancelFloorTags } from '@/autoTag/runner';
import { effectiveOrientation, type Orientation } from '@/backends/size';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { consumeAutoGenerate, shouldAutoGenerate } from '@/floor/autoGenerate';
import { isCollapsed, setCollapsed } from '@/floor/collapseState';
import { imageDownloadFileName, saveImageFile } from '@/floor/download';
import {
  beginGen,
  cancelGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  reconcileGen,
  setGenPhase,
  setGenRetry,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';
import { hydrateMessage } from '@/floor/hydrate';
import { openLightbox } from '@/floor/lightbox';
import { confirmImageMissing, isImageMissing } from '@/floor/missingImages';
import { openPromptEditor } from '@/floor/promptEditor';
import {
  deleteImageResult,
  promptHash,
  saveImageResult,
  type BbiImageEntry,
} from '@/floor/storage';
import { isTagPlanning } from '@/floor/tagPlanState';
import { formatGenerationMeta } from '@/generationMeta';
import { activeComfyPreset, activeOrientationLock, imageDisplayMaxHeight, settings } from '@/state/settings';
import { beginImage, failImage, finishImage, safeHistory } from '@/state/history';
import { copyText } from '@/st/clipboard';
import { getContext } from '@/st/context';
import { formatPromptText } from '@/st/imageTagRegex';

/**
 * Floor image card (DESIGN-FLOOR-UI.md §8).
 *
 * [Important] This component is a **pure display layer** and holds no runtime state.
 * Card lifetimes are decided by external hydration: a successful image on any slot re-hydrates via hydrateMessage,
 * and re-hydration unmounts the **whole floor's** cards; when ST re-renders a floor the anchor DOM is rebuilt too.
 * Runtime state (generating/error/in-flight request) always lives in the module-level store in floor/genState.ts, claimed by slot key,
 * and read back as soon as the component is rebuilt; otherwise "one image finishes, and every other card's 'Generating…' vanishes and falls back to pending"
 * (the marks were consumed and won't rerun automatically). Read the top comment in genState.ts before changing this.
 *
 * Display state has two layers:
 * - runtime state (store): queued / generating / error, surviving rebuilds;
 * - derived state (props): ready (history for this prompt) / stale (only old-prompt results) / pending, computed from props each time.
 */

const props = defineProps<{
  /** Tag part parsed from the raw tag (short danbooru tags; for display and generation). */
  prompt: string;
  /** Natural-language part parsed from the raw tag (empty string if none; written into the %nl% placeholder at generation). */
  nl: string;
  /** Dynamic negative part parsed from the raw tag (empty string if none; written into the %negative_prompt% placeholder at generation). */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** Frame orientation (decided by the model, persisted with the tag): picks the channel's portrait or landscape size; a channel orientation lock wins (see effectiveSize). */
  size: Orientation;
  /** Raw tag text (including the <bbi_image> wrapper): input for generation submission and promptHash. */
  tag: string;
  messageId: number;
  seq: number;
  swipeId: number;
  /** All history for the current prompt in this slot (chronological, newest last). */
  history: BbiImageEntry[];
  /** With no matching history, the latest result of an old prompt in this slot (stale). */
  staleEntry: BbiImageEntry | null;
  /** Chat id it belongs to (passed in at hydration): part of the slot key, so it no longer calls getContext separately. */
  chatId: string;
}>();

type Phase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const key = computed(() => slotKey(props.chatId, props.messageId, props.swipeId, props.seq));
const hash = computed(() => promptHash(props.tag));

/**
 * The part of the history whose files still exist. **Cards always use this, never props.history**.
 *
 * The gallery can now delete files under user/images directly, while the image's pointer stays in this floor's extra
 * (the gallery lists by folder and pointers live in some chat, with no reverse index between them, and scanning everything is infeasible;
 * see the top of floor/missingImages.ts). Without filtering broken pointers, the pager would gain cells you can page to but that are empty,
 * and the collapsed bar's "N images" would be inflated too.
 *
 * Filtering only removes images **confirmed as 404** (the missingImages register), never guesses: unmarked images are always treated as present.
 */
const liveHistory = computed(() => props.history.filter(entry => !isImageMissing(entry.path)));
/** Old-prompt results need reconciling too: their files may also be deleted by the gallery. */
const liveStale = computed(() =>
  props.staleEntry && !isImageMissing(props.staleEntry.path) ? props.staleEntry : null,
);

/** Pager position: defaults to the newest. When history changes (new image saved / broken pointer removed) it follows the newest automatically. */
const index = ref(liveHistory.value.length ? liveHistory.value.length - 1 : 0);
watch(
  () => liveHistory.value.length,
  length => {
    // If the deleted one was the current one, index goes out of range → clamp back to the last; when a new image is saved, follow the newest
    index.value = length ? length - 1 : 0;
  },
);

const promptOpen = ref(false);

/**
 * Collapsed state: stored in the module-level store and claimed by slot key (the component is rebuilt by hydration at any time, losing refs);
 * slots never set manually fall back to the setting "Collapse floor images by default". See floor/collapseState.ts.
 */
const collapsed = computed<boolean>({
  get: () => isCollapsed(key.value, settings.ui.autoCollapseImages),
  set: value => setCollapsed(key.value, value),
});

/** Expanded state of the touch overflow menu (⋯ button); desktop hover shows the row directly and doesn't use it. */
const menuOpen = ref(false);

/** Runtime record (may be undefined = no in-flight task). */
const record = computed(() => getGenRecord(key.value));

/**
 * An "AI rewrite prompt" request is in flight (module-level store, see floor/tagPlanState.ts).
 * Deliberately separate from image runtime state: it runs an LLM request, with cancel/concurrency semantics independent of image generation.
 */
const planning = computed(() => isTagPlanning(key.value));

const phase = computed<Phase>(() => {
  const running = record.value;
  if (running) return running.phase;
  // Uses the surviving set: once the gallery deletes every image it should fall back to pending and offer "Generate image",
  // rather than staying ready and showing a broken image (which couldn't even be regenerated).
  if (liveHistory.value.length) return 'ready';
  if (liveStale.value) return 'stale';
  return 'pending';
});

const error = computed(() => record.value?.error ?? '');
const queueAhead = computed(() => record.value?.queueAhead ?? null);
/** Backing off from rate limits (NAI automatic retry); when non-null the status text reports this first. */
const retryInfo = computed(() => record.value?.retry ?? null);

const comfyActive = computed(() => settings.defaultBackend === 'comfyui');
const naiActive = computed(() => settings.defaultBackend === 'nai');
/**
 * Whether the backend is fully configured (decides between the "Generate image" button and setup guidance).
 * The criterion is backendStatus in generate.ts, the same source as actual generation and the public API;
 * this place once had its own check, so changing ComfyUI simple-mode validation meant editing two places.
 */
const configured = computed(() => backendStatus().configured);

/**
 * Actual output orientation: if the current channel locks orientation, use the lock (activeOrientationLock in settings.ts), otherwise what the tag recorded.
 * generate.ts already applies the lock at generation; computing it again here keeps history records and the no-image placeholder's ratio consistent with the image
 * actually produced; otherwise with landscape locked, the placeholder would still reserve a big portrait block per the tag. The raw tag isn't changed (that would change promptHash).
 */
const effectiveSize = computed(() => effectiveOrientation(activeOrientationLock(), props.size));

/**
 * Setting "Floor image display size": maximum image display height (px; null = fill the floor width, how it looked in 0.3.0 and earlier).
 * Passed to card.css only via data-capped + a CSS variable; image dimensions are never measured.
 */
const displayMaxHeight = computed(() => imageDisplayMaxHeight(settings.ui.imageDisplaySize));

const current = computed(() => liveHistory.value[index.value] ?? null);
/** Full prompt text: shared by copy, the lightbox and the expanded area. Same source as the gallery (st/imageTagRegex.ts). */
const promptText = computed(() =>
  formatPromptText({
    tag: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters,
  }),
);
/**
 * The result currently displayed. **Deliberately ignores runtime state**: on failure/while redrawing the previous image should keep showing;
 * otherwise "has an image → click redraw → fails" would make the image vanish (leaving only an error line), looking as if it was lost.
 */
const shownEntry = computed(() => (liveHistory.value.length ? current.value : liveStale.value));
const imageSrc = computed(() => shownEntry.value?.path ?? '');
/**
 * For the lightbox: prompt + read-only metadata (artist string/vibes/sampling parameters).
 * Kept apart from the card's editable `promptText`: metadata is read-only and must never mix into the tag text that gets written back.
 */
const lightboxPrompt = computed(() => {
  const meta = shownEntry.value?.meta;
  return [promptText.value, meta ? formatGenerationMeta(meta) : ''].filter(Boolean).join('\n\n');
});

/**
 * `<img>` failed to load: confirm a real 404 before recording it, so the live* values above drop it.
 *
 * Not every error means deletion: error can't tell "file gone" from "network down" (see missingImages.ts).
 * If confirmation fails nothing happens: the broken-image placeholder stays, and the next <img> remount naturally retries.
 */
async function onImageError(): Promise<void> {
  const path = imageSrc.value;
  if (!path) return;
  await confirmImageMissing(path);
}
const downloadFileName = (entry: BbiImageEntry): string => {
  const context = getContext();
  const characterName = context?.chat[props.messageId]?.name || context?.name2 || '';
  return imageDownloadFileName(entry.path, characterName, entry.generationId);
};
/** Whether the displayed image belongs to an old prompt (old results exist but the current prompt has produced no image yet). */
const isStale = computed(() => !liveHistory.value.length && !!liveStale.value);
/** While generating/queued, the previous image (if any) still shows so the card doesn't collapse; the skeleton overlays it. */
const busy = computed(() => phase.value === 'generating' || phase.value === 'queued');
/** History pager: only when there is more than one image and not busy (counted by surviving images; broken pointers take no cell). */
const pageable = computed(() => liveHistory.value.length > 1 && !busy.value && !planning.value);

/** Had results, but all files were deleted (usually from the gallery). A note is shown so it doesn't look like images vanished for no reason. */
const filesGone = computed(
  () =>
    !busy.value &&
    !liveHistory.value.length &&
    !liveStale.value &&
    !!(props.history.length || props.staleEntry),
);

const statusLabel = computed(() => {
  // Backoff first: the request already failed and is waiting to retry, so it must not keep claiming "Generating"
  const retry = retryInfo.value;
  if (retry) return `Request is restricted, see later ${retry.attempt}/${retry.max} retries…`;
  if (phase.value === 'queued') return 'Queuing up…';
  const ahead = queueAhead.value;
  if (phase.value === 'generating' && ahead !== null && ahead > 0) return `Queuing (front ${ahead} )`;
  return 'Generating...';
});

/** Main text of the collapsed bar: progress while generating; the reason on error; a prompt summary when there is an image (telling apart several images on one floor); pending for an empty slot. */
const barText = computed(() => {
  if (planning.value) return 'AI Rewrite prompt word…';
  if (busy.value) return statusLabel.value;
  if (phase.value === 'error') return error.value || 'Build failed';
  if (shownEntry.value) return props.prompt || props.nl || 'pictures';
  if (filesGone.value) return 'Image file deleted';
  return 'To be generated';
});

/** Configuration guide in the middle of the placeholder area when there is no image and the backend isn't ready. */
const pendingHint = computed(() => {
  if (!comfyActive.value && !naiActive.value)
    return 'The image rendering backend is not selected. Please go to the "Backend" page of BaiBai Image to select the image rendering channel.';
  return naiActive.value
    ? 'NAI is not configured, please go to BaiBai Image\'s "Backend" page to fill in API Key'
    : 'ComfyUI is not configured, please go to BaiBai Image\'s "Backend" page to fill in the workflow';
});

async function generate(): Promise<void> {
  if (busy.value || planning.value || !configured.value) return;
  const slot = key.value;
  const currentHash = hash.value;
  // Every input for this task is read on the spot: while the request is in flight this component may well be destroyed by re-hydration
  // (any sibling slot finishing an image triggers a whole-floor rebuild), and reading props after destruction isn't reliable.
  const job = {
    messageId: props.messageId,
    swipeId: props.swipeId,
    seq: props.seq,
    tag: props.tag,
    prompt: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters.map(character => ({ ...character })),
    size: effectiveSize.value,
  };
  // NAI must queue at the gate → show "Queued" first; ComfyUI has a server queue, so go straight to generating
  const { signal, token } = beginGen(slot, currentHash, naiActive.value ? 'queued' : 'generating');
  // History record id: registered only once the seed is fixed (see below), so it starts empty here and catch uses it to decide whether to wrap up.
  let historyId: number | null = null;

  try {
    // The seed is fixed at the start (the NAI panel's fixed value when its seed > 0; random otherwise) and saved into extra with the result
    // (entry.seed), so history paging can look it up/reuse it. The rule is in generate.ts, from the same source as the public API.
    const seed = decideSeed(settings.defaultBackend);
    // History instrumentation: the seed is fixed and the request is about to go, so register now. The image itself doesn't go into the store (data URLs would blow up memory,
    // and the image is saved into ST right after); only metadata + floor coordinates are kept, enough to trace "how this image was made".
    historyId = safeHistory(() =>
      beginImage({
        backend: naiActive.value ? 'nai' : 'comfyui',
        model: naiActive.value ? settings.nai.model : activeComfyPreset().name,
        prompt: job.prompt,
        nl: job.nl,
        negative: job.negative,
        characters: job.characters,
        seed,
        size: job.size,
        floor: job.messageId,
        seq: job.seq,
      }),
    );
    // The gate and backend dispatch are all inside generateImage (the public API takes the same path; see generate.ts);
    // this component only wires the progress callback to its own slot's runtime state.
    const { result, meta } = await generateImage({ ...job, seed }, signal, {
      onStart: () => setGenPhase(slot, token, 'generating'),
      onQueue: ahead => setQueueAhead(slot, token, ahead),
      onRetry: retry => setGenRetry(slot, token, retry),
    });
    // The image is in hand: if this task has been superseded by now (cancel then redraw / reconcile), don't save it,
    // otherwise the old prompt's result would be written into extra and trigger a needless re-hydration that interrupts the new task.
    if (!isCurrentGen(slot, token)) {
      result.revoke();
      // The image came out but was discarded; record it in history as "Cancelled", otherwise this entry would stay "In progress" forever.
      if (historyId !== null) safeHistory(() => failImage(historyId!, '', true));
      return;
    }
    // Save: the image goes into ST's file system + the pointer into extra. Re-hydrate on success,
    // and the card is restored from extra as ready (ending the blob/data URL lifetime).
    await saveImageResult(job.messageId, job.swipeId, job.seq, job.tag, seed, result, meta);
    result.revoke();
    if (historyId !== null) safeHistory(() => finishImage(historyId!));
    // Clear runtime state before re-hydrating: re-hydration rebuilds this component, and only once cleared won't it come back still generating
    clearGen(slot, token);
    const ctx = getContext();
    if (ctx) hydrateMessage(job.messageId, ctx);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (historyId !== null) {
      safeHistory(() => failImage(historyId!, e instanceof Error ? e.message : String(e), aborted));
    }
    if (aborted) {
      clearGen(slot, token);
    } else {
      failGen(slot, token, e instanceof Error ? e.message : String(e));
    }
  }
}

function cancel(): void {
  cancelGen(key.value);
}

function openImage(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  // Read on the spot: the lightbox hangs on the plugin shadow root and **outlives this card**: any sibling slot finishing an image
  // re-hydrates and destroys this component while the lightbox is still open. Reading props in a callback would read a destroyed instance, so snapshot everything first.
  const at = { messageId: props.messageId, swipeId: props.swipeId };
  openLightbox({
    src: entry.path,
    prompt: lightboxPrompt.value,
    filename: downloadFileName(entry),
    onDelete: () => void removeEntry(entry, at),
  });
}

/**
 * Opens the prompt editor dialog. Same discipline as the lightbox: the dialog hangs on the plugin shadow root and **outlives this card**,
 * so floor coordinates and content are always snapshotted first (any sibling slot finishing an image re-hydrates and destroys this component).
 * The prompt's source of truth is the text, so write-back and the following re-hydration both happen in promptEditor.ts; this component takes no part.
 */
function openEditor(): void {
  openPromptEditor({
    at: {
      chatId: props.chatId,
      messageId: props.messageId,
      swipeId: props.swipeId,
      seq: props.seq,
      rawTag: props.tag,
    },
    content: {
      tag: props.prompt,
      nl: props.nl,
      negative: props.negative,
      characters: props.characters.map(character => ({ ...character })),
      size: props.size,
    },
    // What counts as alive: the wording promises "change the prompt back to recover it", and images deleted from the gallery can't be recovered, so they don't count
    historyCount: liveHistory.value.length,
    configured: configured.value,
  });
}

/**
 * Cancels an in-flight "AI rewrite prompt".
 *
 * The entry is in the prompt editor dialog (floor/promptEditor.ts), not on the card: editing by hand and by AI are the same thing.
 * But **the request doesn't belong to that dialog**: after the user closes the dialog the rewrite keeps running, so the card still shows progress and keeps a cancel point,
 * otherwise once the dialog closed there would only be an image quietly changing with no way to stop it. Display state reads tagPlanState; aborting relies on the runner's
 * per-floor request lock.
 */
function cancelReplan(): void {
  cancelFloorTags(props.messageId);
}

/** Deletes the result currently shown (DESIGN-FLOOR-UI.md §8.2). */function removeCurrent(): void {
  const target = shownEntry.value;
  if (!target) return;
  void removeEntry(target, { messageId: props.messageId, swipeId: props.swipeId });
}

/**
 * Deletes one result. Floor coordinates are passed in by the caller rather than read from props on the spot:
 * this function may only really run after the component is destroyed (the lightbox callback + confirm dialog are both async).
 */
async function removeEntry(
  target: BbiImageEntry,
  at: { messageId: number; swipeId: number },
): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete this picture',
    text: 'The chat history of this picture will be deleted and cannot be restored; the files in images will be deleted together, and the old pictures in files will be retained. Other historical results for the same prompt word will not be affected.',
    confirmText: 'Delete',
    tone: 'danger',
  });
  if (!ok) return;
  // Stale images are in another hash bucket, so deletion must use their own promptHash, not the current tag's
  const bucketHash = promptHash(target.prompt);
  const removed = await deleteImageResult(
    at.messageId,
    at.swipeId,
    bucketHash,
    target.generationId,
  );
  if (!removed) {
    toastr.error('Deletion failed, chat history could not be saved', 'BaiBai Image');
    return;
  }
  const ctx = getContext();
  if (ctx) hydrateMessage(at.messageId, ctx);
}

async function copyPrompt(): Promise<void> {
  await copyText(promptText.value, 'Prompt word has been copied');
}

/** Saves the image currently shown (shares download.ts with the lightbox, so the two logics can't drift apart). */
function downloadCurrent(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  saveImageFile(entry.path, downloadFileName(entry));
}

// Prompt-change reconciliation goes in watch, not onMounted: under diff hydration (hydrate.ts) a same-anchor card gets a
// props patch, not a remount, so onMounted won't run again; once the tag changes, the old prompt's task must be voided immediately.
watch(hash, current => reconcileGen(key.value, current), { immediate: true });

onMounted(() => {
  // "Generate images automatically after writing tags": this slot mounts during hydration carrying the mark → consume the mark and start generating right away.
  // **The mark is always consumed before the check**: if kept, when the same slot reappears later (e.g. the user deletes the old image) a new card would
  // claim it by mistake and start a generation the user never clicked. The check itself is extracted into the pure function shouldAutoGenerate
  // (this component has no unit tests, so it couldn't be locked down here); for the rule see floor/autoGenerate.ts.
  // Don't run when no backend is configured (the card stays pending and shows the configuration guide); the mark is consumed all the same.
  if (!props.chatId) return;
  const mode = consumeAutoGenerate(props.chatId, props.messageId, props.swipeId, props.seq);
  if (!mode) return;
  if (!shouldAutoGenerate(mode, phase.value)) return;
  if (!configured.value) return;
  void generate();
});
</script>

<template>
  <!-- Immersive design: the image is the card. No border/background panel/brand bar; controls float over the image,
       appearing on hover on desktop and always faintly visible on touch; the prompt lives in a panel opened by a floating button, taking no space normally. -->
  <div
    class="bbi-figure"
    :data-phase="phase"
    :data-capped="displayMaxHeight ? '1' : ''"
    :style="displayMaxHeight ? { '--bbi-figure-max-h': `${displayMaxHeight}px` } : undefined"
  >
    <!-- Collapsed state: shrinks to a thin bar whose only job is "placeholder + expand": clicking anywhere expands it;
         generating/error states show on the bar, but no action buttons (expand first to act). -->
    <button
      v-if="collapsed"
      class="bbi-figure__bar"
      type="button"
      title="Expand image"
      @click="collapsed = false"
    >
      <span v-if="busy || planning" class="bbi-figure__bar-spin" aria-hidden="true" />
      <Icon v-else name="generate" :size="14" class="bbi-figure__bar-icon" />
      <span class="bbi-figure__bar-text" :data-error="phase === 'error' && !busy && !planning ? '1' : ''">
        {{ barText }}
      </span>
      <span v-if="liveHistory.length > 1 && !busy" class="bbi-figure__bar-count">
        {{ liveHistory.length }} image
      </span>
      <Icon name="chevron" :size="13" class="bbi-figure__bar-chevron" />
    </button>

    <!-- Collapse container: always in the DOM (grid-template-rows 1fr→0fr transition animates the height); collapsing only
         zeroes the height + fades out, and <img> isn't unmounted, so the image is there the instant it expands, without a new request. -->
    <div class="bbi-figure__collapse" :data-collapsed="collapsed ? '1' : ''">
      <div class="bbi-figure__collapse-inner">
    <div class="bbi-figure__stage" :data-size="effectiveSize" :data-placeholder="imageSrc ? '' : '1'">
      <img
        v-if="imageSrc"
        class="bbi-figure__img"
        :src="imageSrc"
        alt="Drawing results"
        @click="openImage"
        @error="onImageError"
      />

      <!-- Generating with no image: a skeleton shimmer sweeps over the placeholder -->
      <div v-if="busy && !imageSrc" class="bbi-figure__skeleton" />

      <!-- Generating overlay: absolutely positioned over the whole stage (with an image = frosted over the old image; without = over the skeleton).
           Centred spinner + status + cancel, no longer squeezed side by side with the image as a flex child like the old version. -->
      <div v-if="busy" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">{{ statusLabel }}</span>
        <button class="bbi-figure__cancel" type="button" @click="cancel">Cancel</button>
      </div>

      <!-- Prompt rewrite overlay (AI rewrite prompt): still the same image, with only a progress-and-cancel layer on top;
           mutually exclusive with the generating overlay (replan/generate guards ensure they are never in flight together) -->
      <div v-else-if="planning" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">AI Rewrite prompt word…</span>
        <button class="bbi-figure__cancel" type="button" @click="cancelReplan">Cancel</button>
      </div>

      <!-- No image and idle: generate entry / setup guidance -->
      <div v-if="!imageSrc && !busy" class="bbi-figure__pending">
        <button v-if="configured" class="bbi-figure__generate" type="button" @click="generate">
          <Icon name="palette" :size="15" />
          {{ phase === 'error' ? 'Try again' : 'Generate pictures' }}
        </button>
        <p v-else class="bbi-figure__hint">{{ pendingHint }}</p>
      </div>

      <!-- Prompt changed: a corner badge, no longer darkening the whole image -->
      <span v-if="isStale && !busy && !planning" class="bbi-figure__badge">old prompt words</span>

      <!-- Floating action group: the ⋯ overflow button is pinned top right, always faintly visible; on desktop hover or touch tap, the menu lays out horizontally to its left
           (wrapping if the image is narrow) and collapses automatically after any action (normally the image only shows a small dot) -->
      <span v-if="!busy && !planning" class="bbi-figure__actions" :data-open="menuOpen ? '1' : ''">
        <button
          class="bbi-fab bbi-figure__more"
          type="button"
          title="More actions"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <Icon name="more" :size="15" />
        </button>
        <span class="bbi-figure__menu">
          <button
            class="bbi-fab"
            type="button"
            title="Collapse image"
            @click="menuOpen = false; collapsed = true"
          >
            <Icon name="chevron" :size="15" style="transform: rotate(180deg)" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            :disabled="!configured"
            :title="configured ? 'Redraw' : 'Please complete the configuration on the &quot;Backend&quot; page of BaiBai Image first.'"
            @click="menuOpen = false; generate()"
          >
            <Icon name="refresh" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            title="Download this image"
            @click="menuOpen = false; downloadCurrent()"
          >
            <Icon name="download" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab bbi-fab--danger"
            type="button"
            title="Delete this picture"
            @click="menuOpen = false; removeCurrent()"
          >
            <Icon name="trash" :size="15" />
          </button>
          <button
            class="bbi-fab"
            type="button"
            title="Edit prompt"
            @click="menuOpen = false; openEditor()"
          >
            <Icon name="edit" :size="15" />
          </button>
          <button
            v-if="promptText"
            class="bbi-fab"
            :class="{ 'bbi-fab--on': promptOpen }"
            type="button"
            title="View prompt"
            :aria-expanded="promptOpen"
            @click="menuOpen = false; promptOpen = !promptOpen"
          >
            <Icon name="text" :size="15" />
          </button>
        </span>
      </span>

      <!-- Pager: a pill overlaid at the image's bottom right -->
      <span v-if="pageable" class="bbi-figure__pager">
        <button class="bbi-figure__pager-btn" type="button" :disabled="index <= 0" @click="index--">◀</button>
        <span class="bbi-figure__pager-count">{{ index + 1 }}/{{ liveHistory.length }}</span>
        <button
          class="bbi-figure__pager-btn"
          type="button"
          :disabled="index >= liveHistory.length - 1"
          @click="index++"
        >
          ▶
        </button>
      </span>
    </div>

    <!-- Status line: only appears on errors / prompt changes; takes no space normally -->
    <p v-if="phase === 'error'" class="bbi-figure__status bbi-figure__status--error">
      {{ error
      }}<button v-if="configured" class="bbi-figure__retry" type="button" @click="generate">
        Try again
      </button>
    </p>
    <p v-else-if="isStale && !busy && !planning" class="bbi-figure__status bbi-figure__status--warn">
      The prompt word has been modified, and the picture above was generated by the old prompt word; click Redraw in the upper right corner and press the new prompt word to produce the picture.
    </p>
    <!-- Files deleted (usually from the gallery): records remain but the images are gone; say so plainly so it doesn't look like images vanished for no reason -->
    <p v-else-if="filesGone" class="bbi-figure__status bbi-figure__status--warn">
      The picture file has been deleted (deleted in the gallery); you can click above to regenerate it.
    </p>

    <!-- Prompt panel: opened by the floating text button; the copy button travels with the panel -->
    <div v-if="promptOpen && promptText" class="bbi-figure__prompt-box">
      <pre class="bbi-figure__prompt">{{ promptText }}</pre>
      <button class="bbi-figure__prompt-copy" type="button" title="copy prompt word" @click="copyPrompt">
        <Icon name="copy" :size="14" />
      </button>
    </div>
      </div>
    </div>
  </div>
</template>
