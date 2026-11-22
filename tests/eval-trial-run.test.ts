import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalHost, type EvalHostOptions } from "../packages/host/src/eval-host.js";
import { type Grader, launcherGrader } from "../packages/host/src/eval-grader.js";
import { type EvalIdentity, launcherEvalIdentity } from "../packages/host/src/eval-identity.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { learningPurpose } from "../packages/host/src/types.js";
import { insertTrial } from "../packages/host/src/eval-trial-store.js";
import { TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import type { EvalJobView } from "../packages/host/src/eval-types.js";
import type { ProjectSourceStatus } from "../packages/host/src/project-source.js";
import type { RuntimeProcess } from "../packages/host/src/team-retirement.js";
import type { TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import { fixture } from "./team-fixture.js";

// The trial pump end to end: a validated fixture task, a baseline job, the eval launcher and the fake member of the replay
// tests, the grader fixture, and a real team service. The rig and the validation steps follow eval-validate-run.test.ts.

const GRADER = fileURLToPath(new URL("./fixtures/grader-command.mjs", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("./fixtures/eval-command.mjs", import.meta.url));
const TRIAL_AGENT = fileURLToPath(new URL("./fixtures/trial-agent.mjs", import.meta.url));
const PROJECT = "project-a";
const UID = process.getuid?.() ?? 0;
const profile: TeamModelProfile = { id: "trial-member", label: "Trial member", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const sandboxes: string[] = [];
/** Stores a restarted host replaced; the test closes them after the run. */
const retired: EvidenceStore[] = [];
const NOW = "2026-11-19T00:00:00.000Z";

test.after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  for (const store of retired) {
    try {
      store.close();
    } catch {
      // A store the test already closed needs no close.
    }
  }
});

type Rig = { dir: string; root: string; mirror: string; head: string; ids: string[]; record: string; store: EvidenceStore; groups: string;
  databasePath: string; vaultKey: Buffer };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(work: string, files: Record<string, string>, message: string, time: number): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ["add", "-A"]);
  const result = spawnSync("git", ["-c", "user.name=Placeholder", "-c", "user.email=placeholder@example.invalid", "commit", "-q", "--no-verify", "-m", message], {
    cwd: work, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: `${time} +0000`, GIT_AUTHOR_DATE: `${time} +0000` },
  });
  if (result.status !== 0) throw new Error("commit failed");
  return git(work, ["rev-parse", "HEAD"]);
}

/** A bare mirror with branch main. C0 has no test; C1 adds `add` and its passing test; C2 and C3 are rejected. */
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "infinite-eval-trial-"));
  sandboxes.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  git(work, ["init", "--quiet", "--template=", "-b", "main"]);
  const ids = [
    commit(work, { "package.json": "{\"type\":\"module\"}\n", "src/math.js": "export function sub(a, b) { return a - b; }\n" }, "Start the math module", 1_700_000_000),
    commit(work, {
      "src/math.js": "export function sub(a, b) { return a - b; }\nexport function add(a, b) { return a + b; }\n",
      "tests/add.test.js": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { add } from \"../src/math.js\";\ntest(\"add\", () => { assert.equal(add(1, 2), 3); });\n",
    }, "Add the addition function", 1_700_000_060),
    commit(work, {
      "src/math.js": "// second\nexport function sub(a, b) { return a - b; }\nexport function add(a, b) { return a + b; }\n",
      "tests/sub.test.js": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { sub } from \"../src/math.js\";\ntest(\"sub\", () => { assert.equal(sub(3, 1), 2); });\n",
    }, "Test the subtraction function", 1_700_000_120),
    commit(work, {
      "src/math.js": "// third\nexport function sub(a, b) { return a - b; }\nexport function add(a, b) { return a + b; }\n",
      "tests/flaky.test.js": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { existsSync, writeFileSync } from \"node:fs\";\nimport { join } from \"node:path\";\ntest(\"flaky\", () => {\n  const flag = join(process.env.HOME, \"flag\");\n  assert.equal(existsSync(flag), false);\n  writeFileSync(flag, \"\");\n});\n",
    }, "Test the flaky path", 1_700_000_180),
  ];
  const mirror = join(dir, "mirror.git");
  git(dir, ["clone", "--quiet", "--bare", work, mirror]);
  const root = join(dir, "grader");
  mkdirSync(root, { mode: 0o700 });
  const databasePath = evidenceDatabasePath(join(dir, "state")), vaultKey = randomBytes(32);
  const store = new EvidenceStore({ databasePath, vaultKey });
  // The eval host registers the trials module itself, as it does on a live host.
  store.register(outcomeModule({ now: () => NOW }));
  return { dir, root, mirror, head: ids[3], ids, record: join(dir, "record.log"), store, groups: `${root}.groups`, databasePath, vaultKey };
}

/** The validation project, with the trial settings and the one candidate profile. */
function projectConfig() {
  return {
    id: PROJECT,
    source: { mode: "github", repository: "example/app", baseBranch: "main" },
    team: {
      checks: [],
      eval: {
        mine: true,
        testPaths: { prefixes: ["tests"], suffixes: [".test.js"] },
        focusedTest: { command: process.execPath, args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] },
        reportFormat: "junit",
        trialsPerDay: 10,
        trialMinutes: 10,
        candidateProfiles: [profile],
      },
    },
  };
}

