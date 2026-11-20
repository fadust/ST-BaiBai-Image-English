import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { codexAppearance } from '@/autoTag/codexAppearance';
import {
  applyPositionedCharRefs,
  resolveCharAnchors,
  type PositionedCharOp,
} from '@/autoTag/charAnchors';
import { prepareTargetText } from '@/autoTag/clean';
import { auditLayers, formatLayerAudits, repairTagAges } from '@/autoTag/dupes';
import { beginGeneration, clearGeneration, consumeGeneration } from '@/autoTag/generationGate';
import { focusImageCount, passageTaskNote } from '@/rewriteHint/passage';
import { addFocusedTags, addedExtraUpdates, dropAddedMark, pinFocusPosition } from '@/rewriteHint/move';
import { focusSourceUpdate } from '@/rewriteHint/sources';
import { autoTagProfile, buildAutoTagMessages } from '@/autoTag/prompt';
import { rebaseImagePositions, type RebaseReport } from '@/autoTag/rebase';
import { auditFrames, formatFrameAudits } from '@/autoTag/shotspec';
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
  markForAutoGenerate,
} from '@/floor/autoGenerate';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { getContext, isAiStoryMessage, type STMessage } from '@/st/context';
import {
  hasImageTagTrace,
  parseImageTags,
  serializeImageTag,
  stripImageTags,
  type ImageTagContent,
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

interface SlotRewriteTarget {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  rawTag: string;
}

export interface SlotRewritePreview {
  content: ImageTagContent;
  rawTag: string;
  message: STMessage;
  swipeId: number | null;
  matchesScene: (text: string) => boolean;
}

interface RunOptions {
  /** Manual trigger (floor button): bypasses autoTag.enabled and processed deduplication; gives feedback even for empty results. */
  manual?: boolean;
  /** Regenerate: removes existing tags from the text before analysing/injecting; old images stay in the card history. */
  replace?: boolean;
  /** The editor owns saving and redrawing a single-slot rewrite. */
  slot?: SlotRewriteTarget;
  focus?: string;
  add?: boolean;
}

/** User-readable reason for abandoning the write. Text changes are no longer among them; that is normal and gets rebased and written as usual. */
const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': 'The chat was switched, so no image tags were written',
  'floor-changed': 'This floor was deleted or replaced, so no image tags were written',
  'swipe-changed': 'The swipe changed, so no image tags were written',
  'build-failed': 'The floor text was heavily rewritten or already has image tags, so none were written',
  unavailable: 'The current chat cannot be written to, so no image tags were written',
};

