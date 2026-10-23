import { describe, expect, it } from 'vitest';

import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import { serializeImageTag } from '@/st/imageTagRegex';

function tag(text: string, nl = ''): string {
  return serializeImageTag({ tag: text, nl, negative: '', characters: [], size: 'portrait' });
}

describe('buildSlotTaskNote', () => {
  it('says to rewrite only image N with the scene unchanged, and requires exactly 1 image', () => {
    const source = [
      `正文`,
      tag('1girl, classroom'),
      tag('1boy, rooftop', 'A boy on the roof.'),
      tag('cat, windowsill'),
    ].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('【Rewrite only image 2\'s prompt】');
    expect(note).toContain('Do not choose another scene');
    expect(note).toContain('The images array must return exactly 1 item');
  });

  /**
   * This is the crux of the feature: the write-back side replaces in place by seq and never looks at the position the model returns,
   * so "whether the scene changes" is decided entirely by this wording. The old version said "choose another moment clearly different
   * from them", so the button said "Rewrite prompt" while the model was told "change the scene".
   *
   * Note that only the **imperative** form can be locked: "Do not choose another scene" is a prohibition and contains "choose another", which is exactly what we want,
   * so it can't simply assert that "choose another" is absent. The Chinese strings below guard against the old upstream wording returning in a merge.
   */
  it('never contains imperative wording that makes the model choose another scene', () => {
    const note = buildSlotTaskNote([tag('1girl, classroom'), tag('1boy, rooftop')].join('\n'), 0);
    expect(note).not.toContain('请为这一张另选');
    expect(note).not.toContain('明显不同的瞬间');
    expect(note).not.toContain('重选');
    expect(note).not.toMatch(/\b(?:please )?choose (?:a different|another) moment\b/i);
    expect(note).not.toMatch(/clearly different (?:moment|scene)/i);
    // The prohibition must be present
    expect(note).toContain('Do not choose another scene');
  });

  it('feeds the current prompt of the target slot back verbatim as the anchor (not truncated)', () => {
    const long = `1girl, ${'detail, '.repeat(60)}classroom`;
    const note = buildSlotTaskNote([tag(long), tag('cat')].join('\n'), 0);
    expect(note).toContain('Current prompt for this image');
    // The anchor is for the model to compare word for word, so it must be included in full; truncating it would mean letting it guess the scene
    expect(note).toContain(long);
  });

  it('lists the other images, skipping the target slot, and says not to take over their scenes', () => {
    const source = [tag('1girl, classroom'), tag('1boy, rooftop'), tag('cat, windowsill')].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('Image 1: 1girl, classroom');
    expect(note).not.toContain('Image 2: ');
    expect(note).toContain('Image 3: cat, windowsill');
    expect(note).toContain('do not take over their scenes');
  });

  it('a single-image floor has only the instructions, with no list of other images', () => {
    const note = buildSlotTaskNote(tag('1girl, sunset'), 0);
    expect(note).toContain('【Rewrite only image 1\'s prompt】');
    expect(note).not.toContain('Other images in this message');
    // Single-image floors still get the anchor
    expect(note).toContain('1girl, sunset');
  });

  it('does not throw when the text has no tags, and does not invent an anchor (edge tolerance)', () => {
    const note = buildSlotTaskNote('纯正文', 0);
    expect(note).toContain('【Rewrite only image 1\'s prompt】');
    expect(note).not.toContain('Other images in this message');
    expect(note).not.toContain('Current prompt for this image');
  });

  it('summaries of other images are squeezed onto one line and truncated, avoiding pouring whole prompts into the note', () => {
    const long = 'x'.repeat(400);
    const source = [tag('aaa'), tag(long)].join('\n');
    // The target is image 1, so image 2 uses the "other scenes" summary rule → must be truncated
    const note = buildSlotTaskNote(source, 0);
    expect(note).toContain('Image 2: ');
    expect(note).not.toContain(long);
    expect(note).toContain('…');
    // No newline may leak into the list between the tag / nl sections (parseImageTagContent folds newlines inside nl into spaces;
    // what is locked here is that the separator between sections is squeezed onto one line too)
    const withNl = buildSlotTaskNote(
      [tag('aaa'), tag('1girl', 'A girl.\nSecond line.')].join('\n'),
      0,
    );
    expect(withNl).toContain('Image 2: 1girl / A girl. Second line.');
  });
});