type Setup = { r: Rig; reference: string; receipts: string; evalRoot: string; config: Config; grader: Grader; identity: EvalIdentity };

/**
 * The host's configuration: the grader fixture as `eval.grader` (version 1 when `version1` is set), and the eval launcher,
 * with the fake member, as `eval.member`. The replay team service reads the same member.
 */
function setup(options: { member?: boolean; version1?: boolean } = {}): Setup {
  const r = rig();
  // The launcher's ROOT holds only trials: its clean removes every other entry, so the home, template, and tmp stand beside it.
  const evalRoot = join(r.dir, "eval");
  const home = join(r.dir, "home"), template = join(r.dir, "template"), tmp = join(r.dir, "tmp");
  for (const directory of [join(evalRoot, "trials"), home, template, tmp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(evalRoot, 0o711);
  // The reference is the validated commit's own files, which the fake member applies in `reference` mode.
  const reference = join(r.dir, "reference");
  mkdirSync(join(reference, "src"), { recursive: true });
  mkdirSync(join(reference, "tests"), { recursive: true });
  writeFileSync(join(reference, "src", "math.js"), showAt(r, r.ids[1], "src/math.js"));
  writeFileSync(join(reference, "tests", "add.test.js"), showAt(r, r.ids[1], "tests/add.test.js"));
  const receipts = join(r.dir, "receipts");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const prefix = { command: process.execPath, args: [GRADER, "--root", r.root, "--uid", String(UID), "--metadata", "closed", "--record", r.record, ...(options.version1 ? ["--no-version"] : [])] };
  const member = options.member === false ? undefined : {
    prefix: { command: process.execPath, args: [LAUNCHER, "--root", evalRoot, "--home", home, "--template", template, "--tmp", tmp, "--record", join(r.dir, "eval-record.log")] },
    root: evalRoot,
    agents: { claude: { command: process.execPath, args: [TRIAL_AGENT, receipts] } },
  };
  const project = projectConfig();
  const config = {
    projects: [project],
    stateDir: join(r.dir, "state"),
    runDir: join(r.dir, "runs"),
    keyFile: join(r.dir, "vault.key"),
    teams: { workspaceDir: join(r.dir, "workspaces") },
    eval: { grader: { prefix, root: r.root }, ...(member ? { member } : {}) },
  } as unknown as Config;
  const grader = testGrader(config, options.version1);
  const identity = testIdentity(config);
  return { r, reference, receipts, evalRoot, config, grader, identity };
}

function showAt(r: Rig, commitId: string, path: string): string {
  return execFileSync("git", ["--git-dir", r.mirror, "show", `${commitId}:${path}`], { encoding: "utf8" });
}

/**
 * The eval identity as the host sees it in these tests. Every fixture runs as this one user, so the launcher's own probe can
 * never see a second account: its uid is the grader's, and the host's canaries are readable. The probe here reports the
 * account the fixture stands in for, and every other operation runs through the same-user launcher.
 */
const STAND_IN_EVAL_UID = UID + 1;
function testIdentity(config: Config): EvalIdentity {
  const inner = launcherEvalIdentity(() => config.eval?.member, { hostUid: UID + 2, graceMs: 5_000 });
  return { ...inner, probe: async () => config.eval?.member === undefined
    ? { state: "not-configured" as const }
    : { state: "ready" as const, uid: STAND_IN_EVAL_UID, storage: true, fetch: "refused" as const } };
}

/** The grader as the host sees it in these tests. The fixture runs as this user, so its probe lists no canaries. */
function testGrader(config: Config, version1 = false): Grader {
  const inner = launcherGrader(() => config.eval?.grader, { hostUid: UID + 1, graceMs: 5_000 });
  return { ...inner, probe: async () => {
    const probe = await inner.probe([]);
    return version1 ? { ...probe, version: 1 } : probe;
  } };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The grader fixture's own process groups, as the processes of the grader's account. */
async function fixtureInventory(groups: string): Promise<RuntimeProcess[]> {
  const text = readFileOr(groups);
  return text.split("\n").map(Number).filter(pid => Number.isInteger(pid) && pid > 1 && alive(pid))
    .map(pid => ({ pid, parent: 1, group: pid, ruid: UID, euid: UID, born: "", state: "S" }));
}

function readFileOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Teams and sessions that only the gates touch: a job that waits never reaches them. */
const gatesOnly = { teams: () => ({ providerLimits: () => [] }) as never, sessions: { list: async () => [], remove: async () => undefined } };

/** The eval host over the rig, with the team service the trial pump starts runs on. */
function host(s: Setup, options: { identity?: EvalIdentity; teams?: EvalHostOptions["teams"]; sessions?: EvalHostOptions["sessions"];
  now?: () => string; inventory?: () => Promise<RuntimeProcess[]> } = {}): EvalHost {
  const status: ProjectSourceStatus = { mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: s.r.head };
  return new EvalHost({
    config: s.config,
    store: s.r.store,
    source: { mirrorPath: () => s.r.mirror, status: () => status },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    runs: () => [],
    grader: s.grader,
    inventory: options.inventory ?? (() => fixtureInventory(s.r.groups)),
    ...(options.now ? { now: options.now } : {}),
    ...(options.identity ? { identity: options.identity } : { identity: s.identity }),
    ...(options.teams && options.sessions ? { teams: options.teams, sessions: options.sessions } : {}),
  } as EvalHostOptions);
}

/** Mines the fixture commits until the miner is caught up. */
async function mine(h: EvalHost): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    h.tick();
    await h.idle();
    const summary = await h.summary(PROJECT);
    if ("code" in summary) throw new Error(`summary refused: ${summary.code}`);
    if (summary.mining.state === "caught-up") break;
  }
}

/** Mines the fixture commits, then validates them in one validation job. */
async function validated(h: EvalHost): Promise<void> {
  await mine(h);
  const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
  assert.ok("job" in created, "the validation job is created");
  for (let attempt = 0; attempt < 60; attempt++) {
    h.tick();
    await h.idle();
    if ((h.job(created.job.jobId) as EvalJobView).status === "completed") return;
  }
  throw new Error("validation did not complete");
}

/** The baseline job over the valid mined task, with the given trials per task. */
function baseline(h: EvalHost, trialsPerTask: number, maxTrials: number, options: { maxWallMinutes?: number } = {}): string {
  // A group draws its set when it is created, and a baseline job reads the dev set only. Without this the one mined task is holdout in three runs of ten, and the job runs no trial.
  (h as unknown as { store: EvidenceStore }).store.write(tx => { tx.run("UPDATE eval_groups SET holdout = 0, set_at = NULL"); });
  const created = h.create(PROJECT, {
    kind: "baseline",
    configurations: [{ profile, guidance: "as-of-base", knowledge: "none" }],
    taskFilter: { origins: ["mined"], maxTasks: 1 },
    trialsPerTask,
    limits: { maxTrials, maxWallMinutes: options.maxWallMinutes ?? 120 },
  }, randomUUID());
  assert.ok("job" in created, "the baseline job is created");
  return created.job.jobId;
}

type JobRow = { status: string; reason: string | null; waiting: string | null };
function jobRow(s: Setup, jobId: string): JobRow | undefined {
  return s.r.store.read(db => db.get<JobRow>("SELECT status, reason, waiting FROM eval_jobs WHERE job_id = ?", jobId));
}

type TrialSql = { trial_id: string; state: string; ending: string | null; attempt: number; resolved: number | null; isolation: string | null };
function trialRows(s: Setup, jobId: string): TrialSql[] {
  return s.r.store.read(db => db.all<TrialSql>(
    "SELECT trial_id, state, ending, attempt, resolved, isolation FROM eval_trials WHERE job_id = ? ORDER BY created_at, attempt", jobId));
}

/**
 * Ticks the host until `done` holds. Each new trial takes the next mode from `modes`, written as the fake member's receipt
 * before the member starts; the default mode is `reference`. Ticks run until the budget ends, and then the test asserts.
 */
async function drive(s: Setup, h: EvalHost, done: () => boolean, modes: string[], budgetMs: number): Promise<void> {
  const assigned = new Set<string>();
  const deadline = Date.now() + budgetMs;
  while (!done() && Date.now() < deadline) {
    h.tick();
    await h.idle();
    const live = s.r.store.read(db => db.all<{ trial_id: string }>("SELECT trial_id FROM eval_trials WHERE state != 'final'"));
    for (const { trial_id } of live) {
      if (assigned.has(trial_id)) continue;
      assigned.add(trial_id);
      const mode = modes.shift() ?? "reference";
      writeFileSync(join(s.receipts, `${trial_id}.mode`), JSON.stringify({ mode, dir: s.reference }), { mode: 0o600 });
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** The operation names of the eval launcher's record, in call order. */
function launcherOps(s: Setup): string[] {
  return readFileOr(join(s.r.dir, "eval-record.log")).split("\n").filter(Boolean)
    .map(line => (JSON.parse(line) as { argv: string[] }).argv[0]);
}

/** The grader's record, in call order: each entry is the operation and its arguments. */
function graderRecord(s: Setup): string[][] {
  return readFileOr(s.r.record).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
}

/**
 * A restarted host opens the store anew: the host registers its modules on the store it is given, so a second host over the
 * same handle would register them twice. The new handle reads the same database file; the retired handle stays open for the
 * team service, which flushes its events through it.
 */
function reopen(s: Setup): void {
  const next = new EvidenceStore({ databasePath: s.r.databasePath, vaultKey: s.r.vaultKey });
  next.register(outcomeModule({ now: () => NOW }));
  next.register(configurationModule());
  retired.push(s.r.store);
  s.r.store = next;
}

/** The team service as `TrialTeams`, with some calls replaced. */
function wrapTeams(service: Awaited<ReturnType<typeof serveTeam>>["service"], overrides: Partial<TrialTeams> = {}): () => TrialTeams {
  const base: TrialTeams = {
    createForReplay: input => service.createForReplay(input),
    replayState: trialId => service.replayState(trialId),
    endReplay: (trialId, ending) => service.endReplay(trialId, ending),
    forgetReplay: trialId => service.forgetReplay(trialId),
    replayIds: () => service.replayIds(),
    providerLimits: () => service.providerLimits(),
  };
  return () => ({ ...base, ...overrides });
}

function sessionOf(s: Setup, trialId: string): string | null {
  return s.r.store.read(db => db.get<{ session_id: string | null }>("SELECT session_id FROM eval_trials WHERE trial_id = ?", trialId))?.session_id ?? null;
}

/** True once the fake member has written its start receipt. */
function memberStarted(s: Setup): boolean {
  return readdirSync(s.receipts).some(name => name.endsWith(".started.json"));
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The team fixture, with the eval member and the validation project, whose checkout is the fixture source. */
async function teamFixture(s: Setup): Promise<Fixture> {
  const fx = await fixture("success", undefined, {}, { trustWorkspaces: true });
  fx.host.config.eval = s.config.eval;
  fx.host.config.projects.push({ ...s.config.projects[0], path: fx.source } as never);
  return fx;
}

/**
 * The team service, with its events projected into the eval store as the server projects them: configuration, then outcomes.
 * The events are also kept, so a test can read the kinds a run emitted.
 */
async function serveTeam(s: Setup, fx: Fixture) {
  s.r.store.register(configurationModule());
  const outbox = new EventOutbox(s.r.store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(outcomeProjector(s.r.store));
  const events: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
  let manager: Manager | undefined;
  const service = await fx.openTeamService({
    events: {
      flush(items: unknown[]) { events.push(...(items as typeof events)); return outbox.flush(items as never); },
      advance() { return outbox.advance(); },
    } as never,
    manager: m => { manager = m; },
  });
  return { service, events, manager: manager! };
}

test("a fixture task is resolved by a member that applies the reference", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    // The run is not listed to the owner at any point, so it is checked each tick while the member is still running.
    let checkedWhileRunning = false;
    await drive(s, h, () => {
      for (const row of trialRows(s, jobId)) {
        if (row.state !== "running") continue;
        checkedWhileRunning = true;
        assert.equal(served.service.list().some(view => view.id === row.trial_id), false, "the running run is not listed");
      }
      return jobRow(s, jobId)?.status === "completed";
    }, [], 600_000);
    assert.ok(checkedWhileRunning, "the run was seen while the member ran");
    const rows = trialRows(s, jobId);
    assert.equal(rows.length, 1, "one trial");
    assert.equal(rows[0].ending, "graded");
    assert.equal(rows[0].resolved, 1, "the reference resolves the task");
    assert.equal(rows[0].isolation, "isolated");
    const outcome = s.r.store.read(db => db.get<{ source: string; experiment_ref: string | null }>(
      "SELECT source, experiment_ref FROM outcomes WHERE run_id = ?", rows[0].trial_id));
    assert.equal(outcome?.source, "replay", "the outcome row is a replay row");
    assert.equal(outcome?.experiment_ref, rows[0].trial_id, "the outcome row names the trial");
    assert.deepEqual(readdirSync(join(s.evalRoot, "trials")), [], "the trials root is empty after the job");
    assert.equal(served.service.list().some(view => view.id === rows[0].trial_id), false, "the run is not listed");
    // The server's session filter (server.ts listSessions): the replay session exists and the filter removes it.
    const sessions = await served.manager.list();
    const learning = sessions.filter(row => learningPurpose(row.purpose));
    assert.ok(learning.length > 0, "the replay session exists");
    assert.equal(sessions.filter(row => !learningPurpose(row.purpose)).length, sessions.length - learning.length);
    assert.equal(served.service.replayIds().length, 0, "the graded trial leaves no run record");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("an empty result, an edit outside the paths, and an undecided permission end their trials", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  try {
    await validated(h);
    const endings: string[] = [];
    for (const mode of ["empty", "outside", "permission"]) {
      const jobId = baseline(h, 1, 1);
      await drive(s, h, () => jobRow(s, jobId)?.status === "completed", [mode], 600_000);
      endings.push(trialRows(s, jobId)[0]?.ending ?? "none");
    }
    assert.deepEqual(endings, ["no-result", "scope-violation", "permission"]);
    // The team-replay test asserts endings only, so this owner-question check is new: no decision or question event for any run.
    const asked = served.events.filter(event => /decision|question/.test(event.kind));
    assert.deepEqual(asked.map(event => event.kind), [], "no owner question was asked");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a provider limit voids the trial, and it runs again", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  // The host's clock is real time plus an offset the test raises. The fixture's notice resets within a day.
  let offset = 0;
  const clock = () => new Date(Date.now() + offset).toISOString();
  let stated: string | undefined;
  const teams = wrapTeams(served.service, {
    replayState: async trialId => {
      const state = await served.service.replayState(trialId);
      if (state?.resetsAt !== undefined) stated = state.resetsAt;
      return state;
    },
  });
  const h = host(s, { teams, sessions: served.manager, now: clock });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 2, { maxWallMinutes: 43_200 });
    const modes = ["limit", "reference"];
    await drive(s, h, () => trialRows(s, jobId).some(row => row.ending === "void-limit"), modes, 240_000);
    const first = trialRows(s, jobId);
    assert.equal(first.length, 1, "one trial so far");
    assert.equal(first[0]?.ending, "void-limit");
    assert.deepEqual(served.service.providerLimits(), [], "the limit memory stays empty");
    await drive(s, h, () => false, modes, 5_000);
    assert.equal(trialRows(s, jobId).length, 1, "no second trial while the provider is limited");
    assert.equal(jobRow(s, jobId)?.waiting, "provider-limit", "the job waits for the provider");
    // One minute before the stated reset, the provider is still limited. A reset in the past leaves the 15 minute default, so 10 minutes.
    const resetMs = stated === undefined ? NaN : Date.parse(stated);
    offset = Number.isFinite(resetMs) && resetMs - Date.now() > 120_000 ? resetMs - Date.now() - 60_000 : 10 * 60_000;
    await drive(s, h, () => false, modes, 3_000);
    assert.equal(jobRow(s, jobId)?.waiting, "provider-limit", "the job still waits for the provider just before the reset");
    assert.equal(trialRows(s, jobId).length, 1, "no second trial just before the reset");
    offset += 25 * 3_600_000;
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed", modes, 240_000);
    const rows = trialRows(s, jobId);
    assert.equal(rows[1]?.ending, "graded", "the second trial is graded");
    assert.equal(rows[1]?.attempt, 1, "the second run is attempt 1");
    assert.deepEqual(served.service.providerLimits(), [], "the limit memory stays empty");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("no trial while the eval identity is busy", { timeout: 300_000 }, async () => {
  const s = setup();
  // The identity answers busy: the probe is the only thing the test changes.
  const busy: EvalIdentity = { ...s.identity, probe: async () => ({ state: "busy" }) };
  const h = host(s, { identity: busy, ...gatesOnly });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => false, [], 20_000);
    assert.equal(trialRows(s, jobId).length, 0, "no trial row");
    assert.equal(jobRow(s, jobId)?.waiting, "eval-identity");
  } finally {
    h.close();
    await h.idle();
    s.r.store.close();
  }
  // An eval-uid process that stays alive: the account cannot be stopped, so the trial is never started.
  const alive = setup();
  let planted = false;
  const aliveRow: RuntimeProcess = { pid: 2, parent: 1, group: 2, ruid: STAND_IN_EVAL_UID, euid: STAND_IN_EVAL_UID, born: "", state: "S" };
  const hAlive = host(alive, { ...gatesOnly, inventory: async () => (planted ? [aliveRow] : []) });
  try {
    await validated(hAlive);
    // Start-up has stopped the account while nothing was planted; the row appears only before the trial starts.
    planted = true;
    const jobId = baseline(hAlive, 1, 1);
    await drive(alive, hAlive, () => jobRow(alive, jobId)?.status === "blocked", [], 120_000);
    assert.equal(trialRows(alive, jobId).length, 0, "no trial row");
    assert.equal(jobRow(alive, jobId)?.status, "blocked");
    assert.equal(jobRow(alive, jobId)?.reason, "eval-processes-alive");
  } finally {
    hAlive.close();
    await hAlive.idle();
    alive.r.store.close();
  }
});

test("without both identities, no trial starts and the summary says why", { timeout: 300_000 }, async () => {
  const none = setup({ member: false });
  const hNone = host(none, gatesOnly);
  try {
    await validated(hNone);
    const jobId = baseline(hNone, 1, 1);
    await drive(none, hNone, () => false, [], 10_000);
    assert.equal(trialRows(none, jobId).length, 0);
    assert.equal(jobRow(none, jobId)?.waiting, "eval-identity");
    const summary = await hNone.summary(PROJECT);
    assert.ok(!("code" in summary));
    assert.equal(summary.evalIdentity.state, "not-configured");
    assert.equal(summary.trials.dailyCap, 10, "the daily cap is the project's trialsPerDay");
  } finally {
    hNone.close();
    await hNone.idle();
    none.r.store.close();
  }
  const v1 = setup({ version1: true });
  const hV1 = host(v1, gatesOnly);
  try {
    await validated(hV1);
    const jobId = baseline(hV1, 1, 1);
    await drive(v1, hV1, () => false, [], 10_000);
    assert.equal(trialRows(v1, jobId).length, 0);
    assert.equal(jobRow(v1, jobId)?.waiting, "grader");
    const summary = await hV1.summary(PROJECT);
    assert.ok(!("code" in summary));
    assert.equal(summary.grader.version, 1, "the summary shows the version 1 grader");
  } finally {
    hV1.close();
    await hV1.idle();
    v1.r.store.close();
  }
});

test("a restart in the middle of a trial voids it", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const first = host(s, { teams: () => served.service, sessions: served.manager });
  let second: EvalHost | undefined;
  try {
    await validated(first);
    const jobId = baseline(first, 2, 3);
    // The member stalls: its run stays live until the host stops.
    await drive(s, first, () => memberStarted(s), ["stall"], 240_000);
    assert.ok(memberStarted(s), "the member started");
    await drive(s, first, () => false, [], 1_500);
    // A crash between a trial's insert and its start leaves a preparing row; the second slot's row is such a row.
    const preparing = randomUUID();
    s.r.store.write(tx => {
      const running = tx.get<{ task_id: string; config_ref: string; payload: string }>("SELECT task_id, config_ref, payload FROM eval_trials WHERE job_id = ?", jobId);
      assert.ok(running, "the stalled trial row exists");
      const configuration = { profile, guidance: "as-of-base" as const, knowledge: "none" as const };
      insertTrial(tx, { trialId: preparing, jobId, taskId: running.task_id, configRef: running.config_ref, harness: TRIAL_HARNESS_VERSION, slot: 1,
        attempt: 0, projectId: PROJECT, configuration, keepDays: 365 }, NOW);
    });
    const before = launcherOps(s).length;
    first.close();
    await first.idle();
    reopen(s);
    second = host(s, { teams: () => served.service, sessions: served.manager });
    await drive(s, second, () => jobRow(s, jobId)?.status === "completed", ["reference"], 840_000);
    const rows = s.r.store.read(db => db.all<TrialSql & { slot: number; session_id: string | null }>(
      "SELECT trial_id, state, ending, attempt, resolved, isolation, slot, session_id FROM eval_trials WHERE job_id = ? ORDER BY slot, attempt", jobId));
    assert.equal(rows.length, 3, "three trial rows: the voided trial, its rerun, and the second slot");
    assert.equal(rows.some(row => row.trial_id === preparing), false, "the preparing row is gone");
    assert.deepEqual(rows.map(row => [row.slot, row.attempt, row.ending]), [[0, 0, "void-host"], [0, 1, "graded"], [1, 0, "graded"]],
      "the voided slot runs again as attempt 1, and the preparing slot runs as attempt 0");
    assert.ok(rows[0].session_id, "the voided trial names its session, so the sweep can remove it");
    const view = second.job(jobId);
    assert.ok(!("code" in view) && view.kind === "baseline" && view.trials.void === 1, "the job counts one void trial");
    const run = await served.service.replayState(rows[0].trial_id);
    assert.ok(run === undefined || run.ending === "void-host", "the run ends void-host");
    // The new host's start-up stops, cleans, and scrubs the account before the second trial's first command.
    assert.deepEqual(launcherOps(s).slice(before, before + 3), ["stop", "clean", "scrub"], "the account is reset before any trial command");
  } finally {
    first.close();
    await first.idle();
    second?.close();
    await second?.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a lost replay run voids its trial", { timeout: 900_000 }, async () => {
  // The run's record is lost while its member runs: replayState reports no run for that trial. The team service has no
  // call that removes a live run, so the test stands a wrapper over the service for that one answer.
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const service = served.service;
  let lost: string | undefined;
  const teams = (): TrialTeams => ({
    createForReplay: input => service.createForReplay(input),
    replayState: async trialId => (trialId === lost ? undefined : service.replayState(trialId)),
    endReplay: (trialId, ending) => service.endReplay(trialId, ending),
    forgetReplay: trialId => service.forgetReplay(trialId),
    replayIds: () => service.replayIds(),
    providerLimits: () => service.providerLimits(),
  });
  const h = host(s, { teams, sessions: served.manager });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => memberStarted(s), ["stall"], 240_000);
    await drive(s, h, () => false, [], 2_000);
    lost = trialRows(s, jobId)[0]?.trial_id;
    assert.ok(lost, "the trial row exists");
    await drive(s, h, () => trialRows(s, jobId)[0]?.state === "final", [], 60_000);
    assert.equal(trialRows(s, jobId)[0]?.ending, "void-host", "the lost run voids its trial");
    assert.ok(sessionOf(s, lost), "the voided trial names the session it last saw, so the sweep can remove it");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }

  // The task's row is deleted while its member runs: the trial voids, and the job does not run the task again.
  const t = setup();
  const tfx = await teamFixture(t);
  const tserved = await serveTeam(t, tfx);
  const th = host(t, { teams: () => tserved.service, sessions: tserved.manager });
  try {
    await validated(th);
    const jobId = baseline(th, 1, 2);
    await drive(t, th, () => memberStarted(t), ["stall"], 240_000);
    const taskId = t.r.store.read(db => db.get<{ task_id: string }>("SELECT task_id FROM eval_trials WHERE job_id = ?", jobId))?.task_id;
    assert.ok(taskId, "the trial names its task");
    t.r.store.write(tx => { tx.run("DELETE FROM eval_tasks WHERE task_id = ?", taskId); });
    await drive(t, th, () => trialRows(t, jobId)[0]?.state === "final", [], 60_000);
    assert.equal(trialRows(t, jobId)[0]?.ending, "void-host", "the deleted task voids its trial");
    await drive(t, th, () => jobRow(t, jobId)?.status === "completed", ["reference"], 120_000);
    assert.equal(jobRow(t, jobId)?.status, "completed", "the job moves past the task");
    assert.equal(trialRows(t, jobId).length, 1, "no second trial for the deleted task");
  } finally {
    th.close();
    await th.idle();
    await tfx.close();
    t.r.store.close();
  }
});

test("validation and trials share the grader one step at a time", { timeout: 900_000 }, async () => {
  const JOB_OPS = new Set(["receive", "run", "read", "digest", "export", "clean", "remove"]);
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  try {
    await mine(h);
    // The validation job and the baseline job run together: the baseline waits for the first valid task.
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created, "the validation job is created");
    const validation = created.job.jobId;
    // The baseline job is created once the first candidate is valid: a baseline created earlier finds no task and completes empty.
    await drive(s, h, () => (h.job(validation) as EvalJobView).counts.valid >= 1 || (h.job(validation) as EvalJobView).status === "completed",
      [], 240_000);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed" && (h.job(validation) as EvalJobView).status === "completed",
      ["reference"], 840_000);
    assert.equal(jobRow(s, jobId)?.status, "completed", "the baseline job completes");
    const record = graderRecord(s);
    const open = new Set<string>();
    const seen = new Set<string>();
    // A job holds the grader from its receive to its clean. A stop inside that span is the holder's own launcher step.
    for (const [op, job] of record) {
      if (!JOB_OPS.has(op) || job === undefined) continue;
      seen.add(job);
      for (const other of open) assert.equal(other, job, "no other job's command runs between a receive and its clean");
      if (op === "receive") open.add(job);
      if (op === "clean") open.delete(job);
    }
    assert.ok(seen.has(validation) && seen.has(jobId), "both jobs used the grader");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("an unavailable store starts no trial", { timeout: 300_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  try {
    // An open baseline job, so only the store check stands between the pump and its start-up commands.
    baseline(h, 1, 1);
    assert.deepEqual(launcherOps(s), [], "creating the job runs no launcher command");
    s.r.store.close();
    assert.doesNotThrow(() => h.tick());
    await h.idle();
    h.sweep();
    assert.deepEqual(launcherOps(s), [], "no launcher command runs");
    assert.equal(readFileOr(s.r.record), "", "no grader command runs");
    assert.deepEqual(await h.summary(PROJECT), { status: 503, code: "evidence-unavailable" }, "the summary answers 503");
    assert.deepEqual(h.jobs(), { status: 503, code: "evidence-unavailable" }, "the jobs list answers 503");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
  }
});

test("a graded trial leaves no run record and, later, no session", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  // The host's clock is real time plus an offset the test raises before the sweep.
  let offset = 0;
  const clock = () => new Date(Date.now() + offset).toISOString();
  const h = host(s, { teams: () => served.service, sessions: served.manager, now: clock });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed", [], 600_000);
    const trial = trialRows(s, jobId)[0];
    assert.ok(trial, "the trial row exists");
    assert.equal(trial.ending, "graded");
    assert.deepEqual(served.service.replayIds(), [], "the graded trial leaves no run record");
    const sessionOf = () => s.r.store.read(db => db.get<{ session_id: string | null }>(
      "SELECT session_id FROM eval_trials WHERE trial_id = ?", trial.trial_id))?.session_id ?? null;
    const sessionId = sessionOf();
    assert.ok(sessionId, "the trial keeps its session until the sweep");
    const directory = join(fx.host.config.stateDir, "sessions", sessionId);
    assert.ok(existsSync(directory), "the session directory exists after grading");
    offset += 2 * 3_600_000;
    h.sweep();
    // The sweep runs in the background; the wait is bounded.
    for (let attempt = 0; attempt < 150 && (existsSync(directory) || sessionOf() !== null); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(existsSync(directory), false, "the session directory is gone after the sweep");
    assert.equal(sessionOf(), null, "the trial no longer names its session");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a baseline job is created, viewed, and resumed through the host", { timeout: 300_000 }, async () => {
  const s = setup();
  let planted = false;
  const aliveRow: RuntimeProcess = { pid: 2, parent: 1, group: 2, ruid: STAND_IN_EVAL_UID, euid: STAND_IN_EVAL_UID, born: "", state: "S" };
  const h = host(s, { ...gatesOnly, inventory: async () => (planted ? [aliveRow] : []) });
  try {
    await validated(h);
    planted = true;
    const jobId = baseline(h, 1, 1);
    const view = h.job(jobId);
    assert.ok(!("code" in view), "the job is viewable");
    assert.equal(view.kind, "baseline");
    assert.ok("trials" in view && "tasks" in view, "the view is a baseline view");
    const listed = h.jobs();
    assert.ok(Array.isArray(listed));
    const row = listed.find(item => item.jobId === jobId);
    assert.ok(row !== undefined && row.kind === "baseline" && "trials" in row, "the list shows a baseline view");
    await drive(s, h, () => jobRow(s, jobId)?.status === "blocked", [], 120_000);
    assert.equal(jobRow(s, jobId)?.reason, "eval-processes-alive");
    planted = false;
    const resumed = h.control(jobId, "resume");
    assert.ok(!("code" in resumed), "the resume answers a job view, not a refusal");
    assert.equal(resumed.kind, "baseline");
    assert.notEqual(resumed.status, "blocked");
  } finally {
    h.close();
    await h.idle();
    s.r.store.close();
  }
});

test("an error in the validation step does not stop the trial step", { timeout: 900_000 }, async () => {
  // The validation job's bundle removal throws on every tick after the job ends, so each validation step fails.
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const inner = s.grader;
  const ref: { h?: EvalHost } = {};
  s.grader = { ...inner, remove: async job => {
    const view = ref.h?.job(job);
    if (view !== undefined && !("code" in view) && view.kind === "validate" && view.status === "completed") throw new Error("remove failed");
    return inner.remove(job);
  } };
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  ref.h = h;
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed", [], 400_000);
    const rows = trialRows(s, jobId);
    assert.equal(rows[0]?.ending, "graded", "the trial ran although the validation step threw on every tick");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a running member is watched while a validation step holds the chain", { timeout: 900_000 }, async () => {
  // The chain is held in the validation step's bundle removal. The member's start time is moved 11 minutes back (trialMinutes is 10),
  // so only the pump's own watch can end the run, outside the held chain.
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const inner = s.grader;
  const ref: { h?: EvalHost } = {};
  let mode: "refuse" | "hold" | "open" = "refuse";
  let entered = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  s.grader = { ...inner, remove: async job => {
    const view = ref.h?.job(job);
    // A running validation job removes its own bundle after each task; only the removal after the job ends is held.
    if (view === undefined || "code" in view || view.kind !== "validate" || view.status !== "completed" || mode === "open") return inner.remove(job);
    if (mode === "refuse") return false;
    entered = true;
    await held;
    return inner.remove(job);
  } };
  let skew = false;
  const ended: string[] = [];
  const teams = wrapTeams(served.service, {
    replayState: async trialId => {
      const state = await served.service.replayState(trialId);
      return skew && state?.memberStartedAt !== undefined ? { ...state, memberStartedAt: new Date(Date.now() - 11 * 60_000).toISOString() } : state;
    },
    endReplay: async (trialId, ending) => {
      ended.push(ending);
      return served.service.endReplay(trialId, ending);
    },
  });
  const h = host(s, { teams, sessions: served.manager });
  ref.h = h;
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => memberStarted(s), ["stall"], 240_000);
    assert.ok(memberStarted(s), "the member started");
    mode = "hold";
    skew = true;
    for (let attempt = 0; attempt < 80 && !ended.includes("timeout"); attempt++) {
      h.tick();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(entered, "the chain is held in the validation step");
    assert.ok(ended.includes("timeout"), `the run ended by timeout while the chain was held; ended: ${ended.join(",")}`);
    assert.notEqual(trialRows(s, jobId)[0]?.state, "final", "the chain, not the watch, finishes the trial");
  } finally {
    mode = "open";
    release();
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a failure while grading closes the trial void-host and the next trial runs", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  const inner = s.grader;
  let thrown = false;
  s.grader = { ...inner, stop: async () => {
    const grading = s.r.store.read(db => db.get("SELECT 1 AS n FROM eval_trials WHERE state = 'grading'"));
    if (grading !== undefined && !thrown) {
      thrown = true;
      throw new Error("grader stop failed");
    }
    return inner.stop();
  } };
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 2);
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed", [], 400_000);
    assert.ok(thrown, "the grading threw once");
    const rows = trialRows(s, jobId);
    assert.deepEqual(rows.map(row => [row.attempt, row.state, row.ending]), [[0, "final", "void-host"], [1, "final", "graded"]]);
    const view = h.job(jobId);
    assert.ok(!("code" in view) && view.kind === "baseline" && view.trials.void === 1, "the job records the void trial");
    assert.deepEqual(served.service.replayIds(), [], "no run remains");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a failed stop is tried again before a settled trial is void", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  let armed = false, thrown = false;
  const h = host(s, { teams: () => served.service, sessions: served.manager, inventory: async () => {
    if (armed && !thrown) {
      thrown = true;
      throw new Error("inventory failed");
    }
    return fixtureInventory(s.r.groups);
  } });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 1);
    await drive(s, h, () => trialRows(s, jobId).some(row => row.state === "running"), [], 240_000);
    armed = true;
    await drive(s, h, () => jobRow(s, jobId)?.status === "completed", [], 400_000);
    assert.ok(thrown, "one stop failed");
    assert.equal(trialRows(s, jobId)[0]?.ending, "graded", "the settled trial is graded, not void");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("a failed launch ends the run it may have left", { timeout: 900_000 }, async () => {
  const s = setup();
  const fx = await teamFixture(s);
  const served = await serveTeam(s, fx);
  let launches = 0;
  const ended: Array<[string, string]> = [];
  const teams = wrapTeams(served.service, {
    createForReplay: async input => {
      launches += 1;
      if (launches === 1) throw new Error("launch failed");
      return served.service.createForReplay(input);
    },
    endReplay: async (trialId, ending) => {
      ended.push([trialId, ending]);
      return served.service.endReplay(trialId, ending);
    },
  });
  const h = host(s, { teams, sessions: served.manager });
  try {
    await validated(h);
    const jobId = baseline(h, 1, 2);
    await drive(s, h, () => trialRows(s, jobId)[0]?.state === "final", [], 240_000);
    const first = trialRows(s, jobId)[0];
    assert.equal(first?.ending, "void-host", "the failed launch voids its trial");
    assert.ok(ended.some(([trialId, ending]) => trialId === first.trial_id && ending === "void-host"), "the run is ended void-host");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});
