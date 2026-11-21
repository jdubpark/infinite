import assert from "node:assert/strict";
import { canonicalJson } from "../../packages/host/src/evidence/crypto.js";
import { commandDigest } from "../../packages/host/src/objective-input.js";
import type { GoalRecordPort } from "../../packages/host/src/objective-intent.js";
import type { ObjectiveReceipt } from "../../packages/host/src/objective-receipts.js";
import { objectiveError } from "../../packages/host/src/objective-record.js";
import { recordDigest } from "../../packages/host/src/objective-types.js";
import type { Criterion, LogEntry, ObjectiveRecord } from "../../packages/host/src/objective-types.js";
import { evaluatorPrompt } from "../../packages/host/src/verdict-prompt.js";
import type { VerdictEventData } from "../../packages/host/src/verdict-store.js";
import type { AssessedState, VerdictReport } from "../../packages/host/src/verdict-types.js";
import { TeamVerdicts, VERDICT_EVENTS, VERDICT_TESTING_WAIT_MS } from "../../packages/host/src/team-verdicts.js";
import type { VerdictHolder, VerdictHost } from "../../packages/host/src/team-verdicts.js";
import type { TeamCommand, TeamLineup, TeamMember, TeamModelProfile, TeamReport, TeamRole, TeamRun } from "../../packages/host/src/team-types.js";
import type { Provider } from "../../packages/host/src/types.js";

export const RUN = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
export const PARENT = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e30";
export const GOAL = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
export const AT = "2026-11-21T00:00:00.000Z";
export const HEAD = "1".repeat(40);
export const BASE = "a".repeat(40);
export const SHORTLIST = "research/shortlist.json";
export const MARK = "marker-" + "z9".repeat(6);
export const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
export const DIGEST = commandDigest(RANK);

