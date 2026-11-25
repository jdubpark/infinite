import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { waitFor } from "./helpers.js";
import { fixture, git } from "./team-fixture.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import type { CaptureSink, Capsule, EvalFeatures } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import { DEFAULT_TEAM_RETENTION } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";

const LAUNCHER = resolve("tests/fixtures/eval-command.mjs");
const TRIAL_AGENT = resolve("tests/fixtures/trial-agent.mjs");
const profile: TeamModelProfile = { id: "trial-member", label: "Trial member", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const features: EvalFeatures = { role: "implementer", area: "docs", kind: null, risk: "normal", featureVersion: 1 };
const capsule = (objective: string, ownerAnswers: Capsule["ownerAnswers"] = []): Capsule => ({ objective, steering: ["Keep the change small."], ownerAnswers,
  task: { id: "a", title: "Write a.txt", instructions: "Write a.txt with the reviewed content.", paths: ["a.txt"] } });

async function replayFixture(options: { capture?: CaptureSink } = {}) {
  const f = await fixture("success", undefined, {}, { trustWorkspaces: true });
  const evalRoot = join(f.host.root, "eval");
  const home = join(evalRoot, "home"), template = join(evalRoot, "template"), tmp = join(evalRoot, "tmp");
  for (const directory of [join(evalRoot, "trials"), home, template, tmp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reference = join(evalRoot, "reference");
  mkdirSync(reference, { recursive: true });
  writeFileSync(join(reference, "a.txt"), "Reviewed content\n");
  const record = join(f.receipts, "eval-commands.jsonl");
  f.host.config.eval = { member: {
    prefix: { command: process.execPath, args: [LAUNCHER, "--root", evalRoot, "--home", home, "--template", template, "--tmp", tmp, "--record", record] },
    root: evalRoot,
    agents: { claude: { command: process.execPath, args: [TRIAL_AGENT, f.receipts] } },
  } } as Config["eval"];
  const events: unknown[] = [];
  const outbox = { flush(items: unknown[]) { events.push(...items); return { stored: true }; }, advance() { return { pending: false, blocked: [] }; } } as unknown as EventOutbox;
  let manager: Manager | undefined;
  const service = await f.openTeamService({ events: outbox, ...(options.capture ? { capture: options.capture } : {}), manager: m => { manager = m; } });
  const start = async (mode: string, objective = "Write a.txt for the replay trial.", ownerAnswers: Capsule["ownerAnswers"] = []) => {
    const trialId = randomUUID(), work = join(evalRoot, "trials", trialId, "work");
    mkdirSync(join(evalRoot, "trials", trialId), { recursive: true, mode: 0o700 });
    git(evalRoot, "clone", "--quiet", f.source, work);
    writeFileSync(join(f.receipts, `${trialId}.mode`), JSON.stringify({ mode, dir: reference }), { mode: 0o600 });
    const created = await service.createForReplay({ trialId, jobId: randomUUID(), purpose: "replay", projectId: "rehearsal", profile,
      capsule: capsule(objective, ownerAnswers), features, baseCommit: f.base, workspace: work });
    return { trialId, work, created };
  };
  const ended = (trialId: string) => waitFor(() => service.replayState(trialId), state => state?.phase === "ended", 90000);
  return { f, service, start, ended, events, record, evalRoot, getManager: () => manager! };
}

test("a replay run is seeded and starts one implementer", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const { trialId, work, created } = await context.start("empty", "Write a.txt for the replay trial.");
    assert.equal(created.runId, trialId);
    assert.equal((await context.service.createForReplay({ trialId, jobId: "again", purpose: "replay", projectId: "rehearsal", profile,
      capsule: capsule("Write a.txt for the replay trial."), features, baseCommit: context.f.base, workspace: work })).runId, trialId);
    const state = await waitFor(() => context.service.replayState(trialId), value => value?.memberId !== undefined, 90000);
    assert.equal(state?.memberId !== undefined, true);
    await context.ended(trialId);
    const kinds = context.events.map(item => item as { kind: string; data: Record<string, unknown>; runId: string });
    const forRun = kinds.filter(item => item.runId === trialId);
    const created1 = forRun.find(item => item.kind === "run.created");
    assert.equal(created1?.data.purpose, "replay");
    assert.equal(created1?.data.trialId, trialId);
    assert.equal(forRun.filter(item => item.kind === "run.created").length, 1, "the second call emits nothing");
    assert.equal(forRun.find(item => item.kind === "plan.accepted")?.data.taskCount, 1);
    assert.equal(forRun.filter(item => item.kind === "task.planned").length, 1);
    assert.deepEqual(forRun.find(item => item.kind === "task.planned")?.data.features, features);
    assert.equal(forRun.find(item => item.kind === "member.started")?.data.purpose, "replay");
    assert.equal(forRun.find(item => item.kind === "member.configured")?.data.shape, "trial");
    assert.match(readFileSync(join(work, ".git", "infinite-team-context.json"), "utf8"), /Write a\.txt for the replay trial\./);
    assert.equal((await context.getManager().list()).some(row => row.purpose === "replay"), true);
  } finally {
    await context.f.close();
  }
});

test("a replay run whose capsule holds an owner answer runs its member", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const { trialId, work } = await context.start("reference", "Write a.txt for the replay trial.", [{ question: "Which style?", answer: "Compact" }]);
    const state = await context.ended(trialId);
    assert.equal(state?.ending, "settled");
    assert.equal(state?.memberId !== undefined, true, "the member started");
    const written = JSON.parse(readFileSync(join(work, ".git", "infinite-team-context.json"), "utf8")) as { ownerAnswers?: unknown };
    assert.deepEqual(written.ownerAnswers, [{ decisionId: "answer-1", question: "Which style?", answer: "Compact" }], "the answer reaches the member's context");
  } finally {
    await context.f.close();
  }
});

