import { describe, expect, it } from 'vitest';
import upstream from './upstream-macros.json';
import * as defaults from '../src/state/settings';
import { expandNlSections, RULE_ENGLISH_OUTPUT } from '../src/autoTag/prompt';
import { normalizeOrientation } from '../src/backends/size';

describe('English prompt and saved-data contracts', () => {
  it('preserves macro counts and order in every built-in prompt', () => {
    for (const [name, macros] of Object.entries(upstream)) {
      const text = (defaults as unknown as Record<string, string>)[name];
      expect(text.match(/\{\{[^}]+\}\}/g) ?? [], name).toEqual(macros);
    }
  });
  it('fully expands both natural-language modes without leaving conditional markers', () => {
    for (const enabled of [true, false]) for (const text of [defaults.DEFAULT_NAI_V5_THINKING, defaults.DEFAULT_NAI_V5_SPEC]) {
      expect(expandNlSections(text, enabled)).not.toMatch(/\{\{[#^/]nl\}\}/);
    }
  });
  it('requires English prose while keeping proper names and wire fields intact', () => {
    expect(RULE_ENGLISH_OUTPUT).toContain('Use English');
    expect(RULE_ENGLISH_OUTPUT).toContain('Preserve proper names');
    expect(RULE_ENGLISH_OUTPUT).toContain('JSON keys');
    expect(normalizeOrientation('横屏构图')).toBe('landscape');
    expect(normalizeOrientation('horizontal composition')).toBe('landscape');
  });
});
