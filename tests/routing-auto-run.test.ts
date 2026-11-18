import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, mixedLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { markPeriodEnded, registerRouting, routingModule, taskDecisions } from "../packages/host/src/routing-store.js";
import type { RoutingPoint } from "../packages/host/src/routing-types.js";
import { teamContext } from "../packages/host/src/team-prompts.js";
import { PROFILE_REQUIRED_REFUSAL, type TeamLineup, type TeamMember, type TeamRun, type TeamView } from "../packages/host/src/team-types.js";

const TERMINAL = ["ready-for-review", "merged", "blocked", "cancelled"];
const SONNET_ESCALATION = { id: "sonnet-escalation", label: "Sonnet escalation", provider: "claude" as const, model: "claude-sonnet-5-5", effort: "high", tier: "strong" as const };
const REVOKED_LINE = "Host profile routing was revoked by the owner; new tasks start on the coordinator's pick when it passes the fixed rules, else on the first implementer that passes them.";
const POOL_SENTENCE = "Every task MUST include agentProfileId from this approved worker pool: ";
const AUTO_SENTENCE = "The host assigns each plan task's worker profile; omit agentProfileId from plan tasks.";

/** The stored run, prompts included: the team view strips them. */
const storedRun = (teams: unknown, id: string): TeamRun => (teams as { record(id: string): { run: TeamRun } }).record(id).run;

/** The task's rows at one point, one per revision. The mixed flow plans at revisions 2 and 3, and each start writes one row. */
function rowsOf(store: EvidenceStore, runId: string, taskId: string, point: RoutingPoint = "start") {
  const rows = store.read(db => taskDecisions(db, runId, taskId)).rows.filter(row => row.point === point);
  assert.equal(new Set(rows.map(row => row.revision)).size, rows.length, `task ${taskId} has two rows for one revision`);
  return rows;
}

/** Waits until no member is still queued or running, so a member's process has closed before teardown. */
async function membersClosed(teams: { get(id: string): TeamView }, id: string): Promise<TeamView> {
  return waitFor(() => Promise.resolve(teams.get(id)), view => view.members.every(member => member.status !== "queued" && member.status !== "running"), 60000);
}

/**
 * Runs the team to a terminal status. In the mixed scenario, task b's implementer question blocks the run, and the
 * revision-2 project manager asks the owner one question, so each open decision is answered with its first option as it appears.
 */
async function settleAnswering(teams: { get(id: string): TeamView; answer(id: string, decisionId: string, input: unknown): unknown }, id: string): Promise<TeamView> {
  return waitFor(async () => {
    const view = teams.get(id);
    const open = view.decisions.find(decision => decision.answeredBy === undefined);
    if (open && view.status === "needs-input")
      await Promise.resolve(teams.answer(id, open.id, { requestId: randomUUID(), revision: view.revision, text: open.options[0] })).catch(() => {});
    return teams.get(id);
  }, view => TERMINAL.includes(view.status), 180000);
}

/**
 * A mixed run in an autonomous project whose period has ended, so the router pins `auto`. The store is the one the server
 * registers: the configuration and outcome projectors, then the routing module and its projector, on one outbox.
 * `planWithoutProfiles` writes the fixture's marker, so the project manager's plan omits every agentProfileId.
 * `points` sets the project's routing points, and `escalations` the lineup's escalation profiles, when given.
 */