test("a replay run reaches no client", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const { trialId } = await context.start("limit");
    await waitFor(() => context.service.replayState(trialId), value => value?.memberId !== undefined, 90000);
    assert.equal(context.service.list().some(view => view.id === trialId), false);
    assert.equal(context.service.statuses().some(row => row.id === trialId), false);
    assert.equal(context.service.understandingRecords().some(record => record.id === trialId), false);
    assert.equal(context.service.activeForProject("rehearsal"), false);
    const purposes = await waitFor(async () => (await context.getManager().list()).map(row => row.purpose), rows => rows.includes("replay"), 30000).catch(async () => (await context.getManager().list()).map(row => row.purpose));
    assert.ok(purposes.includes("replay"), `the member's session carries the replay purpose, saw ${JSON.stringify(purposes)}`);
    await assert.rejects(async () => context.service.get(trialId), error => (error as { status?: number; code?: string }).code === "team-not-found");
    assert.throws(() => context.service.objectiveRecord(trialId), error => (error as { code?: string }).code === "team-not-found");
    const missing = (error: unknown) => (error as { code?: string }).code === "team-not-found";
    await assert.rejects(async () => context.service.removeRun(trialId), missing, "delete");
    await assert.rejects(async () => context.service.bundle(trialId), missing, "bundle");
    await assert.rejects(async () => context.service.rateTask(trialId, "t1", { requestId: randomUUID(), score: 5 }), missing, "rating");
    await assert.rejects(async () => context.service.revokePermissions(trialId, { requestId: randomUUID(), revision: 1 }), missing, "revoke");
    assert.equal((await context.service.replayState(trialId))?.phase, "running", "the trial still runs after the refused calls");
    await context.ended(trialId);
    assert.deepEqual(context.service.providerLimits(), [], "a replay run's limit notice never reaches the provider limits");
  } finally {
    await context.f.close();
  }
});

