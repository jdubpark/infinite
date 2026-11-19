import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import express from "express";
import { EvalHost, type EvalHostOptions } from "../packages/host/src/eval-host.js";
import { evalTrialsModule } from "../packages/host/src/eval-trial-store.js";
import { type Grader, launcherGrader } from "../packages/host/src/eval-grader.js";
import type { MineGit } from "../packages/host/src/eval-mine-git.js";
import { minedTaskId } from "../packages/host/src/eval-miner.js";
import { readEvalTask } from "../packages/host/src/eval-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError } from "../packages/host/src/evidence/types.js";
import type { EvalJobView, EvalTaskRow, MinedPayload } from "../packages/host/src/eval-types.js";
import type { ProjectSourceStatus } from "../packages/host/src/project-source.js";
import type { RuntimeProcess } from "../packages/host/src/team-retirement.js";
import type { Config } from "../packages/host/src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/grader-command.mjs", import.meta.url));
const PROJECT = "project-a";
const UID = process.getuid?.() ?? 0;
const sandboxes: string[] = [];

type Rig = { dir: string; root: string; mirror: string; head: string; ids: string[]; record: string; store: EvidenceStore; groups: string; key: Buffer; databasePath: string };

test.after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

/** One commit with the given files. Times are fixed so the run is the same each time. */
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

/**
 * A bare mirror with branch main and four commits. C0 has no test change. C1 adds `add` and passes its test. C2 adds a test
 * that passes at C1, so it is not fail-to-pass. C3 adds a test that passes once and fails on every later run in its job.
 */
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "infinite-eval-run-"));
  sandboxes.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  git(work, ["init", "--quiet", "--template=", "-b", "main"]);
  const ids = [
    commit(work, {
      "package.json": "{\"type\":\"module\"}\n",
      "src/math.js": "export function sub(a, b) { return a - b; }\n",
    }, "Start the math module", 1_700_000_000),
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
  mkdirSync(root);
  spawnSync("chmod", ["700", root]);
  const key = randomBytes(32);
  const databasePath = evidenceDatabasePath(join(dir, "state"));
  const store = new EvidenceStore({ databasePath, vaultKey: key });
  // The server registers the trials module; the host's summary counts today's trials through it.
  store.register(evalTrialsModule(store, () => new Date().toISOString()));
  return { dir, root, mirror, head: ids[3], ids, record: join(dir, "record.log"), store, groups: `${root}.groups`, key, databasePath };
}

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
      },
    },
  };
}

/** The host configuration, with the fixture launcher as `eval.grader` unless `metadata` is null. */
function configFor(r: Rig, options: { metadata?: "open" | "closed"; noGrader?: boolean } = {}): Config {
  const prefix = { command: process.execPath, args: [FIXTURE, "--root", r.root, "--uid", String(UID), "--metadata", options.metadata ?? "closed", "--record", r.record] };
  return {
    projects: [projectConfig()],
    stateDir: join(r.dir, "state"),
    runDir: join(r.dir, "runs"),
    keyFile: join(r.dir, "vault.key"),
    teams: { workspaceDir: join(r.dir, "workspaces") },
    ...(options.noGrader ? {} : { eval: { grader: { prefix, root: r.root } } }),
  } as unknown as Config;
}

/**
 * The launcher as the host sees it in these tests. The fixture runs as this user, so the host's own paths are readable and
 * cannot be canaries here. The probe still receives them; `seen` records each list before it is replaced with none.
 */
