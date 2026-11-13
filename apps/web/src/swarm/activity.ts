import type { ActivityStore } from "./types";

export const ACTIVITY_BUCKETS = 30;
export const ACTIVITY_BUCKET_MS = 10_000;
/** A bucket with this many advances draws full. */
const FULL_BUCKET_ADVANCES = 5;
/** An agent not recorded for this long is forgotten. */
const FORGET_MS = 600_000;

type Entry = { seen?: string; recordedAt: number; advances: Map<number, number> };

/** Page-observed activity. Starts empty; nothing is fetched or stored beyond this object. */
export function createActivity(): ActivityStore {
  const entries = new Map<string, Entry>();
  return {
    record(agents, now) {
      const bucket = Math.floor(now / ACTIVITY_BUCKET_MS);
      for (const agent of agents) {
        const entry = entries.get(agent.id);
        if (!entry) {
          entries.set(agent.id, { seen: agent.lastActivityAt, recordedAt: now, advances: new Map() });
          continue;
        }
        entry.recordedAt = now;
        if (agent.lastActivityAt !== undefined && agent.lastActivityAt !== entry.seen) {
          entry.seen = agent.lastActivityAt;
          entry.advances.set(bucket, (entry.advances.get(bucket) ?? 0) + 1);
        }
      }
      const oldest = bucket - ACTIVITY_BUCKETS + 1;
      for (const [id, entry] of entries) {
        if (now - entry.recordedAt >= FORGET_MS) {
          entries.delete(id);
          continue;
        }
        for (const key of entry.advances.keys()) if (key < oldest) entry.advances.delete(key);
      }
    },
    buckets(id, now) {
      const advances = entries.get(id)?.advances;
      const current = Math.floor(now / ACTIVITY_BUCKET_MS);
      return Array.from({ length: ACTIVITY_BUCKETS }, (_, index) =>
        Math.min(1, (advances?.get(current - (ACTIVITY_BUCKETS - 1 - index)) ?? 0) / FULL_BUCKET_ADVANCES));
    },
  };
}
