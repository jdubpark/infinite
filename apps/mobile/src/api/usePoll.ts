import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { inForeground, onForegroundChange } from "./foreground";

/**
 * Polls `fn` every `intervalMs` while the app is in the foreground. The last
 * good value stays in `data` when a poll fails; `online` reports whether the
 * latest poll succeeded and `seen` is the local time of the last success.
 * Polling stops in the background and runs immediately on return. A recent
 * success keeps `online` unchanged during a brief switch; after a longer
 * absence, `online` stays false until the return poll succeeds. If no poll
 * succeeds within three seconds of returning, `online` turns false either way.
 * `stale` turns true only after three foreground seconds without a successful
 * poll.
 * `refresh()` cancels the pending timer and polls now (or right after the
 * poll in flight). The effect restarts when `intervalMs` or `deps` change.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[],
): { data: T | null; online: boolean; stale: boolean; loading: boolean; refreshing: boolean; seen: string; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [online, setOnline] = useState(false);
  const [stale, setStale] = useState(false);
  const [seen, setSeen] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(fn);
  const onlineNow = useRef(false);
  const lastSuccessAt = useRef(0);
  const pollNow = useRef<() => void>(() => {});
  const focused = useIsFocused();
  const blurred = useRef(false);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (!focused) {
      blurred.current = true;
      pollNow.current = () => {};
      return;
    }
    // Regaining focus is a return like foregrounding: a fresh view needs a poll that succeeds after it.
    const refocused = blurred.current;
    blurred.current = false;
    let active = true,
      polling = false,
      again = false,
      generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let resumeStateTimer: ReturnType<typeof setTimeout> | undefined;
    let staleDeadline = 0;
    const scheduleStale = () => {
      clearTimeout(staleTimer);
      staleDeadline = Date.now() + 3000;
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        staleDeadline = 0;
        if (!active) return;
        onlineNow.current = false;
        setOnline(false);
        setStale(true);
      }, 3000);
    };
    const delayStale = () => {
      if (onlineNow.current || staleTimer !== undefined) return;
      if (!staleDeadline) staleDeadline = Date.now() + 3000;
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        staleDeadline = 0;
        if (active && !onlineNow.current) setStale(true);
      }, Math.max(0, staleDeadline - Date.now()));
    };
    const poll = async () => {
      if (!active || !inForeground()) return;
      if (polling) {
        again = true;
        return;
      }
      polling = true;
      again = false;
      const revision = generation;
      const current = () => active && inForeground() && revision === generation;
      try {
        const value = await latest.current();
        if (current()) {
          lastSuccessAt.current = Date.now();
          onlineNow.current = true;
          clearTimeout(staleTimer);
          staleTimer = undefined;
          staleDeadline = 0;
          setStale(false);
          setData(value);
          setOnline(true);
          setSeen(new Date().toLocaleTimeString());
        }
      } catch {
        if (current()) {
          onlineNow.current = false;
          setOnline(false);
          delayStale();
        }
      } finally {
        polling = false;
        if (current()) setLoading(false);
        if (active) {
          setRefreshing(false);
          if (inForeground()) timer = setTimeout(poll, again ? 0 : intervalMs);
        }
      }
    };
    pollNow.current = () => {
      clearTimeout(timer);
      if (inForeground()) setRefreshing(true);
      void poll();
    };
    const removeForegroundListener = onForegroundChange((foreground) => {
      generation++;
      clearTimeout(timer);
      timer = undefined;
      clearTimeout(staleTimer);
      staleTimer = undefined;
      if (!foreground) return;

      const recentSuccess = Date.now() - lastSuccessAt.current <= intervalMs;
      if (!recentSuccess) {
        onlineNow.current = false;
        setOnline(false);
        setStale(false);
      }
      // A recent view expires after three foreground seconds without a fresh result too.
      scheduleStale();
      void poll();
    });
    if (refocused && inForeground()) {
      resumeStateTimer = setTimeout(() => {
        if (!active || !inForeground()) return;
        if (Date.now() - lastSuccessAt.current > intervalMs) {
          onlineNow.current = false;
          setOnline(false);
        }
        setStale(false);
      }, 0);
      scheduleStale();
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(staleTimer);
      clearTimeout(resumeStateTimer);
      removeForegroundListener();
      pollNow.current = () => {};
    };
    // The caller owns the dependency list; `fn` is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, intervalMs, ...deps]);
  const refresh = useCallback(() => pollNow.current(), []);
  return { data, online, stale: stale && !online, loading, refreshing, seen, refresh };
}