function testGrader(config: Config, seen: string[][] = []): Grader {
  const inner = launcherGrader(() => config.eval?.grader, { hostUid: UID + 1, graceMs: 5_000 });
  return { ...inner, probe: canaries => { seen.push([...canaries]); return inner.probe([]); } };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The fixture's own process groups, as the processes of the grader's account. The host's processes are never listed. */
async function fixtureInventory(groups: string): Promise<RuntimeProcess[]> {
  const text = existsSync(groups) ? readFileSync(groups, "utf8") : "";
  return text.split("\n").map(Number).filter(pid => Number.isInteger(pid) && pid > 1 && alive(pid))
    .map(pid => ({ pid, parent: 1, group: pid, ruid: UID, euid: UID, born: "", state: "S" }));
}

type HostOptions = {
  config?: Config; metadata?: "open" | "closed"; noGrader?: boolean; grader?: Grader | undefined; store?: EvidenceStore; mineGit?: MineGit;
  /** The owner's halt state for every project, read at each check. */
  halt?: () => "clear" | "halted";
  /** The host-load gate's hold reason, read at each check. */
  held?: () => string | undefined;
  source?: EvalHostOptions["source"];
};

function host(r: Rig, options: HostOptions = {}): EvalHost {
  const config = options.config ?? configFor(r, { metadata: options.metadata, noGrader: options.noGrader });
  const status: ProjectSourceStatus = { mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: r.head };
  return new EvalHost({
    config,
    store: options.store ?? r.store,
    source: options.source ?? { mirrorPath: () => r.mirror, status: () => status },
    hostLoad: { held: options.held ?? (() => undefined) },
    halt: () => ({ check: () => ({ state: options.halt?.() ?? "clear" }) }),
    runs: () => [],
    grader: "grader" in options ? options.grader : testGrader(config),
    inventory: () => fixtureInventory(r.groups),
    ...(options.mineGit ? { mineGit: options.mineGit } : {}),
  } as EvalHostOptions);
}

function ops(record: string): string[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").split("\n").filter(Boolean).map(line => (JSON.parse(line) as string[])[0]);
}

async function mineAll(h: EvalHost): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    h.tick();
    await h.idle();
    const summary = await h.summary(PROJECT);
    if ("code" in summary) throw new Error(`summary refused: ${summary.code}`);
    if (summary.mining.state === "caught-up") return;
  }
  throw new Error("mining did not catch up");
}

function minedRows(r: Rig): { commit: string; row: EvalTaskRow }[] {
  return r.store.read(db => {
    const ids = db.all<{ task_id: string }>("SELECT task_id FROM eval_tasks WHERE origin = 'mined' ORDER BY task_id");
    return ids.map(({ task_id }) => {
      const row = readEvalTask(db, task_id)!;
      return { commit: (row.payload as MinedPayload).commit, row };
    });
  });
}

/** The mined row of one commit, by its task id. A rejected row keeps only its project in the payload, so the commit is not read from it. */
function byCommit(r: Rig, commit: string): EvalTaskRow {
  const row = r.store.read(db => readEvalTask(db, minedTaskId(db.index("project", PROJECT), db.index("eval-commit", commit))));
  assert.ok(row, `a mined row for commit ${commit.slice(0, 8)}`);
  return row;
}

/** Every plain text column of every eval table, which must hold no file name and no commit id. */
function plainText(r: Rig): string {
  return r.store.read(db => {
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'eval_%'");
    const parts: string[] = [];
    for (const { name } of tables) {
      for (const row of db.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        for (const [column, value] of Object.entries(row)) {
          if (column !== "payload" && typeof value === "string") parts.push(value);
        }
      }
    }
    return parts.join("\n");
  });
}

test("a fixture commit becomes valid, and the two bad ones are rejected", { timeout: 600_000 }, async () => {
  const r = rig();
  const seen: string[][] = [];
  const h = host(r, { grader: testGrader(configFor(r), seen) });
  try {
    await mineAll(h);
    const first = seen[0] ?? [];
    const hostPaths = [evidenceDatabasePath(join(r.dir, "state")), join(r.dir, "vault.key"), join(r.dir, "state"), join(r.dir, "runs"), join(r.dir, "workspaces"), r.mirror];
    for (const path of hostPaths) assert.ok(first.includes(path), `the probe checks ${path}`);
    const states = [1, 2, 3].map(index => byCommit(r, r.ids[index]).state);
    assert.deepEqual(states, ["candidate", "candidate", "candidate"]);

    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created, "the job is created");
    const jobId = created.job.jobId;
    for (let attempt = 0; attempt < 40; attempt++) {
      h.tick();
      await h.idle();
      const view = h.job(jobId) as EvalJobView;
      if (view.status === "completed") break;
    }
    const job = h.job(jobId) as EvalJobView;
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(job.reason, "done");
    assert.deepEqual(job.counts, { visited: 3, valid: 1, rejected: 2, retired: 0, undecided: 0 });

    const valid = byCommit(r, r.ids[1]);
    assert.equal(valid.state, "valid", JSON.stringify(valid));
    assert.equal((valid.payload as MinedPayload & { expectedCases?: string[] }).expectedCases?.length, 1);
    const sub = byCommit(r, r.ids[2]);
    assert.equal(sub.state, "rejected");
    assert.equal(sub.reason, "not-fail-to-pass");
    const flaky = byCommit(r, r.ids[3]);
    assert.equal(flaky.state, "rejected");
    assert.equal(flaky.reason, "flaky");

    assert.equal(existsSync(join(r.root, "jobs", jobId)), false, "the grader root holds no job after the job");
    const text = plainText(r);
    assert.equal(text.includes("add.test"), false);
    for (const id of r.ids) assert.equal(text.includes(id), false);
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});

