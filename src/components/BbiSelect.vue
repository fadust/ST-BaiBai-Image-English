<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * Custom-drawn dropdown select (replacing the native <select>): both the trigger and the popup menu follow the --bbi-* theme,
 * options can carry icons; pairs with the settings page's bbi-select-row layout.
 *
 * Why the menu teleports to modalHost instead of being absolutely positioned in place:
 * settings items sit inside Collapsible (overflow:hidden) and the .bbi-body scroll container, where in-place positioning gets clipped
 * (BaiBai Book hit the same pitfall). modalHost is a direct child of .bbi-root; the menu uses viewport-level fixed positioning,
 * computed from the trigger's getBoundingClientRect, flipping upward when there isn't enough space below.
 * The window element normally has no transform (only temporarily while dragging the drawer on mobile), so fixed is relative to the viewport.
 *
 * Interaction: clicking outside / Esc / scrolling / resizing closes; ↑↓ move the highlight, Enter/Space select, Home/End jump to the ends.
 */
const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string }[];
  /** Accessible name (the row title is a plain-text span with no label association to the control; this fills that gap) */
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
/** Index of the keyboard/hover-highlighted item */
const activeIndex = ref(0);

const current = computed(() => props.options.find(o => o.value === props.modelValue) ?? null);

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value) return;
  const rect = el.getBoundingClientRect();
  // Estimate the menu height to decide direction: if below is insufficient and above has more room, flip upward
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 34 + 10);
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
  activeIndex.value = Math.max(
    0,
    props.options.findIndex(o => o.value === props.modelValue),
  );
  open.value = true;
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('keydown', onDocKeydown, true);
  // The menu is viewport-level fixed and doesn't scroll with content; closing it on scroll/resize is cleaner than recomputing its position.
  // (The menu is at most 240px tall with only a few options, so it almost never scrolls internally; scrolling inside the menu isn't excluded.)
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('mousedown', onDocMousedown, true);
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
  if (restoreFocus) trigger.value?.focus();
}

function closeOnViewportChange() {
  closeMenu();
}

function toggle() {
  if (open.value) closeMenu(true);
  else openMenu();
}

function pick(option: { value: string }) {
  emit('update:modelValue', option.value);
  closeMenu(true);
}

function onDocMousedown(event: MouseEvent) {
  // composedPath crosses the shadow root; clicks on the trigger or inside the menu don't count as outside
  const path = event.composedPath();
  if (trigger.value && path.includes(trigger.value)) return;
  if (menu.value && path.includes(menu.value)) return;
  closeMenu();
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.bbi-select-option')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = props.options.length;
  if (event.key === 'Escape') {
    // Intercept in the capture phase, only closing the menu, without triggering the window-level Esc (which closes the whole panel)
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) pick(option);
  }
}

/** Native select habit: in the collapsed state ↑/↓ opens it directly */
function onTriggerKeydown(event: KeyboardEvent) {
  if (open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu();
  }
}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <!-- The root class can't be bbi-select: that class in base.css styles native <select> elements,
       with a background-image arrow + padding-right; a clash would draw an extra arrow to the right of the trigger -->
  <div class="bbi-select-box">
    <button
      ref="trigger"
      class="bbi-select-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="bbi-select-current">
        <Icon v-if="current?.icon" :name="current.icon" :size="14" />
        <span class="bbi-select-label">{{ current?.label ?? modelValue }}</span>
      </span>
      <Icon name="chevron" class="bbi-select-caret" :class="{ 'is-open': open }" :size="12" />
    </button>

    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul v-if="open" ref="menu" class="bbi-select-menu" role="listbox" :style="menuStyle">
        <li
          v-for="(option, i) in options"
          :key="option.value"
          class="bbi-select-option"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          <Icon v-if="option.icon" :name="option.icon" :size="14" />
          <span class="bbi-select-option-label">{{ option.label }}</span>
          <Icon
            v-if="option.value === modelValue"
            name="check"
            class="bbi-select-check"
            :size="13"
          />
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbi-select-box {
  width: 180px;
  flex: none;
}
.bbi-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-select-trigger:hover {
  background: var(--bbi-surface-2);
}
.bbi-select-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 1px;
}
.bbi-select-current {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bbi-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-select-caret {
  flex: none;
  color: var(--bbi-ink-soft);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-select-caret.is-open {
  transform: rotate(180deg);
}

/* The menu teleports to modalHost (scoped styles still apply within the same shadow root) */
.bbi-select-menu {
  position: fixed;
  /* 10003: above the ordinary dialog mask (10001) and the overlay mask (10002).
     This component is now also used inside dialogs ("Reasoning effort" in the channel dialog), so the menu and a mask can coexist;
     at the same level "last inserted wins" might happen to cover it, but -top masks such as delete confirmations (10002) would press over the menu,
     so it is raised explicitly rather than relying on insertion order. */
  z-index: 10003;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  box-shadow: var(--bbi-shadow);
}
.bbi-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--bbi-radius-sm);
  font-size: 13px;
  color: var(--bbi-ink);
  cursor: pointer;
}
.bbi-select-option.is-active {
  background: var(--bbi-surface-2);
}
.bbi-select-option.is-selected {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-select-check {
  flex: none;
  color: var(--bbi-accent);
}
</style>
