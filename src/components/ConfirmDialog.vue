<script setup lang="ts">
/**
 * Generic confirm dialog. Replaces the browser's native confirm(): the native dialog sits outside the Shadow DOM with inconsistent styling.
 * Controlled: visibility via v-model:open; OK emits confirm; Cancel/mask/close emit cancel.
 *
 * Teleports to modalHost (direct child of .bbi-root, outside the .bbi-body scroll container),
 * avoiding iOS's "fixed descendants misplaced inside a scrollable ancestor". The host is still inside the shadow root,
 * so scoped styles and --bbi-* variables work as usual; hence the target is an element inside the shadow, not Teleport to="body".
 */
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** OK button text */
    confirmText?: string;
    /** Cancel button text */
    cancelText?: string;
    /** OK button style: primary = main colour, danger = dangerous (subtle outline, red on hover) */
    tone?: 'primary' | 'danger';
    /** Icon name before the OK button (optional, e.g. trash) */
    confirmIcon?: string;
    /** Busy: disables the OK button and shows busyText (for async actions like "Updating…" that keep the dialog open) */
    busy?: boolean;
    /** OK button text while busy */
    busyText?: string;
    /** Stacks above other dialogs (higher z-index), e.g. a delete confirmation opened from the channel dialog */
    topLayer?: boolean;
  }>(),
  {
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    tone: 'primary',
    confirmIcon: '',
    busy: false,
    busyText: '',
    topLayer: false,
  },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

function cancel() {
  emit('update:open', false);
  emit('cancel');
}
function confirm() {
  emit('confirm');
}
</script>

<template>
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbi-modal">
      <div
        v-if="open"
        class="bbi-modal-mask"
        :class="{ 'bbi-modal-mask-top': topLayer }"
        @mousedown.self="cancel"
      >
        <div class="bbi-modal bbi-modal-confirm" role="dialog" aria-modal="true" :aria-label="title">
          <header class="bbi-modal-head">
            <span class="bbi-modal-title">{{ title }}</span>
          </header>
          <p class="bbi-confirm-text">
            <slot />
          </p>
          <footer class="bbi-modal-foot">
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="cancel">{{ cancelText }}</button>
            <button
              class="bbi-btn"
              :class="tone === 'danger' ? 'bbi-btn-danger' : 'bbi-btn-primary'"
              type="button"
              :disabled="busy"
              @click="confirm"
            >
              <Icon v-if="confirmIcon" :name="confirmIcon" />
              {{ busy && busyText ? busyText : confirmText }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Styles specific to the confirm dialog (the base .bbi-modal* styles are global in base.css). */
.bbi-modal-mask-top {
  z-index: 10002;
}
.bbi-modal-confirm {
  max-width: 380px;
}
.bbi-confirm-text {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}
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
</style>
