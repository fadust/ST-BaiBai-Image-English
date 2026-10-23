<script setup lang="ts">
import { computed, ref } from 'vue';

import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  clearHistory,
  records,
  roughTokens,
  type HistoryRecord,
  type LlmRecord,
} from '@/state/history';
import { copyText } from '@/st/clipboard';

/**
 * Request history page.
 *
 * The call funnels for secondary API inference and image generation (api/client.ts, floor/Card.vue) write the process into
 * state/history.ts; this page only displays it. **Memory only, cleared on reload**: it is meant as a debugging aid,
 * not an asset, so it is neither saved nor exportable.
 *
 * Structure: one request = one collapsible section; expanded, it holds a read-only list of "one prompt segment = one row"
 * (same look as "Custom prompts" on the settings page); click a row to see the full text in a dialog.
 */

type Filter = 'all' | 'llm' | 'image';

/** One segment in the expanded list: for the secondary API each message + the response; for image generation each prompt segment. */
interface Segment {
  /** Leading label: system / user / assistant / response / positive prompt … */
  label: string;
  text: string;
}

const filter = ref<Filter>('all');
/** The segment currently viewed in the dialog (null = closed). */
const viewing = ref<{ title: string; segment: Segment } | null>(null);

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'llm', label: 'Auxiliary API' },
  { value: 'image', label: 'Image Generation' },
];

