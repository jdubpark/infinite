import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { applyScan } from "../packages/host/src/outcome-signals.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import type { TeamView } from "../packages/host/src/team-types.js";
import type { GoalVerdictView } from "../packages/host/src/verdict-view.js";
import { waitFor } from "./helpers.js";
import { SWITCHES, criterion, hostFixture } from "./fixtures/verdict-goals.js";

type Fixture = Awaited<ReturnType<typeof hostFixture>>;
type Waiting = { goalId: string; runId: string; head: string; workspace: string; criterionId: string; first: string };

const MERGED = { statement: "The run is merged", check: { kind: "receipt", receipt: "merged" }, threshold: { kind: "pass" } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function read<T>(f: Fixture, path: string): Promise<T> {
  const response = await f.host.fetchApi(path);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as T;
}

async function eventually<T>(load: () => Promise<T>, accept: (value: T) => boolean, ms = 30000): Promise<T> {
  try { return await waitFor(load, accept, ms); } catch { return load(); }
}

const shown = async (f: Fixture, goalId: string, id: string) =>
  (await read<{ verdicts: GoalVerdictView[] }>(f, `/goals/${goalId}/verdicts`)).verdicts[0]?.criteria.find(item => item.id === id);

async function enroll(f: Fixture, change: { team?: Record<string, unknown>; source?: Record<string, unknown> }): Promise<void> {
  const view = await read<{ revision: number; team: Record<string, unknown> }>(f, "/projects/rehearsal/team");
  const saved = await f.host.fetchApi("/projects/rehearsal/team", "owner",
    { requestId: randomUUID(), revision: view.revision, team: { ...view.team, ...change.team }, ...(change.source ? { source: change.source } : {}) }, {}, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

async function create(f: Fixture): Promise<string> {
  const created = await f.host.fetchApi("/goals", "owner", f.create({ maxRuns: 1, criteria: [criterion("Every source is named", "sources"), MERGED] } as never));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.id as string;
}

async function pinned(f: Fixture, goalId: string, runId: string): Promise<Waiting> {
  const record = await read<{ record: { criteria: { id: string; check: { kind: string } }[] } }>(f, `/goals/${goalId}/record`);
  const criterionId = record.record.criteria.find(item => item.check.kind === "receipt")!.id;
  const run = await read<TeamView>(f, `/teams/${runId}`);
  const first = run.assessment!;
  assert.deepEqual([run.verdicts, run.goal?.id, first.kind, first.head, first.revision, first.criteria.find(item => item.id === criterionId)?.state],
    ["on", goalId, "reviewed", run.headCommit, run.revision, "inconclusive"]);
  await waitFor(() => read<ProductGoal>(f, `/goals/${goalId}`), goal => goal.cycles[0]?.assessment?.verdictId === first.verdictId, 30000);
  const before = await shown(f, goalId, criterionId);
  assert.deepEqual([before?.producer, before?.state, before?.reason], ["host", "inconclusive", "before-delivery"]);
  return { goalId, runId, head: run.headCommit!, workspace: run.workspace, criterionId, first: first.verdictId };
}

async function waiting(f: Fixture): Promise<Waiting> {
  const goalId = await create(f);
  const goal = await f.stopped(goalId, value => value.cycles[0]?.assessment !== undefined);
  return pinned(f, goalId, goal.cycles[0]!.teamId);
}

function land(f: Fixture, w: Waiting): void {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) });
  try {
    store.register(outcomeModule());
    const landed = store.write(tx => applyScan(tx, { projectId: "rehearsal", repository: "example/app", baseBranch: "main", head: w.head, at: new Date().toISOString(),
      commits: 1, gap: null, expectedSeq: 0, holdDays: 30, reverts: [],
      landings: [{ runId: w.runId, commit: w.head, method: "tree-equal", position: 0, reviewedHead: w.head }] }));
    assert.equal(landed.applied, true);
  } finally { store.close(); }
}

async function settledLate(f: Fixture, w: Waiting): Promise<void> {
  const run = await eventually(() => read<TeamView>(f, `/teams/${w.runId}`), view => view.assessment?.verdictId !== w.first);
  const late = run.assessment!;
  assert.notEqual(late.verdictId, w.first, "the run has a new verdict");
  assert.deepEqual([late.kind, late.head, late.criteria.find(item => item.id === w.criterionId)?.state], ["reviewed", w.head, "met"]);
  const goal = await eventually(() => read<ProductGoal>(f, `/goals/${w.goalId}`), value => value.cycles[0]?.assessment?.verdictId === late.verdictId);
  assert.equal(goal.cycles[0]!.assessment?.verdictId, late.verdictId, "the goal's cycle holds the new verdict");
  assert.deepEqual(goal.cycles[0]!.supersededVerdictIds, [w.first]);
  assert.equal((await shown(f, w.goalId, w.criterionId))?.state, "met");
}

test("the start-up sweep settles a landing recorded while the host was stopped, and the goal copies the verdict", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "autonomous" });
  try {
    const w = await waiting(f);
    await f.host.stopApi();
    land(f, w);
    await f.host.start();
    await settledLate(f, w);
  } finally { await f.close(); }
});

test("a base scan that finds the landing settles the late verdict, and the goal copies it", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "autonomous" });
  try {
    const w = await waiting(f);
    const remote = join(f.host.root, "scan-remote.git");
    git(f.host.root, "clone", "--bare", f.host.config.projects[0]!.path, remote);
    f.host.config.source = { ...f.host.config.source, remoteOverrides: { rehearsal: remote } };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    await enroll(f, { source: { mode: "github", repository: "example/app", baseBranch: "main" } });

    const scans = async () => (await read<{ counts: Record<string, number> }>(f, "/evidence/status")).counts["outcomes.scans"] ?? 0;
    const refresh = async () => {
      const response = await f.host.fetchApi("/projects/rehearsal/source/refresh", "owner", {});
      assert.equal(response.status, 200, JSON.stringify(response.body));
    };
    await refresh();
    const before = await waitFor(scans, count => count >= 1, 10000);
    await waitFor(() => f.host.fetchApi(`/outcomes/runs/${w.runId}`), response => response.status === 200 && response.body.summary?.payload?.reviewedHead === w.head, 10000);
    assert.equal((await read<TeamView>(f, `/teams/${w.runId}`)).assessment?.verdictId, w.first, "no verdict changes before the base branch moves");

    git(w.workspace, "push", remote, `${w.head}:refs/heads/main`);
    await refresh();
    await waitFor(scans, count => count > before, 10000);
    await settledLate(f, w);
  } finally { await f.close(); }
});

test("a merge report settles a landing the host already holds, and the goal copies the verdict", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "autonomous" });
  try {
    await enroll(f, { team: { delivery: { mode: "merge", repository: "example/app", baseBranch: "main", mergeMethod: "squash" } } });
    const hold = join(f.receipts, "hold-delivery"), held = join(f.receipts, "delivery-held");
    writeFileSync(hold, "", { mode: 0o600 });
    const goalId = await create(f);
    await waitFor(async () => existsSync(held), found => found, 120000);
    const w = await pinned(f, goalId, readFileSync(held, "utf8"));
    assert.notEqual((await read<TeamView>(f, `/teams/${w.runId}`)).status, "merged", "the merge is not reported yet");
    land(f, w);
    rmSync(hold);
    await waitFor(() => read<TeamView>(f, `/teams/${w.runId}`), view => view.status === "merged", 30000);
    await settledLate(f, w);
  } finally { await f.close(); }
});
