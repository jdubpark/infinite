import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CheckObservation } from "../packages/host/src/check-observations.js";
import type { GoalMetrics, GoalMetricsView } from "../packages/host/src/goal-metrics.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { TeamLineup, TeamRun } from "../packages/host/src/team-types.js";
import { unseal } from "../packages/host/src/vault.js";
import { startHost, waitFor, type Host } from "./helpers.js";

/*
 * Reported numbers over the real host: the check runner, the team service and the goal service in one process, with
 * the goal fixture's agents through two cycles. The check is configured twice and prints its process id and a
 * sentinel name on stdout, a marker on stderr, and the setup prints one too. The test reads both sealed holders as a
 * positive control, then shows the sentinel name, as a JSON string, in no view, list, context file or event store.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};
const SENTINEL = "sentinel_q7x";
/** How a stored name would appear in any JSON: as a whole string. The check's own output holds the name only inside a line. */
const QUOTED = JSON.stringify(SENTINEL);
const check = { command: process.execPath, args: ["check.mjs"] };
const setup = { command: process.execPath, args: ["setup.mjs"] };

type RunHolder = { run: TeamRun; checkHead?: string; checkObservations?: CheckObservation[] };
type GoalHolder = { goal: ProductGoal; metrics?: GoalMetrics };

