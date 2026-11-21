import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, mixedLineup } from "./team-fixture.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { waitFor } from "./helpers.js";
import { INTENT_EVENTS } from "../packages/host/src/team-intent.js";
import { INTENT_OPS, runRecord } from "../packages/host/src/objective-record.js";
import { applyIntentReport } from "../packages/host/src/objective-intent.js";
import type { IntentCheckReport } from "../packages/host/src/intent-report.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import type { ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamView } from "../packages/host/src/team-types.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Stored = { run: TeamRun; objectiveRecord?: unknown };

const TERMINAL = ["ready-for-review", "merged", "blocked", "cancelled"];
const OBJECTIVE = "Create independent files and verify their integrated contents.";
// Built at run time, so the source holds no credential-shaped literal.
const SECRET = "gh" + "p_" + "a".repeat(36);
const EVALUATOR: TeamModelProfile = { id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" };
const CHECKED_LINEUP: TeamLineup = { ...mixedLineup, evaluators: [EVALUATOR] };

/**
 * A host with the fake agent and the configured project. `setting` writes `objective.intentCheck`; the lineup defaults to one
 * eligible evaluator. `blackboard` turns the blackboard tools on, with an entries service on the host's evidence store.
 */
async function start(autonomy: "autonomous" | "supervised", setting?: "on" | "off", lineup: TeamLineup = CHECKED_LINEUP, blackboard = false) {
  const f = await fixture("intent", lineup, {}, { noServer: true });
  const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
  project.autonomy = autonomy;
  if (setting) project.team = { ...project.team!, objective: { intentCheck: setting } };
  // The blackboard pins `run.blackboard` at create, so the tools flag and the entries service are both set before it.
  const store = blackboard ? new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) }) : undefined;
  const entries = store ? new Blackboard(store) : undefined;
  if (entries) f.host.config.teams!.blackboard = { tools: true };
  const teams = await f.openTeamService({ entries });
  return { f, teams, store, entries };
}
type Teams = Awaited<ReturnType<Fixture["openTeamService"]>>;

const flag = (f: Fixture, name: string) => writeFileSync(join(f.receipts, name), "1", { mode: 0o600 });
const unflag = (f: Fixture, name: string) => rmSync(join(f.receipts, name), { force: true });
const release = (f: Fixture, runId: string, name: string) => writeFileSync(join(f.receipts, `${runId}.${name}`), "1", { mode: 0o600 });
const reportFile = (f: Fixture, value: unknown) => writeFileSync(join(f.receipts, "intent-report.json"), JSON.stringify(value), { mode: 0o600 });

const stored = (teams: Teams, id: string): Stored => (teams as unknown as { record(id: string): Stored }).record(id);
const recordOf = (teams: Teams, id: string) => stored(teams, id).objectiveRecord as ObjectiveRecord | undefined;
const logOps = (record: ObjectiveRecord | undefined, op: string) => (record?.log ?? []).filter(entry => entry.op === op);
const texts = (view: TeamView) => view.events.map(event => event.text);
const checkers = (view: TeamView) => view.members.filter(member => member.role === "intent-checker");
const settle = (teams: Teams, id: string, timeout = 540000) => waitFor(() => Promise.resolve(teams.get(id)), view => TERMINAL.includes(view.status), timeout);
const until = (teams: Teams, id: string, ready: (view: TeamView) => boolean, timeout = 300000) => waitFor(() => Promise.resolve(teams.get(id)), ready, timeout);
const answerWith = (teams: Teams, id: string, decisionId: string, revision: number, text: string) =>
  teams.answer(id, decisionId, { requestId: randomUUID(), revision, text });

/** An outcome ask the owner must answer, and a scout that becomes an assumption until the scout slice lands. */
const askReport = () => ({
  kind: "intent-check", summary: "One outcome needs the owner.", items: [
    { dimension: "outcome", why: "The success check depends on the owner's naming choice.", criticality: "outcome", disposition: "ask",
      assumption: { statement: "The owner chooses the output name.", refutedBy: "The owner names the output another way.", test: { kind: "owner" } },
      question: { text: "Which output name should the files use?", options: ["alpha", "beta"], interrupt: "definition" } },
    { dimension: "layout", why: "A scout can read the existing layout.", criticality: "detail", disposition: "scout",
      assumption: { statement: "The layout already exists.", refutedBy: "The layout is missing.", test: { kind: "owner" } }, scout: "Read the existing layout." },
  ],
});

