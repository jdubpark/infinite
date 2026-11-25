import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { openEvents, type Connection } from "./client";
import { APP_BACKGROUND_GRACE_MS, inForeground, onForegroundChange } from "./foreground";
import { canUseLiveFallback, invalidatesLiveLoad, isLiveOnline, LIVE_STALE_DELAY_MS, shouldMarkLiveStale, shouldRetryEmptyLiveLoad } from "./liveStatus";

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

type Consumer = { after: () => number; onEvent(event: { topic: string; data: unknown }): void; onClose(): void; onRestart(): void; onOpen(): void };
type StreamPhase =
  | { kind: "idle" }
  | { kind: "opening"; promise: Promise<void> }
  | { kind: "live"; stream: { close(): void } }
  | { kind: "restarting"; promise: Promise<void> };
type SharedStream = { consumers: Set<Consumer>; phase: StreamPhase; generation: number };
const streams = new Map<string, SharedStream>();
function subscribeShared(connection: Connection, topics: string[], consumer: Consumer): { ready: Promise<void>; isCurrent(): boolean; close(): void; restart(): Promise<void> } {
  const key = `${connection.url}/${connection.relay?.machineId ?? "direct"}/${connection.token}/${[...topics].sort().join(",")}`;
  let shared = streams.get(key);
  if (!shared) { shared = { consumers: new Set(), phase: { kind: "idle" }, generation: 0 }; streams.set(key, shared); }
  shared.consumers.add(consumer);
  const current = shared;
  const startOpen = (restarting: boolean) => {
    const generation = current.generation;
    const after = Math.min(...[...current.consumers].map(item => item.after()));
    const promise = openEvents(connection, {
      topics,
      after,
      onEvent: event => { if (current.generation === generation) for (const item of current.consumers) item.onEvent(event); },
      onClose: () => {
        if (current.generation === generation) {
          current.phase = { kind: "idle" };
          for (const item of current.consumers) item.onClose();
        }
      },
    }).then(stream => {
      if (current.generation === generation && current.consumers.size) {
        current.phase = { kind: "live", stream };
        if (restarting) for (const item of [...current.consumers]) item.onOpen();
      } else {
        stream.close();
        if (current.generation === generation && current.phase.kind !== "idle") current.phase = { kind: "idle" };
      }
    }, error => {
      if (current.generation === generation) {
        current.phase = { kind: "idle" };
        if (restarting) for (const item of [...current.consumers]) item.onClose();
      }
      throw error;
    });
    current.phase = restarting ? { kind: "restarting", promise } : { kind: "opening", promise };
    void promise.catch(() => {});
    return promise;
  };
  const connect = () => {
    switch (current.phase.kind) {
      case "live": return Promise.resolve();
      case "opening":
      case "restarting":
        return current.phase.promise;
      case "idle":
        return startOpen(false);
    }
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; current.consumers.delete(consumer);
    if (!current.consumers.size) {
      if (current.phase.kind === "live") current.phase.stream.close();
      current.phase = { kind: "idle" };
      streams.delete(key);
    }
  };
  const restart = () => {
    if (closed || !current.consumers.has(consumer)) return Promise.resolve();
    if (current.phase.kind === "restarting") return current.phase.promise;
    current.generation++;
    if (current.phase.kind === "live") current.phase.stream.close();
    current.phase = { kind: "idle" };
    for (const item of [...current.consumers]) item.onRestart();
    return startOpen(true);
  };
  const readyGeneration = current.generation;
  const ready = connect();
  const isCurrent = () => current.generation === readyGeneration && current.phase.kind === "live" && current.consumers.has(consumer) && !closed;
  return { ready, isCurrent, close, restart };
}

type LiveOptions<T> = {
  topics: string[];
  intervalMs: number;
  deps: unknown[];
  load(): Promise<T>;
  select(topic: string, payload: unknown, previous: T | null): T | undefined;
  after?: () => number;
  refreshOnEvent?: boolean | ((topic: string, payload: unknown) => boolean);
  continuePolling?: (data: T | null) => boolean;
};

