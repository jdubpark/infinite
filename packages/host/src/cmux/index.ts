import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { applyLifecycle, initialAttention, type Attention, type Prompt } from "@infinite/attention";
import type { CreateSession } from "../manager.js";
import type { Config, ControlActor, ControlLease, Event, InputControl, Receipt, Session, WorkerRequest, WorkerState } from "../types.js";
import { Journal, readEvents, unseal, writeSealed } from "../vault.js";
import { CmuxClient, CmuxError, array, string, type Json, type Surface } from "./client.js";
import { foregroundAgent, LAUNCH_ENV, processAlive, readHooks, type CmuxProvider, type HookSession } from "./discovery.js";
import { digest, feedReply, matchingFeed, pendingPrompt, type PendingPrompt } from "./prompts.js";
import { readTranscript } from "./transcripts.js";

export { CmuxError } from "./client.js";

type CmuxConfig = Config & { cmux?: { enabled: boolean; command?: string; hooksDir?: string }; machine?: { id: string } };
type StoredReceipt = Receipt & { digest: string; result?: "closed" | "still-open" | "changed" | "refused" };
type Delivery = Extract<WorkerRequest, { op: "input" | "raw" | "key" | "answer" | "stop" }>;
interface Stored {
  session: Session;
  nativeId?: string;
  surfaceId?: string;
  workspaceId?: string;
  transcript?: string;
  pid?: number;
  launchId?: string;
  launchedAt?: number;
  hookAt?: number;
  lifecycle?: string;
  lastMessage?: string;
  screen: string;
  columns?: number;
  rows?: number;
  draft?: boolean;
  attention: Attention;
  prompt?: PendingPrompt & { id: number };
  controller?: { actorId: string; lease: ControlLease };
  receipts: Record<string, StoredReceipt>;
  creation?: { digest: string; state: "uncertain" | "delivered" };
  recordingError?: boolean;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LEASE_MS = 30_000;
const MAX_QUEUED = 8;
const OBSERVATION_WAIT_MS = 5_000;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const cleanTitle = (value: string) => value.replace(/^[^\p{L}\p{N}]+\s+/u, "").trim().slice(0, 160);
const now = () => new Date().toISOString();

/** An adapter for independently managed cmux terminals. */
export class CmuxSessions {
  private readonly client: CmuxClient;
  private readonly directory: string;
  private readonly records = new Map<string, Stored>();
  private readonly journals = new Map<string, Journal>();
  private readonly unreadable = new Set<string>();
  private readonly mutations: (() => Promise<void>)[] = [];
  private readonly observations: (() => Promise<void>)[] = [];
  private readonly reads = new Map<string, Promise<unknown>>();
  private draining?: Promise<void>;
  private tree = new Map<string, Surface>();
  private feed: Json[] = [];
  private available = false;
  private closed = false;

  constructor(readonly config: CmuxConfig, readonly key: Buffer) {
    this.client = new CmuxClient(config.cmux?.command ?? "cmux");
    this.directory = join(config.stateDir, "cmux");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(this.directory).filter((value) => UUID.test(value))) {
      try {
        const stored = unseal<Stored>(key, `cmux:${id}:meta`, readFileSync(join(this.directory, id, "meta.sealed"), "utf8"));
        if (stored.session.id !== id) continue;
        this.records.set(id, stored);
        try { this.journals.set(id, new Journal(join(this.directory, id, "events"), key, id)); }
        catch { stored.recordingError = true; }
      } catch { this.unreadable.add(id); }
    }
  }

