import { MAX_EVENTS_EVENT_BYTES } from "@infinite/remote/protocol";

export type LiveTopic = "sessions" | "teams" | `session/${string}`;
export type LiveUpdate = { topic: LiveTopic | "refetch"; data: unknown };
export interface LiveSource {
  sessions(): Promise<unknown>;
  teams(): unknown;
  session(id: string): Promise<unknown>;
  events(id: string, after: number): Promise<{ events: unknown[]; cursor: number; more: boolean }>;
}
type Listener = { topics: Set<LiveTopic>; cursors: Map<string, number>; values: Map<string, string>; sentAt: Map<LiveTopic, number>; refetch: Map<LiveTopic, number>; emit(update: LiveUpdate): void };
type EventPage = { events: unknown[]; cursor: number; more: boolean };
type EventRead = { topic: `session/${string}`; id: string; after: number };

const MAX_EVENT_READS_PER_TICK = 32;
const MAX_EVENT_READ_CONCURRENCY = 4;
const UNCHANGED_SESSIONS_RESEND_MS = 60_000;

export class LiveFeed {
  private listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private eventReadOffset = 0;

  constructor(private readonly source: LiveSource, private readonly intervalMs = 750) {
    if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 5000) throw new Error("Invalid live feed interval");
  }

  subscribe(topics: LiveTopic[], after: number, emit: (update: LiveUpdate) => void): () => void {
    const listener: Listener = { topics: new Set(topics), cursors: new Map(), values: new Map(), sentAt: new Map(), refetch: new Map(), emit };
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
      const groups = new Map<`session/${string}`, Map<number, EventRead>>();
      for (const topic of topics) if (topic.startsWith("session/") && snapshots.has(topic)) {
        const sessionTopic = topic as `session/${string}`;
        for (const listener of this.listeners) if (listener.topics.has(sessionTopic)) {
          const after = listener.cursors.get(sessionTopic) ?? 0;
          let byCursor = groups.get(sessionTopic);
          if (!byCursor) groups.set(sessionTopic, byCursor = new Map());
          if (!byCursor.has(after)) byCursor.set(after, { topic: sessionTopic, id: sessionTopic.slice("session/".length), after });
        }
      }
      const eventPages = new Map<`session/${string}`, Map<number, EventPage>>();
      const reads = this.budgetEventReads([...groups.values()].flatMap(byCursor => [...byCursor.values()]));
      let nextRead = 0;
      await Promise.all(Array.from({ length: Math.min(MAX_EVENT_READ_CONCURRENCY, reads.length) }, async () => {
        while (nextRead < reads.length) {
          const read = reads[nextRead++]!;
          try {
            const page = await this.source.events(read.id, read.after);
            let byCursor = eventPages.get(read.topic);
            if (!byCursor) eventPages.set(read.topic, byCursor = new Map());
            byCursor.set(read.after, page);
          } catch {}
        }
      }));
      for (const listener of this.listeners) for (const topic of listener.topics) {
        if (!snapshots.has(topic)) continue;
        let data = snapshots.get(topic);
        if (topic.startsWith("session/")) {
          const sessionTopic = topic as `session/${string}`;
          const after = listener.cursors.get(sessionTopic) ?? 0, page = eventPages.get(sessionTopic)?.get(after);
          if (!page) continue;
          data = { state: data, events: { ...page, events: page.events.filter(event => Number((event as { seq?: unknown }).seq) > after) } };
          listener.cursors.set(topic, Math.max(after, page.cursor));
        }
        const serialized = JSON.stringify(data);
        const lastRefetch = listener.refetch.get(topic);
        const held = lastRefetch === undefined
          ? topic !== "sessions" || Date.now() - (listener.sentAt.get(topic) ?? 0) < UNCHANGED_SESSIONS_RESEND_MS
          : Date.now() - lastRefetch < 15000;
        if (listener.values.get(topic) === serialized && held) continue;
        listener.values.set(topic, serialized);
        listener.sentAt.set(topic, Date.now());
        const update = { topic, data };
        const eventBytes = Buffer.byteLength(JSON.stringify(update));
        if (eventBytes > MAX_EVENTS_EVENT_BYTES || lastRefetch !== undefined) listener.refetch.set(topic, Date.now());
        const outgoing = listener.refetch.has(topic) ? { topic: "refetch" as const, data: { topic } } : update;
        try { listener.emit(outgoing); } catch {}
      }
    } finally { this.ticking = false; }
  }

  private budgetEventReads(reads: EventRead[]) {
    if (reads.length <= MAX_EVENT_READS_PER_TICK) return reads;
    const byTopic = new Map<`session/${string}`, EventRead[]>();
    for (const read of reads) {
      let groups = byTopic.get(read.topic);
      if (!groups) byTopic.set(read.topic, groups = []);
      groups.push(read);
    }
    const newest = new Set<EventRead>();
    for (const groups of byTopic.values()) newest.add(groups.reduce((latest, read) => read.after > latest.after ? read : latest));
    const ordered = [...reads.filter(read => newest.has(read)), ...reads.filter(read => !newest.has(read))];
    const offset = this.eventReadOffset % ordered.length;
    const selected = [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, MAX_EVENT_READS_PER_TICK);
    this.eventReadOffset = (offset + selected.length) % ordered.length;
    return selected;
  }
}