const shown = computed(() =>
  filter.value === 'all' ? records : records.filter(r => r.kind === filter.value),
);

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function duration(ms: number | null): string {
  if (ms === null) return 'In progress';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(record: HistoryRecord): string {
  if (record.status === 'running') return 'In progress';
  if (record.status === 'ok') return 'Success';
  if (record.status === 'aborted') return 'Cancelled';
  return 'Failed';
}

function title(record: HistoryRecord): string {
  return record.kind === 'llm' ? record.source : `No. ${record.floor} Floor · No. ${record.seq + 1} image`;
}

function subtitle(record: HistoryRecord): string {
  if (record.kind === 'llm') {
    return [record.channelName, record.model].filter(Boolean).join(' · ');
  }
  return [record.backend === 'nai' ? 'NAI' : 'ComfyUI', record.model].filter(Boolean).join(' · ');
}

/**
 * Token count display. Estimates get an ≈ prefix: the estimate uses the tokenizer of ST's current main model,
 * which may not match the secondary API channel's model, so it can't be shown mixed with the real usage returned upstream.
 */
function tokenLabel(record: LlmRecord): string {
  if (record.promptTokens === null) return '';
  return `${record.tokensEstimated ? '≈' : ''}${record.promptTokens.toLocaleString()}`;
}

function tokenTitle(record: LlmRecord): string {
  return record.tokensEstimated
    ? 'Local estimation: The word segmenter of the current model of the ST main interface is used, which may not be consistent with the model of this channel and is for reference only.'
    : 'Real usage returned by upstream (usage)';
}

/** Spreads one record into "several segments in order"; the expanded area renders in exactly this order. */
function segments(record: HistoryRecord): Segment[] {
  if (record.kind === 'llm') {
    const out: Segment[] = record.messages.map(m => ({ label: m.role, text: m.content }));
    if (record.response) out.push({ label: 'Return', text: record.response });
    return out;
  }
  const out: Segment[] = [{ label: 'positive cue words', text: record.prompt }];
  if (record.nl) out.push({ label: 'Natural Language', text: record.nl });
  for (const character of record.characters ?? []) {
    out.push({
      label: `Role: ${character.name}`,
      text: [character.tag, character.nl].filter(Boolean).join('\n\n'),
    });
  }
  if (record.negative) out.push({ label: 'Negative', text: record.negative });
  return out;
}

/** Inline preview: newlines squeezed out; long ones are truncated by a CSS ellipsis. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The row of fact tags at the top of the expanded area. */
function facts(record: HistoryRecord): string[] {
  const out = [subtitle(record), duration(record.durationMs), new Date(record.startedAt).toLocaleString()];
  if (record.kind === 'llm') {
    if (record.stream) out.push('Stream');
    // The number on the title row is prompt tokens (the title row is cramped, so no unit); the full rule is given here.
    if (record.promptTokens !== null) out.push(`prompt word ${tokenLabel(record)} token`);
    if (record.completionTokens !== null) {
      out.push(`output ${record.tokensEstimated ? '≈' : ''}${record.completionTokens.toLocaleString()} token`);
    }
  } else {
    out.push(`seeds ${record.seed}`, record.size);
  }
  return out.filter(Boolean);
}

/** Copies the whole record as text, handy for pasting elsewhere when troubleshooting. */
function copyAll(record: HistoryRecord): void {
  const head = [
    `[${title(record)}] ${subtitle(record)}`,
    `Status: ${statusLabel(record)}  Duration: ${duration(record.durationMs)}`,
    record.kind === 'llm' && record.promptTokens !== null
      ? `Prompt tokens: ${tokenLabel(record)}`
      : '',
    record.error ? `Error: ${record.error}` : '',
  ].filter(Boolean);
  const body = segments(record).map(s => `--- ${s.label} ---\n${s.text}`);
  void copyText([...head, '', ...body].join('\n'), 'Record copied');
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Request History</h2>
      <span class="bbi-count" title="Number of requests recorded for this session">{{ records.length }}</span>
    </div>
    <hr class="bbi-rule" />

    <div class="bbi-hist-bar">
      <div class="bbi-segmented-wrap">
        <div class="bbi-segmented" role="tablist" aria-label="record type">
          <button
            v-for="f in FILTERS"
            :key="f.value"
            class="bbi-seg"
            :class="{ 'is-on': filter === f.value }"
            type="button"
            role="tab"
            :aria-selected="filter === f.value"
            @click="filter = f.value"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <button
        class="bbi-btn bbi-btn-danger bbi-btn-sm"
        type="button"
        :disabled="!records.length"
        @click="clearHistory"
      >
        <Icon name="trash" /> Clear
      </button>
    </div>

    <!-- One request = one collapsible section -->
    <div v-if="shown.length" class="bbi-sections">
      <Collapsible v-for="record in shown" :key="record.id" :open="false">
        <template #header>
          <span class="bbi-hist-head">
            <span class="bbi-hist-name">{{ title(record) }}</span>
            <span class="bbi-hist-sub">{{ subtitle(record) }}</span>
            <span
              v-if="record.kind === 'llm' && tokenLabel(record)"
              class="bbi-hist-tok"
              :class="{ 'is-est': record.tokensEstimated }"
              :title="tokenTitle(record)"
            >
              {{ tokenLabel(record) }}
            </span>
            <span class="bbi-hist-time">{{ time(record.startedAt) }}</span>
            <span class="bbi-prompt-state" :class="`is-${record.status}`">{{ statusLabel(record) }}</span>
          </span>
        </template>

        <div class="bbi-hist-facts">
          <span v-for="(f, i) in facts(record)" :key="i" class="bbi-hist-fact">{{ f }}</span>
        </div>

        <p v-if="record.error" class="bbi-hist-error">{{ record.error }}</p>

        <p
          v-if="record.kind === 'llm' && record.tokensEstimated && record.promptTokens !== null"
          class="bbi-field-hint"
        >
          The token number with ≈ is a local estimate: streaming and &quot;follow the main API&quot; cannot get the upstream usage.
          This is estimated using the word segmenter of the current model of the ST main interface, which may not be consistent with the model of this channel.
        </p>

        <!-- Prompt list in order: same row style as "Custom prompts" on the settings page -->
        <ul class="bbi-prompt-list">
          <li v-for="(seg, i) in segments(record)" :key="i">
            <button
              class="bbi-prompt-open"
              type="button"
              @click="viewing = { title: `${title(record)} · ${seg.label}`, segment: seg }"
            >
              <span class="bbi-prompt-role">{{ seg.label }}</span>
              <span class="bbi-prompt-preview">{{ inline(seg.text) }}</span>
              <span
                class="bbi-prompt-len"
                title="Rough estimate of token for this paragraph (local estimate by character, only for comparison between paragraphs, different from the actual usage caliber of the title line)"
              >≈{{ roughTokens(seg.text).toLocaleString() }}</span>
              <Icon name="eye" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>

        <div class="bbi-hist-foot">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="copyAll(record)">
            <Icon name="copy" /> Copy entire
          </button>
        </div>
      </Collapsible>
    </div>
    <p v-else-if="records.length" class="bbi-field-hint">There are no records under the current filter.</p>
    <p v-else class="bbi-field-hint">
      No records have been requested for this session. Trigger an automatic tag or generate a picture, and entries will appear here (refreshing the page will clear them).
    </p>

    <!-- ===== Single-segment full-text dialog ===== -->
    <ModalMask :open="!!viewing" @close="viewing = null">
      <div v-if="viewing" class="bbi-modal bbi-modal-wide" role="dialog" aria-modal="true" aria-label="Full text of prompt words">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">{{ viewing.title }}</span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="viewing = null">
            <Icon name="close" />
          </button>
        </header>

        <pre class="bbi-hist-text">{{ viewing.segment.text }}</pre>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="copyText(viewing!.segment.text, 'Copied')">
            <Icon name="copy" /> Copy
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="viewing = null">Done</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— Count pill: same look as the characters/settings pages —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.bbi-hist-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0;
}

/* —— Collapsible title row: name + channel + tokens + time + status ——
   Shrink priority (who gives way first when space runs out): channel/model → title → time;
   tokens and the status pill **never shrink**: they are the two values on this row most worth reading. */
.bbi-hist-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
/* The title can shrink (min-width:0 is required for the ellipsis to work).
   It used to be flex:0 0 auto, unshrinkable, so a long title pushed the tokens/status after it right out of the container;
   that is exactly why "no tokens visible" happened on narrow screens, not because a media query hid them. */
.bbi-hist-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Channel/model: the first to give way */
.bbi-hist-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbi-hist-tok {
  flex: 0 0 auto;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
}
/* Estimates are muted: visually separated from real usage so they aren't taken as authoritative numbers */
.bbi-hist-tok.is-est {
  color: var(--bbi-ink-muted);
  font-weight: 400;
}
.bbi-hist-time {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* Status pill: reuses the global .bbi-prompt-state geometry, changing only colours.
   Success uses the same accent as its own .is-custom; failure red, cancelled orange (cancelling isn't a fault). */
.bbi-prompt-state.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-error {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
  border-color: transparent;
}
.bbi-prompt-state.is-aborted {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— Expanded area: fact label strip —— */
.bbi-hist-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.bbi-hist-fact {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-soft);
  background: var(--bbi-surface-2);
}

.bbi-hist-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-danger-soft);
  color: var(--bbi-danger);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

/* —— Prompt segment list: geometry copied from "Custom prompts" on the settings page —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* The role label = the identity of this prompt segment, same rule as the settings page's .bbi-prompt-name: uses --bbi-ink.
   Fixed width so every row's preview starts on the same left edge.
   [Width set by the longest label] ASSISTANT is 9 uppercase monospace characters + letter-spacing; the guessed
   72px couldn't fit it and it was cut to "ASSISTAN…". Using ch units follows the font size, so changing font size won't truncate it again.
   [Don't change to --bbi-accent] In the pastel theme it is #ffafcc (light pink, meant for backgrounds,
   paired with white --bbi-accent-ink text); as a text colour on a light surface it is nearly invisible. */
.bbi-prompt-role {
  flex: 0 0 auto;
  width: 10.5ch;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.bbi-prompt-preview {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Rough token estimate: shows at a glance which segment takes the most space; the value in this list most worth reading.
   Fixed width + right-aligned + tabular-nums: units line up in a column across rows, so different digit counts (≈400 / ≈3,700)
   can be compared directly; without a fixed width the numbers float with the preview width and each must be read to compare.
   The width covers the ≈ prefix + 5 digits (tens of thousands), in ch units following the font size. */
.bbi-prompt-len {
  flex: 0 0 auto;
  width: 7ch;
  text-align: right;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

.bbi-hist-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* —— Dialog: wider + long text height-capped with scrolling —— */
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-hist-text {
  margin: 0;
  padding: 12px 14px;
  max-height: 52vh;
  overflow-y: auto;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  user-select: text;
}

/* —— Danger button / icon buttons / bottom spacer: scoped doesn't cross component boundaries, so each page keeps its own copy —— */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.bbi-icon-mini {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— Narrow screens: the title row can't fit, so secondary info steps back ——
   Tokens and status **must stay**: tokens are this page's core information, far more important than the channel name/time. */
@media (max-width: 640px) {
  .bbi-hist-name {
    font-size: 13px;
  }
  .bbi-hist-sub,
  .bbi-hist-time {
    display: none;
  }
  /* Narrow screens: the preview gives way to the token estimate. The estimate is the only basis for judging "which segment takes space"; the preview only
     helps recognition, so when only one can stay, keep the number. With the preview gone, margin-left:auto pushes it back to the right;
     otherwise it would huddle on the left next to the role label, far from the eye button and not reading as a column.
     The role label width is no longer reduced: squeezing it to 56px would truncate ASSISTANT, which is exactly the identity information to read. */
  .bbi-prompt-preview {
    display: none;
  }
  .bbi-prompt-len {
    margin-left: auto;
    font-size: 12px;
    color: var(--bbi-ink);
  }
  .bbi-hist-text {
    font-size: 11.5px;
  }
}
</style>
