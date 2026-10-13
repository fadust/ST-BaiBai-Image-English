<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { computed, ref } from 'vue';

/**
 * 角色管理 —— 两层固定外貌库:
 * - 全局库:跨所有聊天生效的只读模板,AI 永不修改,仅手动维护(适合玩家角色等固定形象)。
 * - 本聊天库:仅当前聊天,柏宝书自动建档、AI 随剧情变更;同名时优先于全局。
 * 外貌按字段记录(sex/hair/eyes/...),拼接结果即最终 tag;生成 tag 时 AI 照抄库中字段,
 * 残留的 @角色名 占位符由插件兜底替换 —— 外貌稳定不漂移。
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
// editingScope:被编辑条目所在层;draftScope:草稿保存到哪层(仅新建时可选)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// 草稿来源:手改内容即转 manual;「从柏宝书重新生成」后转 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// 弹窗内历史面板开关
const historyOpen = ref(false);
// 回滚确认
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: 'Fill in the fan character: character name (copyright name), without escaping brackets; leave blank for original',
  sex: 'Such as 1girl / 1boy',
  hair: 'Such as long black hair',
  eyes: 'Such as red eyes',
  skin: 'Such as pale skin (optional)',
  body: 'Such as petite, small breasts',
  extra: 'Such as heterochromia (optional)',
  outfit: 'Fixed attire, optional',
};

/** 全局库名字集(响应式),用于分区与「覆盖」徽标。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分区 = 派生库里「属于本聊天」的条目:
 * 本聊天基线里的(含覆盖全局的同名条目)+ 非全局的(AI 楼层建档等)。
 * 纯全局条目只出现在全局分区。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** 是否整串模式:有 raw 且没有字段。 */
const draftIsRaw = computed(
  () => !!draft.value && !!draft.value.raw.trim() && CHAR_TAG_FIELDS.every(f => !draft.value!.fields[f].trim()),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** 正在编辑的本聊天条目的实时历史(回滚后随之刷新);全局条目不记历史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** 卡片上的字段 chips:有字段用字段,整串模式回退 raw 文本(模板里分支)。 */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
}

