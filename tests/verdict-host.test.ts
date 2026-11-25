import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import { GoalService } from "../packages/host/src/goals.js";
import type { CreateGoal } from "../packages/host/src/goal-types.js";
import { composeVerdict, verdictRecord } from "../packages/host/src/verdict-compose.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { isFuseReason } from "../packages/host/src/fuse/rules.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { VERDICT_OPS } from "../packages/host/src/objective-record.js";
import { recordDigest, type Criterion, type ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { TeamCommand, TeamLineup, TeamMember, TeamModelProfile, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { VERDICT_EVENTS } from "../packages/host/src/team-verdicts.js";
import { registerVerdicts } from "../packages/host/src/verdict-store.js";
import type { Config, Project } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture } from "./team-fixture.js";

type SchedulerFixture = ReturnType<typeof schedulerFixture>;
type Stored = { run: TeamRun; verdict?: { status: string; failures: number; excluded?: string[] }; objectiveRecord?: unknown; outbox?: OutboxEvent[] };

const AT = new Date().toISOString();
const SHORTLIST = "research/shortlist.json";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
// Built at run time from fragments, so no marker text sits in the source as one string.
const MARK = ["seal", "q7q7q7q7q7q7q7q7"].join("-");

const COORDINATOR: TeamModelProfile = { id: "opus-coordinator", label: "Opus coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
const INTEGRATOR: TeamModelProfile = { id: "opus-integrator", label: "Opus integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
// The fake planner names these two ids for its two tasks; both run the same model.
const IMPLEMENTER: TeamModelProfile = { id: "spark-high", label: "Deep implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium", tier: "light" };
const REVIEWER: TeamModelProfile = { id: "astra-reviewer", label: "Astra reviewer", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" };
// The implementer's own model as an evaluator: listed first, and never chosen.
const AUTHOR_MODEL: TeamModelProfile = { id: "deep-evaluator", label: "Deep evaluator", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium", tier: "strong" };
const OTHER_FAMILY: TeamModelProfile = { id: "gemini-evaluator", label: "Gemini evaluator", provider: "opencode", model: "google/gemini-3-pro", variant: "high", tier: "strong" };
const SECOND_IMPLEMENTER: TeamModelProfile = { ...IMPLEMENTER, id: "astra-xhigh", label: "Second deep implementer" };
const LINEUP: TeamLineup = { coordinator: COORDINATOR, implementers: [IMPLEMENTER, SECOND_IMPLEMENTER], integrator: INTEGRATOR, reviewer: REVIEWER, evaluators: [AUTHOR_MODEL, REVIEWER] };
const WIDE_LINEUP: TeamLineup = { ...LINEUP, evaluators: [AUTHOR_MODEL, REVIEWER, OTHER_FAMILY] };

const storedOf = (teams: TeamService, id: string) => (teams as unknown as { record(id: string): Stored }).record(id);
const scheduler = (teams: TeamService) => teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
const evaluators = (view: TeamView) => view.members.filter(member => member.role === "evaluator");
const TERMINAL = ["ready-for-review", "merged", "blocked", "cancelled"];

/** The events the service handed to the outbox, whether still waiting in a run's record or already flushed. The ledger is registered as the server registers it. */
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

/* ------------------------------------------------ real runs, with the fake agent */

/** A host with the fake agent. `verdicts` writes the project's evaluator and register settings. */
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

    // The implementer's model is listed first and is never chosen; the reviewer's profile evaluates.
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

  // A verdict report from an implementer is a wrong report, as today: no assessment and no verdict state.
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
    // The evaluator's note and one handle carry the marker; the host must keep both out of every reader.
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

    // The marker did reach the host: it sits in the sealed verdict state, the one place that may hold it.
    assert.equal(JSON.stringify(storedOf(teams, created.id).verdict).includes(MARK), true, "the evaluator's text reached the sealed state");
    // The member's report in the view is the stub: ids and states, no evidence.
    const report = evaluator[0]!.report as { kind: string; criteria: { id: string; evidence: unknown[] }[] };
    assert.equal(report.kind, "verdict");
    assert.ok(report.criteria.length >= 1);
    for (const item of report.criteria) assert.equal(item.evidence.length, 0, "empty evidence");

    // A later member: the owner steers the run, and the next project manager starts at a new revision.
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
      // verdict.json is the evaluator's own input; its context and prompt copies hold only host text.
      if (name !== "verdict.json") places[`the file ${name.replace(/[0-9a-f-]{36}/g, "<id>")}`] = readFileSync(join(f.receipts, name), "utf8");
    }
    for (const [place, text] of Object.entries(places)) assert.equal(text.includes(MARK), false, `the marker reached ${place}`);
    // The files of the later member were among those read.
    assert.ok(Object.keys(places).some(name => name.startsWith("the file ")), "member files were searched");
    assert.equal(existsSync(join(f.receipts, `${planner.memberId}.context.json`)), true);
  } finally { store.close(); await f.close(); }
});

/* ------------------------------------------------ seeded runs, on the scheduler fixture */

/** The fixture's launched sessions are quiet from six minutes back, so the scheduler stalls each one before its report. */
function activeSessions(f: SchedulerFixture) {
  const state = f.manager.state;
  f.manager.state = async (requestedId?: string) => ({ ...(await state(requestedId)), attention: initialAttention(new Date().toISOString(), true) });
}

function git(f: SchedulerFixture, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: f.run.workspace, encoding: "utf8", stdio: "pipe" }).trim();
}

