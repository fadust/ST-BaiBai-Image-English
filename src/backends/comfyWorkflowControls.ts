/** Direct bindings into an imported API workflow; edits never rebuild its graph. */
type WorkflowNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
type Workflow = Record<string, WorkflowNode>;

export interface WorkflowField {
  node: string;
  input: string;
  value: string | number;
  also?: string[];
}
export interface WorkflowModel extends WorkflowField { kind: 'checkpoint' | 'unet' | 'gguf'; title: string }
export interface WorkflowLora { name: WorkflowField; strength: WorkflowField }
export interface WorkflowSampling {
  title: string;
  steps?: WorkflowField;
  cfg?: WorkflowField;
  sampler?: WorkflowField;
  scheduler?: WorkflowField;
}
export interface WorkflowControls {
  models: WorkflowModel[];
  loras: WorkflowLora[];
  sampling: WorkflowSampling[];
}

function parse(text: string): Workflow {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected API workflow JSON.');
  return data as Workflow;
}

function field(node: string, inputs: Record<string, unknown>, input: string, kind: 'string' | 'number'): WorkflowField | undefined {
  const value = inputs[input];
  if (typeof value !== kind || (typeof value === 'number' && !Number.isFinite(value))) return undefined;
  return { node, input, value: value as string | number };
}

export function workflowControls(text: string): WorkflowControls {
  const workflow = parse(text);
  const result: WorkflowControls = { models: [], loras: [], sampling: [] };
  const lorasByNode = new Map<string, WorkflowLora[]>();
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.inputs !== 'object') continue;
    const inputs = node.inputs;
    const title = node._meta?.title || node.class_type;
    const modelInput = /^(CheckpointLoaderSimple|CheckpointLoader)$/.test(node.class_type) ? 'ckpt_name'
      : /^(UNETLoader|UnetLoaderGGUF)$/.test(node.class_type) ? 'unet_name' : '';
    const model = modelInput && field(id, inputs, modelInput, 'string');
    if (model) result.models.push({ ...model, title, kind: modelInput === 'ckpt_name' ? 'checkpoint' : node.class_type === 'UnetLoaderGGUF' ? 'gguf' : 'unet' });

    if (/lora/i.test(node.class_type)) {
      const loras: WorkflowLora[] = [];
      const name = field(id, inputs, 'lora_name', 'string');
      const strength = field(id, inputs, 'strength_model', 'number') ?? field(id, inputs, 'strength', 'number');
      if (name && strength) {
        const clip = field(id, inputs, 'strength_clip', 'number');
        loras.push({ name, strength: { ...strength, ...(clip ? { also: ['strength_clip'] } : {}) } });
      }
      const numberedSlots = Object.keys(inputs)
        .filter(key => /^lora_\d+$/.test(key))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
      for (const key of numberedSlots) {
        const name = field(id, inputs, key, 'string');
        const strength = field(id, inputs, key.replace('lora_', 'strength_'), 'number');
        if (name && strength) loras.push({ name, strength });
      }
      if (loras.length) lorasByNode.set(id, loras);
    }
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      result.sampling.push({
        title,
        steps: field(id, inputs, 'steps', 'number'),
        cfg: field(id, inputs, 'cfg', 'number'),
        sampler: field(id, inputs, 'sampler_name', 'string'),
        scheduler: field(id, inputs, 'scheduler', 'string'),
      });
    }
  }
  // A loader inserted into a chain can have a higher node ID than the loader it feeds.
  const visited = new Set<string>();
  function appendLoras(id: string): void {
    const loras = lorasByNode.get(id);
    if (!loras || visited.has(id)) return;
    visited.add(id);
    const { model, clip } = workflow[id].inputs;
    for (const link of [model, clip]) {
      if (Array.isArray(link)) appendLoras(String(link[0]));
    }
    result.loras.push(...loras);
  }
  for (const id of lorasByNode.keys()) appendLoras(id);
  return result;
}

export function updateWorkflowField(text: string, binding: WorkflowField, value: string | number): string {
  const workflow = parse(text);
  const inputs = workflow[binding.node]?.inputs;
  if (!inputs || !Object.hasOwn(inputs, binding.input) || typeof inputs[binding.input] !== typeof value) {
    throw new Error('This workflow field changed. Reopen the controls and try again.');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Enter a valid number.');
    if (binding.input === 'steps' && (!Number.isInteger(value) || value < 1)) throw new Error('Steps must be a positive whole number.');
    if (binding.input === 'cfg' && value < 0) throw new Error('CFG cannot be negative.');
  }
  inputs[binding.input] = value;
  for (const input of binding.also ?? []) {
    if (typeof inputs[input] !== typeof value) throw new Error('A linked strength field changed. Reopen the controls and try again.');
    inputs[input] = value;
  }
  return JSON.stringify(workflow, null, 2);
}