test("every member ending ends the trial with its name", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  context.f.host.config.teams!.stallMinutes = 0.05;
  try {
    const expected: Array<[string, string]> = [["question", "question"], ["blocked", "blocked"], ["escalate", "escalated"],
      ["silent", "no-result"], ["stall", "stalled"], ["limit", "void-limit"], ["permission", "permission"], ["outside", "scope-violation"]];
    for (const [mode, ending] of expected) {
      const { trialId } = await context.start(mode);
      const state = await context.ended(trialId);
      assert.equal(state?.ending, ending, `mode ${mode}`);
    }
    const owner = await context.start("stall");
    await waitFor(() => context.service.replayState(owner.trialId), value => value?.memberId !== undefined, 90000);
    await context.service.endReplay(owner.trialId, "void-owner");
    assert.equal((await context.ended(owner.trialId))?.ending, "void-owner");
    const empty = await context.start("empty");
    assert.equal((await context.ended(empty.trialId))?.resultCommit, undefined, "an empty result settles without a commit");
    const reference = await context.start("reference");
    const settled = await context.ended(reference.trialId);
    assert.equal(settled?.ending, "settled");
    assert.match(settled?.resultCommit ?? "", /^[0-9a-f]{40}$/, "a reference result settles with its commit");
    const memberContext = JSON.parse(readFileSync(join(reference.work, ".git", "infinite-team-context.json"), "utf8")) as Record<string, unknown>;
    assert.equal(memberContext.scratchDirectory, undefined, "no scratch directory is assigned to a trial member");
    context.f.host.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 0 };
    const kept = await context.start("question");
    assert.equal((await context.ended(kept.trialId))?.ending, "question");
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal((await context.service.replayState(kept.trialId))?.ending, "question", "the ended trial's record is still there");
    assert.equal(existsSync(kept.work), true, "the ended trial's workspace is still there");
  } finally {
    await context.f.close();
  }
});

test("a trials root that another account can write starts no member", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    chmodSync(join(context.evalRoot, "trials"), 0o770);
    const { trialId } = await context.start("reference");
    const state = await context.ended(trialId);
    assert.equal(state?.ending, "void-host");
    assert.equal(state?.memberId, undefined, "no member was launched");
    chmodSync(join(context.evalRoot, "trials"), 0o700);
    const again = await context.start("reference");
    assert.equal((await context.ended(again.trialId))?.ending, "settled", "the same root with a private mode runs the trial");
  } finally {
    await context.f.close();
  }
});

test("a stopped replay run ignores late completions", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const { trialId } = await context.start("reference");
    await waitFor(() => context.service.replayState(trialId), value => value?.memberId !== undefined, 90000);
    await context.service.endReplay(trialId, "void-owner");
    const state = await context.ended(trialId);
    assert.equal(state?.ending, "void-owner");
    await new Promise(resolve => setTimeout(resolve, 3000));
    const after = await context.service.replayState(trialId);
    assert.equal(after?.ending, "void-owner");
    assert.equal(after?.resultCommit, undefined);
    await context.service.endReplay(trialId, "void-host");
    assert.equal((await context.service.replayState(trialId))?.ending, "void-owner", "a second ending does not replace the first");
    assert.equal(context.events.some(item => (item as { runId: string; kind: string }).runId === trialId && (item as { kind: string }).kind === "task.integrated"), false);
  } finally {
    await context.f.close();
  }
});

test("replay commands run as the eval identity", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    context.f.host.config.projects.find(project => project.id === "rehearsal")!.team!.setup = { command: process.execPath, args: ["-e", ""] };
    const { trialId } = await context.start("reference");
    await context.ended(trialId);
    const commands = existsSync(context.record) ? readFileSync(context.record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; cwd: string }) : [];
    assert.ok(commands.length > 0, "the eval launcher ran the run's commands");
    for (const command of commands) assert.ok(command.argv.includes("exec") || command.argv.includes("setup"), command.argv.join(" "));
    assert.ok(commands.some(command => command.argv[0] === "setup"), "the setup command ran through the eval launcher");
    const teamCommands = join(context.f.receipts, "commands.jsonl");
    assert.equal(existsSync(teamCommands) ? readFileSync(teamCommands, "utf8").includes(trialId) : false, false);
    const removed = await waitFor(() => context.service.forgetReplay(trialId), value => value === true, 90000);
    assert.equal(removed, true);
    assert.equal(existsSync(join(context.f.host.config.stateDir, "teams", `${trialId}.sealed`)), false, "the record is gone, with no tombstone");
  } finally {
    await context.f.close();
  }
});

