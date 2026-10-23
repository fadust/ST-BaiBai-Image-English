import { describe, expect, it } from 'vitest';

import { nextEditorState } from '@/floor/promptEditor';

/**
 * After an "AI rewrite prompt" is saved, the dialog must reread this slot's tag from the text and refill the input box.
 *
 * The entry is in the edit dialog, while the rewrite writes the text independently via the runner: two writers share one tag.
 * The dialog's rawTag is the credential for the CAS write-back; if refilling forgot to refresh it, the user's next "Apply" would be
 * blocked by "this tag has been changed", and what changed it was exactly the rewrite they just triggered.
 */

const TAG_A = '<bbi_image><tag>1girl, classroom</tag></bbi_image>';
const TAG_B = '<bbi_image><tag>1girl, rooftop, sunset</tag></bbi_image>';
const TAG_C = '<bbi_image><tag>cat</tag></bbi_image>';

describe('nextEditorState', () => {
  it('the tag in the text was replaced: rawTag and content change together', () => {
    const next = nextEditorState(`前文 ${TAG_B} 后文`, 0, TAG_A);
    // The crux: both must update together; updating only content would make the next "Apply" hit the CAS
    expect(next?.rawTag).toBe(TAG_B);
    expect(next?.content.tag).toBe('1girl, rooftop, sunset');
  });

  it('takes by seq without touching other slots on the same floor', () => {
    const next = nextEditorState(`${TAG_C}\n${TAG_B}`, 1, TAG_A);
    expect(next?.rawTag).toBe(TAG_B);
  });

  it('does nothing when the raw text is unchanged (never overwrite the user draft with equivalent content)', () => {
    expect(nextEditorState(`前文 ${TAG_A} 后文`, 0, TAG_A)).toBeNull();
  });

  it('does nothing when seq no longer exists (tag deleted/count changed)', () => {
    expect(nextEditorState(TAG_A, 3, TAG_A)).toBeNull();
  });

  it('does nothing when the text cannot be read (the floor is gone)', () => {
    expect(nextEditorState(undefined, 0, TAG_A)).toBeNull();
  });
});
