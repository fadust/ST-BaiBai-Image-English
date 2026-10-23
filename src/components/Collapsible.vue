<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Title text. May be empty when the #header slot is used. */
    title?: string;
    /** Whether it starts expanded */
    open?: boolean;
  }>(),
  { title: '', open: true },
);

const expanded = ref(props.open);

// Height transition via grid-template-rows 0fr<->1fr: no scrollHeight measuring needed, content sizes itself.
</script>

<template>
  <section class="bbi-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbi-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <!-- Holds only the title text by default; override with the #header slot to put badges/meta in the title row
           (do not put buttons or other interactive elements in the slot: the whole header is itself a button). -->
      <slot name="header">
        <span class="bbi-collapsible-title">{{ title }}</span>
      </slot>
      <Icon name="chevron" class="bbi-collapsible-chevron" />
    </button>
    <div class="bbi-collapsible-outer">
      <div class="bbi-collapsible-inner">
        <div class="bbi-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbi-collapsible {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
}

.bbi-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink);
  cursor: pointer;
  font-family: var(--bbi-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible-head:hover {
  background: var(--bbi-surface-2);
}
.bbi-collapsible-head:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}

.bbi-collapsible-chevron {
  font-size: 18px;
  color: var(--bbi-ink-muted);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
/* Restricted with the direct-child > combinator: with nested Collapsibles, an outer .is-open must not reach the inner outer/chevron,
   or the inner one gets pinned open by the outer one and can never collapse. */
.bbi-collapsible.is-open > .bbi-collapsible-head .bbi-collapsible-chevron {
  transform: rotate(180deg);
}

/* Height transition: grid 0fr -> 1fr */
.bbi-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.bbi-collapsible.is-open > .bbi-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbi-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbi-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--bbi-line);
}

/* Mobile: collapsible titles one size smaller, matching the overall rhythm of narrow screens */
@media (max-width: 640px) {
  .bbi-collapsible-head {
    font-size: 13px;
  }
}
</style>
