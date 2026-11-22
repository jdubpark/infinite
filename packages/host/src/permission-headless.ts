/**
 * The headless permission channel, host side. A headless Claude Code session has no dialog, so its calls reach the
 * permission agent through two host hooks (see launch.ts `headlessChannelArgs`). The session's worker forwards each
 * hook call here over a private socket, bound to that session by a key only the host and the session's worker hold.
 * This module builds the request from the host's own records, asks the pipeline, records delivery, and answers.
 * It decides nothing itself: without a pipeline, or for a project the pipeline does not serve, a call is handled as
 * before. It never allows a call that a class rule matched.
 */
import { createConnection, createServer, type Server } from "node:net";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { matchDestructive } from "@infinite/attention";
import { headlessLaunch } from "./launch.js";
import { REJECT_CODES, requesterNotice, type InterruptClass, type RejectCode } from "./permission-policy.js";
import { teamPermissionAssignment } from "./team-permission-adapter.js";
import type {
  HeadlessChannelStatus, HeadlessSessionStatus, HeadlessShadowedRule, PermissionAgentServices, PermissionHeadlessChannel,
  PermissionPipeline, PermissionRequest,
} from "./permission-agent-types.js";
import type { PermissionDelivery } from "./evidence/permission-journal.js";
import type { AgentProfile, Event, PermissionChannelView, Provider, Session } from "./types.js";

export const CHANNEL_SOCKET = "permission-channel.sock";
export const channelSocketPath = (runDir: string) => join(runDir, CHANNEL_SOCKET);
/** How long the worker waits for a class check. */
export const CLASS_CHECK_MS = 10_000;
/** How long the worker waits for a decision: past the five-minute review bound, below the hook's own deadline. */
export const DECIDE_MS = 335_000;
const MAX_LINE = 512 * 1024;

/** The session's channel key. Only the host and that session's worker can compute it; the agent never sees it. */
export function channelToken(key: Buffer, sessionId: string): string {
  return createHmac("sha256", key).update(`infinite-permission-channel:${sessionId}`).digest("hex");
}

/**
 * Binds one decision to the session it was issued to. The channel returns it with the decision id, and a delivery
 * event must carry it. It holds no state, so a delivery after an API restart is still recorded for that session only.
 */
export function deliveryKey(key: Buffer, sessionId: string, decisionId: string): string {
  return createHmac("sha256", key).update(`infinite-permission-delivery:${sessionId}:${decisionId}`).digest("hex");
}

/** One tool call as the provider's hook reported it to the session's own worker. */
export interface ChannelCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  /** Set for a call made inside a subagent. */
  agentId?: string;
}

export type ChannelRequest =
  | { v: 1; op: "class"; sessionId: string; token: string; call: ChannelCall }
  | { v: 1; op: "decide"; sessionId: string; token: string; call: ChannelCall; requestId: string }
  | { v: 1; op: "delivery"; sessionId: string; token: string; decisionId: string; deliveryKey: string; kind: PermissionDelivery["kind"]; detail?: string }
  /**
   * Asked before the owner's allow of a deferred call is returned to the resumed call. `sessionRoot` is the root the
   * deferral was decided under; `decisionId` and `deliveryKey` are set when the deferral was issued a decision. `call`
   * is the resumed call, which the host reads again; a worker of an earlier release sends none.
   */
  | { v: 1; op: "resume"; sessionId: string; token: string; sessionRoot: string; decisionId?: string; deliveryKey?: string; call?: ChannelCall };

/** A decision the channel returned, with the key that lets this session's worker record its delivery. */
export type IssuedDecision = { decisionId: string; deliveryKey: string };

export type ChannelReply =
  /** The pipeline does not serve this session now. The call is handled as before. */
  | { result: "not-served" }
  /** No class rule matched. The provider's own rules apply. */
  | { result: "none" }
  /** A class rule matched: the call needs the owner's own answer. `sessionRoot` is the root it was decided under. */
  | ({ result: "owner"; interruptClass: InterruptClass; rule: string; sessionRoot?: string } & Partial<IssuedDecision>)
  | ({ result: "allow" } & IssuedDecision)
  /** `notice` is the host's fixed text for the code. `interruptClass` is set when the owner must be told. */
  | ({ result: "deny"; code: RejectCode; notice: string; interruptClass?: InterruptClass | "undeliverable" } & Partial<IssuedDecision>)
  | { result: "recorded" }
  /** The owner's allow of a deferred call may be returned to the resumed call now. */
  | { result: "ok" }
  /** The owner's allow is withheld: an owner halt covers the project, or the session or decision no longer applies. */
  | { result: "withheld"; reason: "halted" | "stale" };

