import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  getWorkflowPlaceholders,
  parseWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';
import { getTagGenChannel } from '@/state/settings';

export type WorkflowBindingPurpose =
  | 'positive_tag'
  | 'positive_nl'
  | 'positive_combined'
  | 'negative'
  | 'seed'
  | 'width'
  | 'height';

export interface WorkflowBinding {
  node: string;
  input: string;
  purpose: WorkflowBindingPurpose;
  /** 需要跨每张图保留的原提示词片段编号；文本由插件按编号读取，AI不复制原文。 */
  keep?: string[];
}

export interface WorkflowChange extends WorkflowBinding {
  before: string | number;
  after: string;
}

export interface WorkflowAssistResult {
  workflow: string;
  changes: WorkflowChange[];
  nlMode: 'none' | 'separate' | 'combined';
  hasNegative: boolean;
}

const PURPOSES = new Set<WorkflowBindingPurpose>([
  'positive_tag',
  'positive_nl',
  'positive_combined',
  'negative',
  'seed',
  'width',
  'height',
]);

const SYSTEM_PROMPT = `You are a dynamic parameter locator for the ComfyUI API format workflow. You are only responsible for determining which inputs field of an existing node serves what purpose, and may not rewrite the workflow.

Return only an JSON object, no Markdown, explanations or thought processes:
{"bindings":[{"node":"6","input":"text","purpose":"positive_combined","keep":["F1","F2"]}]}

purpose can only be:
- positive_tag: Forward danbooru/tag prompt word input.
- positive_nl: Natural language forward input separate from tag.
- positive_combined: Select this if the same text input receives both tag and natural language; the original value contains both a comma and a complete sentence, or the model receives both with the same encoder.
- negative: Negative prompt word input.
- seed: Random seed used by the main generation chain.
- width / height: Width and height of main generated canvas or initial latent.

Rules:
1. node and input must correspond verbatim to the actual nodes ID and inputs keys in the workflow.
2. Only editable inputs whose values are strings or numbers are selected. Wired arrays of the form ["Node ID", Output Serial Number] cannot be selected.
3. Only one purpose can be selected for the same input; positive_combined must be selected when tag is used with natural language.
4. Can return multiple inputs with the same purpose, such as dual encoders and multiple simultaneous seed.
5. Do not select model name, LoRA, sampling steps, CFG, sampler, scheduler, enlarge/crop/preview size.
6. width/height only marks the main generated size, not the post-enlargement, cropping or output size.
7. The text input supplies fragments. keep can only fill in the fragments of this input that need to be persisted across all images ID:
   - Positively retain quality words, model/LoRA trigger words, fixed style words, and fixed rating words.
   - Forwardly delete the number of characters, character appearance, clothing, actions, scenes, composition, lighting and natural language descriptions in the exported examples.
   - Repeated style sentences in natural language are no longer preserved when the same style is already expressed by a short trigger word.
   - Negatively preserve general quality, anatomy, artifacts, and fixed style exclusions; remove temporary exclusions specific to exported example characters or scenes.
   - Fragment text must not be copied, only ID is returned; if there is no fixed fragment, an empty array is returned. keep of seed/width/height must be an empty array.
8. At least one positive_tag or positive_combined must be found. Do not guess at input that cannot be reliably confirmed.`;

interface PromptFragment {
  id: string;
  text: string;
}

const KNOWN_PLACEHOLDER_PATTERN = /%(?:prompt|negative_prompt|seed|nl|width|height)%/g;

function promptFragments(value: string): PromptFragment[] {
  return value
    .replace(KNOWN_PLACEHOLDER_PATTERN, '')
    .split(/[,，;；\r\n]+/)
    .map(text => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `F${index + 1}`, text }));
}

function workflowAnalysisPayload(workflow: ComfyWorkflow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(workflow).map(([nodeId, node]) => {
      const inputs =
        node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
          ? Object.fromEntries(
              Object.entries(node.inputs as Record<string, unknown>).map(([input, value]) => [
                input,
                typeof value === 'string'
                  ? { kind: 'text', fragments: promptFragments(value) }
                  : value,
              ]),
            )
          : node.inputs;
      return [
        nodeId,
        {
          class_type: node.class_type,
          title:
            node._meta && typeof node._meta === 'object' && !Array.isArray(node._meta)
              ? (node._meta as Record<string, unknown>).title
              : undefined,
          inputs,
        },
      ];
    }),
  );
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates = [cleaned];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

