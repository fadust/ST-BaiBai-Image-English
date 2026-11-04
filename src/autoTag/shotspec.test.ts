import { describe, expect, it } from 'vitest';

import {
  ANGLE_TABLE,
  HEIGHT_TABLE,
  SHOT_ORDER_RULE,
  SIZE_TABLE,
  auditFrames,
  blockingIssues,
  emitShotTag,
  formatFrameAudit,
  formatFrameAudits,
  inferContact,
  inspectFrame,
  parseShot,
} from '@/autoTag/shotspec';

/**
 * 这套单测盯的是「判定」本身,不是措辞:词表归并、四条判定、字段顺序、接触推断。
 * 判定一变,出图侧的协议条款就跟着失效(它们引用同一份词表),所以这里判错比生产侧判错更贵。
 */

/** 取某个 code 的问题;没有就返回 undefined,让断言自己说清缺了哪条。 */
function issueOf(code: string, frame: { tag?: string; nl?: string }, options = {}) {
  const result = inspectFrame(frame, options);
  return result.issues.find(issue => issue.code === code);
}

describe('parseShot 词表归并', () => {
  // 这套词表唯一的实现陷阱:按长度从长到短匹配并抹掉已命中的片段。
  // 没做归并时「四分之三侧面」会被再认成正侧,「中近景」会被拆成中景 —— 两张图立刻判成两种构图。
  it('四分之三侧面不被误判成正侧', () => {
    const parsed = parseShot('四分之三侧面');
    expect(parsed.angles).toEqual(['three-quarter']);
    expect(parsed.angles).not.toContain('profile');
    expect(parsed.spec.angle).toBe('three-quarter');
  });

  it('中近景不被拆成中景', () => {
    const parsed = parseShot('中近景');
    expect(parsed.sizes).toEqual(['medium-close']);
    expect(parsed.sizes).not.toContain('medium');
    expect(parsed.spec.size).toBe('medium-close');
  });

  it('中英混排的同一景别只算一个(medium close-up / MCU / 中近景 同义)', () => {
    expect(parseShot('medium close-up').sizes).toEqual(['medium-close']);
    expect(parseShot('MCU').sizes).toEqual(['medium-close']);
    expect(parseShot('medium closeup').sizes).toEqual(['medium-close']);
    expect(parseShot('中近景, medium close-up').sizes).toEqual(['medium-close']);
  });

  it('一条串里两个不同景别时全部返回,交给 inspectFrame 判冲突', () => {
    const parsed = parseShot('中景, 中近景');
    expect(parsed.sizes).toContain('medium');
    expect(parsed.sizes).toContain('medium-close');
    // spec 只取第一个,不代表判定只看第一个 —— 冲突判定走 sizes 全量
    expect(parsed.spec.size).toBe(parsed.sizes[0]);
  });

  it('机位高度与朝向各自归并,中英同义', () => {
    expect(parseShot('俯拍').heights).toEqual(['high']);
    expect(parseShot('high angle').heights).toEqual(['high']);
    expect(parseShot('仰视, low angle').heights).toEqual(['low']);
    expect(parseShot('正面机位').angles).toEqual(['front']);
    expect(parseShot('from behind').angles).toEqual(['back']);
  });

  it('短缩写要整词命中:2girls 里的 ls 不是「远景」', () => {
    // 真实回归:`ls` / `ms` / `cu` 这类两三字母缩写落在别的词肚子里,会把一张干净的 close-up
    // 判成「远景 + 近景」两个互斥景别,体检随即报一条假的 block。
    expect(parseShot('2girls, close-up').sizes).toEqual(['close']);
    expect(parseShot('2girls, ms').sizes).toEqual(['medium']);
    expect(parseShot('one girl, CU').sizes).toEqual(['close']);
    expect(parseShot('1girl, fs').sizes).toEqual(['full']);
    // 带空格 / 连字符的长写法照旧按子串匹配,不受整词规则牵连
    expect(parseShot('wide shot').sizes).toEqual(['wide']);
    expect(parseShot('medium close-up').sizes).toEqual(['medium-close']);
  });

  it('空串与非字符串输入不抛错', () => {
    expect(parseShot('')).toEqual({ sizes: [], angles: [], heights: [], spec: {} });
    // 脏输入来自模型输出的一手数据:这里抛错就等于让整次解析失败
    expect(() => parseShot(undefined as unknown as string)).not.toThrow();
    expect(parseShot(null as unknown as string).sizes).toEqual([]);
  });
});

