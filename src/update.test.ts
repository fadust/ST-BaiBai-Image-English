import { describe, expect, it } from 'vitest';

import { REMOTE_MANIFEST_URL, isNewer } from './update';

describe('isNewer', () => {
  it('compares numeric version segments', () => {
    expect(isNewer('0.1.3', '0.1.2')).toBe(true);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });
});

describe('更新比对源', () => {
  it('指向本扩展实际推送的仓库(origin)', () => {
    // 这条断言的价值:比对源指错了不会报任何错,只会静默地永远检测不到新版。
    // 曾经它指向 baibai-git/…(停在 0.3.2),而远端早已 0.3.5+,装了新版的人也看不见更新提示。
    expect(REMOTE_MANIFEST_URL).toBe(
      'https://raw.githubusercontent.com/yyds-1234/ST-BaiBai-Image/main/manifest.json',
    );
  });

  it('走 raw.githubusercontent.com 且指向 manifest.json', () => {
    const url = new URL(REMOTE_MANIFEST_URL);
    expect(url.host).toBe('raw.githubusercontent.com');
    expect(url.pathname.endsWith('/manifest.json')).toBe(true);
    // 分支写死 main:默认分支改名会让检测 404,而 readRemoteVersion 把 404 静默吞成空串
    expect(url.pathname).toContain('/main/');
  });
});
