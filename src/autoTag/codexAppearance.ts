import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import type { STContext } from '@/st/context';

interface ImageActor { id: string; name: string; aliases: string[]; appearance: string; archived: boolean }
interface ActorSnapshot { apiVersion: number; chatId: string; groupId: string | null; floor: number; revision: number; actors: ImageActor[] }
interface CodexApi { imageActors?(request: { chatId: string; groupId: string | null; floor: number; sourceText: string }): ActorSnapshot | null }
const norm = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const namedIn = (text: string, label: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(text);

/** Temporary rendering references only; never copy Image's decisions back into a dossier or library. */
export function codexAppearance(
  context: STContext, floor: number, sourceText: string, entries: CharTagEntry[], locked: ReadonlySet<string>,
  roleNames: string[] = [], bridge: CodexApi | undefined = (globalThis as { NPCStateDelta?: CodexApi }).NPCStateDelta,
) {
  const result = { entries, locked: new Set(locked), note: '', isCurrent: () => true };
  const chatId = context.getCurrentChatId?.();
  if (!chatId || !bridge?.imageActors) return result;
  const request = { chatId, groupId: context.groupId || null, floor, sourceText };
  let snapshot: ActorSnapshot | null;
  try { snapshot = bridge.imageActors(request); } catch { return result; }
  if (snapshot?.apiVersion !== 1 || snapshot.chatId !== chatId || snapshot.groupId !== request.groupId
      || snapshot.floor !== floor || !Array.isArray(snapshot.actors)) return result;

  const byLabel = new Map<string, ImageActor[]>();
  for (const actor of snapshot.actors) {
    if (!actor?.id || typeof actor.name !== 'string') continue;
    for (const label of new Set([actor.name, ...(Array.isArray(actor.aliases) ? actor.aliases : [])].filter(v => typeof v === 'string' && v.trim()).map(norm))) {
      byLabel.set(label, [...(byLabel.get(label) || []), actor]);
    }
  }
  const references = new Set([...roleNames, ...entries.map(entry => entry.name)].map(norm));
  const text = norm(sourceText);
  const selected: ImageActor[] = [];
  const replaced = new Set<string>();
  for (const actor of snapshot.actors) {
    if (!actor?.id || typeof actor.name !== 'string' || actor.archived || typeof actor.appearance !== 'string' || !actor.appearance.trim()) continue;
    const labels = [...byLabel].filter(([, actors]) => actors.length === 1 && actors[0] === actor).map(([label]) => label);
    if (!labels.includes(norm(actor.name))) continue;
    const mentioned = labels.some(label => references.has(label) || namedIn(text, label));
    if (!mentioned) continue;
    const matching = entries.filter(entry => labels.includes(norm(entry.name)));
    if (matching.some(entry => locked.has(entry.name) || entry.source === 'manual')) continue;
    selected.push(actor);
    for (const label of labels) result.locked.add(label);
    for (const name of [actor.name, ...(actor.aliases || []), ...matching.map(entry => entry.name)]) {
      if (labels.includes(norm(name))) result.locked.add(name);
    }
    for (const entry of matching) replaced.add(entry.name);
  }
  if (!selected.length) return result;
  result.entries = [
    ...entries.filter(entry => !replaced.has(entry.name)),
    ...selected.map(actor => ({ name: actor.name, fields: emptyCharFields(), raw: actor.appearance.trim(),
      nl: actor.appearance.trim(), source: 'manual' as const, desc: actor.appearance.trim(), history: [] })),
  ];
  result.note = `NPC Codex appearance authority for this request: ${JSON.stringify(selected.map(({ name, aliases, appearance }) => ({ name, aliases, appearance })))}\nThese actors are already profiled. Their accepted descriptions take precedence over BaiBai Book, cards and unlocked Image appearance records for matching identities. Preserve their physical details and current form in coherent English sentences; do not convert their descriptions into Danbooru tags or invent missing features. Target-text chronology still governs an explicitly earlier form/outfit or a visible change within this message. Pose, framing, action and temporary expression come from the selected scene. The Codex entries are temporary read-only references, not global library edits: never report new/changes for their names or aliases. Existing manually authored or globally locked Image entries retain their overrides.`;
  const selectedIds = new Set(selected.map(actor => actor.id));
  const appearanceKey = (actors: ImageActor[]) => JSON.stringify(actors.filter(actor => selectedIds.has(actor.id)));
  const acceptedKey = appearanceKey(snapshot.actors);
  const identities = (actors: ImageActor[]) => JSON.stringify(actors.map(({ id, name, aliases }) => ({ id, name, aliases })));
  const acceptedIdentities = identities(snapshot.actors);
  result.isCurrent = () => {
    try {
      const current = bridge.imageActors?.(request);
      return !!current && current.chatId === chatId && current.groupId === request.groupId && current.floor === floor
        && identities(current.actors) === acceptedIdentities && appearanceKey(current.actors) === acceptedKey;
    } catch { return false; }
  };
  return result;
}