test("a goal's checks report numbers that reach only the curve route", { timeout: 180000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-metrics-")));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));',
    'assert.deepEqual(Object.keys(progress), ["completed"]);',
    'assert.ok(Number.isInteger(progress.completed) && progress.completed >= 1 && progress.completed <= 2);',
    'console.log(`infinite-metric pid ${process.pid}`);',
    `console.log(\`infinite-metric ${SENTINEL} \${progress.completed * 10}\`);`,
    'console.error("infinite-metric from_stderr 7");',
  ].join("\n"));
  writeFileSync(join(source, "setup.mjs"), 'console.log("infinite-metric from_setup 3");\n');
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs", "setup.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Metrics fixture");
  // The coordinator's first plan waits for this release file; this test has nothing to do before it.
  writeFileSync(join(receipts, "release-first-plan"), "continue", { mode: 0o600 });
  let host: Host | undefined;
  try {
    host = await startHost({ agents: {
      claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "cycles", receipts, "claude"] },
      codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "cycles", receipts, "codex"] },
    }, config: {
      teams: { workspaceDir: join(root, "teams"), lineup, publishHeads: false },
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { setup, checks: [check, check], objective: { intentCheck: "off" as const } } }],
    } });
    const api = host;
    const request: CreateGoal = { requestId: randomUUID(), projectId: "rehearsal", title: "Improve the progress flow",
      objective: "Build two small progress improvements using the existing data", successCriteria: "Two useful progress steps are available",
      nonGoals: ["Publishing or changing files outside the feature directory"], allowedPaths: ["features"],
      evidence: ["The fixture progress data starts at zero"], maxRuns: 2, maxMinutes: 5, maxMembers: 12, parallelism: 2 } as CreateGoal;
    const created = await api.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const goal = await waitFor(async () => (await api.fetchApi(`/goals/${request.requestId}`)).body as ProductGoal,
      value => ["ready-for-review", "no-opportunity", "blocked", "limit-reached"].includes(value.status) && !value.activeTeamId, 120000);
    assert.equal(goal.status, "ready-for-review", JSON.stringify(goal));
    assert.equal(goal.cycles.length, 2);

    // Positive controls: both holders keep the numbers, beside `run` and `goal`.
    const key = readFileSync(api.config.keyFile), state = api.config.stateDir;
    const runHolder = (id: string) => unseal<RunHolder>(key, `team:${id}`, readFileSync(join(state, "teams", `${id}.sealed`), "utf8"));
    const goalHolder = unseal<GoalHolder>(key, `goal:${goal.id}`, readFileSync(join(state, "goals", `${goal.id}.sealed`), "utf8"));
    const pids: number[] = [];
    for (const cycle of goal.cycles) {
      const holder = runHolder(cycle.teamId), run = holder.run;
      assert.equal(holder.checkHead, run.headCommit);
      const final = Math.max(...run.checks.filter(row => row.revision === run.revision).map(row => row.round ?? 0));
      const rows = run.checks.filter(row => row.phase === undefined && row.revision === run.revision && (row.round ?? 0) === final && row.headCommit === run.headCommit);
      assert.equal(rows.length, 2, "both occurrences of the configured check ran at the reviewed head");
      const [first, second] = rows.map(row => Number(/infinite-metric pid (\d+)/.exec(row.output)?.[1]));
      assert.ok(first && second && first !== second, "the two occurrences ran as two processes");
      const observed = Object.fromEntries((holder.checkObservations ?? []).map(item => [item.name, item]));
      assert.deepEqual(Object.keys(observed).sort(), ["pid", SENTINEL], "stdout of the first occurrence only: no stderr or setup name");
      assert.equal(observed.pid?.value, first, "the first occurrence's number is kept");
      assert.equal(observed[SENTINEL]?.command, commandDigest(check));
      pids.push(first!);
      assert.equal(JSON.stringify(run).includes(QUOTED), false, "no number inside `run`");
    }
    assert.deepEqual(goalHolder.metrics?.entries.map(entry => entry.run), goal.cycles.map(cycle => cycle.teamId));
    assert.equal(JSON.stringify(goalHolder.goal).includes(QUOTED), false, "no number inside `goal`");

    const curve = await api.fetchApi(`/goals/${goal.id}/metrics`);
    assert.equal(curve.status, 200, JSON.stringify(curve.body));
    const view = curve.body as GoalMetricsView;
    const byName = Object.fromEntries(view.series.map(series => [series.name, series]));
    assert.deepEqual(Object.keys(byName).sort(), ["pid", SENTINEL]);
    assert.deepEqual(byName[SENTINEL]!.points.map(point => [point.cycle, point.value]), [[1, 10], [2, 20]]);
    assert.deepEqual(byName.pid!.points.map(point => point.value), pids);
    assert.deepEqual([byName.pid!.configured, byName.pid!.label], [true, `${process.execPath} check.mjs`]);
    assert.deepEqual([view.omittedSeries, view.omittedValues, view.dropped], [0, 0, 0]);
    for (const role of ["controller", "viewer"] as const) {
      const read = await api.fetchApi(`/goals/${goal.id}/metrics`, role);
      assert.equal(read.status, 200, `${role} reads the curve`);
      assert.deepEqual(read.body, view);
    }
    assert.equal((await api.fetchApi(`/goals/${randomUUID()}/metrics`)).status, 404);

    // The sentinel, as a stored name, is in no other read.
    const reads = ["/goals", `/goals/${goal.id}`, "/teams", "/teams?view=list", "/decision-queue", ...goal.cycles.map(cycle => `/teams/${cycle.teamId}`)];
    for (const path of reads) {
      const response = await api.fetchApi(path);
      assert.equal(response.status, 200, path);
      assert.equal(JSON.stringify(response.body).includes(QUOTED), false, `${path} carries a reported number`);
    }
    const members = readdirSync(receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(receipts, name), "utf8")));
    const second = goal.cycles[1]!.teamId;
    const contexts = members.filter(member => member.role === "reviewer" || (member.role === "project-manager" && member.runId === second))
      .map(member => join(member.cwd, ".git", "infinite-team-context.json"));
    assert.ok(contexts.length >= 3, `the reviewers' and the second coordinator's context files: ${contexts.length}`);
    for (const file of contexts) {
      assert.ok(existsSync(file), file);
      const text = readFileSync(file, "utf8");
      JSON.parse(text);
      assert.equal(text.includes(QUOTED), false, `${file} carries a reported number`);
    }
    const evidence = join(state, "evidence");
    assert.ok(existsSync(evidence), "the event store exists");
    for (const name of readdirSync(evidence)) {
      assert.equal(readFileSync(join(evidence, name)).includes(Buffer.from(SENTINEL)), false, `evidence/${name} holds the name in plain bytes`);
    }

    await api.stopApi(); await api.start();
    assert.deepEqual((await api.fetchApi(`/goals/${goal.id}/metrics`, "viewer")).body, view, "the curve is the same after a restart");
  } finally {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