/** Stops the host, optionally rewrites the sealed run record on disk, and opens the host again from disk. */
async function restartWith(f: Fixture, teams: Teams, runId: string, edit?: (stored: SealedRun) => void): Promise<Teams> {
  await teams.close();
  await teams.idle();
  if (edit) editSealed(f, runId, edit);
  return f.openTeamService({});
}

/** The sealed run record as the host writes it: `teams/<id>.sealed`, scope `team:<id>`, the config's key. */
type SealedRun = { run: TeamRun; intentCheck?: Record<string, unknown> & { status: string; planMemberId: string }; objectiveRecord?: ObjectiveRecord };
function editSealed(f: Fixture, runId: string, edit: (stored: SealedRun) => void) {
  const file = join(f.host.config.stateDir, "teams", `${runId}.sealed`);
  const key = readFileSync(f.host.config.keyFile);
  const stored = unseal<SealedRun>(key, `team:${runId}`, readFileSync(file, "utf8"));
  edit(stored);
  writeSealed(file, key, `team:${runId}`, stored);
}

/** The run's plan is accepted once: one checker, the decisions named, one plan accepted, and the first plan's tasks. */
function assertPlanAcceptedOnce(f: Fixture, teams: Teams, runId: string, view: TeamView, decisions: number) {
  assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
  assert.equal(checkers(view).length, 1, "one checker per revision");
  assert.equal(view.decisions.length, decisions, "decisions");
  assert.equal(texts(view).filter(text => text.startsWith("Project manager planned")).length, 1, "one plan accepted");
  const shape = (tasks: { id: string; title: string; paths: string[]; dependsOn: string[] }[]) => tasks.map(task => ({ id: task.id, title: task.title, paths: task.paths, dependsOn: task.dependsOn }));
  const first = JSON.parse(readFileSync(join(f.receipts, `${runId}.first-plan`), "utf8")).tasks;
  assert.deepEqual(shape(stored(teams, runId).run.tasks), shape(first), "the final tasks differ from the plan without a restart");
}

test("the check follows the run's pin", { timeout: 1500000 }, async () => {
  const run = async (autonomy: "autonomous" | "supervised", setting?: "on" | "off", lineup?: TeamLineup) => {
    const { f, teams } = await start(autonomy, setting, lineup);
    try {
      const created = await teams.create(f.create());
      const view = await settle(teams, created.id);
      return { view, record: recordOf(teams, created.id) };
    } finally { await f.close(); }
  };
  // A supervised project without the key, and an autonomous one with the off switch: no checker, no intent entry.
  for (const [autonomy, setting] of [["supervised", undefined], ["autonomous", "off"]] as const) {
    const { view, record } = await run(autonomy, setting);
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(checkers(view).length, 0, `${autonomy} ${setting ?? "default"}: a checker started`);
    assert.ok(texts(view).every(text => !text.includes(INTENT_EVENTS.held) && !text.includes("intent check")), `${autonomy} ${setting ?? "default"}`);
    assert.equal((record?.log ?? []).filter(entry => entry.op.startsWith("intent-check.")).length, 0);
  }
  // A supervised project with the key on and a lineup with no evaluator: the check skips and the plan is accepted.
  const skipped = await run("supervised", "on", mixedLineup);
  assert.equal(skipped.view.status, "ready-for-review", JSON.stringify(skipped.view.events.slice(-5)));
  assert.equal(checkers(skipped.view).length, 0);
  assert.ok(texts(skipped.view).includes(INTENT_EVENTS.skipped["no-eligible-profile"]), JSON.stringify(texts(skipped.view).slice(-5)));

  // A run created before the slice has no pin and never checks: its checker is dropped with the pin on disk, and the plan is accepted.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      await until(teams, created.id, view => checkers(view).length === 1);
      const restarted = await restartWith(f, teams, created.id, stored => {
        delete (stored.run as { intentCheck?: unknown }).intentCheck;
        delete stored.intentCheck;
        stored.run.members = stored.run.members.filter(member => member.role !== "intent-checker");
      });
      unflag(f, "intent-hold");
      const view = await settle(restarted, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      assert.equal(checkers(view).length, 0, "a restart after the pin was dropped started a checker");
      assert.equal((recordOf(restarted, created.id)?.log ?? []).filter(entry => entry.op.startsWith("intent-check.")).length, 0);
      assert.equal(texts(view).filter(text => text.startsWith("Project manager planned")).length, 1, "the plan was not accepted once");
    } finally { await f.close(); }
  }
});

