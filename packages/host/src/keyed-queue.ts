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

type PendingCreateEntry = {
  id: string;
  projectIds: () => readonly string[] | undefined;
  promise: Promise<unknown>;
};

export class PendingCreates {
  private readonly entries = new Set<PendingCreateEntry>();

  track<T>(id: string, projectIds: readonly string[] | (() => readonly string[] | undefined), promise: Promise<T>): Promise<T> {
    const entry: PendingCreateEntry = {
      id,
      projectIds: typeof projectIds === "function" ? projectIds : () => projectIds,
      promise,
    };
    const tracked = promise.finally(() => {
      this.entries.delete(entry);
    });
    entry.promise = tracked;
    this.entries.add(entry);
    return tracked;
  }

  matching(covers: (projectIds: readonly string[], id: string) => boolean): PendingCreateEntry[] {
    return [...this.entries].filter(entry => {
      const projectIds = entry.projectIds();
      return !projectIds || covers(projectIds, entry.id);
    });
  }
}

export function pauseWithPendingCreates<T>(
  pendingCreates: PendingCreates,
  records: ReadonlyMap<string, unknown>,
  covers: (projectIds: readonly string[], id: string) => boolean,
  pauseOne: (id: string) => Promise<T | undefined>,
): Promise<Awaited<T>[]> {
  const onlyDefined = (items: readonly (Awaited<T> | undefined)[]): Awaited<T>[] =>
    items.filter((item): item is Awaited<T> => item !== undefined);
  const seen = new Set(records.keys());
  const existingTask = Promise.all([...seen].map(pauseOne));
  const pending = pendingCreates.matching(covers);
  const pauseCreated = (id: string): Promise<T | undefined> => {
    if (seen.has(id) || !records.has(id)) return Promise.resolve(undefined);
    seen.add(id);
    return pauseOne(id);
  };
  const pendingTask = Promise.all(
    pending.map(entry => entry.promise.then(() => pauseCreated(entry.id), () => pauseCreated(entry.id))),
  );
  return Promise.all([existingTask, pendingTask]).then(([existing, created]) => [
    ...onlyDefined(existing),
    ...onlyDefined(created),
  ]);
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
