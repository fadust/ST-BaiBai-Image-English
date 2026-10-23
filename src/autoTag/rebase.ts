/**
 * Moves the model's insertion positions from "the story text when the request started" to "the story text at write-back".
 *
 * Why: the secondary API analysis takes seconds to tens of seconds, and other plugins often change the text meanwhile (translation, polishing, appended status bars,
 * rewriting stock phrases). The old implementation compared the whole text before writing back and gave up on any difference, even when the change
 * had nothing to do with the image, so the tags were not injected at all. Now it re-locates using "cleaned narrative lines" as anchors: changes to unrelated parts
 * leave positions untouched, and a sentence that really was rewritten still lands at its matching position in the new text, so tags are no longer lost.
 *
 * Alignment: the two segment lists (output of prepareTargetText, naturally containing only the narrative lines that survived cleanup)
 * first get a longest-common-subsequence skeleton by text equality; the gaps between skeleton points are paired by index proportion. A gap with one old and one new line
 * is exactly "that sentence was rewritten", an exact hit rather than an approximation; a line that vanished entirely falls back to the previous paired anchor.
 *
 * Landing points can only be segments of the current text, never raw line numbers: that way a tag can never drop inside a
 * status-bar block another plugin just appended, since such blocks are not segments after cleanup.
 */

import { prepareTargetText, type TargetSegment } from '@/autoTag/clean';
import type { ImageInsertion } from '@/autoTag/protocol';

/** Above this size the O(n*m) DP is skipped. Normal floors have far fewer narrative lines; beyond it, mapping is proportional only. */
const LCS_CELL_LIMIT = 250_000;

/**
 * Longest common subsequence by text equality; returns increasing (old index, new index) pairs.
 * When the size limit is exceeded it returns an empty skeleton and the caller maps everything proportionally (degraded but never wrong).
 */
function lcsPairs(oldTexts: string[], newTexts: string[]): Array<[number, number]> {
  const n = oldTexts.length;
  const m = newTexts.length;
  if (!n || !m || n * m > LCS_CELL_LIMIT) return [];

  // dp[i][j] = LCS length of oldTexts[i..] and newTexts[j..] (flattened to 1D, row width m+1)
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldTexts[i] === newTexts[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTexts[i] === newTexts[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Map from old segment index → new segment index; unmatched positions stay -1.
 * The skeleton (lines whose text exists unchanged) is pinned first, then the gaps it leaves are paired by index proportion.
 */
function alignSegments(oldTexts: string[], newTexts: string[]): number[] {
  const mapped = new Array<number>(oldTexts.length).fill(-1);
  const skeleton = lcsPairs(oldTexts, newTexts);

  let prevOld = -1;
  let prevNew = -1;
  const fillGap = (oldEnd: number, newEnd: number): void => {
    const oldLen = oldEnd - prevOld - 1;
    const newLen = newEnd - prevNew - 1;
    if (oldLen <= 0 || newLen <= 0) return;
    for (let k = 0; k < oldLen; k += 1) {
      mapped[prevOld + 1 + k] = prevNew + 1 + Math.floor((k * newLen) / oldLen);
    }
  };

  for (const [i, j] of skeleton) {
    fillGap(i, j);
    mapped[i] = j;
    prevOld = i;
    prevNew = j;
  }
  fillGap(oldTexts.length, newTexts.length);
  return mapped;
}

/** From index, searches backwards for the nearest paired position, then forwards if none. Returns -1 if there are none at all. */
function nearestMapped(mapped: number[], index: number): number {
  for (let i = index; i >= 0; i -= 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  for (let i = index + 1; i < mapped.length; i += 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  return -1;
}

export interface RebaseReport {
  /** Anchor sentence exists unchanged: the position is effectively unmoved. */
  anchored: number;
  /** Anchor sentence was rewritten: lands on its matching sentence in the new text per the alignment. */
  remapped: number;
  /** Anchor sentence vanished entirely: carried to the previous anchor (better slightly off than losing the tag). */
  drifted: number;
}

export interface RebaseResult {
  images: ImageInsertion[];
  report: RebaseReport;
}

/**
 * Recomputes each image's insertion line against the current text.
 *
 * plannedSegments is the segment list the model saw at the time (preparedTarget.segments in the runner);
 * currentText is the text base about to be written back. The returned images are sorted by new line number ascending (same line keeps the original relative order)
 * and can be passed straight to injectImageTags.
 *
 * Returns null only when there is truly nothing to work with: the current text has no narrative line left after cleanup, so any landing point would be a guess.
 * Rewritten sentences, deleted sentences and whole appended passages are not that case; they always get a landing point.
 */
export function rebaseImagePositions(
  currentText: string,
  plannedSegments: TargetSegment[],
  images: ImageInsertion[],
  stripTags: string[],
): RebaseResult | null {
  const report: RebaseReport = { anchored: 0, remapped: 0, drifted: 0 };
  if (!images.length) return { images: [], report };

  const newSegments = prepareTargetText(currentText, stripTags).segments;
  if (!newSegments.length) return null;

  const oldByLine = new Map(plannedSegments.map((segment, index) => [segment.sourceLine, index]));
  const mapped = alignSegments(
    plannedSegments.map(segment => segment.text),
    newSegments.map(segment => segment.text),
  );

  const out: ImageInsertion[] = [];
  for (const image of images) {
    const oldIndex = oldByLine.get(image.sourceLine);
    // sourceLine comes from plannedSegments in the first place; a mismatch means the caller passed the wrong list
    if (oldIndex === undefined) return null;
    const direct = mapped[oldIndex];
    const target = direct >= 0 ? direct : nearestMapped(mapped, oldIndex);
    if (target < 0) return null;

    if (direct < 0) report.drifted += 1;
    else if (newSegments[target].text === plannedSegments[oldIndex].text) report.anchored += 1;
    else report.remapped += 1;
    out.push({ ...image, sourceLine: newSegments[target].sourceLine });
  }

  // Ascending order keeps narrative order monotonic; sort is stable, so images landing on the same line keep the model's original relative order
  out.sort((left, right) => left.sourceLine - right.sourceLine);
  return { images: out, report };
}
