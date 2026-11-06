import type { CharTagEntry, CharTagField } from '@/state/charTags';



const BUST_TAG = /^(?:flat chest|(?:small|medium|large|huge|gigantic) breasts)$/i;

export function splitBust(fields: Record<CharTagField, string>): Record<CharTagField, string> {
  const parts = (fields.body ?? '').split(',').map(part => part.trim()).filter(Boolean);
  const bust = parts.filter(part => BUST_TAG.test(part));
  if (!bust.length) return fields;
  const body = parts.filter(part => !BUST_TAG.test(part)).join(', ');
  return { ...fields, body, bust: (fields.bust ?? '').trim() || bust.join(', ') };
}


export function withSplitBust(entry: CharTagEntry): CharTagEntry {
  const fields = splitBust(entry.fields);
  return fields === entry.fields ? entry : { ...entry, fields };
}