test("no grader, no validation", { timeout: 600_000 }, async () => {
  const absent = rig();
  const absentHost = host(absent, { noGrader: true, grader: undefined });
  try {
    await mineAll(absentHost);
    const created = absentHost.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    absentHost.tick();
    await absentHost.idle();
    const view = absentHost.job(created.job.jobId) as EvalJobView;
    assert.equal(view.status, "scheduled");
    assert.equal(view.waiting, "grader");
    const summary = await absentHost.summary(PROJECT);
    assert.ok(!("code" in summary));
    assert.equal(summary.grader.state, "not-configured");
    assert.deepEqual(minedRows(absent).map(entry => entry.row.state), ["candidate", "candidate", "candidate"]);
  } finally {
    absentHost.close();
    await absentHost.idle();
    absent.store.close();
  }

  const open = rig();
  const openConfig = configFor(open, { metadata: "open" });
  const openHost = host(open, { config: openConfig });
  try {
    await mineAll(openHost);
    const created = openHost.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    openHost.tick();
    await openHost.idle();
    const view = openHost.job(created.job.jobId) as EvalJobView;
    assert.equal(view.waiting, "grader");
    const summary = await openHost.summary(PROJECT);
    assert.ok(!("code" in summary));
    assert.equal(summary.grader.state, "network-open");
    assert.equal(ops(open.record).includes("run"), false, "no grader run was recorded");
    assert.equal(ops(open.record).includes("stop"), false, "no stop before the grader answers ready");
    assert.equal(ops(open.record).includes("clean"), false, "no clean before the grader answers ready");
  } finally {
    openHost.close();
    await openHost.idle();
    open.store.close();
  }
});

test("a restart in the middle of a task counts no attempt", { timeout: 600_000 }, async () => {
  const r = rig();
  const first = host(r);
  let second: EvalHost | undefined;
  try {
    await mineAll(first);
    const created = first.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    first.tick();
    for (let wait = 0; wait < 1_200 && !ops(r.record).includes("run"); wait++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ops(r.record).includes("run"), "round 1 started");
    first.close();
    const closedAt = ops(r.record).length;
    await first.idle();
    assert.deepEqual(ops(r.record).slice(closedAt).filter(op => op === "run"), [], "close halts the task in flight: no run after close");
    // A restart is a new process: a new store on the same database. The corpus module registers once per store.
    const restart = (): void => {
      r.store.close();
      r.store = new EvidenceStore({ databasePath: r.databasePath, vaultKey: r.key });
      r.store.register(evalTrialsModule(r.store, () => new Date().toISOString()));
    };
    restart();
    const mark = ops(r.record).length;

    // A stop that fails may leave a grader process in the job's work, so the host cleans nothing and starts nothing.
    const failing = host(r, { grader: { ...testGrader(configFor(r)), stop: async () => false } });
    failing.tick();
    await failing.idle();
    failing.close();
    await failing.idle();
    assert.deepEqual(ops(r.record).slice(mark).filter(op => op !== "probe"), [], "no clean and no run after a failed stop");
    restart();

    second = host(r);
    second.tick();
    await second.idle();
    const after = ops(r.record).slice(mark).filter(op => op !== "probe");
    assert.equal(after[0], "stop", JSON.stringify(after));
    assert.equal(after[1], "clean", JSON.stringify(after));
    assert.ok(after.indexOf("run") > 1, "the task runs only after stop and clean");
    assert.equal(existsSync(join(r.root, "jobs", jobId, "in", "base.bundle")), true);

    const view = second.job(jobId) as EvalJobView;
    assert.equal(view.counts.undecided, 0);
    for (const entry of minedRows(r)) assert.equal(entry.row.attempts, 0);
  } finally {
    first.close();
    second?.close();
    await first.idle();
    await second?.idle();
    r.store.close();
  }
});

