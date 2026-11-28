import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import { GoalService } from "../packages/host/src/goals.js";
import { provisionalStop } from "../packages/host/src/goal-verdicts.js";
import type { CreateGoal } from "../packages/host/src/goal-types.js";
import { appendRunEvent } from "../packages/host/src/run-events.js";
import { composeVerdict, verdictRecord } from "../packages/host/src/verdict-compose.js";
import { deliveryPort } from "../packages/host/src/verdict-delivery.js";
import { applyScan } from "../packages/host/src/outcome-signals.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { isFuseReason } from "../packages/host/src/fuse/rules.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { definitionDigest } from "../packages/host/src/objective-receipts.js";
import { VERDICT_OPS } from "../packages/host/src/objective-record.js";
import { recordDigest, type Criterion, type ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { sealRecord } from "../packages/host/src/objective-write.js";
import type { TeamCommand, TeamLineup, TeamMember, TeamModelProfile, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { VERDICT_EVENTS } from "../packages/host/src/team-verdicts.js";
import { registerVerdicts } from "../packages/host/src/verdict-store.js";
import type { Config, Project } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import {
  GOAL as RUNTIME_GOAL,
  evaluating as evaluatingVerdict,
  recordOf as runtimeRecordOf,
  reportEvaluator as reportRuntimeEvaluator,
  reportOf as runtimeReportOf,
  settle as settleRuntimeVerdict,
} from "./fixtures/verdict-runtime.js";
import { fixture } from "./team-fixture.js";

type SchedulerFixture = ReturnType<typeof schedulerFixture>;
type Stored = { run: TeamRun; verdict?: { status: string; failures: number; excluded?: string[]; commit?: unknown }; objectiveRecord?: unknown; outbox?: OutboxEvent[] };

const AT = new Date().toISOString();
const SHORTLIST = "research/shortlist.json";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
const MARK = ["seal", "q7q7q7q7q7q7q7q7"].join("-");

const COORDINATOR: TeamModelProfile = { id: "opus-coordinator", label: "Opus coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
const INTEGRATOR: TeamModelProfile = { id: "opus-integrator", label: "Opus integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const IMPLEMENTER: TeamModelProfile = { id: "spark-high", label: "Deep implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium", tier: "light" };
const REVIEWER: TeamModelProfile = { id: "astra-reviewer", label: "Astra reviewer", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" };
const AUTHOR_MODEL: TeamModelProfile = { id: "deep-evaluator", label: "Deep evaluator", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium", tier: "strong" };
const OTHER_FAMILY: TeamModelProfile = { id: "gemini-evaluator", label: "Gemini evaluator", provider: "opencode", model: "google/gemini-3-pro", variant: "high", tier: "strong" };
const SECOND_IMPLEMENTER: TeamModelProfile = { ...IMPLEMENTER, id: "astra-xhigh", label: "Second deep implementer" };
const LINEUP: TeamLineup = { coordinator: COORDINATOR, implementers: [IMPLEMENTER, SECOND_IMPLEMENTER], integrator: INTEGRATOR, reviewer: REVIEWER, evaluators: [AUTHOR_MODEL, REVIEWER] };
const WIDE_LINEUP: TeamLineup = { ...LINEUP, evaluators: [AUTHOR_MODEL, REVIEWER, OTHER_FAMILY] };

const storedOf = (teams: TeamService, id: string) => (teams as unknown as { record(id: string): Stored }).record(id);
const scheduler = (teams: TeamService) => teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
const evaluators = (view: TeamView) => view.members.filter(member => member.role === "evaluator");
const TERMINAL = ["ready-for-review", "merged", "blocked", "cancelled"];

function watched(store: EvidenceStore) {
  const outbox = new EventOutbox(store);
  registerVerdicts(store, outbox);
  const flushed: OutboxEvent[] = [];
  const flush = outbox.flush.bind(outbox);
  outbox.flush = events => { flushed.push(...events); return flush(events); };
  const rows = (teams: TeamService, runId: string, kind = "verdict.recorded") => {
    const held = storedOf(teams, runId).outbox ?? [];
    const seen = new Map<string, OutboxEvent>();
    for (const event of [...flushed, ...held]) if (event.kind === kind) seen.set(event.key, event);
    return [...seen.values()];
  };
  return { outbox, rows, all: () => flushed };
}

async function realRun(verdicts: boolean, lineup: TeamLineup = LINEUP) {
  const f = await fixture("intent", lineup, {}, { noServer: true });
  const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
  if (verdicts) project.team = { ...project.team!, objective: { evaluator: "on", register: "on" } } as Project["team"];
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) });
  const entries = new Blackboard(store);
  const watch = watched(store);
  const teams = await f.openTeamService({ entries, events: watch.outbox });
  return { f, store, entries, watch, teams };
}

const settle = (teams: TeamService, id: string) => waitFor(() => Promise.resolve(teams.get(id)), view => TERMINAL.includes(view.status), 540000);

test("acceptance 11 end to end", { timeout: 600000 }, async () => {
  const { f, store, watch, teams } = await realRun(true);
  try {
    const created = await teams.create(f.create());
    assert.equal(created.verdicts, "on");
    const view = await settle(teams, created.id);
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));

    const members = evaluators(view);
    assert.equal(members.length, 1, "one evaluator");
    assert.equal(members[0]!.modelProfile?.id, REVIEWER.id);
    assert.equal(view.members.some(member => member.role === "implementer" && member.modelProfile?.id === IMPLEMENTER.id), true, "the implementer's work integrated");
    assert.equal(view.assessment?.kind, "reviewed");
    assert.equal(view.assessment?.result, "met");
    assert.equal(view.events.some(event => event.text === VERDICT_EVENTS.held), true);

    const rows = watch.rows(teams, created.id);
    assert.equal(rows.length, 1, "one row event");
    assert.equal(rows[0]!.data.alsoReviewed, true);
    assert.equal(rows[0]!.data.sharedFamily, false);
    assert.equal(rows[0]!.data.profileId, REVIEWER.id);
    assert.equal(storedOf(teams, created.id).run.verdicts, "on");
  } finally { store.close(); await f.close(); }
});

test("without verdicts a run is as today", { timeout: 600000 }, async () => {
  const { f, store, watch, teams } = await realRun(false);
  try {
    const created = await teams.create(f.create());
    assert.equal(created.verdicts, undefined);
    const view = await settle(teams, created.id);
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(evaluators(view).length, 0, "no evaluator");
    assert.equal(storedOf(teams, created.id).verdict, undefined, "no Stored.verdict");
    const text = JSON.stringify(teams.get(created.id));
    assert.equal("assessment" in (teams.get(created.id) as object), false);
    assert.equal("verdicts" in (teams.get(created.id) as object), false);
    assert.equal(text.includes("Agent assessment"), false);
    assert.equal(view.events.some(event => event.text === VERDICT_EVENTS.held), false);
    assert.equal(watch.rows(teams, created.id).length, 0, "no verdict event");
  } finally { store.close(); await f.close(); }

  const s = schedulerFixture();
  try {
    activeSessions(s);
    const member = s.run.members[0]!;
    member.role = "implementer";
    s.writeTeam();
    s.report(member.sessionId, { requestId: randomUUID(), runId: s.run.id, memberId: member.memberId, revision: member.revision,
      report: { kind: "verdict", result: "met", criteria: [{ id: "c0", state: "met", evidence: [] }] } });
    const teams = s.openTeam();
    await scheduler(teams).step(scheduler(teams).record(s.run.id));
    await teams.idle();
    const after = storedOf(teams, s.run.id);
    assert.equal(after.run.blockCode, "wrong-agent-report");
    assert.equal(after.run.recovery?.source.reportKind, "verdict");
    assert.match(after.run.reason ?? "", /does not match its assigned role/);
    assert.equal(after.run.assessment, undefined, "no assessment");
    assert.equal(after.verdict, undefined, "no stored verdict state");
  } finally { s.close(); }
});

test("evaluator text stays sealed", { timeout: 900000 }, async () => {
  const { f, store, entries, watch, teams } = await realRun(true);
  try {
    writeFileSync(join(f.receipts, "verdict.json"), JSON.stringify({ kind: "verdict", result: "met",
      criteria: [{ id: "c0", state: "met", evidence: [`file:${MARK}.txt`, "file:a.txt"], note: `Looks right ${MARK}` }] }), { mode: 0o600 });
    writeFileSync(join(f.receipts, "record-context"), "");
    const created = await teams.create(f.create());
    const view = await settle(teams, created.id);
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    const evaluator = evaluators(view);
    assert.equal(evaluator.length, 1);
    assert.equal(evaluator[0]!.report?.kind, "verdict");
    assert.equal(view.assessment?.kind, "reviewed");

    assert.equal(JSON.stringify(storedOf(teams, created.id).verdict).includes(MARK), true, "the evaluator's text reached the sealed state");
    const report = evaluator[0]!.report as { kind: string; criteria: { id: string; evidence: unknown[] }[] };
    assert.equal(report.kind, "verdict");
    assert.ok(report.criteria.length >= 1);
    for (const item of report.criteria) assert.equal(item.evidence.length, 0, "empty evidence");

    await teams.steer(created.id, { requestId: randomUUID(), revision: view.revision, text: "Add one more line" });
    const later = await waitFor(() => Promise.resolve(teams.get(created.id)),
      next => next.members.some(member => member.role === "project-manager" && member.revision > view.revision), 120000);
    const planner = later.members.find(member => member.role === "project-manager" && member.revision > view.revision)!;
    await waitFor(() => Promise.resolve(existsSync(join(f.receipts, `${planner.memberId}.context.json`)) && existsSync(join(f.receipts, `${planner.memberId}.json`))),
      ready => ready, 60000);

    const places: Record<string, string> = {
      "the team view": JSON.stringify(teams.get(created.id)),
      "the run's events": JSON.stringify(storedOf(teams, created.id).run.events),
      "the outbox": JSON.stringify([...watch.all(), ...(storedOf(teams, created.id).outbox ?? [])]),
      "the blackboard": JSON.stringify(entries.list(created.id, {} as never)),
      "the record": JSON.stringify(storedOf(teams, created.id).objectiveRecord),
    };
    for (const name of readdirSync(f.receipts)) {
      if (name !== "verdict.json") places[`the file ${name.replace(/[0-9a-f-]{36}/g, "<id>")}`] = readFileSync(join(f.receipts, name), "utf8");
    }
    for (const [place, text] of Object.entries(places)) assert.equal(text.includes(MARK), false, `the marker reached ${place}`);
    assert.ok(Object.keys(places).some(name => name.startsWith("the file ")), "member files were searched");
    assert.equal(existsSync(join(f.receipts, `${planner.memberId}.context.json`)), true);
  } finally { store.close(); await f.close(); }
});

function activeSessions(f: SchedulerFixture) {
  const state = f.manager.state;
  f.manager.state = async (requestedId?: string) => ({ ...(await state(requestedId)), attention: initialAttention(new Date().toISOString(), true) });
}

function git(f: SchedulerFixture, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: f.run.workspace, encoding: "utf8", stdio: "pipe" }).trim();
}

