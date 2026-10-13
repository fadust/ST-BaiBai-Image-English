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
 * 提示词集:全部留空(= 回落内置默认),只把本用例关心的那几项覆盖掉。
 * 收在一处是因为 AutoTagPrompts 每加一个键,散落的字面量会同时 typecheck 失败。
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
    // 建档不受入选与否影响,也不受位置门控 —— 这两条是修复的核心,措辞必须在协议里
    expect(messages.some(m => m.content.includes("- **Create a profile before drawing**: Read through the text of the target first and find out every official character with a name and surname that is not in the 【 character fixed appearance library 】 - as long as the character card, World Info, BaiBai Book or continuous plot has given a setting for him, or he is a character who continues to participate in the plot, he must create a profile for his first appearance, regardless of whether he is selected for this picture. The basis for judgment is all the setting content sent to you, and it is up to you to read through it and make your own judgment. One-time unknown passers-by do not build."))).toBe(true);
    expect(messages.some(m => m.content.includes("- File writing method: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"First Appearance File\"}; position fill in the location where he first appeared, for record only - the file is valid throughout this building, and pictures anywhere in this building can use this appearance immediately."))).toBe(true);
    // 已撤销的 characters 审计:不得回流到协议里
    expect(messages.some(m => m.content.includes("\"characters\""))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain("[system-maintained; currently empty]");
    expect(user.content).toContain("【 character fixed appearance database 】[system-maintained; currently empty]\n (Currently empty, no character has been profiled. The World Info, character card, BaiBai Book and text only provide the basis for creation; official characters not listed in this block must be profiled through field:\"new\".)");
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

    const thinkingMsg = messages.find(m => m.content.includes("Consideration Checklist before Output"));
    expect(thinkingMsg?.role).toBe('system');

    // 两层结构:A~E 是整楼一次的全局判断,第二层是逐图槽位块。
    // 结构骨架比逐字文案更值得钉——散装 bullet 正是模型把每图压成一句话的原因。
    expect(thinkingMsg?.content).toContain("First floor｜Global judgment (one for the whole floor)");
    expect(thinkingMsg?.content).toContain("Second layer | Picture slot blocks");
    expect(thinkingMsg?.content).toContain("Second layer | Picture slot blocks one by one (Write one block for each P selected by E, and may not be merged or shared across pictures)");
    expect(thinkingMsg?.content).toContain("Self-check before writing");
    for (const slot of ['Character:', "Core actions:", 'Scene:', 'Scene:', 'Ambient light:', "size："]) {
      expect(thinkingMsg?.content).toContain(slot);
    }
    expect(thinkingMsg?.content).toContain("Character rows (one row for each character present): <character name>｜expression｜line of sight｜clothing visible in this shot｜temporary status｜personal actions");
    expect(thinkingMsg?.content).toContain("Slot filling requirements (the slot value directly writes the English word you want to eventually put into tag; write \"-\" for the slot that is indeed not applicable, but the seven items of core action, scenery, expression, sight, scene, ambient light, and size must never be \"-\"):");
    expect(thinkingMsg?.content).toContain("Slot filling requirements (the slot value directly writes the English word you want to eventually put into tag; write \"-\" for the slot that is indeed not applicable, but the seven items of core action, scenery, expression, sight, scene, ambient light, and size must never be \"-\"):");
    // 表情/视线此前全库没有槽位,是「木脸」的根因;两个后端规范也要各带一份。
    expect(thinkingMsg?.content).toContain("- For expressions and gaze, fill in the standard danbooru words given in the back-end specification. If you don't write Chinese feelings or create your own phrases (if you want to write \"gently smile\", just fill in smile); you can only choose from the words listed in the specification. Words not listed in the specification are not allowed to be used. If you are not sure, fill in expressionless / looking at another. Neither item should be left blank, and expressionless must be filled in even if you have no expression on your face. Each person in the multi-player screen will fill in one copy, and they will be bound when they enter tag. They cannot be merged or written naked - the naked expression will only fall on one person, and the other person will become the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expressions and gaze, fill in the standard danbooru words given in the back-end specification. If you don't write Chinese feelings or create your own phrases (if you want to write \"gently smile\", just fill in smile); you can only choose from the words listed in the specification. Words not listed in the specification are not allowed to be used. If you are not sure, fill in expressionless / looking at another. Neither item should be left blank, and expressionless must be filled in even if you have no expression on your face. Each person in the multi-player screen will fill in one copy, and they will be bound when they enter tag. They cannot be merged or written naked - the naked expression will only fall on one person, and the other person will become the default wooden face.");
    expect(thinkingMsg?.content).toContain("- tag of each picture covers all non-\"-\" slots of its own piece, without missing expressions, line of sight or ambient light; when nl is required, it describes the same picture as tag.");
    // 不再发送 assistant 预填充,消息以 user 任务消息收尾。
    expect(thinkingMsg?.content).toContain("First go through <thinking> and </thinking> in the following order, and then output the final JSON after thinking. Nothing shall be output except this one <thinking> block and the final JSON, nor shall a second <thinking> block be opened.");

    // 以下是重写前就必须守住的既有约束,逐条确认没有在重构中丢失。
    expect(thinkingMsg?.content).toContain("- The temporary state cannot be restored to the character's default value without clear transition, organization, change of clothes, state release, time jump or scene switch.");
    expect(thinkingMsg?.content).toContain("- Check the permanent changes against the character library: hair dyeing, hair cutting, permanent transformation, etc. are written in changes and marked with the effective P number; temporary status such as wigs, contact lenses, wet hair, light discoloration, etc. are not written. This step cannot be skipped even if images is ​​empty.");
    expect(thinkingMsg?.content).toContain("- Sort by visual clarity, plot importance, action completeness, and difference from other candidates, and abide by the minimum to maximum numbers given in the task agreement: when the lower limit is greater than 0, make up for it from lesser but still visible candidates; after reaching the lower limit, only continue to select pictures that are strong enough and clearly different from each other, and do not use adjacent actions or different shots of the same event to get closer to the upper limit.");
    expect(thinkingMsg?.content).toContain("- Sort by visual clarity, plot importance, action completeness, and difference from other candidates, and abide by the minimum to maximum numbers given in the task agreement: when the lower limit is greater than 0, make up for it from lesser but still visible candidates; after reaching the lower limit, only continue to select pictures that are strong enough and clearly different from each other, and do not use adjacent actions or different shots of the same event to get closer to the upper limit.");
    expect(thinkingMsg?.content).toContain("- A single moment: a picture that can only be captured completely by one shutter. Do not put multiple actions, multiple time points or causal processes that happened one after another into the same piece; the plot facts are strictly based on the text, and do not make up characters, actions or number of people.");
    // size 判定口径瘦身后只留在后端规范一份(thinking 与协议都不再复述),
    // 但整套消息里必须仍有且有这一份,否则模型无从判断横竖。
    expect(messages.some(m => m.content.includes("Write landscape for group portraits, long-range panoramas, wide scenes, and horizontally unfolding interactions; write portrait for single people, vertical stances, close-ups, and close-up compositions of two people."))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('双人近距离可 portrait');
    expect(thinkingMsg?.content).toContain("- The candidate must be a visible moment with a clear subject, action or visual state and scene. Pure dialogue is retained only when accompanied by expressions, body movements, character relationships, or environmental changes worth drawing; only dialogue without visual changes, pure psychology, and transitions are skipped.");
    expect(thinkingMsg?.content).toContain("- Each person writes a line of conclusion: the hit library entry with the same name, or this time field: \"new\". Only those whose names are actually listed in the 】 block of the 【 character fixed appearance database are considered to have been archived - the detailed settings in the World Info, character card, BaiBai Book or text are only sources of archive creation and do not mean that they are already in the database, and they cannot be claimed to be in the database based on impressions. If Curry does not have a role but is a formal character (with a setting or continuous participation in the plot), the profile will be created for the first time, regardless of whether he is selected for this picture; one-time unknown passers-by will not be created.");
    expect(thinkingMsg?.content).toContain("regardless of whether he is selected for this picture");
    expect(thinkingMsg?.content).toContain("profile creation is valid throughout this building");
    // 建档的 hair 必须带长度/发型:只写颜色的旧措辞会让模型以 black hair 过关。
    expect(thinkingMsg?.content).toContain("hair must have both hair color");
    expect(thinkingMsg?.content).not.toContain('hair 与 eyes 都不得留空');
    // 白皙肤色词禁令(ComfyUI 默认肤色已够白,叠 pale skin 会白得失真):
    // 规范给禁令,思维链第三层给落笔前的检查位;tan/dark skin 是豁免项。
    expect(messages.some(m => m.content.includes("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- There are no fair skin tone words like pale skin, white skin, fair skin mixed into any picture (if there are any in the character library field, skip them and don't copy them): the default skin color is already white enough, but writing it down will make it look white and gray; the characters are really tanned/dark skinned and use tan and dark. skin is not included.");
    expect(thinkingMsg?.content).toContain("- There are no fair skin tone words like pale skin, white skin, fair skin mixed into any picture (if there are any in the character library field, skip them and don't copy them): the default skin color is already white enough, but writing it down will make it look white and gray; the characters are really tanned/dark skinned and use tan and dark. skin is not included.");
    // 建档字段的详细写法瘦身后只留在任务协议一份,thinking 不再复述。
    expect(messages.some(m => m.content.includes("- File writing method: {\"name\":\"Character name\",\"field\":\"new\",\"fields\":{\"sex\":\"1girl\",\"hair\":\"long black hair\",\"eyes\":\"blue eyes\"},\"position\":\"P2\",\"reason\":\"First Appearance File\"}; position fill in the location where he first appeared, for record only - the file is valid throughout this building, and pictures anywhere in this building can use this appearance immediately."))).toBe(true);
    // 新旧档案的 position 语义、时代判断的发挥边界:瘦身后各自只留一份权威副本
    // (分别在任务协议与后端规范),thinking 不再复述,但整套消息里必须仍在。
    expect(messages.some(m => m.content.includes("- The permanently changed position is the position where the new status takes effect: the pictures before this position use the old file, and the position and after use the new file; multiple changes are reported separately in the text."))).toBe(true);
    expect(messages.some(m => m.content.includes("When there is a clear setting, strictly follow it; when there is no clear setting, you must also take the initiative to choose the most reasonable, specific and self-consistent era, civilization or original visual system based on the existing clues and plot temperament. When there is less evidence, the style of the era, clothing styles, materials, accessories, light and tone can be reasonably supplemented, but this is limited to \"how to draw\" and cannot be used to make up \"what is in the picture\"."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Define a specific, self-consistent era/culture/visual system and use it throughout the building: strictly follow it if there is a clear setting, even if there is little evidence, choose one proactively, and do not fall back on neutral clothing or default to modern cities. Implemented in clothing styles, materials, accessories and evidence-based architectural artifacts.");
    expect(thinkingMsg?.content).toContain("- This set of judgments only determines \"how to draw\" and cannot be used to concretize unknown scene facts.");
    // 泥地/地形禁令原本 3 份(规范 + 槽位 + 自查),瘦身后规范留完整版、
    // thinking 只留一句「没依据就别写」。outdoors/forest 的具体口径归规范。
    expect(messages.some(m => m.content.includes("Just write outdoors when the text only confirms \"wild\", write forest when only confirm \"forest\"; only write muddy, ground, dirt, path, puddles, etc. corresponding to tag when the text, context or world settings clearly support the facts such as rain, mud, dirt road, etc."))).toBe(true);
    expect(messages.some(m => m.content.includes("Implement judgment into the details that are actually visible in the picture: when the characters are visible, priority is given to improving clothing styles, materials, and accessories; when the background is visible, only the buildings, furniture, environments, and utensils that can be supported by the setting or text are added. Terrain, ground or road materials, weather traces and environmental conditions are all scene facts. Keep it simple if there is no basis for it. You are not allowed to add mud, dirt roads, wetlands, stagnant water, snow, dust or slippery ground in order to enrich the picture."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Scene and ambient light: For a scene, only write facts that can be supported by the main text, context or world setting. Terrain, ground material, weather traces and environmental conditions are all considered facts. Don’t write if there is no basis for it. Ambient light is the opposite. The light source, time and tone will not be written in the text and must be determined by you. Without the picture, it will be a mediocre headshot.");
    expect(thinkingMsg?.content).toContain("- Each plot tag can be traced back to the main text/setting; terrain, ground, roads, weather and environmental conditions tag will be deleted if there is no basis.");
    expect(thinkingMsg?.content).toContain("- Each person writes a line of conclusion: the hit library entry with the same name, or this time field: \"new\". Only those whose names are actually listed in the 】 block of the 【 character fixed appearance database are considered to have been archived - the detailed settings in the World Info, character card, BaiBai Book or text are only sources of archive creation and do not mean that they are already in the database, and they cannot be claimed to be in the database based on impressions. If Curry does not have a role but is a formal character (with a setting or continuous participation in the plot), the profile will be created for the first time, regardless of whether he is selected for this picture; one-time unknown passers-by will not be created.");
    expect(thinkingMsg?.content).toContain("- Maintain the temporary clothing of each character according to the P position in the main text: the initial outfit is reasonably decided once when the main text does not specify it; if there is no putting on or taking off, changing clothes, clothing damage or scene/time jump, the previous state will be used. After the change is clear, it will be updated from the corresponding P position.");
    expect(thinkingMsg?.content).toContain("visual fingerprint");
    expect(thinkingMsg?.content).toContain("main color + key components");
    expect(thinkingMsg?.content).toContain("pantyhose includes color and transparency");
    expect(thinkingMsg?.content).toContain("- Each set of clothing freezes a \"visual fingerprint\" (version/cut + main color + key components, pantyhose includes color and transparency, please see the task agreement for specific requirements). The same copy is reused throughout the building in the same state. Do not write isolated words such as school, uniform, dress, and pantyhose. These models will be redesigned by themselves.");
    // 槽位侧同样要挡住笼统词,否则 C 段定了 navy school blazer、槽位里仍退回 school uniform。
    expect(thinkingMsg?.content).toContain("- In the visible costume photo C, the visual fingerprint of the current state of the character is written piece by piece, only the parts visible in the current scene are written; the parts that are invisible outside the camera can be omitted, but omitting does not mean taking them off. They must be restored when they are re-visible later and there are no changes in the middle. General isolated words such as school, uniform, dress, and pantyhose are not allowed to be returned in the slot - the C segment is navy school blazer, so write navy school blazer, writing a general term is equivalent to letting the model redesign the clothes by herself. The same character will change the style in every picture. In the multiplayer screen, each person's clothing is written separately, and they are bound when they enter tag: both of them wear school uniforms, but the men's and women's styles are different. If you write school or uniform naked, the model will put the skirt on the boy.");
    expect(thinkingMsg?.content).toContain("- In the visible costume photo C, the visual fingerprint of the current state of the character is written piece by piece, only the parts visible in the current scene are written; the parts that are invisible outside the camera can be omitted, but omitting does not mean taking them off. They must be restored when they are re-visible later and there are no changes in the middle. General isolated words such as school, uniform, dress, and pantyhose are not allowed to be returned in the slot - the C segment is navy school blazer, so write navy school blazer, writing a general term is equivalent to letting the model redesign the clothes by herself. The same character will change the style in every picture. In the multiplayer screen, each person's clothing is written separately, and they are bound when they enter tag: both of them wear school uniforms, but the men's and women's styles are different. If you write school or uniform naked, the model will put the skirt on the boy.");
    // 自查项要点名服装,上一版只提「表情视线」,模型自查时就只核对了表情视线。
    expect(thinkingMsg?.content).toContain("- In the multiplayer screen, clothing, body shape, objects, expressions, sightlines and personal actions have all been bound to their respective characters, and there are no scattered ownerless characteristics; the clothing of each character present actually appears in tag, and no one's clothing is only written in the slot but not in tag, nor school uniform, pantyhose This type of general isolated word has no owner; each character present has an expression word and sight word bound to himself, and no one has only actions but no expression.");
    // 配角只写「弯腰换鞋」不写表情词 → tag 里他没有表情。角色行必须逐人写全英文词。
    expect(thinkingMsg?.content).toContain("- The character line is one line for each character present. The supporting characters must also be written in full. It is not allowed to write a complete line only for the protagonist and use a Chinese action sentence to describe the supporting characters. The expression and gaze of each line must be an independent English danbooru word: writing a Chinese phrase like \"look to the other side, bending down to change shoes\" means that there is no expression word in this line. When tag is written, the character will have no expression and be painted as a wooden face by the model.");
    expect(thinkingMsg?.content).toContain("- The character line is one line for each character present. The supporting characters must also be written in full. It is not allowed to write a complete line only for the protagonist and use a Chinese action sentence to describe the supporting characters. The expression and gaze of each line must be an independent English danbooru word: writing a Chinese phrase like \"look to the other side, bending down to change shoes\" means that there is no expression word in this line. When tag is written, the character will have no expression and be painted as a wooden face by the model.");
    expect(thinkingMsg?.content).toContain("- In the multiplayer screen, clothing, body shape, objects, expressions, sightlines and personal actions have all been bound to their respective characters, and there are no scattered ownerless characteristics; the clothing of each character present actually appears in tag, and no one's clothing is only written in the slot but not in tag, nor school uniform, pantyhose This type of general isolated word has no owner; each character present has an expression word and sight word bound to himself, and no one has only actions but no expression.");
    // 超限重选必须发生在 E 段,不能等到第三层「让位」——那几块槽位是白写的。
    expect(thinkingMsg?.content).toContain("- The quantity is stuck here: count it before writing the P list. If it exceeds the upper limit, cut it to the upper limit on the spot and then go down. The second level only writes blocks for the final selected P. It is absolutely not allowed to overwrite a few blocks first and then delete them when the third level finds that the limit is exceeded - those blocks are written in vain, and the third level only checks and does not change the decision.");
    expect(thinkingMsg?.content).toContain("- This layer only checks and does not change decisions: if you find a problem, correct it directly when you enter tag. Do not write down revision processes such as \"over limit, need to streamline\", \"give way\" and \"change to\" in your thinking. The number of shots is already fixed in the E segment and should not be changed here.");
    expect(messages.some(m => m.content.includes('navy school blazer, white collared shirt, red ribbon'))).toBe(true);
    expect(thinkingMsg?.content).toContain("omitting does not mean taking them off");
    expect(thinkingMsg?.content).toContain("- In the multiplayer screen, clothing, body shape, objects, expressions, sightlines and personal actions have all been bound to their respective characters, and there are no scattered ownerless characteristics; the clothing of each character present actually appears in tag, and no one's clothing is only written in the slot but not in tag, nor school uniform, pantyhose This type of general isolated word has no owner; each character present has an expression word and sight word bound to himself, and no one has only actions but no expression.");
    expect(messages.some(m => m.content.includes("- \"File has been created\" can only be judged by the entry with the same name in the 】 block of the 【 character fixed appearance library: only the name is actually listed in the block is considered to be a file; the detailed settings in the World Info, character card, BaiBai Book or text are only the basis for the creation of the file, and do not mean that it is already in the library. Each official character present must choose one of two options: point to an entry with the same name in the library, or type field:\"new\" in changes. The one-time nameless character is not included in this alternative: he neither files nor writes changes, does not need to specify any library entries, and missing files is normal and not an omission."))).toBe(true);
    expect(messages.some(m => m.content.includes("- In the multiplayer screen, each character's hair color, eye color, body shape, clothing, objects, and personal actions must be bound adjacently using the character's distinctive title. It is prohibited to scatter the appearance characteristics of two people into a string of public tag that cannot be attributed."))).toBe(true);
    expect(thinkingMsg?.content).toContain("- Define a specific, self-consistent era/culture/visual system and use it throughout the building: strictly follow it if there is a clear setting, even if there is little evidence, choose one proactively, and do not fall back on neutral clothing or default to modern cities. Implemented in clothing styles, materials, accessories and evidence-based architectural artifacts.");
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
    expect(messages.some(m => m.content.includes("Consideration Checklist before Output"))).toBe(false);
    // 预填充功能已移除:消息里不应再出现 assistant 角色。
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  // 思维链按后端各存一份。改 ComfyUI 那份不能影响 NAI——共用一份正是 V5 被要求填
  // 「景别/环境光/邻接绑定」这类它的规范从未教过的字段的根因。
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
        // 单串分支的代表换成原版 NAI4:4.5 起走 Character Prompts 分支(自然语言是 4.5 引入的)
        // ⚠ NAI4 已从 NAI_MODELS 撤下(设置页选不到了),但 prompt.ts 的单串分支与
        // naiSpec/naiThinking 两个键都还在,故这条继续按字符串锁住分支归属。
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

  // 身份 tag 与 NSFW 的思维链落点:0.1.16 的旧清单本来有(身份 tag 定词+自查 / NAI 专属
  // NSFW 条款+自查),三层重写时三份全丢——规则只在 spec 里、思考回路没有检查位,
  // 漏写概率回升。这条钉死三份各自的落点口径,且 NSFW 不带年龄限定。
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
      // ComfyUI:身份 tag 定词 + 括号转义提醒 + negative 条件自查(只有 Comfy 工作流会有
      // negative 键);Comfy spec 无 NSFW 条款,思维链也不加。
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("final identity tag words are determined in the same line");
      expect(text).toContain(
        "The tag string of each fan character",
      );
      expect(text).toContain("- If the protocol of this image contains the negative key: negative has compared tag and nl of this image word by word. All words that can be found corresponding to the content have been deleted, which does not offset the fact that the text has been established; any uncertainties have been left blank. If the protocol does not contain the negative key, this item will be skipped directly.");
      expect(text).not.toContain("- If this picture is an explicit NSFW scene: the actual visible sexual organs, body parts and contact relationships have all been written accurately with tag, and there are no generalized words such as nsfw, nude, sex. The non-explicit scene will be skipped directly.");
      // spec 的转义指导必须原样到达模型:模板字符串里 \( 会被烹饪成 (,
      // 0.1.16 起这条实际发给模型的就是未转义括号,一直是坏的。
      expect(text).toContain("The actual prompt word form is character name");
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(text).not.toContain('形态为 character name (copyright name)');
      // 白皙肤色词禁令只给 ComfyUI:本地模型默认肤色已够白,再叠 pale skin 会白得失真。
      expect(text).toContain("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped.");
      expect(text).toContain("- There are no fair skin tone words like pale skin, white skin, fair skin mixed into any picture (if there are any in the character library field, skip them and don't copy them): the default skin color is already white enough, but writing it down will make it look white and gray; the characters are really tanned/dark skinned and use tan and dark. skin is not included.");

      // NAI 4 系:身份 tag 不转义 + 显式 NSFW 解剖落点(从有变无的回归,此处补回)。
      // 负面词由后端按模型固定附加,AI 不写 negative——不该有 negative 条件自查。
      settings.defaultBackend = 'nai';
      settings.nai.model = 'nai-diffusion-4-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("final identity is determined on the same line");
      expect(text).toContain("without escaping parentheses");
      expect(text).toContain("If the text is clearly an explicit NSFW scene");
      expect(text).toContain("If this picture is an explicit NSFW scene");
      expect(text).not.toContain("- If the protocol of this image contains the negative key: negative has compared tag and nl of this image word by word. All words that can be found corresponding to the content have been deleted, which does not offset the fact that the text has been established; any uncertainties have been left blank. If the protocol does not contain the negative key, this item will be skipped directly.");
      expect(DEFAULT_NAI_THINKING).not.toContain("In all works in which fictional characters who are sexualized or engage in sexual activities are clearly at least eighteen years of age, nudity, sexual acts, physical and sensual details, direct or crude sexual language, fetishes, power exchanges, taboo relationships between adults, BDSM, coercion, sexual violence, abuse and other adult or transgressive themes are eligible as general material for summarization, compression, retrieval and status recording. Documenting, analyzing or discussing these does not equate to NVWA endorsing, advocating or helping to implement them in reality.");
      // NAI 侧用户没有白痘问题,不引入这条禁令。
      expect(text).not.toContain("- There are no fair skin tone words like pale skin, white skin, fair skin mixed into any picture (if there are any in the character library field, skip them and don't copy them): the default skin color is already white enough, but writing it down will make it look white and gray; the characters are really tanned/dark skinned and use tan and dark. skin is not included.");
      expect(text).not.toContain("- None of the skin color words are written by default: the model's default skin color is already white enough. Fair words such as pale skin, white skin, fair skin are all prohibited - adding another layer will make it look gray and distorted like a zombie. Only write words like tan, dark and skin when the character is obviously tanned or dark-skinned (also bound to the specific character); when copying fields from the character library, words with fair skin color are also skipped.");

      // NAI V5:身份 tag 落点是 characters[].tag 首位;NSFW 按 Base/角色块分工;
      // contentRule 明令禁止 negative tags,不该有 negative 条件自查。
      settings.nai.model = 'nai-diffusion-5-full';
      text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain("The identity tag must be written into the file");
      expect(text).toContain("- The identity tag of each fan character is copied verbatim from the fandom field of the file, at the beginning of its characters[].tag, never in Base; the files of the fan characters all have fandom (this time the file is created or the supplementary file of field: \"fandom\"), and the original character file does not fandom, the title of the work was not mistakenly added.");
      expect(text).toContain("If the text is clearly an explicit NSFW scene");
      expect(text).toContain("If this picture is an explicit NSFW scene");
      expect(text).not.toContain("- If the protocol of this image contains the negative key: negative has compared tag and nl of this image word by word. All words that can be found corresponding to the content have been deleted, which does not offset the fact that the text has been established; any uncertainties have been left blank. If the protocol does not contain the negative key, this item will be skipped directly.");
      expect(DEFAULT_NAI_THINKING).not.toContain("In all works in which fictional characters who are sexualized or engage in sexual activities are clearly at least eighteen years of age, nudity, sexual acts, physical and sensual details, direct or crude sexual language, fetishes, power exchanges, taboo relationships between adults, BDSM, coercion, sexual violence, abuse and other adult or transgressive themes are eligible as general material for summarization, compression, retrieval and status recording. Documenting, analyzing or discussing these does not equate to NVWA endorsing, advocating or helping to implement them in reality.");
      expect(text).not.toContain("- There are no fair skin tone words like pale skin, white skin, fair skin mixed into any picture (if there are any in the character library field, skip them and don't copy them): the default skin color is already white enough, but writing it down will make it look white and gray; the characters are really tanned/dark skinned and use tan and dark. skin is not included.");
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // NAI V5 用 Base + characters[] 隔离每个人,其规范第 8 条明令禁止 ComfyUI 的邻接绑定。
  // 旧版三后端共用一份思维链时,V5 被要求做规范禁止的事——这条钉死不再回流。
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

      // 邻接绑定的每种措辞都不得出现在 V5 路径上。
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

      // 取而代之的是 Base 块 + 每角色块。
      expect(text).toContain("■ P<No.>｜Base");
      expect(text).toContain("■ P <Number>｜<Character name or text reference>");
      // 角色块按取景框、不按档案:块名允许正文指称,固定外貌槽给【一次性】留了合法填法。
      // 旧口径「照抄库中/刚建档的字段」是唯一来源,无名角色在这个槽位上无路可走——
      // 于是模型宁可放弃画面(见「无名角色入画」问题文档),这条钉死不再回流。
      expect(text).toContain("■ P <Number>｜<Character name or text reference> (Write one block for each individual character visible in this picture; for 【 one-time 】 characters, use the original reference word in the text as the block name)");
      expect(text).toContain("Fixed appearance: <【 has been filed, 】【, this file is created, 】 copies the fields in the library/newly created file; 【 is one-time, 】 is one-time completion according to the world view, including at least gender, hair color, hair color, and eye color. 1girl/1boy will all be converted to girl/boy>");
      expect(text).toContain("- **Don't use adjacency binding**: Hanging features after other people's color words (for example, connecting white dress directly after green hair girl) is a single string tag backend approach, V5 does not use it. Each character here has its own independent block. Just write white dress. The ownership is determined by the block it belongs to.");
      expect(text).toContain("division of labor between the Base block and the character block is a hard boundary");
      expect(text).toContain("when they fall into JSON, they enter his own characters[].tag");
      // 单人画面没有多人互动:核心互动槽写 "-",唯一角色的动作进他角色块的个人动作——
      // 旧口径让单人接触点写进 Base 槽,与「个人动作只进角色块」的分工规则直接打架。
      expect(text).toContain("Core interaction: <The action that multiple people participate in: whose body part touches what, first describe the contact point in English, and then give English tag; for single-player screen, write \"-\" in this slot, the only character's action is the personal action of his character block, do not enter Base>");
      expect(text).not.toContain('单人画面写该角色与场景/道具的接触点');
      // 第三层逐槽点名核对:实跑里模型把环境光丢了、自查却声称「覆盖了全部槽位」。
      // 点名清单必须含多人画面的核心互动——只在单人画面才允许 "-" 跳过。
      expect(text).toContain("has been checked slot by slot");
      expect(text).toContain("ambient light is not allowed to leak");
      expect(text).toContain("core interaction of multi-person pictures");
      // 服装视觉指纹与协议形态无关,三份思维链都要保住。
      expect(text).toContain("General isolated words such as school");
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 建档资格 ≠ 入画资格。实跑里模型把「一次性无名路人不建档」读成「无名者不能入画」,
  // 于是放弃了全文最强的戏剧瞬间(核心互动的另一方是个无名对手),转而挑了个能把他
  // 裁出镜头的景别。根因是造名单的谓词写错了:第一层 B 只清点「有名有姓」,那人从未
  // 上册,下游规则根本看不见他。三处必须同时成立,缺一处他就会在某一环被判死刑。
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

      // ① 第一层 B 清点「谁在场」而不是「谁有档案」,并逐人标出三类身份。
      expect(text).toContain("list **all** characters who are actually present");
      expect(text).toContain("- Read through the text of the target and list **all** characters who are actually present one by one - both named and surnamed (third-year captain, shopkeeper). Do not just look at the people in the final selected picture, and do not omit the characters for whom the World Info, character card or BaiBai Book have been set. What counts is \"who is present\", not \"who has files\".");
      expect(text).toContain("· 【 one-time 】 The text only gives references to one-time characters with no setting and no continuous participation in the plot - no file creation, no writing changes, no entry into the library. This type of ** can be included in the picture as usual **: when selecting the picture, write him a character block that is only valid for this picture according to the back-end specifications. name uses the original referential word in the text, and completes the appearance in one go according to the world view. Never make up a name for him.");
      expect(text).not.toContain("- Read through the text of the target and list the named characters who are actually present. You can't just look at the people in the final selected picture, and you can't miss the characters for whom the World Info, character card or BaiBai Book have given settings.");

      // ② 二选一 → 三选一。只改名单不改自查,那人会以合法身份上册、却在最后一关被
      // 自己判死刑(「每个在场正式角色必须二选一」他两条都占不上)。
      expect(text).toContain("- Each character present can choose one of three: point out the entry with the same name in the 【 character's fixed appearance library 】, field: \"new\" in changes, or mark 【 as a one-time 】 (do not write if you do not create a file) changes, only add appearance in his own character block when drawing); the detailed settings in the World Info cannot replace the creation of files. Every field:\"new\" profile of hair has both hair color and length/hairstyle, and eyes has eye color. The 【 one-off 】 character was not written into changes - it would have been a mistake. The permanently changed P number is legal, and the temporary status has not been mistakenly written into changes.");
      expect(text).not.toContain("- Each official character present can choose one of the two: point out the entry with the same name in the fixed appearance library 】 of the 【 character, or field: \"new\" in the changes; detailed settings in the World Info cannot replace the creation of a file. Every hair profiled by field:\"new\" has both hair color and length/hairstyle, and eyes has eye color. The permanently changed P number is legal, and the temporary status has not been mistakenly written into changes.");

      // 缺档不能否决核心互动;排除无关在场者仍是合法取景。
      expect(text).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");
      expect(text).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");

      // 个体/人群只决定入画后的落位,不决定是否值得入画。
      expect(text).toContain("- The inventory list is not a list of entries: it is listed here to check the presence facts and create files. Who is included in the shot is determined by the E segment based on the subject and core interaction. 【 one-time 】 will not be excluded due to missing profiles, and no character must be included in the shot just because he is present or has been profiled. The main text treats a group of people as a whole (crowd, soldiers, onlookers), just line them up as a \"crowd\"; select the shot and then leave it in Base. It does not occupy the character block. If you are not sure whether it is an individual or a group, treat it as a group.");
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');

      // 编人名是有毒的:name 会随 <characters> 落进正文,而 cleanHistoryText 保留
      // bbi_image,下一楼原样读回——一个假人名与真档案无法区分,会被误建档。
      expect(text).toContain("· 【 one-time 】 The text only gives references to one-time characters with no setting and no continuous participation in the plot - no file creation, no writing changes, no entry into the library. This type of ** can be included in the picture as usual **: when selecting the picture, write him a character block that is only valid for this picture according to the back-end specifications. name uses the original referential word in the text, and completes the appearance in one go according to the world view. Never make up a name for him.");
      expect(text).toContain('Never invent a personal name for them');

      // Name consistency 原本是普世律,模型把「没有真名」读成「没有合法名」。
      // 它的全部目的是保护逐字匹配,而一次性角色不参与任何匹配,故必须限定作用域。
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');

      // 人数按取景框算;缺档不能成为裁掉核心互动参与者的理由。
      expect(text).toContain('number of people visible inside this frame');
      expect(text).toContain('a missing profile is never a reason to reject a moment or crop that participant out');

      // C 段连坐:名单放宽后,不排除【一次性】会让模型给一次性对手维护服装时间线——
      // 白烧 token,更糟的是强化「他是正经角色」的暗示,反过来诱发建档。
      expect(text).toContain("- 【 one-time character 】 does not occupy a line in this section: he does not have a clothing ledger that continues across pictures. The clothes can be written once in the character block of the picture where he is selected (when he is included in two pictures on the same floor, they will remain consistent). Maintaining a timeline for him is useless, and will also mislead you into setting up a profile for him as an official character.");

      // 示例本身曾是反面教材:Base 写 2girls 却只给一条 Character Prompt,
      // 正好演示了「另一个人没有落位」。示例必须演示要求的行为。
      expect(text).toContain("- Read through the text of the target and list **all** characters who are actually present one by one - both named and surnamed (third-year captain, shopkeeper). Do not just look at the people in the final selected picture, and do not omit the characters for whom the World Info, character card or BaiBai Book have been set. What counts is \"who is present\", not \"who has files\".");
      expect(text).not.toContain('"tag":"2girls, classroom, sunset, medium shot"');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 只验证规则装配;实际取景是否突出主要角色仍需用剧情实跑。
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
        const thinking = messages.find(m => m.content.includes('Consideration Checklist before Output'))!.content;
        const spec = messages.find(m => m.content.startsWith('[NovelAI'))!.content;
        const selection = thinking.split('E. Excerpt\n')[1].split('Second layer')[0];

        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("6. Only select pictures for the \"target text\" and do not add pictures to the previous context. Priority should be given to showing the expressions, status, actions, and relationships of the player protagonist and the main character in the main text; the same is true for the main character appearing alone. The player is not required to appear in every picture, and no one who is not present is allowed to be added to the picture. Without losing the main content and core interaction, give priority to compositions without irrelevant characters, and do not actively join passers-by or crowds just to join in the fun. The main characters are judged based on the setting and plot, and are not equivalent to all registered characters.");
        expect(contract).toContain("- **The qualifications for setting up a profile and the qualifications for drawing are two different things**: Not setting up a profile only means that he will not be included in the character library, but it does not mean that he cannot be included in the drawing; having established a profile does not mean that he must be included in the drawing. First, frame the picture according to the main body and core interaction, and then write the appearance of the person in the shot. Do not decide based on the file status. If the unnamed character is a participant in the core interaction, he or she should be included in the frame as usual. The frame should not be discarded, the moment should be changed, or the character should be cut out just because of the lack of files. His mere presence does not constitute a reason to be included in the frame, and those who are not present can remain outside the frame.");
        expect(contract).toContain('Anonymous crowds visible in the frame remain in Base');
        expect(selection).toContain("- Give priority to the pictures that highlight the player's protagonist or main characters. The highlights are their expressions, status, actions and relationships. They are not required to be in the same frame in each picture. Candidates are not given points based on whether they have files or names.");
        expect(selection).toContain("- Give priority to the pictures that highlight the player's protagonist or main characters. The highlights are their expressions, status, actions and relationships. They are not required to be in the same frame in each picture. Candidates are not given points based on whether they have files or names.");
        expect(selection).toContain("- First determine the main subject and core interaction to be highlighted in this picture, and then decide who will be in the shot. On the premise of not losing these contents, priority is given to compositions without irrelevant people present; necessary nameless interactive objects are retained as usual, and the core action is not cut off for one less person. The crowd also does not have to be included in the painting just because it is mentioned in the text. If the crowd itself carries the core interaction, it will be retained.");
        expect(selection).toContain("- First determine the main subject and core interaction to be highlighted in this picture, and then decide who will be in the shot. On the premise of not losing these contents, priority is given to compositions without irrelevant people present; necessary nameless interactive objects are retained as usual, and the core action is not cut off for one less person. The crowd also does not have to be included in the painting just because it is mentioned in the text. If the crowd itself carries the core interaction, it will be retained.");
        expect(thinking).toContain("- The inventory list is not a list of entries: it is listed here to check the presence facts and create files. Who is included in the shot is determined by the E segment based on the subject and core interaction. 【 one-time 】 will not be excluded due to missing profiles, and no character must be included in the shot just because he is present or has been profiled. The main text treats a group of people as a whole (crowd, soldiers, onlookers), just line them up as a \"crowd\"; select the shot and then leave it in Base. It does not occupy the character block. If you are not sure whether it is an individual or a group, treat it as a group.");
        expect(thinking).toContain("■ P <Number>｜<Character name or text reference> (Write one block for each individual character visible in this picture; for 【 one-time 】 characters, use the original reference word in the text as the block name)");
        expect(thinking).toContain("- Each character present can choose one of three: point out the entry with the same name in the 【 character's fixed appearance library 】, field: \"new\" in changes, or mark 【 as a one-time 】 (do not write if you do not create a file) changes, only add appearance in his own character block when drawing); the detailed settings in the World Info cannot replace the creation of files. Every field:\"new\" profile of hair has both hair color and length/hairstyle, and eyes has eye color. The 【 one-off 】 character was not written into changes - it would have been a mistake. The permanently changed P number is legal, and the temporary status has not been mistakenly written into changes.");
        expect(thinking).toContain("core interaction is not destroyed in order to reduce the number of people");
        expect(thinking).not.toContain("Character rows (one row for each character present): <character name>｜expression｜line of sight｜clothing visible in this shot｜temporary status｜personal actions");
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

  // 思维链要求填景别/环境光/size,V5 规范里原本没有任何判据——模型只能瞎猜。
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
      // 表情词表与另两份对齐:思维链是白名单制(规范没列的一律不许用),
      // 少列一个词等于禁用一个词。
      expect(text).toContain('smile, grin, laughing, blush');
      expect(text).toContain('crying, tears, angry');
      expect(text).toContain('worried, scared, smug');
      expect(text).toContain('open mouth, clenched teeth');
      // d46ae82 的地形修复此前从未覆盖 V5 路径。
      expect(text).toContain('never add muddy ground, dirt path, wetland, puddles');
      expect(text).toContain('Orientation (the size key)');
      expect(text).toContain('When unsure, write portrait');
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 原版 NAI4 的 char_captions 恒为空(nai.ts),协议形态与 ComfyUI 一样是单条 tag 串,
  // 一样需要邻接绑定——但 NAI 规范里此前一条多人规则、一个示例都没有。
  // (4.5 起走 Character Prompts 分支,归属另一份规范,不适用邻接绑定。)
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
      // 示例是规则的靠山:只有条文没有示例时模型照抄不到写法。
      expect(text).toContain("Multiplayer tag example (see the writing method according to the above rules):");
      // NAI 不吃 ComfyUI 的权重括号转义,那条不该跟着复制过来。
      expect(text).not.toContain('ComfyUI 会把未转义圆括号当作权重语法');
      // 排序统一到「构图紧跟人数」口径:与 Comfy 一致,也与多人规则原文一致;
      // 旧的「镜头构图放末尾」排序表和示例曾与此自相矛盾。
      expect(text).toContain("Arranged from most important to less important: Number of people/subjects → Shot composition → Appearance → Clothing → Action posture → Expression and sight → Scene → Light atmosphere; a single picture is controlled within 40 and tag.");
      expect(text).not.toContain('场景 → 光线氛围 → 镜头构图');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // 视线词表笔误:eyes closed 是 closed eyes 的别名,同 tag 两种词序不该并列。
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

    // 示例改用实际外貌串;@占位符已撤回(见 charAnchors.ts 文件头)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系统会替换成库中最新 tag'))).toBe(false);
    // 照抄库中字段 + 一张图只写一遍,是本次回退的两条核心措辞
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

    // 档案会在之后每张图被照抄,姿势/场景混进字段会让角色永远保持那个姿势
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
      // Base 的全局性对 tag 与 nl 同样成立:实跑里模型把单角色的制服/体型写进 Base nl,
      // 与角色 nl 重复——旧文本只把禁令写在 tag 层面。
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // 建档 nl 只写固定外貌:临时服装进了永久档案的 nl,会跟着之后每楼走。
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 表情/视线此前在三个后端规范里都没有位置,思维链槽位填了也会在转 tag 时丢掉。
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
        // 首轮实跑漏出 gentle smile / shy expression / neutral curious expression
        // 这类非 danbooru 词组:槽位填对了,转 tag 时原样直译。规范里要给限定词表。
        expect(spec?.content).toContain("Expressions and gaze must be written in every picture and cannot be omitted, and must use standard danbooru words recognized by the model. No self-created descriptive phrases are allowed:");
        expect(spec?.content).toContain("- It is forbidden to literally translate the Chinese description in thinking into tag: gentle smile writes smile, shy expression writes blush, neutral curious expression This phrase model is completely unfamiliar and will only waste token and dilute the rest. tag. The natural language feeling with adjectives is left to nl, and tag only puts standard words.");
        expect(spec?.content).toContain('puffy cheeks');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      settings.nai.model = oldModel;
    }
  });

  // 同一轮实跑里 P11 两人各自的 looking at another 被合并成一个裸 tag,
  // petite / black pantyhose 也脱离了 on green hair girl 绑定。
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
      // 规则没有示例撑腰就是空话:实跑里模型照着示例串抄结构,petite/loli 仍然裸写。
      expect(spec?.content).toContain('petite on silver hair girl');
      // 发色瞳色是绑定锚点,裸列才对——不能被上一条误伤成 black hair on black hair girl。
      expect(spec?.content).toContain("- Body shape words (petite, tall, muscular, etc.) are not anchors and must be bound to specific characters. Do not write them naked: write \"petite on silver hair girl\" and do not let petite float in the string - the floating body shape words will be spread by the model to everyone in the same frame. Hair color and eye color themselves are the anchor points used to identify the character. They can be displayed naked as usual and do not need (and cannot) be bound to themselves.");
      // 瘦身时删掉「不许退回笼统词」当轮就复发:tag 里裸写 school uniform +
      // black opaque pantyhose,男孩的 white shirt/dark pants 干脆没进 tag。
      expect(spec?.content).toContain("- Clothes of the same type and different styles must be bound together, and cannot be lumped together with a general name: when two people wear school uniforms but the male and female styles are different, write \"dark pleated skirt on green hair girl, black opaque pantyhose on green hair girl, white shirt on black hair boy, dark trousers on black hair boy\", you must not just write one bare school uniform - That would let the model put the skirt on the boy, or simply design a random suit for each of them. In the same way, parts such as pantyhose and blazer that can only be worn by one person must also be brought with the owner.");
      expect(spec?.content).toContain('dark pleated skirt on green hair girl');
      expect(spec?.content).toContain('white shirt on black hair boy');
      expect(spec?.content).toContain("let the model put the skirt on the boy");
      // 示例串要真的示范绑定写法,否则模型照着旧示例抄裸 tag。
      expect(spec?.content).toContain('black hair girl smile, black hair girl looking at viewer');
      expect(spec?.content).toContain('silver hair girl blush, silver hair girl looking away');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  // 槽位本身也要挡住中文描述,否则先漏进槽位再漏进 tag。
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
    const thinkingMsg = messages.find(m => m.content.includes("Consideration Checklist before Output"));
    expect(thinkingMsg?.content).toContain("- For expressions and gaze, fill in the standard danbooru words given in the back-end specification. If you don't write Chinese feelings or create your own phrases (if you want to write \"gently smile\", just fill in smile); you can only choose from the words listed in the specification. Words not listed in the specification are not allowed to be used. If you are not sure, fill in expressionless / looking at another. Neither item should be left blank, and expressionless must be filled in even if you have no expression on your face. Each person in the multi-player screen will fill in one copy, and they will be bound when they enter tag. They cannot be merged or written naked - the naked expression will only fall on one person, and the other person will become the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expressions and gaze, fill in the standard danbooru words given in the back-end specification. If you don't write Chinese feelings or create your own phrases (if you want to write \"gently smile\", just fill in smile); you can only choose from the words listed in the specification. Words not listed in the specification are not allowed to be used. If you are not sure, fill in expressionless / looking at another. Neither item should be left blank, and expressionless must be filled in even if you have no expression on your face. Each person in the multi-player screen will fill in one copy, and they will be bound when they enter tag. They cannot be merged or written naked - the naked expression will only fall on one person, and the other person will become the default wooden face.");
    expect(thinkingMsg?.content).toContain("- For expressions and gaze, fill in the standard danbooru words given in the back-end specification. If you don't write Chinese feelings or create your own phrases (if you want to write \"gently smile\", just fill in smile); you can only choose from the words listed in the specification. Words not listed in the specification are not allowed to be used. If you are not sure, fill in expressionless / looking at another. Neither item should be left blank, and expressionless must be filled in even if you have no expression on your face. Each person in the multi-player screen will fill in one copy, and they will be bound when they enter tag. They cannot be merged or written naked - the naked expression will only fall on one person, and the other person will become the default wooden face.");
    // 连着两轮实跑都没照抄 ■ 格式,但七个槽位一项没漏——防漏的目的已达成,
    // 形状不是目的。故意不钉「■ 单独成行」这类形态断言,只钉槽位齐全。
    expect(thinkingMsg?.content).toContain("Write one piece for each picture, and write the value for each slot below. The writing style is up to you, but none of the seven slots must be missing - missing any one will make the final tag missing a piece.");
    // 摇摆的可执行判据:抽象的「别反复权衡」模型每次都觉得自己没在权衡。
    expect(thinkingMsg?.content).toContain("Only write the conclusion throughout the whole process, not the deduction process: thinking is a draft for you to clarify the facts, not the process of answering questions. Each judgment is determined once - the same field is only allowed to have one value in the entire <thinking>. Do not ask yourself \"A? Or B?\", do not propose candidates and then reject them one by one, do not overturn the determined fields and re-select, and do not pre-write the final tag/nl string. If there is insufficient evidence, make a decision directly based on the broad outlines of this list and the back-end specifications (size is not allowed to be written as portrait, and if the details of the clothing are unknown, just choose a common and self-consistent one), and then move on.");
    // 不写推演过程的约束保留,但不设字数硬上限——上限会逼着模型为多图多人场景压缩建档判断。
    expect(thinkingMsg?.content).not.toContain("【 Complete the draft in one pass·The iron rule 】 Only write one conclusion and ≤2 sentences in each step; both the judgment and the editing will decide on the first tenable answer, leaving the \"selection\" to the quality self-inspection. 【 prohibits 】 from listing multiple alternative shots (without writing \"A better idea is.../or.../from another angle...\" etc.), 【 prohibits 】 from overturning and starting over, and 【 prohibits 】 from rereading the plot and weighing it repeatedly. The whole paragraph of thinking is about ≤800 words. After writing, output </arc_think> immediately without further writing.");
    expect(thinkingMsg?.content).toContain("- Specifically prohibit these three ways of writing: self-questions with question marks (\"landscape?\" \"Use blush?\"), parallel candidates (\"expressionless or slight smile\"), and overthrowing after writing (\"Use A...but B is better, change A to B\"). Write the conclusion directly after comparing in your mind, and keep the comparison process in your mind. If there is insufficient evidence, just make the decision according to the bottom line (size, if you are not sure, write portrait, if the details of the clothing are unknown, just choose a common and self-consistent one), and then move on.");
    expect(thinkingMsg?.content).toContain("- Specifically prohibit these three ways of writing: self-questions with question marks (\"landscape?\" \"Use blush?\"), parallel candidates (\"expressionless or slight smile\"), and overthrowing after writing (\"Use A...but B is better, change A to B\"). Write the conclusion directly after comparing in your mind, and keep the comparison process in your mind. If there is insufficient evidence, just make the decision according to the bottom line (size, if you are not sure, write portrait, if the details of the clothing are unknown, just choose a common and self-consistent one), and then move on.");
    // 第三层曾自称「落成 tag」,与「不要预写 tag 串」直接打架,实跑里 tag 被写了四遍。
    expect(thinkingMsg?.content).toContain("Self-check before writing");
    // 上一版只禁「完整 tag/nl 串」,模型钻空子改成在 thinking 里预写整个 JSON 对象
    // (末尾一句 "JSON:" 加一份完整答案),白烧约 800 token。措辞要覆盖 JSON 本身。
    expect(thinkingMsg?.content).toContain("At this level, just check the following items one by one and write a conclusion for each point. No drafts of the final answer are allowed in <thinking> - no complete tag string, no complete nl sentence, no JSON object or a title like \"JSON:\". The answer only appears once after </thinking>. Writing it first in thinking is equivalent to paying for the entire output twice. After checking, directly close </thinking> and output JSON:");
    expect(thinkingMsg?.content).toContain("At this level, just check the following items one by one and write a conclusion for each point. No drafts of the final answer are allowed in <thinking> - no complete tag string, no complete nl sentence, no JSON object or a title like \"JSON:\". The answer only appears once after </thinking>. Writing it first in thinking is equivalent to paying for the entire output twice. After checking, directly close </thinking> and output JSON:");
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
    // 工作流改由「当前预设」承载(见 settings.ts 工作流库);默认值恒有一条,直接改它
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
      // 实跑里模型给下雨的正文配了 "negative":"rain, umbrella",反而抵消了 tag 的 wet asphalt。
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      // 复发一次:nl 自己写了 drizzle,negative 仍填 rain。禁令必须覆盖「否定自己刚写的内容」。
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
      expect(messages.some(message => message.content.includes("\n negative is special for this picture. danbooru Negative short words tag: Only exclude content that conflicts with the main text or this composition is particularly easy to be mistakenly generated. It can be empty; it is prohibited to output general quality, picture quality, aesthetic or technical negative words, including but not limited to worst quality, low quality, blurry, lowres, bad anatomy, bad hands, jpeg artifacts; Do not write what you wish to appear and do not use the @role placeholder. \n negative must not contain facts that have been clearly established in the main text, nor can you deny anything you have just written into this picture tag/nl: if the main text says it is raining, or if your own nl writes drizzle, you must never write rain in negative; if you write that the character wears glasses, you are not allowed to write glasses – That’s erasing what should be in the picture. After writing negative, look back word by word at tag and nl in this picture, and delete any words whose corresponding content can be found in them. Leave it blank when in doubt. An empty negative is always safer than an negative that offsets the text."))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
    }
  });

  it('简易模式的动态负面词门槛由模板决定:checkpoint/anima 请求,flux 不请求', async () => {
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

describe('自然语言条件段 expandNlSections', () => {
  it('{{#nl}} 段只在开启时保留,{{^nl}} 段只在关闭时保留', () => {
    const text = 'A{{#nl}}-on{{/nl}}{{^nl}}-off{{/nl}}B';
    expect(expandNlSections(text, true)).toBe('A-onB');
    expect(expandNlSections(text, false)).toBe('A-offB');
  });

  it('段内可以跨行;没有条件段的文本原样返回(整段替换的 {{nl}} 宏不归它管)', () => {
    const text = 'x{{#nl}}\n第一行\n第二行\n{{/nl}}y';
    expect(expandNlSections(text, true)).toBe('x\n第一行\n第二行\ny');
    expect(expandNlSections(text, false)).toBe('xy');
    expect(expandNlSections('plain {{nl}} text', false)).toBe('plain {{nl}} text');
  });

  it('配不上对的标记原样留着,不吞掉后文', () => {
    // 写错了在请求历史里看得见;静默吞掉的话,漏闭合会把后面整份规范一起删光
    expect(expandNlSections('a{{#nl}}b', false)).toBe('a{{#nl}}b');
    expect(expandNlSections('a{{/nl}}b', true)).toBe('a{{/nl}}b');
  });

  // 内置文本里的标记一旦写错(漏闭合、错拼),整段会连标记带内容原样漏给模型
  it.each([true, false])('内置 NAI 规范与思维链展开后不留任何标记(nl=%s)', nlOn => {
    for (const text of [DEFAULT_NAI_V5_SPEC, DEFAULT_NAI_V5_THINKING]) {
      expect(expandNlSections(text, nlOn)).not.toMatch(/\{\{[#^/]nl\}\}/);
    }
  });
});

// NAI 4.5 的提示词 token 上限比 V5 紧,自然语言是最占预算的部分 —— 这是开关的由来。
// 口径与 ComfyUI 那个开关相同:只管 AI 写不写,已写进正文的 nl 照常发送。
describe('NAI「生成自然语言」开关与渠道画幅锁', () => {
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

  /** 每条用例都会拨后端与开关:进来时快照,出去时原样放回(settings 是模块级单例)。 */
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
  const THINKING_MARK = "Consideration Checklist before Output";

  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    '关掉后 %s 的协议、规范、思维链整套切成纯 tag;拨回开启即恢复',
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

        // 示例 JSON 里一个 nl 键都不留:模型照抄示例的倾向比照读规则强得多
        expect(contract).not.toContain('"nl"');
        expect(contract).toContain('"characters":[{"name":"小雪"');
        expect(contract).toContain('This output is tag-only');
        expect(contract).toContain('name and tag are both required');
        // 建档也不再要 nl —— runner 验收同一口径(profile.nl),否则会为不存在的要求白耗重试
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // 规范第 6 条整条换成 tag-only 版本(编号不动),示例与条目形状同步去掉 nl
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain("only tag is written");
        expect(thinking).not.toContain("do not write the complete nl sentence");
        // 多角色提示词本身不受开关影响:关的只是 nl,characters[] 照样要
        expect(thinking).toContain('characters[]');

        settings.nai.naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain("do not write the complete nl sentence");
        expect(on).not.toContain('This output is tag-only');
        expect(on).not.toContain("only tag is written");
      } finally {
        state.restore();
      }
    },
  );

  it('自定义规范与思维链同样按开关展开条件段(两个后端各认各的开关)', async () => {
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
      // ComfyUI 那份开着也不该影响 NAI
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

  // 只锁出图不改协议的话,模型照样按横竖判据取景:锁竖时为群像构思宽画面,出图却是竖的
  it('NAI 锁横屏:协议改口为每张都填 landscape,示例同步,不再给选向兜底', async () => {
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

  it('ComfyUI 锁看当前工作流那份;NAI 的锁不串过来', async () => {
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

  it('autoTagProfile:按当前后端与其开关算一次,写协议与 runner 验收共用这一份', () => {
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

      // 单串分支(NAI4)的协议本来就不写 nl,开关对它不起作用
      settings.nai.model = 'nai-diffusion-4-full';
      settings.nai.naturalLanguage = true;
      expect(autoTagProfile()).toMatchObject({ naiCharPrompts: false, nl: false });

      // ComfyUI:自然语言与画幅锁都取当前工作流
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
