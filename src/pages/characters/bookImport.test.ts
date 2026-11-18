import { createRenderer, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { requestViaMainApi } from '@/api/client';
import { emptyCharFields, upsertCharTag, type CharTagEntry } from '@/state/charTags';
import Characters from './index.vue';

vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/state/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@/state/settings')>(),
  getTagGenChannel: () => null,
}));
vi.mock('@/st/context', () => ({
  getContext: () => ({ chat: [{ mes: 'The lantern went out.' }], name1: 'Player' }),
}));
vi.mock('@/state/globalCharTags', () => ({ globalCharTagLib: { entries: [] } }));
vi.mock('@/state/charTags', async importOriginal => ({
  ...await importOriginal<typeof import('@/state/charTags')>(),
  upsertCharTag: vi.fn(() => true),
}));

afterEach(() => vi.unstubAllGlobals());

it('previews and saves a partial Book import without discarding the rest of the sheet', async () => {
  vi.stubGlobal('toastr', { success: vi.fn(), error: vi.fn() });
  vi.stubGlobal('STBaiBaiBook', {
    apiVersion: 1,
    getContextAtFloor: () => ({
      floorData: { memory: { valid: true } },
      snapshotAfter: {
        revision: 1,
        npcs: [{ name: 'Mara', important: true, desc: 'Pale skin.' }],
      },
    }),
  });
  vi.mocked(requestViaMainApi).mockResolvedValue('{"Mara":{"skin":"pale skin","hair":"","eyes":""}}');

  // Render only a comment. Exercise the handlers from the real editor setup.
  const renderer = createRenderer({
    createComment: () => ({}),
    insert() {},
    remove() {},
  } as unknown as Parameters<typeof createRenderer>[0]);
  const app = renderer.createApp({ ...Characters, render: () => null });
  app.provide(ssrContextKey, {});
  const instance = app.mount({});
  const { setupState: editor } = instance.$ as unknown as {
    setupState: {
      openEntry(entry: CharTagEntry, scope: 'chat'): void;
      regenerateFromBook(): Promise<void>;
      previewTag: string;
      confirmEntry(): void;
    };
  };
  const fields = {
    ...emptyCharFields(), hair: 'black hair', eyes: 'green eyes', outfit: 'red cloak', skin: 'fair skin',
  };
  editor.openEntry({ name: 'Mara', fields, raw: '', nl: '', desc: '', source: 'manual', history: [] }, 'chat');
  await editor.regenerateFromBook();
  expect(editor.previewTag).toContain('black hair, green eyes, pale skin');
  expect(upsertCharTag).not.toHaveBeenCalled();
  editor.confirmEntry();
  expect(upsertCharTag).toHaveBeenCalledWith(
    expect.objectContaining({ fields: { ...fields, skin: 'pale skin' }, source: 'book' }),
    'Mara',
    { recordChanges: true },
  );
  app.unmount();
});
