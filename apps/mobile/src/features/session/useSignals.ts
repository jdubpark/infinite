import { useRef } from "react";
import type { SignalEvent } from "@infinite/attention";
import { api, type Connection, type LogEvent } from "../../api/client";
import { useLive } from "../../api/useLive";
import { hasExitedLifecycle, mergeSignalEvents } from "./liveState";

type Page = { events: LogEvent[]; cursor: number; more: boolean };
type LiveSession = { state: unknown; events: Page };
type SignalSnapshot = { id: string; events: SignalEvent[]; exited: boolean };
const emptySnapshot = (id: string): SignalSnapshot => ({ id, events: [], exited: false });

/** Signal history follows the session stream and resumes after its last received event cursor. */
export function useSignals(connection: Connection, id: string): { events: SignalEvent[]; loading: boolean } {
  const cursor = useRef<{ id: string; value: number }>({ id, value: 0 });
  const snapshot = useRef<SignalSnapshot | null>(null);
  const feed = useLive<SignalSnapshot>(connection, {
    topics: [`session/${id}`], intervalMs: 1500, deps: [id],
    after: () => cursor.current.id === id ? cursor.current.value : 0,
    continuePolling: value => !value?.exited,
    async load() {
      const previous = snapshot.current?.id === id ? snapshot.current : emptySnapshot(id);
      if (cursor.current.id !== id) cursor.current = { id, value: 0 };
      let after = cursor.current.value;
      let events = previous.events;
      let exited = previous.exited;
      let more = false;
      do {
        const page = await api<Page>(connection, `/sessions/${id}/events?after=${after}&limit=200&types=signal,lifecycle,input-intent,input-result`);
        after = page.cursor;
        events = mergeSignalEvents(events, page.events.filter(event => event.type === "signal").map(event => event as unknown as SignalEvent));
        exited ||= hasExitedLifecycle(page.events);
        more = page.more;
      } while (more);
      const latest = snapshot.current?.id === id ? snapshot.current : previous;
      const next = { id, events: mergeSignalEvents(latest.events, events), exited: latest.exited || exited };
      if (cursor.current.id === id) {
        cursor.current = { id, value: Math.max(cursor.current.value, after) };
        snapshot.current = next;
      }
      return next;
    },
    select(topic, payload, previous) {
      if (topic !== `session/${id}`) return;
      const live = payload as LiveSession;
      if (cursor.current.id !== id) cursor.current = { id, value: 0 };
      cursor.current = { id, value: Math.max(cursor.current.value, live.events.cursor) };
      const fresh = live.events.events.filter(event => event.type === "signal").map(event => event as unknown as SignalEvent);
      const base = snapshot.current?.id === id ? snapshot.current : previous?.id === id ? previous : emptySnapshot(id);
      const next = { id, events: mergeSignalEvents(base.events, fresh), exited: base.exited || hasExitedLifecycle(live.events.events) };
      snapshot.current = next;
      return next;
    },
  });
  const data = feed.data?.id === id ? feed.data : null;
  return { events: data?.events ?? [], loading: feed.loading };
}