export function parseWorkflowBindings(raw: string): WorkflowBinding[] {
  let parsed: unknown;
  for (const candidate of jsonObjects(raw)) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // 尝试下一个 JSON 候选。
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI No resolvable workflow location was returned JSON');
  }
  const bindings = (parsed as Record<string, unknown>).bindings;
  if (!Array.isArray(bindings)) throw new Error('The AI response is missing the bindings array');

  const byPath = new Map<string, WorkflowBinding>();
  for (const item of bindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const node = typeof value.node === 'string' ? value.node.trim() : '';
    const input = typeof value.input === 'string' ? value.input.trim() : '';
    const purpose = typeof value.purpose === 'string' ? value.purpose.trim() : '';
    const keep = Array.isArray(value.keep)
      ? value.keep
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim().toUpperCase())
          .filter(id => /^F\d+$/.test(id))
      : [];
    if (!node || !input || !PURPOSES.has(purpose as WorkflowBindingPurpose)) continue;
    const next = { node, input, purpose: purpose as WorkflowBindingPurpose, keep: [...new Set(keep)] };
    const key = `${node}\u0000${input}`;
    const previous = byPath.get(key);
    if (!previous || previous.purpose === next.purpose) {
      byPath.set(key, next);
      continue;
    }
    const positivePair = new Set([previous.purpose, next.purpose]);
    if (
      positivePair.has('positive_combined') ||
      (positivePair.has('positive_tag') && positivePair.has('positive_nl'))
    ) {
      byPath.set(key, {
        node,
        input,
        purpose: 'positive_combined',
        keep: [...new Set([...(previous.keep ?? []), ...(next.keep ?? [])])],
      });
      continue;
    }
    throw new Error(`AI is the node ${node}.${input} Returned conflicting uses`);
  }
  return [...byPath.values()];
}

function appendComma(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed.replace(/[\s,，]+$/, '')}, ${marker}`;
}

function appendLine(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed}\n${marker}`;
}

function fixedText(value: string, keep: string[], binding: WorkflowBinding): string {
  const fragments = promptFragments(value);
  const available = new Map(fragments.map(fragment => [fragment.id, fragment.text]));
  const unknown = keep.filter(id => !available.has(id));
  if (unknown.length) {
    throw new Error(`AI is the node ${binding.node}.${binding.input} returned a fragment that does not exist:${unknown.join('、')}`);
  }
  return fragments
    .filter(fragment => keep.includes(fragment.id))
    .map(fragment => fragment.text)
    .join(', ');
}

function renderTextBinding(value: string, binding: WorkflowBinding): string {
  const base = fixedText(value, binding.keep ?? [], binding);
  if (binding.purpose === 'positive_tag') return appendComma(base, '%prompt%');
  if (binding.purpose === 'positive_nl') return appendLine(base, '%nl%');
  if (binding.purpose === 'positive_combined') {
    return appendLine(appendComma(base, '%prompt%'), '%nl%');
  }
  if (binding.purpose === 'negative') return appendComma(base, '%negative_prompt%');
  return `%${binding.purpose}%`;
}

function editableInput(workflow: ComfyWorkflow, binding: WorkflowBinding): string | number {
  const node = workflow[binding.node];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`AI returned node ${binding.node} does not exist`);
  }
  const inputs = node.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error(`node ${binding.node} No editable inputs`);
  }
  if (!Object.hasOwn(inputs, binding.input)) {
    throw new Error(`node ${binding.node} No input exists ${binding.input}`);
  }
  const value = (inputs as Record<string, unknown>)[binding.input];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`node ${binding.node}.${binding.input} Not a directly replaceable text or numeric input`);
  }
  return value;
}

export function applyWorkflowBindings(template: string, bindings: WorkflowBinding[]): WorkflowAssistResult {
  const workflow = parseWorkflowTemplate(template);
  const changes: WorkflowChange[] = [];
  let hasPositive = false;
  let nlMode: WorkflowAssistResult['nlMode'] = 'none';
  let hasNegative = false;

  for (const binding of bindings) {
    const before = editableInput(workflow, binding);
    if (binding.purpose === 'positive_tag' || binding.purpose === 'positive_nl' || binding.purpose === 'positive_combined') hasPositive = true;
    if (binding.purpose === 'positive_nl' && nlMode === 'none') nlMode = 'separate';
    if (binding.purpose === 'positive_combined') nlMode = 'combined';
    if (binding.purpose === 'negative') hasNegative = true;

    const after =
      binding.purpose === 'seed' || binding.purpose === 'width' || binding.purpose === 'height'
        ? `%${binding.purpose}%`
        : renderTextBinding(String(before), binding);
    const inputs = workflow[binding.node].inputs as Record<string, unknown>;
    inputs[binding.input] = after;
    if (String(before) !== after) changes.push({ ...binding, before, after });
  }

  if (!hasPositive && !getWorkflowPlaceholders(template).some(name => name === 'prompt' || name === 'nl')) {
    throw new Error('AI No positive prompt word input found');
  }
  const rendered = JSON.stringify(workflow, null, 2);
  if (!getWorkflowPlaceholders(rendered).some(name => name === 'prompt' || name === 'nl')) {
    throw new Error('The configured workflow needs %prompt% or %nl%');
  }
  return { workflow: rendered, changes, nlMode, hasNegative };
}

export async function configureWorkflowWithAi(
  template: string,
  signal?: AbortSignal,
): Promise<WorkflowAssistResult> {
  const workflow = parseWorkflowTemplate(template);
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Please locate the following dynamic input for the ComfyUI API workflow. The text value has been split into fragment numbers: \n${JSON.stringify(workflowAnalysisPayload(workflow))}`,
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: 'ComfyUI workflow configuration' })
    : await requestViaMainApi(messages, { signal, source: 'ComfyUI workflow configuration' });
  return applyWorkflowBindings(template, parseWorkflowBindings(raw));
}
