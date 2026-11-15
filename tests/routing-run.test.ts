import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, mixedLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { routingModule, taskDecisions } from "../packages/host/src/routing-store.js";
import type { TeamView } from "../packages/host/src/team-types.js";

const TERMINAL = ["ready-for-review", "merged", "blocked", "cancelled"];
const UNAVAILABLE_LOG = "Routing shadow decision skipped: the evidence store is unavailable.";

/** The store the recorder writes to: the same modules the server registers before the team service starts. */
function openStore(databasePath: string, key: Buffer): EvidenceStore {
  const store = new EvidenceStore({ databasePath, vaultKey: key });
  store.register(configurationModule());
  store.register(outcomeModule());
  store.register(routingModule());
  return store;
}

const decisionCount = (store: EvidenceStore): number => store.read(db => routingModule().counts!(db).decisions);
const decisionsOf = (store: EvidenceStore, runId: string, taskId: string) => store.read(db => taskDecisions(db, runId, taskId));

/** The task's rows, one per revision: the mixed fixture runs revisions 2 and 3, and the spec writes one row per revision. */
function rowsPerRevision(store: EvidenceStore, runId: string, taskId: string) {
  const rows = decisionsOf(store, runId, taskId).rows;
  assert.equal(new Set(rows.map(row => row.revision)).size, rows.length, `task ${taskId} has two rows for one revision`);
  return rows;
}

/** Waits until no member is still queued or running, so a member's process has closed before teardown. */
async function membersClosed(teams: { get(id: string): TeamView }, id: string): Promise<TeamView> {
  return waitFor(() => Promise.resolve(teams.get(id)), view => view.members.every(member => member.status !== "queued" && member.status !== "running"), 60000);
}

/**
 * Runs the team to a terminal status. The mixed scenario's implementer of task b asks the owner one question, so each
 * open decision is answered with its first option as it appears.
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

/** A mixed lineup run in the given mode, with a recorder attached to the team service. */
async function mixedRun(autonomy: "autonomous" | "supervised", blockDatabase = false) {
  const f = await fixture("mixed", mixedLineup, {}, { noServer: true });
  const key = readFileSync(f.host.config.keyFile);
  const databasePath = evidenceDatabasePath(f.host.config.stateDir);
  // A regular file where the database should be: the store cannot open, and its modules read unavailable.
  if (blockDatabase) { mkdirSync(dirname(databasePath), { recursive: true }); writeFileSync(databasePath, "not a database"); }
  const store = openStore(databasePath, key);
  f.host.config.projects.find(project => project.id === "rehearsal")!.autonomy = autonomy;
  const logs: string[] = [];
  const teams = await f.openTeamService();
  teams.useRouter(new RoutingRecorder({ store, log: line => logs.push(line) }));
  return { f, store, teams, logs };
}

test("a shadow run records each first implementer and runs the coordinator's profiles", { timeout: 240000 }, async () => {
  const { f, store, teams } = await mixedRun("autonomous");
  try {
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    const view = await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
    assert.equal(view.routing?.mode, "shadow");
    const rowA = rowsPerRevision(store, created.id, "a"), rowB = rowsPerRevision(store, created.id, "b");
    assert.ok(rowA.length >= 1 && rowB.length >= 1);
    assert.equal(decisionCount(store), rowA.length + rowB.length);
    for (const row of rowA) { assert.equal(row.coordinatorProfileId, "spark-high"); assert.equal(row.chosenProfileId, "astra-xhigh"); }
    for (const row of rowB) { assert.equal(row.coordinatorProfileId, "astra-xhigh"); assert.equal(row.chosenProfileId, "astra-xhigh"); }

    // The members run on the coordinator's profiles, never on the router's pick.
    const profilesOf = (taskId: string) => view.members.filter(member => member.role === "implementer" && member.taskId === taskId).map(member => member.modelProfile?.id);
    assert.ok(profilesOf("a").length >= 1 && profilesOf("a").every(id => id === "spark-high"), JSON.stringify(profilesOf("a")));
    assert.ok(profilesOf("b").length >= 1 && profilesOf("b").every(id => id === "astra-xhigh"), JSON.stringify(profilesOf("b")));

    // No routing value reaches a member's prompt.
    for (const member of view.members) {
      assert.ok(!member.prompt?.includes('"routing":'), `${member.role} prompt carries routing`);
      for (const row of [...rowA, ...rowB]) {
        assert.ok(!member.prompt?.includes(row.key), `${member.role} prompt carries a decision key`);
        assert.ok(!member.prompt?.includes(row.policyDigest), `${member.role} prompt carries the policy digest`);
        assert.ok(!member.prompt?.includes(row.seed), `${member.role} prompt carries a seed`);
      }
    }
  } finally {
    store.close();
    await f.close();
  }
});