/** One-line summary of the relocation result; empty string when everything hit in place (nothing to log). */
function describeRebase(report: RebaseReport): string {
  if (!report.remapped && !report.drifted) return '';
  const parts = [`in place ${report.anchored}`];
  if (report.remapped) parts.push(`followed reworded sentence ${report.remapped}`);
  if (report.drifted) parts.push(`moved to previous paragraph ${report.drifted}`);
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

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<boolean | SlotRewritePreview | void> {
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
    abort(floor, 'missing-context', opts.manual, 'SillyTavern is not ready yet. Try again shortly.');
    return;
  }
  if (!settings.enabled) {
    abort(floor, 'extension-disabled', opts.manual, 'BaiBai Image is turned off. Turn it on in the plugin settings first.');
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
  if (opts.focus && running.has(`${context.getCurrentChatId()}\u0000${floor}`)) {
    toastr.info('Image planning is already running for this message. Try again when it finishes.', 'BaiBai Image');
    return;
  }
  const rawSource = message.mes;
  const slot = opts.slot;
  const chatId = context.getCurrentChatId?.() ?? '';
  const swipeId = activeSwipeId(message);
  if (slot && (slot.chatId !== chatId || slot.swipeId !== (swipeId ?? 0)
    || parseImageTags(rawSource)[slot.seq] !== slot.rawTag)) {
    abort(floor, 'slot-changed', true, 'The original image prompt changed. Reopen the prompt editor to start a new rewrite.');
    return;
  }
  // Detection shares its source with the button layer (imageTagRegex.hasImageTagTrace): the two once drifted:
  // the button only recognised open tags while this recognised both, so a floor with only `</bbi_image>` left got stuck at "clicked, nothing happened".
  // A single-slot rewrite presupposes "this floor already has tags", so this gate doesn't block it.
  if (hasImageTagTrace(rawSource) && !opts.replace && !slot && !opts.add) {
    abort(
      floor,
      'already-has-image-tag',
      opts.manual,
      'This floor already has image tags and regeneration was not confirmed, so nothing changed.',
    );
    if (!opts.manual) console.debug(`[BaiBai Image] No. ${floor} Floor already contains bbi_image tag, skip automatic analysis`);
    return;
  }
  // replace / slot: analysis is based on the text with old tags removed. On write-back, replace makes the old tags disappear with it;
  // slot replaces in place by seq, and other tags stay intact in the write-back base.
  const source = opts.replace || slot || opts.add ? stripImageTags(rawSource) : rawSource;
  if (!source.trim()) {
    abort(floor, 'empty-source', opts.manual, 'This floor has no text (or only image tags), so there is nothing to analyse.');
    return;
  }
  const preparedTarget = prepareTargetText(source, settings.excludes.customStripTags);
  if (!preparedTarget.segments.length) {
    abort(
      floor,
      'no-target-segments',
      opts.manual,
      'No story text is left after cleaning this floor (the cleanup tag list or the reasoning/annotation rules may have removed all of it), so there is nothing to analyse.',
      { sourceLength: source.length },
    );
    return;
  }

  if (!chatId) {
    abort(floor, 'missing-chat-id', opts.manual, 'No chat is open, so no image tags were generated');
    return;
  }
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
    const entriesBefore = slot || opts.add ? charTagsBeforeFloor(floor + 1) : charTagsBeforeFloor(floor);
    // Locked names (global library ⊖ this chat's baseline): AI changes never apply to these names; they carry a [locked] marker in the library text
    const codex = codexAppearance(context, floor, rawSource, entriesBefore, lockedCharTagNames(), memory?.roles.map(role => role.name));
    const lockedNames = codex.locked;
    // Purely local rendering: profile creation is done by the main request in the same output (changes with field="new")
    const profile = autoTagProfile();
    const anchors = resolveCharAnchors(codex.entries, lockedNames, profile.dialect === 'moss' || profile.dialect === 'moss-anime');
    // Single-slot rewrite: the protocol forces "exactly 1 image" and gives the model this slot's current prompt plus summaries of the other slots
    // (anchoring the same scene and not taking others' scenes). min/max must cover both the rule text in build and the parse validation below;
    // changing only one would contradict itself.
    const promptOptions = opts.focus
      ? { ...settings.autoTag, minImages: focusImageCount(opts.focus), maxImages: focusImageCount(opts.focus) }
      : slot
      ? { ...settings.autoTag, minImages: 1, maxImages: 1 }
      : settings.autoTag;
    // Snapshot the protocol shape once at start: protocol writing, validation and finishing share it, so a toggle flipped midway can't make them disagree
    const messages = await buildAutoTagMessages(
      context,
      floor,
      promptOptions,
      memory,
      preparedTarget,
      anchors.text,
      slot ? buildSlotTaskNote(rawSource, slot.seq) : opts.focus ? passageTaskNote(opts.focus) : '',
      profile,
      codex.note,
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
            !slot && !opts.add &&
            profile.naiCharPrompts &&
            profile.nl &&
            candidate.changes.some(change => change.field === 'new' && !change.nl?.trim())
          ) {
            throw new Error('NAI 4.5/V5 profiles must include an nl appearance description');
          }
          // Mechanically repair age conflicts in tags; do not fail the run over a string fix.
          // Composition / cross-layer issues stay warn-only (see shotspec / dupes audits below).
          const repairs: string[] = [];
          for (const image of candidate.images) {
            const fixed = repairTagAges(image.tag);
            if (!fixed.removed.length) continue;
            image.tag = fixed.tag;
            repairs.push(fixed.removed.join(', '));
          }
          if (repairs.length) {
            console.warn(
              '[BaiBai Image] Removed duplicate/conflicting ages from tags:',
              [...new Set(repairs)].join(' / '),
            );
            toastr.info(
              `Removed duplicate or conflicting ages from the prompt (${[...new Set(repairs)].join(', ')}); the image run continues.`,
              'BaiBai Image',
            );
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
        'BaiBai Image auto-tagging failed',
      );
      return;
    }

    // Single-slot rewrites do not apply changes: the first full analysis already created profiles for the whole floor; applying again would only produce
    // duplicate profile/change records. The library text already includes this floor's delta (see entriesBefore above); the AI just copies it.
    if (!codex.isCurrent()) throw new Error('NPC Codex appearance changed during image planning. Run image planning again.');
    if (opts.focus) pinFocusPosition(plan.images, preparedTarget.segments, opts.focus);
    const planOps = slot || opts.add ? [] : planChangeOps(plan);
    // Locked characters (global library) don't accept AI changes: discard them; they are not written to the floor and take no part in @ replacement.
    // The replay side's applyCharTagOps blocks locked names again (old messages may already hold such ops).
    const effectiveOps = lockedNames.size
      ? planOps.filter(item => !lockedNames.has(item.op.name) && !lockedNames.has(item.op.name.normalize('NFKC').toLocaleLowerCase().trim()))
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

    // Pre-image text audits: warn only, never branch the run (see autoTag/shotspec and autoTag/dupes).
    // Runs after placeholder replacement so audits see the final tag/nl that would be submitted.
    if (plan.images.length) {
      try {
        const shotNotes = formatFrameAudits(
          auditFrames(
            plan.images.map(image => ({ tag: image.tag, nl: image.nl, size: image.size })),
            { orientation: profile.lockedSize ?? undefined },
          ),
        );
        if (shotNotes) console.warn(`[BaiBai Image] Composition audit:\n${shotNotes}`);

        const layerNotes = formatLayerAudits(
          auditLayers(
            plan.images.map(image => ({
              tag: image.tag,
              nl: image.nl,
              // Chinese appearance is injected later in Card.vue; runner only audits tag/nl here.
              only: 'tag' as const,
            })),
          ),
        );
        if (layerNotes) console.warn(`[BaiBai Image] Cross-layer duplicates:\n${layerNotes}`);
      } catch (error) {
        console.warn('[BaiBai Image] Pre-image audit failed (ignored)', error);
      }
    }

    if (slot) {
      const { tag, nl, negative, characters, size } = plan.images[0];
      return {
        content: { tag, nl, negative, characters, size },
        rawTag: slot.rawTag,
        message,
        swipeId,
        matchesScene: text => stripImageTags(text) === source && codex.isCurrent(),
      };
    }
    // With no images, no character changes and no old floor changes to clean up, keep the original early exit without writing.
    if (!plan.images.length && !floorOps.length && !previousDelta) {
      if (opts.manual) toastr.info('The model found no scene worth illustrating on this floor.', 'BaiBai Image');
      else console.debug(`[BaiBai Image] Floor ${floor}: no illustration needed`);
      return;
    }

    // Fires MESSAGE_EDITED / MESSAGE_UPDATED; cards consume the mark on hydration/mount and start generating automatically
    // (see floor/autoGenerate.ts); if write-back fails the mark is revoked.
    const markSwipeId = message.swipe_id ?? 0;
    const marked = !opts.add && plan.images.length > 0 && (settings.autoTag.autoGenerate || !!opts.focus);
    if (marked) {
      for (let seq = 0; seq < plan.images.length; seq++) {
        markForAutoGenerate(chatId, floor, markSwipeId, seq);
      }
    }
    // The text is computed in buildNext from "the real text at the moment of writing": edits other plugins made during the analysis
    // (translation/polishing/appended status bars/rewritten sentences) are all preserved, and tags are relocated by narrative line and injected as usual.
    let rebaseNote = '';
    const result = await applyMessageText(
      floor,
      currentText => {
        if (!codex.isCurrent()) return null;
        if (opts.add) {
          // Do not reorder slots if the story or existing prompts changed during planning.
          if (currentText !== rawSource) return null;
          return addFocusedTags(currentText, { chatId, floor, swipeId: markSwipeId }, plan.images.map(image => ({ tag: serializeImageTag(image), passageId: image.position })));
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
      // Text, slot positions, prompt history, and scene markers commit or roll back together.
      [
        ...(opts.add ? addedExtraUpdates(floor) : [{ key: BBI_CHAR_EXTRA_KEY, value: makeCharTagFloorDelta(floorOps, swipeId ?? 0) }]),
        ...(opts.focus ? [focusSourceUpdate(message.extra, markSwipeId, plan.images, preparedTarget.segments, opts.focus)] : []),
      ],
    );
    if (result === 'saved') {
      if (opts.focus) {
        if (!opts.add) recomputeCharTags();
        toastr.success(`Added ${plan.images.length} illustration(s) to message ${floor}. Existing images were kept.`, 'BaiBai Image');
        return true;
      }
      recomputeCharTags();
      if (rebaseNote) console.info(`[BaiBai Image] Floor ${floor} tag relocation: ${rebaseNote}`);
      if (plan.images.length) {
        toastr.success(`Inserted ${plan.images.length} image tag(s) into floor ${floor}`, 'BaiBai Image');
      } else if (opts.manual) {
        toastr.info('The model found no scene worth illustrating on this floor.', 'BaiBai Image');
      } else {
        console.debug(`[BaiBai Image] Floor ${floor}: no illustration needed`);
      }
      return;
    }
    if (opts.add) dropAddedMark();
    if (marked) clearAutoGenerateForFloor(chatId, floor);
    console.info(`[BaiBai Image] Floor ${floor} gave up writing image tags: ${result}`);
    toastr.warning(ABANDON_REASON[result] ?? 'No image tags were written this time', 'BaiBai Image');
  } catch (error) {
    // When the request fails or is cancelled by a chat switch, allow the same text to be retried after a later re-render.
    processed.delete(identity);
    // If the error happened after the marks were set (e.g. a save failure rolled back), revoke this floor's marks, leaving nothing behind.
    if (opts.add) dropAddedMark();
    else if (!slot) clearAutoGenerateForFloor(chatId, floor);
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[BaiBai Image] No. ${floor} Floor automatic generation tag failed`, error);
    toastr.error(message, 'BaiBai Image auto-tagging failed');
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

/** Plans a fresh prompt for the original scene without saving a tag, profile change, or image. */
export async function previewSlotRewrite(target: SlotRewriteTarget): Promise<SlotRewritePreview | null> {
  const result = await runForFloor(target.messageId, { manual: true, slot: target });
  return typeof result === 'object' ? result : null;
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

export async function requestFocusedTags(floor: number, focus: string): Promise<boolean> {
  if (!focus.trim()) return false;
  const add = hasImageTagTrace(getContext()?.chat?.[floor]?.mes ?? '');
  return (await runForFloor(floor, { manual: true, focus, add })) === true;
}
