/**
 * Runs `task` over `items` with at most `limit` running at once; results keep the input order.
 * If a task fails, no new task is started, but those already running are awaited before the first error
 * is thrown, so the caller can safely clean up shared resources (a temporary folder) afterwards.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}
