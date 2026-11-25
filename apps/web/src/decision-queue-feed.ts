import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getDecisionQueue, type Api, type DecisionQueue } from "./api";
import { settleAnsweredKeys } from "./decision-queue-model";
import { foreground, useLiveRefresh } from "./live-refresh";

export const QUEUE_READ_GRACE_MS = 3000;

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
        const unavailable = error instanceof ApiError && error.status === 404;
        if (unavailable) setSnapshot(undefined);
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
    answered.current = new Map(answered.current).set(key, readNumber.current + 1);
    setAnsweredVersion(version => version + 1);
  };
  const known = identity && snapshot?.identity === identity ? snapshot : undefined;
  useEffect(() => {
    if (!known) return;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => setOverdueRead(known.read), interval + QUEUE_READ_GRACE_MS);
    const cancel = () => {
      if (foreground()) return;
      clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") setOverdueRead(0);
    };
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
    current: known !== undefined && feed.fresh && !feed.failed && !overdue,
    stale: feed.stale || overdue,
    confirmAnswered,
    failureSince: identity && failure?.identity === identity ? failure.since : "",
    unavailable: Boolean(identity && failure?.identity === identity && failure.unavailable),
  };
}