describe('inspectFrame 的四条判定', () => {
  it('size-conflict:同一张图两个互斥景别 → block', () => {
    const issue = issueOf('size-conflict', { tag: '2girls, medium shot, medium close-up, bedroom' });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
    expect(issue?.message).toContain('中景');
    expect(issue?.message).toContain('中近景');
    // 修法必须可执行(拆格 / 只留一个),不能只是一句「别这么写」
    expect(issue?.fix).toContain('只留一个景别');
  });

  it('size-conflict 不误伤:一个景别 + 一个纵深词不算冲突', () => {
    // 「中景」在这里既是景别又是「前景/中景/背景」的纵深层名 —— 只出现一次不该报冲突
    expect(issueOf('size-conflict', { tag: '1girl, medium shot', nl: '前景一侧是窗,中景是她' })).toBeUndefined();
  });

  it('profile-occlusion:正侧机位 + 贴身接触 → block', () => {
    const issue = issueOf('profile-occlusion', {
      tag: '2girls, close-up, side view',
      nl: '她低头含住他',
    });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
    expect(issue?.fix).toContain('四分之三侧面');
  });

  it('profile-occlusion 只认贴身:正侧 + 无接触不报', () => {
    expect(issueOf('profile-occlusion', { tag: '1girl, medium shot, side view', nl: '她站在窗边' })).toBeUndefined();
    // 非正侧的贴身接触也不报:这条判的是机位与接触点的几何,不是接触本身
    expect(issueOf('profile-occlusion', {
      tag: '2girls, close-up, three-quarter view',
      nl: '她低头含住他',
    })).toBeUndefined();
  });

  it('size-crowded:景别装不下人数 → block', () => {
    // 中近景 capacity = 2,第三个人会被压成背景色块
    const issue = issueOf('size-crowded', { tag: '三个人, 中近景, 客厅' });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
    expect(issue?.message).toContain('2 个');
    expect(issue?.message).toContain('3 个');
  });

  it('size-crowded 不越界:人数没超容量就不报', () => {
    expect(issueOf('size-crowded', { tag: '两个人, 中近景' })).toBeUndefined();
    // 人数推不出来时不判人数(宁可不判,也不猜)
    expect(issueOf('size-crowded', { tag: '中近景, 客厅' })).toBeUndefined();
  });

  it('closeup-relationship:特写里塞两个人 → warn', () => {
    const issue = issueOf('closeup-relationship', { tag: '2girls, close-up, bedroom' });
    expect(issue).toBeTruthy();
    // 这条是 warn:关系表达不清值得提醒,但特写两人并非物理上画不出来
    expect(issue?.level).toBe('warn');
    expect(issue?.fix).toContain('更宽的景别');
  });

  it('closeup-relationship 只认特写与小特写,中近景两人不报', () => {
    expect(issueOf('closeup-relationship', { tag: '2girls, medium close-up' })).toBeUndefined();
    expect(issueOf('closeup-relationship', { tag: '2girls, extreme close-up' })).toBeTruthy();
  });

  it('block 级问题排在 warn 前面,不随判定顺序漂', () => {
    // 中景 capacity=3、layers=2:塞 4 人(block)+ 三层纵深(warn),block 必须在前
    const result = inspectFrame({
      tag: '四个人, 中景',
      nl: '前景是桌角,中景是她,背景是门口',
    });
    const levels = result.issues.map(issue => issue.level);
    expect(levels[0]).toBe('block');
    expect(blockingIssues(result.issues).every(issue => issue.level === 'block')).toBe(true);
  });

  it('干净的一张图不产出任何问题', () => {
    const result = inspectFrame({
      tag: '两个人, 中景, 四分之三侧面, 平视, 客厅',
      nl: '她们并肩坐在沙发上,前景是茶几一角,背景是一扇窗。',
    }, { orientation: 'landscape' });
    expect(result.issues).toEqual([]);
    expect(result.spec).toMatchObject({ size: 'medium', angle: 'three-quarter', height: 'eye' });
  });
});

describe('emitShotTag 字段顺序', () => {
  it('人数 → 景别 → 机位朝向 → 机位高度,缺项跳过不补默认值', () => {
    expect(emitShotTag({ people: 2, size: 'medium', angle: 'three-quarter', height: 'eye' })).toBe(
      '两个人,中景,四分之三侧面机位,平视',
    );
    expect(emitShotTag({ size: 'close', angle: 'profile' })).toBe('近景,正侧机位');
    expect(emitShotTag({ people: 1 })).toBe('一个人');
    expect(emitShotTag({})).toBe('');
  });

  it('解析与生成互逆:emitShotTag 的输出能被 parseShot 解回同一组 id', () => {
    const tag = emitShotTag({ people: 2, size: 'medium-close', angle: 'front', height: 'high' });
    expect(tag).toBe('两个人,中近景,正面机位,俯拍');
    const parsed = parseShot(tag);
    expect(parsed.spec).toEqual({ size: 'medium-close', angle: 'front', height: 'high' });
  });

  it('词表外的景别/朝向不会漏出脏字段', () => {
    expect(emitShotTag({ size: 'unknown' as never })).toBe('');
    expect(emitShotTag({ people: 9 })).toBe('9个人');
  });
});

