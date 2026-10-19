import { useRef } from "react";
import type { SignalEvent } from "@infinite/attention";
import { api, type Connection, type LogEvent } from "../../api/client";
import { useLive } from "../../api/useLive";

const MAX_EVENTS = 2000;
type Page = { events: LogEvent[]; cursor: number; more: boolean };
type LiveSession = { state: unknown; events: Page };

/** Signal history follows the session stream and resumes after its last received event cursor. */
export function useSignals(connection: Connection, id: string): { events: SignalEvent[]; loading: boolean } {
  const cursor = useRef(0);
  const feed = useLive<SignalEvent[]>(connection, {
    topics: [`session/${id}`], intervalMs: 1500, deps: [id], after: () => cursor.current,
    async load() {
      const events: SignalEvent[] = [];
      let more = false;
      do {
        const page = await api<Page>(connection, `/sessions/${id}/events?after=${cursor.current}&limit=200&types=signal,lifecycle,input-intent,input-result`);
        cursor.current = page.cursor;
        events.push(...page.events.filter(event => event.type === "signal").map(event => event as unknown as SignalEvent));
        more = page.more;
      } while (more);
      return events.slice(-MAX_EVENTS);
    },
    select(topic, payload, previous) {
      if (topic !== `session/${id}`) return;
      const live = payload as LiveSession;
      cursor.current = Math.max(cursor.current, live.events.cursor);
      const fresh = live.events.events.filter(event => event.type === "signal").map(event => event as unknown as SignalEvent);
      return [...new Map([...(previous ?? []), ...fresh].map(event => [event.seq, event])).values()].slice(-MAX_EVENTS);
    },
  });
  return { events: feed.data ?? [], loading: feed.loading };
}