  private serialize<T>(operation: () => Promise<T> | T, observation?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CmuxError("cmux-unavailable"));
    const existing = observation ? this.reads.get(observation) : undefined;
    if (existing) return existing as Promise<T>;
    const queue = observation ? this.observations : this.mutations;
    if (queue.length >= MAX_QUEUED) return Promise.reject(new CmuxError("cmux-busy", "cmux is busy. Refresh before retrying."));
    const queuedAt = Date.now();
    const result = new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          // Abandoned polling must not keep adding subprocess work. Mutations
          // retain their admission and perform their own fresh safety checks.
          if (observation && Date.now() - queuedAt > OBSERVATION_WAIT_MS) throw new CmuxError("cmux-busy", "The observation expired while cmux was busy. Refresh to reconnect.");
          resolve(await operation());
        } catch (error) { reject(error); }
      });
    });
    if (observation) {
      this.reads.set(observation, result);
      const forget = () => { if (this.reads.get(observation) === result) this.reads.delete(observation); };
      void result.then(forget, forget);
    }
    this.drain();
    return result;
  }

  private drain() {
    if (this.draining) return;
    this.draining = (async () => {
      for (;;) {
        const operation = this.mutations.shift() ?? this.observations.shift();
        if (!operation) return;
        await operation();
      }
    })().finally(() => {
      this.draining = undefined;
      if (this.mutations.length || this.observations.length) this.drain();
    });
  }

  private stored(id: string): Stored {
    if (this.unreadable.has(id)) throw new CmuxError("recording-error", "Session state cannot be authenticated; recover its recording before sending input");
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("Session not found"), { code: "ENOENT" });
    return record;
  }

  private save(record: Stored) {
    try { writeSealed(join(this.directory, record.session.id, "meta.sealed"), this.key, `cmux:${record.session.id}:meta`, record); }
    catch (error) { record.recordingError = true; throw error; }
  }

  private append(record: Stored, type: Event["type"], data: Event["data"]): Event {
    if (record.recordingError) throw new CmuxError("recording-error");
    try {
      let journal = this.journals.get(record.session.id);
      if (!journal) {
        journal = new Journal(join(this.directory, record.session.id, "events"), this.key, record.session.id);
        this.journals.set(record.session.id, journal);
      }
      return journal.append(type, data);
    } catch (error) { record.recordingError = true; throw error; }
  }

  private project(cwd: string) {
    let canonical: string;
    try { canonical = realpathSync(cwd); } catch { return undefined; }
    return this.config.projects.flatMap((project) => {
      try {
        const root = realpathSync(project.path);
        const child = relative(root, canonical);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child)) ? [{ ...project, root, cwd: canonical }] : [];
      } catch { return []; }
    }).sort((a, b) => b.root.length - a.root.length)[0];
  }

  private newRecord(provider: CmuxProvider, cwd: string, title: string, id: string = randomUUID()): Stored | undefined {
    const project = this.project(cwd);
    if (!project) return undefined;
    const createdAt = now();
    const record: Stored = {
      session: {
        id, provider, title: cleanTitle(title) || basename(cwd), projectId: project.id, cwd: project.cwd,
        createdAt, status: "starting", contextVersion: 0, context: "", initialPrompt: "",
        backend: "cmux", machineId: this.config.machine?.id,
        runtime: { id: randomUUID(), location: this.config.environment, transport: "cmux" },
      },
      screen: "", attention: initialAttention(createdAt, false), receipts: {},
    };
    this.records.set(id, record);
    this.append(record, "lifecycle", { status: "starting", backend: "cmux" });
    this.save(record);
    return record;
  }

  private nativeRecord(provider: CmuxProvider, nativeId: string): Stored | undefined {
    return [...this.records.values()].find((row) => row.session.provider === provider && row.nativeId === nativeId);
  }

  private mergeHook(hook: HookSession, active: Map<string, HookSession>) {
    const surface = hook.surfaceId ? this.tree.get(hook.surfaceId) : undefined;
    const newest = hook.surfaceId ? active.get(hook.surfaceId) : undefined;
    let record = this.nativeRecord(hook.provider, hook.nativeId);
    // A launch receives its provider-native identity once its first hook arrives.
    record ??= [...this.records.values()].find((candidate) => !candidate.nativeId && candidate.surfaceId === hook.surfaceId && candidate.session.provider === hook.provider && hook.updatedAt >= (candidate.launchedAt ?? 0) - 1000);
    record ??= hook.cwd ? this.newRecord(hook.provider, hook.cwd, surface?.title ?? basename(hook.cwd)) : undefined;
    if (!record) return;
    const project = this.project(hook.cwd ?? record.session.cwd);
    if (!project) {
      record.surfaceId = undefined;
      record.workspaceId = undefined;
      record.pid = undefined;
      return;
    }
    record.session.cwd = project.cwd;
    record.session.projectId = project.id;
    record.nativeId = hook.nativeId;
    record.transcript = hook.transcript ?? record.transcript;
    record.hookAt = hook.updatedAt;
    record.lastMessage = hook.message?.slice(0, 8000) ?? record.lastMessage;
    if (record.launchedAt && hook.updatedAt < record.launchedAt && record.surfaceId !== hook.surfaceId) return;
    if (surface && newest === hook && surface.type === "terminal" && (!hook.workspaceId || surface.workspaceId === hook.workspaceId)) {
      if (record.surfaceId && record.surfaceId !== surface.id) {
        record.session.runtime = { id: randomUUID(), location: this.config.environment, transport: "cmux" };
        record.controller = undefined;
      }
      record.surfaceId = surface.id;
      record.workspaceId = surface.workspaceId;
      record.pid = hook.pid;
      record.lifecycle = hook.lifecycle;
      record.session.title = cleanTitle(surface.title) || record.session.title;
    } else if (record.surfaceId === hook.surfaceId && newest && newest !== hook) {
      // A new conversation now owns this surface. Keep the old transcript, never
      // redirect the old session's remote input to the replacement conversation.
      record.surfaceId = undefined;
      record.workspaceId = undefined;
      record.pid = undefined;
    }
  }

  private async refresh(screenId?: string) {
    if (!this.config.cmux?.enabled) {
      this.available = false;
      for (const record of this.records.values()) this.observe(record, "unavailable");
      return;
    }
    const [tree, vault, feed] = await Promise.allSettled([
      this.client.tree(), this.client.rpc("vault.sessions", { limit: 200 }), this.client.rpc("feed.list", { pending_only: true }),
    ]);
    this.available = tree.status === "fulfilled";
    if (tree.status !== "fulfilled") {
      for (const record of this.records.values()) this.observe(record, "unavailable");
      return;
    }
    this.tree = tree.value;
    this.feed = feed.status === "fulfilled" ? array(feed.value.items) : [];
    const previous = new Map([...this.records].map(([id, record]) => [id, JSON.stringify(record)]));
    const hooks = readHooks(this.config.cmux.hooksDir ?? join(homedir(), ".cmuxterm"));
    const active = new Map<string, HookSession>();
    for (const hook of hooks) if (hook.surfaceId && (!active.has(hook.surfaceId) || active.get(hook.surfaceId)!.updatedAt < hook.updatedAt)) active.set(hook.surfaceId, hook);
    // Pending launches claim their native IDs before Vault adds history rows.
    for (const hook of hooks) this.mergeHook(hook, active);
    if (vault.status === "fulfilled") for (const row of array(vault.value.sessions)) {
      if (!["claude", "codex"].includes(row.agent) || !string(row.session_id) || !string(row.cwd)) continue;
      const record = this.nativeRecord(row.agent, row.session_id) ?? this.newRecord(row.agent, row.cwd, string(row.title) ?? basename(row.cwd));
      if (!record) continue;
      record.nativeId = row.session_id;
      record.transcript = string(row.file) ?? record.transcript;
    }
    for (const record of this.records.values()) {
      const surface = record.surfaceId ? this.tree.get(record.surfaceId) : undefined;
      const live = surface?.workspaceId === record.workspaceId && surface?.type === "terminal" && (!record.pid || processAlive(record.pid));
      const pending = record.launchedAt !== undefined && Date.now() - record.launchedAt < 30_000;
      const status = live ? "running" : pending ? "starting" : record.creation?.state === "uncertain" ? "unavailable" : "exited";
      if (record.session.id === screenId && live) {
        try {
          // A lines argument enables scrollback on some cmux versions. Read the
          // current viewport so an old dialog in history cannot authorize input.
          const screen = await this.client.rpc("surface.read_text", { surface_id: record.surfaceId, workspace_id: record.workspaceId, scrollback: false });
          if (typeof screen.text !== "string") throw new CmuxError("snapshot-unavailable");
          if (screen.surface_id && screen.surface_id !== record.surfaceId || screen.workspace_id && screen.workspace_id !== record.workspaceId) throw new CmuxError("snapshot-unavailable");
          const replay = await this.client.rpc("terminal.replay", { surface_id: record.surfaceId, workspace_id: record.workspaceId }).catch(() => undefined);
          if (replay?.surface_id && replay.surface_id !== record.surfaceId) throw new CmuxError("snapshot-unavailable");
          if (replay && Number.isInteger(replay.columns) && Number.isInteger(replay.rows) && replay.columns > 0 && replay.columns <= 1000 && replay.rows > 0 && replay.rows <= 1000) {
            record.columns = replay.columns;
            record.rows = replay.rows;
          }
          // Protect a person's unfinished local prompt when chat sends a new
          // instruction. Dim placeholder spans are not text the person typed.
          const grid = replay?.render_grid;
          const cursorRow = grid?.cursor?.row;
          const styles = array(grid?.styles);
          const row = Number.isInteger(cursorRow) && Array.isArray(grid?.row_spans)
            ? array(grid.row_spans).filter(span => span.row === cursorRow).sort((a, b) => a.column - b.column).map(span => {
              const style = styles.find(style => style.id === span.style_id);
              return style?.faint || style?.invisible ? "" : typeof span.text === "string" ? span.text : "";
            }).join("") : screen.text.split("\n").filter((line: string) => /^[\s│┃]*[>›❯]/.test(line)).at(-1);
          record.draft = Boolean(row && /^[\s│┃]*[>›❯]\s*\S/.test(row));
          if (record.screen !== screen.text) {
            record.screen = screen.text.slice(-512 * 1024);
            this.append(record, "output", { text: `\u001b[2J\u001b[H${record.screen.replace(/\r?\n/g, "\r\n")}`, snapshot: true });
          }
        } catch { this.observe(record, "unavailable"); continue; }
      }
      const nativeFeed = matchingFeed(this.feed, { provider: record.session.provider as CmuxProvider, nativeId: record.nativeId, surfaceId: record.surfaceId });
      const prompt = status === "running" ? pendingPrompt(record.session.provider as CmuxProvider, record.screen, nativeFeed) : undefined;
      // Failure to refresh native Feed must never erase a known unanswered approval.
      if (feed.status === "rejected" && record.prompt?.feed) {
        this.observe(record, "unavailable");
        continue;
      }
      this.observe(record, status, prompt);
      if (JSON.stringify(record) !== previous.get(record.session.id)) this.save(record);
    }
  }

  private observe(record: Stored, status: Session["status"], pending?: PendingPrompt) {
    if (record.recordingError) { record.session.status = "recording-error"; return; }
    const before = JSON.stringify(record);
    const at = now();
    if (record.session.status !== status) this.append(record, "lifecycle", { status });
    record.session.status = status;
    if (status !== "running" && status !== "starting") {
      record.controller = undefined;
      // An outage is not evidence that an authenticated Feed decision closed.
      // Keep it latched in durable state until a successful observation resolves it.
      if (status !== "unavailable" || !record.prompt?.feed) record.prompt = undefined;
      record.attention = applyLifecycle(record.attention, status as "exited" | "unavailable" | "recording-error", at);
    } else {
      if (pending?.fingerprint !== record.prompt?.fingerprint) {
        if (record.prompt) this.append(record, "signal", { kind: "prompt-closed", promptId: record.prompt.id, reason: "vanished", source: "host", provider: record.session.provider });
        record.prompt = undefined;
        if (pending) {
          const event = this.append(record, "signal", { kind: "prompt-open", prompt: { ...pending.prompt, id: 0 }, source: pending.prompt.source, provider: record.session.provider });
          record.prompt = { ...pending, id: event.seq };
        }
      } else if (pending && record.prompt) record.prompt = { ...pending, id: record.prompt.id };
      const attentionState = record.prompt || record.lifecycle === "needsInput" ? "needs-you"
        : record.lifecycle === "idle" ? "idle" : "working";
      record.attention = {
        ...record.attention, state: attentionState, source: record.prompt?.prompt.source ?? "lifecycle",
        since: record.attention.state === attentionState ? record.attention.since : at,
        prompt: record.prompt ? { ...record.prompt.prompt, id: record.prompt.id } : undefined,
        now: record.prompt ? record.prompt.prompt.title : record.lifecycle === "needsInput" ? "Input requested in cmux"
          : record.lifecycle === "idle" ? "Waiting for your direction" : "cmux session is connected",
        lastMessage: record.lastMessage, hooks: record.hookAt ? "active" : "none", sawTurnEnd: false,
      };
    }
    this.currentControl(record);
    if (JSON.stringify(record) !== before) this.save(record);
  }

  private state(record: Stored): WorkerState {
    const status = record.recordingError ? "recording-error" : record.session.status;
    return {
      status, pid: record.pid, seq: this.journals.get(record.session.id)?.seq ?? 0, screen: record.screen,
      attention: record.recordingError ? applyLifecycle(record.attention, "recording-error", now()) : record.attention,
      capabilities: { terminalSnapshot: 1, inputControl: 1 }, control: this.currentControl(record),
      runtime: record.session.runtime,
      ...(record.nativeId ? { nativeSession: { id: record.nativeId, source: "hook" as const } } : {}),
    };
  }

  list() {
    const rows = () => [...this.records.values()].map((record) => {
      const { context: _context, initialPrompt: _prompt, nativeArgs: _args, ...session } = record.session;
      const { screen: _screen, ...state } = this.state(record);
      return { ...session, ...state, attention: { ...state.attention, lastMessage: state.attention.lastMessage?.slice(0, 280) } };
    });
    return this.serialize(async () => {
      await this.refresh();
      return rows();
    }, "list").catch(error => {
      if (!(error instanceof CmuxError) || error.code !== "cmux-busy") throw error;
      // Keep managed workers visible when cmux is overloaded, without presenting
      // a cached cmux observation as a connected runtime or valid input lease.
      return rows().map(row => ({ ...row, status: "unavailable" as const, control: null,
        attention: applyLifecycle(row.attention, "unavailable", now()) }));
    });
  }

  get(id: string): Promise<Session & WorkerState> {
    return this.serialize(async () => {
      await this.refresh(id);
      const record = this.stored(id);
      return { ...record.session, ...this.state(record) };
    }, `get:${id}`);
  }

  events(id: string, after = 0, limit = 200, types?: Set<string>) {
    this.stored(id);
    return readEvents(join(this.directory, id, "events"), this.key, id, after, limit, types);
  }

  messages(id: string, after?: string, limit = 200) {
    return this.serialize(async () => {
      await this.refresh();
      const record = this.stored(id);
      return readTranscript(record.transcript, record.session.provider as CmuxProvider, after, limit);
    }, `messages:${id}:${after ?? ""}:${limit}`);
  }

  create(request: CreateSession): Promise<Session & WorkerState> {
    return this.serialize(async () => {
      if (!this.config.cmux?.enabled) throw new CmuxError("cmux-disabled");
      if (!UUID.test(request.requestId) || !["claude", "codex"].includes(request.provider)) throw new CmuxError("unsupported", "cmux supports Claude and Codex sessions");
      if (request.localUi || request.workspace) throw new CmuxError("unsupported", "cmux sessions use the selected machine's terminal");
      this.validText(request.prompt, true);
      const fingerprint = digest(request);
      const existing = this.records.get(request.requestId);
      if (existing) {
        if (existing.creation?.digest !== fingerprint) throw new CmuxError("request-conflict");
        if (existing.creation.state === "uncertain") throw new CmuxError("delivery-uncertain", "The previous create may have reached cmux; inspect existing sessions before creating another");
        await this.refresh(existing.session.id);
        return { ...existing.session, ...this.state(existing) };
      }
      if (existsSync(join(this.directory, request.requestId))) throw new CmuxError("recording-error", "This request has unreadable prior state; it cannot be replayed");
      const project = this.config.projects.find((project) => project.id === request.projectId);
      if (!project) throw new CmuxError("unknown-project");
      const profile = this.config.agents[request.provider];
      if (!profile) throw new CmuxError("unsupported", "Provider is not configured on this machine");
      await this.refresh();
      if (!this.available) throw new CmuxError("cmux-unavailable");
      if ([...this.records.values()].filter((row) => ["running", "starting"].includes(row.session.status)).length >= this.config.maxSessions) throw new CmuxError("session-limit");
      const record = this.newRecord(request.provider as CmuxProvider, project.path, request.title, request.requestId);
      if (!record) throw new CmuxError("unknown-project");
      record.session.initialPrompt = request.prompt;
      const contextFile = join(this.config.stateDir, "contexts", `${project.id}.sealed`);
      if (existsSync(contextFile)) {
        const context = unseal<{ version: number; text: string }>(this.key, `context:${project.id}`, readFileSync(contextFile, "utf8"));
        record.session.contextVersion = context.version;
        record.session.context = context.text;
      }
      record.session.nativeArgs = request.nativeArgs;
      record.creation = { digest: fingerprint, state: "uncertain" };
      record.launchId = randomUUID();
      record.launchedAt = Date.now();
      const prompt = request.nativeArgs !== undefined ? "" : [record.session.context ? `Shared project context (version ${record.session.contextVersion}, provided by the owner):\n${record.session.context}` : "", request.prompt].filter(Boolean).join("\n\n");
      const argv = [...profile.args, ...(request.nativeArgs ?? []), ...(prompt ? [prompt.startsWith("-") ? ` ${prompt}` : prompt] : [])];
      await this.launch(record, profile.command, argv);
      record.creation.state = "delivered";
      this.save(record);
      await this.refresh(record.session.id);
      return { ...record.session, ...this.state(record) };
    });
  }

  private async launch(record: Stored, command: string, argv: string[]) {
    for (const argument of [command, ...argv]) this.validText(argument, true);
    const input = `export ${LAUNCH_ENV}=${quote(record.launchId!)}; exec ${[command, ...argv].map(quote).join(" ")}\r`;
    this.append(record, "input-intent", { op: "launch", launchId: record.launchId });
    this.save(record); // The uncertain intent is durable before the external mutation.
    try {
      const result = await this.client.rpc("workspace.create", { cwd: record.session.cwd, focus: false, initial_input: input });
      const workspaceId = string(result.workspace_id), surfaceId = string(result.surface_id);
      if (!workspaceId || !surfaceId) throw new CmuxError("delivery-uncertain");
      record.workspaceId = workspaceId;
      record.surfaceId = surfaceId;
      record.pid = undefined;
      record.lifecycle = undefined;
      record.controller = undefined;
      record.prompt = undefined;
      record.screen = "";
      record.columns = undefined;
      record.rows = undefined;
      record.draft = undefined;
      this.append(record, "input-result", { op: "launch", state: "delivered" });
      this.save(record);
    } catch {
      throw new CmuxError("delivery-uncertain", "cmux did not confirm session creation; the request will not be replayed");
    }
  }

  resume(id: string, requestId: string): Promise<Session & WorkerState> {
    return this.serialize(async () => {
      if (!UUID.test(requestId)) throw new CmuxError("invalid-request");
      await this.refresh(id);
      const record = this.stored(id);
      const fingerprint = digest({ op: "resume", requestId });
      const previous = record.receipts[requestId];
      if (previous) {
        if (previous.digest !== fingerprint) throw new CmuxError("request-conflict");
        if (previous.state === "uncertain") throw new CmuxError("delivery-uncertain", "Resume may have reached cmux; inspect its sessions before resuming again");
        return { ...record.session, ...this.state(record) };
      }
      if (record.session.status === "running" || record.session.status === "starting") return { ...record.session, ...this.state(record) };
      if (!this.available || record.session.status === "unavailable" || record.recordingError) throw new CmuxError("cmux-unavailable");
      if (!record.nativeId || !/^[a-zA-Z0-9-]{8,200}$/.test(record.nativeId)) throw new CmuxError("unsupported", "No resumable provider conversation was recorded");
      const profile = this.config.agents[record.session.provider];
      if (!profile || !this.project(record.session.cwd)) throw new CmuxError("unsupported");
      if ([...this.records.values()].filter((row) => ["running", "starting"].includes(row.session.status)).length >= this.config.maxSessions) throw new CmuxError("session-limit");
      const event = this.append(record, "input-intent", { op: "resume", requestId });
      record.receipts[requestId] = { requestId, digest: fingerprint, state: "uncertain", seq: event.seq };
      record.launchId = randomUUID();
      record.launchedAt = Date.now();
      record.session.runtime = { id: randomUUID(), location: this.config.environment, transport: "cmux" };
      await this.launch(record, profile.command, [...profile.args, record.session.provider === "claude" ? "--resume" : "resume", record.nativeId]);
      const result = this.append(record, "input-result", { requestId, state: "delivered" });
      record.receipts[requestId] = { requestId, digest: fingerprint, state: "delivered", seq: result.seq };
      this.save(record);
      await this.refresh(id);
      return { ...record.session, ...this.state(record) };
    });
  }

  private currentControl(record: Stored): ControlLease | null {
    if (record.controller && record.controller.lease.expiresAt <= Date.now()) record.controller = undefined;
    return record.controller?.lease ?? null;
  }

  private validActor(actor?: ControlActor): actor is ControlActor {
    return Boolean(actor && typeof actor.id === "string" && actor.id.length > 0 && actor.id.length <= 128 && typeof actor.label === "string" && actor.label.length > 0 && actor.label.length <= 120 && !/[\x00-\x1f\x7f]/.test(actor.id + actor.label));
  }

  private control(record: Stored, request: Extract<WorkerRequest, { op: "control" }>) {
    if (!this.validActor(request.actor)) throw new CmuxError("invalid-control");
    const active = this.currentControl(record);
    const owns = active && record.controller?.actorId === request.actor.id && active.id === request.leaseId;
    if (request.action === "claim") {
      const reconnecting = active && record.controller?.actorId === request.actor.id && !request.leaseId;
      if (active && !owns && !reconnecting && !request.takeover) throw new CmuxError("control-busy");
      record.controller = { actorId: request.actor.id, lease: { id: owns && !request.takeover ? active.id : randomUUID(), label: request.actor.label, expiresAt: Date.now() + LEASE_MS } };
    } else {
      if (!owns) throw new CmuxError("control-lost");
      if (request.action === "release") record.controller = undefined;
      else if (request.action === "renew") record.controller!.lease.expiresAt = Date.now() + LEASE_MS;
      else throw new CmuxError("invalid-control");
    }
    this.save(record);
    return this.currentControl(record);
  }

  private checkControl(record: Stored, request: InputControl) {
    const active = this.currentControl(record);
    if (!this.validActor(request.actor) || !request.leaseId || !active || record.controller?.actorId !== request.actor.id || active.id !== request.leaseId) throw new CmuxError("control-lost");
  }

  private async guard(record: Stored, request: InputControl) {
    this.checkControl(record, request);
    if (!this.available || !this.project(record.session.cwd) || record.session.status !== "running" || record.recordingError || !record.surfaceId || !record.workspaceId) throw new CmuxError("session-unavailable");
    const surface = this.tree.get(record.surfaceId);
    if (!surface || surface.workspaceId !== record.workspaceId || !await foregroundAgent({ pid: record.pid, hookAt: record.hookAt, launchId: record.launchId, surfaceId: record.surfaceId, tty: surface.tty, provider: record.session.provider as CmuxProvider }, this.config.agents[record.session.provider]?.command)) throw new CmuxError("agent-not-foreground", "The agent is not verified in the foreground; input could reach a shell");
    this.checkControl(record, request);
  }

  private validText(text: string, empty = false) {
    if (typeof text !== "string" || (!empty && !text.length) || text.length > 64_000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new CmuxError("invalid-input");
  }

  call<T = unknown>(id: string, request: WorkerRequest): Promise<T> {
    return this.serialize(async () => {
      await this.refresh(id);
      const record = this.stored(id);
      if (request.op === "state") return { ...this.state(record), screen: request.screen ? record.screen : "" } as T;
      if (request.op === "snapshot") {
        if (record.session.status !== "running") throw new CmuxError("snapshot-unavailable");
        return { ansi: `\u001b[2J\u001b[H${record.screen.replace(/\r?\n/g, "\r\n")}`, seq: this.journals.get(id)?.seq ?? 0, cols: record.columns ?? 120, rows: record.rows ?? 40, capturedAt: now() } as T;
      }
      if (request.op === "control") return this.control(record, request) as T;
      if (request.op === "resize") { this.checkControl(record, request); return { cols: record.columns ?? 120, rows: record.rows ?? 40 } as T; }
      if (!["input", "raw", "key", "answer", "stop"].includes(request.op)) throw new CmuxError("unsupported");
      return await this.deliver(record, request as Delivery) as T;
    }, request.op === "state" || request.op === "snapshot" ? `${request.op}:${id}:${request.op === "state" && Boolean(request.screen)}` : undefined);
  }

  private async deliver(record: Stored, request: Delivery): Promise<Receipt & { result?: StoredReceipt["result"] }> {
    if (!UUID.test(request.requestId)) throw new CmuxError("invalid-request");
    const { actor: _actor, leaseId: _lease, ...content } = request;
    const fingerprint = digest(content);
    const previous = record.receipts[request.requestId];
    if (previous) {
      if (previous.digest !== fingerprint) throw new CmuxError("request-conflict");
      return this.publicReceipt(previous);
    }
    await this.guard(record, request);
    if (request.op === "input" || request.op === "raw") this.validText(request.text, request.op === "input");
    if (request.op === "key" && !["interrupt", "enter", "escape", "up", "down", "tab"].includes(request.key)) throw new CmuxError("invalid-input");
    if ((request.op === "input" || request.op === "raw" || request.op === "key" && request.key !== "interrupt") && (record.prompt || record.lifecycle === "needsInput")) throw new CmuxError("prompt-open", "Answer the current prompt explicitly");
    if (request.op === "input" && record.draft) throw new CmuxError("draft-present", "The cmux prompt already contains text; finish or clear it in the terminal before sending a chat message");
    let answer: (() => Promise<StoredReceipt["result"]>) | undefined;
    if (request.op === "answer") answer = this.prepareAnswer(record, request);
    const intent = this.append(record, "input-intent", content);
    const receipt: StoredReceipt = { requestId: request.requestId, digest: fingerprint, state: "uncertain", seq: intent.seq };
    record.receipts[request.requestId] = receipt;
    this.save(record);
    try {
      if (answer) receipt.result = await answer();
      else if (request.op === "input" || request.op === "raw") {
        // terminal.paste is cmux's bracketed-paste operation. Raw control bytes
        // are refused; this adapter cannot safely provide a lossless native PTY.
        const result = await this.client.rpc("terminal.paste", { surface_id: record.surfaceId, workspace_id: record.workspaceId, text: request.text, submit_key: request.op === "input" && request.submit ? "return" : "none" });
        if (result.surface_id && result.surface_id !== record.surfaceId || result.workspace_id && result.workspace_id !== record.workspaceId) throw new CmuxError("delivery-uncertain");
        if (request.op === "input" && request.submit && result.submitted !== true) throw new CmuxError("delivery-uncertain");
      } else if (request.op === "key") {
        await this.client.rpc("surface.send_key", { surface_id: record.surfaceId, key: request.key === "interrupt" ? "ctrl-c" : request.key });
      } else if (request.op === "stop") {
        try { await this.client.rpc("surface.close", { workspace_id: record.workspaceId, surface_id: record.surfaceId }); }
        catch (error) {
          // Only close a whole workspace when a fresh tree proves this is its
          // sole surface. Never close another person's adjacent terminal.
          if (!(error instanceof CmuxError) || error.code !== "invalid_state") throw error;
          const tree = await this.client.tree();
          const owned = [...tree.values()].filter((surface) => surface.workspaceId === record.workspaceId);
          if (owned.length !== 1 || owned[0].id !== record.surfaceId) throw new CmuxError("delivery-uncertain");
          await this.guard(record, request);
          await this.client.rpc("workspace.close", { workspace_id: record.workspaceId });
        }
      }
      const done = this.append(record, "input-result", { requestId: request.requestId, state: "delivered", ...(receipt.result ? { result: receipt.result } : {}) });
      receipt.state = "delivered";
      receipt.seq = done.seq;
      if (this.currentControl(record) && record.controller && record.controller.lease.id === request.leaseId) record.controller.lease.expiresAt = Date.now() + LEASE_MS;
      this.save(record);
      return this.publicReceipt(receipt);
    } catch {
      // The durable uncertain receipt intentionally survives API restarts. No
      // failure path retries an input that may already have reached the agent.
      return this.publicReceipt(receipt);
    }
  }

  private publicReceipt(receipt: StoredReceipt) {
    const { digest: _digest, ...result } = receipt;
    return result;
  }

  private prepareAnswer(record: Stored, request: Extract<Delivery, { op: "answer" }>): () => Promise<StoredReceipt["result"]> {
    const pending = record.prompt;
    if (!pending || pending.id !== request.promptId) throw new CmuxError("prompt-changed");
    if (request.text !== undefined) this.validText(request.text);
    if (request.option !== undefined && (!Number.isInteger(request.option) || request.option < 0)) throw new CmuxError("invalid-option");
    if (request.option === undefined && request.text === undefined) throw new CmuxError("invalid-option");
    if (pending.feed) {
      const reply = feedReply(pending.feed, request.option, request.text);
      return async () => {
        const latest = await this.client.rpc("feed.list", { pending_only: true });
        const feed = matchingFeed(array(latest.items), { provider: record.session.provider as CmuxProvider, nativeId: record.nativeId, surfaceId: record.surfaceId });
        const current = pendingPrompt(record.session.provider as CmuxProvider, record.screen, feed);
        if (!feed || current?.fingerprint !== pending.fingerprint) return "changed";
        await this.guard(record, request);
        await this.client.rpc(reply.method, reply.params);
        const after = await this.client.rpc("feed.list", { pending_only: true });
        return array(after.items).some((row) => row.request_id === feed.request_id && (!row.status || row.status === "pending")) ? "still-open" : "closed";
      };
    }
    const prompt = pending.prompt;
    if (prompt.multiSelect || request.text !== undefined) throw new CmuxError("unsupported", "Use the cmux native question interface for this prompt");
    const choice = prompt.options[request.option ?? -1];
    if (!choice) throw new CmuxError("invalid-option");
    return async () => {
      const read = async (): Promise<Prompt | undefined> => {
        const screen = await this.client.rpc("surface.read_text", { surface_id: record.surfaceId, workspace_id: record.workspaceId, scrollback: false });
        if (screen.surface_id && screen.surface_id !== record.surfaceId || screen.workspace_id && screen.workspace_id !== record.workspaceId) return undefined;
        const current = pendingPrompt(record.session.provider as CmuxProvider, typeof screen.text === "string" ? screen.text : "");
        return current?.fingerprint === pending.fingerprint ? { ...current.prompt, id: pending.id } : undefined;
      };
      let current = await read();
      if (!current) return "changed";
      if (prompt.kind === "yes-no") {
        await this.guard(record, request);
        await this.client.rpc("surface.send_text", { surface_id: record.surfaceId, workspace_id: record.workspaceId, text: `${choice.role === "accept" ? "y" : "n"}\r` });
        await new Promise((resolve) => setTimeout(resolve, 80));
        return await read() ? "still-open" : "closed";
      } else {
        if (current.highlighted === undefined) return "refused";
        for (let count = 0; current.highlighted !== choice.index && count < 50; count++) {
          await this.guard(record, request);
          await this.client.rpc("surface.send_key", { surface_id: record.surfaceId, key: current.highlighted! < choice.index ? "down" : "up" });
          await new Promise((resolve) => setTimeout(resolve, 40));
          current = await read();
          if (!current) return "changed";
        }
        if (current.highlighted !== choice.index) return "refused";
      }
      await this.guard(record, request);
      if (!await read()) return "changed";
      await this.client.rpc("surface.send_key", { surface_id: record.surfaceId, key: "enter" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      return await read() ? "still-open" : "closed";
    };
  }

  /** Closing the adapter does not close or interrupt any cmux terminal. */
  async close(): Promise<void> { this.closed = true; await this.draining; }
}
