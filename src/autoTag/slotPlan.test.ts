import { describe, expect, it } from 'vitest';

import { MAX_INSTRUCTION, buildSlotTaskNote } from '@/autoTag/slotPlan';
import { serializeImageTag } from '@/st/imageTagRegex';

function tag(text: string, nl = ''): string {
  return serializeImageTag({ tag: text, nl, negative: '', characters: [], size: 'portrait' });
}

describe('buildSlotTaskNote', () => {
  it('说明只重写第 N 张、画面不变,并要求恰好 1 张', () => {
    const source = [
      `正文`,
      tag('1girl, classroom'),
      tag('1boy, rooftop', 'A boy on the roof.'),
      tag('cat, windowsill'),
    ].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('【本次只重写第 2 张的提示词】');
    expect(note).toContain('不要另选画面');
    expect(note).toContain('images 数组必须恰好返回 1 项');
  });

  /**
   * 这条是本功能的命门:写回侧按 seq 原位替换、根本不看模型返回的 position,
   * 所以「换不换画面」完全由这段措辞决定。旧版写的是「另选一个与它们明显不同的
   * 瞬间」,导致按钮写着「重写提示词」、模型收到的却是「换个画面」。
   *
   * 注意只能锁**祈使**口径:「不要另选画面」是禁令,含「另选」二字却正是我们要的,
   * 所以不能简单断言不含「另选」。
   */
  it('绝不能出现让模型另选画面的祈使措辞', () => {
    const note = buildSlotTaskNote([tag('1girl, classroom'), tag('1boy, rooftop')].join('\n'), 0);
    expect(note).not.toContain('请为这一张另选');
    expect(note).not.toContain('明显不同的瞬间');
    expect(note).not.toContain('重选');
    // 禁令必须在场
    expect(note).toContain('不要另选画面');
  });

  it('把目标槽位当前的提示词原样喂回去当锚点(不截断)', () => {
    const long = `1girl, ${'detail, '.repeat(60)}classroom`;
    const note = buildSlotTaskNote([tag(long), tag('cat')].join('\n'), 0);
    expect(note).toContain('这一张当前的提示词');
    // 锚点是要模型逐字对照的,必须全文带上——被截断就等于让它猜画面
    expect(note).toContain(long);
  });

  it('列出其余画面时跳过目标槽位,并说明不要抢它们的画面', () => {
    const source = [tag('1girl, classroom'), tag('1boy, rooftop'), tag('cat, windowsill')].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('第 1 张：1girl, classroom');
    expect(note).not.toContain('第 2 张：');
    expect(note).toContain('第 3 张：cat, windowsill');
    expect(note).toContain('不要把它们的画面抢过来');
  });

  it('单张楼只有说明,没有其余画面清单', () => {
    const note = buildSlotTaskNote(tag('1girl, sunset'), 0);
    expect(note).toContain('【本次只重写第 1 张的提示词】');
    expect(note).not.toContain('本楼其余画面');
    // 单张楼照样要给锚点
    expect(note).toContain('1girl, sunset');
  });

  it('正文里没有 tag 时不抛错,也不编造锚点(边界容忍)', () => {
    const note = buildSlotTaskNote('纯正文', 0);
    expect(note).toContain('【本次只重写第 1 张的提示词】');
    expect(note).not.toContain('本楼其余画面');
    expect(note).not.toContain('这一张当前的提示词');
  });

  it('其余画面摘要压成单行并截断,避免把整段提示词灌进备注', () => {
    const long = 'x'.repeat(400);
    const source = [tag('aaa'), tag(long)].join('\n');
    // 目标是第 1 张,所以第 2 张走的是「其余画面」摘要口径 → 要截断
    const note = buildSlotTaskNote(source, 0);
    expect(note).toContain('第 2 张：');
    expect(note).not.toContain(long);
    expect(note).toContain('…');
    // tag / nl 两段之间不得带换行漏进清单(parseImageTagContent 会把 nl 内部换行折成空格,
    // 这里锁的是段与段之间的分隔符也被压成单行)
    const withNl = buildSlotTaskNote(
      [tag('aaa'), tag('1girl', 'A girl.\nSecond line.')].join('\n'),
      0,
    );
    expect(withNl).toContain('第 2 张：1girl / A girl. Second line.');
  });
});

