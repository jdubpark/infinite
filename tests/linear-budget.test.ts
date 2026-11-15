import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { startLinearServer } from "./fixtures/linear-server.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { LinearService } from "../packages/host/src/linear.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { Config } from "../packages/host/src/types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { LinearTrackingView } from "../packages/host/src/linear-types.js";

// The pump runs on real timers while these tests move a mocked Date, so waits count real attempts, not Date.now.
const until = async <T>(read: () => T, accepts: (value: T) => boolean, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("The Linear bridge did not reach the expected state.");
};

async function bridge() {
  const linear = await startLinearServer();
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-budget-"));
  const config = { stateDir: join(root, "state"), linear: { apiKeyFile: join(root, "linear-key"), endpoint: linear.endpoint },
    projects: [{ id: "budget", name: "Budget", path: root, linear: { teamId: linear.teamId } }] } as unknown as Config;
  writeFileSync(config.linear!.apiKeyFile, linear.apiKey, { mode: 0o600 });
  const service = new LinearService(config, randomBytes(32));
  const run = (status: string, goal?: ProductGoal) => ({ id: randomUUID(), projectId: "budget", title: `Run ${status}`, objective: "Implement a bounded task",
    status, revision: 1, members: [], checks: [], steering: [], decisions: [], ...(goal ? { goal: { id: goal.id } } : {}) } as unknown as TeamRun);
  const goal = (status: string) => ({ id: randomUUID(), projectId: "budget", title: `Goal ${status}`, objective: "Keep the fixture healthy", successCriteria: "Checks pass",
    nonGoals: [], allowedPaths: ["src"], maxRuns: 3, maxMinutes: 60, maxMembers: 10, parallelism: 1, evidence: [], steering: [], outcomes: [], cycles: [],
    memberCount: 0, revision: 1, status } as unknown as ProductGoal);
  const reads = (from: number) => linear.calls.slice(from).filter(call => call.operation === "InfiniteLinearIssues");
  const readIds = (from: number) => new Set(reads(from).flatMap(call => call.variables.filter.id.in as string[]));
  return { linear, service, run, goal, reads, readIds, async close() { service.close(); await linear.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a finished item keeps its confirmation for client reads; live items and a goal's active run stay on the gating cadence", { timeout: 60000 }, async t => {
  const b = await bridge();
  try {
    b.service.start();
    const liveGoal = b.goal("running"), doneGoal = b.goal("achieved");
    const live = b.run("implementing", liveGoal), active = b.run("ready-for-review", liveGoal), oldCycle = b.run("no-change", liveGoal), finished = b.run("merged");
    const blocked = b.run("blocked");
    Object.assign(liveGoal, { activeTeamId: active.id });
    const sync = () => {
      for (const goal of [liveGoal, doneGoal]) b.service.updateGoal(goal, true);
      for (const run of [live, active, oldCycle, finished]) b.service.updateTeam(run, true);
      b.service.updateTeam(blocked, true, false);
    };
    // What the web and phone lists do on every poll.
    const clientReads = () => {
      for (const goal of [liveGoal, doneGoal]) b.service.getGoal(goal.id);
      return [live, active, oldCycle, finished, blocked].map(run => b.service.getTeam(run.id)!.status);
    };
    sync();
    await until(clientReads, statuses => statuses.every(status => status === "synced"));
    const issue = (id: string) => b.service.getTeam(id)!.issue!.id;

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(31000);
    const mark = b.linear.calls.length;
    for (let poll = 0; poll < 30; poll++) { sync(); clientReads(); await new Promise(resolve => setTimeout(resolve, 50)); }
    const reread = b.readIds(mark);
    assert.ok(reread.has(issue(live.id)), "a live run is re-read once its gating confirmation lapses");
    assert.ok(reread.has(issue(active.id)), "a finished run its live goal still names as active is re-read: the goal's next step depends on it");
    assert.ok(reread.has(b.service.getGoal(liveGoal.id)!.issue!.id), "a live goal is re-read");
    assert.ok(!reread.has(issue(finished.id)), "a finished standalone run is not re-read because a client looked at it");
    assert.ok(!reread.has(issue(oldCycle.id)), "an earlier cycle of a live goal is not re-read because a client looked at it");
    assert.ok(!reread.has(b.service.getGoal(doneGoal.id)!.issue!.id), "a finished goal is not re-read because a client looked at it");
    assert.ok(reread.has(issue(blocked.id)), "a blocked run keeps the gating age for client reads: the host can restart it by itself");
    assert.equal(b.service.getTeam(finished.id)!.status, "synced", "a client still sees the finished run's recent confirmation");

    // An owner action that starts work from the finished run needs the gating age, and gets it after one read.
    assert.equal(b.service.getTeam(finished.id, true)!.status, "pending");
    const confirmed = await b.service.confirmTeam(finished.id);
    assert.equal(confirmed?.status, "synced");
    assert.ok(b.readIds(mark).has(issue(finished.id)));

    // Past the settled window, a client read refreshes a finished item again.
    t.mock.timers.tick(10 * 60000);
    const later = b.linear.calls.length;
    await until(() => { clientReads(); return b.readIds(later); }, ids => ids.has(issue(oldCycle.id)) && ids.has(b.service.getGoal(doneGoal.id)!.issue!.id));

    // Linear prices a read by its page size, so each read asks for exactly the issues it names.
    for (const call of b.reads(0)) assert.equal(call.variables.first, call.variables.filter.id.in.length);
    assert.deepEqual(b.linear.violations, []);
  } finally { await b.close(); }
});

test("rate-limit headers reach the bridge status; a limited read pauses with its reason and retry time", { timeout: 60000 }, async t => {
  const b = await bridge();
  const warnings = t.mock.method(console, "warn", () => undefined);
  try {
    const hour = Date.now() + 3600000;
    b.linear.responseHeaders({ "x-ratelimit-requests-limit": "2500", "x-ratelimit-requests-remaining": "2400", "x-ratelimit-requests-reset": String(hour),
      "x-ratelimit-complexity-limit": "3000000", "x-ratelimit-complexity-remaining": "2990000", "x-ratelimit-complexity-reset": String(hour), "x-complexity": "8" });
    b.service.start();
    const goal = b.goal("running"), child = b.run("implementing", goal);
    b.service.updateGoal(goal, true); b.service.updateTeam(child, true);
    await until(() => b.service.getTeam(child.id)!.status, status => status === "synced");

    const status = b.service.status();
    assert.deepEqual(status.limits?.requests, { limit: 2500, remaining: 2400, resetAt: new Date(hour).toISOString() });
    assert.deepEqual(status.limits?.complexity, { limit: 3000000, remaining: 2990000, resetAt: new Date(hour).toISOString() });
    assert.equal(status.limits?.lastComplexity, 8);
    assert.ok(status.sentLastHour.requests >= 2 && status.sentLastHour.complexity >= 16, JSON.stringify(status.sentLastHour));
    assert.deepEqual(status.records, { total: 2, gating: 2 });
    assert.equal(status.pausedUntil, undefined);
    const published = JSON.stringify(status);
    assert.ok(!published.includes(b.linear.apiKey) && !published.includes("Run implementing") && !published.includes("TEST-"), "the status carries no key and no issue content");

    // Retry-After is Linear's own wait; a complexity reset an hour away does not stretch it.
    const limit = (headers: Record<string, string>) => {
      b.linear.rateLimitReads(headers);
      child.members.push({ memberId: randomUUID(), status: "queued" } as TeamRun["members"][number]);
      b.service.updateTeam(child, true);
      return until(() => b.service.getTeam(child.id)!, view => Boolean(view.retryAt) && view.retryAt !== previous);
    };
    let previous: string | undefined;
    const started = Date.now();
    let view: LinearTrackingView = await limit({ "retry-after": "120", "x-ratelimit-complexity-remaining": "2990000", "x-ratelimit-complexity-reset": String(started + 55 * 60000) });
    assert.ok(Math.abs(Date.parse(view.retryAt!) - (started + 120000)) < 5000, view.retryAt);
    assert.ok(["error", "pending"].includes(view.status));
    assert.equal(view.reason, `Linear is rate-limiting this host's requests. Tracking retries at ${view.retryAt}; execution waits until Linear confirms current requirements.`);
    assert.equal(b.service.status().pausedUntil, view.retryAt);
    assert.deepEqual({ ...b.service.status().lastRateLimit, at: undefined },
      { at: undefined, operation: "InfiniteLinearIssues", httpStatus: 429, retryAfterSeconds: 120, waitSeconds: 120, shared: true });
    assert.equal(warnings.mock.callCount(), 1);
    const line = String(warnings.mock.calls[0].arguments[0]);
    assert.match(line, /^Linear rate limit on InfiniteLinearIssues \(HTTP 429\): the host's Linear requests pause until /);
    assert.match(line, /This host sent \d+ requests \(\d+ complexity points reported\) in the last hour\.$/);
    assert.ok(!line.includes(b.linear.apiKey));

    // Without Retry-After, only the spent limit's reset counts.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(125000);
    previous = view.retryAt;
    let now = Date.now();
    view = await limit({ "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": String(now + 3 * 60000),
      "x-ratelimit-complexity-remaining": "2990000", "x-ratelimit-complexity-reset": String(now + 50 * 60000) });
    assert.ok(Math.abs(Date.parse(view.retryAt!) - (now + 3 * 60000)) < 2000, view.retryAt);

    // A spent limit an hour from reset still probes again within five minutes.
    t.mock.timers.tick(3 * 60000 + 5000);
    previous = view.retryAt; now = Date.now();
    view = await limit({ "x-ratelimit-complexity-remaining": "0", "x-ratelimit-complexity-reset": String(now + 50 * 60000) });
    assert.ok(Math.abs(Date.parse(view.retryAt!) - (now + 5 * 60000)) < 2000, view.retryAt);
    assert.match(b.service.getTeam(child.id)!.reason!, /rate-limiting/);

    // Once Linear answers again, tracking syncs and the pause leaves the view.
    b.linear.rateLimitReads(undefined);
    t.mock.timers.tick(5 * 60000 + 5000);
    view = await until(() => b.service.getTeam(child.id)!, value => value.status === "synced");
    assert.equal(view.retryAt, undefined);
    assert.equal(view.reason, undefined);
    assert.equal(b.service.status().pausedUntil, undefined);
    assert.deepEqual(b.linear.violations, []);
  } finally { await b.close(); }
});

test("continuing a finished run needs a current Linear confirmation, not the older one a client sees", { timeout: 30000 }, async () => {
  const fixture = schedulerFixture();
  fixture.run.status = "blocked"; fixture.run.members = []; fixture.run.linearTracking = true; fixture.run.linear = { status: "synced" };
  fixture.writeTeam();
  let current: LinearTrackingView = { status: "pending", reason: "Waiting for Linear to confirm current requirements and execution evidence." };
  let confirmations = 0;
  const passive: LinearTrackingView = { status: "synced" };
  const linear = {
    updateTeam: () => passive, updateGoal: () => undefined, getGoal: () => undefined,
    getTeam: (_id: string, wantsCurrent = false) => wantsCurrent ? current : passive,
    confirmTeam: async () => { confirmations++; return current; },
  } as unknown as LinearService;
  const teams = fixture.openTeam({ linear });
  try {
    await assert.rejects(teams.continueRun(fixture.run.id, { requestId: randomUUID(), revision: fixture.run.revision }),
      (error: unknown) => error instanceof TeamError && error.code === "linear-reconciliation-required");
    assert.equal(confirmations, 1, "the action asked Linear for a current confirmation first");
    current = { status: "synced" };
    // With a current confirmation the Linear gate passes, and the run's own continuation rules answer.
    await assert.rejects(teams.continueRun(fixture.run.id, { requestId: randomUUID(), revision: fixture.run.revision }),
      (error: unknown) => error instanceof TeamError && error.code !== "linear-reconciliation-required");
  } finally { teams.close(); fixture.close(); }
});
