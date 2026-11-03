import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginImage,
  beginLlm,
  clearHistory,
  failImage,
  failLlm,
  finishLlm,
  finishImage,
  patchImagePrompt,
  patchLlmTokens,
  records,
  resetHistory,
  roughTokens,
  safeHistory,
  truncate,
  HISTORY_LIMITS,
  type ImageRecord,
  type LlmRecord,
} from './history';

const { MAX_RECORDS, MAX_CONTENT } = HISTORY_LIMITS;

function llm(source = 'test'): number {
  return beginLlm({
    source,
    channelName: 'ch',
    model: 'm',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

beforeEach(() => {
  resetHistory();
});

describe('环形缓冲', () => {
  it('新记录在前', () => {
    llm('第一条');
    llm('第二条');
    expect((records[0] as LlmRecord).source).toBe('第二条');
    expect((records[1] as LlmRecord).source).toBe('第一条');
  });

  it('超出封顶时丢弃最旧的', () => {
    for (let i = 0; i < MAX_RECORDS + 10; i++) llm(`#${i}`);
    expect(records.length).toBe(MAX_RECORDS);
    // 最新的在前,最旧的 10 条应已被挤出
    expect((records[0] as LlmRecord).source).toBe(`#${MAX_RECORDS + 9}`);
    expect((records[records.length - 1] as LlmRecord).source).toBe('#10');
  });

  it('被挤出后 finish/fail 是安全空操作', () => {
    const id = llm('会被挤出');
    for (let i = 0; i < MAX_RECORDS; i++) llm(`填充${i}`);
    expect(records.some(r => r.id === id)).toBe(false);
    expect(() =>
      finishLlm(id, { response: 'x', promptTokens: 1, completionTokens: 1, tokensEstimated: false }),
    ).not.toThrow();
    expect(() => failLlm(id, 'boom')).not.toThrow();
  });

  it('clearHistory 清空但保持同一数组引用(reactive 不断链)', () => {
    llm();
    const ref = records;
    clearHistory();
    expect(records.length).toBe(0);
    expect(records).toBe(ref);
  });
});

describe('截断', () => {
  it('短文本原样返回', () => {
    expect(truncate('abc')).toBe('abc');
  });

  it('超长文本截断并标注原长', () => {
    const long = 'x'.repeat(MAX_CONTENT + 500);
    const out = truncate(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain(`原长 ${MAX_CONTENT + 500} 字符`);
  });

  it('登记时对每条 message 都截断', () => {
    const id = beginLlm({
      source: 's',
      channelName: 'c',
      model: 'm',
      stream: false,
      messages: [
        { role: 'system', content: 'y'.repeat(MAX_CONTENT + 1) },
        { role: 'user', content: '短的' },
      ],
    });
    const record = records.find(r => r.id === id) as LlmRecord;
    expect(record.messages[0].content).toContain('已截断');
    expect(record.messages[1].content).toBe('短的');
  });

  it('返回正文同样截断', () => {
    const id = llm();
    finishLlm(id, {
      response: 'z'.repeat(MAX_CONTENT + 1),
      promptTokens: null,
      completionTokens: null,
      tokensEstimated: true,
    });
    expect((records[0] as LlmRecord).response).toContain('已截断');
  });
});

describe('状态流转', () => {
  it('finish 记成功并算耗时', () => {
    const id = llm();
    finishLlm(id, { response: 'ok', promptTokens: 12, completionTokens: 3, tokensEstimated: false });
    const record = records[0] as LlmRecord;
    expect(record.status).toBe('ok');
    expect(record.promptTokens).toBe(12);
    expect(record.tokensEstimated).toBe(false);
    expect(record.durationMs).not.toBeNull();
  });

  it('取消与失败分开:aborted 不带错误信息', () => {
    const a = llm();
    failLlm(a, '被取消了', true);
    expect(records[0].status).toBe('aborted');
    expect(records[0].error).toBe('');

    const b = llm();
    failLlm(b, '500 炸了');
    expect(records[0].status).toBe('error');
    expect(records[0].error).toBe('500 炸了');
  });

  it('生图记录同样区分取消与失败', () => {
    const id = beginImage({
      backend: 'nai',
      model: 'nai-diffusion-4',
      prompt: '1girl',
      nl: '',
      negative: '',
      characters: [{ name: 'A', tag: '1girl, black hair', nl: 'left' }],
      seed: 42,
      size: 'portrait',
      floor: 3,
      seq: 0,
    });
    failImage(id, '', true);
    const record = records[0] as ImageRecord;
    expect(record.status).toBe('aborted');
    expect(record.characters).toEqual([
      { name: 'A', tag: '1girl, black hair', nl: 'left' },
    ]);
  });
});

describe('生图记录的最终提示词全文', () => {
  function image(extra: Record<string, unknown> = {}): number {
    return beginImage({
      backend: 'comfyui',
      model: '预设',
      prompt: '1girl',
      nl: '',
      negative: '',
      characters: [],
      seed: 1,
      size: 'portrait',
      floor: 1,
      seq: 0,
      ...extra,
    });
  }

  it('patchImagePrompt 能在请求前补录最终全文', () => {
    const id = image();
    // begin 时还没有成品(拼装只在 backends 里发生),故分段原料先记,全文后补
    expect((records[0] as ImageRecord).finalPrompt).toBeUndefined();
    patchImagePrompt(id, 'quality, 1girl, 林夏：鹅蛋脸。', 'worst quality');
    const record = records[0] as ImageRecord;
    expect(record.finalPrompt).toBe('quality, 1girl, 林夏：鹅蛋脸。');
    expect(record.finalNegative).toBe('worst quality');
    // 分段原料保留,供对照「用户填了什么」
    expect(record.prompt).toBe('1girl');
  });

  it('finishImage 也能一并带上最终全文', () => {
    const id = image();
    finishImage(id, { finalPrompt: 'full string', finalNegative: 'neg' });
    const record = records[0] as ImageRecord;
    expect(record.status).toBe('ok');
    expect(record.finalPrompt).toBe('full string');
    expect(record.finalNegative).toBe('neg');
  });

  it('空串不写键、也不覆盖已有值', () => {
    const id = image();
    patchImagePrompt(id, '', '');
    // 没算出来就是「未知」,不该落一个假的空提示词
    expect('finalPrompt' in (records[0] as ImageRecord)).toBe(false);
    patchImagePrompt(id, 'real', '');
    patchImagePrompt(id, '', '');
    expect((records[0] as ImageRecord).finalPrompt).toBe('real');
  });

  it('appearance 落库,便于对照「填了什么」与「拼到哪儿」', () => {
    image({ appearance: '鹅蛋脸,单眼皮。' });
    expect((records[0] as ImageRecord).appearance).toBe('鹅蛋脸,单眼皮。');
    // 空串同样不写键
    image({ appearance: '   ' });
    expect('appearance' in (records[0] as ImageRecord)).toBe(false);
  });

  it('超长的最终全文按同一口径截断', () => {
    const id = image();
    const huge = 'a'.repeat(MAX_CONTENT + 500);
    patchImagePrompt(id, huge);
    const text = (records[0] as ImageRecord).finalPrompt ?? '';
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('已截断');
  });
});

describe('token 补录', () => {
  it('估算结果可补录进已完成的记录', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: null, completionTokens: null, tokensEstimated: true });
    patchLlmTokens(id, 88, 9);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(88);
    expect(record.tokensEstimated).toBe(true);
  });

  it('已有真实 usage 时不被估算值覆盖', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: 100, completionTokens: 20, tokensEstimated: false });
    patchLlmTokens(id, 999, 999);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(100);
    expect(record.tokensEstimated).toBe(false);
  });
});

