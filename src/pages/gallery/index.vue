<script setup lang="ts">
import { formatBytes } from '@/bytes';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { imageDownloadFileName } from '@/floor/download';
import { openLightbox } from '@/floor/lightbox';
import { markImagesMissing, normalizeImagePath } from '@/floor/missingImages';
import { deleteImageFileOnly, readStore, sidecarPathFor, type BbiImageSidecar } from '@/floor/storage';
import { formatGenerationMeta, type GenerationMeta } from '@/generationMeta';
import { mapLimit } from '@/pool';
import { getContext } from '@/st/context';
import { formatPromptText, parseImageTagContent } from '@/st/imageTagRegex';
import { ARTIST_PREVIEW_FOLDER, listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { computed, onMounted, ref } from 'vue';

/**
 * Gallery page: browse generated images grouped by character name (GALLERY-STORAGE-DESIGN.md).
 *
 * The group key is the **folder name**, not the file name: the character name in saved file names is a hash
 * (imageFileName in floor/storage.ts, preventing CJK names from being sanitised into runs of underscores), so the readable name can only be recovered from
 * the folder name `user/images/柏宝绘_<character name>/`.
 *
 * [Deletion] Multi-select deletion is supported, but it **only deletes files and never touches chat history**: image paths are also
 * referenced by message.extra.bbiImage, while the gallery lists by folder and pointers are scattered across chats, with no reverse
 * index between them (scanning everything is infeasible; see the top of floor/storage.ts). Broken pointers are handled by runtime degradation on the floor card side:
 * the card's <img> @error confirms the 404 and records the image in floor/missingImages.ts, the pager and image count
 * are then recomputed from what survives, and with everything deleted it falls back to the "Generate image" state. After deleting, this page also marks them in place,
 * so users don't only find out after switching back to the chat.
 *
 * Prompts come from two places (see promptFor): the current chat's extra is read directly; the rest rely on the sidecar json written when saving.
 */

const FOLDER_PREFIX = '柏宝绘_';
/** After expanding, render one batch first and append another batch each time, rather than laying out the whole folder at once. */
const PREVIEW_COUNT = 24;
/** Sidecar request timeout: after clicking an image the lightbox waits for it, so a stuck server mustn't turn the click into "clicked, nothing happened". */
const SIDECAR_TIMEOUT_MS = 4000;
/**
 * Concurrency limit for batch requests (size probes, deletions).
 * Not large: ST is single-process, and dozens of simultaneous requests would stall the user's own chat;
 * more noticeably on remote connections. 6 is fast enough without hogging the connection pool.
 */
const REQUEST_CONCURRENCY = 6;
/** Push a reactive update only once this many sizes have accumulated (reason in measureSizes). */
const SIZE_PUBLISH_BATCH = 12;

interface GalleryImage {
  /** File name within the folder (unique within the group, used as key) */
  file: string;
  /** Normalised full path, the prompt cache key (unique across folders) */
  key: string;
  /** <img src>, encoded segment by segment */
  src: string;
  /** File name for saving */
  download: string;
}

interface GalleryGroup {
  /** Full folder name (with prefix) */
  folder: string;
  /** Character name for display (prefix removed) */
  name: string;
  images: GalleryImage[];
}

const groups = ref<GalleryGroup[]>([]);
const loading = ref(false);
const error = ref('');
/** Number of folders that failed to load: the page as a whole doesn't fail, but it must say honestly how many groups are missing. */
const partialFailed = ref(0);
const query = ref('');

/**
 * The static route /user/images/* runs decodeURIComponent server-side (createRouteHandler in users.js),
 * so each segment is encoded: browsers encode CJK names automatically, but a # ? in a character name would be taken as a URL fragment/query if not encoded.
 */
function imageSrc(folder: string, file: string): string {
  return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/** Takes the genId from bbi_<nameHash>_<swipe>_<promptHash>-<genId>.<ext>; falls back to the original file name if it can't. */
function downloadName(characterName: string, file: string): string {
  const genId = file.match(/-([^-.]+)\.[a-z0-9]+$/i)?.[1];
  return genId ? imageDownloadFileName(file, characterName, genId) : file;
}

/* —— Prompts: the current chat reads extra directly; the rest go through sidecars —— */

/**
 * Normalised path → full prompt text. Two sources share one table:
 * - on load(), prefilled from the **current chat**'s extra (zero network cost, so this chat's older images also have prompts);
 * - when a clicked image misses, filled from the sidecar json.
 * Misses are recorded as null and kept in the table, so clicking the same image repeatedly doesn't keep hitting 404.
 */
const promptCache = ref(new Map<string, string | null>());

/** Sidecars/extra all store the raw tag text, parsed here into human-readable full text (the same rule as cards).
 *  meta (artist string/vibes/sampling parameters) is read-only provenance, appended after; it isn't in the editable tag text. */
function renderPrompt(rawTag: string, seed: number | null, meta?: GenerationMeta): string {
  const text = formatPromptText(parseImageTagContent(rawTag));
  if (!text) return '';
  const lines = [text];
  if (seed !== null) lines.push(`Seed: ${seed}`);
  if (meta) lines.push(formatGenerationMeta(meta));
  return lines.filter(Boolean).join('\n\n');
}

/**
 * Scans the current chat's extra and collects every path → prompt into the cache.
 *
 * Only the current chat is scanned: reverse-looking-up prompts across the whole library was evaluated; one character's chats folder alone can reach GB size,
 * and /api/chats/get returns the whole file without pagination, so scanning it would certainly freeze. This chat is already in memory, free to use.
 */
function seedPromptsFromChat(): void {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return;
  const next = new Map(promptCache.value);
  for (const message of chat) {
    const store = readStore(message);
    if (!store) continue;
    for (const bucket of Object.values(store)) {
      for (const list of Object.values(bucket)) {
        for (const entry of list) {
          if (!entry?.path || !entry.prompt) continue;
          next.set(normalizeImagePath(entry.path), renderPrompt(entry.prompt, entry.seed ?? null, entry.meta));
        }
      }
    }
  }
  promptCache.value = next;
}

/**
 * Fetches the sidecar json. Uses a bare fetch without headers: static routes need no auth headers
 * (same as loadVibeData in backends/vibeStore.ts).
 * Any failure (404 / timeout / not JSON) returns null and degrades silently: old images never had sidecars,
 * which is the expected norm; it shouldn't error or block the lightbox.
 */
async function fetchSidecarPrompt(imagePath: string): Promise<string | null> {
  const sidecar = sidecarPathFor(imagePath);
  if (!sidecar) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
  try {
    const response = await fetch(sidecar, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<BbiImageSidecar>;
    if (!data || typeof data.prompt !== 'string' || !data.prompt) return null;
    return renderPrompt(data.prompt, typeof data.seed === 'number' ? data.seed : null, data.meta);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  partialFailed.value = 0;
  // Rescan the current chat on refresh: a few more images may have been generated meanwhile, or the chat may have switched
  seedPromptsFromChat();
  try {
    // Only list folders reported by /folders: /api/images/list mkdirs folders that don't exist,
    // so guessing names out of thin air would pile up empty folders under user/images.
    const folders = (await listUserImageFolders()).filter(
      folder => folder.startsWith(FOLDER_PREFIX) && folder !== ARTIST_PREVIEW_FOLDER,
    );
    const settled = await Promise.allSettled(
      folders.map(async folder => ({ folder, files: await listUserImages(folder) })),
    );

    const next: GalleryGroup[] = [];
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') {
        partialFailed.value++;
        console.warn('[BaiBai Image] Failed to read the gallery directory', folders[i], result.reason);
        return;
      }
      const { folder, files } = result.value;
      if (!files.length) return; // Leftover folders emptied by deletion take no space
      const storedName = folder.slice(FOLDER_PREFIX.length);
      const name = !storedName || storedName === '未命名角色' ? 'Unnamed Character' : storedName;
      next.push({
        folder,
        name,
        images: files.map(file => ({
          file,
          key: `user/images/${folder}/${file}`,
          src: imageSrc(folder, file),
          download: downloadName(name, file),
        })),
      });
    });

    // The current chat's character goes first, the rest sorted by name, so freshly generated images don't need searching for.
    const current = getContext()?.name2?.trim() ?? '';
    const collator = new Intl.Collator('zh-Hans-CN');
    next.sort((a, b) => {
      const rank = Number(b.name === current) - Number(a.name === current);
      return rank || collator.compare(a.name, b.name);
    });
    groups.value = next;
    // ⚠ Group size statistics are disabled for now: the author is unhappy with the current approach of reading Content-Length with one HEAD per image,
    // where the request count grows linearly with the gallery size, so opening the gallery once means hundreds to thousands of background requests.
    // The size computations, template, CSS and tests are all kept as-is; to restore, just uncomment the line below.
    // void measureSizes(next);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* —— Size statistics (⚠ disabled for now: the measureSizes call in load() is commented out; see there for why) —— */

/**
 * Normalised path → byte count. **Measured by one HEAD per image**.
 *
 * Why it has to be this way: `/api/images/list` only returns file names, with neither size nor mtime
 * (the server's util.js getImages only maps out dirent.name), and no existing endpoint reports sizes.
 * HEAD goes through the static route res.sendFile, measured at 1~2ms with no body; far cheaper than the thumbnails themselves (the gallery loads original images directly,
 * one group being a dozen-plus MB).
 *
 * Not cached in localStorage: files may be changed externally, cache staleness can't be detected, and remeasuring is only a few dozen
 * HEADs. Caching by path while the page is alive is enough; the refresh button remeasures.
 */
const sizes = ref(new Map<string, number>());
/** Number of groups still being measured: while >0 the total is followed by "Calculating", so a partial number isn't taken as final. */
const measuring = ref(0);

/**
 * Background measuring: one HEAD per image with limited concurrency. **Not awaited, not blocking the first screen**: the images are already viewable,
 * and size is extra information that can fill in gradually.
 *
 * Already measured paths are skipped (on refresh most images haven't changed; only the few new ones need measuring).
 *
 * Published in batches rather than written back per image: groupSize must iterate every image in a group to compute the total, so publishing once per measured image
 * would make every group recompute itself n times, quadratic busywork with thousands of images. Pushing once per batch
 * keeps the same "filling in gradually" feel.
 */
async function measureSizes(list: GalleryGroup[]): Promise<void> {
  const pending = list.flatMap(group => group.images).filter(image => !sizes.value.has(image.key));
  if (!pending.length) return;
  measuring.value++;
  // Unpublished increments. On publish they are **merged into the current value** rather than replacing it wholesale: two quick refresh clicks give two rounds of
  // measureSizes in parallel, and each replacing with its own snapshot would erase the other's measurements.
  const buffered = new Map<string, number>();
  const publish = (): void => {
    if (!buffered.size) return;
    const next = new Map(sizes.value);
    for (const [key, size] of buffered) next.set(key, size);
    buffered.clear();
    sizes.value = next;
  };
  try {
    await mapLimit(pending, REQUEST_CONCURRENCY, async image => {
      const probe = await probeUserImage(image.src);
      // Only record definite numbers: if probing fails (network error) leave it empty, and groupSize treats it as "not fully measured yet"
      if (probe?.exists && probe.size !== null) {
        buffered.set(image.key, probe.size);
        if (buffered.size >= SIZE_PUBLISH_BATCH) publish();
      }
    });
  } finally {
    publish();
    measuring.value--;
  }
}

/** A group's total size and completeness. Only fully measured is exact; otherwise the label must carry "≥". */
function groupSize(group: GalleryGroup): { bytes: number; complete: boolean } {
  let bytes = 0;
  let known = 0;
  for (const image of group.images) {
    const size = sizes.value.get(image.key);
    if (size === undefined) continue;
    bytes += size;
    known++;
  }
  return { bytes, complete: known === group.images.length };
}

/** Size label on the group badge; empty string when not one image has been measured (shown as nothing, not 0 B). */
function groupSizeText(group: GalleryGroup): string {
  const { bytes, complete } = groupSize(group);
  if (!bytes) return '';
  const text = formatBytes(bytes);
  return complete ? text : `≥ ${text}`;
}

const totalSizeText = computed(() => {
  let bytes = 0;
  for (const size of sizes.value.values()) bytes += size;
  return bytes ? formatBytes(bytes) : '';
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value.filter(group => group.name.toLowerCase().includes(q));
});

const totalImages = computed(() => groups.value.reduce((n, g) => n + g.images.length, 0));

/* Collapsed by default; only manually expanded groups are recorded. The old collapsed list can't tell which groups were expanded manually. */
const EXPANDED_KEY = 'bbi.ui.galleryExpanded.v1';

function loadExpanded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

const expanded = ref<Set<string>>(loadExpanded());

/**
 * Groups whose content has been mounted. **Only added, never removed**: collapsing doesn't unmount, so on re-expanding the images are still there, with zero requests.
 *
 * Since the fold container became permanent, rendering content unconditionally too would mount every character's images on entering the page (all collapsed by default),
 * worse than unmounting; so this is the safeguard: groups never manually expanded render not one image, and once expanded stay in the DOM for good.
 */
const mounted = ref<Set<string>>(new Set(expanded.value));

function persistExpanded(next: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
  } catch {
    /* When localStorage is unavailable it only applies to this session */
  }
}

function toggleFold(folder: string): void {
  const open = !expanded.value.has(folder);
  // Content is only mounted on first expansion; collapsing afterwards no longer unmounts it.
  // No need to split into two frames, "mount content first, expand next frame": .gal-fold-wrap is permanent from page load and rests at 0fr,
  // so the transition's start value is long settled, and inserting content in the same frame doesn't stop it transitioning from 0fr to 1fr.
  if (open) mounted.value = new Set(mounted.value).add(folder);

  const next = new Set(expanded.value);
  if (open) next.add(folder);
  else next.delete(folder);
  expanded.value = next;
  persistExpanded(next);
}

/* The shown count is kept only within this page visit, so re-expanding after collapsing doesn't start over from the first batch. */
const visibleCounts = ref(new Map<string, number>());

function visibleImages(group: GalleryGroup): GalleryImage[] {
  return group.images.slice(0, visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT);
}

function showMore(group: GalleryGroup): void {
  const count = visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT;
  visibleCounts.value.set(group.folder, Math.min(count + PREVIEW_COUNT, group.images.length));
}

/* —— Multi-select deletion —— */

/**
 * Selection mode. A separate toggle rather than "long-press to enter": the gallery is mainly for browsing, and click image = enlarge must be the default;
 * in selection mode clicking an image ticks it instead, and this toggle keeps the two meanings clearly apart, so users never guess between enlarging and ticking.
 */
const selecting = ref(false);
/** Ticked images (normalised path keys, unique across groups). */
const selected = ref(new Set<string>());
const deleting = ref(false);

const selectedCount = computed(() => selected.value.size);

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  // Leaving selection mode always clears it: keeping selections would mean next time pressing delete on a batch of images nobody remembers selecting
  if (!selecting.value) selected.value = new Set();
}

function toggleSelected(image: GalleryImage): void {
  const next = new Set(selected.value);
  if (next.has(image.key)) next.delete(image.key);
  else next.add(image.key);
  selected.value = next;
}

/** Whether this whole group is selected (empty groups don't count). */
function groupAllSelected(group: GalleryGroup): boolean {
  return group.images.length > 0 && group.images.every(image => selected.value.has(image.key));
}

function someSelected(group: GalleryGroup): boolean {
  return !groupAllSelected(group) && group.images.some(image => selected.value.has(image.key));
}

/**
 * Select/deselect a whole group. **Acts on the whole group, not the batch currently visible**: lazy loading is only a rendering strategy,
 * and when the user says "select all of this character" they mean all of this character's images, not fewer because they didn't scroll down.
 */
function toggleGroup(group: GalleryGroup): void {
  const next = new Set(selected.value);
  if (groupAllSelected(group)) group.images.forEach(image => next.delete(image.key));
  else group.images.forEach(image => next.add(image.key));
  selected.value = next;
}

/** Clicking an image: ticks it in selection mode, otherwise enlarges it. */
function onThumbClick(image: GalleryImage): void {
  if (selecting.value) toggleSelected(image);
  else void open(image);
}

/**
 * Deletes the selected images. **Only deletes files, never touches chat history** (see the file header comment for why).
 *
 * After deleting it does three things: marks them missing (so floor cards already open this session degrade immediately, without waiting for their own 404),
 * removes them from the list in place (no reload, so the user's expanded state and loaded batches aren't all reset), and clears the size cache.
 */
async function deleteSelected(): Promise<void> {
  if (!selectedCount.value || deleting.value) return;
  const targets = groups.value
    .flatMap(group => group.images)
    .filter(image => selected.value.has(image.key));
  if (!targets.length) return;

  const ok = await confirmDialog({
    title: `Delete ${targets.length} images`,
    text:
      `This deletes ${targets.length} images and their prompt sidecar files from disk. It cannot be undone.\n\n` +
      'Chat history is not changed: the floor card shows "Image file deleted" and can be generated again.',
    confirmText: 'Delete',
    tone: 'danger',
  });
  if (!ok) return;

  deleting.value = true;
  try {
    // Per-image fault tolerance: one failure shouldn't stop the rest (mapLimit would reject as a whole, so catch inside the callback)
    const results = await mapLimit(targets, REQUEST_CONCURRENCY, async image => {
      try {
        // Pass the key, not src: src is the segment-encoded path for <img>, while the delete endpoint wants the decoded
        // disk path (ST's /api/images/delete does path.join directly, without decodeURIComponent).
        // The key follows the same rule as markImagesMissing / sizes, so CJK folder names don't drift into a 404.
        await deleteImageFileOnly(image.key);
        return { key: image.key, ok: true };
      } catch (e) {
        console.warn('[BaiBai Image] Failed to delete picture', image.key, e);
        return { key: image.key, ok: false };
      }
    });

    const done = new Set(results.filter(r => r.ok).map(r => r.key));
    const failed = results.length - done.size;

    if (done.size) {
      // Floor cards already open degrade immediately from this (the key is already the normalised path, the same rule as missingImages)
      markImagesMissing(done);
      // Remove in place: no load(), otherwise the user's expanded state and loaded batches would all be reset
      groups.value = groups.value
        .map(group => ({ ...group, images: group.images.filter(image => !done.has(image.key)) }))
        .filter(group => group.images.length > 0);
      const nextSizes = new Map(sizes.value);
      done.forEach(key => nextSizes.delete(key));
      sizes.value = nextSizes;
    }

    selected.value = new Set([...selected.value].filter(key => !done.has(key)));
    if (!selected.value.size) selecting.value = false;

    if (failed) toastr.error(`${failed} images could not be deleted; see the console for details`, 'BaiBai Image');
    else toastr.success(`Deleted ${done.size} images`, 'BaiBai Image');
  } finally {
    deleting.value = false;
  }
}

/** The image whose sidecar is being fetched (between the click and the lightbox opening, show a spinner so nobody thinks the click missed). */
const pending = ref('');

/**
 * Clicking an image: prepare the prompt first, then open the lightbox.
 *
 * It must **await first, then openLightbox**: the lightbox is a one-off component rendered imperatively with h(),
 * its props aren't reactive, and a prompt arriving late can't be added in.
 */
async function open(image: GalleryImage): Promise<void> {
  let prompt = promptCache.value.get(image.key);
  if (prompt === undefined) {
    pending.value = image.key;
    try {
      prompt = await fetchSidecarPrompt(image.key);
      // null goes into the cache too: remember "this one really has none", so each click doesn't hit another round of 404
      promptCache.value = new Map(promptCache.value).set(image.key, prompt);
    } finally {
      pending.value = '';
    }
  }
  openLightbox({ src: image.src, filename: image.download, prompt: prompt ?? '' });
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">Gallery</h2>
      <button class="gal-icon-btn" type="button" title="Reload" :disabled="loading" @click="load">
        <Icon name="refresh" />
      </button>
    </div>
    <hr class="bbi-rule" />

    <!-- Toolbar: searches character names only (file names are hashes, searching them is pointless) -->
    <div class="gal-toolbar">
      <input v-model="query" class="bbi-input gal-search" placeholder="Search character name" />
      <button
        class="bbi-btn bbi-btn-sm gal-select-toggle"
        :class="{ 'is-on': selecting }"
        type="button"
        :disabled="!groups.length"
        :title="selecting ? 'Exit selection' : 'Select images to delete in bulk'"
        @click="toggleSelecting"
      >
        <Icon :name="selecting ? 'close' : 'checklist'" />
        {{ selecting ? 'Done' : 'Select' }}
      </button>
      <span class="gal-count">
        {{ groups.length }} characters · {{ totalImages }} images<template v-if="totalSizeText">
          · {{ totalSizeText }}<span v-if="measuring" class="gal-measuring">+</span>
        </template>
      </span>
    </div>

    <!-- Selection action bar: right after the toolbar, sticky at the top.
         Placed here rather than at the end of the list: the "Select" button that opens it is one row up, so it's visible on press (at the bottom,
         with many characters nothing on screen would move on press, as if it didn't work); sticky keeps it there however far you scroll. -->
    <div v-if="selecting" class="gal-actionbar">
      <span class="gal-actionbar-count">Selected {{ selectedCount }} images</span>
      <button
        class="bbi-btn bbi-btn-sm"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="selected = new Set()"
      >
        Clear
      </button>
      <button
        class="bbi-btn bbi-btn-sm bbi-btn-danger"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="deleteSelected"
      >
        <Icon name="trash" />
        {{ deleting ? 'Deleting…' : 'Delete' }}
      </button>
    </div>

    <p v-if="partialFailed" class="gal-warn">
      {{ partialFailed }} character folders could not be read and are not listed below (see the console for details).
    </p>

    <!-- Loading / error / empty / list -->
    <div v-if="loading && !groups.length" class="gal-state">
      <Icon name="refresh" :size="26" class="gal-spin" />
      <p class="gal-state-title">Loading gallery…</p>
    </div>

    <div v-else-if="error" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">Could not load</p>
      <p class="gal-state-hint">{{ error }}</p>
      <button class="bbi-btn bbi-btn-sm" type="button" @click="load"><Icon name="refresh" /> Try again</button>
    </div>

    <div v-else-if="!groups.length" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">No images yet</p>
      <p class="gal-state-hint">Images generated in chats appear here, grouped by character.</p>
    </div>

    <p v-else-if="!filtered.length" class="gal-state-inline">No match &quot;{{ query }}” role.</p>

    <div v-else class="gal-groups">
      <section
        v-for="group in filtered"
        :key="group.folder"
        class="gal-group"
        :class="{ 'is-collapsed': !expanded.has(group.folder) }"
      >
        <!-- The title row is "a container + several independent controls inside" rather than one big button: in selection mode this row must
             hold the select-all checkbox for the group, and a <button> can't contain a <button>/<input> (invalid HTML, and
             clicks would fire twice). So the collapse trigger is a separate button, with the checkbox beside it. -->
        <div class="gal-fold-head">
          <label v-if="selecting" class="gal-group-check" :title="`Select all of ${group.name}`">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="groupAllSelected(group)"
              :indeterminate="someSelected(group)"
              :aria-label="`Select all of ${group.name}`"
              @change="toggleGroup(group)"
            />
          </label>
          <button
            class="gal-fold-trigger"
            type="button"
            :aria-expanded="expanded.has(group.folder)"
            :title="expanded.has(group.folder) ? `Collapse ${group.name}` : `Expand ${group.name}`"
            @click="toggleFold(group.folder)"
          >
            <Icon name="chevron" class="gal-caret" :class="{ 'is-collapsed': !expanded.has(group.folder) }" />
            <span class="gal-name">{{ group.name }}</span>
            <span class="gal-badge">{{ group.images.length }}</span>
            <span v-if="groupSizeText(group)" class="gal-size">{{ groupSizeText(group) }}</span>
          </button>
        </div>

        <!-- The collapse container stays in the DOM (grid 1fr→0fr only zeroes the height), and <img> isn't unmounted:
             the /user/images static route's sendFile has no maxAge, defaulting to Cache-Control: max-age=0,
             so every remount means one conditional request per image (Firefox even uses no-store and downloads it all again).
             Over a remote ST connection all these round trips land on latency, and collapsing then expanding would flash blank. Same as floor/card.css. -->
        <div class="gal-fold-wrap" :class="{ 'is-collapsed': !expanded.has(group.folder) }">
          <div class="gal-fold-inner">
            <div v-if="mounted.has(group.folder)" class="gal-fold-body">
              <ul class="gal-grid">
                <li v-for="image in visibleImages(group)" :key="image.file" class="gal-cell">
                  <button
                    class="gal-thumb"
                    :class="{
                      'is-busy': pending === image.key,
                      'is-selectable': selecting,
                      'is-selected': selecting && selected.has(image.key),
                    }"
                    type="button"
                    :title="selecting ? image.file : `View ${image.file}`"
                    :aria-pressed="selecting ? selected.has(image.key) : undefined"
                    @click="onThumbClick(image)"
                  >
                    <img class="gal-img" :src="image.src" :alt="`${group.name} The generated graph`" loading="lazy" />
                    <!-- Check badge: only shown in selection mode, filled with the main colour when selected -->
                    <span v-if="selecting" class="gal-check" aria-hidden="true">
                      <Icon v-if="selected.has(image.key)" name="check" :size="13" />
                    </span>
                  </button>
                </li>
              </ul>
              <button
                v-if="group.images.length > visibleImages(group).length"
                class="bbi-btn bbi-btn-sm gal-more"
                type="button"
                @click="showMore(group)"
              >
                <Icon name="plus" />
                Show {{ Math.min(PREVIEW_COUNT, group.images.length - visibleImages(group).length) }} more
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

  </section>