async function autoRun(planWithoutProfiles: boolean, points?: RoutingPoint[], escalations?: TeamLineup["escalations"]) {
  // The evaluator lets the autonomous project pin its run autonomous (C14); the intent check stays off, as in routing-run.
  const lineup: TeamLineup = { ...mixedLineup, evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }], ...(escalations ? { escalations } : {}) };
  const f = await fixture("mixed", lineup, {}, { noServer: true });
  if (planWithoutProfiles) writeFileSync(join(f.receipts, "plan-no-profiles"), "");
  const key = readFileSync(f.host.config.keyFile);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: key });
  const outbox = new EventOutbox(store);
  store.register(configurationModule());
  outbox.registerProjector(configurationProjector());
  store.register(outcomeModule());
  registerRouting(store, outbox);
  outbox.registerProjector(outcomeProjector(store));
  // The period end is stored before the run is created, so its pin is `auto` from the start.
  assert.ok(store.tryWrite(tx => { markPeriodEnded(tx, "rehearsal", "2026-11-01T00:00:00.000Z", "2026-11-16T00:00:00.000Z"); }), "the period end could not be stored");
  const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
  project.autonomy = "autonomous";
  project.team = { ...project.team!, routing: { mode: "auto", ...(points ? { points } : {}) }, objective: { intentCheck: "off" } };
  const teams = await f.openTeamService({ events: outbox });
  teams.useRouter(new RoutingRecorder({ store }));
  return { f, store, teams };
}

test("an auto run accepts a plan without profiles and starts the router's choice", { timeout: 240000 }, async () => {
  const { f, store, teams } = await autoRun(true);
  try {
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    const view = await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));

    const run = storedRun(teams, created.id);
    assert.equal(run.routing?.mode, "auto");
    const implementers = run.members.filter(member => member.role === "implementer");
    assert.ok(implementers.length >= 2, "both tasks' implementers are stored");

    // Each task has one applied row per revision, bound to that revision's first implementer.
    for (const taskId of ["a", "b"]) {
      const rows = rowsOf(store, created.id, taskId);
      assert.ok(rows.length >= 1, `task ${taskId} has no routing row`);
      for (const row of rows) {
        assert.equal(row.mode, "auto");
        assert.equal(row.state, "applied");
        const first = implementers.find(member => member.taskId === taskId && member.revision === row.revision);
        assert.equal(row.memberId, first?.memberId, `task ${taskId} revision ${row.revision} row is not bound to its first implementer`);
      }
      assert.deepEqual(view.tasks.find(task => task.id === taskId)?.routing, { profileId: "astra-xhigh", by: "router" });
      assert.deepEqual(run.tasks.find(task => task.id === taskId)?.routing, { profileId: "astra-xhigh", by: "router" });
    }
    for (const member of implementers) assert.equal(member.modelProfile?.id, "astra-xhigh");

    // The project manager is told the host assigns the profiles, and no member sees a routing value.
    const managerPrompts = run.members.filter(member => member.role === "project-manager").map(member => member.prompt ?? "");
    assert.ok(managerPrompts.length >= 2, "the mixed flow plans at two revisions");
    for (const prompt of managerPrompts) {
      assert.ok(prompt.includes(AUTO_SENTENCE), "the project manager is not told the host assigns profiles");
      assert.ok(!prompt.includes(POOL_SENTENCE), "the project manager sees the pool sentence of a non-auto run");
    }
    const rows = [...rowsOf(store, created.id, "a"), ...rowsOf(store, created.id, "b")];
    for (const member of run.members) {
      const prompt = member.prompt ?? "";
      assert.ok(!prompt.includes('"routing":'), `${member.role} prompt carries routing`);
      assert.ok(!prompt.includes(run.routing!.digest), `${member.role} prompt carries the policy digest`);
      for (const row of rows) {
        assert.ok(!prompt.includes(row.key), `${member.role} prompt carries a decision key`);
        assert.ok(!prompt.includes(row.seed), `${member.role} prompt carries a seed`);
      }
    }
    for (const role of ["project-manager", "implementer", "reviewer"] as TeamMember["role"][])
      assert.ok(!JSON.stringify(teamContext(run, undefined, undefined, role)).includes('"routing":'), `the ${role} context carries routing`);
  } finally {
    await f.close();
    store.close();
  }
});

