import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Prompt } from "@infinite/attention";
import type { Blackboard } from "../../packages/host/src/evidence/blackboard.js";
import type { Manager } from "../../packages/host/src/manager.js";
import { permissionAuthorityHash, permissionEvidenceHash } from "../../packages/host/src/team-permissions.js";
import type { TeamRun, TeamStatus, TeamView } from "../../packages/host/src/team-types.js";
import { TeamError } from "../../packages/host/src/team-workspace.js";
import { memberStallReason, TeamService } from "../../packages/host/src/teams.js";
import { unseal } from "../../packages/host/src/vault.js";
import { bump, type Counts, type Rand, rand } from "../outcome-sim-script.js";
import { schedulerFixture } from "./team-scheduler.js";

export class Violation extends Error {}
export class HostStopped extends Error {}

export type Kind = "pause" | "resume" | "cancel" | "steer" | "revoke" | "answer" | "continue";
const KINDS: readonly Kind[] = ["pause", "resume", "cancel", "steer", "revoke", "answer", "continue"];
type Body = { requestId: string; revision: number; text?: string };
type Request = { kind: Kind; body: Body; decisionId?: string };
type Saved = { run: TeamRun; receipts: Record<string, string>; halt?: string };
type Fixture = ReturnType<typeof schedulerFixture>;

const EVENT: Record<Kind, string> = {
  pause: "Team paused.", cancel: "Team cancelled.", resume: "Team resumed with a fresh plan.", steer: "User steering recorded.",
  revoke: "Delegated permission decisions were revoked by the owner.", answer: "A user decision was recorded.",
  continue: "Owner continued the run from its clean integration commit",
};
const SETTLED: ReadonlySet<TeamStatus> = new Set(["cancelled", "merged", "no-change", "ready-for-review"]);
const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
export const RERUN = (seed: number) => `TEAM_SIM_SEED=${seed} node --import tsx --test tests/team-run-sim.test.ts`;

type Model = {
  status: TeamStatus; revision: number; halted: boolean; steering: readonly string[]; answers: Readonly<Record<string, string>>;
  revoked: boolean; continued: number; events: Readonly<Record<Kind, number>>;
  acked: Readonly<Record<string, { request: Request; receipt: string }>>;
  replannable: boolean;
};

function apply(m: Model, request: Request): Model {
  const next = { ...m, steering: [...m.steering], answers: { ...m.answers }, events: { ...m.events } };
  const happened = () => { next.events[request.kind] += 1; };
  switch (request.kind) {
    case "pause": next.status = "paused"; next.halted = true; happened(); break;
    case "cancel": next.status = "cancelled"; next.halted = true; happened(); break;
    case "steer": next.revision += 1; next.steering.push(request.body.text!); next.status = "planning"; next.halted = true; happened(); break;
    case "resume":
      if (m.status === "paused" || m.status === "blocked" && m.replannable) { next.revision += 1; next.status = "planning"; happened(); }
      break;
    case "revoke": next.revoked = true; happened(); break;
    case "answer": next.answers[request.decisionId!] = request.body.text!; happened(); break;
    case "continue":
      next.revision += 1; next.status = "planning"; next.halted = false; next.continued += 1;
      if (request.body.text) next.steering.push(request.body.text);
      happened(); break;
  }
  if (next.status !== "blocked") next.replannable = false;
  return next;
}

function acknowledge(pre: Model, request: Request, receipt = ""): Model {
  return { ...apply(pre, request), acked: { ...pre.acked, [request.body.requestId]: { request, receipt } } };
}

const INTERMEDIATE: Readonly<Record<string, (pre: Model) => Partial<Model>>> = {
  "revoke:1": () => ({ revoked: true }),
};

type Projection = Omit<Model, "acked" | "replannable"> & { receipts: string[] };
type Allowed = readonly (readonly [string, Model])[];

