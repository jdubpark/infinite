import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import type { EvalJobView } from "../packages/host/src/eval-types.js";
import type { ProjectSourceStatus } from "../packages/host/src/project-source.js";
import type { RuntimeProcess } from "../packages/host/src/team-retirement.js";
import type { TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import { fixture } from "./team-fixture.js";

export const GRADER = fileURLToPath(new URL("./fixtures/grader-command.mjs", import.meta.url));
export const LAUNCHER = fileURLToPath(new URL("./fixtures/eval-command.mjs", import.meta.url));
export const TRIAL_AGENT = fileURLToPath(new URL("./fixtures/trial-agent.mjs", import.meta.url));
export const PROJECT = "project-a";
export const UID = process.getuid?.() ?? 0;
export const profile: TeamModelProfile = { id: "trial-member", label: "Trial member", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
export const sandboxes: string[] = [];
export const retired: EvidenceStore[] = [];
export const NOW = "2026-11-19T00:00:00.000Z";

test.after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  for (const store of retired) {
    try {
      store.close();
    } catch {
    }
  }
});

export type Rig = { dir: string; root: string; mirror: string; head: string; ids: string[]; record: string; store: EvidenceStore; groups: string;
  databasePath: string; vaultKey: Buffer };

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function commit(work: string, files: Record<string, string>, message: string, time: number): string {
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

export function rig(linked = false): Rig {
  const made = mkdtempSync(join(tmpdir(), "infinite-eval-trial-"));
  sandboxes.push(made);
  const dir = linked ? join(made, "link") : made;
  if (linked) {
    mkdirSync(join(made, "real"), { mode: 0o755 });
    symlinkSync(join(made, "real"), dir);
  }
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
  store.register(outcomeModule({ now: () => NOW }));
  return { dir, root, mirror, head: ids[3], ids, record: join(dir, "record.log"), store, groups: `${root}.groups`, databasePath, vaultKey };
}

export function projectConfig() {
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

export type Setup = { r: Rig; reference: string; receipts: string; evalRoot: string; config: Config; grader: Grader; identity: EvalIdentity };

export function setup(options: { member?: boolean; version1?: boolean; linked?: boolean } = {}): Setup {
  const r = rig(options.linked);
  const evalRoot = join(r.dir, "eval");
  const home = join(r.dir, "home"), template = join(r.dir, "template"), tmp = join(r.dir, "tmp");
  for (const directory of [join(evalRoot, "trials"), home, template, tmp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(evalRoot, 0o711);
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

export function showAt(r: Rig, commitId: string, path: string): string {
  return execFileSync("git", ["--git-dir", r.mirror, "show", `${commitId}:${path}`], { encoding: "utf8" });
}

export const STAND_IN_EVAL_UID = UID + 1;
export function testIdentity(config: Config): EvalIdentity {
  const inner = launcherEvalIdentity(() => config.eval?.member, { hostUid: UID + 2, graceMs: 5_000 });
  return { ...inner, probe: async () => config.eval?.member === undefined
    ? { state: "not-configured" as const }
    : { state: "ready" as const, uid: STAND_IN_EVAL_UID, storage: true, fetch: "refused" as const } };
}

export function testGrader(config: Config, version1 = false): Grader {
  const inner = launcherGrader(() => config.eval?.grader, { hostUid: UID + 1, graceMs: 5_000 });
  return { ...inner, probe: async () => {
    const probe = await inner.probe([]);
    return version1 ? { ...probe, version: 1 } : probe;
  } };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function fixtureInventory(groups: string): Promise<RuntimeProcess[]> {
  const text = readFileOr(groups);
  return text.split("\n").map(Number).filter(pid => Number.isInteger(pid) && pid > 1 && alive(pid))
    .map(pid => ({ pid, parent: 1, group: pid, ruid: UID, euid: UID, born: "", state: "S" }));
}

export function readFileOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export const gatesOnly = { teams: () => ({ providerLimits: () => [] }) as never, sessions: { list: async () => [], remove: async () => undefined } };

export function host(s: Setup, options: { identity?: EvalIdentity; teams?: EvalHostOptions["teams"]; sessions?: EvalHostOptions["sessions"];
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

export async function mine(h: EvalHost): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    h.tick();
    await h.idle();
    const summary = await h.summary(PROJECT);
    if ("code" in summary) throw new Error(`summary refused: ${summary.code}`);
    if (summary.mining.state === "caught-up") break;
  }
}

export async function validated(h: EvalHost): Promise<void> {
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

export function baseline(h: EvalHost, trialsPerTask: number, maxTrials: number, options: { maxWallMinutes?: number } = {}): string {
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

export type JobRow = { status: string; reason: string | null; waiting: string | null };
export function jobRow(s: Setup, jobId: string): JobRow | undefined {
  return s.r.store.read(db => db.get<JobRow>("SELECT status, reason, waiting FROM eval_jobs WHERE job_id = ?", jobId));
}

export type TrialSql = { trial_id: string; state: string; ending: string | null; attempt: number; resolved: number | null; isolation: string | null };
export function trialRows(s: Setup, jobId: string): TrialSql[] {
  return s.r.store.read(db => db.all<TrialSql>(
    "SELECT trial_id, state, ending, attempt, resolved, isolation FROM eval_trials WHERE job_id = ? ORDER BY created_at, attempt", jobId));
}

export async function drive(s: Setup, h: EvalHost, done: () => boolean, modes: string[], budgetMs: number): Promise<void> {
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

export function launcherOps(s: Setup): string[] {
  return readFileOr(join(s.r.dir, "eval-record.log")).split("\n").filter(Boolean)
    .map(line => (JSON.parse(line) as { argv: string[] }).argv[0]);
}

export function graderRecord(s: Setup): string[][] {
  return readFileOr(s.r.record).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
}

export function reopen(s: Setup): void {
  const next = new EvidenceStore({ databasePath: s.r.databasePath, vaultKey: s.r.vaultKey });
  next.register(outcomeModule({ now: () => NOW }));
  next.register(configurationModule());
  retired.push(s.r.store);
  s.r.store = next;
}

export function wrapTeams(service: Awaited<ReturnType<typeof serveTeam>>["service"], overrides: Partial<TrialTeams> = {}): () => TrialTeams {
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

export function sessionOf(s: Setup, trialId: string): string | null {
  return s.r.store.read(db => db.get<{ session_id: string | null }>("SELECT session_id FROM eval_trials WHERE trial_id = ?", trialId))?.session_id ?? null;
}

export function memberStarted(s: Setup): boolean {
  return readdirSync(s.receipts).some(name => name.endsWith(".started.json"));
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function teamFixture(s: Setup): Promise<Fixture> {
  const fx = await fixture("success", undefined, {}, { trustWorkspaces: true });
  fx.host.config.eval = s.config.eval;
  fx.host.config.projects.push({ ...s.config.projects[0], path: fx.source } as never);
  return fx;
}

export async function serveTeam(s: Setup, fx: Fixture) {
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
