import { describe, expect, it } from 'vitest';

import { prepareTargetText } from '@/autoTag/clean';
import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import { rebaseImagePositions } from '@/autoTag/rebase';

function image(sourceLine: number, tag: string): ImageInsertion {
  return {
    position: `P${sourceLine}`,
    sourceLine,
    tag,
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
  };
}

/** Per the runner's rule: the segment list the model sees comes from the text at the start of the request. */
function plan(text: string, stripTags: string[] = []) {
  return prepareTargetText(text, stripTags).segments;
}

/** Placement assertions look at "which sentence the tag sticks after", closer than line numbers to what users can observe. */
function lineAfterTag(text: string, tag: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex(line => line.includes(`<bbi_image>${tag}`));
  return index > 0 ? lines[index - 1] : '';
}

describe('rebaseImagePositions', () => {
  it('text unchanged: positions do not move at all', () => {
    const text = '第一句\n第二句\n第三句';
    const segments = plan(text);
    const result = rebaseImagePositions(text, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(result?.report).toEqual({ anchored: 1, remapped: 0, drifted: 0 });
  });

  it('another plugin appends content at the end: the skeleton fully matches, positions do not move', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `${before}\n<statusbar>好感度 +1</statusbar>\n追加的旁注`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    expect(result?.report.anchored).toBe(2);
  });

  it('another plugin inserts content at the start: positions shift as a whole, still right after the original sentence', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `插进来的新首句\n${before}`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(2);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第二句');
    expect(result?.report.anchored).toBe(1);
  });

  it('a stock phrase is rewritten: the tag follows to after the rewritten sentence (the core scenario)', () => {
    const before = '第一句\n【状态】好感度:低\n第三句';
    const after = '第一句\n【状态】好感度:中等偏上\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('【状态】好感度:中等偏上');
    expect(result?.report).toEqual({ anchored: 0, remapped: 1, drifted: 0 });
  });

  it('the whole text is polished (every sentence reworded): aligned sentence by sentence, not one image lost', () => {
    const before = '她走进房间\n窗外下着雨\n他抬起头';
    const after = '她缓步走进了房间\n窗外正下着细雨\n他慢慢抬起头';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('她缓步走进了房间');
    expect(lineAfterTag(injected, 'b')).toBe('他慢慢抬起头');
    expect(result?.report.remapped).toBe(2);
  });

  it('the anchor sentence is deleted entirely: carried to the previous paragraph, the tag is not lost', () => {
    const before = '第一句\n第二句\n第三句';
    const after = '第一句\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(0);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第一句');
    expect(result?.report.drifted).toBe(1);
  });

  it('multiple images keep narrative order monotonic', () => {
    const before = '一\n二\n三\n四';
    const after = '一\n二改了\n三\n四';
    const segments = plan(before);
    const result = rebaseImagePositions(
      after,
      segments,
      [image(3, 'd'), image(0, 'a'), image(1, 'b')],
      [],
    );
    const lines = result!.images.map(i => i.sourceLine);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
    expect(lines).toEqual([0, 1, 3]);
  });

  it('landing points only use cleaned narrative lines: tags never drop into an appended status-bar block', () => {
    const before = '第一句\n第二句';
    const after = '第一句\n<snow>\n块内第一行\n块内第二行\n</snow>\n第二句';
    const segments = plan(before, ['snow']);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], ['snow']);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('第二句');
    // The inside of a block must not be split
    expect(injected).toContain('<snow>\n块内第一行\n块内第二行\n</snow>');
  });

  it('text emptied/only noise left: returns null so the caller gives up', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('', segments, [image(0, 'a')], [])).toBeNull();
    expect(rebaseImagePositions('<snow>只剩状态栏</snow>', segments, [image(0, 'a')], ['snow']))
      .toBeNull();
  });

  it('with no images it returns an empty result directly (text untouched)', () => {
    const result = rebaseImagePositions('随便', plan('随便'), [], []);
    expect(result).toEqual({ images: [], report: { anchored: 0, remapped: 0, drifted: 0 } });
  });

  it('sourceLine not in the given segment list: treated as a caller error, returns null', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('第一句\n第二句', segments, [image(99, 'a')], [])).toBeNull();
  });

  it('repeated sentences do not all collapse onto the same line', () => {
    const before = '同一句\n中间\n同一句';
    const after = '同一句\n中间改了\n同一句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
  });
});
