import { setTimeout as delay } from "node:timers/promises";
import { CHUNK_FRAME_BYTES, encodeChunkBatch, readWorkspaceBlob, WORKSPACE_LIMITS, type WorkspaceStoreTarget } from "./workspace-checkpoint.js";

const BATCHES_IN_FLIGHT = 4;
const CHUNKS_IN_FLIGHT = 16;
const PRESENCE_BATCH = 512;
const ATTEMPTS = 4;
const READ_WINDOW = 8;

export interface ChunkTransport {
  has(hashes: string[], signal: AbortSignal): Promise<unknown>;
  putBatch(body: Buffer, signal: AbortSignal): Promise<"unsupported" | void>;
  put(hash: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
}

async function retried<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await send(); } catch (error) {
      if (attempt === ATTEMPTS || signal.aborted || !(error instanceof TypeError)) throw error;
      await delay(250 * attempt, undefined, { signal });
    }
  }
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      try { results[index] = await run(items[index]); } catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}

export async function uploadMissingChunks(options: { storeDir: WorkspaceStoreTarget; hashes: string[]; transport: ChunkTransport; signal?: AbortSignal; progress?: () => void }) {
  const { storeDir, transport, progress } = options;
  const failure = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, failure.signal]) : failure.signal;
  try { await upload(); } catch (error) { failure.abort(); throw error; }
  async function upload() {
    const hashes = [...new Set(options.hashes)], groups: string[][] = [];
    for (let offset = 0; offset < hashes.length; offset += PRESENCE_BATCH) groups.push(hashes.slice(offset, offset + PRESENCE_BATCH));
    const missing = (await pool(groups, BATCHES_IN_FLIGHT, async group => {
      const reply = await retried(() => transport.has(group, signal), signal);
      if (!Array.isArray(reply) || reply.some(hash => !group.includes(hash))) throw new Error("Host returned an invalid source upload request.");
      progress?.();
      return reply as string[];
    }, signal)).flat();
    if (!missing.length) return;

    type Chunk = { hash: string; bytes: Buffer };
    const readyBatches: Chunk[][] = [];
    let readDone = false;
    let failed = false;
    let batched = true;
    const spaceWaiters: (() => void)[] = [];
    const batchWaiters: (() => void)[] = [];
    const wakeAll = (waiters: (() => void)[]) => {
      while (waiters.length) waiters.shift()!();
    };
    const wakeOne = (waiters: (() => void)[]) => {
      waiters.shift()?.();
    };
    const waitFor = (waiters: (() => void)[]) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")); return; }
      const onAbort = () => {
        const index = waiters.indexOf(onWake);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      const onWake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(onWake);
    });

    const producer = (async () => {
      let cursor = 0;
      let current: Chunk[] = [];
      let size = 0;
      while (cursor < missing.length && !failed) {
        signal.throwIfAborted();
        const slice = missing.slice(cursor, cursor + READ_WINDOW);
        cursor += slice.length;
        const loaded = await Promise.all(slice.map(async hash => ({
          hash,
          bytes: Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"),
        })));
        for (const chunk of loaded) {
          if (failed) return;
          signal.throwIfAborted();
          const frameBytes = CHUNK_FRAME_BYTES + chunk.bytes.length;
          if (current.length && (current.length >= WORKSPACE_LIMITS.batchChunks || size + frameBytes > WORKSPACE_LIMITS.batchBytes)) {
            while (readyBatches.length >= BATCHES_IN_FLIGHT && !failed) await waitFor(spaceWaiters);
            if (failed) return;
            readyBatches.push(current);
            wakeOne(batchWaiters);
            current = [];
            size = 0;
          }
          current.push(chunk);
          size += frameBytes;
          progress?.();
        }
      }
      if (current.length && !failed) {
        while (readyBatches.length >= BATCHES_IN_FLIGHT && !failed) await waitFor(spaceWaiters);
        if (!failed) {
          readyBatches.push(current);
          wakeOne(batchWaiters);
        }
      }
      readDone = true;
      wakeAll(batchWaiters);
    })().catch(error => {
      failed = true;
      wakeAll(batchWaiters);
      throw error;
    });

    const workers = Array.from({ length: BATCHES_IN_FLIGHT }, async () => {
      while (!failed) {
        signal.throwIfAborted();
        if (!readyBatches.length) {
          if (readDone) return;
          await waitFor(batchWaiters);
          continue;
        }
        const chunks = readyBatches.shift()!;
        wakeOne(spaceWaiters);
        try {
          const body = encodeChunkBatch(chunks);
          if (batched && await retried(() => transport.putBatch(body, signal), signal) !== "unsupported") { progress?.(); continue; }
          batched = false;
          await pool(chunks, CHUNKS_IN_FLIGHT / BATCHES_IN_FLIGHT, async ({ hash, bytes }) => { await retried(() => transport.put(hash, bytes, signal), signal); progress?.(); }, signal);
        } catch (error) {
          failed = true;
          wakeAll(spaceWaiters);
          wakeAll(batchWaiters);
          throw error;
        }
      }
    });

    await Promise.all([producer, ...workers]);
  }
}