/**
 * 「修改意见」(弹窗里新加的输入框):用户点「AI 重写提示词」时可以带一句具体要求,
 * runner 把它原样透传到这里的 options.instruction,由 buildSlotTaskNote 拼进任务备注。
 *
 * 这一组用例守两件事:
 * ① 有意见 → 意见必须原样出现在备注里,且位置在「目标提示词之后、本楼其余画面之前」;
 * ② 没意见(不传 / 空串 / 纯空白 / null)→ 输出与**加这个参数之前**逐字一致,
 *    这是既有 7 条用例与老调用方共同依赖的兼容性。
 */
describe('buildSlotTaskNote 的修改意见', () => {
  const source = [
    `正文`,
    tag('1girl, classroom'),
    tag('1boy, rooftop', 'A boy on the roof.'),
    tag('cat, windowsill'),
  ].join('\n');

  it('带意见时:出现意见原文与新标题', () => {
    const instruction = '机位别贴这么近，改成半身';
    const note = buildSlotTaskNote(source, 1, undefined, { instruction });
    expect(note).toContain('【本次重写必须满足的修改意见】');
    expect(note).toContain(instruction);
    // 两句约束:只按意见改 + 冲突时以意见为准但别改到别的槽位
    expect(note).toContain('只按这条意见改');
    expect(note).toContain('以意见为准');
  });

  it('空串 / 纯空白 / 不传 / null 四种写法:输出与旧版逐字相同', () => {
    const baseline = buildSlotTaskNote(source, 1);
    expect(buildSlotTaskNote(source, 1, undefined, {})).toBe(baseline);
    expect(buildSlotTaskNote(source, 1, undefined, { instruction: '' })).toBe(baseline);
    expect(buildSlotTaskNote(source, 1, undefined, { instruction: '   \n\t  ' })).toBe(baseline);
    // 脏输入(渲染层不该出现,但纯函数不该抛)—— RunOptions 里是可选字段,防御一下
    expect(
      buildSlotTaskNote(source, 1, undefined, {
        instruction: null as unknown as string,
      }),
    ).toBe(baseline);
    // 逐字一致的可观测证据:连「意见」这两个字都不该多出来
    expect(baseline).not.toContain('修改意见');
  });

  it('超长意见被截断到 MAX_INSTRUCTION 上限并加省略号', () => {
    const instruction = 'y'.repeat(MAX_INSTRUCTION + 200);
    const note = buildSlotTaskNote(source, 1, undefined, { instruction });
    expect(note).toContain('y'.repeat(MAX_INSTRUCTION));
    expect(note).not.toContain(instruction);
    expect(note).toContain(`${'y'.repeat(MAX_INSTRUCTION)}…`);
  });

  it('意见含换行与特殊字符时原样保留(它不进 prompt 结构,只进任务备注)', () => {
    const instruction = '第一行：机位别那么近\n第二行：裙子是浅灰 <b>不是</b> 白色\n\n<i>bbi_image</i>';
    const note = buildSlotTaskNote(source, 1, undefined, { instruction });
    expect(note).toContain(instruction);
    // 不能被折成单行(换行折叠是 tag/nl 的序列化口径,不该用在意见上)
    expect(note).not.toContain('第一行：机位别那么近 第二行');
  });

  it('顺序固定:目标提示词之后、本楼其余画面之前', () => {
    const instruction = '裙子是浅灰不是白色';
    const note = buildSlotTaskNote(source, 1, undefined, { instruction });
    const currentAt = note.indexOf('这一张当前的提示词');
    const instructionAt = note.indexOf('【本次重写必须满足的修改意见】');
    const othersAt = note.indexOf('本楼其余画面');
    expect(currentAt).toBeGreaterThan(-1);
    expect(instructionAt).toBeGreaterThan(currentAt);
    expect(othersAt).toBeGreaterThan(instructionAt);
    // 意见正文要落在标题与「其余画面」之间
    expect(note.indexOf(instruction)).toBeGreaterThan(instructionAt);
    expect(note.indexOf(instruction)).toBeLessThan(othersAt);
  });

  it('正文里没有目标 tag 时,意见照样带上(不依赖锚点在不在)', () => {
    const note = buildSlotTaskNote('纯正文', 0, undefined, { instruction: '把画面写得更暗' });
    expect(note).toContain('把画面写得更暗');
    expect(note).not.toContain('这一张当前的提示词');
    expect(note).not.toContain('本楼其余画面');
  });
});
