import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  containsTagMarkup,
  ensureImageTagRegexRegistered,
  formatPromptText,
  hasImageTagTrace,
  IMAGE_TAG_HIDE_REGEX_ID,
  IMAGE_TAG_SLOT_REGEX_ID,
  imageTagHideScript,
  imageTagSlotScript,
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  stripImageTags,
} from '@/st/imageTagRegex';

const SLOT_DIV = '<div data-bbi-slot=""></div>';

function regexFromLiteral(literal: string): RegExp {
  const match = literal.match(/^\/(.*)\/([a-z]*)$/i);
  if (!match) throw new Error('invalid regex literal');
  return new RegExp(match[1], match[2]);
}

afterEach(() => vi.unstubAllGlobals());

describe('display-side slot script (markdownOnly)', () => {
  it('replaces each complete tag block with an empty slot anchor', () => {
    const script = imageTagSlotScript();
    expect(script.markdownOnly).toBe(true);
    expect(script.promptOnly).toBe(false);
    expect(script.placement).toEqual([1, 2, 3]);
    expect(script.id).toBe(IMAGE_TAG_SLOT_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<bbi_image>1girl,\nmoonlight</bbi_image>\n正文后'.replace(regex, script.replaceString),
    ).toBe(`正文前\n${SLOT_DIV}\n正文后`);
  });

  it('handles multiple tags without swallowing text between them', () => {
    const script = imageTagSlotScript();
    const regex = regexFromLiteral(script.findRegex);
    expect(
      '<bbi_image>first</bbi_image>中间正文<bbi_image>second</bbi_image>'.replace(
        regex,
        script.replaceString,
      ),
    ).toBe(`${SLOT_DIV}中间正文${SLOT_DIV}`);
  });
});

describe('prompt-side hide script (promptOnly)', () => {
  it('removes the complete tag block from prompts', () => {
    const script = imageTagHideScript();
    expect(script.markdownOnly).toBe(false);
    expect(script.promptOnly).toBe(true);
    expect(script.placement).toEqual([1, 2, 3]);
    expect(script.id).toBe(IMAGE_TAG_HIDE_REGEX_ID);

    const regex = regexFromLiteral(script.findRegex);
    expect(
      '正文前\n<bbi_image>1girl,\nmoonlight</bbi_image>\n正文后'.replace(regex, script.replaceString),
    ).toBe('正文前\n\n正文后');
  });

  it('shares the same find pattern as the slot script', () => {
    expect(imageTagSlotScript().findRegex).toBe(imageTagHideScript().findRegex);
  });
});

describe('placement covers narrator floors (regression lock)', () => {
  /**
   * Why this lock must spell out its reason: narrator floors (`/narrator`, `/sys`) are `is_system:false` +
   * `extra.type:'narrator'`; st/context.ts's isAiStoryMessage **counts them as story floors**, and
   * auto-tag writes tags into them; but script.js's getRegexPlacement assigns such floors
   * SLASH_COMMAND(3), not AI_OUTPUT(2). Without this 3, the anchor regex never matches at all:
   * the raw tag text shows as body text, and there is no anchor to hang a card on.
   *
   * Asserting only `[1,2,3]` wouldn't show the cost to someone later "trimming unused placements";
   * this test says which kind of floor 3 corresponds to.
   */
  const PLACEMENT_BY_MESSAGE_KIND = {
    user: 1,
    ai: 2,
    narrator: 3,
  } as const;

  it('both scripts cover user, ai and narrator display placements', () => {
    for (const script of [imageTagSlotScript(), imageTagHideScript()]) {
      for (const [kind, placement] of Object.entries(PLACEMENT_BY_MESSAGE_KIND)) {
        expect(script.placement, `${script.id} 漏了 ${kind} 楼`).toContain(placement);
      }
    }
  });

  it('never covers the deprecated MD_DISPLAY placement', () => {
    // 0 is deprecated by ST, and regex/index.js rewrites rules containing 0 into "all placements",
    // which would make the placeholder rule run on the lorebook (5)/thought chain (6).
    expect(imageTagSlotScript().placement).not.toContain(0);
    expect(imageTagHideScript().placement).not.toContain(0);
  });
});