test("an unavailable store takes nothing and throws nothing", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-eval-unavailable-"));
  sandboxes.push(dir);
  const root = join(dir, "grader");
  mkdirSync(root);
  const record = join(dir, "record.log");
  const config = { projects: [projectConfig()], eval: { grader: { prefix: { command: process.execPath, args: [FIXTURE, "--root", root, "--uid", String(UID), "--record", record] }, root } } } as unknown as Config;
  let calls = 0;
  const unavailable = () => { throw new EvidenceError("unavailable", "The evidence store is unavailable."); };
  const store = {
    status: () => ({ state: "unavailable", modules: {} }),
    register() { /* the capture registers its module; the store takes it and never opens */ },
    read: unavailable, write: unavailable, tryWrite: () => false, sweep: () => 0, close() { /* nothing open */ },
  } as unknown as EvidenceStore;
  const counted = <T extends object>(value: T): T => new Proxy(value, {
    get(target, key) {
      const member = Reflect.get(target, key) as unknown;
      return typeof member === "function" ? (...args: unknown[]) => { calls += 1; return (member as (...a: unknown[]) => unknown).apply(target, args); } : member;
    },
  });
  const h = new EvalHost({
    config,
    store,
    source: { mirrorPath: () => join(dir, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) as ProjectSourceStatus },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" }) }),
    runs: () => [],
    grader: counted({ probe: async () => ({ state: "ready" }), receive: async () => "failed", run: async () => ({ exitCode: null, timedOut: false, truncated: false, failed: true }), read: async () => ({ state: "failed" }), digest: async () => ({ state: "failed" }), stop: async () => true, clean: async () => true, remove: async () => true }) as unknown as Grader,
    mineGit: counted({ isAncestor: async () => "failed", firstParents: async () => undefined, parents: async () => undefined, present: async () => "failed", numstat: async () => ({ state: "failed" }), message: async () => ({ state: "failed" }) }) as unknown as MineGit,
    inventory: async () => { calls += 1; return []; },
  } as EvalHostOptions);
  assert.doesNotThrow(() => h.tick());
  assert.doesNotThrow(() => h.sweep());
  await h.idle();
  assert.deepEqual(await h.summary(PROJECT), { status: 503, code: "evidence-unavailable" });
  assert.deepEqual(h.jobs(), { status: 503, code: "evidence-unavailable" });
  assert.equal(calls, 0, "no Git and no grader command ran");
  assert.equal(ops(record).length, 0);

  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  h.routes(app, pass, pass);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/eval/projects/${PROJECT}`);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "evidence-unavailable");
  } finally {
    server.close();
  }
});

test("a grader that opens its network between tasks runs no further task", { timeout: 600_000 }, async () => {
  const r = rig();
  const config = configFor(r);
  const metadata = join(r.dir, "metadata");
  writeFileSync(metadata, "closed");
  config.eval!.grader!.prefix.args.push("--metadata-file", metadata);
  const h = host(r, { config });
  try {
    await mineAll(h);
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    for (let attempt = 0; attempt < 40; attempt++) {
      h.tick();
      await h.idle();
      if ((h.job(jobId) as EvalJobView).counts.visited === 1) break;
    }
    assert.equal((h.job(jobId) as EvalJobView).counts.visited, 1, "one task is decided before the switch");

    // The network state comes from a file the probe reads, so the pinned configuration does not change.
    writeFileSync(metadata, "open");
    const runsBefore = ops(r.record).filter(op => op === "run").length;
    for (let tick = 0; tick < 3; tick++) {
      h.tick();
      await h.idle();
    }
    const runsAfter = ops(r.record).filter(op => op === "run").length;
    assert.equal(runsAfter, runsBefore, "no run is recorded after the network opens");
    const view = h.job(jobId) as EvalJobView;
    assert.equal(view.counts.visited, 1, "visited is still 1");
    assert.equal(view.waiting, "grader", "the job waits on the grader");
    assert.notEqual(view.status, "completed", "the job is not completed");
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});

test("a grader that can read a project's mirror runs nothing", { timeout: 600_000 }, async () => {
  const r = rig();
  const config = configFor(r);
  // No wrapper: the probe receives the host's own canaries, and the fixture, running as this user, can read the mirror.
  const grader = launcherGrader(() => config.eval?.grader, { hostUid: UID + 1, graceMs: 5_000 });
  const h = host(r, { config, grader });
  try {
    await mineAll(h);
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    h.tick();
    await h.idle();
    const view = h.job(created.job.jobId) as EvalJobView;
    assert.equal(view.waiting, "grader", "the job waits on the grader");
    const summary = await h.summary(PROJECT);
    assert.ok(!("code" in summary));
    assert.equal(summary.grader.state, "exposed", "the grader state is exposed");
    assert.equal(ops(r.record).includes("run"), false, "no grader run was recorded");
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});

test("a mirror read that throws still records the task", { timeout: 600_000 }, async () => {
  const r = rig();
  let broken = false;
  const status: ProjectSourceStatus = { mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: r.head };
  // The miner reads the same source, so the read fails only once mining has caught up.
  const h = host(r, {
    source: {
      mirrorPath: () => r.mirror,
      status: () => {
        if (broken) throw new Error("mirror read failed");
        return status;
      },
    },
  });
  try {
    await mineAll(h);
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    broken = true;
    h.tick();
    await h.idle();
    const view = h.job(created.job.jobId) as EvalJobView;
    assert.equal(view.waiting, "mirror", "the task is recorded as an anchor the host could not read");
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});

test("a grader low on storage at the task's probe runs nothing", { timeout: 600_000 }, async () => {
  const r = rig();
  const base = testGrader(configFor(r));
  let low = false;
  // Mining leaves a ready probe in the cache, which the gate reads; only the probe before the task sees the room gone.
  const grader: Grader = { ...base, probe: async canaries => ({ ...(await base.probe(canaries)), ...(low ? { storage: false } : {}) }) };
  const h = host(r, { grader });
  try {
    await mineAll(h);
    low = true;
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    const before = ops(r.record).length;
    h.tick();
    await h.idle();
    assert.deepEqual(ops(r.record).slice(before).filter(op => op === "run"), [], "no task runs while the grader is low on storage");
    assert.equal((h.job(created.job.jobId) as EvalJobView).waiting, "storage");
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});

test("the owner's halt and the host's load hold validation", { timeout: 600_000 }, async () => {
  const r = rig();
  let halt: "clear" | "halted" = "clear";
  let held: string | undefined;
  const h = host(r, { halt: () => halt, held: () => held });
  try {
    await mineAll(h);
    const created = h.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, randomUUID());
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    const holds = [{ halt: "halted", held: undefined, waiting: "halt" }, { halt: "clear", held: "memory", waiting: "host-load" }] as const;
    for (const hold of holds) {
      halt = hold.halt;
      held = hold.held;
      h.tick();
      await h.idle();
      assert.equal((h.job(jobId) as EvalJobView).waiting, hold.waiting);
      assert.equal(ops(r.record).includes("run"), false, `no grader run while the job waits on ${hold.waiting}`);
    }
    held = undefined;
    for (let attempt = 0; attempt < 40 && (h.job(jobId) as EvalJobView).counts.visited === 0; attempt++) {
      h.tick();
      await h.idle();
    }
    assert.ok((h.job(jobId) as EvalJobView).counts.visited >= 1, "the job runs once both clear");
  } finally {
    h.close();
    await h.idle();
    r.store.close();
  }
});