</template>

<style scoped>
/* —— Refresh on the right of the title bar —— */
.gal-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}
.gal-icon-btn:hover:not(:disabled) {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.gal-icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

/* —— Toolbar —— */
.gal-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.gal-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.gal-count {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* Sizes still being measured: the total is followed by a "+" meaning "at least this much, still counting".
   No spinner: another animation in the toolbar is too noisy, and a static plus sign reads clearly. */
.gal-measuring {
  margin-left: 1px;
  opacity: 0.6;
}

/* Selection mode toggle. Solid main colour when on, matching the "selecting" state. */
.gal-select-toggle {
  flex: 0 0 auto;
}
.gal-select-toggle.is-on {
  border-color: var(--bbi-accent);
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}

.gal-warn {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
  font-size: 12px;
}

/* —— Empty/error/loading states —— */
.gal-state {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 80px 20px;
  color: var(--bbi-ink-soft);
  text-align: center;
}
.gal-state-title {
  margin: 0;
  font-size: 15px;
  color: var(--bbi-ink);
}
.gal-state-hint {
  margin: 0;
  max-width: 34em;
  font-size: 12.5px;
  word-break: break-word;
}
.gal-state-inline {
  margin: 0;
  padding: 40px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-muted);
}
.gal-spin {
  animation: gal-rotate 0.9s linear infinite;
  color: var(--bbi-accent);
}
@keyframes gal-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gal-spin {
    animation: none;
  }
}

