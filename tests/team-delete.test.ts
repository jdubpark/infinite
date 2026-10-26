import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { hashToken } from "../packages/host/src/config.js";
import { GoalService } from "../packages/host/src/goals.js";
import { MissionService } from "../packages/host/src/missions.js";
import { createApp } from "../packages/host/src/server.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { handleTeamClientCommand } from "../packages/host/src/team-cli.js";
import { unseal } from "../packages/host/src/vault.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun, type TeamView, type TeamLineup } from "../packages/host/src/team-types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { Config } from "../packages/host/src/types.js";

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

type StoredRun = { run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root: string;
  pending?: { kind: string }; source?: { path: string } };
type TeamInternals = { records: Map<string, StoredRun> };
function readStored(teams: TeamService, id: string) { return (teams as unknown as TeamInternals).records.get(id)!; }

test("removeRun refuses active work, returns the final cancelled view, and gives 404 after removal", async () => {
  const fixture = schedulerFixture();
  fixture.run.status = "planning";
  fixture.run.members = [];
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    const stored = readStored(teams, fixture.run.id);
    await assert.rejects(teams.removeRun(fixture.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-active");

    stored.run.status = "cancelled";
    stored.run.reason = "The owner cancelled this run.";
    stored.run.events.push({ at: new Date().toISOString(), text: "Team cancelled." });
    const removed = await teams.removeRun(fixture.run.id);
    assert.equal(removed.status, "cancelled");
    assert.ok(removed.events.some(event => event.text.includes("removeRun after the run settled")));
    assert.equal(teams.list().some((team: TeamView) => team.id === fixture.run.id), false);
    await assert.rejects(teams.removeRun(fixture.run.id), (error: unknown) => error instanceof TeamError && error.status === 404 && error.code === "team-not-found");
  } finally { teams.close(); fixture.close(); }
});

test("removeRun finishes a persisted workspace-removal intent before deleting its record", async () => {
  const fixture = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  fixture.run.status = "no-change";
  fixture.run.updatedAt = at;
  fixture.run.workspaceRemovedAt = at;
  fixture.run.members = [];
  fixture.run.events.push({ at, text: "Workspace removal under the retention policy started." });
  fixture.writeTeam();
  assert.equal(existsSync(dirname(fixture.run.workspace)), true);
  const teams = fixture.openTeam();
  try {
    await teams.removeRun(fixture.run.id);
    assert.equal(existsSync(dirname(fixture.run.workspace)), false, "the restarted DELETE path removes the surviving workspace");
    assert.equal(teams.list().some(team => team.id === fixture.run.id), false);
  } finally { teams.close(); fixture.close(); }
});

test("removeRun and retention preserve a completed run while its owner may still use it as a source", async () => {
  const fixture = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  fixture.run.status = "merged";
  fixture.run.updatedAt = at;
  fixture.run.missionId = randomUUID();
  fixture.run.members = [];
  fixture.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, finishedMinutes: 0 };
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    await assert.rejects(teams.removeRun(fixture.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-retained" &&
      error.message === "A live goal, mission or handoff still uses this run as its source; it is removed when that owner finishes.");
    const stored = readStored(teams, fixture.run.id);
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    assert.equal(existsSync(dirname(fixture.run.workspace)), true, "the missing ownerActive hook must retain the source clone");
    assert.equal(teams.get(fixture.run.id).workspaceRemovedAt, undefined);
  } finally { teams.close(); fixture.close(); }
});

test("removeRun and retention wait for a pending prepare that clones from this run", async () => {
  const fixture = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  fixture.run.status = "no-change";
  fixture.run.updatedAt = at;
  fixture.run.members = [];
  fixture.run.events.push({ at, text: "The project manager reported no justified change." });
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, finishedMinutes: 0 };
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    const child = structuredClone(fixture.run);
    child.id = randomUUID();
    child.workspace = join(fixture.config.teams!.workspaceDir, child.id, "integration");
    child.status = "planning";
    const childStored: StoredRun = { run: child, fingerprint: "fixture", receipts: {}, prepared: false, root: fixture.config.teams!.workspaceDir,
      pending: { kind: "prepare" }, source: { path: fixture.run.workspace } };
    (teams as unknown as { records: Map<string, StoredRun> }).records.set(child.id, childStored);

    await assert.rejects(teams.removeRun(fixture.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-in-use");
    const stored = readStored(teams, fixture.run.id);
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    assert.equal(existsSync(dirname(fixture.run.workspace)), true, "retention leaves the source in place while child preparation is pending");
    assert.equal(teams.get(fixture.run.id).workspaceRemovedAt, undefined);
  } finally { teams.close(); fixture.close(); }
});

