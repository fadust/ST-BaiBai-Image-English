import { afterEach, describe, expect, it, vi } from 'vitest';

import { simpleDefaults } from '@/backends/comfyTemplates';
import {
  generateComfyImage,
  ComfyUIError,
  parseWorkflowTemplate,
  randomSeed,
  renderWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';

const TEMPLATE = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '%seed%', text: '%prompt%', neg: '%negative_prompt%' },
  },
});

function seedOf(workflow: ComfyWorkflow): unknown {
  return (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
}

afterEach(() => vi.restoreAllMocks());

describe('randomSeed', () => {
  it('returns an integer in [0, 2**53)', () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 53);
  });

  it('is derived from Math.random (range = Python random.randint(0, 2**53 - 1))', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(randomSeed()).toBe(Math.floor(0.5 * 2 ** 53));
  });

  it('produces different seeds across calls', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('parseWorkflowTemplate', () => {
  it('hints that placeholders must be quoted strings when JSON parse fails on %', () => {
    try {
      parseWorkflowTemplate('{"3":{"class_type":"KSampler","inputs":{"seed":%seed%}}}');
      expect.unreachable('should throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('placeholders must be written as strings');
      expect(message).toContain('"%seed%"');
    }
  });
});

describe('renderWorkflowTemplate with %seed%', () => {
  it('replaces exact %seed% with a number (not string)', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl' });
    expect(seedOf(workflow)).toBeTypeOf('number');
    expect(seedOf(workflow)).toBeGreaterThanOrEqual(0);
    expect(seedOf(workflow)).toBeLessThan(2 ** 53);
  });

  it('uses the explicitly passed seed when provided', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 42 });
    expect(seedOf(workflow)).toBe(42);
  });

  it('uses the passed seed even when it is 0', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 0 });
    expect(seedOf(workflow)).toBe(0);
  });

  it('replaces every %seed% across all nodes with the same value', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%', note: 'seed=%seed% here' } },
      '9': { class_type: 'SomeNode', inputs: { value: 3 } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl', seed: 12345 });
    const n3 = workflow['3'] as { inputs: { seed: unknown } };
    const n7 = workflow['7'] as { inputs: { noise_seed: unknown; note: unknown } };
    expect(n3.inputs.seed).toBe(12345);
    expect(n7.inputs.noise_seed).toBe(12345);
    // A %seed% embedded in a string is replaced with the same value too
    expect(n7.inputs.note).toBe('seed=12345 here');
  });

  it('replaces every %seed% with the same generated value when not passed', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%' } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl' });
    const a = (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
    const b = (workflow['7'] as { inputs: { noise_seed: unknown } }).inputs.noise_seed;
    expect(a).toBeTypeOf('number');
    expect(a).toBe(b);
  });
});

describe('renderWorkflowTemplate with %nl%', () => {
  it('accepts a semantic-only workflow without a Danbooru prompt input', () => {
    const template = JSON.stringify({ '3': { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } } });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl', nl: 'A woman with red hair wears a blue coat.' });
    expect((workflow['3'] as { inputs: { text: string } }).inputs.text).toBe('A woman with red hair wears a blue coat.');
    expect((renderWorkflowTemplate(template, { prompt: 'An externally supplied prose portrait.' })['3'] as { inputs: { text: string } }).inputs.text).toBe('An externally supplied prose portrait.');
  });
  it('writes nl only into explicit %nl% placeholders, never into %prompt%', () => {
    const template = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl', nl: 'A girl.' });
    expect((workflow['3'] as { inputs: { text: unknown } }).inputs.text).toBe('1girl');
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('A girl.');
  });

  it('substitutes an empty string for %nl% when nl is absent', () => {
    const template = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'caption: %nl%', prompt: '%prompt%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl' });
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('caption: ');
  });
});

describe('renderWorkflowTemplate with %negative_prompt%', () => {
  it('writes the per-image negative prompt into the workflow template', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, {
      prompt: '1girl',
      negative_prompt: 'extra people, duplicate character',
      seed: 1,
    });
    const inputs = (workflow['3'] as { inputs: { neg: unknown } }).inputs;
    expect(inputs.neg).toBe('extra people, duplicate character');
  });
});

describe('renderWorkflowTemplate with %width% / %height%', () => {
  const SIZED = JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%' } },
  });

  it('renders width/height as numbers (EmptyLatentImage rejects strings)', () => {
    const workflow = renderWorkflowTemplate(SIZED, { prompt: '2girls', width: 1216, height: 832 });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(1216);
    expect(inputs.height).toBe(832);
    expect(inputs.width).toBeTypeOf('number');
  });

  it('throws when the workflow uses the placeholders but no size was resolved', () => {
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow(ComfyUIError);
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow('%width%');
  });

  it('ignores a missing size entirely when the workflow hardcodes its own dimensions', () => {
    // Existing workflows (with hardcoded sizes) must be completely unaffected; the frame size is an opt-in feature
    const legacy = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    });
    const workflow = renderWorkflowTemplate(legacy, { prompt: '1girl' });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(512);
    expect(inputs.height).toBe(512);
  });
});

/**
 * Cancel path: must branch by the task's position in the queue.
 * The old implementation blindly POSTed /interrupt; with concurrent generation, cancelling a task further back would interrupt **another task that was running**.
 */
