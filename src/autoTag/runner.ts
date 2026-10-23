import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  applyPositionedCharRefs,
  resolveCharAnchors,
  type PositionedCharOp,
} from '@/autoTag/charAnchors';
import { prepareTargetText } from '@/autoTag/clean';
import { beginGeneration, clearGeneration, consumeGeneration } from '@/autoTag/generationGate';
import { autoTagProfile, buildAutoTagMessages } from '@/autoTag/prompt';
import { rebaseImagePositions, type RebaseReport } from '@/autoTag/rebase';
import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import {
  BBI_CHAR_EXTRA_KEY,
  CHAR_TAG_FIELDS,
  charTagsBeforeFloor,
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  lockedCharTagNames,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
  type CharTagAutoOp,
  type CharTagField,
} from '@/state/charTags';
import { injectImageTags, parseImagePlan, type ImagePlan } from '@/autoTag/protocol';
import {
  clearAutoGenerateForFloor,
  consumeAutoGenerate,
  markForAutoGenerate,
} from '@/floor/autoGenerate';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { getContext, isAiStoryMessage, type STMessage } from '@/st/context';
import {
  hasImageTagTrace,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  stripImageTags,
} from '@/st/imageTagRegex';
import { getTagGenChannel, isCurrentChatExcluded, settings } from '@/state/settings';

const processed = new Set<string>();
const running = new Map<string, AbortController>();
let bound = false;
const scheduled = new Set<ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_PREFIX = '[BBI][AutoTagDebug]';

function diagnostic(event: string, payload: unknown = null): void {
  const seen = new WeakSet<object>();
  let detail: string;
  try {
    const json = JSON.stringify(payload, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    detail = json ?? String(payload);
  } catch (error) {
    detail = JSON.stringify({ stringifyError: error instanceof Error ? error.message : String(error) });
  }
  console.info(`${DIAGNOSTIC_PREFIX} ${event} ${detail}`);
}

/**
 * Abandons this run and explains why: diagnostics are logged in full as usual, and **the manual path must also show a toast**.
 *
 * A manual click is explicit intent; a silent return means, to the user, "clicked the button, nothing happened", impossible to trace
 * or report. The automatic path stays quiet (a toast for every floor would be unbearable); its outcome is in the diagnostic log.
 */
function abort(
  floor: number,
  reason: string,
  manual: boolean | undefined,
  hint: string,
  payload: Record<string, unknown> = {},
): void {
  diagnostic('runForFloor:skip', { floor, reason, ...payload });
  if (manual) toastr.warning(hint, 'BaiBai Image');
}

function activeSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function textHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

interface RunOptions {
  /** Manual trigger (floor button): bypasses autoTag.enabled and processed deduplication; gives feedback even for empty results. */
  manual?: boolean;
  /** Regenerate: removes existing tags from the text before analysing/injecting; old images stay in the card history. */
  replace?: boolean;
  /**
   * Single-slot prompt rewrite (the card's "AI rewrite prompt"): replaces only that seq's tag; other tags and images stay untouched.
   * **The scene doesn't change**: write-back replaces in place by seq, and the position the model returns plays no part in it; for the wording rule see
   * slotPlan.buildSlotTaskNote. The analysis base also strips all old tags, but output is forced to exactly 1 image,
   * and this run's AI changes are ignored (the first full analysis already created profiles for the whole floor).
   */
  slot?: { seq: number };
}

/** User-readable reason for abandoning the write. Text changes are no longer among them; that is normal and gets rebased and written as usual. */
const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': 'Chat has been switched, no pictures were written this time tag',
  'floor-changed': 'This floor has been deleted or replaced, and no raw map is written this time tag',
  'swipe-changed': 'swipe has been switched, and the raw image tag has not been written this time.',
  'build-failed': 'The text of the floor has been greatly rewritten or the existing drawing tag has not been written this time.',
  unavailable: 'The current chat cannot be written, no pictures are written this time tag',
};

/** One-line summary of the relocation result; empty string when everything hit in place (nothing to log). */
function describeRebase(report: RebaseReport): string {
  if (!report.remapped && !report.drifted) return '';
  const parts = [`in situ ${report.anchored}`];
  if (report.remapped) parts.push(`Follow the paraphrased sentence ${report.remapped}`);
  if (report.drifted) parts.push(`Postponed to the previous paragraph ${report.drifted}`);
  return parts.join(' · ');
}

