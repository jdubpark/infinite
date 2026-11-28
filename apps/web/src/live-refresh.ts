import { useCallback, useEffect, useRef, useState } from "react";

export const foreground = () => document.visibilityState !== "hidden" && navigator.onLine;

export function useLiveRefresh(
  task: (current: () => boolean) => Promise<number | void>,
  interval: number,
  identity: unknown,
  unavailable?: () => void,
) {
  const taskRef = useRef(task);
  const unavailableRef = useRef(unavailable);
  useEffect(() => {
    taskRef.current = task;
    unavailableRef.current = unavailable;
  });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const [fresh, setFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seen, setSeen] = useState("");
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let active = true, polling = false, queued = false, generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let waiters: (() => void)[] = [];
    const flushWaiters = () => {
      for (const resolve of waiters.splice(0)) resolve();
    };
    const markStaleLater = () => {
      if (!identity || staleTimer !== undefined) return;
      staleTimer = setTimeout(() => { staleTimer = undefined; if (active) setStale(true); }, 3000);
    };
    const recover = () => {
      clearTimeout(staleTimer);
      staleTimer = undefined;
      setStale(false);
    };
    setFresh(false);
    setFailed(false);
    setSeen("");
    setStale(false);
    const poll = async (): Promise<void> => {
      clearTimeout(timer);
      if (!active || !identity || !foreground()) return;
      if (polling) {
        queued = true;
        await new Promise<void>(resolve => waiters.push(resolve));
        return;
      }
      do {
        queued = false;
        const roundWaiters = waiters.splice(0);
        polling = true;
        setRefreshing(true);
        const started = generation;
        const current = () => active && foreground() && started === generation;
        let delay = interval;
        try {
          delay = await taskRef.current(current) ?? interval;
          if (current()) { recover(); setFresh(true); setFailed(false); setSeen(new Date().toISOString()); }
        } catch {
          if (current()) { setFresh(false); setFailed(true); markStaleLater(); unavailableRef.current?.(); }
        } finally {
          polling = false;
          if (active) setRefreshing(false);
        }
        for (const resolve of roundWaiters) resolve();
        if (!active || !foreground()) {
          flushWaiters();
          return;
        }
        if (!queued) {
          timer = setTimeout(() => { void poll(); }, delay);
          return;
        }
      } while (true);
    };
    const resync = () => {
      generation++;
      setFresh(false);
      if (document.visibilityState === "hidden") recover(); else markStaleLater();
      if (!navigator.onLine) setFailed(true);
      clearTimeout(timer);
      if (foreground()) void poll();
      else unavailableRef.current?.();
    };
    refreshRef.current = () => poll();
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("offline", resync);
    window.addEventListener("focus", resync);
    if (identity && !navigator.onLine) { setFailed(true); markStaleLater(); }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(staleTimer);
      flushWaiters();
      refreshRef.current = async () => {};
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("offline", resync);
      window.removeEventListener("focus", resync);
    };
  }, [identity, interval]);
  return { fresh, refreshing, seen, failed, stale, refresh: useCallback(() => refreshRef.current(), []) };
}

