/**
 * 检测更新:对比本地版本与远端 GitHub 仓库 manifest.json 的版本,
 * 有新版本则提示用户,确认后走 ST 扩展更新 API 自动更新并刷新。
 */

import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import { reactive } from 'vue';

const CURRENT_VERSION = PLUGIN_VERSION;

/**
 * 更新检测的比对源。
 *
 * ⚠ 必须指向**本扩展实际推送的那个仓库**(git remote origin),否则检测就是对着一个
 * 早已停更的副本做比较:baibai-git/ST-BaiBai-Image 停在 0.3.2,而工作副本早已 0.3.5+,
 * 结果是新版本永远提示不出来、老用户永远收不到更新,而且不会有任何报错——静默失效最难查。
 *
 * 换远端仓库时(fork / 改名 / 迁移),这里要跟着一起改;update.test.ts 有一条断言盯着它。
 */
export const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/yyds-1234/ST-BaiBai-Image/main/manifest.json';

export const updateState = reactive({
  current: CURRENT_VERSION,
  latest: '',
  available: false,
  checking: false,
  updating: false,
});

let checkedThisSession = false;

export function isNewer(a: string, b: string): boolean {
  if (!a || !b) return false;
  const remote = a.split('.').map(part => Number.parseInt(part, 10) || 0);
  const current = b.split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(remote.length, current.length);
  for (let index = 0; index < length; index++) {
    const remotePart = remote[index] ?? 0;
    const currentPart = current[index] ?? 0;
    if (remotePart > currentPart) return true;
    if (remotePart < currentPart) return false;
  }
  return false;
}

async function readRemoteVersion(): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return '';
      const manifest = (await response.json()) as { version?: string };
      return String(manifest.version ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

export async function checkForUpdate(force = false): Promise<void> {
  if (updateState.checking || (checkedThisSession && !force)) return;
  updateState.checking = true;
  try {
    const latest = await readRemoteVersion();
    if (latest) {
      updateState.latest = latest;
      updateState.available = isNewer(latest, CURRENT_VERSION);
    }
    checkedThisSession = true;
  } finally {
    updateState.checking = false;
  }
}

function extensionFolderName(): string {
  try {
    const path = new URL(import.meta.url).pathname;
    const marker = '/third-party/';
    const markerIndex = path.indexOf(marker);
    if (markerIndex >= 0) {
      const folder = path.slice(markerIndex + marker.length).split('/')[0];
      if (folder) return folder;
    }
  } catch {
    // 解析失败时回退固定目录名。
  }
  return 'ST-BaiBai-Image';
}

async function discoverExtensionType(folder: string): Promise<'global' | 'local' | 'system' | null> {
  try {
    const headers = getContext()?.getRequestHeaders?.() ?? {};
    const response = await fetch('/api/extensions/discover', {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const extensions = (await response.json()) as Array<{ name?: string; type?: string }>;
    const extension = extensions.find(item => item.name === `third-party/${folder}`);
    return extension?.type === 'global' || extension?.type === 'local' || extension?.type === 'system'
      ? extension.type
      : null;
  } catch {
    return null;
  }
}

export async function performUpdate(): Promise<void> {
  if (updateState.updating) return;
  updateState.updating = true;
  try {
    const folder = extensionFolderName();
    const type = await discoverExtensionType(folder);
    const headers = getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    const response = await fetch('/api/extensions/update', {
      method: 'POST',
      headers,
      body: JSON.stringify({ extensionName: folder, global: type === 'global' }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(message || response.statusText || `HTTP ${response.status}`);
    }
    updateState.available = false;
    setTimeout(() => location.reload(), 800);
  } finally {
    updateState.updating = false;
  }
}