function recordFor(runId: string, delivery = false): ObjectiveRecord {
  const judged = (id: string, statement: string): Criterion => ({ id, origin: "owner", statement, check: { kind: "judgement", item: `item-${id}` },
    producer: "evaluator", threshold: { kind: "pass" }, state: "active" }) as Criterion;
  const body: Omit<ObjectiveRecord, "digest"> = {
    schemaVersion: 1, owner: { kind: "run", runId }, version: 1,
    statement: { objective: "Rank founders", directions: [] }, definitions: [],
    constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
    criteria: [
      { id: "c0", origin: "owner", statement: "", statementOf: "objective", check: { kind: "judgement", item: "owner-text" }, producer: "evaluator", threshold: { kind: "pass" }, state: "active" } as Criterion,
      judged("c1", "Every entry has reasons"), judged("c2", "Every entry has sources"), judged("c3", "The list is ranked"),
      { id: "c4", origin: "owner", statement: "The ranking verifies", check: { kind: "command", command: commandDigest(RANK) }, producer: "host", threshold: { kind: "pass" }, state: "active" } as Criterion,
      ...(delivery ? [{ id: "c5", origin: "owner", statement: "The run is merged", check: { kind: "receipt", receipt: "merged" }, producer: "host", threshold: { kind: "pass" }, state: "active" } as Criterion] : []),
    ],
    assumptions: [], questions: [], rubricVersion: 1,
    log: [{ seq: 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: runId }],
  };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

function seedReviewed(f: SchedulerFixture, options: { rank: "passed" | "failed"; lineup?: TeamLineup; outbox?: boolean; members?: number; manager?: TeamModelProfile; delivery?: boolean }): string {
  f.config.agents = { demo: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] },
    codex: { command: process.execPath, args: [] }, opencode: { command: process.execPath, args: [] } } as Config["agents"];
  f.config.teams = { ...f.config.teams!, lineup: options.lineup ?? LINEUP };
  f.config.projects[0]!.team = { checks: [RANK], objective: { evaluator: "on", register: "on" } } as Project["team"];
  mkdirSync(join(f.run.workspace, "research"), { recursive: true });
  writeFileSync(join(f.run.workspace, SHORTLIST), JSON.stringify({ entries: [] }));
  git(f, "add", "--", SHORTLIST);
  git(f, "commit", "-m", "Shortlist");
  const head = git(f, "rev-parse", "HEAD");
  const author: TeamMember = { ...f.run.members[0]!, role: "implementer", status: "stopped", taskId: "t1", modelProfile: IMPLEMENTER, provider: "opencode",
    report: { kind: "result", summary: "Wrote the shortlist" } as TeamMember["report"] };
  f.run.members = [author];
  if (options.manager) f.run.members.push({ ...author, memberId: randomUUID(), sessionId: randomUUID(), role: "project-manager", taskId: undefined, report: undefined, modelProfile: options.manager });
  for (let extra = 1; extra < (options.members ?? 1); extra += 1) f.run.members.push({ ...author, memberId: randomUUID(), sessionId: randomUUID(), taskId: undefined, report: undefined });
  f.run.tasks = [{ id: "t1", title: "Write the shortlist", instructions: "Write it", paths: [SHORTLIST], dependsOn: [], revision: 1, status: "integrated", memberId: author.memberId,
    commit: head, changedPaths: { paths: [SHORTLIST], truncated: false } } as TeamRun["tasks"][number]];
  Object.assign(f.run, { status: "reviewing", revision: 1, parallelismCeiling: 4, headCommit: head, lineup: options.lineup ?? LINEUP, verdicts: "on", register: "on",
    review: { verdict: "approved", summary: "Approved.", revision: 1 },
    changes: { headCommit: head, recordedAt: AT, files: [{ path: SHORTLIST, status: "added", added: 1, removed: 0 }], truncated: false },
    checks: [{ command: RANK, status: options.rank, startedAt: AT, output: "", revision: 1, headCommit: head, round: 1 }] });
  f.writeTeam({ objectiveRecord: recordFor(f.run.id, options.delivery), checkHead: head });
  return head;
}

