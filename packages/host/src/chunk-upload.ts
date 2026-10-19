import { setTimeout as delay } from "node:timers/promises";
import { CHUNK_FRAME_BYTES, encodeChunkBatch, readWorkspaceBlob, WORKSPACE_LIMITS } from "./workspace-checkpoint.js";

/** Requests kept in flight. A remote host is often a long round trip away, so a serial upload is bound by latency, not bandwidth. */
const BATCHES_IN_FLIGHT = 4;
const CHUNKS_IN_FLIGHT = 16;
const PRESENCE_BATCH = 512;
const ATTEMPTS = 4;

export interface ChunkTransport {
  /** The hashes in `hashes` the host lacks. */
  has(hashes: string[], signal: AbortSignal): Promise<unknown>;
  /** Store a framed batch, or report that the host predates batch upload. */
  putBatch(body: Buffer, signal: AbortSignal): Promise<"unsupported" | void>;
  put(hash: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
}

/** Retry a dropped connection; fetch rejects with a TypeError then. Chunk requests are idempotent, and an HTTP refusal or a timeout is not retried. */
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

/** Upload the chunks of `hashes` the host lacks, batched and in parallel; resolves once the host stored every one. */
export async function uploadMissingChunks(options: { storeDir: string; hashes: string[]; transport: ChunkTransport; signal?: AbortSignal; progress?: () => void }) {
  const { storeDir, transport, progress } = options;
  // The first failure cancels the requests still in flight, so a retry never competes with them for the uplink.
  const failure = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, failure.signal]) : failure.signal;
  try { await upload(); } catch (error) { failure.abort(); throw error; }
  async function upload() {
    const hashes = [...new Set(options.hashes)], groups: string[][] = [];
    for (let offset = 0; offset < hashes.length; offset += PRESENCE_BATCH) groups.push(hashes.slice(offset, offset + PRESENCE_BATCH));
    const missing = (await pool(groups, BATCHES_IN_FLIGHT, async group => {
      const reply = await retried(() => transport.has(group, signal), signal);
      // Upload only chunks this manifest named; the reply never selects other local content.
      if (!Array.isArray(reply) || reply.some(hash => !group.includes(hash))) throw new Error("Host returned an invalid source upload request.");
      progress?.();
      return reply as string[];
    }, signal)).flat();

    // Workers take batches in turn; chunks are read only as a batch is filled, so memory stays near the batches in flight.
    type Chunk = { hash: string; bytes: Buffer };
    let cursor = 0, carried: Chunk | undefined, queue: Promise<unknown> = Promise.resolve(), batched = true, failed = false;
    const take = () => {
      const taken = queue.then(async () => {
        const chunks: Chunk[] = [];
        let size = 0;
        while (chunks.length < WORKSPACE_LIMITS.batchChunks && (carried || cursor < missing.length)) {
          let chunk = carried;
          carried = undefined;
          if (!chunk) { const hash = missing[cursor++]; chunk = { hash, bytes: Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64") }; }
          if (chunks.length && size + CHUNK_FRAME_BYTES + chunk.bytes.length > WORKSPACE_LIMITS.batchBytes) { carried = chunk; break; }
          chunks.push(chunk); size += CHUNK_FRAME_BYTES + chunk.bytes.length;
          progress?.();
        }
        return chunks;
      });
      queue = taken.catch(() => {});
      return taken;
    };
    await Promise.all(Array.from({ length: BATCHES_IN_FLIGHT }, async () => {
      while (!failed) {
        signal?.throwIfAborted();
        try {
          const chunks = await take();
          if (!chunks.length) return;
          const body = encodeChunkBatch(chunks);
        if (batched && await retried(() => transport.putBatch(body, signal), signal) !== "unsupported") { progress?.(); continue; }
          batched = false;
          await pool(chunks, CHUNKS_IN_FLIGHT / BATCHES_IN_FLIGHT, async ({ hash, bytes }) => { await retried(() => transport.put(hash, bytes, signal), signal); progress?.(); }, signal);
        } catch (error) { failed = true; throw error; }
      }
    }));
  }
}
