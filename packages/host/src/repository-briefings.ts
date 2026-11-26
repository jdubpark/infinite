import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { failureReason } from "./failure-reason.js";
import { signalGroup, spawnGroup, watchLeader } from "./process-group.js";
import { agentModelClientEnvironment } from "./egress.js";
import type { Manager } from "./manager.js";
import type { ChatMessage } from "./session-content.js";
import type { Project, Session } from "./types.js";
import type { BriefingUsage } from "./usage-api.js";

const STOP_GRACE_MS = 3_000;

export interface RepositoryBriefingConfig {
  command: string;
  args: string[];
  runner?: "muse" | "deepseek" | "codex";
  model?: string;
  automatic: boolean;
  intervalMs: number;
  cooldownMs: number;
  timeoutMs: number;
}

const citationSource = z.string().min(1).max(1024).refine(source =>
  /^(?:activity|patch):\d+$/.test(source) ||
  (!source.startsWith("/") && !source.includes("\\") && !source.includes("\0") && !source.includes(":") && !source.split("/").includes("..")),
"Citation sources must be repository-relative or refer to supplied activity.");
const citation = z.object({ source: citationSource, line: z.number().int().positive() }).strict();
const claim = z.object({ text: z.string().min(1).max(900), citations: z.array(citation).min(1).max(6) }).strict();
const briefSchema = z.object({
  summary: z.string().min(1).max(600),
  architecture: z.array(claim).max(6),
  review: z.array(z.object({ priority: z.enum(["high", "medium"]), area: z.string().min(1).max(150), why: z.string().min(1).max(900), question: z.string().min(1).max(900), citations: z.array(citation).max(6) }).strict()).max(5),
  changes: z.array(claim).max(6),
  checks: z.array(claim).max(4),
  guidance: z.array(z.object({ text: z.string().min(1).max(900), basis: z.enum(["documented", "proposed"]), citations: z.array(citation).max(6) }).strict()).max(4),
  unknowns: z.array(z.string().min(1).max(900)).max(8),
  diagrams: z.array(z.object({ title: z.string().min(1).max(120), kind: z.enum(["system", "change"]), mermaid: z.string().min(1).max(3000), citations: z.array(citation).max(6) }).strict()).max(2).default([]),
}).strict();
const decisionSchema = z.object({
  action: z.enum(["skip", "run", "coalesced", "disabled", "failed"]), reason: z.string().max(1000),
  judge: z.enum(["jev", "heuristic"]).nullable(), worthwhile: z.number().min(0).max(1).nullable(), scope: z.enum(["skip", "update", "full"]).nullable(),
}).strict();
const briefingUsageSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), tokens: z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), reasoning: z.number().finite().nonnegative(), cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative() }).strict(), reportedCost: z.number().finite().nonnegative().optional() }).strict();
const emptySchema = z.object({ decision: decisionSchema, repo: z.string().max(4096).nullable(), brief: z.null() }).strict();
const envelopeSchema = z.object({
  decision: decisionSchema,
  repo: z.string().min(1).max(4096),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  base: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  fingerprint: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  brief: briefSchema,
  evidence: z.array(z.object({ source: z.string().max(1024), line: z.number().int().positive(), path: z.string().max(4096).nullable(), text: z.string().max(12000) }).strict()).max(200),
  coverage: z.array(z.string().max(500)).max(100),
  usage: briefingUsageSchema.optional(),
}).strict();

export interface RepositoryBrief {
  decision: z.infer<typeof decisionSchema>;
  head: string | null;
  base: string | null;
  fingerprint: string;
  generatedAt: string;
  coverage: string[];
  activity: { included: number; observed: number; truncated: boolean };
  evidence: z.infer<typeof envelopeSchema>["evidence"];
  brief: z.infer<typeof briefSchema>;
}
export interface RepositorySummary {
  engine: "jevcode";
  model: string;
  text: string;
  from: string;
  to: string;
  messages: number;
  at: string;
  repository: RepositoryBrief;
}
export type BriefingStatusName = "pending" | "running" | "ready" | "failed" | "unavailable" | "empty";
export interface BriefingStatus {
  state: BriefingStatusName;
  summary?: RepositorySummary;
  error?: string;
}