const memberOf = (teams: TeamService, id: string, role: string, nth = 0) => storedOf(teams, id).run.members.filter(member => member.role === role)[nth];
const launchedEvaluator = (f: SchedulerFixture, teams: TeamService, id: string, nth = 0) =>
  waitFor(() => Promise.resolve(memberOf(teams, id, "evaluator", nth)), member => member !== undefined && f.launches.some(launch => launch.requestId === member.sessionId), 30000);

function answerAllMet(f: SchedulerFixture, member: TeamMember) {
  const context = JSON.parse(readFileSync(join(member.cwd, ".git", "infinite-team-context.json"), "utf8")) as { record: { criteria: { id: string }[] }; changedPaths: { paths: string[] } };
  assert.ok(context.record.criteria.length >= 5, "the context holds the record's criteria");
  f.report(member.sessionId, { requestId: randomUUID(), runId: member.runId, memberId: member.memberId, revision: member.revision,
    report: { kind: "verdict", result: "met", criteria: context.record.criteria.map(item => ({ id: item.id, state: "met", evidence: [`file:${context.changedPaths.paths[0]}`] })) } });
}

test("acceptance 6 end to end", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const watch = watched(store);
  store.register(outcomeModule({ now: () => new Date().toISOString() }));
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "failed", delivery: true });
    const teams = f.openTeam({ events: watch.outbox, delivery: deliveryPort(store) });
    teams.start();
    const evaluator = await launchedEvaluator(f, teams, f.run.id);
    answerAllMet(f, evaluator!);
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);

    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.assessment?.result, "not-met");
    assert.equal(view.assessment?.evaluatorResult, "met");
    assert.equal(view.assessment?.criteria.find(item => item.id === "c4")?.state, "not-met");
    const log = (storedOf(teams, f.run.id).objectiveRecord as ObjectiveRecord).log;
    const contradicted = log.filter(entry => entry.op === VERDICT_OPS.contradicted);
    assert.equal(contradicted.length, 1);
    assert.equal(contradicted[0]!.target, "c4");
    assert.equal(log.filter(entry => entry.op === VERDICT_OPS.recorded).length, 1);
    assert.equal(watch.rows(teams, f.run.id).length, 1, "one row event");
    const ledger = store.read(db => db.all<{ result: string; evaluator_result: string | null; run_id: string }>("SELECT result, evaluator_result, run_id FROM objective_verdicts"));
    assert.equal(ledger.length, 1, "one ledger row");
    assert.equal(ledger[0]!.run_id, f.run.id);
    assert.equal(ledger[0]!.result, "not-met");
    assert.equal(ledger[0]!.evaluator_result, "met");
    const named = store.read(db => db.all<{ profile_id: string | null }>("SELECT profile_id FROM objective_verdicts"));
    assert.equal(named[0]!.profile_id, evaluator!.modelProfile?.id, "an applied answer names the evaluator");
    assert.equal(teams.verdicts.detail(f.run.id)?.evaluator?.profileId, evaluator!.modelProfile?.id);

    const first = view.assessment!.verdictId;
    assert.deepEqual(await teams.settleReceipts(), [], "no landing is seen yet");
    store.write(tx => applyScan(tx, { projectId: f.run.projectId, repository: "example-repo", baseBranch: "main", head: "5".repeat(40), at: new Date().toISOString(),
      commits: 1, gap: null, expectedSeq: 0, holdDays: 30, reverts: [],
      landings: [{ runId: f.run.id, commit: "6".repeat(40), method: "merge-commit", position: 0, reviewedHead: storedOf(teams, f.run.id).run.headCommit }] }));
    assert.deepEqual(await teams.settleReceipts(), [f.run.id]);
    assert.deepEqual(await teams.settleReceipts(), [], "a repeat pass writes nothing");
    const late = teams.assessmentOf(f.run.id)!;
    assert.notEqual(late.assessment?.verdictId, first);
    assert.equal(late.assessment?.criteria.find(item => item.id === "c5")?.state, "met");
    assert.equal(teams.get(f.run.id)!.status, "ready-for-review");
    assert.equal(evaluators(teams.get(f.run.id)!).length, 1, "no new evaluator");
    const rows = store.read(db => db.all<{ verdict_id: string }>("SELECT verdict_id FROM objective_verdicts WHERE run_id = ?", f.run.id));
    assert.deepEqual(rows.map(row => row.verdict_id).sort(), [first, late.assessment!.verdictId].sort(), "two ledger rows");
    teams.close();
  } finally { store.close(); f.close(); }
});

