/**
 * Concurrency-limited map. Used by the gallery's batched HEAD size probes and bulk deletes:
 * a character folder holds dozens of images, and a single `Promise.all` would fire dozens of requests at ST at once,
 * stalling your own chat first on a remote connection.
 */

/**
 * Maps with at most `limit` in flight; **results keep input order** (not completion order).
 *
 * If `fn` throws, the whole call rejects (standard Promise.all semantics), but already-started tasks are not cancelled.
 * So for cases that must tolerate single failures, such as bulk deletes, try/catch inside `fn` and return a result object;
 * do not rely on this function for partial-failure handling.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (!items.length) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  // Each worker claims the next unclaimed index itself: more even than slicing into chunks (a slow task cannot hold up a whole slice)
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
