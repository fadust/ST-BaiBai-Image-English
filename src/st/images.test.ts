import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

import { deleteUserImage, ImageStoreError, probeUserImage, uploadUserImage } from '@/st/images';

function fakeContext() {
  return { getRequestHeaders: () => ({ 'X-Test': '1' }) };
}

describe('uploadUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('submits per the /api/images/upload protocol (folder → ch_name) and returns the saved path', async () => {
    const fetchMock = vi.fn((url: string, init: any) => {
      expect(url).toBe('/api/images/upload');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        image: 'QUJD',
        format: 'jpg',
        ch_name: '柏宝绘_画师串',
        filename: 'art_1',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ path: '/user/images/柏宝绘_画师串/art_1.jpg' }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const path = await uploadUserImage('柏宝绘_画师串', 'art_1', 'QUJD', 'jpg');
    expect(path).toBe('/user/images/柏宝绘_画师串/art_1.jpg');
  });

  it('server error → ImageStoreError with the status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"error":"bad"}', { status: 400 }))),
    );
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toMatchObject({
      name: 'ImageStoreError',
      status: 400,
    });
  });

  it('200 but the response lacks path → error (the caller must not get an empty path to store in settings)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toBeInstanceOf(
      ImageStoreError,
    );
  });

  it('context unavailable → throws directly without sending a request', async () => {
    mocks.context = null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toBeInstanceOf(
      ImageStoreError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('delete succeeded → true; 404 → false (the file never existed, nothing to clean up)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        expect(url).toBe('/api/images/delete');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).resolves.toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('File not found', { status: 404 }))),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).resolves.toBe(false);
  });

  it('other failures → ImageStoreError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('oops', { status: 500 }))),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).rejects.toMatchObject({
      name: 'ImageStoreError',
      status: 500,
    });
  });
});

describe('probeUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('HEAD reads Content-Length without downloading the image itself', async () => {
    const fetchMock = vi.fn((url: string, init: any) => {
      expect(url).toBe('/user/images/f/a.jpg');
      expect(init.method).toBe('HEAD');
      return Promise.resolve(new Response(null, { status: 200, headers: { 'content-length': '311300' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: true, size: 311300 });
  });

  it('404 → exists:false (the server says clearly it is not there)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: false });
  });

  it('network error/5xx → null: indistinguishable, never to be taken as deleted', async () => {
    // Recording a dropped connection as a deletion would show users a screen full of "File deleted" whenever their network blips
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toBeNull();
  });

  it('missing Content-Length still counts as existing, with size null', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: true, size: null });
  });

  it('timeout abort → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      ),
    );
    await expect(probeUserImage('/user/images/f/a.jpg', 1)).resolves.toBeNull();
  });
});
