import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { openEvents, type Connection } from "./client";
import { canUseLiveFallback, invalidatesLiveLoad, isLiveOnline, LIVE_STALE_DELAY_MS, shouldMarkLiveStale, shouldRetryEmptyLiveLoad } from "./liveStatus";

type Consumer = { after: () => number; onEvent(event: { topic: string; data: unknown }): void; onClose(): void };
type SharedStream = { consumers: Set<Consumer>; stream?: { close(): void }; opening?: Promise<void> };
const streams = new Map<string, SharedStream>();

function subscribeShared(connection: Connection, topics: string[], consumer: Consumer): { ready: Promise<void>; close(): void } {
  const key = `${connection.url}/${connection.relay?.machineId ?? "direct"}/${connection.token}/${[...topics].sort().join(",")}`;
  let shared = streams.get(key);
  if (!shared) { shared = { consumers: new Set() }; streams.set(key, shared); }
  shared.consumers.add(consumer);
  const current = shared;
  const connect = () => {
    if (current.stream || current.opening) return current.opening ?? Promise.resolve();
    const after = Math.min(...[...current.consumers].map(item => item.after()));
    const opening = openEvents(connection, {
      topics,
      after,
      onEvent: event => { for (const item of current.consumers) item.onEvent(event); },
      onClose: () => { current.stream = undefined; for (const item of current.consumers) item.onClose(); },
    }).then(stream => { if (current.consumers.size) current.stream = stream; else stream.close(); }, error => { current.opening = undefined; throw error; });
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
  return { ready: connect(), close };
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
    let active = true, appActive = AppState.currentState === "active", streamUp = false, lastLoadOk = false, connecting = false, polling = false, appRevision = 0;
    let unsubscribe: (() => void) | undefined, fallback: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, staleTimer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 500, revision = 0, pollAgain = false;
    let offlineSince: number | null = null;
    const stamp = () => new Date().toLocaleTimeString();
    const clearTimers = () => { clearTimeout(fallback); clearTimeout(retry); fallback = retry = undefined; };
    const onlineNow = () => isLiveOnline(streamUp, lastLoadOk);
    const delayStale = () => {
      if (onlineNow() || staleTimer !== undefined) return;
      offlineSince ??= Date.now();
      staleTimer = setTimeout(() => {
        staleTimer = undefined;
        if (active && !onlineNow() && shouldMarkLiveStale(offlineSince, Date.now())) setStale(true);
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
      const readRevision = revision;
      if (manual) setRefreshing(true);
      try {
        const next = await current.current.load();
        if (active && readRevision === revision) {
          value.current = next; setData(next); setSeen(stamp());
          lastLoadOk = true; updateOnline();
        }
      } catch {
        if (active && readRevision === revision && !streamUp) { lastLoadOk = false; updateOnline(); }
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
      streamUp = false; unsubscribe?.(); unsubscribe = undefined; updateOnline();
      if (canUseLiveFallback(value.current, current.current.continuePolling)) void load();
      scheduleFallback(); scheduleRetry();
    };
    const connect = async () => {
      if (!active || !appActive || connecting || streamUp) return;
      connecting = true;
      const connectRevision = appRevision;
      try {
        const attached = subscribeShared(connection, current.current.topics, {
          after: () => current.current.after?.() ?? 0,
          onEvent(event) {
            if (!active || !appActive) return;
            const next = current.current.select(event.topic, event.data, value.current);
            const refreshOnEvent = typeof current.current.refreshOnEvent === "function"
              ? current.current.refreshOnEvent(event.topic, event.data)
              : current.current.refreshOnEvent;
            if (invalidatesLiveLoad(next, value.current)) revision++;
            if (next !== undefined) { value.current = next; setData(next); setLoading(false); }
            setSeen(stamp());
            if (next === undefined || refreshOnEvent) void load();
          },
          onClose() { if (active && appActive) failed(); },
        });
        unsubscribe = attached.close;
        await attached.ready;
        if (!active || !appActive || connectRevision !== appRevision) { attached.close(); return; }
        streamUp = true; lastLoadOk = false; retryMs = 500; clearTimers(); markOnline(); setSeen(stamp());
      } catch { failed(); }
      finally {
        connecting = false;
        if (active && appActive && !streamUp && !retry) retry = setTimeout(() => { retry = undefined; void connect(); }, 0);
      }
    };
    refreshRef.current = () => { void load(true); };
    void load();
    void connect();
    const listener = AppState.addEventListener("change", state => {
      appRevision++;
      revision++;
      appActive = state === "active";
      streamUp = false; lastLoadOk = false; setOnline(false); delayStale();
      if (!appActive) {
        clearTimers(); unsubscribe?.(); unsubscribe = undefined;
      } else { void load(); void connect(); }
    });
    return () => {
      active = false; clearTimers(); clearTimeout(staleTimer); unsubscribe?.(); listener.remove(); refreshRef.current = () => {};
    };
    // The caller owns the dependency list; callbacks are read through current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, topicsKey, options.intervalMs, ...options.deps]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, online, stale: stale && !online, loading, refreshing, seen, refresh };
}
