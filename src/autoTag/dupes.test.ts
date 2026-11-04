import { describe, expect, it } from 'vitest';

import {
  auditLayers,
  findCrossLayerDuplicates,
  formatLayerAudit,
  formatLayerAudits,
} from '@/autoTag/dupes';

/**
 * 这套单测盯的是「判定」本身,不是措辞:四类重复项各一正一反、词表的误杀边界、
 * 脏输入不抛、批量接口的空结论。判定一变,出图侧的告警就跟着失效,所以这里判错比生产侧判错更贵。
 */

/** 取某个 code 的问题;没有就返回 undefined,让断言自己说清缺了哪条。 */
function issueOf(code: string, input: { tag?: string; nl?: string; appearance?: string }) {
  return findCrossLayerDuplicates(input).find(issue => issue.code === code);
}

function codes(input: { tag?: string; nl?: string; appearance?: string }): string[] {
  return findCrossLayerDuplicates(input).map(issue => issue.code);
}

describe('race-duplicated 人种写两处', () => {
  it('tag 有 chinese + nl 写「中国女人」→ block', () => {
    const issue = issueOf('race-duplicated', {
      tag: '1girl, chinese, east asian, medium shot',
      nl: '她是一个中国女人,站在窗边。',
    });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
    // 报错必须点名是哪一个 tag 锚点、哪一句 nl,否则用户没法照着改
    expect(issue?.message).toContain('chinese');
    expect(issue?.message).toContain('中国女人');
    expect(issue?.fix).toContain('只写一次');
  });

  it('tag 有 chinese + 英文段写 a Chinese woman → block(规范点名的那一句)', () => {
    const issue = issueOf('race-duplicated', {
      tag: '1girl, chinese, twenty years old',
      nl: 'She is a Chinese woman of twenty, hips bare.',
    });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
  });

  it('反例:tag 没写人种时 nl 写人种不算重复(这时 nl 是唯一的一处)', () => {
    expect(issueOf('race-duplicated', { tag: '1girl, medium shot', nl: '她是一个中国女人。' })).toBeUndefined();
  });

  it('反例:tag 写了人种、nl 只写画面不写人种', () => {
    expect(issueOf('race-duplicated', {
      tag: '1girl, chinese, east asian, medium shot',
      nl: '镜头在她右前方四十五度,略高于视线。阳台的光从右侧进来。',
    })).toBeUndefined();
  });
});

describe('race 词表的误杀边界', () => {
  // 裸的「中国」「日本」是地点不是人种:拿它去判,「中国城」「日本料理」立刻变成假阳性。
  it('「中国城」「日本料理」不算人种', () => {
    expect(issueOf('race-duplicated', {
      tag: '1girl, chinese, street',
      nl: '街角有一家中国城的老店,招牌上写着日本料理。',
    })).toBeUndefined();
  });

  it('只写了族裔 tag、nl 里出现的是别的人种词,不算同一件事', () => {
    // tag 锁的是 chinese,nl 说的是别人,不是「同一信息写两遍」
    expect(issueOf('race-duplicated', {
      tag: '1girl, chinese, two people',
      nl: '她身旁站着一个日本人。',
    })).toBeTruthy();
    // 上面这条是真重复(nl 确实写了人种词);下面这条才是反例:中文没有指人后缀
    expect(issueOf('race-duplicated', { tag: '1girl, chinese', nl: '桌上摆着韩国的化妆品。' })).toBeUndefined();
  });

  it('tag 里的 chinese 只按整词命中,chinesestyle 之类不算人种锚点', () => {
    expect(issueOf('race-duplicated', {
      tag: '1girl, chinesestyle dress',
      nl: '她是一个中国女人。',
    })).toBeUndefined();
  });
});

