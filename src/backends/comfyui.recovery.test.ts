import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateComfyImage } from './comfyui';

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}) }),
}));

const BASE = 'http://comfy.test:8188/comfy';
const HISTORY = `${BASE}/history/original-id`;
const VIEW = `${BASE}/view?filename=scene.png&subfolder=images&type=output`;
const PROXY = '/api/sd/comfy/generate';
const CONN = {
  url: BASE,
  workflow: JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
  }),
} as Parameters<typeof generateComfyImage>[0];

function completedHistory() {
  return Response.json({
    'original-id': {
      status: { completed: true },
      outputs: { '1': { images: [{ filename: 'scene.png', subfolder: 'images', type: 'output' }] } },
    },
  });
}

function image() {
  return new Response('png', { headers: { 'Content-Type': 'image/png' } });
}

function mockFetch(respond: (url: string) => Promise<Response> | Response) {
  const request = vi.fn(async (url: string) => respond(url));
  vi.stubGlobal('fetch', request);
  return { paths: () => request.mock.calls.map(([url]) => url) };
}

function directResponse(url: string) {
  if (url === `${BASE}/system_stats`) return Response.json({});
  if (url === `${BASE}/prompt`) return Response.json({ prompt_id: 'original-id' });
  throw new Error(`Unexpected request: ${url}`);
}

describe('ComfyUI result recovery', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recovers from a failed history request and interrupted image download on the original job', async () => {
    let historyReads = 0;
    let imageReads = 0;
    const fetch = mockFetch(url => {
      if (url === HISTORY) {
        return ++historyReads === 1 ? new Response('temporary outage', { status: 503 }) : completedHistory();
      }
      if (url === VIEW) {
        if (++imageReads > 1) return image();
        return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('Connection lost during download')); },
        }));
      }
      return directResponse(url);
    });

    const promise = generateComfyImage(CONN, { prompt: 'scene' });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toMatchObject({ filename: 'scene.png', format: 'png' });
    result.revoke();
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, `${BASE}/prompt`, HISTORY, HISTORY, VIEW, VIEW]);
  });

  it('reports the original job when recovery is exhausted', async () => {
    const fetch = mockFetch(url => {
      if (url === HISTORY) throw new TypeError('Connection lost');
      return directResponse(url);
    });
    const settled = expect(generateComfyImage(CONN, { prompt: 'scene' }))
      .rejects.toThrow('job original-id');
    await vi.runAllTimersAsync();
    await settled;
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, `${BASE}/prompt`, ...Array<string>(4).fill(HISTORY)]);
  });

  it('reports an authorization error without retrying the history request', async () => {
    const fetch = mockFetch(url => url === HISTORY
      ? new Response('authorization required', { status: 401 })
      : directResponse(url));
    await expect(generateComfyImage(CONN, { prompt: 'scene' })).rejects.toMatchObject({ status: 401 });
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, `${BASE}/prompt`, HISTORY]);
  });

  it('stops retrying after cancellation and keeps the existing queue cleanup', async () => {
    const fetch = mockFetch(url => {
      if (url === HISTORY) throw new TypeError('Connection lost');
      if (url === `${BASE}/queue`) {
        return Response.json({ queue_running: [], queue_pending: [[1, 'original-id']] });
      }
      return directResponse(url);
    });
    const controller = new AbortController();
    const settled = expect(generateComfyImage(CONN, { prompt: 'scene' }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    await settled;
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, `${BASE}/prompt`, HISTORY, `${BASE}/queue`, `${BASE}/queue`]);
  });

  it('does not submit through the proxy after a direct POST fails ambiguously', async () => {
    const fetch = mockFetch(url => {
      if (url === `${BASE}/prompt`) throw new TypeError('Connection lost before confirmation');
      return directResponse(url);
    });
    await expect(generateComfyImage(CONN, { prompt: 'scene' })).rejects.toThrow('Connection lost before confirmation');
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, `${BASE}/prompt`]);
  });

  it('preserves the normal server proxy path when the browser cannot reach ComfyUI', async () => {
    const fetch = mockFetch(url => {
      if (url === `${BASE}/system_stats`) throw new TypeError('Browser cannot reach ComfyUI');
      if (url === PROXY) return Response.json({ format: 'png', data: 'cG5n' });
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await generateComfyImage(CONN, { prompt: 'scene' });
    expect(result.url).toBe('data:image/png;base64,cG5n');
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, PROXY]);
  });

  it.each([
    [HISTORY, [HISTORY, VIEW]],
    [VIEW, [VIEW]],
  ])('recovers an existing job or file from a recognized proxy transport error', async (failedUrl, reads) => {
    const fetch = mockFetch(url => {
      if (url === `${BASE}/system_stats`) throw new TypeError('Browser connection failed');
      if (url === PROXY) return new Response(`request to ${failedUrl} failed, reason: socket hang up`, { status: 500 });
      if (url === HISTORY) return completedHistory();
      if (url === VIEW) return image();
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await generateComfyImage(CONN, { prompt: 'scene' });
    expect(result.filename).toBe('scene.png');
    result.revoke();
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, PROXY, ...reads]);
  });

  it.each([
    'ComfyUI returned an error.',
    `request to ${BASE}/prompt failed, reason: socket hang up`,
    'request to http://other.test/comfy/history/original-id failed, reason: socket hang up',
    'request to http://comfy.test:8188/comfy-other/history/original-id failed, reason: socket hang up',
  ])('surfaces the proxy failure when it cannot identify a same-server result', async body => {
    const fetch = mockFetch(url => {
      if (url === `${BASE}/system_stats`) throw new TypeError('Browser connection failed');
      if (url === PROXY) return new Response(body, { status: 500 });
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(generateComfyImage(CONN, { prompt: 'scene' })).rejects.toThrow(body);
    expect(fetch.paths()).toEqual([`${BASE}/system_stats`, PROXY]);
  });
});
