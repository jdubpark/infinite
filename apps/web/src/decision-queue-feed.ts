import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getDecisionQueue, type Api, type DecisionQueue } from "./api";
import { settleAnsweredKeys } from "./decision-queue-model";
import { foreground, useLiveRefresh } from "./live-refresh";

/** How long past the time the next read was due the last queue still counts as the host's current answer. */
export const QUEUE_READ_GRACE_MS = 3000;

/**
 * The host's decision queue for one identity (a machine and a role). `queue` is the last answer the host gave. It
 * stays while a later read is in flight or fails. `current` says whether it still is the host's answer: the last read
 * succeeded, and the next one is not overdue. A decision the person answered here is hidden at once, and a read that
 * began after the answer settles it.
 */
export function useDecisionQueueFeed(request: Api, identity: string | null, interval: number) {
  const readNumber = useRef(0);
  const answered = useRef(new Map<string, number>());
  const [answeredVersion, setAnsweredVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ identity: string; queue: DecisionQueue; at: string; read: number }>();
  const [failure, setFailure] = useState<{ identity: string; since: string; unavailable: boolean }>();
  const [overdueRead, setOverdueRead] = useState(0);
  const feed = useLiveRefresh(async current => {
    const read = ++readNumber.current;
    try {
      const queue = await getDecisionQueue(request);
      if (!current() || !identity) return;
      const settled = settleAnsweredKeys(answered.current, read, new Set(queue.decisions.map(decision => decision.key)));
      const changed = settled.size !== answered.current.size;
      answered.current = settled;
      setSnapshot({ identity, queue, at: new Date().toISOString(), read });
      setFailure(undefined);
      if (changed) setAnsweredVersion(version => version + 1);
    } catch (error) {
      if (current() && identity) {
        // A host without the route answers 404. That says the queue is not there, not that a read went wrong.
        const unavailable = error instanceof ApiError && error.status === 404;
        setFailure(previous => previous?.identity === identity && previous.unavailable === unavailable ? previous
          : { identity, since: previous?.identity === identity ? previous.since : new Date().toISOString(), unavailable });
      }
      throw error;
    }
  }, interval, identity);
  useEffect(() => {
    if (identity && feed.failed) setFailure(previous => previous?.identity === identity ? previous : { identity, since: new Date().toISOString(), unavailable: false });
  }, [feed.failed, identity]);
  useEffect(() => () => { answered.current = new Map(); }, [identity]);
  const confirmAnswered = (key: string) => {
    // A read already in flight began before the answer, so the first read that can settle the key is the next one.
    answered.current = new Map(answered.current).set(key, readNumber.current + 1);
    setAnsweredVersion(version => version + 1);
  };
  const known = identity && snapshot?.identity === identity ? snapshot : undefined;
  // A read that fails is reported by the refresh itself. A read that only has not come back is not, so the queue
  // also stops being current once the next read is QUEUE_READ_GRACE_MS overdue. A hidden or offline tab reads
  // nothing and sets no such mark: its return starts a read, and the refresh reports that one.
  useEffect(() => {
    if (!known) return;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => setOverdueRead(known.read), interval + QUEUE_READ_GRACE_MS);
    const cancel = () => { if (!foreground()) { clearTimeout(timer); timer = undefined; } };
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("offline", cancel);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", cancel);
      window.removeEventListener("offline", cancel);
    };
  }, [known, interval]);
  const overdue = known !== undefined && overdueRead === known.read;
  const queue = useMemo(
    () => known ? { decisions: known.queue.decisions.filter(decision => !answered.current.has(decision.key)) } : null,
    [answeredVersion, known],
  );
  return {
    ...feed,
    queue,
    readAt: known?.at ?? "",
    /** True while `queue` is the host's current answer. Nothing is answered otherwise. */
    current: known !== undefined && feed.fresh && !feed.failed && !overdue,
    /** True once the queue has gone without a refresh for about three seconds. */
    stale: feed.stale || overdue,
    confirmAnswered,
    failureSince: identity && failure?.identity === identity ? failure.since : "",
    /** True when the host has no decision queue route. */
    unavailable: Boolean(identity && failure?.identity === identity && failure.unavailable),
  };
}
