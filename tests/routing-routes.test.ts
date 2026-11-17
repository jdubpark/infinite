import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule, writeOutcome, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { pinRouting, ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { routingRoutes } from "../packages/host/src/routing-routes.js";
import { decisionKey, insertDecision, routingModule } from "../packages/host/src/routing-store.js";
import type { DecisionRow, RoutingPayload, RoutingStatus } from "../packages/host/src/routing-types.js";
import type { TeamLineup, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { mixedLineup } from "./team-fixture.js";
import { startHost, type Host } from "./helpers.js";
import { fixture as teamFixture } from "./team-fixture.js";

const NOW = new Date().toISOString();
const ASTRA = mixedLineup.implementers[1]!;
// C14: an autonomous lineup is ready only with an evaluator of another family than the coordinator's.
const READY_LINEUP: TeamLineup = { ...mixedLineup, evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }] };

/** Serves the routes from an in-process app whose guard passes everyone, so the config function is the test's own. */
async function serve(store: EvidenceStore, config: Config): Promise<{ get: (path: string) => Promise<Response>; close: () => Promise<void> }> {
  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  routingRoutes(app, { evidence: store, config: () => config, teams: { revokeRouting: async () => ({}) } }, pass, pass);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { get: path => fetch(`http://127.0.0.1:${port}${path}`), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** A counted astra implementer row of the default point, under a stored configuration. */
function countedRow(id: string, configId: string): OutcomeRow {
  return { outcomeId: `${id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: id, revision: 1, memberId: "m1", sessionId: null, attemptIndex: 1,
    inherited: false, role: "implementer", profileId: ASTRA.id, provider: "codex", model: ASTRA.model, effort: "xhigh", profileEpoch: 1, configId, experimentRef: null, kind: null,
    risk: "normal", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [], integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: 1,
    startedAt: NOW, endedAt: NOW, frozenAt: NOW, holdUntil: null, runDeletedAt: null,
    payload: { projectId: "rehearsal", taskId: "task-x", area: "other/", featureMap: "default", rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" } };
}

/** One stored start decision of a run's task, written while the host's API is stopped. */
function seedDecision(host: Host, runId: string, taskId: string, projectId = "rehearsal"): void {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(host.config.stateDir), vaultKey: readFileSync(host.config.keyFile) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule());
    store.register(routingModule());
    const payload: RoutingPayload = {
      projectId, taskId, area: "host", featureMap: "default", coordinatorProfileId: "astra-xhigh", knobs: ROUTING_DEFAULTS,
      costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5,
      current: [], candidates: [], elapsedMs: 1,
    };
    store.write(tx => {
      const row: DecisionRow = {
        key: decisionKey(runId, 1, tx.index("task", taskId), "start", 1), runId, revision: 1, taskKey: tx.index("task", taskId),
        point: "start", ordinal: 1, projectRef: tx.index("project", projectId), role: "implementer", areaRef: tx.index("area", "host"),
        kind: "feature", risk: "normal", featureVersion: 1, featureMapRef: tx.index("feature-map", "default"), mode: "shadow",
        algorithmVersion: 1, rewardVersion: 1, policyDigest: "d".repeat(64), seed: "s".repeat(64), basis: "single-candidate",
        chosenProfileId: "astra-xhigh", chosenIdentity: "i".repeat(64), greedyProfileId: "astra-xhigh",
        coordinatorProfileId: "astra-xhigh", explore: false, state: "recorded", memberId: null,
        decidedAt: new Date().toISOString(),
      };
      insertDecision(tx, row, payload);
    });
  } finally {
    store.close();
  }
}

test("routing reads answer every paired role on a real host", { timeout: 60000 }, async () => {
  const host = await startHost();
  const runId = randomUUID();
  try {
    // The API holds the evidence file open, so the decision is written while it is stopped, then the API starts again.
    await host.stopApi();
    seedDecision(host, runId, "task-one");
    await host.start();

    for (const role of ["owner", "controller", "viewer"] as const) {
      const project = await host.fetchApi("/routing/projects/rehearsal", role);
      assert.equal(project.status, 200, `project status for ${role}`);
      assert.equal(project.body.projectId, "rehearsal");
      // Off without a saved policy in a supervised project; the history of shadow decisions still counts.
      assert.equal(project.body.mode, "off");
      assert.equal(project.body.shadow.decisions, 1);
      const explain = await host.fetchApi(`/teams/${runId}/routing/task-one`, role);
      assert.equal(explain.status, 200, `explain for ${role}`);
      assert.equal(explain.body.decisions.length, 1);
      assert.equal(explain.body.decisions[0].payload.taskId, "task-one");
      assert.equal("taskKey" in explain.body.decisions[0], false);
    }

    const unknownProject = await host.fetchApi("/routing/projects/missing", "owner");
    assert.equal(unknownProject.status, 404);
    assert.equal(unknownProject.body.code, "unknown-project");
    const unknownTask = await host.fetchApi(`/teams/${runId}/routing/task-two`, "owner");
    assert.equal(unknownTask.status, 404);
    assert.equal(unknownTask.body.code, "routing-decision-not-found");
    const badTask = await host.fetchApi(`/teams/${runId}/routing/A_B`, "owner");
    assert.equal(badTask.status, 400);
    const badRun = await host.fetchApi("/teams/not-a-uuid/routing/task-one", "owner");
    assert.equal(badRun.status, 400);
    const anonymous = await host.fetchApi("/routing/projects/rehearsal", null);
    assert.equal(anonymous.status, 401);

    // The evidence directory replaced by a file: the store is unavailable and both routes answer 503.
    await host.stopApi();
    rmSync(join(host.config.stateDir, "evidence"), { recursive: true, force: true });
    writeFileSync(join(host.config.stateDir, "evidence"), "not a directory");
    await host.start();
    const projectDown = await host.fetchApi("/routing/projects/rehearsal", "owner");
    assert.equal(projectDown.status, 503);
    assert.equal(projectDown.body.code, "evidence-unavailable");
    const explainDown = await host.fetchApi(`/teams/${runId}/routing/task-one`, "owner");
    assert.equal(explainDown.status, 503);
    assert.equal(explainDown.body.code, "evidence-unavailable");
  } finally {
    await host.stop();
  }
});

test("the routing command prints status and explain", { timeout: 90000 }, async () => {
  // The project's saved policy makes its status shadow; a supervised project with no policy is off.
  const host = await startHost({ config: { projects: [{ id: "routed", name: "Routed", path: process.cwd(), team: { checks: [], establishChecks: true, routing: { mode: "shadow" } } }] } });
  const runId = randomUUID();
  const clientFile = join(host.root, "routing-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
  const cli = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const run = (args: string[]) => execFileSync(cli[0]!, [...cli.slice(1), "routing", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    await host.stopApi();
    seedDecision(host, runId, "task-one", "routed");
    await host.start();

    assert.match(run(["status", "routed"]), /routing shadow/);
    assert.match(run(["explain", runId, "task-one"]), /basis single-candidate/);
    assert.throws(() => run(["status", "missing"]), (error: { status?: number; stderr?: string }) =>
      error.status !== 0 && String(error.stderr).includes("No project has this ID."));
  } finally {
    await host.stop();
  }
});

test("the status route reads the objective digest version only when owner criteria are on", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-objective-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 6) });
  try {
    store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); store.register(routingModule());
    // The route's flags: publishHeads on (no setting is false), entry tools off.
    store.write(tx => {
      tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) VALUES ('record', 'codex', ?, 'xhigh', ?, 'g', 'k', 'off', 's', ?)",
        ASTRA.model, promptVersion("implementer", "codex", ASTRA, true, false, true), NOW);
      for (let index = 0; index < 2; index++) writeOutcome(tx, countedRow(`record-${index}`, "record"));
    });
    const astraRows = (status: RoutingStatus) => status.cells.find(cell => cell.cell.scope === "new-task")!.profiles.find(profile => profile.profileId === ASTRA.id)!.rows.production;
    const cases = [[{ objective: { prompts: "on" } }, 2], [{ objective: { prompts: "off" } }, 0], [{}, 0]] as const;
    for (const [team, expected] of cases) {
      const served = await serve(store, { projects: [{ id: "rehearsal", autonomy: "autonomous", team }], teams: { lineup: READY_LINEUP } } as unknown as Config);
      try {
        const status = await (await served.get("/api/routing/projects/rehearsal")).json() as RoutingStatus;
        assert.equal(astraRows(status), expected, JSON.stringify(team));
      } finally { await served.close(); }
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the routes pass the saved policy, the lineup, and the flags a new run pins, and take any UUID case", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-routes-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 5) });
  try {
    store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); store.register(routingModule());
    const runId = randomUUID();
    const run = { id: runId, revision: 1, projectId: "rehearsal", lineup: mixedLineup, routing: pinRouting(undefined, "autonomous", mixedLineup) } as unknown as TeamRun;
    const task = { id: "task-one", title: "t", instructions: "do it", paths: ["packages/host/src/a.ts"], dependsOn: [], revision: 1, status: "pending" } as unknown as TeamTask;
    new RoutingRecorder({ store, log: () => {} }).recordStart({ run, task, publishHeads: true, entryTools: false, featureMap: undefined, limited: new Set() });
    // Two rows under the version a new run pins by default (entry tools off), one under entry tools on. publishHeads changes only the delivery prompt.
    store.write(tx => {
      for (const [id, entryTools] of [["plain", false], ["tools", true]] as const) {
        tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) VALUES (?, 'codex', ?, 'xhigh', ?, 'g', 'k', 'off', 's', ?)",
          id, ASTRA.model, promptVersion("implementer", "codex", ASTRA, true, entryTools), NOW);
      }
      writeOutcome(tx, countedRow("plain-1", "plain")); writeOutcome(tx, countedRow("plain-2", "plain")); writeOutcome(tx, countedRow("tools-1", "tools"));
    });
    const astraRows = (status: RoutingStatus) => status.cells.find(cell => cell.cell.scope === "new-task")!.profiles.find(profile => profile.profileId === ASTRA.id)!.rows.production;
    const project = (team: object) => ({ id: "rehearsal", autonomy: "autonomous", team });
    for (const [teams, expected] of [[{ lineup: READY_LINEUP }, 2], [{ lineup: READY_LINEUP, blackboard: { tools: true } }, 1]] as const) {
      const served = await serve(store, { projects: [project({})], teams } as unknown as Config);
      try {
        const status = await (await served.get("/api/routing/projects/rehearsal")).json() as RoutingStatus;
        assert.deepEqual([status.covers.start, astraRows(status)], [true, expected], JSON.stringify(teams));
        assert.equal((await served.get(`/api/teams/${runId.toUpperCase()}/routing/task-one`)).status, 200);
      } finally { await served.close(); }
    }
    const off = await serve(store, { projects: [project({ routing: { mode: "off" } })], teams: { lineup: mixedLineup } } as unknown as Config);
    try {
      assert.equal((await (await off.get("/api/routing/projects/rehearsal")).json() as RoutingStatus).mode, "off");
    } finally { await off.close(); }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the routing status previews the start mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-start-mode-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 7) });
  try {
    store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); store.register(routingModule());
    // mixedLineup has no evaluator of another family, so an autonomous project starts supervised and routing is off.
    const statusFor = async (autonomy: string) => {
      const served = await serve(store, { projects: [{ id: "rehearsal", autonomy, team: {} }], teams: { lineup: mixedLineup } } as unknown as Config);
      try { return await (await served.get("/api/routing/projects/rehearsal")).json() as RoutingStatus; } finally { await served.close(); }
    };
    assert.deepEqual(await statusFor("autonomous"), await statusFor("supervised"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause, resume, and revoke answer the owner only", { timeout: 120000 }, async () => {
  const run = await teamFixture("success");
  const host = run.host;
  const pause = (role: "owner" | "controller" | "viewer" | null, project = "rehearsal") => host.fetchApi(`/routing/projects/${project}/explore/pause`, role, undefined, {}, "POST");
  const resume = (role: "owner" | "controller" | "viewer" | null, project = "rehearsal") => host.fetchApi(`/routing/projects/${project}/explore/resume`, role, undefined, {}, "POST");
  try {
    const paused = await pause("owner");
    assert.equal(paused.status, 200);
    assert.deepEqual([paused.body.projectId, typeof paused.body.explorePausedAt], ["rehearsal", "string"]);
    const resumed = await resume("owner");
    assert.deepEqual([resumed.status, resumed.body.explorePausedAt], [200, null]);

    const created = await host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    // A run without an auto pin has nothing to revoke.
    const revoked = await host.fetchApi(`/teams/${team.id}/routing/revoke`, "owner", { requestId: randomUUID(), revision: team.revision });
    assert.deepEqual([revoked.status, revoked.body.code], [409, "routing-not-enabled"]);

    for (const role of ["controller", "viewer"] as const) {
      assert.equal((await pause(role)).status, 403, `pause for ${role}`);
      assert.equal((await resume(role)).status, 403, `resume for ${role}`);
      assert.equal((await host.fetchApi(`/teams/${randomUUID()}/routing/revoke`, role, { requestId: randomUUID(), revision: 1 })).status, 403, `revoke for ${role}`);
    }
    const unknown = await pause("owner", "missing");
    assert.deepEqual([unknown.status, unknown.body.code], [404, "unknown-project"]);
    assert.equal((await host.fetchApi("/me", "owner")).body.teams.routingAuto, 1);

    // The evidence directory replaced by a file: the pause answers 503.
    await host.stopApi();
    // First, with the API stopped: the host registered the routing projector, which advanced over the settled run's events.
    const evidence = new EvidenceStore({ databasePath: evidenceDatabasePath(host.config.stateDir), vaultKey: readFileSync(host.config.keyFile) });
    try {
      assert.ok(evidence.read(db => db.get("SELECT name FROM projector_cursors WHERE name='routing'")), "the routing projector is registered");
    } finally {
      evidence.close();
    }
    rmSync(join(host.config.stateDir, "evidence"), { recursive: true, force: true });
    writeFileSync(join(host.config.stateDir, "evidence"), "not a directory");
    await host.start();
    const down = await pause("owner");
    assert.deepEqual([down.status, down.body.code], [503, "evidence-unavailable"]);
  } finally {
    await run.close();
  }
});

test("the team revoke-routing command reaches the route", { timeout: 120000 }, async () => {
  const run = await teamFixture("success");
  const host = run.host;
  const root = mkdtempSync(join(tmpdir(), "infinite-revoke-routing-"));
  const clientFile = join(root, "client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
  try {
    const created = await host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    // A run without an auto pin has nothing to revoke. The CLI reports the route's 409 code, not its message.
    const cli = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile, "team", "revoke-routing", team.id], { encoding: "utf8" });
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stderr.includes("Host returned HTTP 409 (routing-not-enabled)"), true, cli.stderr);
  } finally {
    await run.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pause leaves the saved configuration unchanged", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { projects: [{ id: "rehearsal", name: "Rehearsal", path: process.cwd(), team: { checks: [], establishChecks: true, routing: { mode: "auto" } } }] } });
  const file = join(host.root, "config.json");
  try {
    const before = readFileSync(file);
    assert.equal((await host.fetchApi("/routing/projects/rehearsal/explore/pause", "owner", undefined, {}, "POST")).status, 200);
    const paused = readFileSync(file);
    assert.equal((await host.fetchApi("/routing/projects/rehearsal/explore/resume", "owner", undefined, {}, "POST")).status, 200);
    assert.deepEqual([paused.equals(before), readFileSync(file).equals(before)], [true, true]);
  } finally {
    await host.stop();
  }
});