describe('age-duplicated 年龄写两处', () => {
  it('tag 有 twenty years old + nl 写「二十岁」→ block', () => {
    const issue = issueOf('age-duplicated', {
      tag: '1girl, twenty years old, medium shot',
      nl: '二十岁的她站在窗边。',
    });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('block');
    expect(issue?.message).toContain('twenty years old');
    expect(issue?.message).toContain('二十岁');
  });

  it('英文段的 of twenty 也算', () => {
    expect(issueOf('age-duplicated', {
      tag: '1girl, twenty years old',
      nl: 'She stands by the window, of twenty, soft light on her back.',
    })).toBeTruthy();
  });

  it('反例:tag 没写年龄时 nl 写年龄不算重复', () => {
    expect(issueOf('age-duplicated', { tag: '1girl, medium shot', nl: '二十岁的她站在窗边。' })).toBeUndefined();
  });

  it('反例:tag 写了年龄,nl 不写', () => {
    expect(issueOf('age-duplicated', {
      tag: '1girl, twenty years old, medium shot',
      nl: '她站在窗边,一只手撑在窗台上。',
    })).toBeUndefined();
  });

  it('「岁」只认带数字的写法,「岁月」不算', () => {
    expect(issueOf('age-duplicated', {
      tag: '1girl, twenty years old',
      nl: '窗外的岁月安静得像一层灰。',
    })).toBeUndefined();
  });
});

describe('garment-duplicated 服装写两处', () => {
  it('颜色 + 品类同时命中 → warn', () => {
    const issue = issueOf('garment-duplicated', {
      tag: '1girl, white camisole, black miniskirt',
      nl: '她穿着白吊带,站在窗边。',
    });
    expect(issue).toBeTruthy();
    // warn 而非 block:服装复述最容易是「同一件衣服的另一个说法」,值得提醒但不该升级成冲突
    expect(issue?.level).toBe('warn');
    expect(issue?.message).toContain('white');
    expect(issue?.message).toContain('camisole');
    expect(issue?.message).toContain('白吊带');
    expect(issue?.fix).toContain('状态');
  });

  it('反例:nl 里只有颜色,没有品类 → 不判', () => {
    expect(issueOf('garment-duplicated', { tag: '1girl, white camisole', nl: '白色的墙壁。' })).toBeUndefined();
  });

  it('反例:nl 里只有品类,没有颜色 → 不判', () => {
    expect(issueOf('garment-duplicated', { tag: '1girl, white camisole', nl: '她穿着吊带。' })).toBeUndefined();
    expect(issueOf('garment-duplicated', { tag: '1girl, white camisole', nl: '她穿着裙子。' })).toBeUndefined();
  });

  it('颜色与品类隔着别的衣服时,不许拼成一件不存在的衣服', () => {
    // 「白衬衫的下摆垂在黑色的裙子上」:白配衬衫、黑配裙,各自成立;错位的「白 + 裙」是假组合。
    // 邻接窗口把错位的那组挡掉,只留下真成立的那一组。
    const issues = findCrossLayerDuplicates({
      tag: '1girl, white shirt, black dress',
      nl: '白衬衫的下摆垂在黑色的裙子上。',
    }).filter(issue => issue.code === 'garment-duplicated');
    expect(issues).toHaveLength(2);
    // 返回顺序 = 词表顺序(白在前、黑在后),每条消息里拼的是 tag 侧的英文颜色 + 品类
    expect(issues[0].message).toContain('white');
    expect(issues[0].message).toContain('shirt');
    expect(issues[1].message).toContain('black');
    expect(issues[1].message).toContain('dress');
  });

  it('中文里没有颜色词时不算复述(只有品类不算)', () => {
    expect(issueOf('garment-duplicated', {
      tag: '1girl, white shirt, dress',
      nl: '衬衫的袖口卷到手肘。',
    })).toBeUndefined();
  });

  it('tag 里的颜色只按整词命中:whitewash 不是白色', () => {
    expect(issueOf('garment-duplicated', {
      tag: '1girl, whitewash wall, dress',
      nl: '白裙子。',
    })).toBeUndefined();
  });
});