test("a project manager that ran on a fallback family is never the evaluator's family", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed", manager: { ...REVIEWER, id: "astra-manager", label: "Fallback manager" } });
    const teams = f.openTeam();
    teams.start();
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => current.assessment !== undefined || evaluators(current).length > 0, 60000);
    teams.close();
    assert.deepEqual(evaluators(view).map(member => member.modelProfile?.id), [], "no evaluator of the manager's family is launched");
    assert.equal(view.assessment?.result, "inconclusive");
    assert.equal(view.assessment?.reason, "no-independent-evaluator");
  } finally { f.close(); }
});

test("a report whose answers were all dropped names no evaluator", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const watch = watched(store);
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed" });
    const teams = f.openTeam({ events: watch.outbox });
    teams.start();
    const evaluator = await launchedEvaluator(f, teams, f.run.id);
    f.report(evaluator!.sessionId, { requestId: randomUUID(), runId: evaluator!.runId, memberId: evaluator!.memberId, revision: evaluator!.revision,
      report: { kind: "verdict", result: "met", criteria: [{ id: "c-unknown", state: "met", evidence: [`file:${SHORTLIST}`] }] } });
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.assessment?.evaluatorResult !== undefined, true, "the report was kept");
    assert.equal(teams.verdicts.detail(f.run.id)?.criteria.some(item => item.evaluatorState !== undefined), false, "no answer was applied");
    assert.equal(teams.verdicts.detail(f.run.id)?.evaluator, undefined, "the detail names no evaluator");
    const ledger = store.read(db => db.all<{ profile_id: string | null; family: string | null }>("SELECT profile_id, family FROM objective_verdicts"));
    assert.equal(ledger.length, 1, "one ledger row");
    assert.equal(ledger[0]!.profile_id, null);
    assert.equal(ledger[0]!.family, null);
  } finally { store.close(); f.close(); }
});

test("a run at its attempt limit settles without an evaluator", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed", members: 60 });
    const teams = f.openTeam();
    teams.start();
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.members.length, 60, "no member was added");
    assert.equal(view.assessment?.result, "inconclusive");
    assert.equal(view.assessment?.reason, "evaluator-unavailable");
  } finally { f.close(); }
});

test("an evaluator whose working copy cannot be prepared settles the run without it", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed" });
    const config = join(f.run.workspace, ".git", "config");
    const kept = readFileSync(config, "utf8");
    writeFileSync(config, `${kept}\n[broken\n`);
    const teams = f.openTeam();
    teams.start();
    const cause = (view: { events: { text: string }[] }) => view.events.filter(event => /working copy could not be prepared \([a-z-]+\)/.test(event.text));
    await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => cause(current).length > 0 || TERMINAL.includes(current.status), 60000);
    writeFileSync(config, kept);
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.assessment?.result, "inconclusive");
    assert.equal(view.assessment?.reason, "evaluator-unavailable");
    assert.equal(evaluators(view).length, 0, "no evaluator was added");
    assert.equal(storedOf(teams, f.run.id).pending, undefined, "no failed operation stays on the run");
    assert.equal(cause(view).length, 1, "the run's events name the cause once");
  } finally { f.close(); }
});

test("a members directory the host refuses still blocks the run at the evaluator", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  const members = join(f.run.workspace, "..", "members");
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed" });
    rmSync(members, { recursive: true, force: true });
    symlinkSync(join(f.run.workspace, ".."), members);
    const teams = f.openTeam();
    teams.start();
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.status, "blocked", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.blockCode, "team-root-unsafe");
    assert.equal(view.assessment, undefined, "no assessment is written for a blocked run");
  } finally { f.close(); }
});

test("a stalled evaluator is replaced once", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    seedReviewed(f, { rank: "passed", lineup: WIDE_LINEUP });
    const teams = f.openTeam();
    teams.start();
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => current.assessment !== undefined, 90000);
    await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();

    assert.equal(evaluators(view).length, 2, "the first evaluator and one replacement");
    assert.equal(view.assessment?.result, "inconclusive");
    assert.equal(view.assessment?.reason, "evaluator-unavailable");
    const first = evaluators(view)[0]!, second = evaluators(view)[1]!;
    assert.equal(Boolean(first.stalledAt), true, "the first evaluator stalled");
    assert.equal(first.stoppedReason?.startsWith("No activity for "), true, `its stop reason is the stall: ${first.stoppedReason}`);
    assert.notEqual(first.modelProfile?.id, second.modelProfile?.id, "the replacement is a fresh choice");
    assert.equal(view.events.filter(event => event.text === VERDICT_EVENTS.replaced).length, 1);
    assert.equal(teams.get(f.run.id).status, "ready-for-review");
  } finally { f.close(); }
});

