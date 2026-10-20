import { useCallback, useEffect, useRef, useState } from "react";
import { openEvents, type Connection } from "./client";
import { APP_BACKGROUND_GRACE_MS, inForeground, onForegroundChange } from "./foreground";
import { canUseLiveFallback, invalidatesLiveLoad, isLiveOnline, LIVE_STALE_DELAY_MS, shouldMarkLiveStale, shouldRetryEmptyLiveLoad } from "./liveStatus";

type Consumer = { after: () => number; onEvent(event: { topic: string; data: unknown }): void; onClose(): void; onRestart(): void; onOpen(): void };
type SharedStream = { consumers: Set<Consumer>; stream?: { close(): void }; opening?: Promise<void>; restarting?: Promise<void>; generation: number };
const streams = new Map<string, SharedStream>();
function subscribeShared(connection: Connection, topics: string[], consumer: Consumer): { ready: Promise<void>; isCurrent(): boolean; close(): void; restart(): Promise<void> } {
  const key = `${connection.url}/${connection.relay?.machineId ?? "direct"}/${connection.token}/${[...topics].sort().join(",")}`;
  let shared = streams.get(key);
  if (!shared) { shared = { consumers: new Set(), generation: 0 }; streams.set(key, shared); }
  shared.consumers.add(consumer);
  const current = shared;
  const connect = () => {
    if (current.stream || current.opening) return current.opening ?? Promise.resolve();
    const generation = current.generation;
    const after = Math.min(...[...current.consumers].map(item => item.after()));
    const opening = openEvents(connection, {
      topics,
      after,
      onEvent: event => { if (current.generation === generation) for (const item of current.consumers) item.onEvent(event); },
      onClose: () => { if (current.generation === generation) { current.stream = undefined; for (const item of current.consumers) item.onClose(); } },
    }).then(stream => { if (current.generation === generation && current.consumers.size) current.stream = stream; else stream.close(); }, error => { if (current.opening === opening) current.opening = undefined; throw error; });
    current.opening = opening;
    void opening.finally(() => { if (current.opening === opening) current.opening = undefined; }).catch(() => {});
    return opening;
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; current.consumers.delete(consumer);
    if (!current.consumers.size) {
      current.stream?.close(); current.stream = undefined;
      streams.delete(key);
    }
  };
  const restart = () => {
    if (closed || !current.consumers.has(consumer)) return Promise.resolve();
    if (current.restarting) return current.restarting;
    current.generation++;
    const generation = current.generation;
    current.opening = undefined;
    current.stream?.close(); current.stream = undefined;
    for (const item of [...current.consumers]) item.onRestart();
    const restarting = connect().then(() => {
      if (current.generation === generation) for (const item of [...current.consumers]) item.onOpen();
    }, error => {
      if (current.generation === generation) for (const item of [...current.consumers]) item.onClose();
      throw error;
    });
    current.restarting = restarting;
    void restarting.finally(() => { if (current.restarting === restarting) current.restarting = undefined; }).catch(() => {});
    return restarting;
  };
  const readyGeneration = current.generation;
  const ready = connect();
  const isCurrent = () => current.generation === readyGeneration && current.stream !== undefined && current.consumers.has(consumer) && !closed;
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

/** Event driven data with the existing polling result contract and a bounded fallback. */
export function useLive<T>(connection: Connection, options: LiveOptions<T>): {
  data: T | null; online: boolean; stale: boolean; loading: boolean; refreshing: boolean; seen: string; refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null), [online, setOnline] = useState(false), [stale, setStale] = useState(false), [seen, setSeen] = useState("");
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const current = useRef(options), value = useRef<T | null>(null), refreshRef = useRef<() => void>(() => {});
  useEffect(() => { current.current = options; });
  const topicsKey = options.topics.join(",");
  useEffect(() => {
    let active = true, appActive = inForeground(), streamUp = false, lastLoadOk = false, connecting = false, polling = false, appRevision = 0;
    let backgroundedAt: number | null = appActive ? null : Date.now();
    let resumeCatchup = false, resumeEventSeen = false;
    let unsubscribe: (() => void) | undefined, restartShared: (() => Promise<void>) | undefined, fallback: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, staleTimer: ReturnType<typeof setTimeout> | undefined, backgroundGrace: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 500, revision = 0, pollAgain = false;
    let offlineSince: number | null = null;
    const stamp = () => new Date().toLocaleTimeString();
    const clearTimers = () => { clearTimeout(fallback); clearTimeout(retry); fallback = retry = undefined; };
    const onlineNow = () => isLiveOnline(streamUp && (!resumeCatchup || resumeEventSeen), lastLoadOk);
    const detach = () => {
      const close = unsubscribe; unsubscribe = undefined; restartShared = undefined; close?.();
    };
    const delayStale = () => {
      if (!appActive || onlineNow() || staleTimer !== undefined) return;
      offlineSince ??= Date.now();
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        if (active && appActive && !onlineNow() && shouldMarkLiveStale(offlineSince, Date.now())) setStale(true);
      }, LIVE_STALE_DELAY_MS);
    };
    const markOnline = () => {
      clearTimeout(staleTimer); staleTimer = undefined; offlineSince = null;
      setStale(false); setOnline(true);
    };
    const updateOnline = () => {
      if (onlineNow()) markOnline();
      else { setOnline(false); delayStale(); }
    };
    const load = async (manual = false) => {
      if (!active || !appActive) return;
      if (polling) { pollAgain = true; return; }
      polling = true;
      const resumeLoad = resumeCatchup;
      const readRevision = revision;
      if (manual) setRefreshing(true);
      try {
        const next = await current.current.load();
        if (active && readRevision === revision) {
          value.current = next; setData(next); setSeen(stamp());
          lastLoadOk = true; updateOnline();
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
        if (active) { setLoading(false); if (manual) setRefreshing(false); }
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
            if (next !== undefined) { value.current = next; setData(next); setLoading(false); }
            setSeen(stamp());
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
            streamUp = true; lastLoadOk = false; retryMs = 500; clearTimers(); markOnline(); setSeen(stamp());
          },
        });
        unsubscribe = attached.close; restartShared = attached.restart;
        await attached.ready;
        if (!active || !appActive || connectRevision !== appRevision) { attached.close(); return; }
        if (!attached.isCurrent()) { waitingForSharedRestart = Boolean(restartShared); return; }
        streamUp = true; lastLoadOk = false; retryMs = 500; clearTimers(); markOnline(); setSeen(stamp());
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
      setOnline(false); delayStale();
      if (restartShared) void restartShared().catch(() => {});
      else { detach(); void connect(); }
    };
    refreshRef.current = () => { void load(true); };
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
        setStale(false); setOnline(false); offlineSince = Date.now(); delayStale();
        void load();
      } else {
        const restart = streamUp && awayFor >= APP_BACKGROUND_GRACE_MS ? restartShared : undefined;
        if (streamUp) {
          streamUp = false; lastLoadOk = false;
          if (!restart) detach();
        }
        lastLoadOk = false;
        setOnline(false);
        setStale(false);
        offlineSince = Date.now();
        delayStale();
        if (restart) void restart().catch(() => {});
        else { detach(); void connect(); }
      }
    });
    return () => {
      active = false; clearTimers(); clearTimeout(staleTimer); clearTimeout(backgroundGrace); detach(); removeForegroundListener(); refreshRef.current = () => {};
    };
    // The caller owns the dependency list; callbacks are read through current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, topicsKey, options.intervalMs, ...options.deps]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, online, stale: stale && !online, loading, refreshing, seen, refresh };
}