describe('parseImageTags', () => {
  it('returns tags in document order, preserving raw text', () => {
    expect(parseImageTags('a<bbi_image>one</bbi_image>b<bbi_image>two,\nlines</bbi_image>c')).toEqual([
      '<bbi_image>one</bbi_image>',
      '<bbi_image>two,\nlines</bbi_image>',
    ]);
  });

  it('returns an empty array when there are no tags', () => {
    expect(parseImageTags('没有生图标签的正文')).toEqual([]);
  });
});

describe('hasImageTagTrace', () => {
  it('sees complete tags', () => {
    expect(hasImageTagTrace('场景\n<bbi_image>1girl</bbi_image>')).toBe(true);
  });

  it('sees a lone closing tag — the case that used to make the button a no-op', () => {
    // The button layer once used /<bbi_image\b/ (open tags only) → judged "no tag", showed no confirmation, passed replace=false;
    // the runner layer recognised both open and close → judged "has tag" and silently gave up. With both sharing a source, such floors can be regenerated.
    expect(hasImageTagTrace('模型学着上下文写了半截 </bbi_image>')).toBe(true);
  });

  it('sees a lone opening tag and is case-insensitive', () => {
    expect(hasImageTagTrace('<BBI_Image>')).toBe(true);
  });

  it('is false for tag-free text and for a lookalike prefix', () => {
    expect(hasImageTagTrace('普通正文')).toBe(false);
    expect(hasImageTagTrace('<bbi_images>')).toBe(false);
  });
});

