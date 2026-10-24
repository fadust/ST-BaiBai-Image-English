import { describe, expect, it } from 'vitest';

import { autoTagProfile, buildAutoTagMessages, expandNlSections } from '@/autoTag/prompt';
import {
  activeComfyPreset,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * Prompt set: everything blank (= fall back to built-in defaults), overriding only the few items this case cares about.
 * Kept in one place because every key added to AutoTagPrompts would make scattered literals fail typecheck at once.
 */
function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
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

describe('auto tag prompt', () => {
  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ jailbreak: '附加规则' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.role === 'system' && m.content.includes("You are a rigorous plot screen planner"))).toBe(true);
    expect(messages.some(m => m.content.includes("Please complete the check briefly in <thinking>...</thinking> first, then output the final JSON. Nothing other than an <thinking> block and an JSON object must be returned, and do not use Markdown code blocks. The final result must contain and can contain only one parsable JSON object, with a fixed format of:"))).toBe(true);
    expect(messages.some(m => m.content.includes("Please complete the check briefly in <thinking>...</thinking> first, then output the final JSON. Nothing other than an <thinking> block and an JSON object must be returned, and do not use Markdown code blocks. The final result must contain and can contain only one parsable JSON object, with a fixed format of:"))).toBe(true);
    expect(messages.some(m => m.content.includes("images must contain between 0 and 3 items"))).toBe(true);
    expect(messages.some(m => m.content.includes("An empty array can be returned"))).toBe(true);
    expect(messages.some(m => m.content.includes("cannot contain quality words"))).toBe(true);
    expect(messages.some(m => m.content.includes("1. Complete the character profile and change check first, and then select pictures; you cannot skip the changes check because there are no pictures or the number of pictures is small. If there are no changes, changes returns an empty array."))).toBe(true);
    expect(messages.some(m => m.content.includes("Multiple images must be of a single moment with significantly different plot or visual status, and do not return to adjacent action or shot-change versions of the same event."))).toBe(true);
    expect(messages.some(m => m.content.includes("Having two people in the same frame does not mean that the screen must be horizontal. The direction must be consistent with the lens word in tag (wide, shot usually matches landscape, close-up / upper, body usually matches portrait)."))).toBe(true);
    expect(messages.some(m => m.content.includes('"field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('"hair":"long black hair","eyes":"blue eyes"'))).toBe(true);
    expect(messages.some(m => m.content.includes("- **Profile before drawing**: read the target text and find every named character not yet in the 【 character fixed appearance library 】. If the card, World Info, BaiBai Book or ongoing story gives that character a setting, or the character keeps taking part in the plot, create a profile at their first appearance, whether or not they are drawn this time. Judge from all the setting content you were given. One-time nameless passers-by get no profile."))).toBe(true);
    expect(messages.some(m => m.content.includes("- **Profile before drawing**: read the target text and find every named character not yet in the 【 character fixed appearance library 】. If the card, World Info, BaiBai Book or ongoing story gives that character a setting, or the character keeps taking part in the plot, create a profile at their first appearance, whether or not they are drawn this time. Judge from all the setting content you were given. One-time nameless passers-by get no profile."))).toBe(true);
    expect(messages.some(m => m.content.includes("- Source priority: current appearance in the target text > current state in BaiBai Book > card or World Info > reasonable completion. Copy colours stated in the setting exactly. hair and eyes are required: hair has colour and length or style, eyes has colour. A profile missing either is discarded."))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes("- If the setting gives no hair colour, hairstyle or eye colour, choose a simple, coherent look that fits the world, race, role and personality. This is decided once and never re-rolled."))).toBe(true);
    // Profile creation is unaffected by selection and not gated by position: these two are the core of the fix, and the wording must be in the protocol
    expect(messages.some(m => m.content.includes("- **Profile before drawing**: read the target text and find every named character not yet in the 【 character fixed appearance library 】. If the card, World Info, BaiBai Book or ongoing story gives that character a setting, or the character keeps taking part in the plot, create a profile at their first appearance, whether or not they are drawn this time. Judge from all the setting content you were given. One-time nameless passers-by get no profile."))).toBe(true);
    expect(messages.some(m => m.content.includes("- Profile format: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"first appearance\"}. position is where the character first appears and is for the record only; the profile applies to the whole floor at once."))).toBe(true);
    // The withdrawn characters audit must not flow back into the protocol
    expect(messages.some(m => m.content.includes("\"characters\""))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain("[system-maintained; currently empty]");
    expect(user.content).toContain("【 character fixed appearance library 】[system-maintained; currently empty]\n(No character is profiled yet. World Info, the character card, BaiBai Book and the text are only evidence for new profiles; every named character not listed in this block must be profiled with field:\"new\".)");
    expect(user.content).not.toContain("The upper layer to be hung does not exist, or that layer is not a collection.");
    expect(user.content).toContain('目标第一行 ⟦P1⟧\n\n目标第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('turns a positive minimum into a strict image-count range', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 2,
      maxImages: 4,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes("images must contain between 2 and 4 items"))).toBe(true);
    expect(messages.some(m => m.content.includes("The minimum of 2 is an explicit user requirement"))).toBe(true);
    expect(messages.some(m => m.content.includes("no less than 2 images or an empty array"))).toBe(true);
  });

  it('uses the prepared target snapshot without recomputing position IDs', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      null,
      {
        promptText: '请求开始时的正文快照 ⟦P9⟧',
        segments: [{ id: 'P9', sourceLine: 7, text: '请求开始时的正文快照' }],
      },
    );
    const user = messages[messages.length - 1];

    expect(user.content).toContain('请求开始时的正文快照 ⟦P9⟧');
    expect(user.content).not.toContain('目标第一行 ⟦P1⟧');
  });

  it('counts context by AI floors, keeps interleaved user floors, and preserves prior image tags', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早用户楼' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隐藏思维</think>
<bbs_start>上午</bbs_start>
上一个 AI 楼
<snow>状态栏</snow>
<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>
<bbs_end>中午</bbs_end>
尾部状态`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '当前目标楼' },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };

    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 1];
    expect(user.content).not.toContain('更早用户楼');
    expect(user.content).toContain('上一个 AI 楼');
    expect(user.content).toContain('<bbi_image>1girl, long silver hair, red eyes<size>portrait</size></bbi_image>');
    expect(user.content).toContain('中间用户楼');
    expect(user.content).not.toContain('隐藏思维');
    expect(user.content).not.toContain("Take a look at whether the item in the status bar should be a number or text, and then diagnose again.");
    expect(user.content).not.toContain('尾部状态');
    expect(user.content).not.toContain('上下文楼层');
    expect(user.content).toContain('当前目标楼 ⟦P1⟧');
    expect(user.content).not.toContain('上一个 AI 楼 ⟦P');
  });

  it('attaches the built-in thinking checklist by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes("Pre-output checklist"));
    expect(thinkingMsg?.role).toBe('system');
    const thinking = thinkingMsg?.content ?? '';
    const text = messages.map(m => m.content).join('\n');

    // The thought chain is an ordered checklist: layers, steps and slots. The rules themselves are stated once, elsewhere.
    expect(thinking).toContain("this checklist only orders the work");
    expect(thinking).toContain("Work through the steps below inside <thinking></thinking>, then output the final JSON. Output nothing except this one <thinking> block and the final JSON. Never open a second <thinking> block.");
    expect(thinking).toContain("Layer one | Global judgments (once for the whole floor)");
    expect(thinking).toContain("Layer two | Image slot blocks (one block per P selected in E; never merged or shared)");
    expect(thinking).toContain("Layer three | Check before writing");
    for (const step of ['A. Facts and state ledger', 'B. Character roll call and profiles', 'C. Outfit timeline', 'D. Era and world', 'E. Scene selection', 'F. Content gate']) {
      expect(thinking).toContain(step);
    }
    for (const slot of ['Characters:', 'Core action:', 'Shot:', 'Setting:', 'Ambient light:', 'size:', 'Content:']) {
      expect(thinking).toContain(slot);
    }
    expect(thinking).toContain("Character rows (one row per character present): <character name>｜expression｜gaze｜outfit visible in this shot｜temporary state｜personal action");
    expect(thinking).toContain("core action, shot, expression, gaze, setting, ambient light and size are never \"-\"");
    // Over-limit reselection happens in E, never in layer three.
    expect(thinking).toContain("Count before writing the P list and cut to the maximum here");

    // Told once: the thought chain no longer restates specification or protocol rules.
    for (const restated of ['pale skin', 'pantyhose', 'muddy', 'looking at viewer', 'Profile format', 'school uniform']) {
      expect(thinking).not.toContain(restated);
    }
    // Each rule still exists exactly once in the message set.
    for (const once of [
      'The expressions are selected from the actual existing tag',
      "- None of the skin color words are written by default",
      '- Profile format:',
      'navy blazer, white collared shirt, red tie',
      'Write landscape for group portraits',
    ]) {
      expect(text.split(once).length - 1).toBe(1);
    }
    expect(messages.some(m => m.content.includes("Write landscape for group portraits, long-range panoramas, wide scenes, and horizontally unfolding interactions; write portrait for single people, vertical stances, close-ups, and close-up compositions of two people."))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('双人近距离可 portrait');
    expect(thinkingMsg?.content).not.toContain('hair 与 eyes 都不得留空');
    expect(messages.some(m => m.content.includes("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped."))).toBe(true);
    expect(messages.some(m => m.content.includes("- Profile format: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"first appearance\"}. position is where the character first appears and is for the record only; the profile applies to the whole floor at once."))).toBe(true);
    expect(messages.some(m => m.content.includes("- A permanent change takes effect at its position: images before it use the old profile, and images at or after it use the new one. Report several changes separately."))).toBe(true);
    expect(messages.some(m => m.content.includes("When there is a clear setting, strictly follow it; when there is no clear setting, you must also take the initiative to choose the most reasonable, specific and self-consistent era, civilization or original visual system based on the existing clues and plot temperament. When there is less evidence, the style of the era, clothing styles, materials, accessories, light and tone can be reasonably supplemented, but this is limited to \"how to draw\" and cannot be used to make up \"what is in the picture\"."))).toBe(true);
    expect(messages.some(m => m.content.includes("Just write outdoors when the text only confirms \"wild\", write forest when only confirm \"forest\"; only write muddy, ground, dirt, path, puddles, etc. corresponding to tag when the text, context or world settings clearly support the facts such as rain, mud, dirt road, etc."))).toBe(true);
    expect(messages.some(m => m.content.includes("Implement judgment into the details that are actually visible in the picture: when the characters are visible, priority is given to improving clothing styles, materials, and accessories; when the background is visible, only the buildings, furniture, environments, and utensils that can be supported by the setting or text are added. Terrain, ground or road materials, weather traces and environmental conditions are all scene facts. Keep it simple if there is no basis for it. You are not allowed to add mud, dirt roads, wetlands, stagnant water, snow, dust or slippery ground in order to enrich the picture."))).toBe(true);
    expect(messages.some(m => m.content.includes("navy blazer, white collared shirt, red tie"))).toBe(true);
    expect(messages.some(m => m.content.includes("- **What counts as profiled**: only a name actually listed in the 【 character fixed appearance library 】 block."))).toBe(true);
    expect(messages.some(m => m.content.includes("- In a multi-character image, bind each character's hair colour, eye colour, build, outfit, objects and own actions next to that character's distinctive reference. Never scatter two people's traits in a shared tag string that cannot be attributed."))).toBe(true);
    expect(messages.some(m => m.content.includes("2. The era and world view (clothing system, architecture, utensils, environmental style) - **must be judged first and actively embodied**."))).toBe(true);
    expect(messages.some(m => m.content.includes("In a word: lens, composition, light, tone, etc. ** how to shoot ** can be actively specified; ** characters, actions, terrain, ground materials, weather traces and environmental conditions, etc. ** what is in the picture must be based on the text and settings. Being specific does not mean making it up."))).toBe(true);
    expect(messages.some(m => m.content.includes("Implement judgment into the details that are actually visible in the picture: when the characters are visible, priority is given to improving clothing styles, materials, and accessories; when the background is visible, only the buildings, furniture, environments, and utensils that can be supported by the setting or text are added. Terrain, ground or road materials, weather traces and environmental conditions are all scene facts. Keep it simple if there is no basis for it. You are not allowed to add mud, dirt roads, wetlands, stagnant water, snow, dust or slippery ground in order to enrich the picture."))).toBe(true);
    expect(messages.some(m => m.content.includes('允许为了完成画面作合理猜测'))).toBe(false);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain("---Target text｜");
  });

  it('uses custom thinking when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ comfyThinking: '自定义清单' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('自定义清单'))).toBe(true);
    expect(messages.some(m => m.content.includes("Pre-output checklist"))).toBe(false);
    // The prefill feature was removed: the assistant role should no longer appear in the messages.
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  // The thought chain is stored per backend. Changing the ComfyUI one must not affect NAI; sharing one was exactly the root cause of V5 being asked to fill
  // fields its specification never taught, like "shot size/ambient light/adjacency binding".
  it('picks the thinking checklist per backend and never crosses them over', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({
        comfyThinking: 'COMFY-CHECKLIST',
        naiThinking: 'NAI-CHECKLIST',
        naiV5Thinking: 'NAIV5-CHECKLIST',
      }),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      const cases = [
        { backend: 'comfyui', model: oldModel, want: 'COMFY-CHECKLIST' },
        // The single-string branch's representative is now the original NAI4: from 4.5 on it takes the Character Prompts branch (natural language was introduced with 4.5)
        // ⚠ NAI4 was removed from NAI_MODELS (it can't be chosen on the settings page any more), but prompt.ts's single-string branch and
        // the naiSpec/naiThinking keys both still exist, so this keeps locking the branch ownership by string.
        { backend: 'nai', model: 'nai-diffusion-4-full', want: 'NAI-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-4-5-full', want: 'NAIV5-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-5-full', want: 'NAIV5-CHECKLIST' },
      ] as const;
      const all = ['COMFY-CHECKLIST', 'NAI-CHECKLIST', 'NAIV5-CHECKLIST'];
      for (const { backend, model, want } of cases) {
        settings.defaultBackend = backend;
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const text = messages.map(m => m.content).join('\n');
        for (const marker of all) {
          expect([backend, model, marker, text.includes(marker)]).toEqual([
            backend,
            model,
            marker,
            marker === want,
          ]);
        }
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // Where identity tags and NSFW land in the thought chain: the old 0.1.16 checklist had them (identity tag wording + self-check / NAI-only
  // NSFW clause + self-check), but all three were lost in the three-layer rewrite: the rules were only in the spec, with no check slot in the thinking loop,
  // so the chance of omission rose again. This pins where each of the three lands, and NSFW carries no age qualifier.
  it('keeps fandom identity and NSFW checkpoints inside each backend thinking', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      const once = (text: string, needle: string) => text.split(needle).length - 1;
      // ComfyUI: the escaped identity tag, the negative-key rule and the fair-skin ban, each stated once.
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(once(text, 'Fan character identity tag:')).toBe(1);
      // The spec's escaping guidance must reach the model as-is: in a template string \( gets cooked into (.
      expect(text).toContain("The actual prompt word form is character name");
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(once(text, "- None of the skin color words are written by default")).toBe(1);
      expect(text).not.toContain('4. For an explicit NSFW scene.');

      // NAI 4.5 and V5: unescaped identity tag first in characters[].tag; the explicit-scene rules live once, in the specification.
      for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const) {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        text = (await buildAutoTagMessages(context(), 1, options, null))
          .map(m => m.content)
          .join('\n');
        expect(once(text, 'must be the first tag in that character\'s tag')).toBe(1);
        expect(text).toContain('Do not escape the parentheses for NovelAI');
        expect(once(text, '4. For an explicit NSFW scene.')).toBe(1);
        expect(text).not.toContain('If the text is clearly an explicit NSFW scene');
        expect(text).not.toContain('After writing negative, look back word by word');
        expect(text).not.toContain('- None of the skin color words are written by default');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // NAI V5 isolates each person with Base + characters[], and its specification's rule 8 explicitly forbids ComfyUI's adjacency binding.
  // When the three backends shared one thought chain, V5 was asked to do what its specification forbids; this pins that it never flows back.
  it('gives NAI V5 a Base/character slot block with no adjacency-binding wording', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // No wording of adjacency binding may appear on the V5 path.
      for (const banned of [
        '落 tag 时各自绑定',
        'on silver hair girl',
        'on green hair girl',
        '没主人的笼统孤立词',
        'Character:<人数 tag',
        '区分性称谓邻接绑定',
      ]) {
        expect([banned, text.includes(banned)]).toEqual([banned, false]);
      }

      // In its place: a Base block + one block per character, keyed to the frame, not to profiles.
      expect(text).toContain("■ P<number>｜Base");
      expect(text).toContain("■ P<number>｜<character name or the text's reference>");
      expect(text).toContain("Fixed appearance: <library or new-profile fields; a 【one-time】 character is completed once for this image>");
      // The single-person case: the core interaction slot is "-", and the action goes in the character block.
      expect(text).toContain('Core interaction: <the shared contact, as English tags; "-" in a single-person image>');
      // The Base/character split and the no-adjacency rule are stated once, in the specification.
      expect(text).toContain("Do not put one character's appearance, outfit, or individual action in Base.");
      expect(text).toContain("Do not use ComfyUI's multi-person segmentation convention.");
      expect(text).toContain("Base holds no single character's appearance, outfit or action");
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // Eligibility for a profile ≠ eligibility for the image. In a real run the model read "one-off unnamed passers-by get no profile" as "the unnamed can't be in the image",
  // and so gave up the most dramatic moment in the whole text (the other party of the core interaction was an unnamed opponent), picking instead a shot size
  // that cropped him out. The root cause was a wrong predicate in building the list: layer one B only counted "the named", so that person never
  // made the list, and downstream rules couldn't see him at all. All three places must hold together; miss one and he gets sentenced to death at some step.
  it('lets unprofiled characters enter the frame on the NAI V5 path', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      const once = (needle: string) => text.split(needle).length - 1;
      // Layer one B counts "who is present", not "who has a profile", with three identities.
      expect(text).toContain('List **every** character actually present, named or not.');
      expect(text).toContain('【one-time】 (no profile, no changes, but may still appear in an image)');
      // C keeps no outfit ledger for one-time characters.
      expect(text).toContain('One line per 【existing profile】 and 【new profile】 character');
      // Profile eligibility is not image eligibility: stated once, in the task protocol.
      expect(once('Profiling and drawing are separate decisions')).toBe(1);
      // One-off characters, crowds and invented names: stated once, in the specification.
      expect(once('Never invent a personal name for them')).toBe(1);
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');
      // Name consistency is scoped to profiled characters.
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');
      // Headcount is by the frame.
      expect(text).toContain('number of people visible inside this frame');
      expect(text).not.toContain('"tag":"2girls, classroom, sunset, medium shot"');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // This only verifies rule assembly; whether real framing highlights the main characters still needs a real story run.
  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    'prioritizes principal characters without requiring every present person in frame (%s)',
    async model => {
      const options: AutoTagSettings = {
        enabled: true,
        contextMessages: 2,
        minImages: 0,
        maxImages: 2,
        retryCount: 1,
        autoGenerate: true,
        prompts: prompts(),
      };
      const oldBackend = settings.defaultBackend;
      const oldModel = settings.nai.model;
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const contract = messages.find(m => m.content.includes('You are a rigorous plot screen planner'))!.content;
        const thinking = messages.find(m => m.content.includes('Pre-output checklist'))!.content;
        const spec = messages.find(m => m.content.startsWith('[NovelAI'))!.content;
        const selection = thinking.split('E. Scene selection\n')[1].split('Layer two')[0];

        expect(contract).toContain('Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist');
        expect(contract).toContain('A character without a profile can still be drawn');
        expect(selection).toContain('settle the subject and core interaction first, then who is in frame');
        expect(thinking).not.toContain('Character rows (one row per character present)');
        expect(spec).toContain('Only include them when the chosen frame needs the crowd');
        // The framing doctrine lives in the protocol; the specification no longer repeats it.
        expect(spec).not.toContain('Keep an unnamed participant when needed to show the core interaction');
      } finally {
        settings.defaultBackend = oldBackend;
        settings.nai.model = oldModel;
      }
    },
  );

  // The thought chain asks for shot size/ambient light/size, while the V5 specification originally had no criteria for them; the model could only guess.
  it('teaches NAI V5 the visual-completion doctrine its slots depend on', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('Write exactly one shot distance');
      expect(text).toContain('must contain this image');
      expect(text).toContain('Keep body tags consistent with the shot distance');
      // The expression vocabulary is aligned with the other two: the thought chain is allowlist-based (anything the specification doesn't list is forbidden),
      // so listing one word fewer equals banning one word.
      expect(text).toContain('smile, grin, laughing, blush');
      expect(text).toContain('crying, tears, angry');
      expect(text).toContain('worried, scared, smug');
      expect(text).toContain('open mouth, clenched teeth');
      // d46ae82's terrain fix had never covered the V5 path before.
      expect(text).toContain('never add muddy ground, dirt path, wetland, puddles');
      expect(text).toContain('Orientation (the size key)');
      expect(text).toContain('When unsure, write portrait');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // The original NAI4's char_captions is always empty (nai.ts), so the protocol shape is a single tag string just like ComfyUI,
  // needing adjacency binding just the same; yet the NAI specification previously had not one multi-person rule or example.
  // (From 4.5 on it takes the Character Prompts branch, belonging to another specification, where adjacency binding doesn't apply.)
  it('gives NAI 4 the multi-character binding rules and a worked example', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain("Additional rules for multiplayer (two or more people):");
      expect(text).toContain('white dress on green hair girl');
      expect(text).toContain('petite on silver hair girl');
      expect(text).toContain('black hair girl smiling, silver hair girl looking at another');
      expect(text).toContain('dark trousers on black hair boy');
      // Examples are what rules lean on: with only the rule text and no example, the model has no form to copy.
      expect(text).toContain("Multiplayer tag example (see the writing method according to the above rules):");
      // NAI doesn't take ComfyUI's weight-bracket escaping, so that rule shouldn't be copied over.
      expect(text).not.toContain('ComfyUI 会把未转义圆括号当作权重语法');
      // Ordering is unified to the "composition right after headcount" rule: consistent with Comfy, and with the multi-person rule text;
      // the old "camera composition at the end" ordering table and example once contradicted this.
      expect(text).toContain("Arranged from most important to less important: Number of people/subjects → Shot composition → Appearance → Clothing → Action posture → Expression and sight → Scene → Light atmosphere; a single picture is controlled within 40 and tag.");
      expect(text).not.toContain('场景 → 光线氛围 → 镜头构图');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // Gaze vocabulary typo: eyes closed is an alias of closed eyes; two word orders of the same tag shouldn't sit side by side.
      expect(text).not.toContain('eyes closed');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  it('has the library dictate copied field values instead of @ placeholders', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const library = '【角色固定外貌库(系统维护)】\n小雪: 1girl, long silver hair';
    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, library);

    // The example now uses the actual appearance string; @placeholders were withdrawn (see the charAnchors.ts file header)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系统会替换成库中最新 tag'))).toBe(false);
    // Copying the library fields + writing them only once per image are the two core wordings of this rollback
    expect(messages.some(m => m.content.includes("copy the field values into tag word for word"))).toBe(true);
    expect(messages.some(m => m.content.includes("Write each character's fixed appearance once per image"))).toBe(true);
    expect(messages[messages.length - 1].content).toContain(library);
    expect(messages[messages.length - 1].content).not.toContain('currently empty');
  });

  it('forbids poses and scenes from entering the appearance profile', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    // Profiles get copied into every later image, so pose/scene mixed into fields would keep the character in that pose forever
    expect(messages.some(m => m.content.includes('lying on carpet'))).toBe(true);
    expect(messages.some(m => m.content.includes("fixed physical traits only"))).toBe(true);
  });

  it('keeps first-appearance profiling enabled when BaiBai Book memory exists', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      {
        timing: 'before_latest',
        text: '【角色参考】已有其他角色',
        roles: [],
      },
    );

    expect(messages.some(message => message.content.includes("create a profile at their first appearance"))).toBe(true);
    expect(messages.some(message => message.content.includes("Character reference: BaiBai Book is not provided this time."))).toBe(false);
  });

  it('uses the dedicated NAI V5 Base and Character Prompt contract', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('one Base Prompt plus zero or more native Character Prompts'))).toBe(true);
      expect(messages.some(message => message.content.includes('"characters":['))).toBe(true);
      expect(messages.some(message => message.content.includes('source# / target# / mutual#'))).toBe(true);
      expect(messages.some(message => message.content.includes('Use girl/boy rather than 1girl/2girls; numeric counts belong only in Base.'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base's global nature holds for both tag and nl: in a real run the model wrote a single character's uniform/body type into the Base nl,
      // duplicating the character nl; the old text only put the ban at the tag level.
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // Profile nl only covers fixed appearance: temporary clothing in a permanent profile's nl would follow every later floor.
      expect(messages.some(message => message.content.includes('with a concise English description of the fixed appearance only'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // Expression/gaze previously had no place in any of the three backend specifications, so even if the thought-chain slot was filled it got lost when converting to tags.
  it('reserves an expression/gaze slot in the tag ordering of both tag-based backends', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = settings.nai.model;
    try {
      for (const backend of ['comfyui', 'nai'] as const) {
        settings.defaultBackend = backend;
        if (backend === 'nai') settings.nai.model = 'nai-diffusion-4-full';
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const spec = messages.find(m => m.content.includes("Arranged from most important to less important: Number of people/subjects → Shot composition → Appearance → Clothing → Action posture → Expression and sight → Scene → Light atmosphere; a single picture is controlled within 40 and tag."));
        expect(spec?.content).toContain("Arranged from most important to less important: Number of people/subjects → Shot composition → Appearance → Clothing → Action posture → Expression and sight → Scene → Light atmosphere; a single picture is controlled within 40 and tag.");
        expect(spec?.content).toContain("Expressions and gaze must be written in every picture and cannot be omitted, and must use standard danbooru words recognized by the model. No self-created descriptive phrases are allowed:");
        expect(spec?.content).toContain("- The absence of facial expressions in the text is not a reason not to write them - infer one; when it is judged that the face is expressionless, expressionless must also be written explicitly.");
        // The first real run leaked gentle smile / shy expression / neutral curious expression,
        // non-danbooru phrases like these: the slot was filled correctly, then translated literally into tags. The specification must give a restricted vocabulary.
        expect(spec?.content).toContain("Expressions and gaze must be written in every picture and cannot be omitted, and must use standard danbooru words recognized by the model. No self-created descriptive phrases are allowed:");
        expect(spec?.content).toContain("- It is forbidden to literally translate the Chinese description in thinking into tag: gentle smile writes smile, shy expression writes blush, neutral curious expression This phrase model is completely unfamiliar and will only waste token and dilute the rest. tag. The natural language feeling with adjectives is left to nl, and tag only puts standard words.");
        expect(spec?.content).toContain('puffy cheeks');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // In the same real run, P11's two people each with looking at another were merged into one bare tag,
  // and petite / black pantyhose also came loose from the on green hair girl binding.
  it('binds per-character expression, gaze and body type in multi-character ComfyUI tags', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'comfyui';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const spec = messages.find(m => m.content.includes("Additional rules for multiplayer (two or more people):"));
      expect(spec?.content).toContain("- Expression and gaze are also **one copy for each person and must be bound** features: write \"black hair girl smiling, silver hair girl looking at another\", do not put smile, looking at another Naked writing in the string - when two people are in the same frame, the expression/eyesight of the naked writing will only fall on one of them, and the other person will become the default wooden face. If two people have exactly the same expression or gaze, each should write one with a title. \"Write shared characteristics only once\" does not apply.");
      expect(spec?.content).toContain("the other person will become the default wooden face");
      expect(spec?.content).toContain("- Expression and gaze are also **one copy for each person and must be bound** features: write \"black hair girl smiling, silver hair girl looking at another\", do not put smile, looking at another Naked writing in the string - when two people are in the same frame, the expression/eyesight of the naked writing will only fall on one of them, and the other person will become the default wooden face. If two people have exactly the same expression or gaze, each should write one with a title. \"Write shared characteristics only once\" does not apply.");
      expect(spec?.content).toContain("- Body shape words (petite, tall, muscular, etc.) are not anchors and must be bound to specific characters. Do not write them naked: write \"petite on silver hair girl\" and do not let petite float in the string - the floating body shape words will be spread by the model to everyone in the same frame. Hair color and eye color themselves are the anchor points used to identify the character. They can be displayed naked as usual and do not need (and cannot) be bound to themselves.");
      // A rule without an example behind it is empty talk: in a real run the model copied the structure from the example string, and petite/loli were still written bare.
      expect(spec?.content).toContain('petite on silver hair girl');
      // Hair and eye colours are binding anchors and listing them bare is correct; the previous rule must not wrongly turn them into black hair on black hair girl.
      expect(spec?.content).toContain("- Body shape words (petite, tall, muscular, etc.) are not anchors and must be bound to specific characters. Do not write them naked: write \"petite on silver hair girl\" and do not let petite float in the string - the floating body shape words will be spread by the model to everyone in the same frame. Hair color and eye color themselves are the anchor points used to identify the character. They can be displayed naked as usual and do not need (and cannot) be bound to themselves.");
      // Deleting "don't fall back to generic words" while slimming relapsed in the very same round: the tag wrote bare school uniform +
      // black opaque pantyhose, and the boy's white shirt/dark pants never made it into the tag at all.
      expect(spec?.content).toContain("- Clothes of the same type and different styles must be bound together, and cannot be lumped together with a general name: when two people wear school uniforms but the male and female styles are different, write \"dark pleated skirt on green hair girl, black opaque pantyhose on green hair girl, white shirt on black hair boy, dark trousers on black hair boy\", you must not just write one bare school uniform - That would let the model put the skirt on the boy, or simply design a random suit for each of them. In the same way, parts such as pantyhose and blazer that can only be worn by one person must also be brought with the owner.");
      expect(spec?.content).toContain('dark pleated skirt on green hair girl');
      expect(spec?.content).toContain('white shirt on black hair boy');
      expect(spec?.content).toContain("let the model put the skirt on the boy");
      // The example string must really demonstrate the binding form, otherwise the model copies bare tags from the old example.
      expect(spec?.content).toContain('black hair girl smile, black hair girl looking at viewer');
      expect(spec?.content).toContain('silver hair girl blush, silver hair girl looking away');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  // The slot itself must also block Chinese descriptions, otherwise they leak into the slot first and then into the tag.
  it('makes the per-image slot block demand canonical danbooru expression words', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);
    const thinking = messages.find(m => m.content.includes("Pre-output checklist"))?.content ?? '';
    const text = messages.map(m => m.content).join('\n');
    // The expression vocabulary lives once, in the specification; the slot rows ask for it.
    expect(text.split('The expressions are selected from the actual existing tag').length - 1).toBe(1);
    expect(thinking).toContain('｜expression｜gaze｜');
    // Anti-wavering: decide once, no self-questions, candidate lists or reversals.
    expect(thinking).toContain('Decide each field once: a field holds one value in the whole <thinking>. No self-questions, no candidate lists, no reversals');
    // No pre-written answer: the wording covers the JSON itself.
    expect(thinking).toContain('no pre-written tag/nl strings or JSON');
    expect(thinking).toContain('Layer three | Check before writing');
    expect(thinking).not.toContain('第三层｜落成 tag 并自查');
  });

  it('requests per-image negative tags only when the ComfyUI workflow uses %negative_prompt%', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    // The workflow is now carried by "the current preset" (see the workflow library in settings.ts); the default always has one, so change it directly
    const preset = activeComfyPreset();
    const oldWorkflow = preset.workflow;
    try {
      settings.defaultBackend = 'comfyui';
      preset.workflow = JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: '%prompt%', negative: '%negative_prompt%' },
        },
      });
      const messages = await buildAutoTagMessages(context(), 1, options, null);

      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);
      expect(messages.some(message => message.content.includes("it is prohibited to output general quality"))).toBe(true);
      expect(messages.some(message => message.content.includes("do not use the @role placeholder"))).toBe(true);
      expect(messages.some(message => message.content.includes('工作流里已有的通用质量负面词'))).toBe(false);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      // In a real run the model gave rainy text "negative":"rain, umbrella", cancelling out the tag's wet asphalt.
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      // It relapsed once: nl itself wrote drizzle, and negative still had rain. The ban must cover "negating what you just wrote".
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
    }
  });

  it('simple mode dynamic-negative threshold decided by the template: checkpoint/anima request it, flux does not', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const oldMode = preset.mode;
    const oldTemplate = preset.simple.template;
    try {
      settings.defaultBackend = 'comfyui';
      preset.mode = 'simple';
      preset.simple.template = 'checkpoint';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);

      preset.simple.template = 'flux';
      const fluxMessages = await buildAutoTagMessages(context(), 1, options, null);
      expect(fluxMessages.some(message => message.content.includes('"negative":"extra people'))).toBe(false);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.mode = oldMode;
      preset.simple.template = oldTemplate;
    }
  });
});

describe('natural-language conditional sections expandNlSections', () => {
  it('{{#nl}} sections kept only when on, {{^nl}} sections only when off', () => {
    const text = 'A{{#nl}}-on{{/nl}}{{^nl}}-off{{/nl}}B';
    expect(expandNlSections(text, true)).toBe('A-onB');
    expect(expandNlSections(text, false)).toBe('A-offB');
  });

  it('sections may span lines; text without conditional sections is returned as-is (the whole-replacement {{nl}} macro is not its business)', () => {
    const text = 'x{{#nl}}\n第一行\n第二行\n{{/nl}}y';
    expect(expandNlSections(text, true)).toBe('x\n第一行\n第二行\ny');
    expect(expandNlSections(text, false)).toBe('xy');
    expect(expandNlSections('plain {{nl}} text', false)).toBe('plain {{nl}} text');
  });

  it('unmatched markers stay as-is without swallowing the following text', () => {
    // A mistake is visible in request history; if silently swallowed, a missing close would delete the whole specification after it
    expect(expandNlSections('a{{#nl}}b', false)).toBe('a{{#nl}}b');
    expect(expandNlSections('a{{/nl}}b', true)).toBe('a{{/nl}}b');
  });

  // If a marker in the built-in text were written wrong (missing close, misspelt), the whole section would leak to the model, markers and all
  it.each([true, false])('built-in NAI specification and thought chain leave no markers after expansion (nl=%s)', nlOn => {
    for (const text of [DEFAULT_NAI_V5_SPEC, DEFAULT_NAI_V5_THINKING]) {
      expect(expandNlSections(text, nlOn)).not.toMatch(/\{\{[#^/]nl\}\}/);
    }
  });
});

// NAI 4.5's prompt token limit is tighter than V5's, and natural language takes the most budget; that is where the toggle came from.
// Same rule as the ComfyUI toggle: it only controls whether the AI writes it; nl already written into the text is sent as usual.
describe('NAI "Generate Natural Language" toggle and channel frame lock', () => {
  function options(overrides: Partial<AutoTagPrompts> = {}): AutoTagSettings {
    return {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(overrides),
    };
  }

  /** Every case flips backends and toggles: snapshot on entry, restore as-is on exit (settings is a module-level singleton). */
  function snapshot() {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: settings.nai.model,
      naiNl: settings.nai.naturalLanguage,
      naiLock: settings.nai.orientationLock,
      presetNl: preset.naturalLanguage,
      presetLock: preset.orientationLock,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        settings.nai.model = saved.model;
        settings.nai.naturalLanguage = saved.naiNl;
        settings.nai.orientationLock = saved.naiLock;
        preset.naturalLanguage = saved.presetNl;
        preset.orientationLock = saved.presetLock;
      },
    };
  }

  const CONTRACT_MARK = "You are a rigorous plot screen planner";
  const NAI_SPEC_MARK = '[NovelAI 4.5/V5 Prompt Specification]';
  const THINKING_MARK = "Pre-output checklist";

  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    'when off, the %s protocol, specification and thought chain all switch to pure tags; switching back on restores them',
    async model => {
      const state = snapshot();
      try {
        settings.defaultBackend = 'nai';
        settings.nai.model = model;
        settings.nai.naturalLanguage = false;
        const messages = await buildAutoTagMessages(context(), 1, options(), null);
        const contract = pick(messages, CONTRACT_MARK);
        const spec = pick(messages, NAI_SPEC_MARK);
        const thinking = pick(messages, THINKING_MARK);

        // Not a single nl key is left in the example JSON: the model copies examples far more readily than it follows rules
        expect(contract).not.toContain('"nl"');
        expect(contract).toContain('"characters":[{"name":"小雪"');
        expect(contract).toContain('This output is tag-only');
        expect(contract).toContain('characters[] with name and tag for each individual visible in the frame');
        // Profiles no longer need nl either; runner acceptance follows the same rule (profile.nl), otherwise retries would be wasted on a non-existent requirement
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // Specification rule 6 is swapped wholesale for the tag-only version (numbering unchanged); the example and entry shape drop nl in step
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain("This run writes tags only");
        expect(thinking).not.toContain('Base nl');
        // Multi-character prompts themselves are unaffected by the toggle: only nl is turned off; characters[] is still required
        expect(thinking).toContain('characters[]');

        settings.nai.naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain("Base tag and Base nl");
        expect(on).not.toContain('This output is tag-only');
        expect(on).not.toContain("This run writes tags only");
      } finally {
        state.restore();
      }
    },
  );

  it('custom specifications and thought chains likewise expand conditional sections by the toggle (each backend reads its own toggle)', async () => {
    const state = snapshot();
    const custom = options({
      naiV5Spec: 'NAI-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      naiV5Thinking: 'NAI-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfySpec: 'COMFY-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      comfyThinking: 'COMFY-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
    });
    const run = async () =>
      (await buildAutoTagMessages(context(), 1, custom, null)).map(m => m.content).join('\n');
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = false;
      // The ComfyUI one being on shouldn't affect NAI
      state.preset.naturalLanguage = true;
      let text = await run();
      expect(text).toContain('NAI-SPEC tag-only');
      expect(text).toContain('NAI-THINK tag-only');
      expect(text).not.toContain('with-nl');

      settings.nai.naturalLanguage = true;
      text = await run();
      expect(text).toContain('NAI-SPEC with-nl');
      expect(text).toContain('NAI-THINK with-nl');

      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = false;
      text = await run();
      expect(text).toContain('COMFY-SPEC tag-only');
      expect(text).toContain('COMFY-THINK tag-only');
      expect(text).not.toContain('with-nl');

      state.preset.naturalLanguage = true;
      text = await run();
      expect(text).toContain('COMFY-SPEC with-nl');
      expect(text).toContain('COMFY-THINK with-nl');
    } finally {
      state.restore();
    }
  });

  // If only the output were locked without changing the protocol, the model would still frame by the orientation criteria: under a portrait lock it would plan a wide group shot while the output is portrait
  it('NAI landscape lock: the protocol switches to filling landscape for every image, the example follows, no orientation fallback offered', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.orientationLock = 'landscape';
      const contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain("\"landscape\" is filled in for each image");
      expect(contract).toContain("do not apply this time");
      expect(contract).toContain('"size":"landscape"}],"changes":[]}');
      expect(contract).not.toContain("if you are not sure, fill in \"portrait\"");
    } finally {
      state.restore();
    }
  });

  it('the ComfyUI lock reads the current workflow; the NAI lock does not leak over', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      settings.nai.orientationLock = 'landscape';
      state.preset.orientationLock = 'portrait';
      let contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain("\"portrait\" is filled in for each image");
      expect(contract).toContain('"size":"portrait"}],"changes":[]}');

      state.preset.orientationLock = 'auto';
      contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain("if you are not sure, fill in \"portrait\"");
      expect(contract).not.toContain("has been locked");
    } finally {
      state.restore();
    }
  });

  it('autoTagProfile: computed once from the current backend and its toggles, shared by protocol writing and runner acceptance', () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      settings.nai.naturalLanguage = true;
      settings.nai.orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: true, nl: true, lockedSize: null });

      settings.nai.naturalLanguage = false;
      settings.nai.orientationLock = 'portrait';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: true, nl: false, lockedSize: 'portrait' });

      // The single-string branch (NAI4) protocol never writes nl anyway, so the toggle has no effect on it
      settings.nai.model = 'nai-diffusion-4-full';
      settings.nai.naturalLanguage = true;
      expect(autoTagProfile()).toMatchObject({ naiCharPrompts: false, nl: false });

      // ComfyUI: natural language and the frame lock both come from the current workflow
      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = true;
      state.preset.orientationLock = 'landscape';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: false, nl: true, lockedSize: 'landscape' });

      state.preset.naturalLanguage = false;
      state.preset.orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: false, nl: false, lockedSize: null });
    } finally {
      state.restore();
    }
  });
});