const MAX_CACHE = 64;
const MAX_STATUS = 256;
const MAX_TRACKED = 256;
const MAX_PENDING = 16;
const MAX_PAGES = 10;
const PAGE_SIZE = 200;
const MAX_ACTIVITY_MESSAGES = 200;
const MAX_ACTIVITY_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const DEBOUNCE_MS = 350;
const MAX_GIT_MS = 2000;
const FAILED_MESSAGE = "Repository brief could not be generated. Check the configured briefing wrapper.";
const NOT_READY_MESSAGE = "No repository brief exists yet; one is generated after the next change.";
const NOT_OPTED_IN_MESSAGE = "Repository briefings are turned off on this host.";
const WRITER_LABEL = { muse: "meta/muse-spark-1.3-contributor", deepseek: "deepseek/deepseek-flash", codex: "codex" } as const;
class NotReady extends Error {}
class NotOptedIn extends Error {}
const EMPTY_MESSAGE = "No recorded chat is available for a repository brief.";

type ListedSession = Awaited<ReturnType<Manager["list"]>>[number];
type Location = { cwd: string; root: string; baseline: string | null };
type Job = {
  key: string;
  session: Session;
  location: Location;
  messages: ChatMessage[];
  observedMessages: number;
  truncated: boolean;
  from: string;
  to: string;
  dueAt: number;
  automatic: boolean;
  waiters: { resolve: (summary: RepositorySummary) => void; reject: (error: Error) => void }[];
};
type Tracked = { cursor: number; createdAt: number; checkpointDue?: number };
type BriefingRetention = {
  capture(session: Session, location: Location): Promise<unknown>;
  persist(session: Session, location: Location, summary: RepositorySummary, captured: unknown): Promise<void>;
  cacheKey?(session: Session, location: Location): Promise<string | undefined>;
  captureKey?(captured: unknown): string | undefined;
};

type Lifecycle =
  | { kind: "idle"; timer?: NodeJS.Timeout; polling: boolean }
  | { kind: "draining"; timer?: NodeJS.Timeout; polling: boolean }
  | { kind: "closing"; done: Promise<void>; resolve: () => void }
  | { kind: "closed" };

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child));
}

function activityInput(messages: ChatMessage[]): { input: string; included: number; truncated: boolean } {
  const selected = messages.length > MAX_ACTIVITY_MESSAGES ? messages.slice(-MAX_ACTIVITY_MESSAGES) : messages;
  const lines: string[] = [];
  let bytes = 0;
  for (let index = selected.length - 1; index >= 0; index--) {
    const message = selected[index];
    const line = JSON.stringify({ role: message.role, text: message.text, ts: message.ts });
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > MAX_ACTIVITY_BYTES) break;
    lines.unshift(line);
    bytes += size;
  }
  return { input: lines.length ? `${lines.join("\n")}\n` : "", included: lines.length,
    truncated: lines.length < messages.length };
}

function citationText(items: { source: string; line: number }[]) {
  return items.map(item => `${item.source}:${item.line}`).join(", ");
}
function rangeKey(sessionId: string, from: string, messages: ChatMessage[]): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(messages.map(({ role, text, ts }) => ({ role, text, ts }))))
    .digest("hex");
  return `${sessionId}:${from}:${fingerprint}`;
}
function renderBrief(brief: z.infer<typeof briefSchema>) {
  const out = [brief.summary];
  const section = (title: string, values: string[]) => { if (values.length) out.push(`${title}:`, ...values.map(value => `• ${value}`)); };
  section("System shape", brief.architecture.map(item => `${item.text}${item.citations.length ? ` (${citationText(item.citations)})` : ""}`));
  section("Review first", brief.review.map(item => `${item.area} (${item.priority}): ${item.why} Review: ${item.question}${item.citations.length ? ` (${citationText(item.citations)})` : ""}`));
  section("What changed", brief.changes.map(item => `${item.text}${item.citations.length ? ` (${citationText(item.citations)})` : ""}`));
  section("Available check evidence", brief.checks.map(item => `${item.text}${item.citations.length ? ` (${citationText(item.citations)})` : ""}`));
  section("Agent guidance", brief.guidance.map(item => `${item.basis}: ${item.text}${item.citations.length ? ` (${citationText(item.citations)})` : ""}`));
  section("Open questions", brief.unknowns);
  return out.join("\n");
}

