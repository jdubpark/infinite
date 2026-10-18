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
  const refreshRef = useRef<() => void>(() => {});
  const [fresh, setFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seen, setSeen] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, polling = false, queued = false, generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    setFresh(false);
    setFailed(false);
    setSeen("");
    const poll = async () => {
      clearTimeout(timer);
      if (!active || !identity || !foreground()) return;
      if (polling) { queued = true; return; }
      polling = true;
      setRefreshing(true);
      const started = generation;
      const current = () => active && foreground() && started === generation;
      let delay = interval;
      try {
        delay = await taskRef.current(current) ?? interval;
        if (current()) { setFresh(true); setFailed(false); setSeen(new Date().toISOString()); }
      } catch {
        if (current()) { setFresh(false); setFailed(true); unavailableRef.current?.(); }
      } finally {
        polling = false;
        if (active) {
          setRefreshing(false);
          if (foreground()) timer = setTimeout(poll, queued ? 0 : delay);
          queued = false;
        }
      }
    };
    const resync = () => {
      generation++;
      setFresh(false);
      if (!navigator.onLine) setFailed(true);
      clearTimeout(timer);
      if (foreground()) void poll();
      else unavailableRef.current?.();
    };
    refreshRef.current = () => { void poll(); };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("offline", resync);
    window.addEventListener("focus", resync);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = () => {};
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("offline", resync);
      window.removeEventListener("focus", resync);
    };
  }, [identity, interval]);
  return { fresh, refreshing, seen, failed, refresh: useCallback(() => refreshRef.current(), []) };
}