/** One request over the channel socket. Rejects on a timeout or a refused connection, so the caller can deny. */
export function channelCall(socket: string, request: ChannelRequest, timeoutMs: number): Promise<ChannelReply> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let data = "";
    connection.setTimeout(timeoutMs, () => connection.destroy(new Error("The permission channel did not answer in time")));
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", chunk => {
      data += chunk;
      if (data.length > MAX_LINE) return connection.destroy(new Error("Oversized permission channel reply"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(data.slice(0, end)) as ChannelReply & { error?: string };
        connection.end();
        if (reply.error) reject(new Error("The permission channel refused the request"));
        else resolve(reply);
      } catch (error) { connection.destroy(); reject(error); }
    });
    connection.on("error", reject);
    connection.on("close", () => { if (!data.includes("\n")) reject(new Error("The permission channel is unavailable")); });
  });
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (text: unknown, limit: number) => String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, limit);

/** The action as the host extracts it from a tool input, bounded to 2,000 characters. */
export function headlessAction(tool: string, input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command : undefined;
  if (command !== undefined) return bounded(command, 2000);
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  return bounded(path !== undefined ? `${tool} ${path}` : `${tool} ${JSON.stringify(input)}`, 2000);
}

/**
 * The seat a headless session works in. A team member's seat is the one the interactive team adapter gives it, so
 * the journal's rejects and locks are shared by both paths. A session outside a run is its own seat, as in the
 * session adapter.
 */
export function headlessAssignment(session: Pick<Session, "id" | "team">): string {
  const team = session.team;
  return team ? teamPermissionAssignment({ id: team.runId }, { role: team.role, ...(team.taskId ? { taskId: team.taskId } : {}) }) : session.id;
}

/**
 * The task a permission reviewer reads for a headless call. A session outside a run is its own task: its title and its
 * prompt. A team session's task is the host's team projection, and it is undefined when that cannot be read, so the
 * call is not served. The member's prompt never reaches a team member's reviewer.
 */
export function headlessTask(session: Pick<Session, "team" | "title" | "initialPrompt">, teamTask: ((session: Pick<Session, "team">) => { title: string; text: string } | undefined) | undefined): { title: string; text: string } | undefined {
  if (!session.team) return { title: bounded(session.title, 200), text: bounded(session.initialPrompt, 4000) };
  try { return teamTask?.(session); } catch { return undefined; }
}

/** The request id of a call's class check. The resume check builds the same id for the same call. */
function classRequestId(sessionId: string, call: ChannelCall): string {
  return `headless:${sessionId}:${call.toolUseId ?? createHash("sha256").update(JSON.stringify(call)).digest("hex")}`;
}

/** Builds the request from the host's records of the session. Only the tool call itself comes from the hook. */
export function headlessRequest(session: Session, call: ChannelCall, id: string, task: { title: string; text: string }): PermissionRequest {
  const sessionRoot = realpathSync(session.cwd);
  const input = call.toolInput;
  const action = headlessAction(call.toolName, input);
  const pattern = typeof input.command === "string" ? matchDestructive(input.command) : null;
  return {
    id,
    requester: {
      kind: "headless",
      sessionId: session.id,
      projectId: session.projectId,
      taskId: session.team?.runId ?? session.id,
      assignment: headlessAssignment(session),
      ...(session.team ? { role: session.team.role } : {}),
      provider: session.provider,
      ...(session.teamModelProfile?.model ? { model: session.teamModelProfile.model } : {}),
      sessionRoot,
      scratchRoots: [],
      task,
    },
    tool: call.toolName,
    input,
    action,
    ...(pattern ? { destructive: { pattern } } : {}),
    // A headless call carries its complete input and is answered once, allow or deny.
    shape: { completeEvidence: true, oneShotAccept: true, oneShotReject: true, persistentOnly: false, trustPrompt: false },
    evidenceHash: sha256({ v: 1, kind: "headless", sessionId: session.id, sessionRoot, tool: call.toolName, input }),
    reuseKey: sha256({ v: 1, kind: "headless", projectId: session.projectId, sessionRoot, tool: call.toolName, input }),
  };
}

