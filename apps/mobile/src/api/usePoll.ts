import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { inForeground, onForegroundChange } from "./foreground";

export type Freshness<T> =
  | { kind: "loading" }
  | { kind: "online"; data: T; seen: string; refreshing: boolean }
  | { kind: "offline"; data: T | null; seen: string; stale: boolean; refreshing: boolean };

function freshnessView<T>(
  freshness: Freshness<T>,
): { data: T | null; online: boolean; stale: boolean; loading: boolean; refreshing: boolean; seen: string } {
  switch (freshness.kind) {
    case "loading":
      return { data: null, online: false, stale: false, loading: true, refreshing: false, seen: "" };
    case "online":
      return { data: freshness.data, online: true, stale: false, loading: false, refreshing: freshness.refreshing, seen: freshness.seen };
    case "offline":
      return { data: freshness.data, online: false, stale: freshness.stale, loading: false, refreshing: freshness.refreshing, seen: freshness.seen };
  }
}

type PollPhase =
  | { kind: "idle"; timer?: ReturnType<typeof setTimeout> }
  | { kind: "polling"; rerunRequested: boolean };

export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[],
): { data: T | null; online: boolean; stale: boolean; loading: boolean; refreshing: boolean; seen: string; refresh: () => void } {
  const [freshness, setFreshness] = useState<Freshness<T>>({ kind: "loading" });
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
    const refocused = blurred.current;
    blurred.current = false;
    let active = true;
    let generation = 0;
    let phase: PollPhase = { kind: "idle" };
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let resumeStateTimer: ReturnType<typeof setTimeout> | undefined;
    let staleDeadline = 0;
    const clearPollTimer = () => {
      if (phase.kind === "idle" && phase.timer !== undefined) {
        clearTimeout(phase.timer);
        phase.timer = undefined;
      }
    };
    const toOffline = (stale?: boolean) => {
      setFreshness((prev) => {
        switch (prev.kind) {
          case "loading":
            return stale ? { kind: "offline", data: null, seen: "", stale: true, refreshing: false } : prev;
          case "online":
            return { kind: "offline", data: prev.data, seen: prev.seen, stale: stale ?? false, refreshing: prev.refreshing };
          case "offline":
            return stale === undefined || prev.stale === stale ? prev : { ...prev, stale };
        }
      });
    };
    const scheduleStale = () => {
      clearTimeout(staleTimer);
      staleDeadline = Date.now() + 3000;
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        staleDeadline = 0;
        if (!active) return;
        onlineNow.current = false;
        toOffline(true);
      }, 3000);
    };
    const delayStale = () => {
      if (onlineNow.current || staleTimer !== undefined) return;
      if (!staleDeadline) staleDeadline = Date.now() + 3000;
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        staleDeadline = 0;
        if (active && !onlineNow.current) toOffline(true);
      }, Math.max(0, staleDeadline - Date.now()));
    };
    const poll = async () => {
      if (!active || !inForeground()) return;
      if (phase.kind === "polling") {
        phase.rerunRequested = true;
        return;
      }
      clearPollTimer();
      phase = { kind: "polling", rerunRequested: false };
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
          setFreshness({ kind: "online", data: value, seen: new Date().toLocaleTimeString(), refreshing: false });
        }
      } catch {
        if (current()) {
          onlineNow.current = false;
          toOffline();
          delayStale();
        }
      } finally {
        const rerun = phase.kind === "polling" && phase.rerunRequested;
        phase = { kind: "idle" };
        if (active) {
          setFreshness((prev) => {
            switch (prev.kind) {
              case "loading":
                return current() ? { kind: "offline", data: null, seen: "", stale: false, refreshing: false } : prev;
              case "online":
              case "offline":
                return prev.refreshing ? { ...prev, refreshing: false } : prev;
            }
          });
          if (inForeground()) phase = { kind: "idle", timer: setTimeout(poll, rerun ? 0 : intervalMs) };
        }
      }
    };
    pollNow.current = () => {
      clearPollTimer();
      if (inForeground()) {
        setFreshness((prev) => {
          switch (prev.kind) {
            case "loading":
              return prev;
            case "online":
            case "offline":
              return prev.refreshing ? prev : { ...prev, refreshing: true };
          }
        });
      }
      void poll();
    };
    const removeForegroundListener = onForegroundChange((foreground) => {
      generation++;
      clearPollTimer();
      clearTimeout(staleTimer);
      staleTimer = undefined;
      if (!foreground) return;

      const recentSuccess = Date.now() - lastSuccessAt.current <= intervalMs;
      if (!recentSuccess) {
        onlineNow.current = false;
        toOffline(false);
      }
      scheduleStale();
      void poll();
    });
    if (refocused && inForeground()) {
      resumeStateTimer = setTimeout(() => {
        if (!active || !inForeground()) return;
        if (Date.now() - lastSuccessAt.current > intervalMs) {
          onlineNow.current = false;
          toOffline(false);
        } else {
          setFreshness((prev) => (prev.kind === "offline" && prev.stale ? { ...prev, stale: false } : prev));
        }
      }, 0);
      scheduleStale();
    }
    void poll();
    return () => {
      active = false;
      clearPollTimer();
      clearTimeout(staleTimer);
      clearTimeout(resumeStateTimer);
      removeForegroundListener();
      pollNow.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, intervalMs, ...deps]);
  const refresh = useCallback(() => pollNow.current(), []);
  return { ...freshnessView(freshness), refresh };
}
