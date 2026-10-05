import { useEffect, useState } from "react";
import { AppState } from "react-native";
import type { SignalEvent } from "@infinite/attention";
import { api, type Connection, type LogEvent } from "../../api/client";

const MAX_EVENTS = 2000;
const POLL_MS = 1500;
const TYPES = "signal,lifecycle,input-intent,input-result";

type Page = { events: LogEvent[]; cursor: number; more: boolean };

/**
 * Signal events for one session: pages from the start by cursor, then polls.
 * Only `signal` events are kept (newest 2,000); an `exited` lifecycle event
 * stops polling. Polling pauses while the app is backgrounded.
 */
export function useSignals(
  connection: Connection,
  id: string,
): { events: SignalEvent[]; loading: boolean } {
  // State is tagged with the feed it belongs to, so a new connection or id
  // starts empty without a synchronous reset inside the effect.
  const feed = `${connection.url}\n${connection.token}\n${id}`;
  const [state, setState] = useState<{
    feed: string;
    events: SignalEvent[];
    loading: boolean;
  }>({ feed, events: [], loading: true });
  useEffect(() => {
    let active = true,
      running = false,
      exited = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!active || exited || running || AppState.currentState !== "active")
        return;
      running = true;
      let more = false;
      try {
        do {
          const page = await api<Page>(
            connection,
            `/sessions/${id}/events?after=${cursor}&limit=200&types=${TYPES}`,
          );
          if (!active) return;
          cursor = page.cursor;
          more = page.more;
          const fresh = page.events
            .filter((e) => e.type === "signal")
            .map((e) => e as unknown as SignalEvent);
          if (
            page.events.some(
              (e) =>
                e.type === "lifecycle" &&
                (e.data as { status?: string })?.status === "exited",
            )
          )
            exited = true;
          setState((prev) => {
            const base = prev.feed === feed ? prev.events : [];
            return {
              feed,
              loading: more,
              events: fresh.length
                ? [...base, ...fresh].slice(-MAX_EVENTS)
                : base,
            };
          });
        } while (more);
      } catch {
        // Keep what we have; the next tick retries from the same cursor.
        if (active)
          setState((prev) =>
            prev.feed === feed
              ? { ...prev, loading: false }
              : { feed, events: [], loading: false },
          );
      } finally {
        running = false;
        if (active && !exited) timer = setTimeout(tick, POLL_MS);
      }
    };
    const listener = AppState.addEventListener("change", (state) => {
      clearTimeout(timer);
      if (state === "active") void tick();
    });
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
      listener.remove();
    };
  }, [connection, id, feed]);
  return state.feed === feed
    ? { events: state.events, loading: state.loading }
    : { events: [], loading: true };
}