/** The synthetic call an allow rule admits, for the shadow check. A rule with no literal command or path is skipped. */
function ruleCall(rule: string): ChannelCall | undefined {
  const match = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(rule.trim());
  if (!match) return undefined;
  const [, tool, spec] = match;
  const literal = spec.replace(/(?::\*|\s\*|\*)$/, "").trim();
  if (!literal) return undefined;
  if (tool === "Bash") return { toolName: tool, toolInput: { command: literal } };
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return { toolName: tool, toolInput: { file_path: literal } };
  return undefined;
}

export interface HeadlessAdmission {
  record: NonNullable<Session["headless"]>;
  bootstrap?: { socket: string };
}

type Sessions = {
  meta(id: string): { session: Session };
  list(): Promise<Array<Record<string, unknown>>>;
};

/**
 * The host side of the channel. `services` is the server's registry: the pipeline is read from it on every call,
 * so a pipeline that is absent, or added later, takes effect at once.
 */
export class HeadlessPermissionChannel implements PermissionHeadlessChannel {
  private server?: Server;
  constructor(private readonly options: {
    key: Buffer;
    runDir: string;
    sessions: Sessions;
    services: PermissionAgentServices;
    /**
     * Whether the run of a team member's session is live now: not stopped, paused, halted, or with its permissions
     * revoked. A session with `team` is served only when this is given and returns true. A throw counts as false.
     */
    teamLive?: (session: Session) => boolean;
    /**
     * The task a permission reviewer reads for a team member's session, from the run in memory. A session with `team`
     * is served only when this returns a task; a throw or undefined leaves the session not served.
     */
    teamTask?: (session: Pick<Session, "team">) => { title: string; text: string } | undefined;
  }) {}

  private pipeline(): PermissionPipeline | undefined { return this.options.services.pipeline; }

  /** A session outside a run is not limited here. A team member's session is served only while its run is live. */
  private teamServed(session: Session): boolean {
    if (!session.team) return true;
    const live = this.options.teamLive;
    if (!live) return false;
    try { return live(session) === true; } catch { return false; }
  }

  private issued(decisionId: string, sessionId: string): IssuedDecision {
    return { decisionId, deliveryKey: deliveryKey(this.options.key, sessionId, decisionId) };
  }

  /** Whether a decision id and its key were issued to this session. */
  private bound(sessionId: string, decisionId: unknown, key: unknown): decisionId is string {
    return typeof decisionId === "string" && decisionId.length >= 1 && decisionId.length <= 200 &&
      typeof key === "string" && /^[a-f0-9]{64}$/.test(key) &&
      timingSafeEqual(Buffer.from(key), Buffer.from(deliveryKey(this.options.key, sessionId, decisionId)));
  }

  /**
   * Whether the owner's allow of a deferred call may still be returned to the resumed call: the session keeps the
   * root the deferral was decided under, no owner halt covers its project, and the decision the deferral was issued
   * still applies. A deferral issued no decision gets no allow. The owner's answer may be days old, so it is read
   * now, at the moment the call would run: the resumed call is read again with the task as it is now, and a reading
   * that no longer gives the deferral's decision withholds the allow.
   */
  private resumable(session: Session, request: Extract<ChannelRequest, { op: "resume" }>): ChannelReply {
    if (typeof request.sessionRoot !== "string" || request.sessionRoot.length < 1 || request.sessionRoot.length > 4096) throw new Error("invalid");
    const issued = request.decisionId !== undefined || request.deliveryKey !== undefined;
    if (issued && !this.bound(session.id, request.decisionId, request.deliveryKey)) throw new Error("unbound");
    const pipeline = this.pipeline();
    if (!session.headless?.channel || !pipeline) return { result: "withheld", reason: "stale" };
    let root: string | undefined;
    try { root = realpathSync(session.cwd); } catch { root = undefined; }
    if (root !== request.sessionRoot) return { result: "withheld", reason: "stale" };
    // A team member's run must still be live: stopped, paused, halted or revoked runs get no allow from here.
    if (!this.teamServed(session)) return { result: "withheld", reason: "stale" };
    // A halt that cannot be read counts as a halt.
    let halted: boolean;
    try { halted = pipeline.halted?.(session.projectId) === true; } catch { halted = true; }
    if (halted) return { result: "withheld", reason: "halted" };
    // The allow is bound to the decision its deferral was issued, whose authority holds every recorded halt. A deferral
    // without one is bound to no authority, so no allow is returned for it.
    if (!issued) return { result: "withheld", reason: "stale" };
    const raw = (request as { call?: unknown }).call;
    const call = raw === undefined ? undefined : validCall(raw);
    if (raw !== undefined && !call) throw new Error("invalid");
    let applies: boolean;
    try {
      // The class check gave the deferred call this request id, so an unchanged reading gives the deferral's decision id.
      const task = call && headlessTask(session, this.options.teamTask);
      const again = call && task && headlessRequest(session, call, classRequestId(session.id, call), task);
      applies = (call === undefined || again !== undefined) && pipeline.applicable(request.decisionId!, again) === true;
    } catch { applies = false; }
    if (!applies) return { result: "withheld", reason: "stale" };
    return { result: "ok" };
  }