function project(saved: Saved): Projection {
  const run = saved.run;
  const events = Object.fromEntries(KINDS.map(kind => [kind, run.events.filter(event => event.text.startsWith(EVENT[kind])).length])) as Record<Kind, number>;
  return { status: run.status, revision: run.revision, halted: Boolean(saved.halt), steering: run.steering.map(item => item.text),
    answers: Object.fromEntries(run.decisions.filter(item => item.answer !== undefined).map(item => [item.id, item.answer!])),
    revoked: Boolean(run.permissionsRevokedAt), continued: run.continuations?.length ?? 0, events, receipts: Object.keys(saved.receipts).sort() };
}

function expected(m: Model): Projection {
  const { acked, replannable: _replannable, ...rest } = m;
  return { ...rest, receipts: Object.keys(acked).sort() };
}

function match(saved: Saved, allowed: Allowed): string | undefined {
  const got = project(saved);
  return allowed.find(([, m]) => isDeepStrictEqual(expected(m), got))?.[0];
}

function difference(want: Projection, got: Projection): string {
  return (Object.keys(want) as (keyof Projection)[]).filter(key => !isDeepStrictEqual(want[key], got[key]))
    .map(key => `${key} is ${JSON.stringify(got[key])}, the model has ${JSON.stringify(want[key])}`).join("; ");
}

type Start = "working" | "paused" | "stalled" | "waiting" | "continuable";
const STARTS: readonly Start[] = ["working", "paused", "stalled", "waiting", "continuable"];
type Step =
  | { do: "request"; kind: Kind; stale: boolean; stopAt: number; again: boolean; settle: boolean; requestId: string; text?: string; decision: "open" | "unknown" }
  | { do: "retry"; pick: number }
  | { do: "conflict"; pick: number; kind: Kind; text: string }
  | { do: "pass"; stopAt: number }
  | { do: "restart" };
type Script = { start: Start; delegated: boolean; ids: readonly string[]; steps: Step[] };

function weighted<T>(r: Rand, table: readonly (readonly [number, T])[]): T {
  let roll = r.next() * table.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, item] of table) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return table[0]![1];
}

