import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LiveFeed } from "../packages/host/src/live.js";
import { teamListItem } from "../packages/host/src/team-list.js";
import type { TeamModelProfile, TeamView } from "../packages/host/src/team-types.js";
import type { UsageTotals } from "../packages/host/src/usage.js";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

const KIB = 1024, MIB = 1024 * KIB;
const prose = (seed: string, bytes: number) => `${seed} `.repeat(Math.ceil(bytes / (seed.length + 1))).slice(0, bytes);
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const commit = (seed: number) => seed.toString(16).padStart(40, "a");
const totals = (cost: number): UsageTotals => ({ cost, tokens: { input: 52000, output: 9100, reasoning: 2100, cacheRead: 410000, cacheWrite: 12000 }, messages: 38, pricing: { configured: 0, catalog: 38, provider: 0, unknown: 0 } });
const coordinator: TeamModelProfile = { id: "strong-coordinator", label: "Strong coordinator", provider: "claude", model: "example-strong", effort: "high", tier: "strong" };
const implementer: TeamModelProfile = { id: "light-implementer", label: "Light implementer", provider: "codex", model: "example-light", effort: "medium", tier: "light" };
const roles = ["project-manager", "implementer", "implementer", "implementer", "implementer", "implementer", "integrator", "reviewer"] as const;