/* —— 分区折叠(参照柏宝书「计划/悬念」)——
 * 标题行兼作折叠开关;折叠态是本机视图偏好,走 localStorage、不进设置(跨设备同步没意义)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 无条目即无可折叠:不显示箭头与计数,也强制展开(避免删空后卡在收拢的空态)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** 手动编辑过的字段 → 条目归手动(但仍可被 AI 变更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('Role name cannot be empty', 'BaiBai Image');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('Fill in at least one Appearance fields (or the entire string tag)', 'BaiBai Image');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) closeEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  closeEntry();
}

/* —— 提升为全局 / 复制到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}"Has been promoted to global character, all chats take effect`, 'BaiBai Image');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`Already put "${name}"Copy to this chat, and then this chat will be subject to the copy.`, 'BaiBai Image');
  }
  closeEntry();
}

/* —— 从柏宝书最新状态建档:取最新楼的角色参考,找到同名角色的外貌记录,批量转换接口转字段 —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('Fill in the character name first', 'BaiBai Image');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('There are currently no open chats', 'BaiBai Image');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('There is no appearance record of this character in the latest status of BaiBai Book. It can be filled in manually.', 'BaiBai Image');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('The model did not return tag for this character, please try again or fill it in manually.', 'BaiBai Image');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('The latest appearance of BaiBai Book has been generated. Click "Finish" to save.', 'BaiBai Image');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'BaiBai Image');
  } finally {
    regenerating.value = false;
  }
}

/* —— 历史展示与回滚(仅本聊天条目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return 'Create a file';
  if (field === 'raw') return 'whole string';
  if (field === 'nl') return 'Natural Language';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`Rolled back"${p.name}" of${fieldLabel(p.record.field)}Changed`, 'BaiBai Image');
  } else {
    toastr.warning('Rollback failed: entry may have been deleted', 'BaiBai Image');
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? 'BaiBai Book' : entry.source === 'ai' ? 'AI Maintenance' : 'Manual';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Characters</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      The appearance library keeps characters consistent. Image planning copies their saved features; legacy @name references use the latest saved appearance.
    </p>

    <!-- ===== 全局角色库 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? 'Collapse global character library' : 'Expand global character library') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">Global character library</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="Add global character" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            All chats are in effect, only manual maintenance - AI will not modify the global character and is suitable for fixed images such as player roles. When this chat has a character with the same name, this chat shall prevail.
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-char-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'global')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span class="bbi-char-pill is-global">Global</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="This chat has a character with the same name. The current chat is based on this chat.">
                    This chat has been covered
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            There is no global character yet. Click &quot;Promote to global&quot; in the editing pop-up window of chat character, or click &quot;+&quot; in the upper right corner to add.
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? 'Close chat character' : 'Expand chat character') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">Chat characters</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="Add chat character" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            Only the current chat is effective: BaiBai Book characters are automatically archived, and AI changes permanently with the plot report; the history can be viewed and rolled back.
          </p>
          <ul v-if="chatEntries.length" class="bbi-char-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'chat')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >
                    {{ sourceLabel(entry) }}
                  </span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="The same name as the global library, the current chat is subject to this article">
                    Cover the whole world
                  </span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} Change records, click on the card to view`"
                  >
                    <Icon name="history" />{{ entry.history.length }}
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            This chat has no characters yet. When tag is generated, the BaiBai Book character will be automatically created. You can also click the &quot;+&quot; in the upper right corner to manually add it.
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="Edit character">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? 'Edit character' : 'Add role' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? 'Global' : 'This chat' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="Close" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- 作用域:仅新建时可选;已有条目换层用底部「提升为全局 / 复制到本聊天」 -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">save to</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              This chat
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              Global
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? 'Global: All chats take effect, AI will not be modified, tag needs to be modified manually if there is any problem.' : 'This chat: Only the current chat, AI can automatically change with the plot.' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Character name</span>
          <input v-model="draft.name" class="bbi-input" placeholder="The name is consistent with the name in the main text/BaiBai Book" @input="markManual" />
        </label>
        <span class="bbi-field-hint">Use the exact name from the story or BaiBai Book. Names are matched verbatim; renaming an entry does not update earlier references.</span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">Appearance fields</span>
          <div class="bbi-char-form">
            <label
              v-for="f in CHAR_TAG_FIELDS"
              :key="f"
              class="bbi-char-form-row"
              :class="{ 'is-wide': f === 'outfit' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
              <input
                v-model="draft.fields[f]"
                class="bbi-input"
                :placeholder="FIELD_PLACEHOLDERS[f]"
                @input="markManual"
              />
            </label>
          </div>
        </div>
        <span class="bbi-field-hint">Save permanent features and signature outfits here. Temporary clothing, expressions, and actions come from the current scene.</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Custom tag string (optional)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="If left blank, the above fields will be used to splice it; when the entire string is filled in and the fields are all empty, the entire string will prevail (old data format)"
            @input="markManual"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">Natural language appearance (optional)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="A coherent description of appearance in English. Use it to replace @character name in nl in natural language mode; if left blank, use tag string to replace it."
            @input="markManual"
          />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">Final tag preview</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(empty)' }}</code>
          <span v-if="draftIsRaw" class="bbi-char-preview-mode">Whole string mode</span>
        </div>

        <!-- 变更历史:仅本聊天条目;全局条目无历史(AI 不可改,手动编辑不留痕) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            Change History ({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `No.${record.floor}building` : 'Manual' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="Roll back the field to its value before the change" @click="askRollback(record)">
                rollback
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> Delete
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            v-if="editingName && editingScope === 'chat'"
            class="bbi-btn"
            type="button"
            title="Snapshot the current appearance into the global library, all chats will take effect; this chat copy and change history will be cleared"
            @click="askPromote"
          >
            <Icon name="star" /> Promote to global
          </button>
          <button
            v-if="editingName && editingScope === 'global'"
            class="bbi-btn"
            type="button"
            title="Copy as this chat copy: This chat will be based on the copy later, and AI can change it."
            @click="copyToChat"
          >
            <Icon name="copy" /> Copy to this chat
          </button>
          <button
            class="bbi-btn"
            type="button"
            title="Read the appearance of the character in the latest status of BaiBai Book and convert it into a field again."
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? 'Generating...' : 'Generate from BaiBai Book' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">Done</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Delete role"
          confirm-text="Delete"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          Confirm to delete &quot;{{ editingName }}&quot;tag's fixed appearance? The character's appearance will no longer be anchored when generated later.
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="Promote to global"
          confirm-text="promote"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          Put &quot;{{ editingName }}”’s current appearance snapshot into the global database? All subsequent chats (including this chat) will be based on the global value.
          AI can no longer modify it; the copy and change history of this chat will be cleared.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 回滚确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="Rollback changes"
      confirm-text="rollback"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        Put &quot;{{ pendingRollback.name }}&quot; of &quot;{{ fieldLabel(pendingRollback.record.field) }}&quot;From
        <code>{{ pendingRollback.record.to }}</code> rollback to
        <code>{{ pendingRollback.record.from || '(empty)' }}</code> ?
        Rolling back an archived record deletes the entire entry.
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与设置页版本号同款观感 —— */
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

/* —— 分区 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 折叠开关(参照柏宝书「计划/悬念」)——
 * 标题行整体可点:左箭头 + 标题 + 计数标。无框透明,折叠是辅助操作,标题仍是主体。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右。描边继承 currentColor(muted),hover 整行点亮强调色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区头右侧小「+」:透明底,hover 才点亮,不喷宾夺主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

/* —— 角色卡片网格 —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— 徽标药丸:全局=实心强调;柏宝书/AI=强调浅底;手动=弱化;覆盖=警示色 —— */
.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 字段 chips:两行封顶,超出裁切 —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* 整串模式:mono 小字两行截断 */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 弹窗加宽,容纳两列字段表单 —— */
.bbi-char-modal {
  max-width: 600px;
}

/* —— 字段表单:两列网格,固定着装独占一行 —— */
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— 弹窗内历史面板 —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 最终 tag 预览 —— */
.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