describe('stripImageTags', () => {
  it('removes plugin-injected tags together with their line break, restoring the original text', () => {
    expect(stripImageTags('第一行\n<bbi_image>1girl</bbi_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('removes multiple tags after the same line and tags with nl/size sub-tags', () => {
    expect(
      stripImageTags(
        '场景\n<bbi_image>1girl<nl>A girl.</nl><size>portrait</size></bbi_image>\n<bbi_image>2boy<size>landscape</size></bbi_image>\n结尾',
      ),
    ).toBe('场景\n结尾');
  });

  it('removes inline hand-written tags without touching surrounding text', () => {
    expect(stripImageTags('前文 <bbi_image>x</bbi_image> 后文')).toBe('前文  后文');
  });

  it('leaves tag-free text untouched and preserves CRLF', () => {
    expect(stripImageTags('没有\r\n标签')).toBe('没有\r\n标签');
  });

  it('also clears half-written orphan tags left after the pairs are gone', () => {
    // Leaving a lone <bbi_image> would let the non-greedy find regex eat from it to the next </bbi_image>,
    // swallowing the text in between along with the real tag after it; the debris deletes only itself, the real tag is deleted whole.
    expect(stripImageTags('第一行\n<bbi_image>\n第二行\n<bbi_image>1girl</bbi_image>\n第三行')).toBe(
      '第一行\n第二行\n第三行',
    );
    expect(stripImageTags('半截 </bbi_image> 残骸')).toBe('半截  残骸');
    expect(stripImageTags('第一行\n</bbi_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('clears an empty tag pair (the old pair regex required non-empty content and left it behind)', () => {
    expect(stripImageTags('第一行\n<bbi_image></bbi_image>\n第二行')).toBe('第一行\n第二行');
  });

  it('deletes the whole outer span when opening tags nest', () => {
    expect(stripImageTags('前\n<bbi_image>a<bbi_image>b</bbi_image></bbi_image>\n后')).toBe('前\n后');
  });
});

describe('parseImageTagContent', () => {
  it('treats bare content as the tag part (legacy format)', () => {
    expect(parseImageTagContent('<bbi_image>1girl, moonlight</bbi_image>')).toEqual({
      tag: '1girl, moonlight',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('splits bare tag text and a <nl> sub-tag (plugin standard form)', () => {
    expect(parseImageTagContent('<bbi_image>1girl<nl>A girl.</nl></bbi_image>')).toEqual({
      tag: '1girl',
      nl: 'A girl.',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('accepts explicit <tag> and <nl> sub-tags in any order', () => {
    expect(
      parseImageTagContent('<bbi_image><nl>A girl.\nShe smiles.</nl><tag>1girl</tag></bbi_image>'),
    ).toEqual({ tag: '1girl', nl: 'A girl. She smiles.', negative: '', characters: [], size: 'portrait' });
  });

  it('merges bare text with explicit <tag> content instead of dropping it', () => {
    expect(parseImageTagContent('<bbi_image>bare_tags<tag>explicit_tags</tag></bbi_image>')).toEqual({
      tag: 'bare_tags, explicit_tags',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('strips <size> out of the tag part instead of leaking it into the prompt', () => {
    // If not stripped, the word landscape would mix straight into the positive prompt
    expect(parseImageTagContent('<bbi_image>2girls, wide shot<size>landscape</size></bbi_image>')).toEqual(
      { tag: '2girls, wide shot', nl: '', negative: '', characters: [], size: 'landscape' },
    );
  });

  it('handles all three sub-tags together (full plugin form)', () => {
    expect(
      parseImageTagContent('<bbi_image>2girls<nl>Two girls.</nl><size>landscape</size></bbi_image>'),
    ).toEqual({ tag: '2girls', nl: 'Two girls.', negative: '', characters: [], size: 'landscape' });
  });

  it('extracts <negative> without leaking it into the positive tag', () => {
    expect(
      parseImageTagContent(
        '<bbi_image>1girl<negative>extra people,\nduplicate</negative><size>portrait</size></bbi_image>',
      ),
    ).toEqual({
      tag: '1girl',
      nl: '',
      negative: 'extra people, duplicate',
      characters: [],
      size: 'portrait',
    });
  });


  it('parses V5 character prompts without leaking JSON into Base tag', () => {
    const raw = '<bbi_image>2girls, classroom<characters>[{"name":"A","tag":"girl, black hair","nl":"left"}]</characters><size>landscape</size></bbi_image>';
    expect(parseImageTagContent(raw)).toEqual({
      tag: '2girls, classroom',
      nl: '',
      negative: '',
      characters: [{ name: 'A', tag: 'girl, black hair', nl: 'left' }],
      size: 'landscape',
    });
  });

  it('ignores malformed character JSON while preserving the Base prompt', () => {
    expect(parseImageTagContent('<bbi_image>1girl<characters>{bad}</characters></bbi_image>')).toEqual({
      tag: '1girl',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
    });
  });

  it('falls back to portrait for legacy tags without <size>', () => {
    // Tags in existing text have no size and must keep the pre-change portrait behaviour
    expect(parseImageTagContent('<bbi_image>1girl</bbi_image>').size).toBe('portrait');
    expect(parseImageTagContent('<bbi_image>1girl<size>乱写</size></bbi_image>').size).toBe('portrait');
  });
});

describe('serializeImageTag', () => {
  it('writes every sub-tag when all fields are present', () => {
    expect(
      serializeImageTag({
        tag: '2girls, classroom',
        nl: 'Two girls talking.',
        negative: 'extra people',
        characters: [{ name: 'A', tag: 'girl, black hair', nl: 'left' }],
        size: 'landscape',
      }),
    ).toBe(
      '<bbi_image>2girls, classroom<nl>Two girls talking.</nl><negative>extra people</negative>' +
        '<characters>[{"name":"A","tag":"girl, black hair","nl":"left"}]</characters>' +
        '<size>landscape</size></bbi_image>',
    );
  });

  it('omits empty nl/negative/characters instead of writing empty sub-tags', () => {
    expect(
      serializeImageTag({ tag: '1girl', nl: '', negative: '', characters: [], size: 'portrait' }),
    ).toBe('<bbi_image>1girl<size>portrait</size></bbi_image>');
  });

  it('always writes <size> — generation is deferred, so orientation must persist in the text', () => {
    expect(
      serializeImageTag({ tag: '1girl', nl: '', negative: '', characters: [], size: 'landscape' }),
    ).toContain('<size>landscape</size>');
  });

  it('round-trips through parseImageTagContent byte-for-byte in canonical form', () => {
    // This locks down that "open the dialog, change nothing, save" doesn't switch promptHash buckets; if it did, all old images would turn stale.
    const canonical = [
      '<bbi_image>1girl<size>portrait</size></bbi_image>',
      '<bbi_image>2girls<nl>Two girls.</nl><size>landscape</size></bbi_image>',
      '<bbi_image>1girl<negative>extra people</negative><size>portrait</size></bbi_image>',
      '<bbi_image>2girls<characters>[{"name":"A","tag":"girl","nl":""}]</characters><size>landscape</size></bbi_image>',
    ];
    for (const raw of canonical) {
      expect(serializeImageTag(parseImageTagContent(raw))).toBe(raw);
    }
  });

  it('produces a form that parses back to the same fields', () => {
    const content = {
      tag: '1girl, smile',
      nl: 'A girl smiling.',
      negative: 'duplicate',
      characters: [{ name: '小雪', tag: 'girl, white hair', nl: 'right side' }],
      size: 'portrait' as const,
    };
    expect(parseImageTagContent(serializeImageTag(content))).toEqual(content);
  });
});

describe('formatPromptText', () => {
  it('joins the parts with blank lines in card order', () => {
    expect(
      formatPromptText({
        tag: '1girl, moonlight',
        nl: 'She stands on the roof.',
        negative: 'lowres',
        characters: [{ name: '顾晚', tag: 'black hair', nl: 'looking away' }],
      }),
    ).toBe(
      "1girl, moonlight\n\nShe stands on the roof.\n\nRole: 顾晚\nblack hair\nlooking away\n\nNegative: lowres",
    );
  });

  it('drops empty parts instead of leaving blank gaps', () => {
    expect(formatPromptText({ tag: '1girl', nl: '', negative: '', characters: [] })).toBe('1girl');
    expect(formatPromptText({ tag: '', nl: '', negative: '', characters: [] })).toBe('');
  });

  it('renders what parseImageTagContent produces (gallery reads tags this way)', () => {
    // The gallery only gets the raw tag text and relies on this chain to restore a display matching the card
    const raw = serializeImageTag({
      tag: '1girl',
      nl: 'night',
      negative: 'blurry',
      characters: [{ name: '顾晚', tag: 'black hair', nl: '' }],
      size: 'portrait',
    });
    expect(formatPromptText(parseImageTagContent(raw))).toBe(
      "1girl\n\nnight\n\nRole: 顾晚\nblack hair\n\nNegative: blurry",
    );
  });
});

describe('replaceImageTagAt', () => {
  const text = '一\n<bbi_image>first</bbi_image>\n二\n<bbi_image>second</bbi_image>\n三\n<bbi_image>third</bbi_image>\n四';
  const next = '<bbi_image>edited<size>portrait</size></bbi_image>';

  it('replaces the first tag and leaves everything else byte-identical', () => {
    expect(replaceImageTagAt(text, 0, next)).toBe(
      `一\n${next}\n二\n<bbi_image>second</bbi_image>\n三\n<bbi_image>third</bbi_image>\n四`,
    );
  });

  it('replaces a middle tag without touching its neighbours', () => {
    expect(replaceImageTagAt(text, 1, next)).toBe(
      `一\n<bbi_image>first</bbi_image>\n二\n${next}\n三\n<bbi_image>third</bbi_image>\n四`,
    );
  });

  it('replaces the last tag', () => {
    expect(replaceImageTagAt(text, 2, next)).toBe(
      `一\n<bbi_image>first</bbi_image>\n二\n<bbi_image>second</bbi_image>\n三\n${next}\n四`,
    );
  });

  it('returns null when seq is out of range or invalid', () => {
    expect(replaceImageTagAt(text, 3, next)).toBe(null);
    expect(replaceImageTagAt(text, -1, next)).toBe(null);
    expect(replaceImageTagAt(text, 1.5, next)).toBe(null);
    expect(replaceImageTagAt('没有标签的正文', 0, next)).toBe(null);
  });

  it('is not affected by a shared regex lastIndex across repeated calls', () => {
    // The module-level IMAGE_TAG_FIND_REGEX has /g and is stateful, so this function creates its regex locally; three calls in a row must give the same result
    expect(replaceImageTagAt(text, 0, next)).toBe(replaceImageTagAt(text, 0, next));
    expect(replaceImageTagAt(text, 2, next)).toBe(replaceImageTagAt(text, 2, next));
  });

  it('handles multi-line and inline tags on the same line', () => {
    expect(
      replaceImageTagAt('前 <bbi_image>a,\nb</bbi_image> 中 <bbi_image>c</bbi_image> 后', 1, next),
    ).toBe(`前 <bbi_image>a,\nb</bbi_image> 中 ${next} 后`);
  });
});

describe('containsTagMarkup', () => {
  it('catches sub-tag literals that would truncate the tag block', () => {
    // The find regex is non-greedy: a </bbi_image> mixed into the content would cut the tag off early, leaking the second half into the DOM and prompt
    expect(containsTagMarkup('1girl</bbi_image>后半截')).toBe(true);
    expect(containsTagMarkup('1girl<bbi_image>')).toBe(true);
    expect(containsTagMarkup('a<nl>b')).toBe(true);
    expect(containsTagMarkup('a</nl>')).toBe(true);
    expect(containsTagMarkup('a<negative>b')).toBe(true);
    expect(containsTagMarkup('a<characters>b')).toBe(true);
    expect(containsTagMarkup('a<size>b')).toBe(true);
    expect(containsTagMarkup('a<tag>b')).toBe(true);
  });

  it('leaves ordinary prompt text alone', () => {
    expect(containsTagMarkup('1girl, long black hair, (smile:1.2), <lora:foo:0.8>')).toBe(false);
    expect(containsTagMarkup('')).toBe(false);
    expect(containsTagMarkup('a < b, 2 > 1')).toBe(false);
  });
});

describe('managed bbi image-tag regex registration', () => {  it('registers both scripts once by fixed id and updates old managed rules', () => {
    const saveSettingsDebounced = vi.fn();
    const unrelated = { id: 'user-rule', scriptName: '用户规则' };
    const legacy = {
      id: IMAGE_TAG_HIDE_REGEX_ID,
      scriptName: '柏宝绘 · 隐藏生图标签',
      findRegex: '/old/g',
      markdownOnly: true,
      promptOnly: true,
      placement: [0, 1, 2],
      customField: 'preserved',
    };
    const extensionSettings: Record<string, unknown> = { regex: [unrelated, legacy] };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({ extensionSettings, saveSettingsDebounced }),
      },
    });

    expect(ensureImageTagRegexRegistered()).toBe(true);
    expect(ensureImageTagRegexRegistered()).toBe(true);
    const list = extensionSettings.regex as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(unrelated);

    // The old single hide rule is upgraded in place to the promptOnly version (no longer both on), keeping user fields
    const hide = list.find(s => s.id === IMAGE_TAG_HIDE_REGEX_ID);
    expect(hide).toMatchObject({
      scriptName: "BaiBai Image · Hidden Picture Tags",
      markdownOnly: false,
      promptOnly: true,
      placement: [1, 2, 3],
      customField: 'preserved',
    });

    // The slot rule is added, and appears only once
    const slots = list.filter(s => s.id === IMAGE_TAG_SLOT_REGEX_ID);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      scriptName: "BaiBai Image · Picture label placeholder",
      markdownOnly: true,
      promptOnly: false,
      placement: [1, 2, 3],
      replaceString: SLOT_DIV,
    });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
  });
});