test("deleting a run persists its request ID tombstone across restart", async () => {
  const fixture = schedulerFixture();
  fixture.run.status = "no-change";
  fixture.run.members = [];
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    await teams.removeRun(fixture.run.id);
    const tombstonePath = join(fixture.config.stateDir, "teams", "retired.sealed");
    assert.ok(unseal<string[]>(fixture.key, "team:retired", readFileSync(tombstonePath, "utf8")).includes(fixture.run.id));
    teams.close();

    const restarted = fixture.openTeam();
    await assert.rejects(restarted.create({ requestId: fixture.run.id, projectId: "fixture", provider: "demo", title: "Replay deleted start", objective: "Must stay idempotent" }),
      (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-deleted" &&
        error.message === "This request's run was deleted under the retention policy. Start a new run with a new request id.");
  } finally { teams.close(); fixture.close(); }
});

test("workspace retention follows delivery and reconciliation errors for team controls", async () => {
  const fixture = schedulerFixture();
  fixture.run.status = "blocked"; fixture.run.members = []; fixture.run.workspaceRemovedAt = new Date().toISOString();
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    const stored = readStored(teams, fixture.run.id) as StoredRun & { pending?: unknown; deliveryAttempt?: unknown };
    stored.deliveryAttempt = { memberId: randomUUID(), revision: fixture.run.revision, headCommit: fixture.run.baseCommit };
    await assert.rejects(teams.steer(fixture.run.id, { requestId: randomUUID(), revision: fixture.run.revision, text: "Inspect the recorded delivery first." }),
      (error: unknown) => error instanceof TeamError && error.code === "delivery-reconciliation-required");

    stored.deliveryAttempt = undefined;
    stored.pending = { id: randomUUID(), kind: "check", revision: fixture.run.revision };
    await assert.rejects(teams.resume(fixture.run.id, { requestId: randomUUID(), revision: fixture.run.revision }),
      (error: unknown) => error instanceof TeamError && error.code === "team-reconciliation-required");

    stored.pending = undefined;
    stored.run.linearTracking = true;
    stored.run.linear = { status: "blocked" } as TeamRun["linear"];
    await assert.rejects(teams.continueRun(fixture.run.id, { requestId: randomUUID(), revision: fixture.run.revision }),
      (error: unknown) => error instanceof TeamError && error.code === "linear-reconciliation-required");
  } finally { teams.close(); fixture.close(); }
});