test("a check with nothing to ask accepts the plan once", { timeout: 900000 }, async () => {
  const { f, teams } = await start("autonomous");
  try {
    const created = await teams.create(f.create());
    const view = await settle(teams, created.id);
    assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
    assert.equal(view.decisions.length, 0, "an empty check opened a decision");
    assert.equal(checkers(view).length, 1);
    assert.equal(texts(view).filter(text => text === INTENT_EVENTS.accepted).length, 1);
    const record = recordOf(teams, created.id);
    assert.equal(logOps(record, INTENT_OPS.applied).length, 1);
    assert.equal(record?.version, 2, "the applied entry is one version up");
    assert.equal(stored(teams, created.id).run.tasks.length, 2, "the first project manager's tasks are the run's tasks");
  } finally { await f.close(); }
});

test("acceptance 3: an outcome ask waits for the owner and the corrected plan is not checked again", { timeout: 900000 }, async () => {
  const { f, teams } = await start("autonomous");
  try {
    reportFile(f, askReport());
    const created = await teams.create(f.create());
    const waiting = await until(teams, created.id, view => view.status === "needs-input");
    assert.equal(checkers(waiting).length, 1);
    const decision = waiting.decisions.find(item => item.answeredBy === undefined)!;
    assert.equal(decision.memberId, checkers(waiting)[0].memberId);
    assert.ok(decision.question.includes("Which output name"), decision.question);
    const record = recordOf(teams, created.id)!;
    assert.equal(record.assumptions.find(item => item.id === "a1")?.status, "unchecked");
    assert.equal(record.questions.find(item => item.id === "q1")?.waits, true);
    assert.equal(record.assumptions.find(item => item.id === "a2")?.status, "assumed");

    await answerWith(teams, created.id, decision.id, waiting.revision, "alpha");
    const settled = await settle(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
    assert.equal(checkers(settled).length, 1, "the corrected plan started a second checker");
    assert.ok(texts(settled).some(text => text.includes(INTENT_EVENTS.answered)), "the answer's event is missing");
    const corrected = stored(teams, created.id).run.members.filter(member => member.role === "project-manager" && member.contextFeedback?.includes("alpha"));
    assert.equal(corrected.length, 1, "the corrected project manager does not carry the answer");
    const after = recordOf(teams, created.id);
    assert.equal(logOps(after, INTENT_OPS.applied).length, 1);
    assert.equal(logOps(after, INTENT_OPS.answered).length, 1);
  } finally { await f.close(); }
});

test("the check survives a restart in every state", { timeout: 2400000 }, async () => {
  // queued: the record holds the state hold saved before step prepares a checker. The checker member the restart drops is the one a
  // checking host would have held, so the record is rewritten to the queued state and the member removed (team-intent.ts holdNew).
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      const checking = await until(teams, created.id, view => checkers(view).length === 1);
      await waitFor(() => Promise.resolve(existsSync(join(f.receipts, `${checkers(checking)[0].memberId}.intent-context.json`))), ready => ready, 120000);
      const restarted = await restartWith(f, teams, created.id, stored => {
        stored.intentCheck = { ...stored.intentCheck!, status: "queued", failures: 0 };
        delete stored.intentCheck.checkerMemberId;
        stored.run.members = stored.run.members.filter(member => member.role !== "intent-checker");
      });
      unflag(f, "intent-hold");
      release(f, created.id, "intent-release");
      const settled = await settle(restarted, created.id);
      assertPlanAcceptedOnce(f, restarted, created.id, settled, 0);
      assert.equal(logOps(recordOf(restarted, created.id), INTENT_OPS.applied).length, 1);
    } finally { await f.close(); }
  }
  // checking: the checker is held by a flag; the host restarts; the checker is released.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      const checking = await until(teams, created.id, view => checkers(view).length === 1);
      const checkerId = checkers(checking)[0].memberId;
      await waitFor(() => Promise.resolve(existsSync(join(f.receipts, `${checkerId}.intent-context.json`))), ready => ready, 120000);
      assert.equal(teams.get(created.id).status, "planning", "a run whose plan is being checked shows planning");
      const restarted = await restartWith(f, teams, created.id);
      unflag(f, "intent-hold");
      release(f, created.id, "intent-release");
      const settled = await settle(restarted, created.id);
      assertPlanAcceptedOnce(f, restarted, created.id, settled, 0);
      assert.equal(logOps(recordOf(restarted, created.id), INTENT_OPS.applied).length, 1);
    } finally { await f.close(); }
  }
  // waiting: the decision stays open across the restart and is answered afterwards.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      await until(teams, created.id, view => view.status === "needs-input");
      const restarted = await restartWith(f, teams, created.id);
      const waiting = await until(restarted, created.id, view => view.status === "needs-input");
      const decision = waiting.decisions.find(item => item.answeredBy === undefined)!;
      assert.ok(decision, "the restart lost the open decision");
      await answerWith(restarted, created.id, decision.id, waiting.revision, "beta");
      const settled = await settle(restarted, created.id);
      assertPlanAcceptedOnce(f, restarted, created.id, settled, 1);
      assert.equal(logOps(recordOf(restarted, created.id), INTENT_OPS.answered).length, 1);
    } finally { await f.close(); }
  }
  // correcting: the owner answered, and the corrected project manager is held by the hold flag when the host stops.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      await until(teams, created.id, view => checkers(view).length === 1);
      release(f, created.id, "intent-release");
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      const decision = waiting.decisions.find(item => item.answeredBy === undefined)!;
      await answerWith(teams, created.id, decision.id, waiting.revision, "alpha");
      await until(teams, created.id, view => view.members.filter(member => member.role === "project-manager").length === 2);
      const restarted = await restartWith(f, teams, created.id);
      unflag(f, "intent-hold");
      release(f, created.id, "correct-release");
      const settled = await settle(restarted, created.id);
      assertPlanAcceptedOnce(f, restarted, created.id, settled, 1);
      assert.equal(logOps(recordOf(restarted, created.id), INTENT_OPS.answered).length, 1);
    } finally { await f.close(); }
  }
  // accepting: the checker's empty report is applied and the state is accepting. The host writes that state in complete() and
  // consumes the held plan on the next tick; the stop cannot be held there, so the record is rewritten to that state with the
  // same applyIntentReport call, the checker's report stored, and the held plan kept.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      const checking = await until(teams, created.id, view => checkers(view).length === 1);
      const checkerId = checkers(checking)[0].memberId;
      await waitFor(() => Promise.resolve(existsSync(join(f.receipts, `${checkerId}.intent-context.json`))), ready => ready, 120000);
      const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
      const restarted = await restartWith(f, teams, created.id, stored => {
        const checker = stored.run.members.find(member => member.role === "intent-checker")!;
        const plan = stored.run.members.find(member => member.memberId === stored.intentCheck!.planMemberId)!;
        const report = { kind: "intent-check" as const, summary: "No gap found.", items: [] };
        const applied = applyIntentReport(stored.objectiveRecord!, report, { runId: stored.run.id, revision: stored.run.revision,
          checkerMemberId: checker.memberId, decisionId: randomUUID(), mode: "autonomous", goal: false,
          configured: [...(project.team?.checks ?? [])], at: new Date().toISOString() });
        stored.objectiveRecord = applied.record;
        checker.status = "reported"; checker.report = report as never;
        stored.intentCheck = { revision: stored.run.revision, planMemberId: plan.memberId, status: "accepting", failures: 0, checkerMemberId: checker.memberId };
      });
      unflag(f, "intent-hold");
      const settled = await settle(restarted, created.id);
      assertPlanAcceptedOnce(f, restarted, created.id, settled, 0);
      assert.equal(logOps(recordOf(restarted, created.id), INTENT_OPS.applied).length, 1, "the check was applied twice");
    } finally { await f.close(); }
  }
});
test("steering, resume, and cancel meet the pending plan", { timeout: 1500000 }, async () => {
  // A steer while the checker runs: the new revision is checked once, and the old report is ignored.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      await until(teams, created.id, view => checkers(view).length === 1);
      const running = teams.get(created.id);
      await teams.steer(created.id, { requestId: randomUUID(), revision: running.revision, text: "Prefer the alpha names." });
      unflag(f, "intent-hold");
      release(f, created.id, "intent-release");
      const settled = await settle(teams, created.id);
      assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
      assert.equal(settled.revision, running.revision + 1);
      assert.equal(logOps(recordOf(teams, created.id), INTENT_OPS.applied).length, 1, "the old report was applied");
    } finally { await f.close(); }
  }
  // A steer while waiting: the question stops waiting, and the old decision answers 404.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      const old = waiting.decisions.find(item => item.answeredBy === undefined)!;
      await teams.steer(created.id, { requestId: randomUUID(), revision: waiting.revision, text: "Keep the names short." });
      // The release runs in the next tick, after the steer's revision exists.
      const steered = await until(teams, created.id, view => texts(view).includes(INTENT_EVENTS.released.replanned));
      await assert.rejects(() => Promise.resolve(answerWith(teams, created.id, old.id, steered.revision, "alpha")), (error: { code?: string }) => error.code === "decision-not-found");
      await teams.cancel(created.id, { requestId: randomUUID(), revision: steered.revision });
    } finally { await f.close(); }
  }
  // A cancel while waiting: the questions are released with the cancelled cause.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      await teams.cancel(created.id, { requestId: randomUUID(), revision: waiting.revision });
      const cancelled = await until(teams, created.id, view => view.status === "cancelled");
      assert.ok(texts(cancelled).includes(INTENT_EVENTS.released.cancelled), JSON.stringify(texts(cancelled).slice(-5)));
      assert.ok(cancelled.members.every(member => member.status !== "running"), "a member is still running after cancel");
    } finally { await f.close(); }
  }
  // A pause and a resume while waiting: a new revision, the waits released, and one check in the new revision.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      await teams.pause(created.id, { requestId: randomUUID(), revision: waiting.revision });
      await until(teams, created.id, view => view.status === "paused");
      // Resume waits while the paused members stop (`members-stopping`), so it is retried until they have.
      await waitFor(async () => {
        try { await teams.resume(created.id, { requestId: randomUUID(), revision: teams.get(created.id).revision }); return true; }
        catch (error) { if ((error as { code?: string }).code === "members-stopping") return false; throw error; }
      }, resumed => resumed, 300000);
      const resumed = await until(teams, created.id, view => texts(view).includes(INTENT_EVENTS.released.replanned) && view.status === "needs-input");
      assert.equal(resumed.revision, waiting.revision + 1, "the resume did not start a new revision");
      assert.equal(checkers(resumed).filter(member => member.revision === resumed.revision).length, 1, "one check in the new revision");
      await teams.cancel(created.id, { requestId: randomUUID(), revision: resumed.revision });
    } finally { await f.close(); }
  }
  // The owner's halt while waiting, an answer during the halt, then the release: the answer resolves in the same revision.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      const mark = { haltId: randomUUID(), reason: "Halted by the owner for this test." };
      await teams.haltPause(mark, () => true);
      const halted = await until(teams, created.id, view => view.status === "paused");
      const decision = halted.decisions.find(item => item.answeredBy === undefined)!;
      await answerWith(teams, created.id, decision.id, halted.revision, "alpha");
      await teams.haltResume(mark.haltId, () => undefined, false);
      const settled = await settle(teams, created.id);
      assert.equal(settled.revision, waiting.revision, "the answer during the halt changed the revision");
      assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
      assert.ok(texts(settled).some(text => text.includes(INTENT_EVENTS.answered)), "the answer did not resolve");
      assert.equal(logOps(recordOf(teams, created.id), INTENT_OPS.answered).length, 1);
    } finally { await f.close(); }
  }
});

