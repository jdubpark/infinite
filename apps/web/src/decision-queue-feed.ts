import { useEffect, useMemo, useRef, useState } from "react";
import { getDecisionQueue, type Api, type DecisionQueue } from "./api";
import { settleAnsweredKeys } from "./decision-queue-model";
import { useLiveRefresh } from "./live-refresh";

/**
 * The host's decision queue for one identity (a machine and a role). `queue` is the last answer the host gave. It
 * stays while a later read is in flight or fails; `fresh`, `failed` and `stale` say whether it is current. A decision
 * the person answered here is hidden at once, and a read that began after the answer settles it.
 */
export function useDecisionQueueFeed(request: Api, identity: string | null, interval: number) {
  const readNumber = useRef(0);
  const answered = useRef(new Map<string, number>());
  const [answeredVersion, setAnsweredVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ identity: string; queue: DecisionQueue; at: string }>();
  const [failure, setFailure] = useState<{ identity: string; since: string }>();
  const feed = useLiveRefresh(async current => {
    const read = ++readNumber.current;
    try {
      const queue = await getDecisionQueue(request);
      if (!current() || !identity) return;
      const settled = settleAnsweredKeys(answered.current, read, new Set(queue.decisions.map(decision => decision.key)));
      const changed = settled.size !== answered.current.size;
      answered.current = settled;
      setSnapshot({ identity, queue, at: new Date().toISOString() });
      setFailure(undefined);
      if (changed) setAnsweredVersion(version => version + 1);
    } catch (error) {
      if (current() && identity) setFailure(previous => previous?.identity === identity ? previous : { identity, since: new Date().toISOString() });
      throw error;
    }
  }, interval, identity);
  useEffect(() => {
    if (identity && feed.failed) setFailure(previous => previous?.identity === identity ? previous : { identity, since: new Date().toISOString() });
  }, [feed.failed, identity]);
  useEffect(() => () => { answered.current = new Map(); }, [identity]);
  const confirmAnswered = (key: string) => {
    // A read already in flight began before the answer, so the first read that can settle the key is the next one.
    answered.current = new Map(answered.current).set(key, readNumber.current + 1);
    setAnsweredVersion(version => version + 1);
  };
  const known = identity && snapshot?.identity === identity ? snapshot : undefined;
  const queue = useMemo(
    () => known ? { decisions: known.queue.decisions.filter(decision => !answered.current.has(decision.key)) } : null,
    [answeredVersion, known],
  );
  return {
    ...feed,
    queue,
    readAt: known?.at ?? "",
    confirmAnswered,
    failureSince: identity && failure?.identity === identity ? failure.since : "",
  };
}