/* —— Groups —— */
/* —— Group cards ——
   Same rhythm as the settings page's .bbi-sections (gap 12px): each group is one bordered card,
   still a solid title bar when collapsed, never shrinking into a line of floating text.
   The difference from the characters page's "borderless collapse header" vocabulary: there the groups hold grey-white forms,
   here they hold colourful thumbnails, which need an enclosure to stay tidy. */
.gal-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gal-group {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  /* Deliberately no gap: after .gal-fold-wrap collapses to 0fr, the gap still takes space,
     and with a border it would show a dead white strip at the bottom of the card. Spacing always comes from each part's padding. */
}

/* The whole title row is clickable: left arrow + character name + count (same collapse vocabulary as the character management page).
   As a card, the header carries its own padding and fills the rounded corners, with background feedback on hover.
   In selection mode this row also holds the group's select-all checkbox, so the outer element is a plain div and the collapse trigger is the button inside
   (an <input type=checkbox> inside a <button> is invalid nesting, and clicks fire twice). */
.gal-fold-head {
  display: flex;
  align-items: center;
  /* Rounded corners and hover background still come from this layer: it is the one filling the card's width */
  border-radius: var(--bbi-radius) var(--bbi-radius) 0 0;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-head:hover {
  background: var(--bbi-surface-2);
}
/* Collapse trigger: fills the remaining width of the title row and draws no background itself (the background is on the parent, changing together with the checkbox) */
.gal-fold-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 11px 14px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
}
.gal-fold-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}
/* The checkbox is at the far left, sharing the row's hover background with the trigger;
   padding is horizontal only; the height comes from the title row itself, so it isn't shorter than the trigger.
   Size/colours always come from the global .bbi-checkbox; only margin is cleared here:
   the pastel theme turns .bbi-checkbox into a custom-drawn one (background tick 14px centred), and shrinking it here would push the tick to the edge. */