/** c0, three judgements, and c4: `rank-verify` must pass. */
function recordFor(runId: string): ObjectiveRecord {
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
    ],
    assumptions: [], questions: [], rubricVersion: 1,
    log: [{ seq: 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: runId }],
  };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

/**
 * Writes a standalone run that the reviewer approved: one integrated task whose author is the lineup's implementer, a change to the
 * shortlist, a final check round for `rank-verify`, and the verdict pins. The next scheduler pass reaches the approved branch.
 */
function seedReviewed(f: SchedulerFixture, options: { rank: "passed" | "failed"; lineup?: TeamLineup; outbox?: boolean; members?: number; manager?: TeamModelProfile }): string {
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
  // A project manager that ran, as after a provider limit moved it to a fallback profile.
  if (options.manager) f.run.members.push({ ...author, memberId: randomUUID(), sessionId: randomUUID(), role: "project-manager", taskId: undefined, report: undefined, modelProfile: options.manager });
  // Earlier attempts that stopped: they count against the run's limit of members and do nothing else.
  for (let extra = 1; extra < (options.members ?? 1); extra += 1) f.run.members.push({ ...author, memberId: randomUUID(), sessionId: randomUUID(), taskId: undefined, report: undefined });
  f.run.tasks = [{ id: "t1", title: "Write the shortlist", instructions: "Write it", paths: [SHORTLIST], dependsOn: [], revision: 1, status: "integrated", memberId: author.memberId,
    commit: head, changedPaths: { paths: [SHORTLIST], truncated: false } } as TeamRun["tasks"][number]];
  Object.assign(f.run, { status: "reviewing", revision: 1, parallelismCeiling: 4, headCommit: head, lineup: options.lineup ?? LINEUP, verdicts: "on", register: "on",
    review: { verdict: "approved", summary: "Approved.", revision: 1 },
    changes: { headCommit: head, recordedAt: AT, files: [{ path: SHORTLIST, status: "added", added: 1, removed: 0 }], truncated: false },
    checks: [{ command: RANK, status: options.rank, startedAt: AT, output: "", revision: 1, headCommit: head, round: 1 }] });
  f.writeTeam({ objectiveRecord: recordFor(f.run.id), checkHead: head });
  return head;
}

const memberOf = (teams: TeamService, id: string, role: string, nth = 0) => storedOf(teams, id).run.members.filter(member => member.role === role)[nth];
/** The evaluator once the host has launched its session. */
const launchedEvaluator = (f: SchedulerFixture, teams: TeamService, id: string, nth = 0) =>
  waitFor(() => Promise.resolve(memberOf(teams, id, "evaluator", nth)), member => member !== undefined && f.launches.some(launch => launch.requestId === member.sessionId), 30000);