test("a failed checker is replaced once and then skipped", { timeout: 1500000 }, async () => {
  // No report: the checker exits twice, so the held plan is accepted unchecked.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-silent");
      const created = await teams.create(f.create());
      const view = await settle(teams, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      assert.equal(checkers(view).length, 2, "the failed checker was not replaced once");
      assert.ok(texts(view).includes(INTENT_EVENTS.skipped["checker-failed"]), JSON.stringify(texts(view).slice(-5)));
      assert.equal(logOps(recordOf(teams, created.id), INTENT_OPS.skipped).length, 1);
    } finally { await f.close(); }
  }
  // A plan report from each checker is not a check: no second project manager starts.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-plan");
      const created = await teams.create(f.create());
      const view = await settle(teams, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      assert.equal(checkers(view).length, 2);
      assert.equal(view.members.filter(member => member.role === "project-manager").length, 1, "a plan report started a project manager");
    } finally { await f.close(); }
  }
  // A stall: each held checker's session reports its last activity past the stall window, so the stall path stops it.
  {
    const quiet = new Set<string>();
    const f = await fixture("intent", CHECKED_LINEUP, {}, { noServer: true });
    f.host.config.projects.find(item => item.id === "rehearsal")!.autonomy = "autonomous";
    const window = (f.host.config.teams?.stallMinutes ?? 30) * 60000;
    const teams = await f.openTeamService({ manager: manager => {
      const state = manager.state.bind(manager);
      manager.state = async (id: string, screen?: boolean) => {
        const value = await state(id, screen);
        return quiet.has(id) ? { ...value, attention: { ...value.attention, lastActivityAt: new Date(Date.now() - window - 60000).toISOString() } } : value;
      };
    } });
    try {
      flag(f, "intent-hold");
      const created = await teams.create(f.create());
      for (const count of [1, 2]) {
        const view = await until(teams, created.id, next => checkers(next).length === count && checkers(next).at(-1)!.status === "running");
        quiet.add(checkers(view).at(-1)!.sessionId);
      }
      const view = await settle(teams, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      assert.equal(checkers(view).length, 2, "the stalled checker was not replaced once");
      assert.ok(checkers(view).every(member => member.stalledAt), "each checker left through the stall path");
      assert.ok(texts(view).includes(INTENT_EVENTS.skipped["checker-failed"]), JSON.stringify(texts(view).slice(-5)));
      assert.equal(texts(view).filter(text => text.startsWith("Project manager planned")).length, 1, "one plan accepted");
    } finally { unflag(f, "intent-hold"); await f.close(); }
  }
});