function uuid(r: Rand): string {
  const hex = Array.from({ length: 32 }, () => r.int(0, 15).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[r.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const STEPS_PER_SEED = 14;
const STOPS: Record<"twice" | "once", readonly (readonly [number, number])[]> = { twice: [[45, 1], [45, 2], [10, 3]], once: [[70, 1], [25, 2], [5, 3]] };
const KIND_WEIGHTS: Record<Start, readonly (readonly [number, Kind])[]> = {
  working: [[20, "pause"], [10, "resume"], [5, "cancel"], [20, "steer"], [10, "revoke"], [3, "answer"], [3, "continue"]],
  paused: [[10, "pause"], [25, "resume"], [5, "cancel"], [15, "steer"], [10, "revoke"], [3, "answer"], [3, "continue"]],
  stalled: [[10, "pause"], [25, "resume"], [5, "cancel"], [15, "steer"], [10, "revoke"], [3, "answer"], [5, "continue"]],
  waiting: [[10, "pause"], [8, "resume"], [4, "cancel"], [10, "steer"], [8, "revoke"], [35, "answer"], [3, "continue"]],
  continuable: [[8, "pause"], [10, "resume"], [4, "cancel"], [8, "steer"], [12, "revoke"], [3, "answer"], [35, "continue"]],
};

function script(seed: number): Script {
  const r = rand(seed);
  const start = STARTS[seed % STARTS.length]!;
  const delegated = r.chance(start === "continuable" ? 0.3 : 0.6);
  const ids = [uuid(r), uuid(r), uuid(r), uuid(r)];
  const kinds = KIND_WEIGHTS[start];
  const steps: Step[] = [];
  for (let index = 0; index < STEPS_PER_SEED; index += 1) {
    const what = weighted(r, [[64, "request"], [8, "retry"], [6, "conflict"], [12, "pass"], [8, "restart"]] as const);
    if (what === "request") {
      const kind = weighted(r, kinds), direction = `Direction ${index}: ${r.pick(["keep the API stable", "drop the cache", "add a test"])}.`;
      const text = kind === "answer" ? r.pick(["a", "b"]) : kind === "steer" || kind === "continue" && r.chance(0.5) ? direction : undefined;
      const stale = r.chance(0.1), stopAt = r.chance(0.6) ? weighted(r, STOPS[kind === "continue" || kind === "answer" ? "once" : "twice"]) : 0;
      steps.push({ do: "request", kind, stale, stopAt, again: r.chance(0.15), settle: r.chance(0.6),
        requestId: uuid(r), ...(text ? { text } : {}), decision: r.chance(0.9) ? "open" : "unknown" });
    } else if (what === "retry") steps.push({ do: "retry", pick: r.int(0, 1000) });
    else if (what === "conflict") steps.push({ do: "conflict", pick: r.int(0, 1000), kind: weighted(r, kinds), text: `Conflict ${index}.` });
    else if (what === "pass") steps.push({ do: "pass", stopAt: r.chance(0.5) ? 1 : 0 });
    else steps.push({ do: "restart" });
  }
  return { start, delegated, ids, steps };
}

function describe(step: Step): string {
  switch (step.do) {
    case "request": return `${step.stale ? "stale " : ""}${step.kind} ${step.requestId.slice(0, 8)}${step.stopAt ? `, stop after write ${step.stopAt}` : ""}${step.again ? ", sent twice" : ""}${step.settle ? ", then a host pass" : ""}`;
    case "retry": return "retry of an acknowledged request";
    case "conflict": return `a reused request id sent as ${step.kind}`;
    case "pass": return `host pass${step.stopAt ? `, stop after write ${step.stopAt}` : ""}`;
    case "restart": return "clean restart";
  }
}

function setup(f: Fixture, s: Script): Model {
  const run = f.run, pm = run.members[0]!;
  const events = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<Kind, number>;
  const [decisionId, permissionId, answerRequestId, coordinatorMemberId] = s.ids as [string, string, string, string];
  f.journal.append("output", { text: "Earlier output." }); f.journal.append("output", { text: "Later output." });
  pm.cursor = f.journal.seq;
  if (s.start !== "working") pm.status = s.start === "waiting" ? "waiting" : "stopped";
  if (s.start === "paused") run.status = "paused";
  if (s.start === "stalled") { run.status = "blocked"; run.reason = memberStallReason; }
  if (s.start === "continuable") { run.status = "blocked"; run.blockCode = "repair-limit"; run.reason = "The team exhausted its correction rounds."; run.headCommit = run.baseCommit; }
  if (s.start === "waiting") {
    run.status = "needs-input";
    run.decisions = [{ id: decisionId, memberId: pm.memberId, revision: 1, question: "Which file first?", options: ["a", "b"], createdAt: run.createdAt }];
  }
  if (s.delegated) {
    const prompt: Prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
      title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
      options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No (esc)", role: "reject" }] };
    run.permissions = { mode: "coordinator", scope: "Approve one-time runs of accepted checks.", maxDecisions: 3 };
    run.permissionDecisions = [{ id: permissionId, revision: 1, targetMemberId: pm.memberId, targetSessionId: pm.sessionId, targetCwd: pm.cwd,
      policyHash: createHash("sha256").update(JSON.stringify(run.permissions)).digest("hex"), promptId: prompt.id, promptHash: prompt.hash!,
      evidenceHash: permissionEvidenceHash(prompt), prompt, option: 0, authorityHash: permissionAuthorityHash(run.permissions, []),
      expiresAt: "2099-01-01T00:00:00.000Z", answerRequestId, coordinatorMemberId, status: "approved" }];
  }
  f.writeTeam();
  return { status: run.status, revision: 1, halted: false, steering: [], answers: {}, revoked: false, continued: 0, events, acked: {},
    replannable: s.start === "stalled" };
}

export type Variant = { patch?: (service: TeamService) => void; stop?: "clean" | "torn" | "lost" };
type Outcome<T> = { value?: T; error?: unknown; writes: Saved[]; stopped: boolean };
type Life = { stopped: boolean; label: string };

function files(root: string, skip: ReadonlySet<string>, at = ""): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const name = join(at, entry.name);
    if (skip.has(name)) continue;
    if (entry.isDirectory()) for (const [inner, bytes] of files(root, skip, name)) found.set(inner, bytes);
    else if (entry.isFile()) found.set(name, readFileSync(join(root, name)));
  }
  return found;
}

class Host {
  service?: TeamService;
  private writes: Saved[] = [];
  private stopAt = 0;
  private label = "open";
  private life: Life = { stopped: false, label: "open" };
  private before?: Buffer;
  private unblock?: () => void;
  private atStop?: Map<string, Buffer>;
  private readonly file: string;
  private readonly skip: ReadonlySet<string>;

  constructor(private readonly f: Fixture, private readonly variant: Variant, private readonly counts: Counts) {
    this.file = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
    this.skip = new Set([join("teams", `${f.run.id}.sealed`), join("teams", `${f.run.id}.sealed.saved`)]);
  }

  bytes(): Buffer { return readFileSync(this.file); }
  read(): Saved { return unseal<Saved>(this.f.key, `team:${this.f.run.id}`, readFileSync(this.file, "utf8")); }

  private guard<T extends object>(life: Life, target: T, path = ""): T {
    return new Proxy(target, { get: (object, key) => {
      const value: unknown = Reflect.get(object, key), name = `${path}${String(key)}`;
      if (typeof value === "object" && value !== null) return this.guard(life, value, `${name}.`);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!life.stopped) return value.apply(object, args);
        bump(this.counts, `after-stop:${life.label}:${name}`);
        const error = new HostStopped(`The host stopped before ${name}.`);
        if (value.constructor.name === "AsyncFunction") return Promise.reject(error);
        throw error;
      };
    } });
  }

  open(): Saved[] {
    this.writes = [];
    const life: Life = { stopped: false, label: this.label };
    this.life = life;
    let previous = this.bytes();
    const entries = { retryable: () => false, held: () => false, unread: () => false, mirror: () => {
      this.writes.push(this.read());
      if (this.stopAt > 0 && this.writes.length === this.stopAt) {
        life.stopped = true; life.label = this.label; this.before = previous;
        this.atStop = files(this.f.config.stateDir, this.skip);
        this.unblock = this.f.blockRecordWrites("team", this.f.run.id);
      } else previous = this.bytes();
      return true;
    } };
    const given = this.guard(life, { now: () => T0, start: (_project: string, start: () => unknown) => start() });
    const service = new TeamService(this.f.config, this.f.key, this.guard(life, this.f.manager) as unknown as Manager, given.start as never,
      undefined, undefined, { entries: this.guard(life, entries) as unknown as Blackboard, now: given.now });
    this.variant.patch?.(service);
    this.service = service;
    return this.writes;
  }

  async call<T>(work: (service: TeamService) => Promise<T>, label: string, stopAt = 0): Promise<Outcome<T>> {
    const life = this.life;
    this.writes = []; this.stopAt = stopAt; this.label = label;
    let value: T | undefined, error: unknown;
    try { value = await work(this.service!); } catch (caught) { error = caught; }
    this.stopAt = 0;
    return { value, error, writes: this.writes, stopped: life.stopped };
  }

  private restoreFiles() {
    const root = this.f.config.stateDir, then = this.atStop!, now = files(root, this.skip);
    for (const [name, bytes] of then) if (!now.get(name)?.equals(bytes)) {
      bump(this.counts, `after-stop:file:${name.replace(UUID, "<id>")}`);
      mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), bytes);
    }
    for (const name of now.keys()) if (!then.has(name)) { bump(this.counts, `after-stop:file:${name.replace(UUID, "<id>")}`); rmSync(join(root, name)); }
  }

  async restart(): Promise<Saved[]> {
    const life = this.life;
    await this.service!.close().catch(error => { if (!(error instanceof HostStopped)) throw error; });
    if (life.stopped) {
      this.restoreFiles();
      this.unblock!(); this.unblock = undefined;
      if (this.variant.stop === "torn") writeFileSync(this.file, this.bytes().subarray(0, this.bytes().length >> 1));
      if (this.variant.stop === "lost") writeFileSync(this.file, this.before!);
    }
    return this.open();
  }

  close() { return this.service?.close(); }
}

