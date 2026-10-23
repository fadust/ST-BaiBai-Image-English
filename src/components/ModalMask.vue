<script setup lang="ts">
/**
 * Dialog mask shell: hosts the .bbi-modal-mask layer for every page's dialogs + closing on mask click.
 *
 * Teleports to modalHost (direct child of .bbi-root, outside the .bbi-body scroll container),
 * fixing an old iOS Safari problem: "position:fixed descendants inside a scrollable ancestor" are positioned relative to the scrolled content
 * instead of the viewport, so after scrolling the settings page dialogs shifted up and off screen (the channel dialog exposed it first).
 * The host is still inside the shadow root, so scoped styles and --bbi-* theme variables work as usual;
 * hence the target is an element inside the shadow, not a Teleport to="body" that would escape it.
 *
 * Content is passed via <slot>, keeping scoped data-v markers, so each page dialog's own class styles are unaffected by Teleport.
 *
 * Visibility uses the open prop (rather than callers writing v-if on <ModalMask>): the Transition container must stay mounted and toggle the dialog
 * with an inner v-if for the leave animation to play (otherwise the component unmounts with the parent's v-if before leave can fire).
 * Slots are lazy functions; when open=false <slot/> is never reached or evaluated, so a slot referencing objects that become null after closing
 * (editingChannel.name etc.) won't throw; no guards are needed at each call site.
 */
import { modalHost } from '@/state/ui';

defineProps<{
  /** Whether the dialog is shown */
  open?: boolean;
  /** Stacks above other dialogs (higher z-index), e.g. a delete confirmation opened from the channel dialog */
  topLayer?: boolean;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <!-- Fallback: render in place when modalHost isn't ready, so a dialog is never lost -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbi-modal">
      <div
        v-if="open"
        class="bbi-modal-mask"
        :class="{ 'bbi-modal-mask-top': topLayer }"
        @mousedown.self="emit('close')"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Overlay layer: covers ordinary dialogs (same level as ConfirmDialog's -top) */
.bbi-modal-mask-top {
  z-index: 10002;
}
</style>