/** What the fake evaluator does: reads its context file and reports every criterion in it met, with the first changed path. */
function answerAllMet(f: SchedulerFixture, member: TeamMember) {
  const context = JSON.parse(readFileSync(join(member.cwd, ".git", "infinite-team-context.json"), "utf8")) as { record: { criteria: { id: string }[] }; changedPaths: { paths: string[] } };
  assert.ok(context.record.criteria.length >= 5, "the context holds the record's criteria");
  f.report(member.sessionId, { requestId: randomUUID(), runId: member.runId, memberId: member.memberId, revision: member.revision,
    report: { kind: "verdict", result: "met", criteria: context.record.criteria.map(item => ({ id: item.id, state: "met", evidence: [`file:${context.changedPaths.paths[0]}`] })) } });
}

test("acceptance 6 end to end", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const watch = watched(store);
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "failed" });
    const teams = f.openTeam({ events: watch.outbox });
    teams.start();
    const evaluator = await launchedEvaluator(f, teams, f.run.id);
    answerAllMet(f, evaluator!);
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();

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
    // The event the host stored reaches the ledger as a row.
    const ledger = store.read(db => db.all<{ result: string; evaluator_result: string | null; run_id: string }>("SELECT result, evaluator_result, run_id FROM objective_verdicts"));
    assert.equal(ledger.length, 1, "one ledger row");
    assert.equal(ledger[0]!.run_id, f.run.id);
    assert.equal(ledger[0]!.result, "not-met");
    assert.equal(ledger[0]!.evaluator_result, "met");
    const named = store.read(db => db.all<{ profile_id: string | null }>("SELECT profile_id FROM objective_verdicts"));
    assert.equal(named[0]!.profile_id, evaluator!.modelProfile?.id, "an applied answer names the evaluator");
    assert.equal(teams.verdicts.detail(f.run.id)?.evaluator?.profileId, evaluator!.modelProfile?.id);
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
    // A standalone run admits 60 members, and the evaluator would be one more.
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
  const members = join(f.run.workspace, "..", "members");
  try {
    activeSessions(f);
    seedReviewed(f, { rank: "passed" });
    // The review is approved. The host refuses a members directory that is a link, so the evaluator's checkout cannot be made.
    rmSync(members, { recursive: true, force: true });
    symlinkSync(join(f.run.workspace, ".."), members);
    const teams = f.openTeam();
    teams.start();
    const view = await waitFor(() => Promise.resolve(teams.get(f.run.id)), current => TERMINAL.includes(current.status), 60000);
    teams.close();
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.assessment?.result, "inconclusive");
    assert.equal(view.assessment?.reason, "evaluator-unavailable");
    assert.equal(evaluators(view).length, 0, "no evaluator was added");
    assert.equal(storedOf(teams, f.run.id).pending, undefined, "no failed operation stays on the run");
  } finally { f.close(); }
});

test("a stalled evaluator is replaced once", { timeout: 120000 }, async () => {
  const f = schedulerFixture();
  try {
    // The fixture's sessions are quiet from six minutes back, so each evaluator stalls as soon as the scheduler looks at it.
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

    // The verdict waits: no evaluator session starts, and the run neither settles nor loses its hold.
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
    // A goal with its first cycle's run, created by the services themselves; both stop before the crash is written.
    const first = f.openTeam(), goals = new GoalService(f.config, f.key, first);
    const goal = await goals.create({ requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
      successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2 } as CreateGoal);
    goals.start();
    await goals.steer(goal.id, { requestId: randomUUID(), revision: 999, text: "Barrier" }).catch(() => undefined);
    const teamId = goals.get(goal.id).activeTeamId!;
    assert.ok(teamId, "the first cycle's run exists");
    goals.close();
    first.close();
    await first.idle();

    // The files as the crash leaves them: the run held in `evaluating` with its evaluator reported and an operation running, and the
    // goal's record already holding the verdict's entry.
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

    // The host opens again.
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
    // The restart fences the interrupted operation as it does for any member's result: the run blocks, nothing replays, and the
    // verdict stays where the crash left it.
    assert.equal(after.run.status, "blocked");
    assert.match(after.run.reason ?? "", /will not be replayed/);
    assert.equal(after.verdict?.status, "evaluating");
  } finally { f.close(); }
});
