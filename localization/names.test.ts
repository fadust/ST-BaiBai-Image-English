import { describe, expect, it } from 'vitest';
import { parseImagePlan } from '../src/autoTag/protocol';

describe('English source names', () => {
  it('recovers source casing and typography for saved entries and character prompts', () => {
    const segments = [{ id: 'P1', sourceLine: 0, text: 'Rowan O’Connor waits beside Alexandra Montgomery-Smythe.' }];
    const plan = parseImagePlan(JSON.stringify({
      images: [{ position: 'P1', tag: '2people', characters: [{ name: "rowan o'connor", tag: 'boy' }] }],
      changes: [{ name: "Rowan O'Connor", field: 'new', fields: { hair: 'short hair', eyes: 'green eyes' } }],
    }), segments, 0, 1);
    expect(plan.images[0].characters[0].name).toBe('Rowan O’Connor');
    expect(plan.changes[0].name).toBe('Rowan O’Connor');
  });
  it('does not guess between different source spellings or transliterate a new name', () => {
    const plan = parseImagePlan(JSON.stringify({ images: [], changes: [
      { name: "rowan o'connor", field: 'hair', value: 'short hair', position: 'P1' },
      { name: 'Snow', field: 'hair', value: 'short hair', position: 'P1' },
    ] }), [{ id: 'P1', sourceLine: 0, text: "Rowan O’Connor meets Rowan O'Connor and 小雪." }], 0, 1);
    expect(plan.changes.map(change => change.name)).toEqual(["rowan o'connor", 'Snow']);
  });
});