/** A synthetic finished run shaped like a live one: long check output, member reports, task instructions and an issue body. */
function finishedRun(index: number): TeamView {
  const id = randomUUID(), workspace = `/srv/infinite/teams/${id}`;
  const members = roles.map((role, slot) => ({
    runId: id, memberId: randomUUID(), revision: 1, role, provider: slot ? implementer.provider : coordinator.provider, modelProfile: slot ? implementer : coordinator,
    sessionId: randomUUID(), title: `${role} ${slot + 1}`, status: "reported" as const, cwd: `${workspace}/member-${slot}`, baseCommit: commit(index),
    taskId: role === "implementer" ? `task-${slot}` : undefined, stoppedReason: slot === 6 ? "The provider reported a usage limit." : undefined,
    startedAt: at(slot), reportedAt: at(slot + 20), lastActivityAt: at(slot + 19), cursor: 400 + slot, stopRequestId: randomUUID(),
    report: { kind: "result" as const, summary: prose(`Member ${slot} changed the parser, ran the focused tests and recorded the evidence.`, 6000) }, usage: totals(0.42 + slot),
  }));
  const tasks = Array.from({ length: 12 }, (_, slot) => ({
    id: `task-${slot + 1}`, title: `Task ${slot + 1} of run ${index}`, instructions: prose(`Change module ${slot} and keep its public contract.`, 3000),
    paths: [`src/module-${slot}.ts`, `tests/module-${slot}.test.ts`, `docs/module-${slot}.md`], dependsOn: slot ? [`task-${slot}`] : [],
    revision: 1, status: "integrated" as const, memberId: members[1 + (slot % 5)].memberId, commit: commit(index * 100 + slot),
    summary: prose(`Task ${slot} is integrated. Limitations: none observed.`, 1500), ownerRating: { score: 4 as const, at: at(90) },
    diffStat: { added: 120, removed: 40, files: 3, docs: true, tests: true }, changedPaths: { paths: [`src/module-${slot}.ts`, `tests/module-${slot}.test.ts`], truncated: false },
  }));
  const permissionDecisions = Array.from({ length: 6 }, (_, slot) => ({
    id: randomUUID(), revision: 1, policyHash: commit(slot), targetMemberId: members[1].memberId, targetSessionId: members[1].sessionId, targetCwd: members[1].cwd,
    promptId: slot + 1, promptHash: commit(slot + 10), evidenceHash: commit(slot + 20), option: 1, expiresAt: at(120), answerRequestId: randomUUID(),
    status: "answered" as const, reason: prose("The command reads only files inside the member workspace.", 300),
  }));
  return {
    id, projectId: "rehearsal", provider: "claude", title: `Finished run ${index}`, objective: prose("Make the parser accept the documented grammar.", 5000),
    parallelism: 4, revision: 1, status: "ready-for-review", createdAt: at(index), updatedAt: at(index + 100), workspace, branch: `team/run-${index}`,
    baseCommit: commit(index), headCommit: commit(index + 1), round: 1, reason: "Ready for review.",
    lineup: { coordinator, integrator: coordinator, reviewer: coordinator, implementers: [implementer] },
    goal: { id: randomUUID(), revision: 2, cycle: 3, successCriteria: prose("The grammar suite passes.", 1500), nonGoals: ["No new syntax."], allowedPaths: ["src", "tests"],
      evidence: [prose("Recorded failures from the suite.", 400)], previousWork: [prose("Cycle 2 fixed the lexer.", 400)], deadlineAt: at(600), maxMembers: 40 },
    linear: { status: "synced", checkedAt: at(95), issue: { id: randomUUID(), identifier: `ENG-${100 + index}`, url: `https://linear.example/issue/ENG-${100 + index}`,
      title: `Parser grammar ${index}`, description: prose("The parser refuses documented input.", 6000), state: { name: "In Review", type: "started" }, updatedAt: at(95) } },
    members, tasks, permissionDecisions,
    decisions: [{ id: randomUUID(), memberId: members[0].memberId, revision: 1, question: prose("Should the parser keep the old error text?", 400), options: ["Keep", "Replace"], createdAt: at(30), answer: "Keep", answeredBy: "owner", answeredAt: at(31) }],
    checks: Array.from({ length: 4 }, (_, slot) => ({ command: { command: "npm", args: ["run", `check-${slot}`] }, status: "passed" as const, startedAt: at(60 + slot), finishedAt: at(61 + slot),
      exitCode: 0, output: prose(`ok ${slot} - grammar case passes`, 60 * KIB), revision: 1 })),
    continuations: [{ revision: 1, requestId: randomUUID(), at: at(50), reason: prose("Continue with the remaining grammar cases.", 800), headCommit: commit(index + 2), tasks: tasks.slice(0, 6) }],
    steering: [{ text: prose("Prefer small commits.", 600), revision: 1, at: at(40) }],
    events: Array.from({ length: 40 }, (_, slot) => ({ at: at(slot * 2), text: `Event ${slot}: the host recorded a member report and moved the plan forward.` })),
    review: { verdict: "approved", summary: prose("The change matches the request and the checks pass.", 2000), revision: 1 },
    brief: { title: "Parser grammar", problem: prose("Documented input fails.", 1500), evidence: [{ source: "tests/grammar.test.ts", observation: prose("Three cases fail.", 400) }],
      dataShape: prose("No data change.", 400), acceptance: ["The suite passes."], expectedOutcome: prose("Documented input parses.", 400), uiChanges: false },
    discovery: { revision: 1, summary: prose("Scouts located the failing grammar cases.", 1500), tasks: [], completedAt: at(10) },
    pullRequest: { revision: 1, headCommit: commit(index + 1), pullRequestUrl: `https://git.example/pull/${index}`, summary: prose("Opened for review.", 1000), reportedAt: at(98) },
    deliveryReceipt: { revision: 1, headCommit: commit(index + 1), pullRequestUrl: `https://git.example/pull/${index}`, mergeCommit: commit(index + 3), summary: prose("Merged after review.", 1000), reportedAt: at(99) },
    permissions: { mode: "coordinator", scope: prose("Routine reads and test runs inside the workspace.", 600), maxDecisions: 30 }, permissionsRevokedAt: at(97),
    usage: { total: totals(12.5), byProfile: { [coordinator.id]: totals(4), [implementer.id]: totals(8.5) }, byProvider: { claude: totals(4), codex: totals(8.5) }, unmeasuredMembers: 1, partialMembers: 0 },
    providerLimits: [], workers: { limit: 4, max: 4, running: 0, ready: 0 }, resumable: false, continuable: false,
  };
}

