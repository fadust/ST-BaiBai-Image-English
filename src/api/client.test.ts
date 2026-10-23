import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/state/settings';
import { buildRequestBody, extractContent, readSseContent, requestCompletion } from './client';

/** The history layer is all mocked: what is asserted here is exactly "when success/failure is recorded" */
const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟随主 API',
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  // Same semantics as the real implementation: swallows exceptions and returns null
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}) }),
}));

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const channel: ApiChannel = {
  id: 'ch1',
  name: '测试渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  excludeParams: [],
  reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hi' }];
/** A response with usage: avoids triggering the token estimate branch (which needs the main UI's tokenizer) */
const okPayload = {
  choices: [{ message: { role: 'assistant', content: '  答案文本  ' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
};

/** Builds a minimal Response that reads out the given SSE text */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('buildRequestBody: reasoning effort and the two source branches', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<typeof channel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1', false);

  it('reasoning effort unset → openai source (apart from the added tool_choice, the request body is the same as before the feature)', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      tool_choice: 'none',
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('both source branches carry tool_choice:none (a pass-through handshake for anti-truncation fetch interceptors)', () => {
    // Preset scripts like Kemini intercept every /generate request, and let it through when the caller brings its own tool_choice,
    // no longer injecting a synthetic tool + control message (otherwise image tags would be slowed down or even forced into retries).
    expect(build().tool_choice).toBe('none');
    expect(build({ reasoningEffort: 'high' }).tool_choice).toBe('none');
    // If the user really wants a third party to rewrite it, excludeParams can delete it
    expect(build({ excludeParams: ['tool_choice'] }).tool_choice).toBeUndefined();
  });

  it('reasoning effort set → switches to the custom source, passed through via custom_include_body', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // reasoning_effort isn't sent at the top level: both the openai/custom sources gate on a model-name allowlist,
    // and when the model name happens to match, it would overwrite the value we actually want to send
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('the custom source must carry the key via header: proxy_password is not read under that source', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('keys containing YAML metacharacters are still injected safely (escaped via JSON.stringify)', () => {
    // Hand-built YAML would fail to parse on such keys, and ST's mergeObjectWithYaml silently ignores the failure;
    // header injection fails → falls back to ST's own Custom key → may send someone else's key to this endpoint.
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('blank strings count as unset (no mistaken switch to the custom source)', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('values are not allowlisted: unusual values pass through as-is', () => {
    const body = build({ reasoningEffort: '我自己的档位' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('我自己的档位');
  });

  it('excludeParams works as usual under both branches', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });
});

describe('extractContent: standard response', () => {
  it('message.content extracted normally', () => {
    const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(extractContent(data)).toBe('hello');
  });

  it('compatible with choices[0].text and top-level content', () => {
    expect(extractContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractContent({ content: 'top-level' })).toBe('top-level');
  });

  it('content as a content-parts array joins each part text', () => {
    const data = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    expect(extractContent(data)).toBe('ab');
  });

  it('content null returns an empty string instead of throwing', () => {
    const data = { choices: [{ message: { role: 'assistant', content: null, refusal: null } }] };
    expect(extractContent(data)).toBe('');
  });
});

describe('extractContent: reasoning models put the answer in reasoning', () => {
  it('empty content falls back to reasoning', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          reasoning: '思考过程…\n\n{"images":[],"changes":[]}',
        },
      }],
    };
    expect(extractContent(data)).toContain('"images"');
  });

  it('empty content falls back to reasoning_content (the DeepSeek standard field)', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: null, reasoning_content: '答案在里' },
      }],
    };
    expect(extractContent(data)).toBe('答案在里');
  });

  it('empty content falls back to thinking', () => {
    const data = { choices: [{ message: { content: null, thinking: 'via thinking' } }] };
    expect(extractContent(data)).toBe('via thinking');
  });

  it('non-empty content never mixes in reasoning', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: 'final answer', reasoning: 'chain of thought' },
      }],
    };
    expect(extractContent(data)).toBe('final answer');
  });
});

describe('readSseContent: streaming', () => {
  it('joins delta.content', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('Hello');
  });

  it('all-empty content falls back to joining reasoning deltas', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"…{\\"images\\":[]}"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toContain('"images"');
  });

  it('once content appears, reasoning is ignored and not joined', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"先想"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('答案!');
  });
});

describe('validate: history success = the caller acceptance passed', () => {
  beforeEach(() => {
    h.beginLlm.mockClear();
    h.finishLlm.mockClear();
    h.failLlm.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okPayload)));
  });

  it('acceptance passed → returns the text, history records success', async () => {
    const seen: string[] = [];
    const text = await requestCompletion(channel, messages, {
      validate: raw => seen.push(raw),
    });
    expect(text).toBe('答案文本');
    expect(seen).toEqual(['答案文本']); // validate gets the extracted body text
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
    expect(h.failLlm).not.toHaveBeenCalled();
  });

  it('without validate → keeps the old behaviour: getting text records success', async () => {
    await expect(requestCompletion(channel, messages)).resolves.toBe('答案文本');
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
  });

  it('acceptance throws → the request throws as a failure, history records failure not success', async () => {
    // This is the "HTTP succeeded but the protocol didn't parse" case: it must failLlm, otherwise retries would leave
    // two green success records in history, and anyone reading it would think it succeeded yet was called twice.
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('协议不合法');
        },
      }),
    ).rejects.toThrow('协议不合法');
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, '协议不合法', false);
  });

  it('validate must never be called when HTTP fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const validate = vi.fn();
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('500');
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });
});