describe('missing-exclusion 中文外貌空转', () => {
  it('外貌段里的名字在 tag / nl 里都没出现 → warn', () => {
    const issue = issueOf('missing-exclusion', {
      tag: '1girl, medium shot',
      nl: '她站在窗边。',
      appearance: '林夏:鹅蛋脸,单眼皮,皮肤偏白。',
    });
    expect(issue).toBeTruthy();
    expect(issue?.level).toBe('warn');
    expect(issue?.message).toContain('林夏');
  });

  it('名字出现在 tag 或 nl 里就算认领,不报', () => {
    const appearance = '林夏:鹅蛋脸,单眼皮。 苏曼:圆脸,双眼皮。';
    expect(issueOf('missing-exclusion', {
      tag: '1girl, 林夏, medium shot',
      nl: '苏曼站在门口。',
      appearance,
    })).toBeUndefined();
  });

  it('没传外貌段 / 空外貌段时整条判据跳过', () => {
    expect(codes({ tag: '1girl, medium shot', nl: '她站在窗边。' })).toEqual([]);
    expect(codes({ tag: '1girl, medium shot', nl: '她站在窗边。', appearance: '' })).toEqual([]);
  });
});

describe('脏输入一律空结论,不抛错', () => {
  it('null / undefined / 非对象 / 空串都不抛', () => {
    expect(() => findCrossLayerDuplicates(null as never)).not.toThrow();
    expect(() => findCrossLayerDuplicates(undefined as never)).not.toThrow();
    expect(() => findCrossLayerDuplicates('garbage' as never)).not.toThrow();
    expect(findCrossLayerDuplicates(null as never)).toEqual([]);
    expect(findCrossLayerDuplicates('garbage' as never)).toEqual([]);
    expect(findCrossLayerDuplicates({})).toEqual([]);
    expect(findCrossLayerDuplicates({ tag: '', nl: '' })).toEqual([]);
  });

  it('字段类型不对时当空处理,不抛', () => {
    expect(findCrossLayerDuplicates({ tag: 42 as never, nl: { a: 1 } as never })).toEqual([]);
    expect(findCrossLayerDuplicates({ tag: '1girl, chinese', nl: null as never })).toEqual([]);
  });
});

describe('auditLayers 与 formatLayerAudits', () => {
  it('逐张给结论,block 只体现在 hasBlocking 上', () => {
    const audits = auditLayers([
      { tag: '1girl, chinese', nl: '她是一个中国女人。' },
      { tag: '1girl, medium shot', nl: '她站在窗边。' },
      {},
      null as never,
    ]);
    expect(audits).toHaveLength(4);
    expect(audits[0].hasBlocking).toBe(true);
    expect(audits[0].issues.map(issue => issue.code)).toEqual(['race-duplicated']);
    expect(audits[1].issues).toEqual([]);
    expect(audits[1].hasBlocking).toBe(false);
    expect(audits[2].issues).toEqual([]);
    expect(audits[3].issues).toEqual([]);
  });

  it('空结论:空数组、非数组都返回空,format 出空串', () => {
    expect(auditLayers([])).toEqual([]);
    expect(auditLayers(undefined as never)).toEqual([]);
    expect(formatLayerAudits([])).toBe('');
    expect(formatLayerAudits(undefined as never)).toBe('');
    expect(formatLayerAudit(null)).toBe('');
    expect(formatLayerAudits(auditLayers([{ tag: '1girl, medium shot' }]))).toBe('');
  });

  it('有问题时逐张成行,并带 code 与修法', () => {
    const text = formatLayerAudits(auditLayers([
      { tag: '1girl, chinese, twenty years old', nl: '她是一个中国女人,二十岁。' },
    ]));
    expect(text).toContain('第 1 张');
    expect(text).toContain('重复冲突');
    expect(text).toContain('race-duplicated');
    expect(text).toContain('age-duplicated');
    // 多行接口:两张都脏时是两行
    const lines = formatLayerAudits(auditLayers([
      { tag: '1girl, chinese', nl: '她是一个中国女人。' },
      { tag: '1girl, twenty years old', nl: '二十岁的她。' },
    ])).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('第 2 张');
  });

  it('block 级问题排在 warn 前面', () => {
    const issues = findCrossLayerDuplicates({
      tag: '1girl, chinese, twenty years old, white camisole',
      nl: '她是一个中国女人,二十岁,穿着白吊带。',
    });
    expect(issues.map(issue => issue.level)[0]).toBe('block');
    expect(issues.filter(issue => issue.level === 'block').map(issue => issue.code))
      .toEqual(['race-duplicated', 'age-duplicated']);
  });
});