/** Converts the AI's reported changes into operations on the current floor; the real write-back happens once, when the text CAS succeeds. */
function planChangeOps(plan: ImagePlan): PositionedCharOp[] {
  const ops: PositionedCharOp[] = [];
  for (const change of plan.changes) {
    let op: CharTagAutoOp | null = null;
    if (change.field === 'new') {
      // value may be a JSON string of structured fields (built by protocol.ts) or a whole tag text
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const field of CHAR_TAG_FIELDS) {
            const value = parsed[field];
            if (typeof value === 'string' && value.trim()) picked[field] = value.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* Not JSON → treat as a whole string */
        }
      }
      if (!fields && change.value) value = change.value;
      op = createCharTagNewOp(
        {
          name: change.name,
          fields: { ...emptyCharFields(), ...(fields ?? {}) },
          raw: value,
          nl: change.nl ?? '',
          source: 'ai',
          desc: '',
        },
        change.reason,
      );
    } else if (change.field === 'nl') {
      op = createCharTagSetOp(change.name, 'nl', change.value || change.nl || '', change.reason);
    } else {
      op = createCharTagSetOp(change.name, change.field, change.value, change.reason);
    }
    if (op) ops.push({ op, sourceLine: change.sourceLine });
  }
  return ops.sort((left, right) => left.sourceLine - right.sourceLine);
}

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<void> {
  const context = getContext();
  diagnostic('runForFloor:enter', {
    floor,
    manual: Boolean(opts.manual),
    replace: Boolean(opts.replace),
    slotSeq: opts.slot?.seq ?? null,
    chatId: context?.getCurrentChatId?.() ?? '',
    extensionEnabled: settings.enabled,
    autoTagEnabled: settings.autoTag.enabled,
  });
  if (!context) {
    abort(floor, 'missing-context', opts.manual, 'SillyTavern is not ready yet, please try again later.');
    return;
  }
  if (!settings.enabled) {
    abort(floor, 'extension-disabled', opts.manual, 'BaiBai Image has been disabled. Please enable it in the plug-in settings first.');
    return;
  }
  if (!opts.manual && !settings.autoTag.enabled) {
    diagnostic('runForFloor:skip', { floor, reason: 'auto-tag-disabled' });
    return;
  }
  // Excluded-character gate (same list as BaiBai Book): the whole auto-tag flow is disabled in chats with that character name;
  // the manual button is also removed at the actionButton layer; this is the safety net (with feedback for manual triggers).
  if (isCurrentChatExcluded()) {
    abort(floor, 'chat-excluded', opts.manual, 'This character is excluded from image planning.');
    return;
  }
  const message = context.chat[floor];
  const messageDiagnostic = message
    ? {
        isUser: message.is_user,
        isSystem: message.is_system,
        textLength: typeof message.mes === 'string' ? message.mes.length : -1,
        extraType: message.extra?.type ?? null,
      }
    : null;
  // Same predicate as the floor button (st/context.ts): normal floors hidden with /hide count as story floors and still run
  if (!isAiStoryMessage(message)) {
    abort(floor, 'not-ai-story-message', opts.manual, 'Only assistant story messages can be illustrated.', {
      message: messageDiagnostic,
    });
    return;
  }
  const rawSource = message.mes;
  const slot = opts.slot;
  // Target of a single-slot rewrite: snapshot the raw text of tag number seq at start, and before writing back confirm seq still points at the same tag
  // (same discipline as the prompt editor dialog). If the text no longer has this tag = it was deleted/the swipe changed meanwhile, give up.
  const slotRawTag = slot ? parseImageTags(rawSource)[slot.seq] : undefined;
  if (slot && slotRawTag === undefined) {
    abort(
      floor,
      'slot-missing',
      true,
      `No. ${slot.seq + 1} The prompt word of this picture no longer exists (it may have been changed to swipe or edited), and it has not been rewritten this time.`,
    );
    return;
  }
  // Detection shares its source with the button layer (imageTagRegex.hasImageTagTrace): the two once drifted:
  // the button only recognised open tags while this recognised both, so a floor with only `</bbi_image>` left got stuck at "clicked, nothing happened".
  // A single-slot rewrite presupposes "this floor already has tags", so this gate doesn't block it.
  if (hasImageTagTrace(rawSource) && !opts.replace && !slot) {
    abort(
      floor,
      'already-has-image-tag',
      opts.manual,
      'There is already a picture of tag in this building. There is no confirmation to regenerate it. It has not been changed this time.',
    );
    if (!opts.manual) console.debug(`[BaiBai Image] No. ${floor} Floor already contains bbi_image tag, skip automatic analysis`);
    return;
  }
  // replace / slot: analysis is based on the text with old tags removed. On write-back, replace makes the old tags disappear with it;
  // slot replaces in place by seq, and other tags stay intact in the write-back base.
  const source = opts.replace || slot ? stripImageTags(rawSource) : rawSource;
  if (!source.trim()) {
    abort(floor, 'empty-source', opts.manual, 'The text of this page is empty (or only the raw picture tag is left), and there is no content that can be analyzed.');
    return;
  }
  const preparedTarget = prepareTargetText(source, settings.excludes.customStripTags);
  if (!preparedTarget.segments.length) {
    abort(
      floor,
      'no-target-segments',
      opts.manual,
      'There is no narrative content left after cleaning the main text of this article (it may have been completely deleted by the "elimination tag" list or thought chain/annotation rules), and there are no paragraphs that can be analyzed.',
      { sourceLength: source.length },
    );
    return;
  }

  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) {
    abort(floor, 'missing-chat-id', opts.manual, 'There is currently no open chat, and no pictures are generated this time tag');
    return;
  }
  const swipeId = activeSwipeId(message);
  const identity = `${chatId}\u0000${floor}\u0000${swipeId ?? 'none'}\u0000${textHash(source)}`;
  // Manual means explicit intent: run even if the automatic flow already processed this text (e.g. concluded no image was needed),
  // but still record it in processed, so the automatic flow doesn't request the same text again afterwards.
  if (!opts.manual && processed.has(identity)) {
    diagnostic('runForFloor:skip', { floor, reason: 'already-processed', chatId, swipeId, identity });
    return;
  }
  processed.add(identity);
  diagnostic('runForFloor:start', {
    floor,
    chatId,
    swipeId,
    identity,
    sourceLength: source.length,
    segmentCount: preparedTarget.segments.length,
  });

  const runKey = `${chatId}\u0000${floor}`;
  running.get(runKey)?.abort();
  const controller = new AbortController();
  running.set(runKey, controller);

  try {
    const memory = readBookMemory(floor, context.chat[floor]?.mes ?? '', context.name1);
    // Single-slot rewrite: the library text must include this floor's profiles already recorded (created by the first full analysis), otherwise the AI would
    // rewrite profiled characters as newcomers. charTagsBeforeFloor(floor + 1) includes exactly this floor (applies when the swipe matches).
    const entriesBefore = slot ? charTagsBeforeFloor(floor + 1) : charTagsBeforeFloor(floor);
    // Locked names (global library ⊖ this chat's baseline): AI changes never apply to these names; they carry a [locked] marker in the library text
    const lockedNames = lockedCharTagNames();
    // Purely local rendering: profile creation is done by the main request in the same output (changes with field="new")
    const anchors = resolveCharAnchors(entriesBefore, lockedNames);
    // Single-slot rewrite: the protocol forces "exactly 1 image" and gives the model this slot's current prompt plus summaries of the other slots
    // (anchoring the same scene and not taking others' scenes). min/max must cover both the rule text in build and the parse validation below;
    // changing only one would contradict itself.
    const promptOptions = slot
      ? { ...settings.autoTag, minImages: 1, maxImages: 1 }
      : settings.autoTag;
    // Snapshot the protocol shape once at start: protocol writing, validation and finishing share it, so a toggle flipped midway can't make them disagree
    const profile = autoTagProfile();
    const messages = await buildAutoTagMessages(
      context,
      floor,
      promptOptions,
      memory,
      preparedTarget,
      anchors.text,
      slot ? buildSlotTaskNote(rawSource, slot.seq) : '',
      profile,
    );
    const channel = getTagGenChannel();
    // Retry on failure: both request errors and "unparseable/failed validation" responses count as retryable (the latter is common when the model ignores the protocol);
    // an abort signal stops immediately without using a retry. parseImagePlan throws on bad output, while "no images" is a normal empty array.
    // Parsing/validation goes into the validate callback: a failure is recorded truthfully in request history as failed (not a green "HTTP got text" success),
    // and the error is rethrown here for the retry loop, so display and behaviour follow the same rule.
    const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
    let plan: ImagePlan | null = null;
    let lastError = '';
    for (let attempt = 0; attempt <= retries && !plan; attempt++) {
      if (controller.signal.aborted) {
        processed.delete(identity);
        return;
      }
      try {
        // parsed is wrapped in an object: the validate closure writes it and it is read after await; non-null only if the request succeeded and validation passed.
        // (A plain let would be narrowed to null by TS: control-flow analysis can't see assignments inside the closure.)
        const parsed: { plan: ImagePlan | null } = { plan: null };
        const validate = (raw: string) => {
          const candidate = parseImagePlan(
            raw,
            preparedTarget.segments,
            promptOptions.minImages,
            promptOptions.maxImages,
          );
          // A single-slot rewrite ignores this run's changes and doesn't validate the profile nl; validating it would waste retries
          // on changes that will be discarded anyway. When NAI natural language is off the protocol asks for no nl, so it isn't validated either.
          if (
            !slot &&
            profile.naiCharPrompts &&
            profile.nl &&
            candidate.changes.some(change => change.field === 'new' && !change.nl?.trim())
          ) {
            throw new Error('NAI 4.5/V5 file must be accompanied by nl appearance description');
          }
          parsed.plan = candidate;
        };
        // With retries, add the attempt number to source, so two history records are visibly a retry pair
        const source = slot
          ? `Rewrite Prompt Words (No. ${floor} Floor · No. ${slot.seq + 1} image${retries > 0 ? ` · No. ${attempt + 1} times` : ''})`
          : retries > 0
            ? `Automatic tag (No. ${floor} Floor · No. ${attempt + 1} times)`
            : `Automatic tag (No. ${floor} floor)`;
        if (channel) {
          await requestCompletion(channel, messages, {
            signal: controller.signal,
            source,
            validate,
          });
        } else {
          await requestViaMainApi(messages, {
            signal: controller.signal,
            source,
            validate,
          });
        }
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        plan = parsed.plan;
      } catch (error) {
        if (controller.signal.aborted) {
          processed.delete(identity);
          return;
        }
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[BaiBai Image] No. ${floor} Building ${attempt + 1}/${retries + 1} Generation tag failed`, error);
      }
    }
    if (!plan) {
      // Retries exhausted: allow the same text to be tried again after a later re-render
      processed.delete(identity);
      toastr.error(
        `${lastError}${retries > 0 ? `(Automatically retried ${retries} times)` : ''}`,
        'BaiBai Image automatic tag failed',
      );
      return;
    }

    // Single-slot rewrites do not apply changes: the first full analysis already created profiles for the whole floor; applying again would only produce
    // duplicate profile/change records. The library text already includes this floor's delta (see entriesBefore above); the AI just copies it.
    const planOps = slot ? [] : planChangeOps(plan);
    // Locked characters (global library) don't accept AI changes: discard them; they are not written to the floor and take no part in @ replacement.
    // The replay side's applyCharTagOps blocks locked names again (old messages may already hold such ops).
    const effectiveOps = lockedNames.size
      ? planOps.filter(item => !lockedNames.has(item.op.name))
      : planOps;
    const floorOps = effectiveOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(message);

    // @placeholders are replaced by story position: images before a change use the old profile; the change position and after use the new one.
    const unknownNames = new Set<string>();
    for (const image of plan.images) {
      // When the protocol asks for tags only, any nl the model wrote anyway is dropped (same rule as ComfyUI with natural language off):
      // keeping it would send it as usual, making the toggle meaningless. If the channel locks orientation, record the locked value everywhere; generation follows the lock anyway,
      // this just keeps the orientation recorded in the tag consistent with the actual frame.
      if (!profile.nl) {
        image.nl = '';
        for (const character of image.characters) character.nl = '';
      }
      if (profile.lockedSize) image.size = profile.lockedSize;
      const tagRes = applyPositionedCharRefs(
        image.tag,
        anchors.entries,
        effectiveOps,
        image.sourceLine,
        'tag',
        lockedNames,
      );
      if (tagRes.text) image.tag = tagRes.text;
      if (image.nl) {
        const nlRes = applyPositionedCharRefs(
          image.nl,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'nl',
          lockedNames,
        );
        image.nl = nlRes.text;
        for (const n of nlRes.unknown) unknownNames.add(n);
      }
      for (const character of image.characters) {
        const charTag = applyPositionedCharRefs(
          character.tag,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'tag',
          lockedNames,
        );
        character.tag = charTag.text;
        for (const n of charTag.unknown) unknownNames.add(n);
        if (character.nl) {
          const charNl = applyPositionedCharRefs(
            character.nl,
            anchors.entries,
            effectiveOps,
            image.sourceLine,
            'nl',
            lockedNames,
          );
          character.nl = charNl.text;
          for (const n of charNl.unknown) unknownNames.add(n);
        }
      }
      for (const n of tagRes.unknown) unknownNames.add(n);
    }
    if (unknownNames.size) {
      // The model treated this as a character but created no profile for it, so the character will have no appearance at all in the image.
      // This is the only deterministic signal of a missed profile. Hiding it in the console means nobody sees it; the user must be shown.
      const names = [...unknownNames].join(', ');
      console.warn('[BaiBai Image] AI references a character placeholder that is not in the library and has been stripped:', names);
      toastr.warning(`Character "${names}" has no profile, so their appearance is missing from this image.`, 'BaiBai Image');
    }

    // The single-slot rewrite returned no new prompt: keep the original prompt and image, replace nothing (empty images is not an error).
    if (slot && !plan.images.length) {
      toastr.info('The model does not give new prompt words, and this picture remains as it is.', 'BaiBai Image');
      return;
    }
    // With no images, no character changes and no old floor changes to clean up, keep the original early exit without writing.
    if (!plan.images.length && !floorOps.length && !previousDelta) {
      if (opts.manual) toastr.info('The model believes that this building has no scenes worthy of illustration.', 'BaiBai Image');
      else console.debug(`[BaiBai Image] No. ${floor} No illustration required`);
      return;
    }

    // Fires MESSAGE_EDITED / MESSAGE_UPDATED; cards consume the mark on hydration/mount and start generating automatically
    // (see floor/autoGenerate.ts); if write-back fails the mark is revoked.
    // A single-slot rewrite is the user's explicit intent on the card (like "Apply and regenerate" in the prompt editor dialog),
    // so it isn't bound by the autoTag.autoGenerate toggle and always force-generates.
    const markSwipeId = message.swipe_id ?? 0;
    const marked = plan.images.length > 0 && (settings.autoTag.autoGenerate || !!slot);
    if (marked) {
      if (slot) {
        markForAutoGenerate(chatId, floor, markSwipeId, slot.seq, 'force');
      } else {
        for (let seq = 0; seq < plan.images.length; seq++) {
          markForAutoGenerate(chatId, floor, markSwipeId, seq);
        }
      }
    }
    // The text is computed in buildNext from "the real text at the moment of writing": edits other plugins made during the analysis
    // (translation/polishing/appended status bars/rewritten sentences) are all preserved, and tags are relocated by narrative line and injected as usual.
    let rebaseNote = '';
    const result = await applyMessageText(
      floor,
      currentText => {
        // Single-slot rewrite: replace only tag number seq; the text and other tags stay untouched, and no relocation is needed.
        // The position the model returns deliberately plays no part here: the scene is pinned in place; the model only rewrites the content.
        // The raw text snapshotted at start doesn't match = changed by the user/another flow meanwhile; don't overwrite (same as the prompt editor dialog).
        if (slot) {
          if (parseImageTags(currentText)[slot.seq] !== slotRawTag) return null;
          return replaceImageTagAt(currentText, slot.seq, serializeImageTag(plan.images[0]));
        }
        // The replace path likewise strips old tags with the current text as base; the old snapshot can't be used
        const base = opts.replace ? stripImageTags(currentText) : currentText;
        if (!plan.images.length) return base;
        // The user/another plugin already added tags during the request: injecting again would duplicate, so return build-failed and take the abandon branch
        if (!opts.replace && hasImageTagTrace(currentText)) return null;
        const rebased = rebaseImagePositions(
          base,
          preparedTarget.segments,
          plan.images,
          settings.excludes.customStripTags,
        );
        if (!rebased) return null;
        rebaseNote = describeRebase(rebased.report);
        return injectImageTags(base, rebased.images);
      },
      chatId,
      swipeId,
      message,
      // Single slot writes nothing extra: this floor's character delta and other slots' images aren't its business; not passing extraUpdate leaves them as-is.
      slot
        ? undefined
        : {
            key: BBI_CHAR_EXTRA_KEY,
            value: makeCharTagFloorDelta(floorOps, swipeId ?? 0),
          },
    );
    if (result === 'saved') {
      if (slot) {
        toastr.success(`rewritten ${slot.seq + 1} image’s prompt word, the picture is being produced according to the new prompt word`, 'BaiBai Image');
        return;
      }
      recomputeCharTags();
      if (rebaseNote) console.info(`[BaiBai Image] Floor ${floor} tag relocation: ${rebaseNote}`);
      if (plan.images.length) {
        toastr.success(`Already in the ${floor} floor insert ${plan.images.length} Personality chart tag`, 'BaiBai Image');
      } else if (opts.manual) {
        toastr.info('The model believes that this building has no scenes worthy of illustration.', 'BaiBai Image');
      } else {
        console.debug(`[BaiBai Image] No. ${floor} No illustration required`);
      }
      return;
    }
    // Revoke only our own mark: clearAutoGenerateForFloor would also clear pending marks for other slots on the same floor.
    if (marked) {
      if (slot) consumeAutoGenerate(chatId, floor, markSwipeId, slot.seq);
      else clearAutoGenerateForFloor(chatId, floor);
    }
    console.info(`[BaiBai Image] Floor ${floor} gave up writing image tags: ${result}`);
    // A single-slot rewrite abandons for a different reason than the full run: whether other parts of the text changed doesn't matter; what matters is that this one tag was changed
    if (slot && result === 'build-failed') {
      toastr.warning('The prompt word of this picture has been changed during generation, and it has not been overwritten this time.', 'BaiBai Image');
    } else {
      toastr.warning(ABANDON_REASON[result] ?? 'There is no raw picture tag written this time', 'BaiBai Image');
    }
  } catch (error) {
    // When the request fails or is cancelled by a chat switch, allow the same text to be retried after a later re-render.
    processed.delete(identity);
    // If the error happened after the marks were set (e.g. a save failure rolled back), revoke this floor's marks, leaving nothing behind.
    // A single slot revokes only its own mark: clearAutoGenerateForFloor would also clear pending marks for other slots on the same floor.
    if (slot) consumeAutoGenerate(chatId, floor, swipeId ?? 0, slot.seq);
    else clearAutoGenerateForFloor(chatId, floor);
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[BaiBai Image] No. ${floor} Floor automatic generation tag failed`, error);
    toastr.error(message, 'BaiBai Image automatic tag failed');
  } finally {
    if (running.get(runKey) === controller) running.delete(runKey);
  }
}

