import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { waitFor } from "./helpers.js";
import { fixture, git } from "./team-fixture.js";
import { sessionAgentProfile } from "../packages/host/src/launch.js";
import { sessionEgressIdentity } from "../packages/host/src/egress.js";
import { judgePackage, writeJudgePackage } from "../packages/host/src/judge-package.js";
import { judgePrompt } from "../packages/host/src/judge-prompt.js";
import { refreshReportingInstructions } from "../packages/host/src/team-prompts.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import type { TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";

const LAUNCHER = resolve("tests/fixtures/eval-command.mjs");
const JUDGE_AGENT = resolve("tests/fixtures/judge-agent.mjs");
// Distinctive names that must never reach a byte the judge reads.
const profile: TeamModelProfile = { id: "zz-judge-profile", label: "Label Zed", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const patch = (marker: string) => Buffer.from(`diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${marker}\n`);

type Stored = { run: TeamRun };
const runOf = (service: TeamService, runId: string) => (service as unknown as { records: Map<string, Stored> }).records.get(runId)!.run;

/** A real service over a fixture project, with the eval identity configured as the same-user launcher and the fake judge. */
async function judgeFixture() {
  const f = await fixture("success", undefined, {}, { trustWorkspaces: true });
  const evalRoot = join(f.host.root, "eval");
  const home = join(evalRoot, "home"), template = join(evalRoot, "template"), tmp = join(evalRoot, "tmp");
  for (const directory of [join(evalRoot, "trials"), home, template, tmp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = join(f.receipts, "eval-commands.jsonl");
  f.host.config.eval = { member: {
    prefix: { command: process.execPath, args: [LAUNCHER, "--root", evalRoot, "--home", home, "--template", template, "--tmp", tmp, "--record", record] },
    root: evalRoot,
    agents: { claude: { command: process.execPath, args: [JUDGE_AGENT, f.receipts] } },
  } } as Config["eval"];
  const events: unknown[] = [];
  const outbox = { flush(items: unknown[]) { events.push(...items); return { stored: true }; }, advance() { return { pending: false, blocked: [] }; } } as unknown as EventOutbox;
  let manager: Manager | undefined;
  const service = await f.openTeamService({ events: outbox, manager: m => { manager = m; } });
  /** A judge run over a clone of the fixture project, holding a package of two patches. `mode` is the fixture judge's behavior. */
  const start = async (mode: string, options: { judgeMinutes?: number; resolvedMarker?: boolean } = {}) => {
    const duelId = randomUUID(), work = join(evalRoot, "trials", duelId, "work");
    mkdirSync(join(evalRoot, "trials", duelId), { recursive: true, mode: 0o700 });
    git(evalRoot, "clone", "--quiet", f.source, work);
    writeFileSync(join(f.receipts, `${duelId}.mode`), JSON.stringify({ mode }), { mode: 0o600 });
    const gate = { scope: "pass", checks: "skipped" } as const;
    const files = judgePackage({
      a: { patch: patch(options.resolvedMarker ? "SOMETHING-ELSE" : "AAA"), gate }, b: { patch: patch(options.resolvedMarker ? "RESOLVED-MARKER" : "BBB"), gate },
      task: { title: "Write a.txt", instructions: "Write a.txt with the reviewed content.", paths: ["a.txt"], acceptance: ["a.txt exists"] },
    })!;
    await writeJudgePackage(realpathSync(work), files, undefined);
    const created = await service.createForReplay({ purpose: "duel", trialId: duelId, jobId: randomUUID(), projectId: "rehearsal", profile,
      baseCommit: f.base, workspace: work, steering: ["Keep the change small."], ownerAnswers: [{ question: "Which style?", answer: "Compact" }],
      judgeMinutes: options.judgeMinutes ?? 10 });
    return { duelId, work, created };
  };
  const ended = (duelId: string) => waitFor(() => service.replayState(duelId), state => state?.phase === "ended", 90000);
  return { f, service, start, ended, events, record, evalRoot, getManager: () => manager! };
}

test("a judge run starts one judge with the judge prompt", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId, created } = await context.start("prefer-a");
    assert.equal(created.runId, duelId);
    await context.ended(duelId);
    const run = runOf(context.service, duelId);
    assert.equal(run.members.length, 1);
    assert.equal(run.members[0]!.role, "judge");
    assert.equal(run.members[0]!.prompt, refreshReportingInstructions(judgePrompt("claude"), "claude", "judge"));
    const forRun = context.events.map(item => item as { kind: string; data: Record<string, unknown>; runId: string }).filter(item => item.runId === duelId);
    assert.equal(forRun.find(item => item.kind === "member.started")?.data.purpose, "duel");
    assert.deepEqual(forRun.find(item => item.kind === "run.created")?.data, { v: 1, projectId: "rehearsal", purpose: "duel", trialId: duelId });
    assert.equal(forRun.some(item => item.kind === "plan.accepted" || item.kind === "task.planned"), false, "a judge run plans no task");
    assert.equal(run.tasks.length, 0);
  } finally {
    await context.f.close();
  }
});

