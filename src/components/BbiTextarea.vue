<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';

/**
 * Auto-height textarea (one line by default, growing with content, scrolling internally once capped).
 *
 * Why a component: pages previously assembled "textarea + v-autosize directive + their own max-height class" ad hoc,
 * with inconsistent rules and gaps in each. The component unifies it:
 * - line rules: props.rows is the starting line count, maxRows the cap, converted to pixels via lineHeight,
 *   so callers no longer write max-height themselves.
 * - v-model follows Vue's native textarea behaviour, using compositionstart/end to hold back IME composition strings,
 *   which the directive version (v-autosize) lacked.
 * - a ResizeObserver re-measures after its own width changes (window resize/drawer drag);
 *   BaiBai Book's height not shrinking after manually widening a narrow window was exactly this omission.
 * - focus()/insertAtCursor() are exposed to callers (macro insertion in the prompt dialog relies on caret operations).
 *
 * Height measurement follows the directive version: set height to zero first, then read scrollHeight (zeroing is required,
 * otherwise scrollHeight won't shrink when content is reduced), and clamp to [min,max] when writing back.
 * Both mount and update wait one frame before measuring, avoiding reading a collapsing layout while an edit refills.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Starting line count (height when empty) */
    rows?: number;
    /** Maximum line count; a scrollbar appears beyond it. Default 12 */
    maxRows?: number;
    /** Monospace font (for workflow JSON / tag strings) */
    mono?: boolean;
    /** Placeholder */
    placeholder?: string;
    /** Disable spell checking (off by default for tags/JSON; can be on for prose descriptions) */
    spellcheck?: boolean;
  }>(),
  { rows: 1, maxRows: 12, mono: false, placeholder: '', spellcheck: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

// Pass through class/style (merged onto the root textarea, keeping existing utility classes such as .bbi-input working)
const attrs = useAttrs();

const el = ref<HTMLTextAreaElement | null>(null);
/** Pixel height of one line: measured once after mount; the basis for converting lines → pixels */
let lineHeightPx = 21;

const composing = ref(false);
function onInput(event: Event) {
  if (composing.value) return;
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
function onCompositionStart() {
  composing.value = true;
}
function onCompositionEnd(event: CompositionEvent) {
  composing.value = false;
  // For browsers that don't fire input in this case: write back the final value once when composition ends
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

function measure(): void {
  const node = el.value;
  if (!node) return;
  node.style.height = 'auto';
  // scrollHeight only includes content + top/bottom padding; with box-sizing:border-box the borders must be added for the total height
  const content = node.scrollHeight;
  const style = window.getComputedStyle(node);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const min = lineHeightPx * props.rows;
  const max = lineHeightPx * props.maxRows;
  node.style.height = `${Math.max(min, Math.min(max, content + border))}px`;
  node.style.overflowY = content + border > max ? 'auto' : 'hidden';
}

let ro: ResizeObserver | null = null;

function setup() {
  const node = el.value;
  if (!node) return;
  const style = window.getComputedStyle(node);
  lineHeightPx = parseFloat(style.lineHeight) || 21;
  ro?.disconnect();
  ro = new ResizeObserver(() => measure());
  // Observe itself: height must reflow when the width changes (drag/resize)
  ro.observe(node);
  requestAnimationFrame(() => measure());
}

defineExpose({
  /** Focus */
  focus() {
    el.value?.focus();
  },
  /**
   * Inserts text at the cursor and selects it; appends to the end when unfocused.
   * Used by macro buttons: returns the cursor position after insertion; callers move the cursor themselves if needed.
   */
  insertAtCursor(text: string): void {
    const node = el.value;
    if (!node) {
      emit('update:modelValue', props.modelValue + text);
      return;
    }
    const start = node.selectionStart ?? props.modelValue.length;
    const end = node.selectionEnd ?? start;
    const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end);
    emit('update:modelValue', next);
    void nextTick(() => {
      node.focus();
      const pos = start + text.length;
      node.setSelectionRange(pos, pos);
    });
  },
});

onMounted(setup);
// When rows/maxRows change the bounds change, so clamp the height again (template editing and similar cases change them dynamically)
watch(() => [props.rows, props.maxRows], () => requestAnimationFrame(() => measure()));
// Programmatic value changes (the dialog refilling a draft/restoring defaults) don't fire the input event, so measure here too (measuring twice on the input path is harmless)
watch(
  () => props.modelValue,
  () => requestAnimationFrame(() => measure()),
);

onBeforeUnmount(() => ro?.disconnect());

defineOptions({ inheritAttrs: false });
</script>

<template>
  <textarea
    ref="el"
    class="bbi-textarea"
    :class="{ 'is-mono': mono }"
    v-bind="attrs"
    :value="modelValue"
    :placeholder="placeholder"
    :spellcheck="spellcheck"
    :rows="rows"
    @input="onInput"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  ></textarea>
</template>

<style scoped>
.bbi-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  display: block;
  resize: none;
  overflow-y: hidden;
}
.bbi-textarea.is-mono {
  font-family: var(--bbi-font-mono);
  font-variant-ligatures: none;
}
.bbi-textarea:focus {
  outline: none;
  border-color: var(--bbi-accent);
}
.bbi-textarea::placeholder {
  color: var(--bbi-ink-muted);
}
.bbi-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