  /**
   * Decides at launch whether a session gets the channel. Undefined for a launch that is not headless. A headless
   * launch the channel cannot serve gets a record with the reason, and launches exactly as before.
   */
  admit(input: { provider: Provider; profile: AgentProfile; session: Session; hooks: boolean }): HeadlessAdmission | undefined {
    const shape = headlessLaunch(input.provider, input.profile);
    if (!shape.headless) return undefined;
    const refuse = (reason: string): HeadlessAdmission => ({ record: { channel: false, reason, ...(shape.allowlist.length ? { allowlist: shape.allowlist } : {}) } });
    if (input.session.team?.role === "permission-coordinator") return refuse("The permission agent's own turns are never served.");
    if (shape.unservable) return refuse(shape.unservable);
    if (!input.hooks) return refuse("The session starts without the host's hooks.");
    const pipeline = this.pipeline();
    if (!pipeline) return refuse("The permission pipeline is not on this host.");
    let served;
    try { served = pipeline.serves(input.session.projectId); } catch { return refuse("The permission pipeline could not be read."); }
    if (!served.served) return refuse(served.reason === "not-ready" ? "The host is not ready to serve permission requests." : "No owner act covers this project.");
    return { record: { channel: true, ...(shape.allowlist.length ? { allowlist: shape.allowlist } : {}) }, bootstrap: { socket: channelSocketPath(this.options.runDir) } };
  }

  /** Starts the private socket. A stale socket file from an earlier host process is replaced. */
  listen(): Promise<void> {
    const path = channelSocketPath(this.options.runDir);
    try { if (lstatSync(path).isSocket()) rmSync(path); } catch { /* none yet */ }
    const server = createServer(connection => {
      let data = "";
      connection.setTimeout(10_000, () => connection.destroy());
      connection.on("error", () => {});
      connection.on("data", chunk => {
        data += chunk;
        if (data.length > MAX_LINE) return connection.destroy();
        const end = data.indexOf("\n");
        if (end < 0) return;
        connection.pause();
        connection.setTimeout(0);
        let request: unknown;
        try { request = JSON.parse(data.slice(0, end)); } catch { return void connection.end(JSON.stringify({ error: "invalid" }) + "\n"); }
        this.handle(request).then(
          reply => connection.end(JSON.stringify(reply) + "\n"),
          () => connection.end(JSON.stringify({ error: "refused" }) + "\n"),
        );
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        try { chmodSync(path, 0o600); } catch { /* the run directory is private already */ }
        resolve();
      });
    });
  }

  close() { this.server?.close(); this.server = undefined; }