export const CLAUDE = { id: "opus-xhigh", label: "Opus", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } as TeamModelProfile;
export const SONNET = { id: "sonnet-high", label: "Sonnet", provider: "claude", model: "claude-sonnet-5-5", effort: "high", tier: "strong" } as TeamModelProfile;
export const ASTRA = { id: "astra-high", label: "Astra", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" } as TeamModelProfile;
export const DEEP = { id: "deep-high", label: "Deep", provider: "opencode", model: "deepseek/deepseek-v4", tier: "strong" } as TeamModelProfile;
export const LINEUP = { coordinator: CLAUDE, reviewer: SONNET, implementers: [SONNET], evaluators: [ASTRA, DEEP] } as unknown as TeamLineup;
export const SAME_FAMILY = { coordinator: CLAUDE, reviewer: SONNET, implementers: [SONNET], evaluators: [SONNET] } as unknown as TeamLineup;
export const ONE_ASTRA = { coordinator: CLAUDE, reviewer: SONNET, implementers: [SONNET], evaluators: [ASTRA] } as unknown as TeamLineup;

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function criteria(): Criterion[] {
  return [
    { id: "c0", origin: "owner", statement: "", statementOf: "objective", check: { kind: "judgement", item: "owner-text" },
      producer: "evaluator", threshold: { kind: "pass" }, state: "active" },
    { id: "c1", origin: "owner", statement: "Ranking verifies", check: { kind: "command", command: DIGEST },
      producer: "host", threshold: { kind: "pass" }, state: "active" },
    { id: "c2", origin: "owner", statement: "Rated by the owner", check: { kind: "owner-rating", subject: "top-10" },
      producer: "owner", threshold: { kind: "score", min: 4, of: 5 }, state: "active" },
  ];
}

export function recordOf(runId: string, entries = 1, extra: Criterion[] = []): ObjectiveRecord {
  const log: LogEntry[] = Array.from({ length: entries }, (_, index) => ({
    seq: index + 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: runId,
  }));
  const body: Omit<ObjectiveRecord, "digest"> = {
    schemaVersion: 1, owner: { kind: "run", runId }, version: 1,
    statement: { objective: "Rank founders", directions: [] }, definitions: [],
    constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
    criteria: [...criteria(), ...extra], assumptions: [], questions: [], rubricVersion: 1, log,
  };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

export function receiptOf(id: string, outcome: ObjectiveReceipt["outcome"], runId = RUN, commit = HEAD): ObjectiveReceipt {
  return {
    handle: `receipt:${runId}:1:${id}`, kind: "command", subject: "criterion", id, commit, outcome, at: AT,
    detail: { kind: "command", observed: outcome === "pass" ? "passed" : "failed", round: 1 },
  };
}

export function reportOf(states: Record<string, AssessedState>, note?: string, evidence: string[] = [`file:${SHORTLIST}`]): VerdictReport {
  return {
    kind: "verdict", result: "met",
    criteria: Object.entries(states).map(([id, state]) => ({ id, state, evidence, ...(note === undefined ? {} : { note }) })),
  };
}

export type FakeHolder = VerdictHolder & { outbox: VerdictEventData[] };
export type PassEntry = { head: string; pending: boolean; receipts?: ObjectiveReceipt[] };
/** What survives a restart outside the holders: the register's passes, the goal's record, and the uuid counter. */
export type World = { passes: Map<string, PassEntry>; uuids: number; store?: { record: ObjectiveRecord; failing: boolean }; marks: number };
export const newWorld = (): World => ({ passes: new Map(), uuids: 0, marks: 0 });

export function goalPort(world: World): GoalRecordPort {
  return {
    read: () => ({ kind: "ready" as const, record: world.store!.record }),
    write: (_goalId, expectedVersion, next) => {
      if (world.store!.failing) throw new Error("the goal record could not be saved");
      if (world.store!.record.version !== expectedVersion) throw objectiveError("objective-version-stale");
      world.store = { record: next, failing: world.store!.failing };
    },
  };
}

export let sequence = 0;
export function memberOf(run: TeamRun, role: TeamRole, extra: Partial<TeamMember> = {}): TeamMember {
  sequence += 1;
  return {
    runId: run.id, memberId: `${role}-${sequence}`, role, revision: run.revision, title: role, status: "queued", cwd: "/unused",
    baseCommit: BASE, prompt: "", sessionId: `session-${sequence}`, stopRequestId: "", cursor: 0, modelProfile: SONNET, ...extra,
  } as unknown as TeamMember;
}

export function runOf(overrides: Partial<TeamRun> = {}): TeamRun {
  const run = {
    id: RUN, projectId: "research", objective: "Rank founders", revision: 1, status: "reviewing", verdicts: "on", register: "on",
    lineup: LINEUP, decisions: [], members: [], tasks: [], checks: [], steering: [], events: [], createdAt: AT, updatedAt: AT,
    baseCommit: BASE, headCommit: HEAD, review: { verdict: "approved", summary: "ok", revision: 1 },
    changes: { headCommit: HEAD, recordedAt: AT, files: [{ path: SHORTLIST, status: "added", added: 1, removed: 0 }], truncated: false },
    ...overrides,
  } as unknown as TeamRun;
  const author = memberOf(run, "implementer", { status: "reported" });
  run.members.push(author);
  run.tasks.push({ id: "t1", revision: 1, status: "integrated", memberId: author.memberId } as never);
  if (run.checks.length === 0) {
    run.checks.push({ command: RANK, status: "passed", startedAt: AT, output: "", revision: 1, round: 1, headCommit: run.headCommit } as never);
  }
  return run;
}

export function holderOf(run: TeamRun, record?: ObjectiveRecord): FakeHolder {
  return { run, checkHead: run.headCommit, outbox: [], ...(record === undefined ? {} : { objectiveRecord: record }) };
}

export type Pending = { complete: (clean: boolean | undefined) => void; member: TeamMember };

export class FakeHost implements VerdictHost {
  readonly prepared: { member: TeamMember; prompt: string; profile: TeamModelProfile }[] = [];
  readonly consumed: string[] = [];
  readonly holds: boolean[] = [];
  readonly pending: Pending[] = [];
  readonly persisted = new Map<string, string>();
  readonly limitedSet = new Set<Provider>();
  readonly log: string[] = [];
  clock = AT;
  saves = 0;
  failNextSave = false;
  verdicts?: TeamVerdicts;

  constructor(readonly world: World, readonly holders: Map<string, FakeHolder>) {}

  holder(runId: string): VerdictHolder | undefined { return this.holders.get(runId); }
  prepare(holder: VerdictHolder, onPrepared: (member: TeamMember) => void, prebuilt: { prompt: string; profile: TeamModelProfile }): void {
    const member = memberOf(holder.run, "evaluator", { modelProfile: prebuilt.profile });
    holder.run.members.push(member);
    this.prepared.push({ member, ...prebuilt });
    onPrepared(member);
  }
  consume(holder: VerdictHolder, member: TeamMember): void {
    this.consumed.push(member.memberId);
    if (member.role === "evaluator") this.verdicts!.consume(holder, member);
    else this.holds.push(this.verdicts!.holdNoChange(holder, member));
  }
  operation(_holder: VerdictHolder, _perform: unknown, complete: (clean: boolean | undefined) => void, member: TeamMember): void {
    this.pending.push({ complete, member });
  }
  save(holder: VerdictHolder): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("the host stopped before it saved");
    }
    this.saves += 1;
    this.persisted.set(holder.run.id, JSON.stringify(holder));
  }
  event(holder: VerdictHolder, text: string): void {
    this.log.push(`event:${text}`);
    holder.run.events.push({ at: AT, text });
  }
  emit(holder: VerdictHolder, data: VerdictEventData): void { (holder as FakeHolder).outbox.push(data); }
  configured(): readonly TeamCommand[] { return [RANK]; }
  limited(): Set<Provider> { return this.limitedSet; }
  prefix(): TeamCommand | undefined { return undefined; }
  now(): string { return this.clock; }
  uuid(): string { this.world.uuids += 1; return uuidOf(this.world.uuids); }
  readonly register = {
    markReviewed: (holder: VerdictHolder): boolean => {
      const head = holder.run.headCommit!;
      const current = this.world.passes.get(holder.run.id);
      this.world.marks += 1;
      this.log.push("mark");
      if (current?.head !== head) this.world.passes.set(holder.run.id, { head, pending: true });
      return true;
    },
    reviewedReceipts: (runId: string, head: string): readonly ObjectiveReceipt[] | "pending" | undefined => {
      const pass = this.world.passes.get(runId);
      if (pass === undefined || pass.head !== head) return undefined;
      return pass.pending ? "pending" : (pass.receipts ?? []);
    },
  };
}