describe('回归:tag 自身的年龄冲突与外貌段的越界复述', () => {
  // 2026-11-04 的一次真实崩图:tag 里 young adult 与 twenty-eight years old 并排,
  // 角色库外貌段写着 an 18-year-old Chinese boy。跨层闸当时一条都报不出来,
  // 因为 ageIssue 只比对 tag ↔ nl,而这两处重复都不在 nl 里。
  const tag =
    '1boy, 1girl, medium close-up, three-quarter view, chinese, east asian, young adult, ' +
    '小宇, sleeping, twenty-eight years old';
  const appearance = '小宇：an 18-year-old Chinese boy, east asian, a soft boyish charm';

  it('tag 里笼统年龄词与具体年龄并排 → age-conflict', () => {
    const codes = findCrossLayerDuplicates({ tag, nl: '镜头在床的近侧。' }).map(issue => issue.code);
    expect(codes).toContain('age-conflict');
  });

  it('only:"tag" 时只做与其它层无关的判定', () => {
    const codes = findCrossLayerDuplicates({ tag, nl: '', only: 'tag' }).map(issue => issue.code);
    expect(codes).toEqual(['age-conflict']);
  });

  it('外貌段里年龄与 tag 对不上 → age-in-appearance（block）', () => {
    const issues = findCrossLayerDuplicates({ tag, nl: '镜头在床的近侧。', appearance });
    const hit = issues.find(issue => issue.code === 'age-in-appearance');
    expect(hit?.level).toBe('block');
    expect(hit?.message).toContain('28');
    expect(hit?.message).toContain('18');
  });

  it('外貌段里复述人种 → race-in-appearance（warn）', () => {
    const issues = findCrossLayerDuplicates({ tag, nl: '', appearance });
    expect(issues.map(issue => issue.code)).toContain('race-in-appearance');
  });

  it('把笼统词与年龄删掉后零结论', () => {
    const clean = '1boy, 1girl, full shot, three-quarter view, chinese, east asian, 小宇, sleeping';
    const cleanAppearance = '小宇：a soft boyish charm with a shy edge';
    expect(findCrossLayerDuplicates({ tag: clean, nl: '镜头在床的近侧。', appearance: cleanAppearance }))
      .toEqual([]);
  });

  it('missing-exclusion 与新增判定可以同时给出', () => {
    const issues = findCrossLayerDuplicates({
      tag: '1girl, chinese, twenty years old',
      nl: '她在窗边。',
      appearance: '苏曼：a soft oval face',
    });
    expect(issues.map(issue => issue.code)).toContain('missing-exclusion');
  });
});

describe('回归:合规的 MOSS 写实串不得误报', () => {
  // 这段是 MOSS 写实线的规范口径(settings.ts 的 DEFAULT_MOSS_SPEC 第二、三节):
  // 人种与年龄只写在 tag,nl 只写机位/环境/光线,不复述人种年龄、不复述服装。
  // 这条是本次改动的守门人:跨层闸一旦开始报它,整条线每一张图都会飘红,闸就废了。
  const mossTag =
    '1girl, solo, medium shot, three-quarter view, chinese, east asian, twenty years old, ' +
    'long black hair, white cotton camisole, standing, looking at viewer, smile, dorm room, desk lamp';
  const mossNl =
    '镜头在她右前方四十五度,略高于视线。她站在窗前,前景是桌角与台灯,背景是一扇落地的窗。' +
    '阳台的光从右侧进来,她半边脸沉在暗部。';

  it('合规串零结论', () => {
    expect(codes({ tag: mossTag, nl: mossNl })).toEqual([]);
  });

  it('同一段串把英文身体段接上(不复述人种年龄)也零结论', () => {
    expect(codes({
      tag: mossTag,
      nl: mossNl + ' The thin cotton stretches across one shoulder, the elastic edge pressing a shallow line into the near hip.',
    })).toEqual([]);
  });
});
