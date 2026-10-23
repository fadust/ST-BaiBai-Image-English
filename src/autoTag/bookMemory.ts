/**
 * Reads and formats BaiBai Book character state.
 *
 * Image planning only cares whether character traits are right, not about plot context: the snapshot is no longer stuffed whole into the prompt,
 * but parsed into a **character reference block**: protagonist profile + important characters (always included, the same full profile as BaiBai Book's injection side).
 * Other characters are looked up by name in the target text: sent only if they appear in it (BaiBai Book's presence check can lag,
 * so a character may have arrived before the record updates; the story text wins), also in full, because they may actually be present.
 * Past plot, time and place, items, plans and the like are irrelevant to the image and are never injected.
 */

interface BookFloor {
  revision: number;
  memory: { valid: boolean };
}

interface BookSnapshot {
  revision: number;
  [key: string]: unknown;
}

interface BookFloorContext {
  revision: number;
  floorData?: { memory?: { valid?: boolean } };
  snapshotBefore?: BookSnapshot;
  snapshotAfter?: BookSnapshot;
}

interface BookApi {
  apiVersion: number;
  getFloor(floor: number): BookFloor;
  getSnapshot(options: { floor: number; at: 'before' | 'after' }): BookSnapshot;
  getContextAtFloor?(options: { floor: number }): BookFloorContext;
}

/** A single character in the reference block (structured), used for anchor matching against the fixed-appearance tag library. */
export interface BookRole {
  /** Character name: BaiBai Book's name for NPCs; for the protagonist, the name given by the caller (default "protagonist"). */
  name: string;
  /** Original fixed-appearance text recorded by BaiBai Book (protagonist appearance / NPC desc); empty string if not recorded. */
  desc: string;
  isProtagonist: boolean;
}

export interface BookMemoryContext {
  timing: 'before_latest' | 'after_latest';
  /** Parsed character reference text block, ready to drop into the prompt. */
  text: string;
  /** Characters covered by this reference block (filtered by the same rules as text). */
  roles: BookRole[];
}

function getBookApi(): BookApi | null {
  const api = (globalThis as { STBaiBaiBook?: BookApi }).STBaiBaiBook;
  return api?.apiVersion === 1 ? api : null;
}