test("an open fuse holds the verdict", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const fuse = new FuseService({ config: f.config, key: f.key, store, sessionExists: () => false, now: () => Date.now() });
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed" });
    for (let index = 0; index < 30; index++) fuse.admit({ launchId: `other-${index}`, projectId: "fixture", purpose: "work", role: "implementer", profileId: "spark-high" });
    assert.equal(fuse.check({ projectId: "fixture" }).state, "open");
    const teams = f.openTeam();
    teams.useFuse(fuse);
    teams.start();

    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(f.launches.length, 0, "no evaluator launched");
    const held = teams.get(f.run.id);
    assert.equal(TERMINAL.includes(held.status), false, `the run stays held: ${held.status}`);
    assert.equal(held.assessment, undefined);
    assert.equal(isFuseReason(held.reason), true, `the fuse caused the hold: ${held.reason}`);
    assert.equal(evaluators(held).every(member => member.status === "queued"), true, "an evaluator that exists was never launched");

    assert.equal(fuse.close({ scope: "project", projectId: "fixture" }), "closed");
    const evaluator = await launchedEvaluator(f, teams, f.run.id);
    answerAllMet(f, evaluator!);
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.assessment?.kind, "reviewed");
  } finally { store.close(); f.close(); }
});

test("a crash between the record's write and the save writes nothing twice", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    seedReviewed(f, { rank: "passed" });
    f.config.projects[0]!.team = { checks: [RANK], objective: { prompts: "on", evaluator: "on", register: "on" } } as Project["team"];
    const first = f.openTeam(), goals = new GoalService(f.config, f.key, first);
    const goal = await goals.create({ requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
      successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2 } as CreateGoal);
    goals.start();
    await goals.idle();
    const teamId = goals.get(goal.id).activeTeamId!;
    assert.ok(teamId, "the first cycle's run exists");
    goals.close();
    first.close();
    await first.idle();

    const teamFile = join(f.config.stateDir, "teams", `${teamId}.sealed`), goalFile = join(f.config.stateDir, "goals", `${goal.id}.sealed`);
    const team = unseal<Stored & Record<string, unknown>>(f.key, `team:${teamId}`, readFileSync(teamFile, "utf8"));
    const head = git(f, "rev-parse", "HEAD");
    const author = { ...f.run.members[0]!, runId: teamId, memberId: randomUUID(), role: "implementer", status: "stopped", modelProfile: IMPLEMENTER,
      report: { kind: "result", summary: "Wrote it" } } as unknown as TeamMember;
    const evaluator = { ...author, memberId: randomUUID(), sessionId: randomUUID(), role: "evaluator", modelProfile: REVIEWER, status: "reported", report: { kind: "verdict", result: "met", criteria: [{ id: "c0", state: "met", evidence: [] }] } } as unknown as TeamMember;
    const run = team.run;
    Object.assign(run, { status: "reviewing", revision: 1, headCommit: head, baseCommit: run.baseCommit, lineup: LINEUP, verdicts: "on", register: "on", parallelismCeiling: 4,
      review: { verdict: "approved", summary: "Approved.", revision: 1 }, members: [author, evaluator], checks: [], tasks: [] });
    const verdictId = randomUUID();
    team.verdict = { revision: 1, head, kind: "reviewed", verdictId, status: "evaluating", failures: 0, receiptsFrom: teamId, evaluatorMemberId: evaluator.memberId,
      report: evaluator.report } as Stored["verdict"];
    Object.assign(team, { prepared: true, checkHead: head, pending: { id: randomUUID(), kind: "result", revision: 1,
      source: { memberId: evaluator.memberId, role: "evaluator", cwd: evaluator.cwd, baseCommit: evaluator.baseCommit, headCommit: head, workspace: "member" } } });
    writeSealed(teamFile, f.key, `team:${teamId}`, team);
    const sealedGoal = unseal<{ objectiveRecord: ObjectiveRecord }>(f.key, `goal:${goal.id}`, readFileSync(goalFile, "utf8"));
    const before = sealedGoal.objectiveRecord;
    const composed = composeVerdict({ record: before, head, kind: "reviewed", configured: [], receipts: [], facts: {}, changedPaths: { paths: [], truncated: false }, reason: "evaluator-unavailable" });
    const written = verdictRecord(before, composed, { verdictId, kind: "reviewed", revision: 1, head, at: AT });
    assert.notEqual(written, "log-full");
    sealedGoal.objectiveRecord = written as ObjectiveRecord;
    writeSealed(goalFile, f.key, `goal:${goal.id}`, sealedGoal);

    const teams = f.openTeam(), reopened = new GoalService(f.config, f.key, teams);
    teams.start();
    await new Promise(resolve => setTimeout(resolve, 3000));
    teams.close();
    const record = reopened.objectiveRecord(goal.id);
    const entries = record.log.filter(entry => entry.op === VERDICT_OPS.recorded && entry.handle === `verdict:${verdictId}`);
    assert.equal(entries.length, 1, "the record holds the entry once");
    assert.equal(record.log.filter(entry => entry.op === VERDICT_OPS.recorded).length, 1);
    assert.equal(record.version, (written as ObjectiveRecord).version, "the record's version did not change");
    const after = storedOf(teams, teamId);
    assert.equal(after.run.assessment, undefined, "the run has no assessment");
    assert.equal((after.outbox ?? []).filter(event => event.kind === "verdict.recorded").length, 0, "no row event");
    assert.equal(after.run.status, "blocked");
    assert.match(after.run.reason ?? "", /will not be replayed/);
    assert.equal(after.verdict?.status, "evaluating");
  } finally { f.close(); }
});

function reportAllCriteriaMet(f: SchedulerFixture, member: TeamMember) {
  const context = JSON.parse(readFileSync(join(member.cwd, ".git", "infinite-team-context.json"), "utf8")) as { record: { criteria: { id: string }[] }; changedPaths: { paths: string[] } };
  assert.ok(context.record.criteria.length >= 1, "the context holds the goal record's criteria");
  f.report(member.sessionId, { requestId: randomUUID(), runId: member.runId, memberId: member.memberId, revision: member.revision,
    report: { kind: "verdict", result: "met", criteria: context.record.criteria.map(item => ({ id: item.id, state: "met", evidence: [`file:${context.changedPaths.paths[0]}`] })) } });
}