.gal-group-check {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  flex: 0 0 auto;
  padding: 0 2px 0 12px;
  cursor: pointer;
}
.gal-group-check .bbi-checkbox {
  margin: 0;
}
/* With a checkbox, the trigger's left padding narrows so the arrow isn't pushed too far right */
.gal-group-check + .gal-fold-trigger {
  padding-left: 8px;
}
/* Corner rounding switches instantly at both ends and isn't transitioned: "the bottom two corners rounding" mid-collapse would let .gal-fold-body's
   full-width border-top line poke out past the rounded corner (especially visible with a hover background).
   Expanding restores square corners immediately (0s, no delay); collapsing rounds them only after the height has finished (0s + --bbi-dur delay). */
.gal-group.is-collapsed > .gal-fold-head {
  border-radius: var(--bbi-radius);
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-radius 0s var(--bbi-dur);
}
.gal-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    color 0.15s;
}
.gal-caret.is-collapsed {
  transform: rotate(-90deg);
}
.gal-fold-trigger:hover .gal-caret,
.gal-fold-trigger:focus-visible .gal-caret {
  color: var(--bbi-accent);
}
.gal-name {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbi-ink);
  word-break: break-word;
}
.gal-badge {
  flex: 0 0 auto;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
/* Size: follows the count badge on the right, without background: it is a note, not a label, and overpowering the character name would steal the show.
   margin-left:auto pushes it to the end of the row, aligned with the right-hand padding. */
.gal-size {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 8px;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gal-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
@media (prefers-reduced-motion: reduce) {
  .gal-fold-wrap {
    transition: none;
  }
}
.gal-fold-inner {
  min-height: 0;
  overflow: hidden;
}
/* Padding and the divider live on this layer: it is a child of inner, so when collapsed it is clipped along with the 0fr,
   without leaving a stub of stretched height as it would if attached to inner (same as Collapsible.vue).
   Left padding 12px + .gal-grid's own 2px = 14px, exactly aligned with the left edge of the title bar's arrow. */
.gal-fold-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--bbi-line);
}