test("the judge's context file and package carry no identity", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("prefer-a");
    await context.ended(duelId);
    const run = runOf(context.service, duelId), member = run.members[0]!;
    const readDir = join(context.f.receipts, duelId, "read");
    const names = readdirSync(readDir).filter(name => !name.startsWith("."));
    for (const name of ["context.json", "package.A.patch", "package.B.patch", "package.task.json", "package.gate.json"]) assert.ok(names.includes(name), `the judge read ${name}`);
    const forbidden = [profile.id, profile.label, member.memberId, member.sessionId, "Codex", "OpenCode"];
    for (const name of names) {
      const text = readFileSync(join(readDir, name), "utf8");
      for (const word of forbidden) assert.equal(text.includes(word), false, `${name} holds ${word}`);
    }
    const context1 = JSON.parse(readFileSync(join(readDir, "context.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(context1).sort(), ["baseCommit", "duelId", "kind", "memberBaseCommit", "ownerAnswers", "package", "revision", "runId", "steering"],
      "Ruling 4's keys and the one key every launch adds; the host assigns no scratch directory to an eval member, so that key is absent");
    assert.equal(context1.assignment, undefined);
    assert.equal(context1.kind, "judge-context");
    assert.equal(context1.package, ".git/infinite-judge");
    assert.equal(context1.duelId, duelId);
    assert.equal(context1.baseCommit, context.f.base);
    assert.deepEqual(context1.steering, ["Keep the change small."]);
    assert.deepEqual(context1.ownerAnswers, [{ question: "Which style?", answer: "Compact" }]);
    const task = JSON.parse(readFileSync(join(readDir, "package.task.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(task).sort(), ["acceptance", "instructions", "paths", "title"]);
    // The session title and the stored prompt are fixed text too.
    assert.equal(member.prompt.includes(profile.label), false);
    assert.equal(member.prompt.includes(profile.id), false);
  } finally {
    await context.f.close();
  }
});

test("an accepted judgement ends the run judged", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("prefer-a");
    const state = await context.ended(duelId);
    assert.equal(state?.ending, "judged");
    const scores = { correctness: 4, cleanliness: 3, extensibility: 3, docs: 2 };
    assert.deepEqual(state?.judgement, { preferred: "A", rubric: { a: scores, b: { ...scores, correctness: 2 } } });
    assert.equal(JSON.stringify(state).includes("fixture"), false, "the judge's summary is not kept in the state");
    assert.equal((await context.service.replayState(duelId))?.ending, "judged", "the first ending stands");
  } finally {
    await context.f.close();
  }
});

test("a judge that picks the resolved patch is read as that label", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("prefer-resolved", { resolvedMarker: true });
    const state = await context.ended(duelId);
    assert.equal(state?.judgement?.preferred, "B");
  } finally {
    await context.f.close();
  }
});