async function collectProcess(command: string, args: string[], options: { cwd: string; input?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try { child = spawnGroup(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }, STOP_GRACE_MS); }
    catch { rejectPromise(new Error("spawn")); return; }
    const leader = watchLeader(child);
    let stdout = Buffer.alloc(0), stderrTail = Buffer.alloc(0), stopped: string | undefined;
    let closeCode: number | null | undefined, closeHandled = false, escalationDone = false;
    const finish = () => {
      if (closeHandled || closeCode === undefined || (stopped && !escalationDone)) return;
      closeHandled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (stopped || closeCode !== 0) rejectPromise(stopped ? new Error(stopped) : new Error(failureReason(new Error(`exit ${closeCode}`), stderrTail.toString("utf8"))));
      else resolvePromise(stdout.toString("utf8"));
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      signalGroup(child, "SIGTERM");
      setTimeout(() => {
        signalGroup(child, "SIGKILL");
        escalationDone = true;
        finish();
      }, STOP_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    timer.unref();
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > options.maxBytes) { stop("oversized"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-2048); });
    child.on("error", () => { stopped ??= "spawn"; escalationDone = true; });
    child.on("close", code => {
      closeCode = code;
      if (leader.leftover && !stopped) {
        stopped = "output-held";
        escalationDone = true;
      }
      if (!stopped) clearTimeout(timer);
      finish();
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input ?? "");
    if (options.signal?.aborted) abort();
  });
}