type Internal = { step(stored: unknown): Promise<void>; record(id: string): unknown };

function send(service: TeamService, id: string, request: Request): Promise<TeamView> {
  const { requestId, revision, text } = request.body, action = { requestId, revision };
  switch (request.kind) {
    case "pause": return service.pause(id, action);
    case "resume": return service.resume(id, action);
    case "cancel": return service.cancel(id, action);
    case "revoke": return service.revokePermissions(id, action);
    case "steer": return service.steer(id, { ...action, text: text! });
    case "answer": return service.answer(id, request.decisionId!, { ...action, text: text! });
    case "continue": return service.continueRun(id, { ...action, ...(text ? { text } : {}) });
  }
}

const code = (error: unknown) => error instanceof TeamError ? error.code : error instanceof Error ? `${error.name}: ${error.message}` : String(error);

class Sim {
  private model!: Model;
  private where = "setup";
  private readonly durable = { revision: 0, cursors: new Map<string, number>(), receipts: new Set<string>(), settled: undefined as { status: TeamStatus; revision: number } | undefined };

  constructor(private readonly seed: number, private readonly f: Fixture, private readonly host: Host, private readonly counts: Counts, private readonly variant: Variant) {}

  private fail(invariant: string, message: string): never {
    throw new Violation(`seed ${this.seed} ${this.where}: ${invariant}: ${message}; rerun: ${RERUN(this.seed)}`);
  }

