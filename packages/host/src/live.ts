import { MAX_EVENTS_EVENT_BYTES } from "@infinite/remote/protocol";

export type LiveTopic = "sessions" | "teams" | `session/${string}`;
export type LiveUpdate = { topic: LiveTopic | "refetch"; data: unknown };
export interface LiveSource {
  sessions(): Promise<unknown>;
  teams(): unknown;
  session(id: string): Promise<unknown>;
  events(id: string, after: number): Promise<{ events: unknown[]; cursor: number; more: boolean }>;
}
type Listener = { topics: Set<LiveTopic>; cursors: Map<string, number>; values: Map<string, string>; refetch: Map<LiveTopic, number>; emit(update: LiveUpdate): void };

/** Shared change snapshots for HTTP and encrypted remote event subscribers. */
export class LiveFeed {
  private listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly source: LiveSource, private readonly intervalMs = 750) {
    if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 5000) throw new Error("Invalid live feed interval");
  }

  subscribe(topics: LiveTopic[], after: number, emit: (update: LiveUpdate) => void): () => void {
    const listener: Listener = { topics: new Set(topics), cursors: new Map(), values: new Map(), refetch: new Map(), emit };
    for (const topic of topics) if (topic.startsWith("session/")) listener.cursors.set(topic, after);
    this.listeners.add(listener);
    if (!this.timer) this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    };
  }

  get subscriberCount() { return this.listeners.size; }
  get running() { return this.timer !== undefined; }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  private async tick() {
    if (this.ticking || !this.listeners.size) return;
    this.ticking = true;
    try {
      const topics = new Set([...this.listeners].flatMap(listener => [...listener.topics]));
      const snapshots = new Map<LiveTopic, unknown>();
      const jobs: Promise<void>[] = [];
      if (topics.has("sessions")) jobs.push(this.source.sessions().then(data => { snapshots.set("sessions", data); }).catch(() => {}));
      if (topics.has("teams")) jobs.push(Promise.resolve(this.source.teams()).then(data => { snapshots.set("teams", data); }).catch(() => {}));
      for (const topic of topics) if (topic.startsWith("session/")) {
        const id = topic.slice("session/".length);
        jobs.push(this.source.session(id).then(data => { snapshots.set(topic, data); }).catch(() => {}));
      }
      await Promise.all(jobs);
      const eventPages = new Map<string, { after: number; page: { events: unknown[]; cursor: number; more: boolean } }>();
      for (const topic of topics) if (topic.startsWith("session/") && snapshots.has(topic)) {
        const after = Math.min(...[...this.listeners].filter(listener => listener.topics.has(topic)).map(listener => listener.cursors.get(topic) ?? 0));
        try { eventPages.set(topic, { after, page: await this.source.events(topic.slice("session/".length), after) }); } catch { /* Retry next tick. */ }
      }
      for (const listener of this.listeners) for (const topic of listener.topics) {
        if (!snapshots.has(topic)) continue;
        let data = snapshots.get(topic);
        if (topic.startsWith("session/")) {
          const cached = eventPages.get(topic);
          if (!cached) continue;
          const after = listener.cursors.get(topic) ?? 0, page = cached.page;
          data = { state: data, events: { ...page, events: page.events.filter(event => Number((event as { seq?: unknown }).seq) > after) } };
          listener.cursors.set(topic, Math.max(after, page.cursor));
        }
        const serialized = JSON.stringify(data);
        const lastRefetch = listener.refetch.get(topic);
        if (listener.values.get(topic) === serialized && (lastRefetch === undefined || Date.now() - lastRefetch < 15000)) continue;
        listener.values.set(topic, serialized);
        const update = { topic, data };
        const eventBytes = Buffer.byteLength(JSON.stringify(update));
        if (eventBytes > MAX_EVENTS_EVENT_BYTES || lastRefetch !== undefined) listener.refetch.set(topic, Date.now());
        // Keep the latch after the first refetch: a later inline event could move
        // the phone's journal cursor past data it has not fetched yet. Repeat
        // unchanged refetches periodically so a failed REST load can recover.
        const outgoing = listener.refetch.has(topic) ? { topic: "refetch" as const, data: { topic } } : update;
        try { listener.emit(outgoing); } catch { /* A disconnected consumer is removed by its owner. */ }
      }
    } finally { this.ticking = false; }
  }
}