/* ============ Snapshot → character reference text ============ */

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function fmtProtagonist(protagonist: unknown): string {
  const p = (protagonist ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const fields: Array<[string, string]> = [
    ['Gender', 'gender'],
    ['Age', 'age'],
    ['Identity', 'identity'],
    ['Appearance', 'appearance'],
    ['Outfit', 'outfit'],
    ['Condition', 'condition'],
  ];
  for (const [label, key] of fields) {
    const v = oneLine(p[key]);
    if (v) parts.push(`${label}:${v}`);
  }
  return parts.join('；');
}

/**
 * Full NPC line, matching the fields of BaiBai Book's present-character profile on its injection side; image planning also adds the fixed appearance desc
 * (BaiBai Book keeps main characters' appearance brief because the main model's card already has it; image generation is sensitive to looks, so appearance must be given).
 */
function fmtNpc(n: Record<string, unknown>): string {
  const name = oneLine(n.name);
  const bracket = [oneLine(n.gender), oneLine(n.age), oneLine(n.title)].filter(Boolean).join('·');
  let line = bracket ? `${name}(${bracket})` : name;
  const rel = oneLine(n.relation);
  if (rel) line += ` ——With the protagonist:${rel}`;
  const tail: string[] = [];
  const desc = oneLine(n.desc);
  if (desc) tail.push(`Appearance:${desc}`);
  const outfit = oneLine(n.outfit);
  if (outfit) tail.push(`Outfit:${outfit}`);
  const condition = oneLine(n.condition);
  if (condition) tail.push(`Condition:${condition}`);
  if (n.follow === true) tail.push('Following');
  else {
    const loc = oneLine(n.location);
    if (loc) tail.push(`In:${loc}`);
  }
  return tail.length ? `${line} 〔${tail.join(';')}〕` : line;
}

function fmtNpcs(npcs: unknown, bodyText: string, roles: BookRole[]): string {
  if (!Array.isArray(npcs)) return '';
  const lines: string[] = [];
  for (const raw of npcs) {
    const n = (raw ?? {}) as Record<string, unknown>;
    const name = oneLine(n.name);
    if (!name) continue;
    // Important characters always included; following characters are always present; others are looked up by name in the target text and only count as taking part in this floor if they appear
    if (n.important === true || n.follow === true || bodyText.includes(name)) {
      lines.push(`- ${fmtNpc(n)}`);
      roles.push({ name, desc: oneLine(n.desc), isProtagonist: false });
    }
  }
  return lines.length ? `Important role:\n${lines.join('\n')}` : '';
}

/** Parses the snapshot into character reference text + a structured character list (no character info → empty string, which the caller treats as not provided). */
function formatSnapshotRoles(
  snapshot: BookSnapshot,
  bodyText: string,
  protagonistName: string,
): { text: string; roles: BookRole[] } {
  const lines: string[] = [];
  const roles: BookRole[] = [];
  const protagonist = fmtProtagonist(snapshot.protagonist);
  if (protagonist) {
    lines.push(`Protagonist:${protagonist}`);
    const p = (snapshot.protagonist ?? {}) as Record<string, unknown>;
    roles.push({ name: protagonistName, desc: oneLine(p.appearance), isProtagonist: true });
  }
  const npcs = fmtNpcs(snapshot.npcs, bodyText, roles);
  if (npcs) lines.push(npcs);
  return { text: lines.join('\n'), roles };
}

/* ============ Text wrapping ============ */

const ROLE_NOTE = '【 character reference (the latest status of BaiBai Book synchronization, read-only reference) 】\n';

function buildMemoryText(roles: string): string {
  return `${ROLE_NOTE}${roles}`;
}

/* ============ Read entry point ============ */

/**
 * Reads BaiBai Book's character state and parses it into character reference text.
 * @param floor target floor
 * @param bodyText raw text of the target floor (used to judge whether characters not present actually take part in this floor)
 * @param protagonistName protagonist display name (usually the user name; defaults to "protagonist", used only as the character tag library's match key)
 * BaiBai Book unavailable / no character info / read failure → returns null (the caller degrades to sending only the text).
 */
export function readBookMemory(
  floor: number,
  bodyText: string,
  protagonistName = 'Protagonist',
): BookMemoryContext | null {
  const api = getBookApi();
  if (!api) return null;
  try {
    let snapshot: BookSnapshot | undefined;
    let timing: BookMemoryContext['timing'] = 'before_latest';

    if (typeof api.getContextAtFloor === 'function') {
      // Prefer getContextAtFloor: BaiBai Book aligns the before/after snapshots' revision in one go, guaranteeing consistency internally.
      const data = api.getContextAtFloor({ floor });
      const valid = !!data.floorData?.memory?.valid;
      timing = valid ? 'after_latest' : 'before_latest';
      snapshot = valid ? data.snapshotAfter : data.snapshotBefore;
    } else {
      // Fallback: the old public API, trying to align revisions step by step per rules D1/D2
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const floorData = api.getFloor(floor);
        timing = floorData.memory.valid ? 'after_latest' : 'before_latest';
        const s = api.getSnapshot({
          floor,
          at: timing === 'after_latest' ? 'after' : 'before',
        });
        if (floorData.revision === s.revision) {
          snapshot = s;
          break;
        }
      }
      if (!snapshot) {
        console.warn('[BaiBai Image] BaiBai Book continues to change during reading, and there is no character reference included this time.');
        return null;
      }
    }
    if (!snapshot) return null;

    const { text, roles } = formatSnapshotRoles(snapshot, bodyText, protagonistName);
    if (!text) return null;
    return { timing, text: buildMemoryText(text), roles };
  } catch (error) {
    console.warn('[BaiBai Image] Failed to read the character status of BaiBai Book. Only the latest text will be used this time.', error);
    return null;
  }
}