  async run(s: Script) {
    this.model = setup(this.f, s);
    this.durableCheck(this.host.read(), "the starting record");
    this.durableChecks(this.host.open(), "the first open");
    this.effect(this.host.read(), "I3");
    for (const [index, step] of s.steps.entries()) {
      this.where = `step ${index + 1} (${describe(step)})`;
      if (step.do === "request") await this.request(step);
      else if (step.do === "retry") await this.retryAcked(step.pick);
      else if (step.do === "conflict") await this.conflict(step);
      else if (step.do === "pass") await this.pass(step.stopAt);
      else await this.restart();
    }
  }

  private durableCheck(saved: Saved, what: string) {
    const run = saved.run, d = this.durable;
    if (run.revision < d.revision) this.fail("I4", `${what} is at revision ${run.revision}, behind the written revision ${d.revision}`);
    for (const member of run.members) {
      if (member.cursor < (d.cursors.get(member.memberId) ?? 0)) this.fail("I4", `${what} moved member ${member.memberId} back to cursor ${member.cursor}`);
      d.cursors.set(member.memberId, member.cursor);
    }
    for (const id of d.receipts) if (!saved.receipts[id]) this.fail("I4", `${what} lost the saved receipt of ${id}`);
    if (d.settled && (run.status !== d.settled.status || run.revision !== d.settled.revision))
      this.fail("I5", `${what} is ${run.status} at revision ${run.revision} after ${d.settled.status} was written at revision ${d.settled.revision}`);
    d.revision = run.revision;
    for (const id of Object.keys(saved.receipts)) d.receipts.add(id);
    if (SETTLED.has(run.status)) d.settled ??= { status: run.status, revision: run.revision };
  }

  private durableChecks(writes: readonly Saved[], what: string) {
    writes.forEach((saved, index) => this.durableCheck(saved, `${what}'s write ${index + 1}`));
  }

  private effect(saved: Saved, invariant: string, request?: Request) {
    const want = expected(this.model), got = project(saved);
    if (!isDeepStrictEqual(want, got)) this.fail(invariant, `${request ? `after the acknowledged ${request.kind}, ` : ""}${difference(want, got)}`);
  }

  private unexpected(saved: Saved, allowed: Allowed, what: string): never {
    const got = project(saved);
    this.fail("I3", `${what} is none of the states the model allows; ${allowed.map(([name, m]) => `against ${name}: ${difference(expected(m), got)}`).join("; ")}`);
  }