test("a cancel cut releases a waiting objective intent once on retry", async () => {
  const f = schedulerFixture();
  try {
    const at = new Date().toISOString(), decisionId = randomUUID(), checkerMemberId = randomUUID();
    f.run.status = "needs-input"; f.run.autonomy = "autonomous"; f.run.intentCheck = "on"; f.run.members[0]!.status = "waiting";
    const initial = runRecord(f.run, at, "record-created");
    if (initial === "source-invalid") assert.fail("the fixture's objective must build a run record");
    const applied = applyIntentReport(initial, { kind: "intent-check", summary: "One owner choice remains.", items: [{
      dimension: "outcome", why: "The output name affects the result.", criticality: "outcome", disposition: "ask",
      assumption: { statement: "The default name is accepted.", refutedBy: "The owner chooses another name.", test: { kind: "owner" } },
      question: { text: "Which output name should the files use?", options: ["alpha", "beta"], interrupt: "definition" },
    }] } as IntentCheckReport, { runId: f.run.id, revision: f.run.revision, checkerMemberId, decisionId, mode: "autonomous", goal: false, configured: [], at });
    assert.ok(applied.decision, "the objective intent should wait on an owner answer");
    assert.equal(applied.record.questions[0]?.waits, true);
    f.run.decisions = [{ id: decisionId, memberId: checkerMemberId, revision: f.run.revision, question: applied.decision.question,
      options: applied.decision.options, createdAt: at, intentQuestions: applied.decision.questions }];
    f.writeTeam({ objectiveRecord: applied.record, intentCheck: { revision: f.run.revision, planMemberId: f.run.members[0]!.memberId,
      status: "waiting", failures: 0, decisionId } });

    const teams = f.openTeam(), request = { requestId: randomUUID(), revision: f.run.revision };
    const service = teams as unknown as { save(stored: { run: TeamRun; receipts: Record<string, string> }): void };
    const save = service.save.bind(teams);
    let cut = false;
    service.save = stored => {
      save(stored);
      if (!cut && stored.run.status === "cancelled" && stored.receipts[request.requestId]) {
        cut = true;
        throw new Error("Simulated host stop after the first cancel write.");
      }
    };
    await assert.rejects(teams.cancel(f.run.id, request), /Simulated host stop after the first cancel write/);
    assert.equal(cut, true, "the cancel did not reach its first durable write");

    teams.close();
    const restarted = f.openTeam();
    const durable = f.readRecord<{ run: TeamRun; receipts: Record<string, string>; objectiveRecord: ObjectiveRecord }>("team", f.run.id);
    const questionId = applied.decision.questions[0]!;
    assert.equal(durable.run.status, "cancelled");
    assert.equal(durable.receipts[request.requestId] !== undefined, true);
    assert.equal(durable.run.reason, "Stopping active team members; any human input lease remains authoritative.");
    assert.equal(durable.run.events.filter(event => event.text === "Team cancelled.").length, 1);
    assert.equal(durable.objectiveRecord.questions.find(question => question.id === questionId)?.waits, false);
    assert.equal(durable.objectiveRecord.log.filter(entry => entry.op === INTENT_OPS.released).length, 1);

    assert.equal((await restarted.cancel(f.run.id, request)).status, "cancelled");
    const retried = f.readRecord<{ objectiveRecord: ObjectiveRecord }>("team", f.run.id).objectiveRecord;
    assert.equal(retried.questions.find(question => question.id === questionId)?.waits, false);
    assert.equal(retried.log.filter(entry => entry.op === INTENT_OPS.released).length, 1);
  } finally { f.close(); }
});