  /** Answers one request. Throws for a request that is malformed or not bound to its session. */
  async handle(raw: unknown): Promise<ChannelReply> {
    const request = raw as ChannelRequest;
    if (!request || typeof request !== "object" || request.v !== 1 || typeof request.sessionId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(request.sessionId) || typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token))
      throw new Error("invalid");
    const expected = Buffer.from(channelToken(this.options.key, request.sessionId));
    if (!timingSafeEqual(Buffer.from(request.token), expected)) throw new Error("unbound");
    const session = this.options.sessions.meta(request.sessionId).session;
    if (request.op === "delivery") {
      if (!this.bound(session.id, request.decisionId, request.deliveryKey) || !["intent", "receipt", "refusal", "uncertain", "stale"].includes(request.kind))
        throw new Error("unbound");
      this.pipeline()?.recordDelivery(request.decisionId, request.kind, request.detail === undefined ? undefined : bounded(request.detail, 500));
      return { result: "recorded" };
    }
    if (request.op === "resume") return this.resumable(session, request);
    const call = validCall((request as { call?: unknown }).call);
    if (!call || (request.op !== "class" && request.op !== "decide")) throw new Error("invalid");
    const pipeline = this.pipeline();
    if (!session.headless?.channel || !pipeline) return { result: "not-served" };
    if (!pipeline.serves(session.projectId).served || !this.teamServed(session)) return { result: "not-served" };
    // A team session whose task cannot be read is not served; no request is built for it.
    const task = headlessTask(session, this.options.teamTask);
    if (!task) return { result: "not-served" };
    if (request.op === "class") {
      const built = headlessRequest(session, call, classRequestId(session.id, call), task);
      const match = pipeline.classOf(built);
      if (!match) return { result: "none" };
      // The decision is recorded through the pipeline; its class rules run first, so no model turn starts.
      let outcome;
      try { outcome = await pipeline.decide(built); } catch { outcome = undefined; }
      if (outcome?.kind === "not-served") return { result: "not-served" };
      // An owner halt: nothing is decided or recorded, and no answer may wait for the release, so the call is denied.
      if (outcome?.kind === "held") return { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") };
      if (outcome?.kind === "owner")
        return { result: "owner", interruptClass: outcome.interruptClass, rule: match.rule, sessionRoot: built.requester.sessionRoot, ...this.issued(outcome.decisionId, session.id) };
      // Any other outcome, or none, gives no owner decision that an answer could be bound to, so the call cannot wait
      // for the owner. It is denied with needs-owner, and the owner is told with the class rule's class.
      const decided = outcome && "decisionId" in outcome && typeof outcome.decisionId === "string" ? this.issued(outcome.decisionId, session.id) : undefined;
      if (decided) pipeline.recordDelivery(decided.decisionId, "refusal", "Headless: a class call got no owner decision; it was denied with needs-owner.");
      return { result: "deny", code: "needs-owner", notice: requesterNotice("needs-owner"), interruptClass: match.interruptClass, ...(decided ?? {}) };
    }
    if (typeof request.requestId !== "string" || !/^headless:[a-f0-9-]{36}:[A-Za-z0-9_:-]{1,200}$/.test(request.requestId)) throw new Error("invalid");
    const built = headlessRequest(session, call, request.requestId, task);
    let outcome;
    try { outcome = await pipeline.decide(built, { signal: AbortSignal.timeout(DECIDE_MS - 5_000) }); }
    catch { return { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") }; }
    if (outcome.kind === "not-served") return { result: "not-served" };
    // An owner halt: nothing is decided or recorded. A headless call cannot wait for the release, so it is denied.
    if (outcome.kind === "held") return { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") };
    if (outcome.kind === "undeliverable")
      return { result: "deny", code: "needs-owner", notice: requesterNotice("needs-owner"), interruptClass: "undeliverable" };
    const issued = this.issued(outcome.decisionId, session.id);
    if (outcome.kind === "owner") {
      // A PermissionRequest hook cannot defer a call: it is denied, recorded, and the owner is told with the class.
      pipeline.recordDelivery(outcome.decisionId, "refusal", "Headless: a call that the rules left open cannot wait for the owner; it was denied with needs-owner.");
      return { result: "deny", code: "needs-owner", notice: requesterNotice("needs-owner"), ...issued, interruptClass: outcome.interruptClass };
    }
    // The live checks before a verdict is returned, an allow or a reject. A team member's run and the task are read
    // again here: the verdict was reached for the task the request was built with.
    const live = (() => {
      try {
        const now = this.options.sessions.meta(session.id).session;
        const again = headlessTask(now, this.options.teamTask);
        return realpathSync(now.cwd) === built.requester.sessionRoot && again?.title === task.title && again.text === task.text &&
          this.teamServed(session) && pipeline.applicable(outcome.decisionId, built);
      } catch { return false; }
    })();
    if (!live) {
      // An owner halt that was recorded while the call was decided: the verdict is withheld, as at entry.
      let halted: boolean;
      try { halted = pipeline.halted?.(session.projectId) === true; } catch { halted = true; }
      if (halted) {
        pipeline.recordDelivery(outcome.decisionId, "stale", "Headless: an owner halt covers the project; the verdict was withheld and the call was denied as unavailable.");
        return { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") };
      }
      pipeline.recordDelivery(outcome.decisionId, "stale", "Headless: the decision no longer applies; the call was left to the provider, which denies it.");
      return { result: "not-served" };
    }
    if (outcome.kind === "reject") {
      // The notice is rebuilt from the code, so no other text can reach the agent.
      const code = (REJECT_CODES as readonly string[]).includes(outcome.code) ? outcome.code : "unavailable";
      pipeline.recordDelivery(outcome.decisionId, "intent", "Headless deny returned to the session's hook.");
      return { result: "deny", code, notice: requesterNotice(code), ...issued };
    }
    if (built.destructive && !outcome.strongTier) {
      pipeline.recordDelivery(outcome.decisionId, "refusal", "Headless: a destructive call needs a strong verdict; it was denied.");
      return { result: "deny", code: "uncertain", notice: requesterNotice("uncertain"), ...issued };
    }
    pipeline.recordDelivery(outcome.decisionId, "intent", "Headless allow returned to the session's hook.");
    return { result: "allow", ...issued };
  }

  /** Headless sessions that are live now, served or not and why, and the allow rules that a class rule outranks. */
  async status(): Promise<HeadlessChannelStatus> {
    const sessions: HeadlessSessionStatus[] = [];
    const shadowed: HeadlessShadowedRule[] = [];
    const pipeline = this.pipeline();
    for (const row of await this.options.sessions.list()) {
      const status = row.status;
      if (status !== "running" && status !== "starting") continue;
      if (!row.headless) continue;
      const id = String(row.id);
      let session: Session;
      try { session = this.options.sessions.meta(id).session; } catch { continue; }
      if (!session.headless) continue;
      const view = row.permissionChannel as PermissionChannelView | undefined;
      const state: HeadlessSessionStatus["state"] = !session.headless.channel ? "not-served" : view?.served ? "served" : "admitted";
      sessions.push({
        sessionId: id, projectId: session.projectId, title: bounded(session.title, 200), provider: session.provider, state,
        ...(state === "not-served" ? { reason: session.headless.reason ?? "The permission channel does not serve this launch." }
          : state === "admitted" ? { reason: "No hook call of this session has arrived; it behaves as before." } : {}),
        ...(view?.waiting ? { waiting: view.waiting } : {}),
      });
      if (!session.headless.channel || !pipeline) continue;
      // A team session whose task cannot be read is skipped, as it is not served.
      const task = headlessTask(session, this.options.teamTask);
      if (!task) continue;
      for (const rule of session.headless.allowlist ?? []) {
        const call = ruleCall(rule);
        if (!call) continue;
        try {
          const match = pipeline.classOf(headlessRequest(session, call, `headless:${id}:shadow`, task));
          if (match) shadowed.push({ sessionId: id, rule, interruptClass: match.interruptClass, classRule: match.rule });
        } catch { /* a rule that cannot be checked is not listed */ }
      }
    }
    return { sessions, shadowed };
  }
}

function validCall(value: unknown): ChannelCall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const call = value as Partial<ChannelCall>;
  if (typeof call.toolName !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(call.toolName) ||
      !call.toolInput || typeof call.toolInput !== "object" || Array.isArray(call.toolInput) ||
      (call.toolUseId !== undefined && (typeof call.toolUseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(call.toolUseId))) ||
      (call.agentId !== undefined && (typeof call.agentId !== "string" || call.agentId.length > 128)))
    return undefined;
  return { toolName: call.toolName, toolInput: call.toolInput, ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}), ...(call.agentId ? { agentId: call.agentId } : {}) };
}

/**
 * Whether a session's journal holds a deferred call that was never returned to the provider. Such a session must not
 * be resumed by the ordinary resume: its provider would ask for that call again with no channel to answer it, and the
 * launch profile's allowlist would decide a call that a class rule sent to the owner.
 */
export function deferredCallOpen(events: (after: number, limit: number) => { events: Event[]; cursor: number; more: boolean }): boolean {
  const open = new Set<string>();
  let cursor = 0;
  for (;;) {
    const page = events(cursor, 200);
    for (const event of page.events) {
      const channel = (event.data as { permissionChannel?: { event?: string; callId?: string } }).permissionChannel;
      if (!channel?.callId) continue;
      if (channel.event === "deferred") open.add(channel.callId);
      else if (channel.event === "delivered") open.delete(channel.callId);
    }
    if (!page.more) return open.size > 0;
    cursor = page.cursor;
  }
}
