import { describe, expect, it } from 'vitest';

import { buildEntryTag, emptyCharFields } from '@/state/charTags';

import { splitBust } from './split';

const f = (body: string, bust = '') => ({ ...emptyCharFields(), sex: '1girl', hair: 'long hair', body, bust });

describe('bust field migration', () => {
  it('moves size tags out of Build without changing the generated prompt', () => {
    const before = f('petite, small breasts');
    const after = splitBust(before);
    expect(after).toMatchObject({ body: 'petite', bust: 'small breasts' });
    expect(buildEntryTag({ fields: after, raw: '' })).toBe(buildEntryTag({ fields: before, raw: '' }));
  });

  it('keeps an explicit Bust value and removes duplicate size tags from Build', () => {
    expect(splitBust(f('slim, large breasts', 'medium breasts'))).toMatchObject({ body: 'slim', bust: 'medium breasts' });
  });

  it('leaves unrelated Build values unchanged', () => {
    const fields = f('petite, tall');
    expect(splitBust(fields)).toBe(fields);
  });

  it('matches complete size tags without altering unrelated phrases', () => {
    expect(splitBust(f('breast curtain, flat chest'))).toMatchObject({ body: 'breast curtain', bust: 'flat chest' });
  });
});
