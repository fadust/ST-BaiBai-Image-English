<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from '@/components/Icon.vue';
import { saveImageFile } from '@/floor/download';
import { copyText } from '@/st/clipboard';
import { modalHost } from '@/state/ui';

/**
 * Image lightbox (floor card click to enlarge).
 *
 * Why our own instead of ST's native one: ST's lightbox entry `.mes_img` is just a class; the real
 * expandMessageMedia reads the `chat[mesid].extra.media[data-index]` data model, and that function is
 * module-private and not exported to context, so just adding the class bails out. Taking the official extra.media route would give us
 * the lightbox for free, but the image would be attached to `.mes_media_wrapper` (a sibling of .mes_text), leaving the tag's inline position,
 * which conflicts with the core design "the image appears in the tag's paragraph", and would need another store parallel to extra.bbiImage.
 *
 * [Long-press to save] Long-press saving on mobile is guaranteed by three constraints together; keep them when making changes:
 * 1. Only click is listened for; never preventDefault touchstart/touchend on the image. When a long press brings up the system menu
 *    the browser doesn't follow up with a click, so the two never conflict; intercepting touch ourselves breaks long-press saving immediately.
 * 2. The image gets no user-select:none / -webkit-touch-callout:none / draggable=false.
 * 3. An explicit touch-action:auto counteracts ST's `body{touch-action:none}`
 *    (css/mobile-styles.css:251, global on mobile ≤1000px), which interferes with some engines' long-press detection.
 * [Two-step zoom and panning] Clicking the image toggles between "fit to screen ↔ original size" (zoomed = 1:1 to inspect
 * details such as faces/hands and decide whether to keep or redraw). Panning when zoomed has two paths:
 * - desktop: mouse drag (pointer events only for pointerType==='mouse'; a 5px threshold tells click from drag);
 * - mobile: the stage's native overflow scrolling, **with no touch event listeners** (see the three constraints above).
 * The stage centres with margin:auto on the image, not justify-content:center: the latter pushes the zoomed image's
 * left/top overflow out of the scrollable area (the culprit behind "can only scroll up and down" on mobile).
 */

const props = defineProps<{
  src: string;
  /** Raw prompt text (for copying); no copy button if empty. */
  prompt?: string;
  /** Download file name. */
  filename?: string;
  /** The delete button only shows when this has a value. */
  deletable?: boolean;
}>();

const emit = defineEmits<{ close: []; delete: [] }>();

/** Fit to screen ↔ original size. */
const zoomed = ref(false);

/** Scroll container (for panning when zoomed). */
const stage = ref<HTMLElement | null>(null);

/** The click right after a drag-pan must be swallowed, or the image would shrink back as soon as the drag ends. */
let suppressClick = false;

/** Click toggles zoom; when zooming in, scrolls the clicked point to the viewport centre (look where you click). */
async function onImageClick(event: MouseEvent): Promise<void> {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (zoomed.value) {
    zoomed.value = false;
    return;
  }
  const img = event.currentTarget as HTMLImageElement;
  const rect = img.getBoundingClientRect();
  const ratioX = (event.clientX - rect.left) / rect.width;
  const ratioY = (event.clientY - rect.top) / rect.height;
  zoomed.value = true;
  await nextTick();
  const el = stage.value;
  if (el) {
    el.scrollLeft = img.offsetWidth * ratioX - el.clientWidth / 2;
    el.scrollTop = img.offsetHeight * ratioY - el.clientHeight / 2;
  }
}

/**
 * Mouse drag panning (zoomed state only, mouse only).
 * Touch is left alone: touch panning is handled by the stage's native overflow scrolling (touch-action:auto on the img is
 * reserved for that and for long-press saving); intercepting touch ourselves would violate the three long-press constraints at the top.
 */
let pan: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (!zoomed.value || event.pointerType !== 'mouse' || event.button !== 0) return;
  const el = stage.value;
  if (!el) return;
  pan = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const el = stage.value;
  if (!pan || !el) return;
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 5) return; // Within the threshold it's a click; keep click-to-zoom
  pan.moved = true;
  el.scrollLeft = pan.left - dx;
  el.scrollTop = pan.top - dy;
}

function onPointerUp(): void {
  if (pan?.moved) suppressClick = true;
  pan = null;
}

