<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import { searchNames, searchState, splitNames, stripTagList } from '@/batch/search';
import { getContext, type STContext } from '@/st/context';
import { settings } from '@/state/settings';
import { closePanel } from '@/state/ui';
import { openPassageGenFor } from '@/rewriteHint/floorPassageGen';
const together = ref(false);
const expanded = ref<Record<string, boolean>>({});
const chatId = ref(getContext()?.getCurrentChatId() ?? '');
const resultChat = ref(chatId.value);
const rows = computed(() => together.value && searchState.names.length > 1
  ? [{ name: 'All selected characters', floors: searchState.result?.together ?? [] }]
  : searchState.result?.rows ?? []);
function search() {
  const context = getContext();
  searchState.names = splitNames(searchState.query);
  searchState.result = searchNames(context?.chat ?? [], searchState.names, { withUser: searchState.withUser, stripTags: stripTagList(settings.excludes.customStripTags) });
  resultChat.value = context?.getCurrentChatId() ?? '';
  expanded.value = {};
}
function current() {
  if ((getContext()?.getCurrentChatId() ?? '') === resultChat.value) return true;
  search(); toastr.info('The chat changed. Search results have been refreshed.', 'BaiBai Image'); return false;
}
async function jump(floor: number) {
  if (!current()) return;
  const context = getContext() as (STContext & { executeSlashCommandsWithOptions?: (text: string) => Promise<unknown> }) | null;
  if (!context?.executeSlashCommandsWithOptions) { toastr.warning('This SillyTavern version does not support jumping to messages.', 'BaiBai Image'); return; }
  closePanel();
  try { await context.executeSlashCommandsWithOptions(`/chat-jump ${floor}`); }
  catch { toastr.warning(`Could not jump to message ${floor}.`, 'BaiBai Image'); }
}
function illustrate(floor: number) { if (current()) openPassageGenFor(floor); }
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  if (searchState.names.length) search();
  timer = setInterval(() => { const next = getContext()?.getCurrentChatId() ?? ''; if (next !== chatId.value) { chatId.value = next; if (searchState.names.length) search(); } }, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="bbi-page">
    <h2 class="bbi-title bbi-title-sub">Character Search</h2>
    <p>Find where characters appear in this chat, then jump to a message or choose a scene to illustrate.</p>
    <label>Character names<BbiTextarea v-model="searchState.query" :rows="2" :max-rows="5" placeholder="Mary Jane, Peter Parker — separate names with commas or newlines" /></label>
    <p class="bbi-field-hint">Searches names in story text, ignoring case. Thinking sections, comments, image prompts, and your cleanup tags are excluded.</p>
    <label class="bbi-switch-row"><span>Include user messages</span><input v-model="searchState.withUser" type="checkbox" @change="searchState.result && search()" /></label>
    <label class="bbi-switch-row"><span>Only messages containing every name</span><input v-model="together" type="checkbox" /></label>
    <button class="bbi-btn bbi-btn-primary" :disabled="!searchState.query.trim()" @click="search">Search chat</button>
    <section v-for="row in rows" :key="row.name" class="bbi-search-result">
      <h3>{{ row.name }} · {{ row.floors.length }} {{ row.floors.length === 1 ? 'message' : 'messages' }}</h3>
      <p v-if="!row.floors.length">No matches in the story text.</p>
      <div class="bbi-search-hits">
        <span v-for="floor in (expanded[row.name] ? row.floors : row.floors.slice(0, 12))" :key="floor" class="bbi-search-hit">
          <button class="bbi-btn bbi-btn-sm" :title="`Jump to message ${floor}`" @click="jump(floor)">#{{ floor }}</button>
          <button v-if="!getContext()?.chat?.[floor]?.is_user" class="bbi-btn bbi-btn-sm" :title="`Choose scenes from message ${floor}`" @click="illustrate(floor)">Illustrate…</button>
        </span>
      </div>
      <button v-if="row.floors.length > 12" class="bbi-btn bbi-btn-sm" @click="expanded[row.name] = !expanded[row.name]">{{ expanded[row.name] ? 'Show fewer' : 'Show all matches' }}</button>
    </section>
  </section>
</template>
<style scoped>
.bbi-search-result { border-top:1px solid color-mix(in srgb,currentColor 15%,transparent); padding:12px 0; }
.bbi-search-hits { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
.bbi-search-hit { display:inline-flex; gap:3px; }
</style>