test("a changed working copy ends the run changed", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("edit");
    const state = await context.ended(duelId);
    assert.equal(state?.ending, "changed");
    assert.equal(state?.judgement, undefined);
  } finally {
    await context.f.close();
  }
});

test("a wrong duel ID ends the run mismatch", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("wrong-id");
    const state = await context.ended(duelId);
    assert.equal(state?.ending, "mismatch");
    assert.equal(state?.judgement, undefined);
  } finally {
    await context.f.close();
  }
});

test("a late judgement ends the run timeout", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    // 0.001 minutes is 60 ms: the fixture judge waits 1.5 s before it reports.
    const { duelId } = await context.start("late", { judgeMinutes: 0.001 });
    const state = await context.ended(duelId);
    assert.equal(state?.ending, "timeout");
    assert.equal(state?.judgement, undefined);
  } finally {
    await context.f.close();
  }
});

test("a judge run never starts a second member", { timeout: 180000 }, async () => {
  const context = await judgeFixture();
  context.f.host.config.teams!.stallMinutes = 0.05;
  try {
    const expected: Array<[string, string]> = [["exit", "no-result"], ["question", "question"], ["permission", "permission"], ["hang", "stalled"]];
    for (const [mode, ending] of expected) {
      const { duelId } = await context.start(mode);
      const state = await context.ended(duelId);
      assert.equal(state?.ending, ending, `mode ${mode}`);
      // Three more passes of the service's step: nothing may start.
      await new Promise(resolve => setTimeout(resolve, 3000));
      const run = runOf(context.service, duelId);
      assert.equal(run.members.length, 1, `mode ${mode} holds one member`);
      assert.equal(run.members.some(member => member.role === "project-manager"), false, `mode ${mode} starts no project manager`);
      assert.equal((await context.service.replayState(duelId))?.ending, ending, `mode ${mode} keeps its ending`);
    }
  } finally {
    await context.f.close();
  }
});

test("a judge run is hidden from team lists", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const { duelId } = await context.start("hang");
    await waitFor(() => context.service.replayState(duelId), value => value?.memberId !== undefined, 90000);
    assert.equal(context.service.list().some(view => view.id === duelId), false);
    assert.equal(context.service.statuses().some(row => row.id === duelId), false);
    assert.equal(context.service.activeForProject("rehearsal"), false);
    await assert.rejects(async () => context.service.get(duelId), error => (error as { code?: string }).code === "team-not-found");
    await context.service.endReplay(duelId, "void-owner");
    assert.equal((await context.ended(duelId))?.ending, "void-owner");
  } finally {
    await context.f.close();
  }
});

test("a judge session uses the eval identity", { timeout: 120000 }, async () => {
  const context = await judgeFixture();
  try {
    const manager = context.getManager() as unknown as { createTeamSession: (...args: unknown[]) => Promise<unknown> };
    const original = manager.createTeamSession.bind(manager);
    const launches: unknown[][] = [];
    manager.createTeamSession = (...args: unknown[]) => { launches.push(args); return original(...args); };
    const { duelId } = await context.start("prefer-a");
    await context.ended(duelId);
    assert.equal(launches.length, 1);
    const header = launches[0]![6] as { purpose?: string };
    assert.equal(header.purpose, "duel");
    assert.equal(launches[0]![7], undefined, "a judge gets no GitHub grant scope");
    assert.equal((await context.getManager().list()).some(row => row.purpose === "duel"), true);
    // The identity rules a session with this purpose gets: the eval agent profile and the `_eval` egress identity.
    assert.equal(sessionAgentProfile(context.f.host.config, "claude", "duel"), context.f.host.config.eval!.member!.agents!.claude);
    assert.equal(sessionEgressIdentity("rehearsal", "session", "duel").project, "_eval");
    const commands = existsSync(context.record) ? readFileSync(context.record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { argv: string[] }) : [];
    assert.ok(commands.some(command => command.argv.includes("exec")), "the judge's commands ran through the eval launcher");
  } finally {
    await context.f.close();
  }
});