test("an off run pins nothing and writes nothing", { timeout: 240000 }, async () => {
  const { f, store, teams } = await mixedRun("supervised");
  try {
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    const view = await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
    assert.equal("routing" in settled, false, "an off run carries no routing key");
    assert.equal(decisionCount(store), 0);
    // The members run on the profiles the plan names, as the shadow run does.
    const profileOf = (taskId: string) => view.members.find(member => member.role === "implementer" && member.taskId === taskId)?.modelProfile?.id;
    assert.equal(profileOf("a"), "spark-high");
    assert.equal(profileOf("b"), "astra-xhigh");
  } finally {
    store.close();
    await f.close();
  }
});

test("with the store unavailable the run continues", { timeout: 240000 }, async () => {
  const { f, store, teams, logs } = await mixedRun("autonomous", true);
  try {
    assert.equal(store.status().modules.routing === "ready", false);
    const created = await teams.create(f.create());
    const settled = await settleAnswering(teams, created.id);
    const view = await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
    assert.equal(view.members.find(member => member.role === "implementer" && member.taskId === "a")?.modelProfile?.id, "spark-high");
    assert.equal(view.members.find(member => member.role === "implementer" && member.taskId === "b")?.modelProfile?.id, "astra-xhigh");
    assert.deepEqual(logs, [UNAVAILABLE_LOG]);
  } finally {
    store.close();
    await f.close();
  }
});

test("a project manager replacement records no decision", { timeout: 240000 }, async () => {
  // The mixed scenario's project manager asks the owner a question at its second revision, and the answer replaces the
  // manager through the answer path. Only the manager is replaced here: the limit scenario replaces an implementer, but
  // it switches members only through the hook server, which this no-server fixture lacks, and the stall-slow-stop
  // scenario needs a multi-minute stall window and no lineup profiles. So no implementer replacement is covered.
  const { f, store, teams } = await mixedRun("autonomous");
  try {
    const created = await teams.create(f.create());
    const asked = await waitFor(() => Promise.resolve(teams.get(created.id)), view => view.status === "needs-input" && view.decisions.length === 1, 120000);
    const before = { a: decisionsOf(store, created.id, "a").rows, b: decisionsOf(store, created.id, "b").rows };
    await Promise.resolve(teams.answer(asked.id, asked.decisions[0].id, { requestId: randomUUID(), revision: asked.revision, text: asked.decisions[0].options[0] }));
    const replaced = await waitFor(() => Promise.resolve(teams.get(created.id)), view => view.members.filter(member => member.role === "project-manager").length >= 2, 120000);
    const settled = await settleAnswering(teams, created.id);
    await membersClosed(teams, created.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled.events.slice(-5)));
    assert.ok(replaced.members.filter(member => member.role === "project-manager").length >= 2);
    // Each task keeps one row per revision, and every row written before the replacement is unchanged by it.
    for (const [taskId, earlier] of [["a", before.a], ["b", before.b]] as const) {
      const final = rowsPerRevision(store, created.id, taskId);
      for (const row of earlier) assert.deepEqual(final.find(item => item.key === row.key), row, `task ${taskId}'s row changed after the replacement`);
    }
  } finally {
    store.close();
    await f.close();
  }
});