describe('generateComfyImage cancel', () => {
  const CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: TEMPLATE,
    qualityTags: '',
    negativePrompt: '',
    resolution: '',
    portraitSize: '',
    landscapeSize: '',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Records which endpoints the cancel phase hit and with what body. */
  function stubFetch(queueBody: unknown) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/queue')) return json(queueBody);
        // history always returns empty: the task is "unfinished", and polling keeps waiting until abort
        if (url.includes('/history/')) return json({});
        return json({});
      }),
    );
    return calls;
  }

  /**
   * Wait until polling really starts (a /history request appears) before cancelling.
   * Waiting only for /prompt isn't enough: queueDirect may not have returned yet, and the cancel listener isn't registered.
   */
  async function waitForPolling(calls: Array<{ url: string }>): Promise<void> {
    await vi.waitFor(() => expect(calls.some(c => c.url.includes('/history/'))).toBe(true));
  }

  it('task still queued → removed with /queue delete, no interrupt', async () => {
    const calls = stubFetch({
      queue_running: [[0, 'other-running-task']],
      queue_pending: [[1, 'pid-1']],
    });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const cancelCall = calls.find(c => c.url.includes('/queue') && c.body);
      expect(cancelCall?.body).toEqual({ delete: ['pid-1'] });
    });
    // Key: the task that was running wasn't interrupted
    expect(calls.some(c => c.url.includes('/interrupt'))).toBe(false);
  });

  it('task running → interrupt with its own prompt_id', async () => {
    const calls = stubFetch({ queue_running: [[0, 'pid-1']], queue_pending: [] });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const interrupt = calls.find(c => c.url.includes('/interrupt'));
      // With prompt_id: newer ComfyUI validates against it; older versions ignore the body, but we already confirmed the running one is ours
      expect(interrupt?.body).toEqual({ prompt_id: 'pid-1' });
    });
    // Only queued tasks use delete; it shouldn't be sent here
    expect(calls.some(c => c.url.includes('/queue') && c.body)).toBe(false);
  });

  it('onQueue reports the queue position (the running one counts as ahead too)', async () => {
    stubFetch({
      queue_running: [[0, 'other']],
      queue_pending: [
        [1, 'ahead-1'],
        [2, 'pid-1'],
      ],
    });
    const reported: Array<number | null> = [];
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal, {
      onQueue: ahead => reported.push(ahead),
    });
    // 1 pending ahead (ahead-1) + 1 running = 2
    await vi.waitFor(() => expect(reported).toContain(2));
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('when the queue position cannot be found, both are sent (otherwise running but not found would miss the interrupt and waste GPU)', async () => {
    // The queue returns an unparseable shape → fetchQueuePosition gets null (position unknown)
    const calls = stubFetch({ nonsense: true });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      expect(calls.find(c => c.url.includes('/queue') && c.body)?.body).toEqual({
        delete: ['pid-1'],
      });
      expect(calls.find(c => c.url.includes('/interrupt'))?.body).toEqual({ prompt_id: 'pid-1' });
    });
  });
});

/**
 * Simple mode: the preset carries no JSON; comfyTemplates assembles it from the template.
 * It meets custom mode at "have a submittable JSON", so here only the submitted body is checked to be the assembled result.
 */
describe('generateComfyImage simple mode', () => {
  const SIMPLE_CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: '',
    mode: 'simple',
    simple: {
      ...simpleDefaults(),
      model: 'illustrious.safetensors',
      positive: 'masterpiece',
      negative: 'worst quality',
    },
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => vi.unstubAllGlobals());

  function stubSuccessFetch() {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async (): Promise<string> => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/history/')) {
          return json({
            'pid-1': {
              status: { completed: true },
              outputs: { '8': { images: [{ filename: 'BaiBai_00001_.png', type: 'output' }] } },
            },
          });
        }
        if (url.includes('/view')) {
          return { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }), text: async (): Promise<string> => '' };
        }
        return json({});
      }),
    );
    return calls;
  }

  it('submits the assembled workflow (fixed + generated words joined, size taken from the preset)', async () => {
    const calls = stubSuccessFetch();
    const result = await generateComfyImage(SIMPLE_CONN, {
      prompt: '1girl',
      negative_prompt: 'extra people',
      seed: 42,
      size: 'portrait',
    });
    expect(result.filename).toBe('BaiBai_00001_.png');

    const submit = calls.find(c => c.url.endsWith('/prompt'));
    const prompt = (submit?.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(prompt['1'].class_type).toBe('CheckpointLoaderSimple');
    expect(prompt['1'].inputs.ckpt_name).toBe('illustrious.safetensors');
    expect(prompt['3'].inputs.text).toBe('masterpiece, 1girl');
    expect(prompt['4'].inputs.text).toBe('worst quality, extra people');
    expect(prompt['5'].inputs).toMatchObject({ width: 832, height: 1216 });
    expect(prompt['6'].inputs.seed).toBe(42);
    result.revoke();
  });

  it('incomplete config (no model selected) goes to ComfyUIError without sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const conn = {
      ...SIMPLE_CONN,
      simple: { ...simpleDefaults(), model: '' },
    } as unknown as Parameters<typeof generateComfyImage>[0];
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow(ComfyUIError);
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow("Model");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
