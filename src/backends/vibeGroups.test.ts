import { describe, expect, it } from 'vitest';

import { groupKey, groupVibes, isGroupActive, matchVibe, UNGROUPED } from '@/backends/vibeGroups';
import type { NaiVibe } from '@/state/settings';

function vibe(id: string, group = '', enabled = false, name = id): NaiVibe {
  return {
    id,
    name,
    dataPath: `/user/files/${id}.json`,
    thumbnailPath: '',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: `fp-${id}`,
    strength: 0.6,
    enabled,
    group,
  };
}

describe('groupKey', () => {
  it('real group names are boxed with a prefix; an empty name is the ungrouped sentinel', () => {
    expect(groupKey('战斗组')).toBe('g:战斗组');
    expect(groupKey('')).toBe(UNGROUPED);
    expect(groupKey('   ')).toBe(UNGROUPED);
  });

  it('a user naming a group the sentinel literal does not collide', () => {
    expect(groupKey('ungrouped')).not.toBe(UNGROUPED);
    expect(groupKey('new')).toBe('g:new');
  });
});

describe('matchVibe', () => {
  it('empty query matches everything', () => {
    expect(matchVibe(vibe('a'), '')).toBe(true);
    expect(matchVibe(vibe('a'), '   ')).toBe(true);
  });

  it('substring match on name or group name, case-insensitive', () => {
    const v = { name: 'Sunset Girl', group: '风景组' };
    expect(matchVibe(v, 'sunset')).toBe(true);
    expect(matchVibe(v, 'GIRL')).toBe(true);
    expect(matchVibe(v, '风景')).toBe(true);
    expect(matchVibe(v, '战斗')).toBe(false);
  });
});

describe('groupVibes', () => {
  it('gathered by group, ungrouped always last', () => {
    const groups = groupVibes([
      vibe('1'),
      vibe('2', '战斗组'),
      vibe('3'),
      vibe('4', '日常组'),
      vibe('5', '战斗组'),
    ]);
    expect(groups.map(g => g.label)).toEqual(['战斗组', '日常组', "Ungrouped"]);
    expect(groups[0].all.map(v => v.id)).toEqual(['2', '5']);
    expect(groups[2].all.map(v => v.id)).toEqual(['1', '3']);
  });

  it('named groups ordered by first appearance in the library', () => {
    const groups = groupVibes([vibe('1', 'Z组'), vibe('2', 'A组')]);
    expect(groups.map(g => g.label)).toEqual(['Z组', 'A组']);
  });

  it('search only narrows items; all is always the full membership', () => {
    const groups = groupVibes(
      [vibe('1', '战斗组', false, '剑光'), vibe('2', '战斗组', false, '火焰'), vibe('3', '日常组', false, '咖啡')],
      '剑',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(v => v.id)).toEqual(['1']);
    // Key: "火焰", hidden by the search within the same group, is still in all, so bulk actions don't turn it off by mistake
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('groups with no search match do not appear', () => {
    const groups = groupVibes([vibe('1', '战斗组', false, '剑光'), vibe('2', '日常组', false, '咖啡')], '咖啡');
    expect(groups.map(g => g.label)).toEqual(['日常组']);
  });

  it('searching by group name brings out the whole group', () => {
    const groups = groupVibes([vibe('1', '战斗组', false, '剑光'), vibe('2', '战斗组', false, '火焰')], '战斗');
    expect(groups[0].items).toHaveLength(2);
  });

  it('leading/trailing spaces in group names normalise to the same group', () => {
    const groups = groupVibes([vibe('1', '战斗组'), vibe('2', ' 战斗组 ')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].all.map(v => v.id)).toEqual(['1', '2']);
  });

  it('empty library returns an empty array', () => {
    expect(groupVibes([])).toEqual([]);
  });
});

describe('isGroupActive', () => {
  it('active only when the enabled set exactly equals all members of the group', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '战斗组', true), vibe('3', '日常组', false)];
    const [battle, daily] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(true);
    expect(isGroupActive(daily, vibes)).toBe(false);
  });

  it('one extra enabled outside the group is no longer active (no misleading active)', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '日常组', true)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('one missing inside the group does not count as active either', () => {
    const vibes = [vibe('1', '战斗组', true), vibe('2', '战斗组', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('judged on full membership even while searching', () => {
    const vibes = [vibe('1', '战斗组', true, '剑光'), vibe('2', '战斗组', false, '火焰')];
    // The search leaves only "剑光", but "火焰" isn't enabled → the whole group doesn't count as active
    const [battle] = groupVibes(vibes, '剑');
    expect(battle.items).toHaveLength(1);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });

  it('not active when none are enabled', () => {
    const vibes = [vibe('1', '战斗组', false)];
    const [battle] = groupVibes(vibes);
    expect(isGroupActive(battle, vibes)).toBe(false);
  });
});
