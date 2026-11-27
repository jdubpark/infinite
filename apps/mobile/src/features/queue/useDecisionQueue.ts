import { useMemo, useRef, useState } from "react";
import { api, ApiError, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { QUEUE_COUNT_POLL_MS, QUEUE_SCREEN_POLL_MS, settleAnsweredKeys, visibleDecisions, type DecisionQueue } from "./model";

type Read = { queue: DecisionQueue | null; read: number };

async function readQueue(connection: Connection): Promise<DecisionQueue | null> {
  try {
    return await api<DecisionQueue>(connection, "/decision-queue");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function useDecisionQueue(connection: Connection) {
  const readNumber = useRef(0);
  const answered = useRef(new Map<string, number>());
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(() => new Map());
  const publish = (next: Map<string, number>) => {
    answered.current = next;
    setHidden(next);
  };
  const poll = usePoll(async (): Promise<Read> => {
    const read = ++readNumber.current;
    const queue = await readQueue(connection);
    if (queue) {
      const settled = settleAnsweredKeys(answered.current, read, new Set(queue.decisions.map(decision => decision.key)));
      if (settled.size !== answered.current.size) publish(settled);
    }
    return { queue, read };
  }, QUEUE_SCREEN_POLL_MS, [connection]);
  const confirmAnswered = (key: string) => {
    publish(new Map(answered.current).set(key, readNumber.current + 1));
  };
  const source = poll.data?.queue ?? null;
  const decisions = useMemo(() => source ? visibleDecisions(source, hidden) : null, [source, hidden]);
  return {
    decisions,
    unavailable: poll.data !== null && poll.data.queue === null,
    online: poll.online,
    stale: poll.stale,
    loading: poll.loading,
    refreshing: poll.refreshing,
    seen: poll.seen,
    refresh: poll.refresh,
    confirmAnswered,
  };
}

export function useDecisionCount(connection: Connection): { count: number | undefined; available: boolean } {
  const poll = usePoll(async () => (await readQueue(connection))?.decisions.length ?? null, QUEUE_COUNT_POLL_MS, [connection]);
  const known = poll.online && typeof poll.data === "number";
  return { count: known ? poll.data ?? undefined : undefined, available: poll.data !== null || !poll.online };
}