/** When panning while zoomed, block the image's native drag ghost; outside zoom keep native behaviour untouched. */
function onDragStart(event: DragEvent): void {
  if (zoomed.value) event.preventDefault();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => {
  // Capture phase: grab Esc before ST's global shortcuts
  document.addEventListener('keydown', onKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});

async function copyPrompt(): Promise<void> {
  await copyText(props.prompt ?? '', 'Prompt word has been copied');
}

function save(): void {
  saveImageFile(props.src, props.filename);
}

const promptText = computed(() => (props.prompt ?? '').trim());
</script>

<template>
  <!-- Teleports to modalHost (direct child of .bbi-root): the lightbox needs the --bbi-* theme variables,
       while lightbox.ts's container hangs at the top of the shadow root, outside .bbi-root, where the variables are unavailable.
       Same technique as ConfirmDialog. -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <!-- The mask itself handles close clicks; the image and toolbar stop propagation to avoid closing by mistake -->
    <div class="bbi-lightbox" @click="emit('close')">
      <div class="bbi-lightbox__bar" @click.stop>
        <button class="bbi-lb-btn" type="button" title="save image" @click="save">
          <Icon name="download" :size="18" />
        </button>
        <button
          v-if="promptText"
          class="bbi-lb-btn"
          type="button"
          title="copy prompt word"
          @click="copyPrompt"
        >
          <Icon name="copy" :size="18" />
        </button>
        <button
          v-if="deletable"
          class="bbi-lb-btn bbi-lb-btn--danger"
          type="button"
          title="Delete this picture"
          @click="emit('delete')"
        >
          <Icon name="trash" :size="18" />
        </button>
        <button class="bbi-lb-btn" type="button" title="Close (Esc)" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </div>

      <!-- Image container: scrolls when zoomed (touch) / mouse drag to view the original -->
      <div
        ref="stage"
        class="bbi-lightbox__stage"
        :data-zoomed="zoomed ? '1' : ''"
        @click.stop="emit('close')"
      >
        <img
          class="bbi-lightbox__img"
          :src="src"
          alt="Drawing results"
          :data-zoomed="zoomed ? '1' : ''"
          @click.stop="onImageClick"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dragstart="onDragStart"
        />
      </div>

      <p v-if="promptText" class="bbi-lightbox__prompt" @click.stop>{{ promptText }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.bbi-lightbox {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  /* Same as the mask in base.css: some mobile WebViews don't handle inset/percentage chains, so the viewport height is given explicitly */
  height: 100vh;
  height: 100dvh;
  z-index: 10050;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: oklch(0 0 0 / 0.82);
  backdrop-filter: blur(6px);
}

.bbi-lightbox__bar {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.bbi-lb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid oklch(1 0 0 / 0.18);
  border-radius: var(--bbi-radius-pill);
  background: oklch(1 0 0 / 0.1);
  color: oklch(1 0 0 / 0.92);
  cursor: pointer;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}

.bbi-lb-btn:hover {
  background: oklch(1 0 0 / 0.2);
  border-color: oklch(1 0 0 / 0.4);
}

.bbi-lb-btn--danger:hover {
  background: var(--bbi-danger);
  border-color: var(--bbi-danger);
  color: #fff;
}

/* Centring doesn't use justify-content/align-items:center: when the zoomed image is wider than the container, flex centring
   pushes the left/top overflow out of the scrollable area (the culprit behind "can only scroll up and down" on mobile).
   The image's own margin:auto is used instead: centred when small; when large the auto margins collapse to zero and it aligns at the start, scrollable in all four directions. */
.bbi-lightbox__stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: auto;
}

.bbi-lightbox__img {
  display: block;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--bbi-radius-sm);
  cursor: zoom-in;
  /* Counteracts ST's body{touch-action:none} (css/mobile-styles.css:251):
     it interferes with some engines' long-press save detection and also blocks native touch scrolling when zoomed. See the comment at the top of <script>. */
  touch-action: auto;
}

/* Original size: the overflow is viewed by __stage scrolling (touch) / mouse drag */
.bbi-lightbox__img[data-zoomed='1'] {
  max-width: none;
  max-height: none;
  cursor: grab;
}

.bbi-lightbox__img[data-zoomed='1']:active {
  cursor: grabbing;
}

/* Bring back a thin scrollbar when zoomed (base.css hides scrollbars globally inside .bbi-root),
   giving a sense of "where am I now" */
.bbi-lightbox__stage[data-zoomed='1'] {
  scrollbar-width: thin;
  scrollbar-color: oklch(1 0 0 / 0.3) transparent;
}

.bbi-lightbox__stage[data-zoomed='1']::-webkit-scrollbar {
  width: 6px;
  height: 6px;
  display: block;
}

.bbi-lightbox__stage[data-zoomed='1']::-webkit-scrollbar-thumb {
  background: oklch(1 0 0 / 0.25);
  border-radius: 3px;
}

.bbi-lightbox__prompt {
  flex: 0 0 auto;
  max-height: 22%;
  overflow-y: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--bbi-radius-sm);
  background: oklch(1 0 0 / 0.08);
  color: oklch(1 0 0 / 0.85);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  /* The prompt must be selectable for copying, so selection isn't disabled here */
  user-select: text;
}
</style>