/* —— Thumbnail grid —— */
.gal-grid {
  list-style: none;
  margin: 0;
  padding: 2px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}
.gal-cell {
  min-width: 0;
}
.gal-thumb {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  cursor: zoom-in;
  overflow: hidden;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.gal-thumb:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.gal-thumb:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
/* While fetching the sidecar prompt: lowered opacity signals "busy", without layout changes, so the grid doesn't jitter */
.gal-thumb.is-busy {
  opacity: 0.55;
  cursor: progress;
}
/* Selection mode: pointer cursor (clicking no longer enlarges); selected items get a main-colour outline + a slight inset to suggest "picked up" */
.gal-thumb.is-selectable {
  cursor: pointer;
  position: relative;
}
.gal-thumb.is-selected {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 2px var(--bbi-accent) inset;
}
.gal-thumb.is-selected .gal-img {
  opacity: 0.72;
}
/* Check badge: a circle at the top right. Unselected it is an empty ring on a translucent background (hinting "this can be selected"),
   selected it fills with the main colour and shows a white tick. */
.gal-check {
  position: absolute;
  top: 5px;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  border: 1.5px solid var(--bbi-surface);
  border-radius: 50%;
  background: var(--bbi-overlay);
  color: #fff;
}
.gal-thumb.is-selected .gal-check {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
/* Fixed 3:4 portrait framing: generated images are mostly portrait; a uniform ratio keeps the whole grid aligned, with overflow cropped by cover */
.gal-img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}

.gal-more {
  align-self: center;
}

/* —— Selection action bar ——
   Right after the toolbar + sticky at the top: the "Select" button that opens it is one row up, so it's visible on press;
   however far you scroll it stays, so there's no need to scroll back up to delete.
   top is calc(-1 * pad): the scroll container is .bbi-body, which has --bbi-page-pad padding,
   so the scrolling viewport's top edge is at the padding; top:0 would park the bar at the padding's lower edge, leaving a gap above
   for thumbnails to scroll through. Cancelling the padding makes it sit flush with the real top edge (same as .bbi-modal-head in base.css). */
.gal-actionbar {
  position: sticky;
  top: calc(-1 * var(--bbi-page-pad));
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  /* Opaque background: the thumbnail grid is underneath, and translucency would let images show through, making the numbers hard to read */
  background: var(--bbi-surface);
  box-shadow: 0 6px 18px -14px var(--bbi-overlay);
}
.gal-actionbar-count {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: var(--bbi-ink-soft);
  font-variant-numeric: tabular-nums;
}
/* .bbi-btn-danger is only declared in ConfirmDialog's scoped block (base.css doesn't have it),
   so using it here means copying both the base and hover rules in full; adding only hover would leave it the default ink colour normally,
   turning red only on mouse-over, a problem invisible in static screenshots. */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .gal-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .gal-name {
    font-size: 13px;
  }
}
</style>