export function useLive<T>(connection: Connection, options: LiveOptions<T>): {
  data: T | null; online: boolean; stale: boolean; loading: boolean; refreshing: boolean; seen: string; refresh: () => void;
} {
  const [freshness, setFreshness] = useState<Freshness<T>>({ kind: "loading" });
  const current = useRef(options), value = useRef<T | null>(null), hasValue = useRef(false), refreshRef = useRef<() => void>(() => {});
  const focused = useIsFocused(), blurred = useRef(false);
  useEffect(() => { current.current = options; });
  const topicsKey = options.topics.join(",");
  useEffect(() => {
    if (!focused) {
      blurred.current = true;
      refreshRef.current = () => {};
      return;
    }
    const refocused = blurred.current;
    blurred.current = false;
    let active = true, appActive = inForeground(), streamUp = false, lastLoadOk = false, connecting = false, polling = false, appRevision = 0;
    let backgroundedAt: number | null = appActive ? null : Date.now();
    let resumeCatchup = false, resumeEventSeen = false;
    let unsubscribe: (() => void) | undefined, restartShared: (() => Promise<void>) | undefined, fallback: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, staleTimer: ReturnType<typeof setTimeout> | undefined, backgroundGrace: ReturnType<typeof setTimeout> | undefined;
    let resumeStateTimer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 500, revision = 0, pollAgain = false;
    let offlineSince: number | null = null;
    const stamp = () => new Date().toLocaleTimeString();
    const clearTimers = () => { clearTimeout(fallback); clearTimeout(retry); fallback = retry = undefined; };
    const onlineNow = () => isLiveOnline(streamUp && (!resumeCatchup || resumeEventSeen), lastLoadOk);
    const detach = () => {
      const close = unsubscribe; unsubscribe = undefined; restartShared = undefined; close?.();
    };
    const toOffline = (stale?: boolean) => {
      setFreshness(prev => {
        switch (prev.kind) {
          case "loading": return prev;
          case "online": return { kind: "offline", data: prev.data, seen: prev.seen, stale: stale ?? false, refreshing: prev.refreshing };
          case "offline": return stale === undefined || prev.stale === stale ? prev : { ...prev, stale };
        }
      });
    };
    const setSeenOnly = (seen: string) => {
      setFreshness(prev => {
        switch (prev.kind) {
          case "loading": return prev;
          case "online": return { ...prev, seen };
          case "offline": return { ...prev, seen };
        }
      });
    };
    const delayStale = () => {
      if (!appActive || onlineNow() || staleTimer !== undefined) return;
      offlineSince ??= Date.now();
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        if (active && appActive && !onlineNow() && shouldMarkLiveStale(offlineSince, Date.now())) toOffline(true);
      }, LIVE_STALE_DELAY_MS);
    };
    const markOnline = (seenOverride?: string) => {
      clearTimeout(staleTimer); staleTimer = undefined; offlineSince = null;
      if (!hasValue.current) {
        if (seenOverride !== undefined) setSeenOnly(seenOverride);
        return;
      }
      const data = value.current as T;
      setFreshness(prev => ({
        kind: "online",
        data,
        seen: seenOverride ?? (prev.kind === "loading" ? stamp() : prev.seen),
        refreshing: prev.kind === "loading" ? false : prev.refreshing,
      }));
    };
    const updateOnline = (seenOverride?: string) => {
      if (onlineNow()) markOnline(seenOverride);
      else { toOffline(); delayStale(); }
    };
    const load = async (manual = false) => {
      if (!active || !appActive) return;
      if (polling) { pollAgain = true; return; }
      polling = true;
      const resumeLoad = resumeCatchup;
      const readRevision = revision;
      if (manual) {
        setFreshness(prev => {
          switch (prev.kind) {
            case "loading": return prev;
            case "online":
            case "offline":
              return prev.refreshing ? prev : { ...prev, refreshing: true };
          }
        });
      }
      try {
        const next = await current.current.load();
        if (active && readRevision === revision) {
          hasValue.current = true;
          value.current = next;
          lastLoadOk = true;
          updateOnline(stamp());
          if (resumeLoad) {
            resumeCatchup = false;
            if (resumeEventSeen) reconnectAfterResume();
          }
        }
      } catch {
        if (active && readRevision === revision && !streamUp) { lastLoadOk = false; updateOnline(); }
        if (resumeLoad && active && appActive && readRevision === revision) {
          recoverAfterResumeFailure();
        }
      }
      finally {
        polling = false;
        if (active) {
          setFreshness(prev => {
            switch (prev.kind) {
              case "loading":
                return { kind: "offline", data: null, seen: "", stale: false, refreshing: false };
              case "online":
              case "offline":
                return manual && prev.refreshing ? { ...prev, refreshing: false } : prev;
            }
          });
        }
        if ((pollAgain || shouldRetryEmptyLiveLoad(readRevision !== revision, value.current)) && active && appActive) {
          pollAgain = false; void load();
        }
      }
    };
    const scheduleFallback = () => {
      clearTimeout(fallback);
      if (!canUseLiveFallback(value.current, current.current.continuePolling)) return;
      fallback = setTimeout(() => {
        if (!active || !appActive || streamUp || !canUseLiveFallback(value.current, current.current.continuePolling)) return;
        void load().finally(() => { if (active && appActive && !streamUp) scheduleFallback(); });
      }, current.current.intervalMs);
    };
    const scheduleRetry = () => {
      clearTimeout(retry);
      retry = setTimeout(() => { retry = undefined; void connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    };
    const failed = () => {
      if (!active || !appActive) return;
      streamUp = false; detach(); updateOnline();
      if (canUseLiveFallback(value.current, current.current.continuePolling)) void load();
      scheduleFallback(); scheduleRetry();
    };
    const connect = async () => {
      if (!active || !appActive || connecting || streamUp) return;
      connecting = true;
      const connectRevision = appRevision;
      let waitingForSharedRestart = false;
      try {
        const attached = subscribeShared(connection, current.current.topics, {
          after: () => current.current.after?.() ?? 0,
          onEvent(event) {
            if (!active || !appActive) return;
            if (resumeCatchup) { resumeEventSeen = true; markOnline(); return; }
            const next = current.current.select(event.topic, event.data, value.current);
            const refreshOnEvent = typeof current.current.refreshOnEvent === "function"
              ? current.current.refreshOnEvent(event.topic, event.data)
              : current.current.refreshOnEvent;
            if (invalidatesLiveLoad(next, value.current)) revision++;
            const nextSeen = stamp();
            if (next !== undefined) {
              hasValue.current = true;
              value.current = next;
              markOnline(nextSeen);
            } else {
              setSeenOnly(nextSeen);
            }
            if (next === undefined || refreshOnEvent) void load();
          },
          onClose() {
            streamUp = false;
            if (!active) return;
            if (appActive) failed();
            else detach();
          },
          onRestart() {
            revision++;
            resumeCatchup = false; resumeEventSeen = false;
            streamUp = false; clearTimers();
            if (!lastLoadOk) updateOnline();
          },
          onOpen() {
            if (!active || !appActive) return;
            streamUp = true; lastLoadOk = false; retryMs = 500; clearTimers(); markOnline(stamp());
          },
        });
        unsubscribe = attached.close; restartShared = attached.restart;
        await attached.ready;
        if (!active || !appActive || connectRevision !== appRevision) { attached.close(); return; }
        if (!attached.isCurrent()) { waitingForSharedRestart = Boolean(restartShared); return; }
        streamUp = true; lastLoadOk = false; retryMs = 500; clearTimers(); markOnline(stamp());
      } catch { failed(); }
      finally {
        connecting = false;
        if (active && appActive && !streamUp && !retry && !waitingForSharedRestart) retry = setTimeout(() => { retry = undefined; void connect(); }, 0);
      }
    };
    const reconnectAfterResume = () => {
      resumeCatchup = false; resumeEventSeen = false;
      if (restartShared) void restartShared().catch(() => {});
      else { streamUp = false; detach(); void connect(); }
    };
    const recoverAfterResumeFailure = () => {
      resumeCatchup = false; resumeEventSeen = false;
      streamUp = false; lastLoadOk = false;
      clearTimers();
      toOffline(); delayStale();
      if (restartShared) void restartShared().catch(() => {});
      else { detach(); void connect(); }
    };
    refreshRef.current = () => { void load(true); };
    if (refocused && appActive) {
      resumeStateTimer = setTimeout(() => {
        if (!active || !appActive) return;
        if (!onlineNow()) toOffline(false);
      }, 0);
      offlineSince = Date.now();
      delayStale();
    }
    void load();
    void connect();
    const removeForegroundListener = onForegroundChange(foreground => {
      appRevision++;
      revision++;
      appActive = foreground;
      if (!foreground) {
        backgroundedAt = Date.now();
        resumeCatchup = false; resumeEventSeen = false;
        clearTimers();
        clearTimeout(staleTimer); staleTimer = undefined;
        clearTimeout(backgroundGrace); backgroundGrace = undefined;
        if (streamUp) backgroundGrace = setTimeout(() => {
          backgroundGrace = undefined;
          if (!active || appActive || !streamUp) return;
          streamUp = false; lastLoadOk = false;
          detach();
        }, APP_BACKGROUND_GRACE_MS);
        return;
      }
      const awayFor = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
      backgroundedAt = null;
      clearTimeout(backgroundGrace); backgroundGrace = undefined;
      if (streamUp && awayFor < APP_BACKGROUND_GRACE_MS) {
        resumeCatchup = true; resumeEventSeen = false;
        lastLoadOk = false;
        toOffline(false); offlineSince = Date.now(); delayStale();
        void load();
      } else {
        const restart = streamUp && awayFor >= APP_BACKGROUND_GRACE_MS ? restartShared : undefined;
        if (streamUp) {
          streamUp = false; lastLoadOk = false;
          if (!restart) detach();
        }
        lastLoadOk = false;
        toOffline(false);
        offlineSince = Date.now();
        delayStale();
        if (restart) void restart().catch(() => {});
        else { detach(); void connect(); }
      }
    });
    return () => {
      active = false; clearTimers(); clearTimeout(staleTimer); clearTimeout(backgroundGrace); clearTimeout(resumeStateTimer); detach(); removeForegroundListener(); refreshRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, connection, topicsKey, options.intervalMs, ...options.deps]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...freshnessView(freshness), refresh };
}