test("a replay run never acts on the world outside its workspace", { timeout: 120000 }, async () => {
  const integrated: unknown[] = [];
  const capture = { enabled: () => true, integrated: (start: unknown) => { integrated.push(start); }, approved: () => {} } as unknown as CaptureSink;
  const context = await replayFixture({ capture });
  try {
    context.f.host.config.projects.find(project => project.id === "rehearsal")!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
    const manager = context.getManager() as unknown as { createTeamSession: (...args: unknown[]) => Promise<unknown> };
    const original = manager.createTeamSession.bind(manager);
    const launches: unknown[][] = [];
    manager.createTeamSession = (...args: unknown[]) => { launches.push(args); return original(...args); };
    const { trialId } = await context.start("reference");
    const state = await context.ended(trialId);
    assert.equal(state?.ending, "settled");
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.ok(launches.length > 0, "the member was launched");
    for (const launch of launches) assert.equal(launch[7], undefined, "a replay member gets no GitHub grant scope");
    assert.deepEqual(integrated, [], "a replay result is not captured as an integrated task");
    const teamCommands = join(context.f.receipts, "commands.jsonl");
    assert.equal(existsSync(teamCommands) ? readFileSync(teamCommands, "utf8").includes(trialId) : false, false, "no push or save ran through the team prefix");
    assert.equal(await waitFor(() => context.service.forgetReplay(trialId), value => value === true, 90000), true);
    assert.equal(existsSync(join(context.f.host.config.stateDir, "teams", "retired.sealed")), false, "forgetting a replay run leaves no deletion tombstone");
  } finally {
    await context.f.close();
  }
});

function leavingAgent(context: Awaited<ReturnType<typeof replayFixture>>): unknown[] {
  const handled: unknown[] = [];
  context.service.usePermissionAgent({
    delivery: { addSource: () => () => {}, handle: async (target: unknown) => { handled.push(target); return { handled: false }; } },
    pipeline: { serves: () => ({ served: true }), taskEnded: () => {} },
  } as never);
  return handled;
}

test("a replay run's permission hand-off reads the member's changes as the eval identity", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const handled = leavingAgent(context);
    const { trialId } = await context.start("permission");
    assert.equal((await context.ended(trialId))?.ending, "permission");
    assert.ok(handled.length > 0, "the dialog was handed to the permission agent first");
    const teamCommands = join(context.f.receipts, "commands.jsonl");
    assert.equal(existsSync(teamCommands) ? readFileSync(teamCommands, "utf8").includes(trialId) : false, false, "the hand-off ran no command through the team prefix");
  } finally {
    await context.f.close();
  }
});

test("a replay run holds a dialog that only a hook has reported, for a bounded time", { timeout: 120000 }, async () => {
  const context = await replayFixture();
  try {
    const handled = leavingAgent(context);
    const late = await context.start("permission-late");
    assert.equal((await context.ended(late.trialId))?.ending, "permission");
    assert.equal(handled.length > 0, true, "the trial waited for the screen to show the dialog, and the permission agent was asked");
    handled.length = 0;
    const unread = await context.start("permission-unread");
    assert.equal((await context.ended(unread.trialId))?.ending, "permission", "a dialog the screen never shows does not hold the trial");
    assert.equal(handled.length, 0, "and it is never handed to the permission agent");
  } finally {
    await context.f.close();
  }
});
