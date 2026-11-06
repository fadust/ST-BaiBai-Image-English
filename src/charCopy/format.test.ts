import { describe, expect, it } from 'vitest';
import { emptyCharFields } from '@/state/charTags';
import { formatCharForCopy, parseCharPaste } from './format';
describe('English appearance copy and paste', () => {
  const source = { name: '小雪', fields: { ...emptyCharFields(), hair: 'long black hair', bust: 'small breasts' }, raw: '', nl: 'An adult woman with long black hair.' };
  it('round-trips all exported English labels while preserving original names', () => {
    const copied = formatCharForCopy(source);
    expect(copied).toContain('[Appearance description]');
    expect(copied).toContain('[Distinctive features] None');
    expect(copied).toContain('[Character] 小雪');
    expect(parseCharPaste(copied)).toMatchObject({ name: '小雪', values: { ...source.fields, nl: source.nl } });
  });
  it('accepts revised English profiles in common AI response formats, leaving omitted fields untouched', () => {
    expect(parseCharPaste('**Hair:** short silver hair\n\n| Eyes | green eyes |\n| Bust | None |').values).toEqual({ hair: 'short silver hair', eyes: 'green eyes', bust: '' });
  });
  it('can still read donor profiles without translating stored names', () => {
    expect(parseCharPaste('【角色】小雪\n【头发】black hair').name).toBe('小雪');
  });
});