  private build(step: Extract<Step, { do: "request" }>): Request {
    const revision = step.stale ? (this.model.revision > 1 ? this.model.revision - 1 : this.model.revision + 1) : this.model.revision;
    const open = this.f.run.decisions[0]?.id;
    return { kind: step.kind, body: { requestId: step.requestId, revision, ...(step.text ? { text: step.text } : {}) },
      ...(step.kind === "answer" ? { decisionId: step.decision === "open" && open ? open : step.requestId } : {}) };
  }

  private async request(step: Extract<Step, { do: "request" }>) {
    const request = this.build(step), pre = this.model, before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind, step.stopAt);
    this.durableChecks(result.writes, `the ${request.kind}`);
    if (result.stopped) {
      if (request.body.revision !== pre.revision) this.fail("I7", `a ${request.kind} issued against revision ${request.body.revision} wrote the record at revision ${pre.revision} before the stop`);
      if (SETTLED.has(pre.status)) this.fail("I5", `a new ${request.kind} wrote the ${pre.status} record before the stop`);
      bump(this.counts, `cut:${request.kind}:${step.stopAt}`);
      const post = acknowledge(pre, request), name = `intermediate:${request.kind}:${step.stopAt}`, change = INTERMEDIATE[`${request.kind}:${step.stopAt}`];
      const allowed: Allowed = [["the state before it", pre], ["the state after it", post], ...(change ? [[name, { ...pre, ...change(pre) }] as const] : [])];
      const saved = await this.reopen(), held = match(saved, allowed);
      if (held === name) bump(this.counts, name);
      if (held === undefined) this.unexpected(saved, allowed, "the reopened record");
      const retry = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
      this.durableChecks(retry.writes, `the retried ${request.kind}`);
      if (retry.error !== undefined) this.fail("I1", `the host admitted the ${request.kind} before the stop, and refused its retry (${code(retry.error)})`);
      this.acknowledged(request, pre, retry.value!, true);
    } else if (result.error !== undefined) {
      this.refused(request, before, result);
      return;
    } else this.acknowledged(request, pre, result.value!, false);
    if (step.again) await this.retry(request);
    if (step.settle && this.model.halted) await this.pass(0);
  }

  private refused(request: Request, before: Buffer, result: Outcome<TeamView>) {
    if (!(result.error instanceof TeamError)) throw result.error;
    if (result.writes.length > 0 || !before.equals(this.host.bytes())) this.fail("I6", `the refused ${request.kind} (${result.error.code}) wrote the record`);
    bump(this.counts, `refused:${result.error.code}`);
  }

  private acknowledged(request: Request, pre: Model, view: TeamView, cut: boolean) {
    if (SETTLED.has(pre.status)) this.fail("I5", `a new ${request.kind} was acknowledged on a ${pre.status} run`);
    if (request.body.revision !== pre.revision) this.fail("I7", `a ${request.kind} issued against revision ${request.body.revision} was acknowledged at revision ${pre.revision}`);
    const saved = this.host.read(), post = acknowledge(pre, request, saved.receipts[request.body.requestId] ?? "");
    this.model = post;
    this.effect(saved, "I1", request);
    if (view.status !== saved.run.status || view.revision !== saved.run.revision)
      this.fail("I1", `the acknowledgement shows ${view.status} at revision ${view.revision}; the record holds ${saved.run.status} at ${saved.run.revision}`);
    bump(this.counts, `ack:${request.kind}`);
    if (cut) bump(this.counts, `ack:${request.kind}:after-stop`);
  }

  private async retry(request: Request) {
    const receipt = this.model.acked[request.body.requestId]!.receipt, before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
    if (result.error !== undefined) this.fail("I2", `a retry of the acknowledged ${request.kind} was refused (${code(result.error)})`);
    if (result.writes.length > 0 || !before.equals(this.host.bytes())) this.fail("I2", `a retry of the acknowledged ${request.kind} wrote the record`);
    if (this.host.read().receipts[request.body.requestId] !== receipt) this.fail("I2", `a retry of the acknowledged ${request.kind} changed its receipt`);
    this.effect(this.host.read(), "I2");
    bump(this.counts, `retry:${request.kind}`);
  }

  private async retryAcked(pick: number) {
    const acked = Object.values(this.model.acked);
    if (acked.length === 0) return bump(this.counts, "retry:none");
    await this.retry(acked[pick % acked.length]!.request);
  }

  private async conflict(step: Extract<Step, { do: "conflict" }>) {
    const acked = Object.values(this.model.acked);
    if (acked.length === 0) return bump(this.counts, "conflict:none");
    const prior = acked[step.pick % acked.length]!.request;
    const body = { requestId: prior.body.requestId, revision: this.model.revision, ...(step.kind === "steer" || step.kind === "answer" ? { text: step.text } : {}) };
    const request: Request = { kind: step.kind, body, ...(step.kind === "answer" ? { decisionId: this.f.run.decisions[0]?.id ?? prior.body.requestId } : {}) };
    if (request.kind === prior.kind && request.body.revision === prior.body.revision && request.kind !== "steer" && request.kind !== "answer") request.body.revision += 1;
    const before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
    if (result.error === undefined) this.fail("I7", `request id ${prior.body.requestId}, acknowledged as a ${prior.kind}, was acknowledged again as a different ${request.kind}`);
    if (code(result.error) !== "request-conflict") this.fail("I7", `request id ${prior.body.requestId} reused as a different ${request.kind} was refused as ${code(result.error)}, not as a request conflict`);
    this.refused(request, before, result);
  }

  private async pass(stopAt: number) {
    if (!this.model.halted) return bump(this.counts, "pass:idle");
    const pre = this.model, allowed: Allowed = [["the state before it", pre], ["the state with its halt ended", { ...pre, halted: false }]];
    const step = (service: TeamService) => {
      const internal = service as unknown as Internal;
      return internal.step(internal.record(this.f.run.id));
    };
    const result = await this.host.call(step, "pass", stopAt);
    this.durableChecks(result.writes, "the pass");
    if (result.stopped) {
      bump(this.counts, "cut:pass");
      const reopened = await this.reopen();
      if (match(reopened, allowed) === undefined) this.unexpected(reopened, allowed, "the reopened record");
      if (reopened.halt) {
        const again = await this.host.call(step, "pass");
        this.durableChecks(again.writes, "the pass after the stop");
        if (again.error !== undefined) throw again.error;
      }
    } else if (result.error !== undefined) throw result.error;
    const saved = this.host.read();
    if (match(saved, allowed) === undefined) this.unexpected(saved, allowed, "the record after the pass");
    this.model = { ...pre, halted: Boolean(saved.halt) };
    bump(this.counts, saved.halt ? "pass:still-halted" : "pass:ended-halt");
  }

  private async restart() {
    const saved = await this.reopen(), allowed: Allowed = [["the model", this.model]];
    if (match(saved, allowed) === undefined) this.unexpected(saved, allowed, "the record after a clean restart");
    bump(this.counts, "restart");
  }

  private async reopen(): Promise<Saved> {
    let writes: Saved[];
    try { writes = await this.host.restart(); } catch (error) { this.fail("I3", `the record does not load after the stop (${code(error)})`); }
    this.durableChecks(writes, "the reopened service");
    let saved: Saved;
    try { saved = this.host.read(); } catch (error) { this.fail("I3", `the record does not load after the stop (${code(error)})`); }
    this.durableCheck(saved, "the reopened record");
    return saved;
  }
}

export async function simulate(seed: number, counts: Counts, variant: Variant = {}): Promise<void> {
  const s = script(seed);
  bump(counts, `start:${s.start}${s.delegated ? ":delegated" : ""}`);
  let f: Fixture | undefined, host: Host | undefined;
  try {
    f = schedulerFixture(); host = new Host(f, variant, counts);
    await new Sim(seed, f, host, counts, variant).run(s);
  } finally {
    await host?.close()?.catch(() => undefined);
    f?.close();
  }
}
