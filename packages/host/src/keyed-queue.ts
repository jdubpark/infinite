export class KeyedQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    const done = next.then(() => undefined, () => undefined);
    this.queues.set(key, done);
    void done.then(() => {
      if (this.queues.get(key) === done) this.queues.delete(key);
    });
    return next;
  }

  settle(): Promise<void> {
    return Promise.allSettled([...this.queues.values()]).then(() => undefined);
  }

  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled([...this.queues.values()]);
    }
  }
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(items.length, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1));
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