test("a crash after writing the goal objective record and before saving the run recovers assessment, outbox, and settlement cleanly", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  const store1 = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const watch1 = watched(store1);
  let store2: EvidenceStore | undefined;
  let restoreTeamWrite: (() => void) | undefined;
  try {
    activeSessions(f);
    const head = seedReviewed(f, { rank: "passed" });
    f.config.projects[0]!.team = { checks: [RANK], objective: { prompts: "on", evaluator: "on", register: "on" } } as Project["team"];
    const setupTeams = f.openTeam({ events: watch1.outbox });
    const setupGoals = new GoalService(f.config, f.key, setupTeams);
    const goal = await setupGoals.create({ requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
      successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2 } as CreateGoal);
    setupGoals.close();
    await setupTeams.close();

    const teamId = f.run.id;
    const teamFile = join(f.config.stateDir, "teams", `${teamId}.sealed`);
    const goalFile = join(f.config.stateDir, "goals", `${goal.id}.sealed`);
    Object.assign(f.run, {
      goal: {
        id: goal.id, revision: 1, cycle: 1, successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [],
        previousWork: [], deadlineAt: new Date(Date.now() + 3600_000).toISOString(), maxMembers: 10,
      },
    });
    f.writeTeam({ checkHead: head });

    const crashedTeams = f.openTeam({ events: watch1.outbox });
    const crashedGoals = new GoalService(f.config, f.key, crashedTeams);
    const originalGoalsPort = crashedTeams.verdicts.goals!;
    let wroteGoal = false;
    crashedTeams.verdicts.goals = {
      read: id => originalGoalsPort.read(id),
      write: (id, expectedVersion, next) => {
        originalGoalsPort.write(id, expectedVersion, next);
        wroteGoal = true;
        restoreTeamWrite = f.blockRecordWrites("team", teamId);
      },
    };
    crashedTeams.start();
    const evaluator = await launchedEvaluator(f, crashedTeams, teamId);
    reportAllCriteriaMet(f, evaluator!);
    await waitFor(() => Promise.resolve(wroteGoal), done => done, 30000);
    await new Promise(resolve => setTimeout(resolve, 250));
    crashedGoals.close();
    await crashedTeams.close();
    store1.close();
    restoreTeamWrite!();
    restoreTeamWrite = undefined;

    const midGoal = unseal<{ objectiveRecord: ObjectiveRecord }>(f.key, `goal:${goal.id}`, readFileSync(goalFile, "utf8")).objectiveRecord;
    const midTeam = unseal<Stored & { pending?: unknown }>(f.key, `team:${teamId}`, readFileSync(teamFile, "utf8"));
    const midVerdicts = midGoal.log.filter(entry => entry.op === VERDICT_OPS.recorded);
    assert.equal(midVerdicts.length, 1, "goal record persisted the verdict before the crash");
    assert.equal(midTeam.pending, undefined, "intent save cleared the read-only operation marker before goal write");
    assert.equal(midTeam.verdict?.status, "recording", "durable recording intent is persisted on the team run");
    assert.ok(midTeam.verdict?.commit, "composed commit payload is durably persisted");
    assert.equal(midTeam.run.assessment, undefined, "final team save did not complete before the crash");

    store2 = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
    const watch2 = watched(store2);
    assert.equal(store2.read(db => db.all("SELECT verdict_id FROM objective_verdicts")).length, 0, "no ledger row before recovery");

    const recoveredTeams = f.openTeam({ events: watch2.outbox });
    const recoveredGoals = new GoalService(f.config, f.key, recoveredTeams);
    recoveredTeams.start();
    const settled = await waitFor(() => Promise.resolve(recoveredTeams.get(teamId)), view => TERMINAL.includes(view.status), 30000);
    recoveredGoals.close();
    await recoveredTeams.close();

    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-6)));
    assert.equal(settled.assessment?.result, "met");
    assert.equal(settled.assessment?.verdictId, midVerdicts[0]!.handle!.slice("verdict:".length));
    const afterGoal = recoveredGoals.objectiveRecord(goal.id);
    assert.equal(afterGoal.version, midGoal.version, "recovery did not rewrite the goal objective record");
    assert.equal(afterGoal.log.filter(entry => entry.op === VERDICT_OPS.recorded).length, 1);
    const afterTeam = unseal<Stored>(f.key, `team:${teamId}`, readFileSync(teamFile, "utf8"));
    assert.equal(afterTeam.verdict?.status, "done");
    assert.equal(afterTeam.verdict?.commit, undefined);
    assert.equal(afterTeam.run.events.filter(event => event.text.startsWith("Agent assessment, provisional")).length, 1);
    const ledger = store2.read(db => db.all<{ verdict_id: string; record_version: number; result: string }>("SELECT verdict_id, record_version, result FROM objective_verdicts"));
    assert.equal(ledger.length, 1, "exactly one verdict row flushed to SQLite after recovery");
    assert.equal(ledger[0]!.verdict_id, settled.assessment!.verdictId);
    assert.equal(ledger[0]!.record_version, midGoal.version);
    assert.equal(ledger[0]!.result, "met");
  } finally {
    restoreTeamWrite?.();
    try { store1.close(); } catch {}
    try { store2?.close(); } catch {}
    f.close();
  }
});