function cancelAll(): void {
  diagnostic('cancelAll', { scheduled: scheduled.size, running: running.size });
  clearGeneration();
  for (const timer of scheduled) clearTimeout(timer);
  scheduled.clear();
  for (const controller of running.values()) controller.abort();
  running.clear();
}

function scheduleForGeneratedFloor(floor: number, chatId: string): void {
  diagnostic('schedule', { floor, chatId });
  const timer = setTimeout(() => {
    scheduled.delete(timer);
    const currentChatId = getContext()?.getCurrentChatId?.() ?? '';
    diagnostic('schedule:fire', { floor, chatId, currentChatId, sameChat: currentChatId === chatId });
    if (currentChatId !== chatId) return;
    void runForFloor(floor);
  }, 0);
  scheduled.add(timer);
}

/**
 * Manual entry point for the floor button. replace=true is for "regenerate existing tags":
 * remove old tags → analyse → write back new tags (old tags disappear with the write-back; old images stay in the card history).
 */
export async function requestFloorTags(floor: number, opts: { replace?: boolean } = {}): Promise<void> {
  await runForFloor(floor, { manual: true, replace: opts.replace });
}

/**
 * Manual entry point for "AI rewrite prompt": rewrites and replaces only tag number seq (0-based).
 *
 * The entry is in the prompt editor dialog (floor/promptEditor.ts): editing by hand and by AI are two means to the same end.
 * The caller hands this function to runTagPlan in floor/tagPlanState.ts: the request's lifetime belongs to that
 * store, so **closing the dialog doesn't interrupt the rewrite**.
 *
 * It still depicts the original moment: write-back replaces in place by seq and the model's returned position plays no part; for the wording rule see
 * slotPlan.buildSlotTaskNote (which feeds this slot's current prompt back as the anchor).
 * The analysis base strips all old tags (the AI shouldn't take tags for story text), and output is forced to 1 image; other tags and images on this floor
 * stay untouched, and the old image stays in this slot's history. This run's AI changes are always ignored (profiles were created by the first full analysis).
 */