export class RepositoryBriefings {
  private usageRecorder?: { recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null): void };
  private lifecycle: Lifecycle = { kind: "idle", polling: false };
  private discoveredBefore = 0;
  private readonly tracked = new Map<string, Tracked>();
  private readonly locations = new Map<string, Location>();
  private readonly pending = new Map<string, Job>();
  private readonly inFlight = new Map<string, Job>();
  private readonly reports = new Map<string, RepositorySummary>();
  private readonly latest = new Map<string, BriefingStatus>();
  private readonly statusUpdatedAt = new Map<string, number>();
  private readonly controllers = new Set<AbortController>();
  private readonly lastAttempt = new Map<string, number>();
  private retention?: BriefingRetention;
  useUsage(service: { recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null): void }) { this.usageRecorder = service; }
  useRetention(retention: BriefingRetention) { this.retention = retention; }

  constructor(
    readonly config: RepositoryBriefingConfig,
    private readonly manager: Manager,
    private readonly projects: Project[],
    private readonly teamWorkspace?: string,
  ) {}

  get model() { return this.config.model ?? WRITER_LABEL[this.config.runner ?? "muse"]; }

  private currentLifecycle(): Lifecycle {
    return this.lifecycle;
  }

  private isClosed(): boolean {
    return this.lifecycle.kind === "closing" || this.lifecycle.kind === "closed";
  }

  async start(): Promise<void> {
    if (this.lifecycle.kind !== "idle" || this.lifecycle.timer) return;
    const sessions = await this.manager.list().catch(() => []);
    if (this.isClosed()) return;
    this.discoveredBefore = Date.now();
    for (const listed of sessions) {
      const session = this.manager.meta(listed.id).session;
      if (session.status === "running" || session.status === "starting" || session.status === "unavailable" || session.status === "recording-error") {
        this.tracked.set(session.id, { cursor: listed.seq, createdAt: Date.parse(session.createdAt) || 0 });
        try { this.rememberLocation(session.id, await this.location(session)); } catch {}
      }
    }
    const lc = this.currentLifecycle();
    if ((lc.kind !== "idle" && lc.kind !== "draining") || lc.timer) return;
    this.trimTracked();
    const timer = setInterval(() => { void this.poll(); }, this.config.intervalMs);
    timer.unref();
    lc.timer = timer;
  }

  close(): Promise<void> {
    if (this.lifecycle.kind === "closed") return Promise.resolve();
    if (this.lifecycle.kind === "closing") return this.lifecycle.done;
    if (this.lifecycle.timer) clearInterval(this.lifecycle.timer);
    for (const controller of this.controllers) controller.abort();
    for (const job of this.pending.values()) for (const waiter of job.waiters) waiter.reject(new Error("Repository brief service closed"));
    this.pending.clear();
    if (this.lifecycle.kind === "draining") {
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      this.lifecycle = { kind: "closing", done, resolve: resolveDone };
      return done;
    }
    this.lifecycle = { kind: "closed" };
    return Promise.resolve();
  }

  async status(session: Session): Promise<BriefingStatus> {
    const current = this.latest.get(session.id);
    if (current) return current;
    try {
      const location = await this.location(session);
      this.rememberLocation(session.id, location);
      const status: BriefingStatus = { state: "empty" };
      this.setStatus(session.id, status);
      return status;
    } catch {
      const status: BriefingStatus = { state: "unavailable", error: "This session source is unavailable for repository briefing." };
      this.setStatus(session.id, status);
      return status;
    }
  }

  understandingStatuses() {
    return [...this.latest.entries()].map(([sessionId, status]) => ({ sessionId, state: status.state,
      attemptedAt: this.lastAttempt.get(sessionId), updatedAt: this.statusUpdatedAt.get(sessionId)!, ...(status.error ? { error: status.error } : {}) }));
  }

  async summarize(session: Session, from: string): Promise<RepositorySummary | Omit<RepositorySummary, "repository">> {
    if (this.isClosed()) throw new Error("Repository brief service closed");
    const state = await this.manager.state(session.id);
    const activity = await this.readMessages(session, state.capabilities?.transcript === 1, from, state.seq);
    const { messages, cursor: to } = activity;
    const baseKey = rangeKey(session.id, from, messages);
    const pinnedLookup = Boolean(this.retention?.cacheKey && session.team?.role === "mission-coordinator");
    if (!pinnedLookup) {
      const cached = this.reports.get(baseKey);
      if (cached) return cached;
    }
    const location = await this.location(session);
    if (this.isClosed()) throw new Error("Repository brief service closed");
    if (messages.length === 0) return { engine: "jevcode", model: this.model, text: "", from, to, messages: 0, at: new Date().toISOString() };
    let key = baseKey;
    if (pinnedLookup) {
      try {
        const sourceKey = await this.retention!.cacheKey!(session, location);
        if (this.isClosed()) throw new Error("Repository brief service closed");
        if (sourceKey) key = `${baseKey}:${sourceKey}`;
      } catch {
        key = `${baseKey}:uncached:${Date.now()}`;
      }
      const cached = this.reports.get(key);
      if (cached) return cached;
    }
    const baseline = location.baseline ?? await this.captureHead(location.root);
    const nextLocation = { ...location, baseline };
    this.rememberLocation(session.id, nextLocation);
    return this.enqueue({ session, location: nextLocation, messages, observedMessages: activity.observedMessages, truncated: activity.truncated,
      from, to, automatic: false, dueAt: Date.now(), key, waiters: [] });
  }

  private async poll(): Promise<void> {
    if ((this.lifecycle.kind !== "idle" && this.lifecycle.kind !== "draining") || this.lifecycle.polling || !this.config.automatic) return;
    this.lifecycle.polling = true;
    try {
      const observedAt = Date.now();
      const sessions = await this.manager.list();
      for (const listed of sessions) await this.observe(listed);
      this.discoveredBefore = Math.max(this.discoveredBefore, observedAt);
    } catch {}
    finally {
      if (this.lifecycle.kind === "idle" || this.lifecycle.kind === "draining") this.lifecycle.polling = false;
      void this.drain();
    }
  }

  private async observe(listed: ListedSession): Promise<void> {
    if (this.isClosed()) return;
    let tracked = this.tracked.get(listed.id);
    if (!tracked) {
      const createdAt = Date.parse(listed.createdAt) || 0;
      if (createdAt < this.discoveredBefore && listed.status === "exited") return;
      tracked = { cursor: createdAt >= this.discoveredBefore ? 0 : listed.seq, createdAt };
      this.tracked.set(listed.id, tracked);
      if (createdAt >= this.discoveredBefore) {
        try { this.rememberLocation(listed.id, await this.location(this.manager.meta(listed.id).session)); } catch {}
      }
      this.trimTracked();
    }
    let pages = 0;
    let trigger = false;
    while (tracked.cursor < listed.seq && pages++ < MAX_PAGES) {
      let page;
      try { page = this.manager.events(listed.id, tracked.cursor, PAGE_SIZE, new Set(["signal", "lifecycle"])); }
      catch { return; }
      if (page.cursor <= tracked.cursor) break;
      tracked.cursor = page.cursor;
      for (const event of page.events) {
        if (event.type === "signal" && event.data.kind === "turn-end") trigger = true;
        if (event.type === "lifecycle" && event.data.status === "exited") trigger = true;
      }
      if (!page.more) break;
    }
    if (trigger) tracked.checkpointDue = Date.now() + DEBOUNCE_MS;
    if (tracked.checkpointDue === undefined || Date.now() < tracked.checkpointDue) {
      if (tracked.checkpointDue === undefined && listed.status === "exited" && tracked.cursor >= listed.seq) {
        this.tracked.delete(listed.id);
        this.lastAttempt.delete(listed.id);
      }
      return;
    }
    delete tracked.checkpointDue;
    const location = this.locations.get(listed.id);
    if (!location) { this.setStatus(listed.id, { state: "unavailable", error: "This session source is unavailable for repository briefing." }); return; }
    const session = this.manager.meta(listed.id).session;
    const transcript = listed.capabilities?.transcript === 1;
    const activity = await this.readMessages(session, transcript, "0", listed.seq);
    if (!activity.messages.length) { this.setStatus(listed.id, { state: "empty", error: EMPTY_MESSAGE }); return; }
    const to = activity.cursor;
    const baseKey = rangeKey(session.id, "0", activity.messages);
    let key = baseKey;
    if (this.retention?.cacheKey && session.team?.role === "mission-coordinator") {
      try {
        const sourceKey = await this.retention.cacheKey(session, location);
        if (sourceKey) key = `${baseKey}:${sourceKey}`;
      } catch {
        key = `${baseKey}:uncached:${Date.now()}`;
      }
    }
    if (this.reports.has(key) || this.inFlight.has(key)) return;
    const priorAttempt = this.lastAttempt.get(session.id) ?? 0;
    const dueAt = Math.max(Date.now() + DEBOUNCE_MS, priorAttempt + this.config.cooldownMs);
    const job: Job = { key, session, location, messages: activity.messages, observedMessages: activity.observedMessages, truncated: activity.truncated,
      from: "0", to, dueAt, automatic: true, waiters: [] };
    for (const [pendingKey, pendingJob] of this.pending) {
      if (pendingJob.session.id === session.id && pendingJob.automatic && pendingJob.waiters.length === 0 && pendingKey !== key) this.pending.delete(pendingKey);
    }
    const sameRange = this.pending.get(key);
    if (this.isClosed()) return;
    if (sameRange) {
      sameRange.dueAt = Math.min(sameRange.dueAt, job.dueAt);
      sameRange.automatic = true;
    } else this.pending.set(key, job);
    this.setStatus(session.id, { state: "pending", ...(this.latest.get(session.id)?.summary ? { summary: this.latest.get(session.id)!.summary } : {}) });
    this.trimPending();
    void this.drain();
  }

  private async readMessages(session: Session, transcript: boolean, after: string, through: number) {
    const messages: ChatMessage[] = [];
    const start = Math.max(Number(after), through - MAX_PAGES * PAGE_SIZE);
    if (start === 0 && session.initialPrompt && !transcript) messages.push({ id: "initial", role: "user", text: session.initialPrompt, ts: session.createdAt });
    const types = transcript ? new Set(["message"]) : new Set(["message", "signal", "input-result"]);
    let cursor = start, pages = 0, more = false, observedMessages = messages.length;
    do {
      const page = this.manager.events(session.id, cursor, PAGE_SIZE, types);
      for (const event of page.events) {
        const data = event.data;
        if (event.type === "message" && typeof data.text === "string" && ["user", "assistant", "tool"].includes(String(data.role))) {
          messages.push({ id: typeof data.id === "string" ? `message:${data.id}` : `message:${event.seq}`, role: data.role as ChatMessage["role"], text: data.text,
            ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}), ts: typeof data.ts === "string" ? data.ts : event.at, seq: event.seq });
          observedMessages++;
        } else if (!transcript && event.type === "input-result" && data.state === "delivered" && typeof data.message === "string") {
          messages.push({ id: `input:${event.seq}`, role: "user", text: data.message, ts: event.at, seq: event.seq }); observedMessages++;
        } else if (!transcript && event.type === "signal" && data.kind === "turn-end" && typeof data.message === "string" && data.message.trim()) {
          messages.push({ id: `reply:${event.seq}`, role: "assistant", text: data.message, ts: event.at, seq: event.seq }); observedMessages++;
        } else if (!transcript && event.type === "signal" && data.kind === "tool-start" && typeof data.tool === "string") {
          messages.push({ id: `tool:${event.seq}`, role: "tool", toolName: data.tool, text: data.tool, ts: event.at, seq: event.seq }); observedMessages++;
        }
      }
      cursor = page.cursor; more = page.more; pages += 1;
    } while (more && pages < MAX_PAGES && messages.length < 2000);
    const kept = messages.length > MAX_ACTIVITY_MESSAGES ? messages.slice(-MAX_ACTIVITY_MESSAGES) : messages;
    return { messages: kept, observedMessages, cursor: String(cursor), truncated: start > Number(after) || more || kept.length < observedMessages };
  }

  private trimPending() {
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (!oldest) break;
      const job = this.pending.get(oldest)!;
      this.pending.delete(oldest);
      this.setStatus(job.session.id, { state: "failed", error: "Repository briefing queue is full." });
      for (const waiter of job.waiters) waiter.reject(new Error("Repository briefing queue is full"));
    }
  }

  private enqueue(job: Job): Promise<RepositorySummary> {
    if (this.isClosed()) return Promise.reject(new Error("Repository brief service closed"));
    const cached = this.reports.get(job.key);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolvePromise, rejectPromise) => {
      const existing = this.inFlight.get(job.key) ?? this.pending.get(job.key);
      if (existing) {
        existing.waiters.push({ resolve: resolvePromise, reject: rejectPromise });
      } else {
        if (this.pending.size >= MAX_PENDING) { rejectPromise(new Error("Repository briefing queue is full")); return; }
        this.pending.set(job.key, { ...job, waiters: [...job.waiters, { resolve: resolvePromise, reject: rejectPromise }] });
      }
      this.setStatus(job.session.id, { state: "pending", ...(this.latest.get(job.session.id)?.summary ? { summary: this.latest.get(job.session.id)!.summary } : {}) });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.lifecycle.kind !== "idle") return;
    this.lifecycle = { kind: "draining", timer: this.lifecycle.timer, polling: this.lifecycle.polling };
    try {
      while (this.lifecycle.kind === "draining" && this.pending.size) {
        const ready = [...this.pending.values()].filter(job => job.dueAt <= Date.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!ready) break;
        this.pending.delete(ready.key);
        try {
          if (ready.automatic && ready.waiters.length === 0) {
            const state = await this.manager.state(ready.session.id);
            const activity = await this.readMessages(ready.session, state.capabilities?.transcript === 1, ready.from, state.seq);
            ready.messages = activity.messages; ready.to = activity.cursor;
            ready.observedMessages = activity.observedMessages; ready.truncated = activity.truncated;
            const baseKey = rangeKey(ready.session.id, ready.from, ready.messages);
            const sourceKey = this.retention?.cacheKey && ready.session.team?.role === "mission-coordinator"
              ? await this.retention.cacheKey(ready.session, ready.location) : undefined;
            ready.key = sourceKey ? `${baseKey}:${sourceKey}` : baseKey;
            if (this.reports.has(ready.key)) continue;
            const matching = this.pending.get(ready.key);
            if (matching) { ready.waiters.push(...matching.waiters); this.pending.delete(ready.key); }
          }
          if (this.isClosed()) { for (const waiter of ready.waiters) waiter.reject(new Error("Repository brief service closed")); break; }
          this.setStatus(ready.session.id, { state: "running", ...(this.latest.get(ready.session.id)?.summary ? { summary: this.latest.get(ready.session.id)!.summary } : {}) });
          const queueKey = ready.key;
          this.inFlight.set(queueKey, ready);
          this.lastAttempt.delete(ready.session.id);
          this.lastAttempt.set(ready.session.id, Date.now());
          while (this.lastAttempt.size > MAX_TRACKED) this.lastAttempt.delete(this.lastAttempt.keys().next().value!);
          const retentionCapture = this.retention ? await this.retention.capture(ready.session, ready.location) : undefined;
          const baseKey = rangeKey(ready.session.id, ready.from, ready.messages);
          const capturedSourceKey = ready.session.team?.role === "mission-coordinator"
            ? this.retention?.captureKey?.(retentionCapture)
            : undefined;
          const reportKey = ready.session.team?.role === "mission-coordinator"
            ? (capturedSourceKey ? `${baseKey}:${capturedSourceKey}` : undefined)
            : ready.key;
          const summary = await this.run(ready);
          if (this.retention && retentionCapture !== undefined)
            await this.retention.persist(ready.session, ready.location, summary, retentionCapture);
          this.inFlight.delete(queueKey);
          if (reportKey) {
            this.reports.set(reportKey, summary);
            if (this.reports.size > MAX_CACHE) this.reports.delete(this.reports.keys().next().value!);
          }
          this.setStatus(ready.session.id, { state: "ready", summary });
          for (const waiter of ready.waiters) waiter.resolve(summary);
        } catch (error) {
          this.inFlight.delete(ready.key);
          const notReady = error instanceof NotReady;
          const notOptedIn = error instanceof NotOptedIn;
          const message = notOptedIn ? NOT_OPTED_IN_MESSAGE : notReady ? NOT_READY_MESSAGE : `${FAILED_MESSAGE} Reason: ${failureReason(error)}`;
          this.setStatus(ready.session.id, { state: notOptedIn ? "unavailable" : notReady ? "empty" : "failed", ...(this.latest.get(ready.session.id)?.summary ? { summary: this.latest.get(ready.session.id)!.summary } : {}), error: message });
          for (const waiter of ready.waiters) waiter.reject(new Error(message));
        }
      }
    } finally {
      const lc = this.currentLifecycle();
      if (lc.kind === "closing") {
        const { resolve } = lc;
        this.lifecycle = { kind: "closed" };
        resolve();
      } else if (lc.kind === "draining") {
        this.lifecycle = { kind: "idle", timer: lc.timer, polling: lc.polling };
        if ([...this.pending.values()].some(job => job.dueAt <= Date.now())) void this.drain();
      }
    }
  }

  private async run(job: Job): Promise<RepositorySummary> {
    if (this.isClosed()) throw new Error("Repository brief service closed");
    const current = await this.location(job.session);
    if (this.isClosed() || current.cwd !== job.location.cwd || current.root !== job.location.root) throw new Error("Repository source changed");
    const repoTarget = inside(job.location.root, job.location.cwd) ? job.location.cwd : job.location.root;
    const args = [...this.config.args, "auto", "--trigger", "host", "--format", "json", "--activity-stdin", "--session", job.session.id,
      "--repo", repoTarget, "--timeout", String(Math.ceil(this.config.timeoutMs / 1000))];
    if (job.location.baseline) args.push("--base", job.location.baseline);
    if (this.config.runner) args.push("--runner", this.config.runner);
    if (this.config.model) args.push("--model", this.config.model);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const activity = activityInput(job.messages);
      const raw = await collectProcess(this.config.command, args, {
        cwd: repoTarget, env: agentModelClientEnvironment(), input: activity.input, timeoutMs: this.config.timeoutMs,
        maxBytes: MAX_STDOUT_BYTES, signal: controller.signal,
      });
      const value: unknown = JSON.parse(raw);
      const empty = emptySchema.safeParse(value);
      if (empty.success) throw empty.data.decision.action === "disabled" ? new NotOptedIn() : new NotReady();
      const parsed = envelopeSchema.parse(value);
      if (resolve(parsed.repo) !== job.location.root || (job.location.baseline !== null && parsed.base !== job.location.baseline))
        throw new Error("provenance");
      if (parsed.decision.action === "run") this.usageRecorder?.recordBriefing(job.session.projectId, job.session.id, parsed.generatedAt, parsed.usage ?? null);
      const repository: RepositoryBrief = { decision: parsed.decision, head: parsed.head, base: parsed.base, fingerprint: parsed.fingerprint,
        generatedAt: parsed.generatedAt,
        coverage: [...parsed.coverage, `Session activity: ${activity.included} of ${job.observedMessages} recorded messages included${activity.truncated || job.truncated ? "; activity outside the bounded message or page limits omitted" : "."}`],
        activity: { included: activity.included, observed: job.observedMessages, truncated: activity.truncated || job.truncated }, evidence: parsed.evidence, brief: parsed.brief };
      const evidence = parsed.evidence.map(item => `${item.source}:${item.line}${item.path ? ` (${item.path})` : ""}: ${item.text}`).join("\n");
      const freshness = parsed.decision.action === "run" ? "Refreshed for this turn." : `Not refreshed this turn: ${parsed.decision.reason}.`;
      const text = `${renderBrief(parsed.brief)}\n\n${freshness} Generated source snapshot: ${parsed.generatedAt}. Comparison base: ${parsed.base ?? "unborn"}. This is generated evidence, not approval.\nCoverage:\n${repository.coverage.join("\n")}${evidence ? `\nCited evidence:\n${evidence}` : ""}`;
      return { engine: "jevcode", model: this.model, text, from: job.from, to: job.to,
        messages: activity.included, at: parsed.generatedAt, repository };
    } finally { this.controllers.delete(controller); }
  }

  private async location(session: Session): Promise<Location> {
    if (session.workspace || session.executionLocation === "laptop") throw new Error("laptop");
    let cwd: string;
    try { cwd = realpathSync(session.cwd); } catch { throw new Error("cwd"); }
    const teamRoot = session.team && this.teamWorkspace ? realpathSync(this.teamWorkspace) : undefined;
    const project = this.projects.find(item => item.id === session.projectId);
    if (!project) throw new Error("project");
    const projectRoot = realpathSync(project.path);
    const allowedRoot = session.team && teamRoot ? teamRoot : projectRoot;
    if (!inside(allowedRoot, cwd)) throw new Error("outside");
    const isMissionCoordinator = session.team?.role === "mission-coordinator";
    const repoTarget = isMissionCoordinator && !inside(projectRoot, cwd) ? projectRoot : cwd;
    const expectedRoot = isMissionCoordinator ? projectRoot : allowedRoot;
    const output = await collectProcess("git", ["-c", `safe.directory=${repoTarget}`, "-C", repoTarget, "rev-parse", "--show-toplevel"], { cwd: repoTarget, timeoutMs: MAX_GIT_MS, maxBytes: 4096 });
    const root = realpathSync(output.trim());
    if (!inside(expectedRoot, root)) throw new Error("git-root");
    const previous = this.locations.get(session.id);
    const baseline = previous?.root === root ? previous.baseline : await this.captureHead(root);
    return { cwd, root, baseline };
  }

  private async captureHead(root: string): Promise<string | null> {
    try {
      const value = (await collectProcess("git", ["-c", `safe.directory=${root}`, "-C", root, "rev-parse", "--verify", "HEAD"], { cwd: root, timeoutMs: MAX_GIT_MS, maxBytes: 256 })).trim();
      return /^[a-f0-9]{40,64}$/.test(value) ? value : null;
    } catch { return null; }
  }

  private rememberLocation(id: string, location: Location): void {
    this.locations.delete(id);
    this.locations.set(id, location);
    while (this.locations.size > MAX_STATUS) this.locations.delete(this.locations.keys().next().value!);
  }

  private setStatus(id: string, status: BriefingStatus): void {
    this.latest.delete(id);
    this.latest.set(id, status);
    this.statusUpdatedAt.set(id, Date.now());
    while (this.latest.size > MAX_STATUS) {
      const oldest = this.latest.keys().next().value!;
      this.latest.delete(oldest);
      this.statusUpdatedAt.delete(oldest);
    }
  }

  private trimTracked(): void {
    while (this.tracked.size > MAX_TRACKED) {
      const oldest = this.tracked.keys().next().value;
      if (!oldest) break;
      this.tracked.delete(oldest);
    }
  }
}