test("a crash after persisting the recording intent and before writing the goal record converges cleanly on restart", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  const store1 = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const watch1 = watched(store1);
  let store2: EvidenceStore | undefined;
  let restoreTeamWrite: (() => void) | undefined;
  try {
    activeSessions(f);
    const head = seedReviewed(f, { rank: "passed" });
    f.config.projects[0]!.team = { checks: [RANK], objective: { prompts: "on", evaluator: "on", register: "on" } } as Project["team"];
    const setupTeams = f.openTeam({ events: watch1.outbox });
    const setupGoals = new GoalService(f.config, f.key, setupTeams);
    const goal = await setupGoals.create({ requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
      successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2 } as CreateGoal);
    setupGoals.close();
    await setupTeams.close();

    const teamId = f.run.id;
    const teamFile = join(f.config.stateDir, "teams", `${teamId}.sealed`);
    const goalFile = join(f.config.stateDir, "goals", `${goal.id}.sealed`);
    Object.assign(f.run, {
      goal: {
        id: goal.id, revision: 1, cycle: 1, successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [],
        previousWork: [], deadlineAt: new Date(Date.now() + 3600_000).toISOString(), maxMembers: 10,
      },
    });
    f.writeTeam({ checkHead: head });

    const crashedTeams = f.openTeam({ events: watch1.outbox });
    const crashedGoals = new GoalService(f.config, f.key, crashedTeams);
    const originalGoalsPort = crashedTeams.verdicts.goals!;
    let intercepted = false;
    crashedTeams.verdicts.goals = {
      read: id => originalGoalsPort.read(id),
      write: () => {
        intercepted = true;
        restoreTeamWrite = f.blockRecordWrites("team", teamId);
        throw new Error("simulated crash before goal write");
      },
    };
    crashedTeams.start();
    const evaluator = await launchedEvaluator(f, crashedTeams, teamId);
    reportAllCriteriaMet(f, evaluator!);
    await waitFor(() => Promise.resolve(intercepted), done => done, 30000);
    await new Promise(resolve => setTimeout(resolve, 250));
    crashedGoals.close();
    await crashedTeams.close();
    store1.close();
    restoreTeamWrite!();
    restoreTeamWrite = undefined;

    const midGoal = unseal<{ objectiveRecord: ObjectiveRecord }>(f.key, `goal:${goal.id}`, readFileSync(goalFile, "utf8")).objectiveRecord;
    const midTeam = unseal<Stored>(f.key, `team:${teamId}`, readFileSync(teamFile, "utf8"));
    assert.equal(midGoal.log.filter(entry => entry.op === VERDICT_OPS.recorded).length, 0, "goal record was not written before crash");
    assert.equal(midTeam.verdict?.status, "recording", "recording intent was persisted before crash");
    assert.equal(midTeam.run.assessment, undefined);

    store2 = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
    const watch2 = watched(store2);
    const recoveredTeams = f.openTeam({ events: watch2.outbox });
    const recoveredGoals = new GoalService(f.config, f.key, recoveredTeams);
    recoveredTeams.start();
    const settled = await waitFor(() => Promise.resolve(recoveredTeams.get(teamId)), view => TERMINAL.includes(view.status), 30000);
    recoveredGoals.close();
    await recoveredTeams.close();

    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-6)));
    assert.equal(settled.assessment?.result, "met");
    const afterGoal = recoveredGoals.objectiveRecord(goal.id);
    assert.equal(afterGoal.version, midGoal.version + 1, "recovery wrote the goal objective record once");
    assert.equal(afterGoal.log.filter(entry => entry.op === VERDICT_OPS.recorded).length, 1);
    const ledger = store2.read(db => db.all<{ verdict_id: string; record_version: number }>("SELECT verdict_id, record_version FROM objective_verdicts"));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.verdict_id, settled.assessment!.verdictId);
    assert.equal(ledger[0]!.record_version, afterGoal.version);
  } finally {
    restoreTeamWrite?.();
    try { store1.close(); } catch {}
    try { store2?.close(); } catch {}
    f.close();
  }
});

function twoCriterionGoalRecord(): ObjectiveRecord {
  const base = runtimeRecordOf("5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", 1);
  const criteria = base.criteria
    .filter(item => item.id !== "c2")
    .map(item => {
      if (item.id !== "c0") return item;
      const { statementOf: _statementOf, ...rest } = item as typeof item & { statementOf?: unknown };
      return { ...rest, statement: "Rank founders accurately" };
    });
  const { digest: _digest, ...rest } = base;
  const body = { ...rest, owner: { kind: "goal" as const, goalId: RUNTIME_GOAL }, criteria };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

test("recovery recomposes against a goal objective record edited between intent save and restart instead of marking changed criteria met", () => {
  const f = evaluatingVerdict({ goal: true, record: twoCriterionGoalRecord() });
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met", c1: "met" }));
  f.world.store!.failNextWrite = true;
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.verdict?.commit?.composed.result, "met");
  assert.equal(f.holder.verdict?.commit?.sourceRecordVersion, 1);
  assert.equal(f.world.store!.record.version, 1);

  const editedBase = f.world.store!.record;
  const editedCriteria = editedBase.criteria.map(item => {
    if (item.id === "c0") return { ...item, statement: "Rank founders with audited revenue evidence" };
    if (item.id === "c1") return { ...item, check: { kind: "command" as const, command: commandDigest({ command: "npm", args: ["run", "strict-verify"] }) } };
    return item;
  });
  f.world.store!.record = sealRecord(
    editedBase,
    { rubricVersion: 2, criteria: editedCriteria },
    [{ seq: editedBase.log.length + 1, at: AT, version: 2, actor: "owner", authority: "direction", op: "criterion.updated", target: "c0" }],
  );

  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.run.assessment?.result, "inconclusive");
  assert.deepEqual(
    f.holder.run.assessment?.criteria.map(item => [item.id, item.state]),
    [["c0", "inconclusive"], ["c1", "inconclusive"]],
  );
  assert.equal(f.world.store!.record.version, 3);
  assert.equal(f.holder.outbox.length, 1);
  assert.equal(f.holder.outbox[0]!.result, "inconclusive");
  assert.equal(f.holder.outbox[0]!.recordVersion, 3);
  assert.equal(f.holder.outbox[0]!.rubricVersion, 2);
});

test("recovery against an unreadable goal record finalizes as inconclusive record-unavailable and never triggers provisional stop", () => {
  const f = evaluatingVerdict({ goal: true, record: twoCriterionGoalRecord() });
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met", c1: "met" }));
  f.world.store!.failNextWrite = true;
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.verdict?.commit?.composed.result, "met");

  const originalPort = f.verdicts.goals!;
  f.verdicts.goals = {
    read: () => ({ kind: "unavailable", reason: "record-invalid" }),
    write: originalPort.write,
  };

  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.verdict?.written, "record-unavailable");
  assert.equal(f.holder.run.assessment?.result, "inconclusive");
  assert.equal(f.holder.run.assessment?.reason, "record-unavailable");
  assert.equal(f.holder.outbox.length, 0);
  const stop = provisionalStop(
    { autonomy: "autonomous", cycles: [{ teamId: f.holder.run.id } as never] },
    { id: f.holder.run.id, revision: f.holder.run.revision, assessment: f.holder.run.assessment },
  );
  assert.equal(stop, false);
});

