export const WORKSPACE_TRANSFER_CONCURRENCY = 4;

export function createWorkspaceTransferPool(limit = WORKSPACE_TRANSFER_CONCURRENCY) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Workspace transfer concurrency must be a positive integer.");
  let active = 0;
  const waiting: (() => void)[] = [];
  const pending = new Set<Promise<unknown>>();

  const acquire = () => {
    if (active < limit) { active += 1; return Promise.resolve(); }
    return new Promise<void>(resolve => waiting.push(resolve));
  };
  const release = () => {
    if (waiting.length) waiting.shift()!();
    else active -= 1;
  };

  async function run<T>(transfer: () => Promise<T>): Promise<T> {
    const operation = (async () => {
      await acquire();
      try { return await transfer(); }
      finally { release(); }
    })();
    pending.add(operation);
    try { return await operation; }
    finally { pending.delete(operation); }
  }

  async function drain(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return { run, drain };
}

/** Run independent content transfers with a shared bound and settle in-flight work before returning. */
export async function transferWorkspaceBlobs(
  hashes: readonly string[],
  transfer: (hash: string, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!hashes.length) return;

  const controller = new AbortController();
  let stopped = false, failed = false, failure: unknown;
  const stop = (reason?: unknown) => {
    stopped = true;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const cancel = () => stop(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  let next = 0;
  const worker = async () => {
    while (!stopped) {
      if (signal?.aborted) { cancel(); return; }
      const index = next++;
      if (index >= hashes.length) return;
      try { await transfer(hashes[index]!, controller.signal); }
      catch (error) {
        if (!stopped) { failed = true; failure = error; stop(error); }
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(WORKSPACE_TRANSFER_CONCURRENCY, hashes.length) }, worker));
  } finally { signal?.removeEventListener("abort", cancel); }
  if (signal?.aborted) signal.throwIfAborted();
  if (failed) throw failure;
}