describe('roughTokens 粗估', () => {
  it('空串为 0', () => {
    expect(roughTokens('')).toBe(0);
  });

  it('中日韩按 1 字 1 token', () => {
    expect(roughTokens('你好世界')).toBe(4);
    expect(roughTokens('こんにちは')).toBe(5);
  });

  it('拉丁文按 4 字符 1 token', () => {
    expect(roughTokens('a'.repeat(40))).toBe(10);
  });

  it('中英混排两段分别计入', () => {
    // 4 个汉字 + 8 个 ASCII → 4 + 2
    expect(roughTokens('你好世界abcdefgh')).toBe(6);
  });

  it('代理对(emoji)按一个字符算,不重复计数', () => {
    // '🎨' 的 length 是 2,但按码点只应算 1 个字符 → 1/4 → 四舍五入 0
    expect(roughTokens('🎨')).toBe(0);
    expect(roughTokens('🎨'.repeat(4))).toBe(1);
  });

  it('结果随文本变长而单调不减(段间比大小是它唯一的用途)', () => {
    const short = roughTokens('短文本');
    const long = roughTokens('短文本'.repeat(50));
    expect(long).toBeGreaterThan(short);
  });
});

describe('safeHistory', () => {
  it('吞掉异常并返回 null,不连累主流程', () => {
    expect(
      safeHistory(() => {
        throw new Error('store 炸了');
      }),
    ).toBeNull();
  });

  it('正常时原样返回结果', () => {
    expect(safeHistory(() => 42)).toBe(42);
  });
});