export function finishPass(world: World, runId: string, receipts: ObjectiveReceipt[]): void {
  const pass = world.passes.get(runId);
  assert.ok(pass, "a pass was marked");
  world.passes.set(runId, { head: pass.head, pending: false, receipts });
}

export type Fixture = { world: World; host: FakeHost; verdicts: TeamVerdicts; holder: FakeHolder };

export function fixture(options: { run?: Partial<TeamRun>; record?: ObjectiveRecord; goal?: boolean } = {}): Fixture {
  const world = newWorld();
  const goal = options.goal === true;
  const run = runOf({ ...(goal ? { goal: { id: GOAL, revision: 1, cycle: 2, parentRunId: PARENT } as never } : {}), ...options.run });
  const record = options.record ?? recordOf(run.id);
  const holder = holderOf(run, goal ? undefined : record);
  holder.checkHead = run.headCommit;
  if (goal) world.store = { record, failing: false };
  const holders = new Map<string, FakeHolder>([[run.id, holder]]);
  const host = new FakeHost(world, holders);
  const verdicts = new TeamVerdicts(host);
  host.verdicts = verdicts;
  if (goal) verdicts.goals = goalPort(world);
  return { world, host, verdicts, holder };
}

/** A goal cycle that reported no change: no task, and the head equal to the base. */
export function noChangeFixture(run: Partial<TeamRun> = {}): Fixture {
  const f = fixture({ goal: true, run: { status: "planning", review: undefined, headCommit: BASE, ...run } });
  f.holder.run.tasks.length = 0;
  return f;
}

/** The holder's record, wherever it lives. */
export function recordIn(f: Fixture): ObjectiveRecord {
  return f.world.store ? f.world.store.record : f.holder.objectiveRecord as ObjectiveRecord;
}

/** The evaluator reports as the host stores it: screened, saved, consumed. */
export function reportEvaluator(f: Fixture, member: TeamMember, report: TeamReport): void {
  member.report = report;
  member.status = "reported";
  member.report = f.verdicts.screen(f.holder, member, report);
  f.host.save(f.holder);
  f.verdicts.consume(f.holder, member);
}

/** No argument means a clean check; an explicit `undefined` is a check that ended without a result. */
export function settle(host: FakeHost, ...clean: [boolean | undefined] | []): void {
  const value = clean.length === 0 ? true : clean[0];
  for (const op of host.pending.splice(0)) op.complete(value);
}

/** Steps until the state reaches `status` or five calls pass. */
export function drive(f: Fixture, status: string): void {
  for (let index = 0; index < 5 && f.holder.verdict?.status !== status; index += 1) f.verdicts.step(f.holder);
}

export const countOf = (texts: string[], text: string): number => texts.filter(item => item === text).length;
export const eventTexts = (holder: VerdictHolder): string[] => holder.run.events.map(item => item.text);

/** A reviewed run through the register's pass and the evaluator's launch. */
export function evaluating(options: Parameters<typeof fixture>[0] = {}): Fixture & { member: TeamMember } {
  const f = fixture(options);
  assert.equal(f.verdicts.reviewed(f.holder), true, "the verdict holds");
  finishPass(f.world, f.holder.run.id, [receiptOf("c1", "pass", f.holder.run.id)]);
  drive(f, "evaluating");
  assert.equal(f.holder.verdict?.status, "evaluating", "the evaluator launched");
  const member = f.host.prepared.at(-1)!.member;
  assert.equal(f.verdicts.context(f.holder, member)?.kind, "verdict-context", "the evaluator read its context");
  return { ...f, member };
}
