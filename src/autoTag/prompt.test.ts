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
    expect(messages.some(m => m.content.includes("- **Create a profile before drawing**: Read through the text of the target first and find out every official character with a name and surname that is not in the 【 character fixed appearance library 】 - as long as the character card, World Info, BaiBai Book or continuous plot has given a setting for him, or he is a character who continues to participate in the plot, he must create a profile for his first appearance, regardless of whether he is selected for this picture. The basis for judgment is all the setting content sent to you, and it is up to you to read through it and make your own judgment. One-time unknown passers-by do not build."))).toBe(true);
    expect(messages.some(m => m.content.includes("- **Create a profile before drawing**: Read through the text of the target first and find out every official character with a name and surname that is not in the 【 character fixed appearance library 】 - as long as the character card, World Info, BaiBai Book or continuous plot has given a setting for him, or he is a character who continues to participate in the plot, he must create a profile for his first appearance, regardless of whether he is selected for this picture. The basis for judgment is all the setting content sent to you, and it is up to you to read through it and make your own judgment. One-time unknown passers-by do not build."))).toBe(true);
    expect(messages.some(m => m.content.includes("- Priority of file creation: current appearance specified in the target text > current character status in BaiBai Book > character card/World Info specified > reasonable completion. When the color is clearly written in the character design, it must be converted as it is and cannot be tampered with; hair and eyes are required, hair contains at least hair color and length/hair style, eyes must contain eye color, if any of the items is missing, the file will be discarded."))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes("- If the setting does not include hair color, hairstyle or eye color, make up a concise, coordinated, long-term reusable color and hairstyle based on the world view, race, identity, personality and other character settings; this is a one-time file creation decision and cannot be re-randomized in the future."))).toBe(true);
    // Profile creation is unaffected by selection and not gated by position: these two are the core of the fix, and the wording must be in the protocol
    expect(messages.some(m => m.content.includes("- **Create a profile before drawing**: Read through the text of the target first and find out every official character with a name and surname that is not in the 【 character fixed appearance library 】 - as long as the character card, World Info, BaiBai Book or continuous plot has given a setting for him, or he is a character who continues to participate in the plot, he must create a profile for his first appearance, regardless of whether he is selected for this picture. The basis for judgment is all the setting content sent to you, and it is up to you to read through it and make your own judgment. One-time unknown passers-by do not build."))).toBe(true);
    expect(messages.some(m => m.content.includes("- File writing method: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"First Appearance File\"}; position fill in the location where he first appeared, for record only - the file is valid throughout this building, and pictures anywhere in this building can use this appearance immediately."))).toBe(true);
    // The withdrawn characters audit must not flow back into the protocol
    expect(messages.some(m => m.content.includes("\"characters\""))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain("[system-maintained; currently empty]");
    expect(user.content).toContain("【 character fixed appearance library 】[system-maintained; currently empty]\n (Currently empty, no character has been profiled. The World Info, character card, BaiBai Book and text only provide the basis for creation; official characters not listed in this block must be profiled through field:\"new\".)");
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

    // Two-layer structure: A~E are whole-floor global judgements made once; the second layer is the per-image slot block.
    // The structural skeleton is more worth pinning than word-for-word copy: loose bullets were exactly why the model squeezed each image into one sentence.
    expect(thinkingMsg?.content).toContain("Layer one | Global judgments (once for the whole floor)");
    expect(thinkingMsg?.content).toContain("Layer two | Image slot blocks");
    expect(thinkingMsg?.content).toContain("Layer two | Image slot blocks (one block per P selected in E; never merged or shared across images)");
    expect(thinkingMsg?.content).toContain("Self-check before writing");
    for (const slot of ['Characters:', "Core action:", 'Shot:', 'Setting:', 'Ambient light:', "size:"]) {
      expect(thinkingMsg?.content).toContain(slot);
    }
    expect(thinkingMsg?.content).toContain("Character rows (one row per character present): <character name>｜expression｜gaze｜outfit visible in this shot｜temporary state｜personal action");
    expect(thinkingMsg?.content).toContain("Slot rules (write slot values directly as the English words that will go into tag; write \"-\" for a slot that truly does not apply, but core action, shot, expression, gaze, setting, ambient light and size may never be \"-\"):");
    expect(thinkingMsg?.content).toContain("Slot rules (write slot values directly as the English words that will go into tag; write \"-\" for a slot that truly does not apply, but core action, shot, expression, gaze, setting, ambient light and size may never be \"-\"):");
    // Expression/gaze previously had no slot anywhere, the root cause of "wooden faces"; both backend specifications must carry one each too.
    expect(thinkingMsg?.content).toContain("- For expression and gaze, use the standard danbooru words in the back-end specification. Do not write feelings in Chinese or invent phrases (for \"gently smiling\", just write smile). Choose only from the words the specification lists; anything else is not allowed. When unsure, use expressionless / looking at another. Neither slot may be blank: even a blank face gets expressionless. In multi-person images each person gets their own pair, bound to them in tag. Never merge them or leave them bare: a bare expression lands on one person only, and everyone else gets the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expression and gaze, use the standard danbooru words in the back-end specification. Do not write feelings in Chinese or invent phrases (for \"gently smiling\", just write smile). Choose only from the words the specification lists; anything else is not allowed. When unsure, use expressionless / looking at another. Neither slot may be blank: even a blank face gets expressionless. In multi-person images each person gets their own pair, bound to them in tag. Never merge them or leave them bare: a bare expression lands on one person only, and everyone else gets the default wooden face.");
    expect(thinkingMsg?.content).toContain("- Each image's tag covers every non-\"-\" slot of its own block, with no missing expression, gaze or ambient light. When nl is required, it describes the same image as tag.");
    // No assistant prefill is sent any more; the messages end with the user task message.
    expect(thinkingMsg?.content).toContain("Work through the steps below inside <thinking></thinking>, then output the final JSON. Output nothing except this one <thinking> block and the final JSON. Never open a second <thinking> block.");

    // Below are existing constraints that had to hold before the rewrite, each confirmed not lost in the refactor.
    expect(thinkingMsg?.content).toContain("- A temporary state may not reset to the character's default without a clear transition: tidying up, changing clothes, the state ending, a time skip or a scene change.");
    expect(thinkingMsg?.content).toContain("- Check permanent changes against the character library: dyed hair, a haircut, a permanent transformation and the like go into changes with the P number where they take effect. Temporary states such as wigs, coloured contacts, wet hair or slight discolouration do not. Do not skip this step even when images is empty.");
    expect(thinkingMsg?.content).toContain("- Rank by visual clarity, plot importance, completeness of the action and difference from other candidates, and respect the minimum and maximum in the task protocol. When the minimum is above 0, fill up from weaker but still visible candidates. Once the minimum is met, add only images that are strong enough and clearly different from each other; do not pad toward the maximum with adjacent actions or other angles on the same event.");
    expect(thinkingMsg?.content).toContain("- Rank by visual clarity, plot importance, completeness of the action and difference from other candidates, and respect the minimum and maximum in the task protocol. When the minimum is above 0, fill up from weaker but still visible candidates. Once the minimum is met, add only images that are strong enough and clearly different from each other; do not pad toward the maximum with adjacent actions or other angles on the same event.");
    expect(thinkingMsg?.content).toContain("- One moment: an image is what a single shutter press captures. Do not put several actions, time points or a chain of cause and effect into one block. Plot facts follow the text strictly; never invent characters, actions or headcount.");
    // After slimming, the size criteria live only in the backend specification (neither thinking nor the protocol repeats them),
    // but the whole message set must still contain exactly this one copy, otherwise the model can't judge landscape vs portrait.
    expect(messages.some(m => m.content.includes("Write landscape for group portraits, long-range panoramas, wide scenes, and horizontally unfolding interactions; write portrait for single people, vertical stances, close-ups, and close-up compositions of two people."))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('双人近距离可 portrait');
    expect(thinkingMsg?.content).toContain("- A candidate must be a visible moment with a clear subject, action or visual state, and a setting. Keep dialogue only when it comes with expressions, body movement, relationships or environmental change worth drawing. Skip dialogue with no visual change, pure inner thoughts and transitions.");
    expect(thinkingMsg?.content).toContain("- One conclusion line per person: the matching same-name library entry, or field: \"new\" in this output. A character counts as profiled only if their name is actually listed in the 【 character fixed appearance library 】 block. Detailed descriptions in the lorebook, character card, BaiBai Book or story text are only sources for creating a profile; they do not mean the character is already in the library, and you may not claim a profile from memory. A character not in the library who is a formal character (has a setting or keeps taking part in the plot) gets a profile on first appearance, whether or not they are selected for an image. One-off unnamed passers-by get no profile.");
    expect(thinkingMsg?.content).toContain("whether or not they are selected for an image");
    expect(thinkingMsg?.content).toContain("A profile created here holds for the whole floor");
    // Profile hair must include length/style: the old colour-only wording let the model pass with black hair.
    expect(thinkingMsg?.content).toContain("hair needs both a colour and a length/style");
    expect(thinkingMsg?.content).not.toContain('hair 与 eyes 都不得留空');
    // The fair-skin tag ban (ComfyUI's default skin is already fair enough; stacking pale skin makes it unnaturally white):
    // the specification gives the ban, and the thought chain's third layer gives a check before writing; tan/dark skin are exempt.
    expect(messages.some(m => m.content.includes("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- No fair-skin words like pale skin, white skin or fair skin appear in any image (if a library field has one, skip it rather than copy it): the default skin tone is already fair enough, and adding them makes skin look grey-white. Genuinely tanned/dark-skinned characters use tan and dark skin, which are not affected.");
    expect(thinkingMsg?.content).toContain("- No fair-skin words like pale skin, white skin or fair skin appear in any image (if a library field has one, skip it rather than copy it): the default skin tone is already fair enough, and adding them makes skin look grey-white. Genuinely tanned/dark-skinned characters use tan and dark skin, which are not affected.");
    // After slimming, the detailed wording for profile fields lives only in the task protocol; thinking no longer repeats it.
    expect(messages.some(m => m.content.includes("- File writing method: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"First Appearance File\"}; position fill in the location where he first appeared, for record only - the file is valid throughout this building, and pictures anywhere in this building can use this appearance immediately."))).toBe(true);
    // The position semantics of new vs old profiles and the latitude of era judgement: after slimming each keeps only one authoritative copy
    // (in the task protocol and backend specification respectively); thinking no longer repeats them, but they must still be in the message set.
    expect(messages.some(m => m.content.includes("- The permanently changed position is the position where the new status takes effect: the pictures before this position use the old file, and the position and after use the new file; multiple changes are reported separately in the text."))).toBe(true);
    expect(messages.some(m => m.content.includes("When there is a clear setting, strictly follow it; when there is no clear setting, you must also take the initiative to choose the most reasonable, specific and self-consistent era, civilization or original visual system based on the existing clues and plot temperament. When there is less evidence, the style of the era, clothing styles, materials, accessories, light and tone can be reasonably supplemented, but this is limited to \"how to draw\" and cannot be used to make up \"what is in the picture\"."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Set one specific, self-consistent era/culture/visual style and use it across the whole floor. Follow an explicit setting strictly. With little evidence, still choose one; do not fall back to neutral clothing or a default modern city. Apply it to clothing styles, materials, accessories and any architecture the evidence supports.");
    expect(thinkingMsg?.content).toContain("- This judgment only decides \"how to draw\". It may not be used to invent unknown scene facts.");
    // The mud/terrain ban originally had 3 copies (specification + slot + self-check); after slimming the specification keeps the full version,
    // and thinking keeps only one line, "don't write it without grounds". The specifics of outdoors/forest belong to the specification.
    expect(messages.some(m => m.content.includes("Just write outdoors when the text only confirms \"wild\", write forest when only confirm \"forest\"; only write muddy, ground, dirt, path, puddles, etc. corresponding to tag when the text, context or world settings clearly support the facts such as rain, mud, dirt road, etc."))).toBe(true);
    expect(messages.some(m => m.content.includes("Implement judgment into the details that are actually visible in the picture: when the characters are visible, priority is given to improving clothing styles, materials, and accessories; when the background is visible, only the buildings, furniture, environments, and utensils that can be supported by the setting or text are added. Terrain, ground or road materials, weather traces and environmental conditions are all scene facts. Keep it simple if there is no basis for it. You are not allowed to add mud, dirt roads, wetlands, stagnant water, snow, dust or slippery ground in order to enrich the picture."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Setting and ambient light: for the setting, write only facts the story text, context or world setting supports. Terrain, ground surface, weather traces and environmental conditions all count as facts; leave them out without grounds. Ambient light is the opposite: the text rarely states light source, time and tone, so you must decide them. Without them the image becomes a flat, mediocre shot.");
    expect(thinkingMsg?.content).toContain("- Every plot tag traces back to the story text or setting. Terrain, ground, road, weather and environmental-condition tags without grounds are removed.");
    expect(thinkingMsg?.content).toContain("- One conclusion line per person: the matching same-name library entry, or field: \"new\" in this output. A character counts as profiled only if their name is actually listed in the 【 character fixed appearance library 】 block. Detailed descriptions in the lorebook, character card, BaiBai Book or story text are only sources for creating a profile; they do not mean the character is already in the library, and you may not claim a profile from memory. A character not in the library who is a formal character (has a setting or keeps taking part in the plot) gets a profile on first appearance, whether or not they are selected for an image. One-off unnamed passers-by get no profile.");
    expect(thinkingMsg?.content).toContain("- Track each character's temporary outfit by P position in the story text. If the text never states the starting outfit, decide a reasonable one once. Without dressing or undressing, a change of clothes, clothing damage or a scene/time skip, the previous state carries over. Once a change is clear, update from that P position.");
    expect(thinkingMsg?.content).toContain("visual fingerprint");
    expect(thinkingMsg?.content).toContain("main colour + key pieces");
    expect(thinkingMsg?.content).toContain("pantyhose includes colour and sheerness");
    expect(thinkingMsg?.content).toContain("- Freeze a \"visual fingerprint\" for each outfit (style/cut + main colour + key pieces; pantyhose includes colour and sheerness; see the task protocol for details). Reuse the same fingerprint across the whole floor while the state is unchanged. Do not write bare words like school, uniform, dress or pantyhose: the model will redesign those on its own.");
    // The slot side must also block generic words, otherwise C settles on navy school blazer while the slot still falls back to school uniform.
    expect(thinkingMsg?.content).toContain("- The visible outfit follows C: write the character's current visual fingerprint piece by piece, only the parts visible in this shot. Parts outside the frame may be left out, but leaving them out does not mean they were taken off; when they are visible again later with no change in between, they come back. Never fall back to bare words like school, uniform, dress or pantyhose in a slot: if C says navy school blazer, write navy school blazer. A generic word lets the model redesign the outfit, so the same character changes style in every image. In multi-person images, write each person's outfit separately and bind it in tag: two people may both wear school uniforms in different men's and women's styles, and a bare school or uniform lets the model put the skirt on the boy.");
    expect(thinkingMsg?.content).toContain("- The visible outfit follows C: write the character's current visual fingerprint piece by piece, only the parts visible in this shot. Parts outside the frame may be left out, but leaving them out does not mean they were taken off; when they are visible again later with no change in between, they come back. Never fall back to bare words like school, uniform, dress or pantyhose in a slot: if C says navy school blazer, write navy school blazer. A generic word lets the model redesign the outfit, so the same character changes style in every image. In multi-person images, write each person's outfit separately and bind it in tag: two people may both wear school uniforms in different men's and women's styles, and a bare school or uniform lets the model put the skirt on the boy.");
    // The self-check must name clothing; the previous version only mentioned "expression and gaze", so the model only checked expression and gaze.
    expect(thinkingMsg?.content).toContain("- In multi-person images, outfits, body type, objects, expressions, gaze and personal actions are all bound to their own characters, with no stray unowned traits. Each present character's outfit actually appears in tag; nobody's outfit exists only in a slot, and no generic word like school uniform or pantyhose is left unowned. Each present character has their own expression word and gaze word; nobody has an action but no expression.");
    // A side character written only as "bending to change shoes" with no expression word → he has no expression in the tag. Character rows must spell out English words for each person.
    expect(thinkingMsg?.content).toContain("- Write one row per character present, side characters included in full. Do not write a full row for the protagonist and describe side characters with a Chinese action sentence. Each row's expression and gaze must be standalone English danbooru words: a Chinese phrase like \"looks the other way, bends down to change shoes\" means the row has no expression word, so the character ends up expressionless in tag and the model paints a wooden face.");
    expect(thinkingMsg?.content).toContain("- Write one row per character present, side characters included in full. Do not write a full row for the protagonist and describe side characters with a Chinese action sentence. Each row's expression and gaze must be standalone English danbooru words: a Chinese phrase like \"looks the other way, bends down to change shoes\" means the row has no expression word, so the character ends up expressionless in tag and the model paints a wooden face.");
    expect(thinkingMsg?.content).toContain("- In multi-person images, outfits, body type, objects, expressions, gaze and personal actions are all bound to their own characters, with no stray unowned traits. Each present character's outfit actually appears in tag; nobody's outfit exists only in a slot, and no generic word like school uniform or pantyhose is left unowned. Each present character has their own expression word and gaze word; nobody has an action but no expression.");
    // Over-limit reselection must happen in E, not wait for "yielding" in the third layer; those slot blocks would have been written for nothing.
    expect(thinkingMsg?.content).toContain("- The count is settled here: count before writing the P list. If it exceeds the maximum, cut it to the maximum on the spot, then continue. Layer two writes blocks only for the final P list. Never write extra blocks and then drop them when layer three finds the count too high; those blocks are wasted, and layer three only checks, it never changes decisions.");
    expect(thinkingMsg?.content).toContain("- This layer only checks; it never changes decisions. If you find a problem, fix it directly when writing tag. Do not write revision notes in your thinking such as \"over the limit, need to trim\", \"give way\" or \"change to\". The image count was settled in E and does not change here.");
    expect(messages.some(m => m.content.includes('navy school blazer, white collared shirt, red ribbon'))).toBe(true);
    expect(thinkingMsg?.content).toContain("leaving them out does not mean they were taken off");
    expect(thinkingMsg?.content).toContain("- In multi-person images, outfits, body type, objects, expressions, gaze and personal actions are all bound to their own characters, with no stray unowned traits. Each present character's outfit actually appears in tag; nobody's outfit exists only in a slot, and no generic word like school uniform or pantyhose is left unowned. Each present character has their own expression word and gaze word; nobody has an action but no expression.");
    expect(messages.some(m => m.content.includes("- \"File has been created\" can only be judged by the entry with the same name in the 】 block of the 【 character fixed appearance library: only the name is actually listed in the block is considered to be a file; the detailed settings in the World Info, character card, BaiBai Book or text are only the basis for the creation of the file, and do not mean that it is already in the library. Each official character present must choose one of two options: point to an entry with the same name in the library, or type field:\"new\" in changes. The one-time nameless character is not included in this alternative: he neither files nor writes changes, does not need to specify any library entries, and missing files is normal and not an omission."))).toBe(true);
    expect(messages.some(m => m.content.includes("- In the multiplayer screen, each character's hair color, eye color, body shape, clothing, objects, and personal actions must be bound adjacently using the character's distinctive title. It is prohibited to scatter the appearance characteristics of two people into a string of public tag that cannot be attributed."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Set one specific, self-consistent era/culture/visual style and use it across the whole floor. Follow an explicit setting strictly. With little evidence, still choose one; do not fall back to neutral clothing or a default modern city. Apply it to clothing styles, materials, accessories and any architecture the evidence supports.");
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
      // ComfyUI: identity tag wording + bracket-escaping reminder + negative-condition self-check (only Comfy workflows have
      // a negative key); the Comfy spec has no NSFW clause, and the thought chain doesn't add one.
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("settle the identity tag on the same line");
      expect(text).toContain(
        "Every fan-work character's tag string carries the identity tag",
      );
      expect(text).toContain("- If this image's protocol includes the negative key: negative was checked word by word against this image's tag and nl. Every word matching established content was removed, so negative never cancels what the text establishes, and anything uncertain was left out. If the protocol has no negative key, skip this item.");
      expect(text).not.toContain("- If this picture is an explicit NSFW scene: the actual visible sexual organs, body parts and contact relationships have all been written accurately with tag, and there are no generalized words such as nsfw, nude, sex. The non-explicit scene will be skipped directly.");
      // The spec's escaping guidance must reach the model as-is: in a template string \( gets cooked into (,
      // so since 0.1.16 what actually went to the model was unescaped brackets; it was always broken.
      expect(text).toContain("The actual prompt word form is character name");
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(text).not.toContain('形态为 character name (copyright name)');
      // The fair-skin tag ban is only for ComfyUI: local models' default skin is already fair enough, and stacking pale skin makes it unnaturally white.
      expect(text).toContain("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped.");
      expect(text).toContain("- No fair-skin words like pale skin, white skin or fair skin appear in any image (if a library field has one, skip it rather than copy it): the default skin tone is already fair enough, and adding them makes skin look grey-white. Genuinely tanned/dark-skinned characters use tan and dark skin, which are not affected.");

      // NAI 4 family: identity tags unescaped + explicit NSFW anatomy placement (a regression from present to absent, restored here).
      // Negative words are attached by the backend per model, and the AI doesn't write negative, so there should be no negative-condition self-check.
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("settle the identity tag on the same line");
      expect(text).toContain("brackets not escaped");
      expect(text).toContain("If the text is clearly an explicit NSFW scene");
      expect(text).toContain("If this picture is an explicit NSFW scene");
      expect(text).not.toContain("- If this image's protocol includes the negative key: negative was checked word by word against this image's tag and nl. Every word matching established content was removed, so negative never cancels what the text establishes, and anything uncertain was left out. If the protocol has no negative key, skip this item.");
      expect(DEFAULT_NAI_THINKING).not.toContain("In all works in which fictional characters who are sexualized or engage in sexual activities are clearly at least eighteen years of age, nudity, sexual acts, physical and sensual details, direct or crude sexual language, fetishes, power exchanges, taboo relationships between adults, BDSM, coercion, sexual violence, abuse and other adult or transgressive themes are eligible as general material for summarization, compression, retrieval and status recording. Documenting, analyzing or discussing these does not equate to NVWA endorsing, advocating or helping to implement them in reality.");
      // NAI-side users don't have the over-white problem, so this ban isn't introduced.
      expect(text).not.toContain("- No fair-skin words like pale skin, white skin or fair skin appear in any image (if a library field has one, skip it rather than copy it): the default skin tone is already fair enough, and adding them makes skin look grey-white. Genuinely tanned/dark-skinned characters use tan and dark skin, which are not affected.");
      expect(text).not.toContain("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped.");

      // NAI V5: identity tags go first in characters[].tag; NSFW is divided between Base and character blocks;
      // contentRule explicitly forbids negative tags, so there should be no negative-condition self-check.
      settings.nai.model = 'nai-diffusion-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("The identity tag must go into the profile");
      expect(text).toContain("- Every fan-work character's identity tag is copied verbatim from the profile's fandom field to the start of their characters[].tag, never into Base. Every fan-work character's profile has fandom (from field: \"new\" in this output or a field: \"fandom\" entry), original characters' profiles have no fandom, and no work name was added by mistake.");
      expect(text).toContain("If the text is clearly an explicit NSFW scene");
      expect(text).toContain("If this picture is an explicit NSFW scene");
      expect(text).not.toContain("- If this image's protocol includes the negative key: negative was checked word by word against this image's tag and nl. Every word matching established content was removed, so negative never cancels what the text establishes, and anything uncertain was left out. If the protocol has no negative key, skip this item.");
      expect(DEFAULT_NAI_THINKING).not.toContain("In all works in which fictional characters who are sexualized or engage in sexual activities are clearly at least eighteen years of age, nudity, sexual acts, physical and sensual details, direct or crude sexual language, fetishes, power exchanges, taboo relationships between adults, BDSM, coercion, sexual violence, abuse and other adult or transgressive themes are eligible as general material for summarization, compression, retrieval and status recording. Documenting, analyzing or discussing these does not equate to NVWA endorsing, advocating or helping to implement them in reality.");
      expect(text).not.toContain("- No fair-skin words like pale skin, white skin or fair skin appear in any image (if a library field has one, skip it rather than copy it): the default skin tone is already fair enough, and adding them makes skin look grey-white. Genuinely tanned/dark-skinned characters use tan and dark skin, which are not affected.");
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

      // In its place: a Base block + one block per character.
      expect(text).toContain("■ P<number>｜Base");
      expect(text).toContain("■ P<number>｜<character name or the text's reference>");
      // Character blocks follow the frame, not the profiles: block names may use the text's references, and the fixed-appearance slot leaves a valid way to fill in for 【one-time】.
      // The old rule made "copy the library/just-created profile fields" the only source, leaving unnamed characters no way through this slot,
      // so the model would rather give up the scene (see the "unnamed characters in the image" issue document); this pins that it never flows back.
      expect(text).toContain("■ P<number>｜<character name or the text's reference> (one block per individual character visible in this image; for a 【one-time】 character, use the text's reference word as the block name)");
      expect(text).toContain("Fixed appearance: <【existing profile】 and 【new profile】 copy the fields from the library/new profile; 【one-time】 is completed once to fit the world, with at least gender, hair colour, hairstyle and eye colour. 1girl/1boy become girl/boy>");
      expect(text).toContain("- **No adjacency binding**: hanging traits after someone's colour words (for example white dress straight after green hair girl) is a single-string tag back-end technique that V5 does not use. Every character here has their own block. Just write white dress; the block it sits in decides who owns it.");
      expect(text).toContain("The split between the Base block and character blocks is a hard boundary");
      expect(text).toContain("in the JSON into their own characters[].tag");
      // A single-person image has no multi-person interaction: the core interaction slot gets "-", and the only character's action goes into the personal action in their character block;
      // the old rule put single-person contact points into the Base slot, directly fighting the division rule "personal actions only go into character blocks".
      expect(text).toContain("Core interaction: <an action several people share: whose body part touches what; describe the contact point in English first, then give English tags. In a single-person image this slot is \"-\": the only character's action is the personal action in their own block and does not go into Base>");
      expect(text).not.toContain('单人画面写该角色与场景/道具的接触点');
      // Third layer checks slot by slot by name: in a real run the model dropped ambient light while its self-check claimed "all slots covered".
      // The named checklist must include the core interaction for multi-person images; skipping with "-" is only allowed for single-person images.
      expect(text).toContain("was checked slot by slot");
      expect(text).toContain("Ambient light may not be dropped");
      expect(text).toContain("the core interaction of multi-person images");
      // The clothing visual fingerprint is independent of the protocol shape; all three thought chains must keep it.
      expect(text).toContain("Never fall back to bare words like school");
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

      // ① Layer one B counts "who is present", not "who has a profile", and marks each person with one of three identities.
      expect(text).toContain("list **every** character actually present");
      expect(text).toContain("- Read the target text and list **every** character actually present, one by one, named or not (the third-year captain, the shopkeeper). Do not look only at the people in the images you end up selecting, and do not miss characters the lorebook, character card or BaiBai Book describes. What counts is \"who is present\", not \"who has a profile\".");
      expect(text).toContain("· 【one-time】 is a character the text only refers to once, with no setting and no continuing part in the plot: no profile, no changes, nothing enters the library. **They can still appear in images as usual**: when selected, give them a character block valid for that image only, per the back-end specification. Their name is the text's own reference word, and their appearance is completed once to fit the world. Never invent a name for them.");
      expect(text).not.toContain("- Read the target text and list every named character actually present. Do not look only at the people in the images you end up selecting, and do not miss characters the lorebook, character card or BaiBai Book describes.");

      // ② Two-way choice → three-way choice. Changing only the list without the self-check, that person would make the list with a valid identity, only to be
      // sentenced to death at the last check by himself ("every present formal character must take one of two", and he fits neither).
      expect(text).toContain("- Every character present has exactly one of three: a named same-name entry in the 【 character fixed appearance library 】, field: \"new\" in changes, or the 【one-time】 mark (no profile, so no changes; their appearance is added only in their own character block when drawn). Detailed lorebook descriptions do not replace creating a profile. Every hair profiled with field:\"new\" has both colour and length/style, and every eyes has a colour. No 【one-time】 character was written into changes; that would be a mistake. P numbers for permanent changes are valid, and no temporary state was written into changes by mistake.");
      expect(text).not.toContain("- Every formal character present has exactly one of two: a named same-name entry in the 【 character fixed appearance library 】, or field: \"new\" in changes. Detailed lorebook descriptions do not replace creating a profile. Every hair profiled with field:\"new\" has both colour and length/style, and every eyes has a colour. P numbers for permanent changes are valid, and no temporary state was written into changes by mistake.");

      // A missing profile can't veto the core interaction; excluding unrelated people present is still valid framing.
      expect(text).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");
      expect(text).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");

      // Individual/crowd only decides placement once in the image, not whether they deserve to be in it.
      expect(text).toContain("- The roll call is not a casting list: it exists to check who is present and to create profiles. E decides who is in frame, based on the subject and core interaction. A 【one-time】 character is never excluded for lacking a profile, and nobody must be in frame just because they are present or profiled. When the text treats a group as one mass (a crowd, soldiers, onlookers), list it as one \"crowd\" line; if selected, it stays in Base and takes no character block. When unsure whether it is an individual or a group, treat it as a group.");
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');

      // Inventing names is toxic: name lands in the text along with <characters>, and cleanHistoryText keeps
      // bbi_image, so the next floor reads it back as-is; a fake name is indistinguishable from a real profile and would be profiled by mistake.
      expect(text).toContain("· 【one-time】 is a character the text only refers to once, with no setting and no continuing part in the plot: no profile, no changes, nothing enters the library. **They can still appear in images as usual**: when selected, give them a character block valid for that image only, per the back-end specification. Their name is the text's own reference word, and their appearance is completed once to fit the world. Never invent a name for them.");
      expect(text).toContain('Never invent a personal name for them');

      // Name consistency was originally a universal law, and the model read "has no real name" as "has no valid name".
      // Its whole purpose is protecting verbatim matching, and one-off characters take part in no matching, so its scope must be limited.
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');

      // Headcount is by the frame; a missing profile can't be a reason to crop out a participant of the core interaction.
      expect(text).toContain('number of people visible inside this frame');
      expect(text).toContain('a missing profile is never a reason to reject a moment or crop that participant out');

      // C is implicated too: once the list was loosened, not excluding 【one-time】 would make the model maintain a clothing timeline for a one-off opponent,
      // burning tokens and, worse, reinforcing the hint that "he is a proper character", in turn inducing a profile.
      expect(text).toContain("- 【one-time】 characters take no line here: they have no outfit ledger that carries across images. Write their outfit once in the character block of each image they are selected for (consistent if they appear in two images on the same floor). A timeline for them is useless and would also mislead you into profiling them as formal characters.");

      // The example itself was once a bad example: Base wrote 2girls yet gave only one Character Prompt,
      // demonstrating exactly "the other person has no placement". The example must demonstrate the required behaviour.
      expect(text).toContain("- Read the target text and list **every** character actually present, one by one, named or not (the third-year captain, the shopkeeper). Do not look only at the people in the images you end up selecting, and do not miss characters the lorebook, character card or BaiBai Book describes. What counts is \"who is present\", not \"who has a profile\".");
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
        const selection = thinking.split('E. Scene selection\n')[1].split('Second layer')[0];

        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");
        expect(contract).toContain('Anonymous crowds visible in the frame remain in Base');
        expect(selection).toContain("- Prefer images that feature the player's protagonist or the main characters: their expressions, states, actions and relationships. They do not have to be in frame in every image. Candidates gain or lose nothing for having a profile or a name.");
        expect(selection).toContain("- Prefer images that feature the player's protagonist or the main characters: their expressions, states, actions and relationships. They do not have to be in frame in every image. Candidates gain or lose nothing for having a profile or a name.");
        expect(selection).toContain("- First settle the subject and the core interaction this image features, then decide who is in frame. As long as that content is kept, prefer compositions without unrelated people present. Necessary unnamed interaction partners stay as usual; never cut the core action to save one person. A crowd does not have to be in frame just because the text mentions it, but keep it when the crowd itself carries the core interaction.");
        expect(selection).toContain("- First settle the subject and the core interaction this image features, then decide who is in frame. As long as that content is kept, prefer compositions without unrelated people present. Necessary unnamed interaction partners stay as usual; never cut the core action to save one person. A crowd does not have to be in frame just because the text mentions it, but keep it when the crowd itself carries the core interaction.");
        expect(thinking).toContain("- The roll call is not a casting list: it exists to check who is present and to create profiles. E decides who is in frame, based on the subject and core interaction. A 【one-time】 character is never excluded for lacking a profile, and nobody must be in frame just because they are present or profiled. When the text treats a group as one mass (a crowd, soldiers, onlookers), list it as one \"crowd\" line; if selected, it stays in Base and takes no character block. When unsure whether it is an individual or a group, treat it as a group.");
        expect(thinking).toContain("■ P<number>｜<character name or the text's reference> (one block per individual character visible in this image; for a 【one-time】 character, use the text's reference word as the block name)");
        expect(thinking).toContain("- Every character present has exactly one of three: a named same-name entry in the 【 character fixed appearance library 】, field: \"new\" in changes, or the 【one-time】 mark (no profile, so no changes; their appearance is added only in their own character block when drawn). Detailed lorebook descriptions do not replace creating a profile. Every hair profiled with field:\"new\" has both colour and length/style, and every eyes has a colour. No 【one-time】 character was written into changes; that would be a mistake. P numbers for permanent changes are valid, and no temporary state was written into changes by mistake.");
        expect(thinking).toContain("The core interaction was not broken to cut headcount");
        expect(thinking).not.toContain("Character rows (one row per character present): <character name>｜expression｜gaze｜outfit visible in this shot｜temporary state｜personal action");
        expect(thinking).not.toContain('入画资格只看正文是否写他在场');
        expect(spec).toContain('Only include them when the chosen frame needs the crowd');
        expect(spec).toContain('Other people or crowds may remain off-screen');
        expect(spec).toContain('Keep an unnamed participant when needed to show the core interaction');
        expect(spec).not.toContain('an extra body in Base costs a little rendering polish');
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
    expect(messages.some(m => m.content.includes("tag and nl must copy the field values in the library/newly created file"))).toBe(true);
    expect(messages.some(m => m.content.includes("Copy this appearance and add costumes, actions, scenes, etc. around it tag; only write this appearance once in the same picture."))).toBe(true);
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
    expect(messages.some(m => m.content.includes("long-term unchanged physical characteristics"))).toBe(true);
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

    expect(messages.some(message => message.content.includes("he must create a profile for his first appearance"))).toBe(true);
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
      expect(messages.some(message => message.content.includes('Character tag uses girl/boy without a numeric count'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base's global nature holds for both tag and nl: in a real run the model wrote a single character's uniform/body type into the Base nl,
      // duplicating the character nl; the old text only put the ban at the tag level.
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // Profile nl only covers fixed appearance: temporary clothing in a permanent profile's nl would follow every later floor.
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
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
    const thinkingMsg = messages.find(m => m.content.includes("Pre-output checklist"));
    expect(thinkingMsg?.content).toContain("- For expression and gaze, use the standard danbooru words in the back-end specification. Do not write feelings in Chinese or invent phrases (for \"gently smiling\", just write smile). Choose only from the words the specification lists; anything else is not allowed. When unsure, use expressionless / looking at another. Neither slot may be blank: even a blank face gets expressionless. In multi-person images each person gets their own pair, bound to them in tag. Never merge them or leave them bare: a bare expression lands on one person only, and everyone else gets the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expression and gaze, use the standard danbooru words in the back-end specification. Do not write feelings in Chinese or invent phrases (for \"gently smiling\", just write smile). Choose only from the words the specification lists; anything else is not allowed. When unsure, use expressionless / looking at another. Neither slot may be blank: even a blank face gets expressionless. In multi-person images each person gets their own pair, bound to them in tag. Never merge them or leave them bare: a bare expression lands on one person only, and everyone else gets the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expression and gaze, use the standard danbooru words in the back-end specification. Do not write feelings in Chinese or invent phrases (for \"gently smiling\", just write smile). Choose only from the words the specification lists; anything else is not allowed. When unsure, use expressionless / looking at another. Neither slot may be blank: even a blank face gets expressionless. In multi-person images each person gets their own pair, bound to them in tag. Never merge them or leave them bare: a bare expression lands on one person only, and everyone else gets the default wooden face.");
    // Two real runs in a row didn't copy the ■ format, yet not one of the seven slots was missed; the goal of preventing omissions was met,
    // and the shape isn't the goal. So shape assertions like "■ on its own line" are deliberately not pinned, only that the slots are complete.
    expect(thinkingMsg?.content).toContain("Write one block per image and fill every slot below. Wording is up to you, but none of the eight slots may be missing: a missing slot leaves a gap in the final tag.");
    // An actionable criterion for wavering: with an abstract "don't keep weighing it up", the model always feels it isn't weighing anything.
    expect(thinkingMsg?.content).toContain("Write conclusions only, never the reasoning. <thinking> is your scratchpad for settling facts, not an answer. Decide each judgment once: a field may hold only one value in the whole <thinking>. Do not ask yourself \"A or B?\", do not list candidates and reject them one by one, do not reopen a settled field, and do not pre-write the final tag/nl string. When evidence is thin, decide by the defaults in this checklist and the back-end specification (if unsure of size, write portrait; if outfit details are unknown, pick a common, self-consistent outfit), then move on.");
    // The constraint against writing out the reasoning is kept, but with no hard word limit: a limit would force the model to compress profile decisions for multi-image, multi-person scenes.
    expect(thinkingMsg?.content).not.toContain("【 Complete the draft in one pass·The iron rule 】 Only write one conclusion and ≤2 sentences in each step; both the judgment and the editing will decide on the first tenable answer, leaving the \"selection\" to the quality self-inspection. 【 prohibits 】 from listing multiple alternative shots (without writing \"A better idea is.../or.../from another angle...\" etc.), 【 prohibits 】 from overturning and starting over, and 【 prohibits 】 from rereading the plot and weighing it repeatedly. The whole paragraph of thinking is about ≤800 words. After writing, output </arc_think> immediately without further writing.");
    expect(thinkingMsg?.content).toContain("- Three patterns are banned: self-questions with question marks (\"landscape?\", \"use blush?\"), side-by-side candidates (\"expressionless or slight smile\"), and reversals after writing (\"use A... but B is better, change A to B\"). Compare in your head and write only the conclusion. When evidence is thin, decide by the defaults (if unsure of size, write portrait; if outfit details are unknown, pick a common, self-consistent outfit), then move on.");
    expect(thinkingMsg?.content).toContain("- Three patterns are banned: self-questions with question marks (\"landscape?\", \"use blush?\"), side-by-side candidates (\"expressionless or slight smile\"), and reversals after writing (\"use A... but B is better, change A to B\"). Compare in your head and write only the conclusion. When evidence is thin, decide by the defaults (if unsure of size, write portrait; if outfit details are unknown, pick a common, self-consistent outfit), then move on.");
    // The third layer once described itself as "turning into tags", directly fighting "don't pre-write tag strings"; in a real run the tags were written four times.
    expect(thinkingMsg?.content).toContain("Self-check before writing");
    // The previous version only banned "full tag/nl strings", and the model found the loophole of pre-writing the whole JSON object in thinking
    // (a final line "JSON:" plus a complete answer), burning about 800 tokens. The wording must cover the JSON itself.
    expect(thinkingMsg?.content).toContain("In this layer, check each item below and write one conclusion per item. No draft of the final answer may appear in <thinking>: no full tag string, no full nl sentence, no JSON object and no heading like \"JSON:\". The answer appears exactly once, after </thinking>. Writing it inside thinking first means paying for the whole output twice. When the check is done, close </thinking> and output the JSON:");
    expect(thinkingMsg?.content).toContain("In this layer, check each item below and write one conclusion per item. No draft of the final answer may appear in <thinking>: no full tag string, no full nl sentence, no JSON object and no heading like \"JSON:\". The answer appears exactly once, after </thinking>. Writing it inside thinking first means paying for the whole output twice. When the check is done, close </thinking> and output the JSON:");
    expect(thinkingMsg?.content).not.toContain('第三层｜落成 tag 并自查');
    expect(thinkingMsg?.content).not.toContain('逐条转成 tag/nl');
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
        expect(contract).toContain('name and tag are both required');
        // Profiles no longer need nl either; runner acceptance follows the same rule (profile.nl), otherwise retries would be wasted on a non-existent requirement
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // Specification rule 6 is swapped wholesale for the tag-only version (numbering unchanged); the example and entry shape drop nl in step
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain("This run writes tags only");
        expect(thinking).not.toContain("no full nl sentence");
        // Multi-character prompts themselves are unaffected by the toggle: only nl is turned off; characters[] is still required
        expect(thinking).toContain('characters[]');

        settings.nai.naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain("no full nl sentence");
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