test("with the store closed an auto run starts fallback profiles and continues", { timeout: 240000 }, async () => {
  const { f, store, teams } = await autoRun(false);
  try {
    const created = await teams.create(f.create());
    // The plan arrives later, from the coordinator's own process, so the store is already closed when each start decides.
    store.close();
    const settled = await settleAnswering(teams, created.id);
    await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));

    const run = storedRun(teams, created.id);
    const implementers = run.members.filter(member => member.role === "implementer");
    for (const member of implementers) assert.equal(member.modelProfile?.id, "astra-xhigh");
    for (const taskId of ["a", "b"]) {
      assert.equal(run.tasks.find(task => task.id === taskId)?.routing?.by, "fallback");
      const line = `Host routing could not choose a profile for task ${taskId}; it is assigned Astra implementer.`;
      const revisions = new Set(implementers.filter(member => member.taskId === taskId).map(member => member.revision));
      assert.equal(run.events.filter(event => event.text === line).length, revisions.size, `the fallback line for task ${taskId} is not once per revision`);
    }
  } finally {
    await f.close();
  }
});

test("revoking routing returns new tasks to the coordinator's profiles", { timeout: 240000 }, async () => {
  const { f, store, teams } = await autoRun(false);
  try {
    const created = await teams.create(f.create());
    await teams.revokeRouting(created.id, { requestId: randomUUID(), revision: teams.get(created.id).revision });
    const settled = await settleAnswering(teams, created.id);
    await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));

    const run = storedRun(teams, created.id);
    const implementers = run.members.filter(member => member.role === "implementer");
    // Task a's pick, spark-high, fails rule 1 and task b's pick passes: both run the fixed-rule fallback, astra-xhigh.
    for (const member of implementers) assert.equal(member.modelProfile?.id, "astra-xhigh");
    assert.equal(rowsOf(store, created.id, "a").length, 0, "task a has a routing row after revoke");
    assert.equal(rowsOf(store, created.id, "b").length, 0, "task b has a routing row after revoke");
    assert.ok(run.events.some(event => event.text === REVOKED_LINE), "the run has no revoke line");

    const astra = run.lineup!.implementers.find(profile => profile.id === "astra-xhigh")!;
    const revisionTwo = run.members.find(member => member.role === "project-manager" && member.revision === 2);
    assert.ok(revisionTwo?.prompt, "the revision-2 project manager has no prompt");
    assert.ok(revisionTwo.prompt.includes(`${POOL_SENTENCE}${JSON.stringify([astra])}`), "the revision-2 prompt does not list only astra-xhigh");
  } finally {
    await f.close();
    store.close();
  }
});

