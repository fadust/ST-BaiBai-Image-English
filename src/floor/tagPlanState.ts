import { reactive } from 'vue';
import type { SlotRewritePreview } from '@/autoTag/runner';

interface TagPlanRecord {
  promise: Promise<void>;
}

// Slot state outlives the editor and card. A preview remains available when the editor is reopened.
const planning = reactive(new Map<string, TagPlanRecord>());
const previews = new Map<string, SlotRewritePreview>();

export function isTagPlanning(key: string): boolean {
  return planning.has(key);
}

export function runTagPlan(key: string, run: () => Promise<SlotRewritePreview | null>): Promise<void> {
  const promise = run().then(preview => {
    if (preview && planning.get(key)?.promise === promise) previews.set(key, preview);
  }).finally(() => {
    if (planning.get(key)?.promise === promise) planning.delete(key);
  });
  previews.delete(key);
  planning.set(key, { promise });
  return promise;
}

export function awaitTagPlan(key: string): Promise<void> | null {
  return planning.get(key)?.promise ?? null;
}

export function getTagPreview(key: string): SlotRewritePreview | undefined {
  return previews.get(key);
}

export function discardTagPreview(key: string): void {
  previews.delete(key);
}

export function clearAllTagPlans(): void {
  planning.clear();
  previews.clear();
}