/** `a.b.*.c` reads `c` from every item of the array at `a.b`. */
function read(value: unknown, keys: string[]): unknown {
  if (!keys.length) return value;
  const [key, ...rest] = keys;
  if (key === "*") return Array.isArray(value) ? value.map(item => read(item, rest)) : undefined;
  if (value === null || typeof value !== "object") return undefined;
  const entry: unknown = Object.entries(value).find(([name]) => name === key)?.[1];
  return read(entry, rest);
}
/** Every key path in a JSON value, with array items folded into `*`. */
function paths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap(item => paths(item, `${prefix}.*`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [`${prefix}.${key}`, ...paths(item, `${prefix}.${key}`)]);
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("thirty finished runs list in compact rows far under the relay's response limit", t => {
  const views = Array.from({ length: 30 }, (_, index) => finishedRun(index));
  const full = Buffer.byteLength(JSON.stringify({ teams: views }));
  const rows = Buffer.byteLength(JSON.stringify({ teams: views.map(teamListItem) }));
  t.diagnostic(`30 full views: ${full} bytes; 30 rows: ${rows} bytes (${Math.round(rows / 30)} per run)`);
  assert.ok(full > 4 * MIB, `the fixture reproduces the refused list: ${full} bytes`);
  assert.ok(rows < 30 * 12 * KIB, `rows average under 12 KiB per run: ${rows} bytes`);
});

test("a list row keeps every field client list code reads, unchanged, and nothing the view lacks", () => {
  const view = json(finishedRun(7)), row = json(teamListItem(view));
  const listed = [
    "id", "projectId", "provider", "title", "status", "revision", "parallelism", "createdAt", "updatedAt", "workspace", "branch", "baseCommit", "headCommit",
    "reason", "missionId", "permissionsRevokedAt", "resumable", "continuable", "workers", "decisions", "lineup.coordinator", "goal.id", "goal.revision", "goal.cycle",
    "linear.status", "linear.reason", "linear.checkedAt", "linear.issue.identifier", "linear.issue.url", "linear.issue.title", "linear.issue.state",
    "deliveryReceipt.headCommit", "deliveryReceipt.pullRequestUrl", "deliveryReceipt.mergeCommit", "pullRequest.pullRequestUrl", "review.verdict", "review.revision", "discovery.revision",
    "permissions.mode", "permissions.maxDecisions", "permissionDecisions.*.targetSessionId", "permissionDecisions.*.promptId", "permissionDecisions.*.status",
    "usage.total", "usage.unmeasuredMembers", "checks.*.status", "checks.*.revision",
    ...["memberId", "sessionId", "role", "revision", "title", "status", "taskId", "provider", "startedAt", "reportedAt", "lastActivityAt", "stalledAt", "stoppedReason",
      "pendingLimit", "modelProfile.label", "modelProfile.provider", "modelProfile.tier", "usage.cost"].map(key => `members.*.${key}`),
    ...["id", "title", "status", "paths", "memberId", "changedPaths", "ownerRating"].map(key => `tasks.*.${key}`),
  ];
  for (const key of listed) assert.deepEqual(read(row, key.split(".")), read(view, key.split(".")), key);
  assert.deepEqual(row.events, view.events.slice(-1), "the CLI's list reads the latest history entry");
  const viewPaths = new Set(paths(view));
  assert.deepEqual(paths(row).filter(path => !viewPaths.has(path)), [], "a row adds no field");
  assert.equal(read(row, ["objective"]), undefined);
  assert.equal(read(row, ["checks", "0", "output"]), undefined);
});

test("the live teams topic notifies a refetch instead of sending rows", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let title = "First";
  const feed = new LiveFeed({ sessions: async () => ({}), teams: () => ({ teams: [{ title }] }), session: async () => ({}), events: async () => ({ events: [], cursor: 0, more: false }) });
  const updates: unknown[] = [];
  try {
    const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); };
    feed.subscribe(["teams"], 0, update => updates.push(update));
    await flush();
    title = "Second";
    t.mock.timers.tick(750);
    await flush();
    assert.deepEqual(updates, Array(2).fill({ topic: "refetch", data: { topic: "teams" } }), "each change is a refetch notice; a phone reloads the list or its open run");
  } finally { feed.close(); t.mock.timers.reset(); }
});

test("GET /api/teams answers rows and GET /api/teams/:id keeps the full record", { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const request = f.create();
    const created = await f.host.fetchApi("/teams", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await f.settled(created.body.id)).status, "ready-for-review");
    // Usage is read from the ledger as journals arrive, so compare a list and a detail read taken while the run is still.
    const { row, detail } = await waitFor(async () => {
      const listed = await f.host.fetchApi("/teams");
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      return { row: listed.body.teams.find((team: { id: string }) => team.id === created.body.id), detail: await f.get(created.body.id) };
    }, value => isDeepStrictEqual(value.row, json(teamListItem(value.detail))), 15000);
    assert.equal(row.objective, undefined, "the row leaves the request to the detail route");
    assert.equal(detail.objective, request.objective);
    assert.ok(detail.checks.length > 0 && detail.checks.every(check => typeof check.output === "string"), "the detail keeps check output");
    assert.ok(detail.members.some(member => member.report), "the detail keeps member reports");
    assert.ok(detail.tasks.every(task => typeof task.instructions === "string"), "the detail keeps task instructions");
    assert.ok(Array.isArray(detail.providerLimits) && "byProfile" in detail.usage, "the detail keeps the view's computed fields");
  } finally { await f.close(); }
});