export async function requestSlotTag(floor: number, seq: number): Promise<void> {
  await runForFloor(floor, { manual: true, slot: { seq } });
}

/** Aborts a floor's in-flight tag request (full analysis and single-slot rewrite share the same "one per floor" lock). */
export function cancelFloorTags(floor: number): void {
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  running.get(`${chatId}\u0000${floor}`)?.abort();
}

/** Only pair automatic tagging with the final render of a real ST generation. */
export function bindAutoTagging(): void {
  if (bound) {
    diagnostic('bind:skip', { reason: 'already-bound' });
    return;
  }
  const context = getContext();
  const events = context?.eventTypes;
  if (!context?.eventSource || !events?.GENERATION_STARTED || !events.CHARACTER_MESSAGE_RENDERED) {
    diagnostic('bind:skip', {
      reason: 'missing-events',
      hasContext: Boolean(context),
      hasEventSource: Boolean(context?.eventSource),
      generationStarted: events?.GENERATION_STARTED ?? null,
      characterRendered: events?.CHARACTER_MESSAGE_RENDERED ?? null,
    });
    return;
  }
  bound = true;

  diagnostic('bind', {
    generationStarted: events.GENERATION_STARTED,
    characterRendered: events.CHARACTER_MESSAGE_RENDERED,
    generationEnded: events.GENERATION_ENDED ?? null,
    generationStopped: events.GENERATION_STOPPED ?? null,
    chatChanged: events.CHAT_CHANGED,
  });
  context.eventSource.on(
    events.GENERATION_STARTED,
    (type: unknown, options: unknown, dryRun: unknown) => {
      const chatId = getContext()?.getCurrentChatId?.() ?? '';
      const eligible = Boolean(
        chatId && !dryRun && typeof type === 'string' && type !== 'quiet' && type !== 'impersonate',
      );
      diagnostic('GENERATION_STARTED', { chatId, type, dryRun, eligible, options });
      beginGeneration(chatId, type, dryRun);
    },
  );
  context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    const matched = consumeGeneration(chatId, type);
    diagnostic('CHARACTER_MESSAGE_RENDERED', { chatId, messageId, type, matched });
    if (!matched) return;
    const floor = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) {
      diagnostic('render:skip', { chatId, messageId, type, reason: 'invalid-floor' });
      return;
    }
    // Do not block ST finalization, and pin the deferred run to the originating chat.
    scheduleForGeneratedFloor(floor, chatId);
  });
  if (events.GENERATION_ENDED) {
    context.eventSource.on(events.GENERATION_ENDED, (...args: unknown[]) => {
      // ST may emit this before the final CHARACTER_MESSAGE_RENDERED; that render consumes the gate.
      diagnostic('GENERATION_ENDED', { args, action: 'keep-pending-until-final-render' });
    });
  }
  if (events.GENERATION_STOPPED) {
    context.eventSource.on(events.GENERATION_STOPPED, (...args: unknown[]) => {
      diagnostic('GENERATION_STOPPED', { args });
      clearGeneration();
    });
  }
  context.eventSource.on(events.CHAT_CHANGED, (...args: unknown[]) => {
    diagnostic('CHAT_CHANGED', { args, currentChatId: getContext()?.getCurrentChatId?.() ?? '' });
    cancelAll();
  });
}