test("cancel and steer on a full log complete", { timeout: 1500000 }, async () => {
  // Fills the sealed record's log on disk to its share, so every intent write after the restart fails.
  const fillLog = (stored: SealedRun) => {
    const record = stored.objectiveRecord!;
    const template = record.log.find(entry => entry.op === INTENT_OPS.applied) ?? record.log[0];
    while (record.log.length < 380) record.log.push({ ...template, seq: record.log.length + 1 });
  };
  // A cancel while the run waits on a full log: the release fails once, and the cancel still ends the run.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      const restarted = await restartWith(f, teams, created.id, fillLog);
      await restarted.cancel(created.id, { requestId: randomUUID(), revision: waiting.revision });
      const cancelled = await until(restarted, created.id, view => view.status === "cancelled" && view.members.every(member => !["running", "queued"].includes(member.status)));
      assert.equal(texts(cancelled).filter(text => text === INTENT_EVENTS.releaseUnrecorded).length, 1, JSON.stringify(texts(cancelled).slice(-5)));
    } finally { await f.close(); }
  }
  // A steer on a full log: the new revision starts, its check is skipped with log-full, and its plan is accepted.
  {
    const { f, teams } = await start("autonomous");
    try {
      reportFile(f, askReport());
      const created = await teams.create(f.create());
      const waiting = await until(teams, created.id, view => view.status === "needs-input");
      const restarted = await restartWith(f, teams, created.id, fillLog);
      await restarted.steer(created.id, { requestId: randomUUID(), revision: waiting.revision, text: "Keep the names short." });
      const settled = await settle(restarted, created.id);
      assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
      assert.equal(settled.revision, waiting.revision + 1, "the steer did not start a new revision");
      assert.ok(texts(settled).includes(INTENT_EVENTS.skipped["log-full"]), JSON.stringify(texts(settled).slice(-5)));
      assert.equal(checkers(settled).filter(member => member.revision === settled.revision).length, 0, "a checker ran on a full log");
      assert.ok(texts(settled).some(text => text.startsWith("Project manager planned")), "the plan was not accepted");
    } finally { await f.close(); }
  }
});
test("the checker is read-only and owns nothing", { timeout: 1500000 }, async () => {
  // A secret-shaped item is dropped, and the checker's context and prompt carry no run data. The blackboard tools are on, so
  // the checks on entries and entry tools would see a leak.
  {
    const { f, teams, store, entries } = await start("autonomous", undefined, CHECKED_LINEUP, true);
    try {
      reportFile(f, { kind: "intent-check", summary: "No question.", items: [
        { dimension: "detail", why: "A token-shaped string appears in the plan.", criticality: "detail", disposition: "assume",
          assumption: { statement: `Use the token ${SECRET} for the push.`, refutedBy: "The token is absent.", test: { kind: "owner" } } },
        { dimension: "detail", why: "The output shape is plain.", criticality: "detail", disposition: "assume",
          assumption: { statement: "The output has two files.", refutedBy: "The output has one file.", test: { kind: "owner" } } },
      ] });
      const created = await teams.create(f.create());
      const view = await settle(teams, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      const checker = checkers(view)[0];
      assert.ok(checker, "no checker ran");
      const context = readFileSync(join(f.receipts, `${checker.memberId}.intent-context.json`));
      const prompt = readFileSync(join(f.receipts, `${checker.memberId}.intent-prompt.txt`));
      assert.ok(!context.includes('"agentProfileId"'), "the context names a routing profile");
      assert.equal(JSON.parse(context).log, undefined, "the context carries the record's log");
      assert.equal(JSON.parse(context).entries, undefined, "the context carries blackboard entries");
      assert.ok(!prompt.includes(OBJECTIVE), "the prompt carries the objective");
      assert.ok(!context.includes(SECRET) && !prompt.includes(SECRET), "a secret reached the checker's files");
      const run = stored(teams, created.id).run;
      assert.ok(run.members.some(member => member.role === "project-manager" && member.entryTools === true), "the project manager has no entry tools");
      assert.equal(run.members.find(member => member.memberId === checker.memberId)?.entryTools, undefined);
      const posted = entries!.list(created.id).entries.map(head => entries!.get(created.id, head.entryId));
      assert.ok(!JSON.stringify(posted).includes(SECRET), "the secret-shaped item reached a blackboard entry");
      assert.ok(!JSON.stringify(run).includes(SECRET), "the secret-shaped item reached the stored run");
      assert.ok(!JSON.stringify(recordOf(teams, created.id)).includes(SECRET), "the secret-shaped item reached the record");
      assert.equal(logOps(recordOf(teams, created.id), INTENT_OPS.applied).length, 1);
    } finally { store?.close(); await f.close(); }
  }
  // An edit by the read-only checker counts as a failure, twice, so the plan is accepted unchecked.
  {
    const { f, teams } = await start("autonomous");
    try {
      flag(f, "intent-edit");
      const created = await teams.create(f.create());
      const view = await settle(teams, created.id);
      assert.equal(view.status, "ready-for-review", JSON.stringify(view.events.slice(-5)));
      assert.ok(texts(view).includes(INTENT_EVENTS.skipped["checker-failed"]), JSON.stringify(texts(view).slice(-5)));
    } finally { await f.close(); }
  }
});

