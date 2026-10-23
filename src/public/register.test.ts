import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { STBaiBaiImageApi } from '@/public/types';
import { charTagLib, emptyCharFields, type CharTagEntry } from '@/state/charTags';

vi.mock('@/st/context', () => ({ getContext: () => ({ getCurrentChatId: () => 'chat-a' }) }));

// This plugin runs in the browser, where ready/changed are **real events**; the test environment is node, with no window.
// EventTarget stands in: addEventListener/dispatchEvent behave the same as in the browser,
// enough to lock down "whether third parties get notified". It must be set up before importing register.
vi.stubGlobal('window', new EventTarget());

const { PUBLIC_CHANGED_EVENT, PUBLIC_READY_EVENT, registerPublicInterface } =
  await import('@/public/register');

function api(): STBaiBaiImageApi {
  return (globalThis as { STBaiBaiImage?: STBaiBaiImageApi }).STBaiBaiImage!;
}

function entry(name: string): CharTagEntry {
  return { name, fields: emptyCharFields(), raw: '', nl: '', source: 'ai', desc: '', history: [] };
}

/** Waits for both queueMicrotask and the Vue watch flush to finish. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  charTagLib.entries = [];
});

describe('registerPublicInterface', () => {
  it('publishes on globalThis and announces readiness (the two ways to find it)', async () => {
    const ready = vi.fn();
    // Third parties loaded before BaiBai Image can only rely on events; offering only globalThis would force them to write their own polling
    window.addEventListener(PUBLIC_READY_EVENT, ready);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    registerPublicInterface();
    await settle();

    expect(api()).toBeDefined();
    expect(ready).toHaveBeenCalledTimes(1);
    const detail = (ready.mock.calls[0][0] as CustomEvent).detail as Record<string, unknown>;
    expect(detail).toMatchObject({ type: 'ready', apiVersion: 1, chatId: 'chat-a' });
    expect(detail.capabilities).toMatchObject({ generate: true, characterLibrary: true });
  });

  it('is idempotent: a second call does not re-announce or replace the object', () => {
    const ready = vi.fn();
    window.addEventListener(PUBLIC_READY_EVENT, ready);
    const first = api();
    registerPublicInterface();
    expect(api()).toBe(first);
    expect(ready).not.toHaveBeenCalled();
  });

  it('freezes the api so one plugin cannot rewrite what the next one gets', () => {
    const target = api() as unknown as Record<string, unknown>;
    expect(() => { target.generate = () => {}; }).toThrow();
    expect(typeof api().generate).toBe('function');
  });

  it('hands out a fresh capabilities copy each read', () => {
    (api().capabilities as unknown as Record<string, unknown>).generate = false;
    expect(api().capabilities.generate).toBe(true);
  });

  it('notifies subscribers when the character library changes, and stops on unsubscribe', async () => {
    const seen: unknown[] = [];
    const off = api().subscribe(notice => seen.push(notice));

    charTagLib.entries = [entry('阿黛尔')];
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'changed', apiVersion: 1 });

    off();
    charTagLib.entries = [entry('别的')];
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('coalesces a burst of library recomputes into one notice', async () => {
    const seen: unknown[] = [];
    const off = api().subscribe(notice => seen.push(notice));
    // Switching chats/deleting floors/swiping triggers several recomputations in a row; without batching a third party would get a dozen identical notifications a second,
    // each of which might make it do a full refresh
    charTagLib.entries = [entry('a')];
    charTagLib.entries = [entry('b')];
    charTagLib.entries = [entry('c')];
    await settle();
    expect(seen).toHaveLength(1);
    off();
  });

  it('gives each subscriber its own copy so one cannot corrupt the next', async () => {
    const second: Array<Record<string, unknown>> = [];
    const offA = api().subscribe(notice => {
      const mutable = notice as unknown as Record<string, unknown>;
      mutable.type = '被改了';
      (mutable.capabilities as Record<string, unknown>).generate = false;
    });
    const offB = api().subscribe(notice => second.push(notice as unknown as Record<string, unknown>));

    charTagLib.entries = [entry('x')];
    await settle();

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'changed' });
    expect((second[0].capabilities as { generate: boolean }).generate).toBe(true);
    offA();
    offB();
  });

  it('survives a subscriber that throws, and still fires the DOM event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changed = vi.fn();
    window.addEventListener(PUBLIC_CHANGED_EVENT, changed);
    const good = vi.fn();
    const offA = api().subscribe(() => { throw new Error('第三方崩了'); });
    const offB = api().subscribe(good);

    charTagLib.entries = [entry('y')];
    await settle();

    // One third party crashing must not take down the other subscribers and event listeners
    expect(good).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('rejects a non-function subscriber loudly instead of silently doing nothing', () => {
    expect(() => api().subscribe(null as never)).toThrow(TypeError);
  });
});
