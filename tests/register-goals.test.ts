import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost, type Host } from "./helpers.js";
import type { CreateGoal, GoalCycle } from "../packages/host/src/goal-types.js";
import type { TeamLineup, TeamCommand } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { ratingStamp } from "../packages/host/src/objective-goals.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/**
 * A host whose project has the objective switches set as given. The server fixture of `goals.test.ts` is local to that
 * file and takes no register switch, so this copies its minimum: a source repository, the `no-change` goal agent, and
 * the same create body. `restart` rewrites the switches and restarts the API, as `goals.test.ts` does for its sync home.
 */
async function fixture(objective: { prompts: "on" | "off"; register: "on" | "off" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-register-goal-")));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));',
    'assert.deepEqual(Object.keys(progress), ["completed"]);',
    'assert.ok(Number.isInteger(progress.completed) && progress.completed >= 1 && progress.completed <= 2);',
  ].join("\n"));
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial goal fixture");
  const command: TeamCommand = { command: process.execPath, args: ["check.mjs"] };
  let host: Host;
  try {
    host = await startHost({ agents: {
      claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "claude"] },
      codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "codex"] },
    }, config: {
      teams: { workspaceDir: join(root, "teams"), lineup, publishHeads: false },
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [command], objective: { ...objective, intentCheck: "off" as const } } }],
    } });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const create = (extra: Partial<CreateGoal> = {}): CreateGoal => ({ requestId: randomUUID(), projectId: "rehearsal", title: "Improve the progress flow",
    objective: "Build two small progress improvements using the existing data", successCriteria: "Two useful progress steps are available",
    nonGoals: ["Publishing or changing files outside the feature directory"], allowedPaths: ["features"],
    evidence: ["The fixture progress data starts at zero"], maxRuns: 3, maxMinutes: 5, maxMembers: 12, parallelism: 2, ...extra });
  const restart = async (next: { prompts: "on" | "off"; register: "on" | "off" }) => {
    const project = host.config.projects[0]!;
    project.team = { ...project.team!, objective: { ...next, intentCheck: "off" } } as Config["projects"][number]["team"];
    await host.stopApi();
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.start();
  };
  const close = async () => {
    try {
      for (const value of (await host.fetchApi("/goals")).body.goals ?? [])
        if (value.status !== "cancelled") await host.fetchApi(`/goals/${value.id}/cancel`, "owner", { requestId: randomUUID(), revision: value.revision });
    } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
  };
  return { host, create, restart, close };
}

test("owner results take the owner route only", { timeout: 120000 }, async () => {
  const f = await fixture({ prompts: "on", register: "on" });
  try {
    const created = await f.host.fetchApi("/goals", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id;
    const record = await f.host.fetchApi(`/goals/${id}/record`, "viewer");
    assert.equal(record.status, 200, JSON.stringify(record.body));
    const body = { requestId: randomUUID(), version: record.body.version, ops: [{ op: "assumption.set", id: "a9", status: "verified" }] };

    // The owner passes the role and the gate; the id is missing, so the op is refused by name.
    const missing = await f.host.fetchApi(`/goals/${id}/record`, "owner", body);
    assert.equal(missing.status, 409, JSON.stringify(missing.body));
    assert.equal(missing.body.code, "objective-assumption-target");
    assert.equal((await f.host.fetchApi(`/goals/${id}/record`, "controller", { ...body, requestId: randomUUID() })).status, 403);
    assert.equal((await f.host.fetchApi(`/goals/${id}/record`, "viewer", { ...body, requestId: randomUUID() })).status, 403);

    // Register off: a register op is refused before it is applied. Prompts are still on.
    await f.restart({ prompts: "on", register: "off" });
    const off = await f.host.fetchApi(`/goals/${id}/record`, "owner", { ...body, requestId: randomUUID() });
    assert.equal(off.status, 409, JSON.stringify(off.body));
    assert.equal(off.body.code, "objective-register-off");

    // Prompts off, register on: a criterion op is refused by its own switch, also beside a register op.
    await f.restart({ prompts: "off", register: "on" });
    const retire = await f.host.fetchApi(`/goals/${id}/record`, "owner", {
      requestId: randomUUID(), version: record.body.version, ops: [{ op: "criterion.retire", id: "c1" }, { op: "assumption.set", id: "a9", status: "verified" }],
    });
    assert.equal(retire.status, 409, JSON.stringify(retire.body));
    assert.equal(retire.body.code, "objective-prompts-off");
  } finally { await f.close(); }
});

test("a rating needs a reviewed cycle", { timeout: 120000 }, async () => {
  // The stamp is the latest reviewed cycle's head: ready-for-review and merged count, the rest do not.
  const cycle = (value: number, status: string, headCommit?: string) => ({ cycle: value, status, teamId: randomUUID(), goalRevision: 1, startedAt: "2026-11-18T10:00:00.000Z", memberCount: 1, ...(headCommit ? { headCommit } : {}) }) as GoalCycle;
  assert.deepEqual(ratingStamp({ cycles: [cycle(1, "blocked"), cycle(2, "ready-for-review", "H1"), cycle(3, "no-change"), cycle(4, "merged", "H4")] }), { commit: "H4", cycle: 4 });
  assert.equal(ratingStamp({ cycles: [cycle(1, "blocked"), cycle(2, "no-change")] }), undefined);
  assert.equal(ratingStamp({ cycles: [cycle(1, "ready-for-review")] }), undefined, "a reviewed cycle with no head is no stamp");
  assert.equal(ratingStamp({ cycles: [] }), undefined);

  // The route: a rating with no reviewed cycle is refused by name. The goal has an owner-rating criterion on quality.
  const f = await fixture({ prompts: "on", register: "on" });
  try {
    const criterion = { statement: "The quality rating reaches three", check: { kind: "owner-rating", subject: "quality" }, threshold: { kind: "score", min: 3, of: 5 } };
    const created = await f.host.fetchApi("/goals", "owner", f.create({ criteria: [criterion] } as Partial<CreateGoal>));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const record = await f.host.fetchApi(`/goals/${created.body.id}/record`, "viewer");
    assert.equal(record.status, 200, JSON.stringify(record.body));
    const rated = await f.host.fetchApi(`/goals/${created.body.id}/record`, "owner", { requestId: randomUUID(), version: record.body.version, ops: [{ op: "rating.record", subject: "quality", score: 3.5 }] });
    assert.equal(rated.status, 409, JSON.stringify(rated.body));
    assert.equal(rated.body.code, "objective-rating-no-head");
  } finally { await f.close(); }
});
