import { useMemo, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { api, ApiError, connectionKey, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { runRequests } from "../../store/requests";
import { hideCompleted, QUEUE_COUNT_POLL_MS, QUEUE_SCREEN_POLL_MS, queueRequestKey, visibleDecisions, type DecisionQueue } from "./model";

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
  const machine = connectionKey(connection);
  const readNumber = useRef(0);
  const focused = useIsFocused();
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [settledFor, setSettledFor] = useState<Read | null>(null);
  const [blurredAt, setBlurredAt] = useState<{ data: Read | null } | null>(null);
  const poll = usePoll(async (): Promise<Read> => {
    const read = ++readNumber.current;
    return { queue: await readQueue(connection), read };
  }, QUEUE_SCREEN_POLL_MS, [connection]);
  if (poll.data !== settledFor) {
    setSettledFor(poll.data);
    if (poll.data?.queue) {
      const { read, queue } = poll.data;
      const next = hideCompleted(hidden, read, queue.decisions.map(decision => decision.key), key => runRequests.read(queueRequestKey(machine, key)).result !== undefined);
      if (next.size !== hidden.size || [...next].some(([key, value]) => hidden.get(key) !== value)) setHidden(next);
    }
  }
  if (!focused && !blurredAt) setBlurredAt({ data: poll.data });
  if (focused && blurredAt && poll.data !== blurredAt.data) setBlurredAt(null);
  const current = focused && !blurredAt;
  const confirmAnswered = (key: string) => {
    const first = readNumber.current + 1;
    setHidden(previous => new Map(previous).set(key, first));
  };
  const source = poll.data?.queue ?? null;
  const decisions = useMemo(() => source ? visibleDecisions(source, hidden) : null, [source, hidden]);
  return {
    decisions,
    unavailable: poll.data !== null && poll.data.queue === null,
    online: poll.online && current,
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