describe('inferContact 接触紧密度', () => {
  it('body 级:只认最硬的几个动词', () => {
    expect(inferContact('她低头含住他')).toBe('body');
    expect(inferContact('两人贴合在一起')).toBe('body');
    expect(inferContact('his tongue against hers')).toBe('body');
  });

  it('near 级:拥抱搂靠这类贴但不深入的', () => {
    expect(inferContact('她抱住他')).toBe('near');
    expect(inferContact('她把头靠在他肩上')).toBe('near');
    expect(inferContact('they hug each other')).toBe('near');
  });

  it('none:没有接触,脏输入也不抛错', () => {
    expect(inferContact('她站在窗边')).toBe('none');
    expect(inferContact('')).toBe('none');
    expect(inferContact(undefined as unknown as string)).toBe('none');
    expect(() => inferContact(null as unknown as string)).not.toThrow();
  });
});

describe('portrait-lying:横躺的身体塞进竖幅', () => {
  // 2026-11-04 的真实崩图:832×1216 竖幅 + 侧躺,主角少了一条腿。
  // 规范第五节写着「横向展开的身体塞进竖构图会被压扁」,但此前没有任何代码执行它。
  const lying = { tag: '1boy, 1girl, medium close-up', nl: '小宇侧躺在画面左侧,胯部朝镜头。' };

  it('竖幅 + 卧姿 → portrait-lying(warn)', () => {
    const codes = inspectFrame(lying, { orientation: 'portrait' }).issues.map(issue => issue.code);
    expect(codes).toContain('portrait-lying');
  });

  it('横幅 + 卧姿不报', () => {
    const codes = inspectFrame(lying, { orientation: 'landscape' }).issues.map(issue => issue.code);
    expect(codes).not.toContain('portrait-lying');
  });

  it('竖幅 + 站立不报:长轴本来就是竖的', () => {
    const codes = inspectFrame(
      { tag: '1girl, medium shot', nl: '她站在窗边,身体是竖直的。' },
      { orientation: 'portrait' },
    ).issues.map(issue => issue.code);
    expect(codes).not.toContain('portrait-lying');
  });

  it('英文写法 lying on his side 也认', () => {
    const codes = inspectFrame(
      { tag: '1boy, full shot', nl: 'He is lying on his side with his hips angled toward the camera.' },
      { orientation: 'portrait' },
    ).issues.map(issue => issue.code);
    expect(codes).toContain('portrait-lying');
  });
});

describe('auditFrames 非阻断体检', () => {
  it('逐张给结论,block 只体现在 hasBlocking 上,不抛错', () => {
    const audits = auditFrames([
      { tag: '2girls, medium shot, medium close-up' },
      { tag: '1girl, medium shot, three-quarter view', nl: '她站在窗边' },
      {},
    ]);
    expect(audits).toHaveLength(3);
    expect(audits[0].hasBlocking).toBe(true);
    expect(audits[1].issues).toEqual([]);
    expect(audits[1].hasBlocking).toBe(false);
    expect(audits[2].issues).toEqual([]);
  });

  it('size 决定竖幅判定;脏 size 与脏输入都不影响返回形状', () => {
    const audits = auditFrames([
      { tag: '三个人, 远景', size: 'portrait' },
      { tag: '三个人, 远景', size: 'bogus' },
    ]);
    expect(audits[0].issues.some(issue => issue.code === 'portrait-row')).toBe(true);
    expect(audits[1].issues.some(issue => issue.code === 'portrait-row')).toBe(false);

    expect(auditFrames([])).toEqual([]);
    expect(auditFrames(undefined as never)).toEqual([]);
    expect(auditFrames([null as never])).toHaveLength(1);
  });

  it('formatFrameAudits:没问题时是空串,有问题时逐张成行', () => {
    const audits = auditFrames([{ tag: '2girls, medium shot, medium close-up' }]);
    const text = formatFrameAudits(audits);
    expect(text).toContain('第 1 张');
    expect(text).toContain('构图矛盾');
    expect(text).toContain('size-conflict');

    expect(formatFrameAudits(auditFrames([{ tag: '1girl, medium shot' }]))).toBe('');
    expect(formatFrameAudits([])).toBe('');
    expect(formatFrameAudit(null)).toBe('');
    expect(formatFrameAudits(undefined as never)).toBe('');
  });
});

describe('SHOT_ORDER_RULE 规则常量', () => {
  // prompt.ts 直接引用这一份(不复制词表),所以这里钉住的是「注入模型的那句协议」本身
  it('点明四个承重墙字段与「景别只许一个」', () => {
    expect(SHOT_ORDER_RULE).toContain('人数');
    expect(SHOT_ORDER_RULE).toContain('景别');
    expect(SHOT_ORDER_RULE).toContain('机位朝向');
    expect(SHOT_ORDER_RULE).toContain('机位高度');
    expect(SHOT_ORDER_RULE).toContain('景别只许出现一个');
    expect(SHOT_ORDER_RULE).toContain('nl 第一段必须与 tag 的这个顺序同口径');
  });

  it('词表本身就是一张表:每个 id 都能被 parseShot 解回来', () => {
    for (const size of SIZE_TABLE) expect(parseShot(size.zh).sizes).toContain(size.id);
    for (const angle of ANGLE_TABLE) expect(parseShot(angle.zh).angles).toContain(angle.id);
    for (const height of HEIGHT_TABLE) expect(parseShot(height.zh).heights).toContain(height.id);
  });
});
