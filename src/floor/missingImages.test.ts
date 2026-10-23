import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

import {
  confirmImageMissing,
  isImageMissing,
  markImageMissing,
  markImagesMissing,
  normalizeImagePath,
  resetMissingImages,
} from '@/floor/missingImages';
import { probeUserImage } from '@/st/images';

vi.mock('@/st/images', () => ({ probeUserImage: vi.fn() }));

beforeEach(() => {
  resetMissingImages();
  vi.mocked(probeUserImage).mockReset();
});

describe('normalizeImagePath', () => {
  it('decodes and strips the leading slash so the extra and gallery forms can compare equal', () => {
    // extra holds the unencoded path returned as-is by the server; the gallery side is encodeURIComponent'd segment by segment
    const fromExtra = '/user/images/柏宝绘_爱丽丝/bbi_a_0_b-g1.png';
    const fromGallery = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/bbi_a_0_b-g1.png';
    expect(normalizeImagePath(fromExtra)).toBe(normalizeImagePath(fromGallery));
  });

  it('half-encoded percent sequences do not throw and compare as raw text', () => {
    expect(normalizeImagePath('/user/images/100%/a.png')).toBe('user/images/100%/a.png');
  });
});

describe('missingImages', () => {
  it('after marking, matches by the normalised rule, encoded or not', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png')).toBe(true);
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/a.png')).toBe(true);
  });

  it('unmarked images do not count as missing', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/b.png')).toBe(false);
  });

  it('bulk marking', () => {
    markImagesMissing(['/user/images/f/a.png', '/user/images/f/b.png']);
    expect(isImageMissing('/user/images/f/a.png')).toBe(true);
    expect(isImageMissing('/user/images/f/b.png')).toBe(true);
  });

  it('empty paths are neither written nor matched', () => {
    markImageMissing('');
    expect(isImageMissing('')).toBe(false);
  });
});

describe('confirmImageMissing', () => {
  const path = '/user/images/柏宝绘_爱丽丝/a.png';

  it('recorded only on an explicit server 404', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('never recorded when unclear (network error/500)', async () => {
    // An <img> error can't tell "file gone" from "network down". Recording a dropped connection as a deletion
    // would fill the screen with "File deleted" whenever the network blips, and it wouldn't recover until a refresh.
    vi.mocked(probeUserImage).mockResolvedValue(null);
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('not recorded while the file still exists', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: true, size: 1024 });
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('each image probed only once: recorded ones return directly, and concurrent latecomers send no duplicate request', async () => {
    let settle!: (probe: { exists: false }) => void;
    vi.mocked(probeUserImage).mockReturnValue(new Promise(resolve => { settle = resolve; }));
    // Re-hydration remounts the <img>, so the error comes again
    const first = confirmImageMissing(path);
    expect(await confirmImageMissing(path)).toBe(false); // In flight; no second HEAD is sent
    settle({ exists: false });
    expect(await first).toBe(true);
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);

    expect(await confirmImageMissing(path)).toBe(true); // Already recorded; matches directly
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);
  });

  it('only images under user/images: old images and foreign paths are never probed', async () => {
    // This plugin never deletes old images in user/files, so there is no "deleted by the gallery" path for them
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing('/user/files/old.png')).toBe(false);
    expect(await confirmImageMissing('https://example.com/a.png')).toBe(false);
    expect(await confirmImageMissing('')).toBe(false);
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
  });

  it('encoded paths are also recognised as user/images and share a key with the unencoded form', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    const encoded = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png';
    expect(await confirmImageMissing(encoded)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('releases the in-flight mark when probing throws, so it can retry next time', async () => {
    vi.mocked(probeUserImage).mockRejectedValueOnce(new Error('boom'));
    await expect(confirmImageMissing(path)).rejects.toThrow('boom');
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
  });
});

describe('reactivity', () => {
  // The card's liveHistory/liveStale/filesGone are all computed(isImageMissing(...)).
  // If this record degraded to a plain Set, cards wouldn't recompute after marking: after the gallery deletes images, open floors would still show broken images
  // until the next hydration. What this locks down is "marking drives computed", not Set semantics.
  it('computed recomputes immediately after marking', () => {
    const a = '/user/images/f/a.png';
    const gone = computed(() => isImageMissing(a));
    expect(gone.value).toBe(false);
    markImageMissing(a);
    expect(gone.value).toBe(true);
  });

  it('only the marked image is affected, not other images in the same folder', () => {
    const b = '/user/images/f/b.png';
    const gone = computed(() => isImageMissing(b));
    expect(gone.value).toBe(false);
    markImageMissing('/user/images/f/a.png');
    expect(gone.value).toBe(false);
  });
});
