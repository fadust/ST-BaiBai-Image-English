<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * A combo box you can type in and pick from (combobox, same interaction as the secondary API's model box):
 * the input is both the current value and the filter; focusing pops up the candidate menu; with no candidates it degrades to a plain input.
 *
 * Why the menu teleports to modalHost instead of being absolutely positioned in place (the secondary API one is in place):
 * this component is used inside Collapsible (overflow:hidden), where in-place positioning gets clipped (BaiBai Book hit the same pitfall),
 * so it uses the same approach as BbiSelect: viewport-level fixed, computed from the input's getBoundingClientRect,
 * flipping upward when there isn't enough space below.
 *
 * Interaction: focus/typing opens; ↑↓ move the highlight, Enter selects, Esc only closes the menu (doesn't trigger the window-level Esc);
 * clicking outside (input blur)/scrolling/resizing closes. Every mousedown inside the menu calls preventDefault,
 * so clicking options/the scrollbar doesn't steal the input's focus; options are selected by click.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Candidate list; empty array = plain input (no menu, no arrow) */
    options: string[];
    placeholder?: string;
    ariaLabel?: string;
    /** Cap on displayed filter results, avoiding lag with very long lists */
    maxShown?: number;
  }>(),
  { placeholder: '', ariaLabel: undefined, maxShown: 200 },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
/** Filter text typed after focusing; cleared on focus/close (cleared = show all candidates) */
const query = ref('');
const trigger = ref<HTMLInputElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const activeIndex = ref(0);

// Filter: substring, case-insensitive; empty query shows everything
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out = q ? props.options.filter(o => o.toLowerCase().includes(q)) : props.options;
  return out.slice(0, props.maxShown);
});

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value || !props.options.length) return;
  const rect = el.getBoundingClientRect();
  // Estimate the menu height to decide direction: if below is insufficient and above has more room, flip upward
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 30 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
  activeIndex.value = Math.max(0, filtered.value.indexOf(props.modelValue));
  open.value = true;
  document.addEventListener('keydown', onDocKeydown, true);
  // The menu is viewport-level fixed and doesn't scroll with content; closing it on scroll/resize is cleaner than recomputing its position
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu() {
  if (!open.value) return;
  open.value = false;
  query.value = '';
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
}

function closeOnViewportChange() {
  closeMenu();
}

function onFocus() {
  query.value = '';
  openMenu();
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', value);
  query.value = value;
  activeIndex.value = 0;
  openMenu();
}

function pick(option: string) {
  emit('update:modelValue', option);
  closeMenu();
  // Focus stays in the input box (the menu's mousedown is prevented, so it never loses focus), handy for typing the next field
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.bbi-combo-item')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = filtered.value.length;
  if (event.key === 'Escape') {
    // Intercept in the capture phase, only closing the menu, without triggering the window-level Esc (which closes the whole panel)
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!count) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    if (!count) return;
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter') {
    const option = filtered.value[activeIndex.value];
    if (option) {
      event.preventDefault();
      pick(option);
    }
  }
}

/** In the collapsed state ↓ opens it directly (native combobox habit) */
function onTriggerKeydown(event: KeyboardEvent) {
  if (!open.value && event.key === 'ArrowDown') {
    event.preventDefault();
    openMenu();
  }
}

/** Intercept every mousedown in the menu: clicking options/dragging the scrollbar never steals the input's focus; options are selected via click */
function keepFocus() {}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <div class="bbi-combo-box">
    <input
      ref="trigger"
      class="bbi-input bbi-combo-input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
      @focus="onFocus"
      @blur="closeMenu"
      @keydown="onTriggerKeydown"
    />
    <!-- Dropdown arrow (decorative): only shown when there are candidates; pointer-events:none → clicks pass through to focus and open as usual -->
    <Icon
      v-if="options.length"
      name="chevron"
      class="bbi-combo-caret"
      :class="{ 'is-open': open }"
      :size="12"
    />
    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul
        v-if="open"
        ref="menu"
        class="bbi-combo-menu"
        role="listbox"
        :style="menuStyle"
        @mousedown.prevent="keepFocus"
      >
        <li v-if="!filtered.length" class="bbi-combo-empty">No match</li>
        <li
          v-for="(option, i) in filtered"
          :key="option"
          class="bbi-combo-item"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option === modelValue }"
          role="option"
          :aria-selected="option === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          {{ option }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbi-combo-box {
  position: relative;
  width: 100%;
  min-width: 0;
}
.bbi-combo-input {
  width: 100%;
  padding-right: 26px; /* Make room for the arrow on the right */
}
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 9px;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--bbi-ink-soft);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}

/* The menu teleports to modalHost (scoped styles still apply within the same shadow root) */
.bbi-combo-menu {
  position: fixed;
  z-index: 10001; /* Above the window (10000), same level as the BbiSelect menu */
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-combo-item.is-active {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-selected {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
</style>
