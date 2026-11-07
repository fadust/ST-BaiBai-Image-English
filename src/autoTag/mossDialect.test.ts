import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/st/context', () => ({
  getContext: () => ({ name1: 'User', name2: 'Char' }),
  isAiStoryMessage: (m: { is_user?: boolean; is_system?: boolean }) => !m.is_user && !m.is_system,
  isStoryMessage: (m: { is_system?: boolean }) => !m.is_system,
}));

import { autoTagProfile, buildAutoTagMessages } from '@/autoTag/prompt';
import {
  DEFAULT_MOSS_ANIME_SPEC,
  DEFAULT_MOSS_ANIME_THINKING,
  DEFAULT_MOSS_SPEC,
  DEFAULT_MOSS_THINKING,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import type { STContext } from '@/st/context';

function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    mossSpec: '',
    mossThinking: '',
    mossAnimeSpec: '',
    mossAnimeThinking: '',
    ...overrides,
  };
}

function options(): AutoTagSettings {
  return {
    enabled: true,
    contextMessages: 2,
    minImages: 0,
    maxImages: 2,
    retryCount: 1,
    autoGenerate: true,
    prompts: prompts(),
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: 'previous' },
      { name: 'Char', is_user: false, is_system: false, mes: 'target line one\n\ntarget line two' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('MOSS dialect wiring (English fork)', () => {
  beforeEach(() => {
    settings.defaultBackend = 'comfyui';
    const preset = settings.comfyui.workflows[0];
    preset.mode = 'simple';
    preset.naturalLanguage = false;
    preset.specDialect = 'comfy';
    preset.layoutLock = 'auto';
    preset.simple.template = 'checkpoint';
  });

  it('forces nl and swaps to MOSS realistic defaults', async () => {
    const preset = settings.comfyui.workflows[0];
    preset.specDialect = 'moss';
    preset.simple.template = 'moss';
    expect(autoTagProfile()).toMatchObject({ dialect: 'moss', nl: true, layoutLock: 'auto' });
    const messages = await buildAutoTagMessages(context(), 1, options(), null);
    const joined = messages.map(m => m.content).join('\n');
    expect(joined).toContain('MOSS-Image photo realistic prompt design assistant');
    expect(joined).toContain('Pre-output checklist (MOSS natural-language trial)');
    expect(joined).toContain('Use the supplied CHARACTER SHEET');
    expect(joined).toContain('Prefer English');
    expect(joined).toContain('Write the complete picture as coherent natural-language prose in nl');
    expect(joined).not.toContain('tag and nl both carry');
    expect(joined).not.toContain('lock one shot size');
    expect(joined).not.toContain('Chinese scene');
    expect(joined).not.toContain('%negative_prompt%');
  });

  it('uses the same body for anime and suppresses legacy page bubbles', async () => {
    const preset = settings.comfyui.workflows[0];
    preset.specDialect = 'moss-anime';
    preset.layoutLock = 'page';
    preset.simple.template = 'moss-anime';
    expect(autoTagProfile()).toMatchObject({ dialect: 'moss-anime', nl: true, layoutLock: 'page' });
    const messages = await buildAutoTagMessages(context(), 1, options(), null);
    const joined = messages.map(m => m.content).join('\n');
    expect(joined).toContain('MOSS-Image anime illustration prompt design assistant');
    expect(joined).toContain('Legacy strip/page settings do not request panels or speech bubbles');
    expect(joined).not.toContain('tailed oval bubbles');
    expect(joined).not.toContain('Chinese narrative');
    expect(DEFAULT_MOSS_THINKING).toContain('checklist, not a reasoning puzzle');
    expect(DEFAULT_MOSS_ANIME_THINKING).toBe(DEFAULT_MOSS_THINKING);
    expect(DEFAULT_MOSS_SPEC.split('\n').slice(1)).toEqual(DEFAULT_MOSS_ANIME_SPEC.split('\n').slice(1));
    expect(DEFAULT_MOSS_SPEC).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