test("DELETE /api/teams/:id enforces ownership and removes only settled runs", { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "team-delete-api-")),
    runDir = mkdtempSync(join(resolve(tmpdir(), "../../../../../tmp"), "team-delete-run-")), fixture = schedulerFixture();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const key = randomBytes(32), token = randomBytes(32).toString("base64url"), controllerToken = randomBytes(32).toString("base64url");
  const config: Config = { port: 0, origin: "http://127.0.0.1", keyFile: join(root, "key"), stateDir: join(root, "state"), runDir,
    environment: "local", enableDemo: true, maxSessions: 4, agents: {}, projects: [{ id: "fixture", name: "Fixture", path: workspace }],
    tokens: [
      { id: "owner", label: "Owner", role: "owner", hash: hashToken(token) },
      { id: "controller", label: "Controller", role: "controller", hash: hashToken(controllerToken) },
    ], teams: { workspaceDir: join(root, "teams") } };
  writeFileSync(config.keyFile, key, { mode: 0o600 });
  mkdirSync(join(config.stateDir, "desktop-uploads"), { recursive: true });
  let host: ReturnType<typeof createApp> | undefined;
  let listening = false;
  try {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("The sandbox does not permit the loopback listener required by the HTTP route test."); return; }
      throw error;
    } finally { if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve())); }
    host = createApp(config, key);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      host!.server.once("error", fail);
      host!.server.listen(0, "127.0.0.1", () => { listening = true; host!.server.removeListener("error", fail); resolve(); });
    });
    config.port = (host.server.address() as { port: number }).port;
    host.teams.close(); host.goals.close(); host.missions.close();

    const run = fixture.run;
    const stored: StoredRun = { run, fingerprint: "api-fixture", receipts: {}, prepared: true, root: config.teams!.workspaceDir };
    (host.teams as unknown as TeamInternals).records.set(run.id, stored);
    const call = async (bearer = token) => {
      const response = await fetch(`http://127.0.0.1:${config.port}/api/teams/${run.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } });
      return { status: response.status, body: await response.json() as any };
    };

    const forbidden = await call(controllerToken);
    assert.equal(forbidden.status, 403);

    const active = await call();
    assert.equal(active.status, 409);
    assert.equal(active.body.code, "team-active");

    const goalId = randomUUID();
    const goalRecord = { goal: { id: goalId, status: "running", activeTeamId: run.id, cycles: [] } };
    (host.goals as unknown as { records: Map<string, unknown> }).records.set(goalId, goalRecord);
    const owned = await call();
    assert.equal(owned.status, 409);
    assert.equal(owned.body.code, "goal-owned-team");

    goalRecord.goal.status = "achieved";
    const missionId = randomUUID();
    const missionRecord = { mission: { id: missionId, status: "working", subtasks: [{ id: "active-subtask", status: "running", teamId: run.id }] } };
    (host.missions as unknown as { records: Map<string, unknown> }).records.set(missionId, missionRecord);
    const missionOwned = await call();
    assert.equal(missionOwned.status, 409);
    assert.equal(missionOwned.body.code, "mission-owned-team");

    missionRecord.mission.status = "cancelled";
    run.status = "cancelled"; run.reason = "The owner cancelled this run."; run.members = []; run.workspaceRemovedAt = new Date().toISOString();
    // The clones are already gone: point the run at the host root so deletion only has to drop the record.
    run.workspace = join(config.teams!.workspaceDir, "removed-run", "integration");
    const deleted = await call();
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.status, "cancelled");
    assert.ok(deleted.body.workspaceRemovedAt);
    const repeated = await call();
    assert.equal(repeated.status, 404);
    assert.equal(repeated.body.code, "team-not-found");
  } finally {
    if (host) {
      await host.closeConnections();
      if (listening) await new Promise<void>(resolve => host!.server.close(() => resolve()));
    }
    rmSync(root, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); fixture.close();
  }
});

test("active owner guards and retention references diverge after a goal cycle stops being active", () => {
  const fixture = schedulerFixture();
  fixture.run.status = "planning";
  fixture.run.members = [];
  fixture.writeTeam();
  const teams = fixture.openTeam();
  const goals = new GoalService(fixture.config, fixture.key, teams);
  try {
    const goalId = randomUUID();
    (goals as unknown as { records: Map<string, unknown> }).records.set(goalId, { goal: {
      id: goalId, status: "running", activeTeamId: fixture.run.id, cycles: [{ teamId: fixture.run.id }],
    } });
    assert.equal(goals.ownsActiveTeam(fixture.run.id), true);
    assert.equal(goals.retainsTeamRun(fixture.run.id), true);
    const goal = (goals as unknown as { records: Map<string, { goal: { activeTeamId?: string } }> }).records.get(goalId)!.goal;
    goal.activeTeamId = undefined;
    assert.equal(goals.ownsActiveTeam(fixture.run.id), false, "a historical cycle cannot block standalone team deletion");
    assert.equal(goals.retainsTeamRun(fixture.run.id), true, "the live goal still retains its referenced cycle run");
    assert.throws(() => teams.get("missing"), (error: unknown) => error instanceof TeamError && error.status === 404);
  } finally { goals.close(); teams.close(); fixture.close(); }
});

test("mission delete guards follow active subtask state while retention follows live references", () => {
  const fixture = schedulerFixture();
  const missionKey = randomBytes(32), missionId = randomUUID();
  const teams = fixture.openTeam();
  const groups = { get: () => { throw new Error("The fixture mission has no group lookup."); } };
  const missions = new MissionService(fixture.config, missionKey, fixture.manager as unknown as Manager, teams, groups);
  const at = new Date().toISOString();
  const mission = {
    id: missionId, groupId: "fixture", groupName: "Fixture", repoProjectIds: ["fixture"], title: "Test mission", objective: "Exercise owner guards",
    maxSubtasks: 5, maxMinutes: 10, deadlineAt: new Date(Date.now() + 600_000).toISOString(), revision: 1, status: "working", createdAt: at, updatedAt: at,
    lineup, subtasks: [{ id: "subtask", repoProjectId: "fixture", title: "Work", objective: "Work", size: "solo", parallelism: 1, dependsOn: [], status: "running", teamId: fixture.run.id }],
    decisions: [], steering: [], events: [],
  } as unknown as Mission;
  (missions as unknown as { records: Map<string, { mission: Mission }> }).records.set(missionId, { mission });
  try {
    assert.equal(missions.ownsActiveSubteam(fixture.run.id), true);
    assert.equal(missions.retainsSubteamRun(fixture.run.id), true);
    const subtask = mission.subtasks[0]!;
    subtask.status = "cancelled";
    assert.equal(missions.ownsActiveSubteam(fixture.run.id), false, "a cancelled subtask cannot block standalone team deletion");
    assert.equal(missions.retainsSubteamRun(fixture.run.id), true, "the live mission still retains its referenced run");
    subtask.status = "blocked";
    assert.equal(missions.ownsActiveSubteam(fixture.run.id), true, "a blocked subtask remains under mission control");
  } finally { missions.close(); teams.close(); fixture.close(); }
});

test("team delete CLI prints JSON and treats a repeated delete as successful", async () => {
  const root = mkdtempSync(join(tmpdir(), "team-delete-cli-"));
  const plainId = randomUUID(), jsonId = randomUUID();
  const deleted = new Set<string>();
  const config = { origin: "http://fixture.invalid", token: "fixture-token" };
  const api = {
    request: async () => { throw new Error("The delete command uses the JSON API only."); },
    json: async (path: string, _body?: unknown, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string) => {
      const id = path.slice("/teams/".length);
      assert.ok([plainId, jsonId].includes(id));
      assert.equal(method, "DELETE");
      if (!deleted.has(id)) { deleted.add(id); return { id, status: "cancelled", title: "Fixture run" }; }
      throw Object.assign(new Error("This team does not exist."), { status: 404 });
    },
  };
  const configPath = join(root, "client.json");
  const output: string[] = [], log = console.log;
  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    assert.equal(await handleTeamClientCommand("team", ["delete", plainId], {}, config, api, configPath, ["team", "delete", plainId]), true);
    assert.match(output.join("\n"), new RegExp(`${plainId}\\s+cancelled\\s+Fixture run`));
    output.length = 0;
    assert.equal(await handleTeamClientCommand("team", ["delete", jsonId], { "--json": true }, config, api, configPath, ["team", "delete", jsonId, "--json"]), true);
    assert.equal(JSON.parse(output.pop()!).status, "cancelled");
    assert.equal(await handleTeamClientCommand("team", ["delete", plainId], {}, config, api, configPath, ["team", "delete", plainId]), true);
    assert.match(output.pop()!, /already removed/);
    assert.equal(await handleTeamClientCommand("team", ["delete", jsonId], { "--json": true }, config, api, configPath, ["team", "delete", jsonId, "--json"]), true);
    assert.equal(JSON.parse(output.pop()!).status, "already-removed");
    assert.deepEqual([...deleted].sort(), [plainId, jsonId].sort());
  } finally { console.log = log; rmSync(root, { recursive: true, force: true }); }
});

test("team start clears an uncertain receipt after confirming its prior run was cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "team-start-recovery-"));
  const oldId = randomUUID(), newId = randomUUID(), config = { origin: "http://fixture.invalid", token: "fixture-token" }, objective = "Recover after cancellation";
  const configPath = join(root, "client.json");
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const receiptPath = join(dirname(configPath), "team-cli", identity, "receipts.json");
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const staleBody = { requestId: oldId, projectId: "rehearsal", provider: "demo", useConfiguredLineup: false, title: objective, objective };
  writeFileSync(receiptPath, JSON.stringify({ [`team-start:${oldId}`]: { requestId: oldId, endpoint: "/teams", method: "POST", body: staleBody, createdAt: "2026-01-01T00:00:00.000Z", state: "pending" } }), { mode: 0o600 });
  const calls: { path: string; method?: string }[] = [];
  const api = {
    request: async () => { throw new Error("The start command uses the JSON API only."); },
    json: async (path: string, body?: any, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string): Promise<any> => {
      calls.push({ path, method });
      if (path === "/projects/rehearsal/team") return { hostSetup: { ready: true }, team: { checks: [{ command: "node" }] } };
      if (path === "/me") return { teams: { lineup: { coordinator: { provider: "demo" } } } };
      if (path === `/teams/${oldId}`) return { id: oldId, status: "cancelled" };
      if (path === "/teams" && method === "POST") return { id: body.requestId, status: "planning", projectId: body.projectId, title: body.title };
      throw Object.assign(new Error("Not found"), { status: 404 });
    },
  };
  const output: string[] = [], log = console.log;
  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    assert.equal(await handleTeamClientCommand("team", ["start", objective], { "--project": "rehearsal", "--provider": "demo", "--request-id": newId, "--json": true }, config, api, configPath,
      ["team", "start", objective, "--project", "rehearsal", "--provider", "demo", "--request-id", newId, "--json"]), true);
    assert.equal(JSON.parse(output.pop()!).id, newId);
    assert.ok(calls.some(call => call.path === `/teams/${oldId}` && call.method === undefined));
    assert.ok(calls.some(call => call.path === "/teams" && call.method === "POST"));
    const receipts = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipts[`team-start:${oldId}`], undefined);
    assert.equal(receipts[`team-start:${newId}`].state, "confirmed");
  } finally { console.log = log; rmSync(root, { recursive: true, force: true }); }
});

test("team start clears a tombstoned receipt and accepts a new request ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "team-start-tombstone-"));
  const oldId = randomUUID(), newId = randomUUID(), config = { origin: "http://fixture.invalid", token: "fixture-token" }, objective = "Start after deletion";
  const configPath = join(root, "client.json");
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const receiptPath = join(dirname(configPath), "team-cli", identity, "receipts.json");
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const staleBody = { requestId: oldId, projectId: "rehearsal", provider: "demo", useConfiguredLineup: false, title: objective, objective };
  writeFileSync(receiptPath, JSON.stringify({ [`team-start:${oldId}`]: { requestId: oldId, endpoint: "/teams", method: "POST", body: staleBody, createdAt: "2026-01-01T00:00:00.000Z", state: "pending" } }), { mode: 0o600 });
  const calls: { path: string; method?: string }[] = [];
  let rejectDeletedReplay = false;
  const api = {
    request: async () => { throw new Error("The start command uses the JSON API only."); },
    json: async (path: string, body?: any, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string): Promise<any> => {
      calls.push({ path, method });
      if (path === "/projects/rehearsal/team") return { hostSetup: { ready: true }, team: { checks: [{ command: "node" }] } };
      if (path === "/me") return { teams: { lineup: { coordinator: { provider: "demo" } } } };
      if (path === `/teams/${oldId}`) throw Object.assign(new Error("This team was deleted and retained."), { status: 409, code: "team-deleted" });
      if (path === "/teams" && method === "POST") {
        if (rejectDeletedReplay) throw Object.assign(new Error("Host returned HTTP 409 (team-deleted)."), { status: 409, code: "team-deleted" });
        return { id: body.requestId, status: "planning", projectId: body.projectId, title: body.title };
      }
      throw Object.assign(new Error("Not found"), { status: 404 });
    },
  };
  const output: string[] = [], log = console.log;
  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    assert.equal(await handleTeamClientCommand("team", ["start", objective], { "--project": "rehearsal", "--provider": "demo", "--request-id": newId, "--json": true }, config, api, configPath,
      ["team", "start", objective, "--project", "rehearsal", "--provider", "demo", "--request-id", newId, "--json"]), true);
    assert.equal(JSON.parse(output.pop()!).id, newId);
    assert.ok(calls.some(call => call.path === `/teams/${oldId}` && call.method === undefined));
    assert.ok(calls.some(call => call.path === "/teams" && call.method === "POST"));
    const receipts = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipts[`team-start:${oldId}`], undefined);
    assert.equal(receipts[`team-start:${newId}`].state, "confirmed");
    rejectDeletedReplay = true;
    const replayId = randomUUID();
    await assert.rejects(handleTeamClientCommand("team", ["start", objective], { "--project": "rehearsal", "--provider": "demo", "--request-id": replayId }, config, api, configPath,
      ["team", "start", objective, "--project", "rehearsal", "--provider", "demo", "--request-id", replayId]),
      /already deleted and retained as a tombstone.*new request ID/);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8"))[`team-start:${replayId}`], undefined, "a tombstoned replay does not leave a pending CLI receipt");
  } finally { console.log = log; rmSync(root, { recursive: true, force: true }); }
});

test("restore blocks a run that restarted before workspace preparation", () => {
  const fixture = schedulerFixture();
  fixture.run.status = "planning";
  fixture.run.members = [];
  fixture.writeTeam({ prepared: false });
  const teams = fixture.openTeam();
  try {
    const view = teams.get(fixture.run.id);
    assert.equal(view.status, "blocked");
    assert.match(view.reason ?? "", /restarted before this team's workspace was prepared/);
    assert.ok(view.events.some(event => event.text.includes("Start a new team")));
    const stored = fixture.readRecord<{ halt?: string; pending?: unknown }>("team", fixture.run.id);
    assert.equal(stored.halt, "block");
    assert.equal(stored.pending, undefined);
  } finally { teams.close(); fixture.close(); }
});

test("active goal, mission, or handoff owners retain completed integration clones", async () => {
  const retained = schedulerFixture();
  retained.run.status = "merged";
  retained.run.missionId = randomUUID();
  retained.run.members.forEach(member => { member.status = "stopped"; });
  const at = new Date(Date.now() - 1000).toISOString();
  retained.run.updatedAt = at;
  retained.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  retained.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, finishedMinutes: 0 };
  retained.writeTeam();
  const retainedTeams = new TeamService(retained.config, retained.key, retained.manager as unknown as Manager, (_project, start) => start());
  try {
    const stored = (retainedTeams as unknown as { records: Map<string, unknown> }).records.get(retained.run.id)!;
    await (retainedTeams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    assert.equal(existsSync(dirname(retained.run.workspace)), true, "an owned completed run keeps its integration workspace when no owner hook is wired");
    assert.equal(retainedTeams.get(retained.run.id).workspaceRemovedAt, undefined);
  } finally { retainedTeams.close(); retained.close(); }

  const released = schedulerFixture();
  released.run.status = "ready-for-review";
  released.run.goal = { id: randomUUID(), parentRunId: randomUUID(), cycle: 1, revision: 1, deadlineAt: new Date().toISOString(), ceilingAt: new Date().toISOString(), extendMinutes: 0 };
  released.run.members.forEach(member => { member.status = "stopped"; });
  released.run.updatedAt = at;
  released.run.events.push({ at, text: "The delivery agent reported an open pull request for the reviewed commit." });
  released.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, reviewHours: 0 };
  released.writeTeam();
  const releasedTeams = new TeamService(released.config, released.key, released.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { ownerActive: () => false });
  try {
    const stored = (releasedTeams as unknown as { records: Map<string, unknown> }).records.get(released.run.id)!;
    await (releasedTeams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    await releasedTeams.idle();
    assert.equal(existsSync(dirname(released.run.workspace)), false, "a terminal owner allows completed workspace retention to proceed");
    assert.ok(releasedTeams.get(released.run.id).workspaceRemovedAt);
  } finally { releasedTeams.close(); released.close(); }
});

test("retention does not remove a member workspace reused by a newer run member", async () => {
  const fixture = schedulerFixture();
  fixture.run.status = "implementing";
  const base = fixture.run.members[0]!;
  const olderId = randomUUID(), newerId = randomUUID(), at = new Date(Date.now() - 1000).toISOString();
  const older = { ...base, memberId: olderId, sessionId: randomUUID(), role: "implementer" as const, taskId: "finished", title: "Implementer: finished",
    status: "stopped" as const, cwd: fixture.run.workspace, report: { kind: "result" as const, summary: "Integrated work." } };
  const newer = { ...base, memberId: newerId, sessionId: randomUUID(), role: "implementer" as const, taskId: "replacement", title: "Implementer: replacement",
    status: "running" as const, cwd: fixture.run.workspace, report: undefined };
  fixture.run.members = [older, newer];
  fixture.run.tasks = [{ id: "finished", title: "Finished", instructions: "Complete this task", paths: ["."], dependsOn: [], revision: 1, status: "integrated", memberId: olderId, commit: fixture.run.baseCommit }];
  fixture.run.updatedAt = at;
  fixture.run.events.push({ at, text: `${older.title} reported a result; its validated changes were integrated.` });
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, memberMinutes: 0 };
  fixture.writeTeam();
  const teams = fixture.openTeam();
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(fixture.run.id)!;
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    assert.equal(existsSync(older.cwd), true);
    assert.equal(teams.get(fixture.run.id).members.find(member => member.memberId === olderId)?.workspaceRemovedAt, undefined);
  } finally { teams.close(); fixture.close(); }
});

test("a settled cancelled mission subteam is removed while its evidence and replacement stay available", async () => {
  const fixture = schedulerFixture();
  const missionKey = randomBytes(32), missionId = randomUUID();
  fixture.run.status = "implementing";
  fixture.run.missionId = missionId;
  fixture.run.headCommit = fixture.run.baseCommit;
  fixture.run.members[0]!.status = "stopped";
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 0 };
  fixture.writeTeam();
  const teams = new TeamService(fixture.config, fixture.key, fixture.manager as unknown as Manager, (_project, start) => start(),
    undefined, undefined, { ownerActive: () => false });
  const groups = { get: () => { throw new Error("The fixture mission has no group lookup."); } };
  const missions = new MissionService(fixture.config, missionKey, fixture.manager as unknown as Manager, teams, groups);
  const runDirectory = dirname(fixture.run.workspace);
  const at = new Date().toISOString();
  const mission = {
    id: missionId, groupId: "fixture", groupName: "Fixture", repoProjectIds: ["fixture"], title: "Test mission", objective: "Exercise cancellation cleanup",
    maxSubtasks: 5, maxMinutes: 10, deadlineAt: new Date(Date.now() + 600_000).toISOString(), revision: 1, status: "working", createdAt: at, updatedAt: at,
    lineup, subtasks: [
      { id: "cancelled-run", repoProjectId: "fixture", title: "Cancelled work", objective: "Work that was cancelled", size: "solo", parallelism: 1, dependsOn: [], status: "running", teamId: fixture.run.id },
      { id: "replacement", repoProjectId: "fixture", title: "Replacement work", objective: "Continue the needed work", size: "solo", parallelism: 1, dependsOn: [], status: "queued" },
    ], decisions: [], steering: [], events: [],
  } as unknown as Mission;
  const missionStored = { mission, fingerprint: "fixture", receipts: {}, folder: fixture.config.stateDir, repos: [], attempts: [], inbox: [] as any[], notes: [], notified: [], launches: {} as Record<string, any>, ops: [], refusals: 0 };
  (missions as unknown as { records: Map<string, typeof missionStored> }).records.set(missionId, missionStored);
  try {
    await (missions as unknown as { consume(stored: typeof missionStored, report: any, attempt: any): void }).consume(missionStored,
      { kind: "cancel-subtask", subtaskId: "cancelled-run", reason: "The coordinator cancelled this subtask." }, { ownerInputs: 0 });
    await (missions as unknown as { applyOps(stored: typeof missionStored): Promise<void> }).applyOps(missionStored);
    assert.equal(teams.get(fixture.run.id).status, "cancelled");
    assert.equal(teams.get(fixture.run.id).reason, "Stopping active team members; any human input lease remains authoritative.");
    const storedRun = readStored(teams, fixture.run.id);
    await (teams as unknown as { retire(record: StoredRun): Promise<void> }).retire(storedRun);
    await teams.idle();
    assert.ok(storedRun.run.workspaceRemovedAt, "the host retires a cancelled workspace after all members settle");
    const removeRun = teams.removeRun.bind(teams);
    teams.removeRun = async id => {
      const persisted = unseal<{ mission: Mission }>(missionKey, `mission:${missionId}`,
        readFileSync(join(fixture.config.stateDir, "missions", `${missionId}.sealed`), "utf8")).mission;
      assert.equal(persisted.subtasks[0]?.status, "cancelled");
      assert.equal(persisted.subtasks[0]?.teamStatus, "cancelled");
      assert.equal(persisted.subtasks[0]?.finalEvidence?.reason, "Stopping active team members; any human input lease remains authoritative.");
      assert.equal(persisted.subtasks[0]?.finalEvidence?.headCommit, fixture.run.baseCommit);
      assert.equal(persisted.subtasks[0]?.teamId, fixture.run.id);
      return removeRun(id);
    };
    await (missions as unknown as { refresh(stored: typeof missionStored): Promise<void> }).refresh(missionStored);
    const subtask = mission.subtasks[0]!;
    assert.equal(subtask.status, "cancelled");
    assert.equal(subtask.teamStatus, "cancelled");
    assert.equal(subtask.teamId, undefined);
    assert.equal(subtask.finalEvidence?.reason, "Stopping active team members; any human input lease remains authoritative.");
    assert.equal(subtask.finalEvidence?.headCommit, fixture.run.baseCommit);
    assert.equal(teams.list().some((run: TeamView) => run.id === fixture.run.id), false);
    assert.equal(missionStored.mission.events.filter(event => event.text.includes("deleted cancelled subtask")).length, 1);
    assert.match(missionStored.inbox[0]?.retentionNote ?? "", /replacement subtask with a new ID in the same repository/);
    const persisted = unseal<{ mission: Mission }>(missionKey, `mission:${missionId}`,
      readFileSync(join(fixture.config.stateDir, "missions", `${missionId}.sealed`), "utf8")).mission;
    assert.equal(persisted.subtasks[0]?.teamId, undefined);

    (missions as unknown as { schedule(stored: typeof missionStored): void }).schedule(missionStored);
    assert.equal(missionStored.launches.replacement.projectId, "fixture");
  } finally { missions.close(); teams.close(); fixture.close(); }
});

test("a goal keeps cancelled cycle evidence when its team record is gone and continues stepping", async () => {
  const fixture = schedulerFixture();
  const at = new Date().toISOString(), goalId = randomUUID();
  const reason = "The cancelled cycle's final reason.";
  fixture.run.status = "cancelled";
  fixture.run.reason = reason;
  fixture.run.headCommit = fixture.run.baseCommit;
  fixture.run.members = [];
  fixture.run.goal = { id: goalId, parentRunId: randomUUID(), cycle: 1, revision: 1,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), ceilingAt: new Date(Date.now() + 600_000).toISOString(), extendMinutes: 0 };
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 0 };
  fixture.writeTeam();
  let ownerActive = true;
  const teams = new TeamService(fixture.config, fixture.key, fixture.manager as unknown as Manager, (_project, start) => start(),
    undefined, undefined, { ownerActive: () => ownerActive });
  const goals = new GoalService(fixture.config, fixture.key, teams);
  const goal = {
    id: goalId, title: "Test goal", objective: "Exercise cancelled-cycle cleanup", projectId: "fixture", status: "running", revision: 1,
    activeTeamId: fixture.run.id, deadlineAt: new Date(Date.now() + 600_000).toISOString(), maxMembers: 20, memberCount: 0, maxRuns: 2, maxMinutes: 10,
    createdAt: at, updatedAt: at, cycles: [{ teamId: fixture.run.id, cycle: 1, goalRevision: 1, status: "running", startedAt: at, memberCount: 0 }],
    steering: [], events: [], outcomes: [],
  };
  const storedGoal = { goal, fingerprint: "fixture", receipts: {} };
  (goals as unknown as { records: Map<string, unknown> }).records.set(goalId, storedGoal);
  try {
    const storedRun = readStored(teams, fixture.run.id);
    await (teams as unknown as { retire(record: StoredRun): Promise<void> }).retire(storedRun);
    assert.equal(storedRun.run.workspaceRemovedAt, undefined, "a live goal keeps the cancelled run's continuation source");
    assert.equal(existsSync(dirname(fixture.run.workspace)), true);
    assert.equal(teams.list().some((run: TeamView) => run.id === fixture.run.id), true, "retention keeps a goal-owned cancelled record until the goal snapshots it");

    await (goals as unknown as { step(stored: unknown): Promise<void> }).step(storedGoal);
    ownerActive = false;
    await (teams as unknown as { retire(record: StoredRun): Promise<void> }).retire(storedRun);
    await teams.idle();
    assert.ok(storedRun.run.workspaceRemovedAt, "retention removes the source after the goal records the cancelled cycle");

    const removeRun = teams.removeRun.bind(teams);
    teams.removeRun = async id => {
      ownerActive = false;
      const sealed = readFileSync(join(fixture.config.stateDir, "goals", `${goalId}.sealed`), "utf8");
      const persisted = unseal<{ goal: typeof goal }>(fixture.key, `goal:${goalId}`, sealed).goal;
      assert.equal(persisted.cycles[0]?.teamId, fixture.run.id);
      assert.equal(persisted.cycles[0]?.status, "cancelled");
      assert.equal(persisted.cycles[0]?.reason, reason);
      assert.equal(persisted.cycles[0]?.headCommit, fixture.run.baseCommit);
      return removeRun(id);
    };
    await (goals as unknown as { step(stored: unknown): Promise<void> }).step(storedGoal);
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, reason);
    const view = goals.get(goalId);
    assert.equal(view.cycles[0].teamId, fixture.run.id);
    assert.equal(view.cycles[0].status, "cancelled");
    assert.equal(view.cycles[0].reason, reason);
    assert.throws(() => teams.get(fixture.run.id), (error: unknown) => error instanceof TeamError && error.code === "team-not-found");
  } finally { goals.close(); teams.close(); fixture.close(); }
});

test("a goal sweeps a cancelled cycle after retention and retries a failed run removal", async () => {
  const fixture = schedulerFixture();
  const at = new Date().toISOString(), goalId = randomUUID(), reason = "The cancelled cycle's final reason.";
  let retentionNow = Date.parse(fixture.run.updatedAt) + 10_000;
  fixture.run.status = "cancelled"; fixture.run.reason = reason; fixture.run.headCommit = fixture.run.baseCommit; fixture.run.members = [];
  fixture.run.goal = { id: goalId, parentRunId: randomUUID(), cycle: 1, revision: 1,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), ceilingAt: new Date(Date.now() + 600_000).toISOString(), extendMinutes: 0 };
  fixture.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 1 };
  fixture.writeTeam();
  let ownerActive = true;
  const teams = new TeamService(fixture.config, fixture.key, fixture.manager as unknown as Manager, (_project, start) => start(),
    undefined, undefined, { now: () => retentionNow, ownerActive: () => ownerActive });
  const goals = new GoalService(fixture.config, fixture.key, teams);
  const goal = {
    id: goalId, title: "Test goal", objective: "Exercise delayed cancellation cleanup", projectId: "fixture", status: "running", revision: 1,
    activeTeamId: fixture.run.id, deadlineAt: new Date(Date.now() + 600_000).toISOString(), maxMembers: 20, memberCount: 0, maxRuns: 2, maxMinutes: 10,
    createdAt: at, updatedAt: at, cycles: [{ teamId: fixture.run.id, cycle: 1, goalRevision: 1, status: "running", startedAt: at, memberCount: 0 }],
    steering: [], events: [], outcomes: [],
  };
  const storedGoal = { goal, fingerprint: "fixture", receipts: {} };
  (goals as unknown as { records: Map<string, unknown> }).records.set(goalId, storedGoal);
  try {
    await (goals as unknown as { step(stored: unknown): Promise<void> }).step(storedGoal);
    assert.equal(goal.activeTeamId, undefined, "the settled cycle is no longer the active team before retention removes its workspace");
    ownerActive = false;
    assert.equal(goal.cycles[0]?.status, "cancelled");
    assert.equal(goal.cycles[0]?.reason, reason);
    assert.ok(teams.get(fixture.run.id));

    const storedRun = readStored(teams, fixture.run.id);
    await (teams as unknown as { retire(record: StoredRun): Promise<void> }).retire(storedRun);
    assert.equal(storedRun.run.workspaceRemovedAt, undefined, "the cancelled workspace remains before its retention interval elapses");
    retentionNow += 61_000;
    await (teams as unknown as { retire(record: StoredRun): Promise<void> }).retire(storedRun);
    await teams.idle();
    assert.ok(storedRun.run.workspaceRemovedAt);
    assert.ok(teams.get(fixture.run.id), "retention keeps the goal-owned record until the goal cleanup sweep acknowledges it");

    const removeRun = teams.removeRun.bind(teams);
    let removeAttempts = 0;
    teams.removeRun = async id => {
      removeAttempts++;
      const persisted = unseal<{ goal: typeof goal }>(fixture.key, `goal:${goalId}`,
        readFileSync(join(fixture.config.stateDir, "goals", `${goalId}.sealed`), "utf8")).goal;
      assert.equal(persisted.cycles[0]?.teamId, fixture.run.id);
      assert.equal(persisted.cycles[0]?.status, "cancelled");
      assert.equal(persisted.cycles[0]?.reason, reason);
      if (removeAttempts === 1) throw new TeamError(500, "team-record-removal-failed", "The fixture delays record removal once.");
      return removeRun(id);
    };
    await (goals as unknown as { step(stored: unknown): Promise<void> }).step(storedGoal);
    assert.equal(removeAttempts, 1);
    assert.ok(teams.get(fixture.run.id), "a failed removal remains available for the next goal tick");

    await (goals as unknown as { step(stored: unknown): Promise<void> }).step(storedGoal);
    assert.equal(removeAttempts, 2);
    assert.throws(() => teams.get(fixture.run.id), (error: unknown) => error instanceof TeamError && error.code === "team-not-found");
    const view = goals.get(goalId);
    assert.equal(view.cycles[0]?.teamId, fixture.run.id);
    assert.equal(view.cycles[0]?.status, "cancelled");
    assert.equal(view.cycles[0]?.reason, reason);
  } finally { goals.close(); teams.close(); fixture.close(); }
});