test("failed finalization save rolls back the emitted outbox entry so retry emits the current record version", () => {
  const f = evaluatingVerdict({ goal: true, record: twoCriterionGoalRecord() });
  const seenKeys = new Set<string>();
  f.host.emit = (holder, data) => {
    const outbox = holder.outbox as typeof f.holder.outbox;
    if (outbox.some(item => item.verdictId === data.verdictId)) return;
    seenKeys.add(data.verdictId);
    outbox.push(data);
  };
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met", c1: "met" }));
  f.world.store!.failing = true;
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(seenKeys.size, 1, "emit ran before the failed final save");
  assert.equal(f.holder.outbox.length, 0, "failed final save rolled back the stale version-1 outbox entry");
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.run.assessment, undefined);

  f.world.store!.failing = false;
  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.verdict?.written, "wrote");
  assert.equal(f.world.store!.record.version, 2);
  assert.equal(f.holder.outbox.length, 1);
  assert.equal(f.holder.outbox[0]!.recordVersion, 2);
});

test("failed finalization save restores a capped 300-event run history by value without dropping the oldest event", () => {
  const f = evaluatingVerdict({ goal: true, record: twoCriterionGoalRecord() });
  f.host.event = (holder, text) => appendRunEvent(holder.run, text);
  f.holder.run.events.splice(
    0,
    f.holder.run.events.length,
    ...Array.from({ length: 300 }, (_, index) => ({ at: AT, text: `event-${index}` })),
  );
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met", c1: "met" }));
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(f.holder.run.events.length, 300);
  assert.equal(f.holder.run.events[0]!.text, "event-0");
  assert.equal(f.holder.run.events[299]!.text, "event-299");
  assert.equal(f.holder.run.events.some(event => event.text.startsWith("Agent assessment, provisional")), false);

  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.run.events.length, 300);
  assert.equal(f.holder.run.events[0]!.text, "event-1");
  assert.match(f.holder.run.events[299]!.text, /^Agent assessment, provisional/);
});

test("recovery fences an artifact criterion whose threshold was raised between intent save and restart", () => {
  const base = twoCriterionGoalRecord();
  const artifactCriteria = base.criteria.map(item =>
    item.id === "c1"
      ? { ...item, statement: "Shortlist holds at least 3 founders", check: { kind: "artifact" as const, path: SHORTLIST, count: "/items" }, threshold: { kind: "count" as const, min: 3 } }
      : item,
  );
  const { digest: _digest, ...rest } = base;
  const initialRecord = { ...rest, criteria: artifactCriteria, digest: recordDigest({ ...rest, criteria: artifactCriteria }) } as ObjectiveRecord;
  const f = evaluatingVerdict({ goal: true, record: initialRecord });
  f.world.passes.set(f.holder.run.id, {
    head: f.holder.run.headCommit!,
    pending: false,
    receipts: [{
      handle: `receipt:${f.holder.run.id}:1:c1`, kind: "artifact", subject: "criterion", id: "c1",
      digest: definitionDigest(initialRecord.criteria.find(item => item.id === "c1")!),
      commit: f.holder.run.headCommit!, outcome: "pass", at: AT, detail: { kind: "artifact", read: "read", total: 5 },
    }],
  });
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met" }));
  f.world.store!.failNextWrite = true;
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.verdict?.commit?.composed.result, "met");

  const raisedCriteria = f.world.store!.record.criteria.map(item =>
    item.id === "c1" ? { ...item, threshold: { kind: "count" as const, min: 10 } } : item,
  );
  f.world.store!.record = sealRecord(
    f.world.store!.record,
    { rubricVersion: 2, criteria: raisedCriteria },
    [{ seq: f.world.store!.record.log.length + 1, at: AT, version: 2, actor: "owner", authority: "direction", op: "criterion.updated", target: "c1" }],
  );

  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.run.assessment?.result, "inconclusive");
  assert.deepEqual(
    f.holder.run.assessment?.criteria.map(item => [item.id, item.state]),
    [["c0", "met"], ["c1", "inconclusive"]],
  );
  assert.equal(
    provisionalStop(
      { autonomy: "autonomous", cycles: [{ teamId: f.holder.run.id } as never] },
      { id: f.holder.run.id, revision: f.holder.run.revision, assessment: f.holder.run.assessment },
    ),
    false,
  );
});

test("recovery keeps original receipt fingerprints immutable across repeated crashes and subsequent unrelated edits", () => {
  const f = evaluatingVerdict({ goal: true, record: twoCriterionGoalRecord() });
  reportRuntimeEvaluator(f, f.member, runtimeReportOf({ c0: "met", c1: "met" }));
  f.world.store!.failNextWrite = true;
  f.host.failSaveAt = 2;
  assert.throws(() => settleRuntimeVerdict(f.host, true), /stopped before it saved/);
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.verdict?.commit?.composed.result, "met");

  const editedC1 = f.world.store!.record.criteria.map(item =>
    item.id === "c1"
      ? { ...item, check: { kind: "command" as const, command: commandDigest({ command: "npm", args: ["run", "strict-verify"] }) } }
      : item,
  );
  f.world.store!.record = sealRecord(
    f.world.store!.record,
    { rubricVersion: 2, criteria: editedC1 },
    [{ seq: f.world.store!.record.log.length + 1, at: AT, version: 2, actor: "owner", authority: "direction", op: "criterion.updated", target: "c1" }],
  );

  f.world.store!.failNextWrite = true;
  f.host.failSaveAt = 2;
  assert.throws(() => f.verdicts.recover(f.holder), /stopped before it saved/);
  assert.equal(f.holder.verdict?.status, "recording");
  assert.equal(f.holder.verdict?.commit?.sourceRecordVersion, 2);
  assert.equal(f.holder.verdict?.commit?.composed.result, "inconclusive");
  assert.equal(f.world.store!.record.version, 2);

  f.world.store!.record = sealRecord(
    f.world.store!.record,
    { nonGoals: [{ id: "ng1", text: "Do not rank non-public companies" }] },
    [{ seq: f.world.store!.record.log.length + 1, at: AT, version: 3, actor: "owner", authority: "direction", op: "nongoal.added", target: "ng1" }],
  );

  assert.equal(f.verdicts.recover(f.holder), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.run.assessment?.result, "inconclusive");
  assert.deepEqual(
    f.holder.run.assessment?.criteria.map(item => [item.id, item.state]),
    [["c0", "met"], ["c1", "inconclusive"]],
  );
  assert.equal(f.world.store!.record.version, 4);
  assert.equal(f.holder.outbox.length, 1);
  assert.equal(f.holder.outbox[0]!.result, "inconclusive");
  assert.equal(f.holder.outbox[0]!.recordVersion, 4);
});