test("an auto run routes its scouts and its escalation, and no member sees a routing value", { timeout: 240000 }, async () => {
  const { f, store, teams } = await autoRun(true, ["start", "escalation", "scout"], [SONNET_ESCALATION]);
  try {
    // The project manager explores once before it plans, and task a's first implementer escalates without naming a profile.
    writeFileSync(join(f.receipts, "explore-unnamed"), "");
    writeFileSync(join(f.receipts, "escalate-unnamed"), "");
    writeFileSync(join(f.receipts, "escalate-to"), "sonnet-escalation");
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));

    const run = storedRun(teams, created.id);
    const scout = run.members.find(member => member.role === "scout");
    assert.ok(scout, "no scout member was launched");
    assert.equal(scout.modelProfile?.id, "astra-xhigh", "the scout did not start on the router's choice");
    const escalated = run.members.find(member => member.role === "implementer" && member.taskId === "a" && member.prompt?.includes("The previous implementer requested escalation"));
    assert.ok(escalated, "task a did not start its escalated member");
    assert.equal(escalated.modelProfile?.id, "sonnet-escalation");
    // Task a is planned again at later revisions, so its escalation is read from the run line of its escalation.
    assert.ok(run.events.some(event => event.text.includes("escalated to Sonnet escalation;")), "task a has no escalation run line");

    // The scout and the escalation each have one applied row, bound to the member that started on the chosen profile.
    const [scoutRow] = rowsOf(store, created.id, "s1", "scout");
    assert.ok(scoutRow, "the scout has no routing row");
    assert.equal(scoutRow.state, "applied");
    assert.equal(scoutRow.memberId, scout.memberId, "the scout row is not bound to the scout member");
    const [escalationRow] = rowsOf(store, created.id, "a", "escalation");
    assert.ok(escalationRow, "the escalation has no routing row");
    assert.equal(escalationRow.state, "applied");
    assert.equal(escalationRow.memberId, escalated.memberId, "the escalation row is not bound to the escalated member");

    // Each task's first start row is applied to that revision's first implementer.
    const implementers = run.members.filter(member => member.role === "implementer");
    for (const taskId of ["a", "b"]) {
      for (const row of rowsOf(store, created.id, taskId)) {
        assert.equal(row.state, "applied");
        const first = implementers.find(member => member.taskId === taskId && member.revision === row.revision && !member.prompt?.includes("requested escalation"));
        assert.equal(row.memberId, first?.memberId, `task ${taskId} revision ${row.revision} start row is not bound to its first implementer`);
      }
    }

    // The coordinator is told the host assigns scout profiles, and the first implementer is told the host selects the escalation.
    const coordinator = run.members.find(member => member.role === "project-manager");
    assert.ok(coordinator?.prompt?.includes("The host assigns each scout's profile; omit agentProfileId from scouts."), "the coordinator is not told the host assigns scout profiles");
    const firstA = implementers.find(member => member.taskId === "a" && !member.prompt?.includes("requested escalation"));
    assert.ok(firstA?.prompt?.includes("The host selects the stronger profile."), "the first implementer is not told the host selects its escalation");

    // No member prompt or context carries a routing value.
    const rows = [...rowsOf(store, created.id, "a"), ...rowsOf(store, created.id, "b"), ...rowsOf(store, created.id, "a", "escalation"), scoutRow];
    for (const member of run.members) {
      const prompt = member.prompt ?? "";
      assert.ok(!prompt.includes('"routing":'), `${member.role} prompt carries routing`);
      assert.ok(!prompt.includes(run.routing!.digest), `${member.role} prompt carries the policy digest`);
      for (const row of rows) {
        assert.ok(!prompt.includes(row.key), `${member.role} prompt carries a decision key`);
        assert.ok(!prompt.includes(row.seed), `${member.role} prompt carries a seed`);
      }
    }
    for (const role of ["project-manager", "implementer", "reviewer"] as TeamMember["role"][])
      assert.ok(!JSON.stringify(teamContext(run, undefined, undefined, role)).includes('"routing":'), `the ${role} context carries routing`);
  } finally {
    await f.close();
    store.close();
  }
});

test("an off run refuses a report without a profile, and the member corrects it", { timeout: 240000 }, async () => {
  // An off project: no routing, so the plan names its profiles and the escalation is the worker's to name.
  const f = await fixture("mixed", { ...mixedLineup, escalations: [SONNET_ESCALATION] }, {}, { noServer: true });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) });
  store.register(configurationModule());
  store.register(outcomeModule());
  store.register(routingModule());
  try {
    writeFileSync(join(f.receipts, "escalate-unnamed"), "");
    writeFileSync(join(f.receipts, "escalate-to"), "sonnet-escalation");
    const teams = await f.openTeamService();
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));

    const run = storedRun(teams, created.id);
    const first = run.members.find(member => member.role === "implementer" && member.taskId === "a");
    assert.ok(first, "task a has no implementer");
    const rejection = readFileSync(join(f.receipts, `${first.memberId}.rejection.txt`), "utf8");
    assert.ok(rejection.includes(PROFILE_REQUIRED_REFUSAL), "the refused report does not carry the profile refusal");
    const escalated = run.members.find(member => member.role === "implementer" && member.taskId === "a" && member.prompt?.includes("requested escalation"));
    assert.equal(escalated?.modelProfile?.id, "sonnet-escalation", "task a did not escalate after the correction");
    assert.ok(run.events.some(event => event.text.includes("escalated to Sonnet escalation;")), "task a has no escalation run line");
    assert.equal(store.read(db => taskDecisions(db, created.id, "a")).rows.length, 0, "an off run wrote a routing row");
  } finally {
    await f.close();
    store.close();
  }
});
