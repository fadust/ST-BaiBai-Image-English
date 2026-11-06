import { CHAR_TAG_FIELDS, CHAR_TAG_FIELD_LABELS, charFieldsEmpty, type CharTagField } from '@/state/charTags';



export type CharCopyKey = CharTagField | 'raw' | 'nl';

export interface CharCopySource {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

export interface CharPasteResult {

  values: Partial<Record<CharCopyKey, string>>;

  name?: string;
}

const RAW_LABEL = 'Full tag string';
const NL_LABEL = 'Appearance description';
const NAME_LABEL = 'Character';

const INSTRUCTION =
  'Compare this character profile with the reference image. Correct visible discrepancies and fill in details supported by the image. ' +
  'Keep one [Field] value per line and preserve the field labels and character name. Use comma-separated English Danbooru tags in tag fields; write None to clear a field. ' +
  'Write the appearance description as coherent English prose. Return only the revised profile, without explanations or before/after comparisons.';

function labelOf(key: CharCopyKey): string {
  if (key === 'raw') return RAW_LABEL;
  if (key === 'nl') return NL_LABEL;
  return CHAR_TAG_FIELD_LABELS[key];
}

export function formatCharForCopy(source: CharCopySource): string {
  const lines = [INSTRUCTION, '', `[${NAME_LABEL}] ${source.name.trim()}`];

  const rawMode = !!source.raw.trim() && charFieldsEmpty(source.fields);
  const keys: CharCopyKey[] = rawMode ? ['raw', 'nl'] : [...CHAR_TAG_FIELDS, 'nl'];
  for (const key of keys) {
    const value = key === 'raw' ? source.raw : key === 'nl' ? source.nl : source.fields[key];
    lines.push(`[${labelOf(key)}] ${value.trim() || 'None'}`);
  }
  return lines.join('\n');
}




const ALIASES: Record<CharCopyKey | 'name', string[]> = {
  name: ['角色', '角色名', '名字', '姓名', 'name', 'character'],
  fandom: ['同人身份', '同人', '同人身份标签', '作品', 'fandom', 'copyright'],
  sex: ['性别', 'sex', 'gender'],
  hair: ['头发', '发型', '发色', '发型发色', 'hair'],
  eyes: ['眼睛', '眼', '眼睛颜色', '瞳色', '瞳孔', 'eyes', 'eye'],
  skin: ['肤色', '皮肤', 'skin'],
  body: ['Build', '体型', '身材', '体形', 'body'],
  bust: ['胸部', '胸', '罩杯', '胸部大小', 'bust', 'breasts', 'chest'],
  extra: ['Distinctive features', '标志特征', '特征', '其他特征', '特殊特征', 'extra', 'features'],
  outfit: ['Signature outfit', '固定着装', '着装', '服装', '衣着', '穿着', 'outfit', 'clothes', 'clothing'],
  raw: ['Full tag string', '整串', '整串标签', 'raw'],
  nl: ['Appearance description', '自然语言外貌', '自然语言', '自然语言描述', '外貌描述', '外貌', 'nl', 'naturallanguage', 'description'],
};

function normLabel(label: string): string {
  return label
    .replace(/[\s*_`'"“”‘’]/g, '')
    .toLowerCase()
    .replace(/tags?|标签/g, '')
    .replace(/[（(].*?[）)]$/, '');
}

const LABEL_LOOKUP = new Map<string, CharCopyKey | 'name'>();
for (const [key, names] of Object.entries(ALIASES) as [CharCopyKey | 'name', string[]][]) {
  for (const n of names) LABEL_LOOKUP.set(normLabel(n), key);
}

for (const f of CHAR_TAG_FIELDS) LABEL_LOOKUP.set(normLabel(CHAR_TAG_FIELD_LABELS[f]), f);

function lookupLabel(label: string): CharCopyKey | 'name' | undefined {
  const n = normLabel(label);
  return n ? LABEL_LOOKUP.get(n) : undefined;
}

const EMPTY_VALUE = /^(?:无|没有|空|留空|不填|暂无|无需|none|null|n\/?a|nil|empty|-+|—+|\/)$/i;

interface LabeledLine {

  key: CharCopyKey | 'name' | undefined;
  value: string;
}


function matchLabeled(line: string): LabeledLine | null {

  const s = line.replace(/^\s*(?:[-*+•·>]+|#+|\d+[.)、])\s*/, '').trim();
  if (!s) return null;

  if (s.startsWith('|')) {
    const cells = s.split('|').map(c => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    if (cells.length < 2 || cells.every(c => /^:?-+:?$/.test(c))) return { key: undefined, value: '' };
    const key = lookupLabel(cells[0]!);
    return key ? { key, value: cells.slice(1).join(', ') } : { key: undefined, value: '' };
  }

  const bracket = /^\*{0,2}[【\[［「〔]([^】\]］」〕]{1,64})[】\]］」〕]\*{0,2}\s*[:：]?\s*(.*)$/.exec(s);
  if (bracket) return { key: lookupLabel(bracket[1]!), value: bracket[2]! };

  const bold = /^\*\*([^*]{1,64}?)\s*[:：]?\s*\*\*\s*[:：]?\s*(.*)$/.exec(s);
  if (bold) return { key: lookupLabel(bold[1]!), value: bold[2]! };

  const bare = /^([^:：]{1,64}?)\s*[:：]\s*(.*)$/.exec(s);
  if (bare) {
    const key = lookupLabel(bare[1]!);
    if (key) return { key, value: bare[2]! };
  }
  return null;
}

function cleanPiece(value: string): string {
  let v = value.trim();

  const arrow = v.split(/\s*(?:→|->|=>|⟶)\s*/);
  if (arrow.length > 1) v = arrow[arrow.length - 1]!;
  return v
    .replace(/^\*+|\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^["“'‘]|["”'’]$/g, '')
    .trim();
}

function finishTags(parts: string[]): string {
  const tags = parts
    .join(',')
    .split(/[,，、;；\n]/)
    .map(t => cleanPiece(t).replace(/[。.]+$/, '').trim())
    .filter(Boolean);
  if (tags.length === 1 && EMPTY_VALUE.test(tags[0]!)) return '';
  return tags.filter(t => !EMPTY_VALUE.test(t)).join(', ');
}

function finishText(parts: string[]): string {
  const text = parts.map(cleanPiece).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return EMPTY_VALUE.test(text) ? '' : text;
}

export function parseCharPaste(text: string): CharPasteResult {
  const result: CharPasteResult = { values: {} };
  let current: CharCopyKey | 'name' | undefined;
  let parts: string[] = [];

  const flush = () => {
    if (current === 'name') {
      const name = finishText(parts);
      if (name) result.name = name;
    } else if (current) {
      result.values[current] = current === 'nl' ? finishText(parts) : finishTags(parts);
    }
    current = undefined;
    parts = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) continue;
    if (!line.trim()) {

      flush();
      continue;
    }
    const labeled = matchLabeled(line);
    if (labeled) {
      flush();
      current = labeled.key;
      if (current) parts.push(labeled.value);
      continue;
    }
    if (current) parts.push(line);
  }
  flush();
  return result;
}

export function pasteKeyLabel(key: CharCopyKey): string {
  return labelOf(key);
}
