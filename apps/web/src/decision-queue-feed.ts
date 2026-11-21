import { useEffect, useMemo, useRef, useState } from "react";
import { getDecisionQueue, type Api, type DecisionQueue } from "./api";
import { useLiveRefresh } from "./live-refresh";

export function useDecisionQueueFeed(request: Api, identity: string | null, interval: number) {
  const readNumber = useRef(0);
  const confirmed = useRef(new Map<string, number>());
  const [confirmedVersion, setConfirmedVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ identity: string; queue: DecisionQueue }>();
  const [failure, setFailure] = useState<{ identity: string; since: string }>();
  const feed = useLiveRefresh(async current => {
    const read = ++readNumber.current;
    try {
      const queue = await getDecisionQueue(request);
      if (current() && identity) {
        const liveKeys = new Set(queue.decisions.map(decision => decision.key));
        let changed = false;
        for (const [key, afterRead] of confirmed.current) {
          if (key.startsWith(`${identity}/`) && read >= afterRead && !liveKeys.has(key.slice(identity.length + 1))) {
            confirmed.current.delete(key);
            changed = true;
          }
        }
        setSnapshot({ identity, queue });
        setFailure(undefined);
        if (changed) setConfirmedVersion(version => version + 1);
      }
    } catch (error) {
      if (current() && identity) setFailure(previous => previous?.identity === identity ? previous : { identity, since: new Date().toISOString() });
      throw error;
    }
  }, interval, identity);
  useEffect(() => {
    if (identity && feed.failed) setFailure(previous => previous?.identity === identity ? previous : { identity, since: new Date().toISOString() });
  }, [feed.failed, identity]);
  useEffect(() => () => {
    for (const key of confirmed.current.keys()) if (key.startsWith(`${identity}/`)) confirmed.current.delete(key);
  }, [identity]);
  const confirmAnswered = (key: string) => {
    if (!identity) return;
    confirmed.current.set(`${identity}/${key}`, readNumber.current + 1);
    setConfirmedVersion(version => version + 1);
  };
  const queue = useMemo(() => {
    const rawQueue = identity && snapshot?.identity === identity ? snapshot.queue : null;
    if (!rawQueue) return null;
    const hidden = identity ? new Set([...confirmed.current.keys()].filter(key => key.startsWith(`${identity}/`)).map(key => key.slice(identity.length + 1))) : new Set<string>();
    return { decisions: rawQueue.decisions.filter(decision => !hidden.has(decision.key)) };
  }, [confirmedVersion, identity, snapshot]);
  return {
    ...feed,
    queue,
    confirmAnswered,
    failureSince: identity && failure?.identity === identity ? failure.since : "",
  };
}
