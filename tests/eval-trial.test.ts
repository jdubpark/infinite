import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { parseReport } from "../packages/host/src/eval-report.js";
import { launcherEvalIdentity, type EvalIdentity } from "../packages/host/src/eval-identity.js";
import { launcherGrader, type Grader, type GraderRun } from "../packages/host/src/eval-grader.js";
import { gradeTrial, prepareTrialSource, type TrialContext } from "../packages/host/src/eval-trial.js";
import type { BundleState } from "../packages/host/src/eval-validate.js";
import type { EvalGraderConfig, EvalMemberConfig, ValidationSettings } from "../packages/host/src/eval-config.js";

const GRADER_FIXTURE = fileURLToPath(new URL("./fixtures/grader-command.mjs", import.meta.url));
const EVAL_FIXTURE = fileURLToPath(new URL("./fixtures/eval-command.mjs", import.meta.url));
const NOW = "2026-11-17T10:00:00.000Z";
const PROJECT = "project-trial-1";
const RUN = "run-trial-1";
const JOB = "11111111-2222-4333-8444-555555555555";
const TRIAL = "00000000-0000-4000-8000-000000000001";
const TASK = "mined:run-trial-1:m-1";
const GRADER_UID = 4242;
const EVAL_UID = 777;
const HIDDEN = "tests/a.test.txt";
const FEATURES = { role: "implementer" as const, area: "src", kind: "fix", risk: "normal" as const, featureVersion: 1 };
const CAPSULE = {
  objective: "Make the file read fixed.",
  steering: [],
  ownerAnswers: [],
  task: { id: "t-1", title: "Fix the file", instructions: "Set src/x.txt to fixed.", paths: ["src/x.txt"] },
};
const RUNNER = [
  "import fs from \"node:fs\";",
  "const args = process.argv.slice(2);",
  "const report = args.find(arg => arg.startsWith(\"--report=\")).slice(\"--report=\".length);",
  "const files = args.filter(arg => !arg.startsWith(\"--report=\"));",
  "const expected = fs.readFileSync(\"src/x.txt\", \"utf8\");",
  "const cases = files.map(file => {",
  "  const name = file.replace(/^\\.\\//, \"\");",
  "  const passed = fs.existsSync(file) && fs.readFileSync(file, \"utf8\") === expected;",
  "  return `<testcase name=\"${name}\" classname=\"cls\">${passed ? \"\" : \"<failure message=\\\"x\\\"/>\"}</testcase>`;",
  "});",
  "fs.writeFileSync(report, `<?xml version=\"1.0\" encoding=\"utf-8\"?><testsuites><testsuite name=\"suite\">${cases.join(\"\")}</testsuite></testsuites>`);",
  "",
].join("\n");
const SETTINGS: ValidationSettings = {
  focusedTest: { command: process.execPath, args: ["runner.mjs", "{files}", "--report={report}"] },
  reportFormat: "junit",
  gradingPaths: [],
  guardChecks: [],
};
const KEY = [...parseReport("junit", Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="suite"><testcase name="${HIDDEN}" classname="cls"></testcase></testsuite></testsuites>`,
)).cases.keys()][0];
const PAYLOAD = {
  projectId: PROJECT, anchorCommit: "", commit: "", commitTime: NOW, promptOrigin: "commit-message",
  files: ["src/x.txt", HIDDEN], hiddenFiles: [HIDDEN], features: FEATURES, expectedCases: [KEY],
};

type Rig = {
  root: string; work: string; mirror: string; anchor: string; commit: string;
  graderRoot: string; evalRoot: string; evalHome: string; evalTmp: string; evalTemplate: string;
  store: EvidenceStore; close: () => void;
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitStatus(cwd: string, args: string[]): number {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status ?? -1;
}

function commitFiles(work: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ["add", "-A"]);
  git(work, ["-c", "user.name=Placeholder", "-c", "user.email=placeholder@example.invalid", "commit", "-q", "--no-verify", "-m", message]);
  return git(work, ["rev-parse", "HEAD"]);
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-trial-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, ["init", "--quiet", "--template=", "-b", "main"]);
  const anchor = commitFiles(work, { "src/x.txt": "broken\n", "runner.mjs": RUNNER, "package.json": "{\"type\":\"module\"}\n" }, "Start");
  const commit = commitFiles(work, { "src/x.txt": "fixed\n", [HIDDEN]: "fixed\n" }, "Fix");
  const mirror = join(root, "mirror.git");
  git(root, ["clone", "--quiet", "--bare", work, mirror]);
  const graderRoot = join(root, "grader");
  mkdirSync(graderRoot, { mode: 0o700 });
  const evalRoot = join(root, "eval");
  mkdirSync(join(evalRoot, "trials"), { recursive: true });
  chmodSync(evalRoot, 0o711);
  const evalHome = join(root, "eval-home");
  const evalTmp = join(root, "eval-tmp");
  const evalTemplate = join(root, "eval-template");
  for (const dir of [evalHome, evalTmp, evalTemplate]) mkdirSync(dir);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, attempts) VALUES (?, 'mined', ?, 'm-1', ?, 'valid', NULL, 'none', 'none', 0, ?, ?, ?, NULL, 0)",
      TASK, RUN, tx.index("project", PROJECT), NOW, NOW, tx.seal("eval_tasks", TASK, { ...PAYLOAD, anchorCommit: anchor, commit }),
    );
    tx.run("INSERT INTO eval_material (task_id, part, bytes, payload) VALUES (?, 'capsule', 0, ?)",
      TASK, tx.seal("eval_material", `${TASK}/capsule`, { capsule: CAPSULE }));
  });
  return {
    root, work, mirror, anchor, commit, graderRoot, evalRoot, evalHome, evalTmp, evalTemplate, store,
    close: () => {
      store.close();
      spawnSync("chmod", ["-R", "u+rwX", root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function graderOf(fx: Rig): Grader {
  const config: EvalGraderConfig = {
    prefix: { command: process.execPath, args: [GRADER_FIXTURE, "--root", fx.graderRoot, "--uid", String(GRADER_UID)] },
    root: fx.graderRoot,
  };
  return launcherGrader(() => config, { hostUid: -1, graceMs: 5_000 });
}

function identityOf(fx: Rig): EvalIdentity {
  const member: EvalMemberConfig = {
    prefix: {
      command: process.execPath,
      args: [EVAL_FIXTURE, "--root", fx.evalRoot, "--uid", String(process.getuid?.() ?? 0), "--home", fx.evalHome,
        "--template", fx.evalTemplate, "--tmp", fx.evalTmp],
    },
    root: fx.evalRoot,
    agents: {},
  };
  return launcherEvalIdentity(() => member, { hostUid: -1, graceMs: 5_000 });
}

const bundleOf = (mirror: string) => (): ChildProcess => spawn("git", ["-C", mirror, "bundle", "create", "-", "--all"], { stdio: ["ignore", "pipe", "ignore"] });

function contextOf(fx: Rig, grader: Grader, identity: EvalIdentity, over: Partial<TrialContext> = {}): TrialContext {
  const bundle: BundleState = { spawn: bundleOf(fx.mirror), job: null, sha256: null, restreamedFor: null, tooLarge: null };
  return {
    jobId: JOB, projectId: PROJECT, settings: SETTINGS, grader, graderRoot: fx.graderRoot, uid: GRADER_UID,
    mirror: fx.mirror, mirrorHead: fx.commit, git: { isAncestor: async () => "yes" }, halted: () => false,
    inventory: async () => [], now: () => NOW, bundle,
    trialId: TRIAL, identity, evalUid: EVAL_UID, probe: { state: "ready", fetch: "refused" }, root: fx.evalRoot,
    ...over,
  };
}

function spied<T extends object>(target: T, calls: string[], label: string): T {
  return new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${label}.${String(key)}`);
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

function focusedAs(grader: Grader, run: Partial<GraderRun>): Grader {
  return {
    ...grader,
    async run(job, dir, seconds, argv, options) {
      if (argv[0] === process.execPath) return { exitCode: 0, timedOut: false, truncated: false, failed: false, ...run };
      return grader.run(job, dir, seconds, argv, options);
    },
  };
}

function exportingReference(grader: Grader): Grader {
  return {
    ...grader,
    async run(job, dir, seconds, argv, options) {
      const rewritten = argv.includes("refs/heads/trial") ? argv.map(arg => (arg === "refs/tags/eval-base" ? "refs/tags/eval-reference" : arg)) : argv;
      return grader.run(job, dir, seconds, rewritten, options);
    },
  };
}

function memberCommit(work: string, files: Record<string, string>): string {
  return commitFiles(work, files, "Member change");
}

test("the trial source holds only the base", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, grader, identity);
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const workspace = join(fx.evalRoot, "trials", TRIAL, "work");
    assert.equal(source.workspace, workspace);
    assert.equal(source.baseCommit, fx.anchor);
    assert.equal(source.isolation, "isolated");
    assert.deepEqual(source.hiddenFiles, [HIDDEN]);
    assert.notEqual(gitStatus(workspace, ["cat-file", "-e", `${fx.commit}^{commit}`]), 0, "the reference commit is absent");
    const blob = git(fx.mirror, ["rev-parse", `${fx.commit}:${HIDDEN}`]);
    assert.notEqual(gitStatus(workspace, ["cat-file", "-e", blob]), 0, "the hidden file's reference blob is absent");
    assert.equal(git(workspace, ["remote"]), "", "no remote");
    assert.equal(existsSync(join(workspace, HIDDEN)), false, "no hidden test file in the workspace");
    assert.equal(existsSync(join(fx.evalRoot, "trials", TRIAL, "in")), false, "the bundle directory is gone");

    const leaking = contextOf(fx, exportingReference(grader), identity);
    const skipped = await prepareTrialSource(fx.store, TASK, leaking);
    assert.deepEqual(skipped, { kind: "skip", reason: "source-leaked" });
    assert.deepEqual(readdirSync(join(fx.evalRoot, "trials")), [], "no trial workspace remains");
  } finally {
    fx.close();
  }
});

test("a member that applies the reference is resolved", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, grader, identity);
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n" });
    const graded = await gradeTrial(fx.store, {
      taskId: TASK, baseCommit: source.baseCommit, resultCommit: result, workspace: source.workspace,
      hiddenFiles: source.hiddenFiles, isolation: source.isolation,
    }, ctx);
    assert.equal(graded.kind, "graded", JSON.stringify(graded));
    if (graded.kind !== "graded") return;
    assert.equal(graded.grade.ending, "graded");
    assert.equal(graded.grade.expectedPassed, graded.grade.expectedTotal);
    assert.equal(graded.grade.expectedTotal, 1);
    assert.equal(graded.grade.guardPassed, true);
    assert.equal(graded.grade.resolved, true);
    assert.equal(graded.grade.overwritten, 0);
    assert.equal(graded.grade.isolation, "isolated");
  } finally {
    fx.close();
  }
});

test("an exit code never resolves", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, grader, identity);
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const input = (resultCommit: string) => ({
      taskId: TASK, baseCommit: source.kind === "ready" ? source.baseCommit : "", resultCommit, workspace: source.kind === "ready" ? source.workspace : "",
      hiddenFiles: [HIDDEN], isolation: "isolated" as const,
    });

    const silent = memberCommit(source.workspace, { "README.md": "silent\n" });
    const noReport = await gradeTrial(fx.store, input(silent), contextOf(fx, focusedAs(grader, { exitCode: 0 }), identity));
    assert.equal(noReport.kind, "graded", JSON.stringify(noReport));
    if (noReport.kind !== "graded") return;
    assert.equal(noReport.grade.expectedPassed, null);
    assert.equal(noReport.grade.resolved, false);

    const wrong = memberCommit(source.workspace, { "README.md": "wrong\n" });
    const failed = await gradeTrial(fx.store, input(wrong), ctx);
    assert.equal(failed.kind, "graded", JSON.stringify(failed));
    if (failed.kind !== "graded") return;
    assert.equal(failed.grade.expectedPassed, 0);
    assert.equal(failed.grade.resolved, false);
  } finally {
    fx.close();
  }
});

test("a grading path edit is overwritten", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, grader, identity, { settings: { ...SETTINGS, gradingPaths: ["package.json"] } });
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n", "package.json": "{\"type\":\"module\",\"edited\":true}\n" });
    const graded = await gradeTrial(fx.store, {
      taskId: TASK, baseCommit: source.baseCommit, resultCommit: result, workspace: source.workspace,
      hiddenFiles: source.hiddenFiles, isolation: source.isolation,
    }, ctx);
    assert.equal(graded.kind, "graded", JSON.stringify(graded));
    if (graded.kind !== "graded") return;
    assert.equal(graded.grade.overwritten, 1);
    assert.equal(graded.grade.resolved, true);
  } finally {
    fx.close();
  }
});

test("a grading time-out ends timeout", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, focusedAs(grader, { exitCode: null, timedOut: true }), identity);
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n" });
    const graded = await gradeTrial(fx.store, {
      taskId: TASK, baseCommit: source.baseCommit, resultCommit: result, workspace: source.workspace,
      hiddenFiles: source.hiddenFiles, isolation: source.isolation,
    }, ctx);
    assert.equal(graded.kind, "graded", JSON.stringify(graded));
    if (graded.kind !== "graded") return;
    assert.equal(graded.grade.ending, "timeout");
    assert.equal(graded.grade.resolved, false);
    assert.equal(graded.grade.expectedPassed, null);
  } finally {
    fx.close();
  }
});

test("an unreadable task starts no trial", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    fx.store.write(tx => {
      tx.run("UPDATE eval_tasks SET payload = ? WHERE task_id = ?", "not a sealed payload", TASK);
    });
    const calls: string[] = [];
    const grader = spied(graderOf(fx), calls, "grader");
    const identity = spied(identityOf(fx), calls, "identity");
    const source = await prepareTrialSource(fx.store, TASK, contextOf(fx, grader, identity));
    assert.deepEqual(source, { kind: "skip", reason: "unreadable" });
    assert.deepEqual(calls, [], "no launcher command ran");
  } finally {
    fx.close();
  }
});

const TOKEN = `ghp_${"a1B2".repeat(9)}`;

type Source = Extract<Awaited<ReturnType<typeof prepareTrialSource>>, { kind: "ready" }>;

const inputOf = (source: Source, resultCommit: string, baseCommit = source.baseCommit) => ({
  taskId: TASK, baseCommit, resultCommit, workspace: source.workspace, hiddenFiles: source.hiddenFiles, isolation: source.isolation,
});

function keyOf(name: string): string {
  return [...parseReport("junit", Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="suite"><testcase name="${name}" classname="cls"></testcase></testsuite></testsuites>`,
  )).cases.keys()][0];
}

function exportingCommit(grader: Grader, target: string): Grader {
  return {
    ...grader,
    async run(job, dir, seconds, argv, options) {
      const rewritten = argv.includes("refs/heads/trial") ? argv.map(arg => (arg === "refs/tags/eval-base" ? target : arg)) : argv;
      return grader.run(job, dir, seconds, rewritten, options);
    },
  };
}

test("a task that cannot be a trial source starts no trial", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const calls: string[] = [];
    const run = () => prepareTrialSource(fx.store, TASK, contextOf(fx, spied(graderOf(fx), calls, "grader"), spied(identityOf(fx), calls, "identity")));
    const reseal = (payload: object) => fx.store.write(tx => {
      tx.run("UPDATE eval_tasks SET payload = ? WHERE task_id = ?", tx.seal("eval_tasks", TASK, { ...PAYLOAD, anchorCommit: fx.anchor, commit: fx.commit, ...payload }), TASK);
    });
    const capsule = (body: object | null) => fx.store.write(tx => {
      if (body === null) tx.run("DELETE FROM eval_material WHERE task_id = ?", TASK);
      else tx.run("UPDATE eval_material SET payload = ? WHERE task_id = ?", tx.seal("eval_material", `${TASK}/capsule`, { capsule: body }), TASK);
    });

    fx.store.write(tx => tx.run("UPDATE eval_tasks SET state = 'candidate' WHERE task_id = ?", TASK));
    assert.deepEqual(await run(), { kind: "skip", reason: "not-valid" });
    fx.store.write(tx => tx.run("UPDATE eval_tasks SET state = 'valid' WHERE task_id = ?", TASK));

    reseal({ expectedCases: [] });
    assert.deepEqual(await run(), { kind: "skip", reason: "expected-missing" });
    reseal({});

    capsule({ ...CAPSULE, objective: `Use ${TOKEN} to fetch.` });
    assert.deepEqual(await run(), { kind: "skip", reason: "secret-shaped" });
    capsule(null);
    assert.deepEqual(await run(), { kind: "skip", reason: "unreadable" });
    assert.deepEqual(calls, [], "no launcher command ran");
  } finally {
    fx.close();
  }
});

test("a leak of the mirror head or of a hidden blob alone skips the source", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    git(fx.work, ["checkout", "-q", "-b", "blob-only", fx.anchor]);
    const blobOnly = commitFiles(fx.work, { [HIDDEN]: "fixed\n" }, "Blob only");
    git(fx.work, ["checkout", "-q", "-b", "head-only", fx.anchor]);
    const headOnly = commitFiles(fx.work, { "other.txt": "other\n" }, "Head only");
    git(fx.work, ["push", "-q", fx.mirror, "blob-only", "head-only"]);
    const grader = graderOf(fx);
    const identity = identityOf(fx);

    const blob = await prepareTrialSource(fx.store, TASK, contextOf(fx, exportingCommit(grader, blobOnly), identity));
    assert.deepEqual(blob, { kind: "skip", reason: "source-leaked" });
    const head = await prepareTrialSource(fx.store, TASK, contextOf(fx, exportingCommit(grader, headOnly), identity, { mirrorHead: headOnly }));
    assert.deepEqual(head, { kind: "skip", reason: "source-leaked" });
    assert.deepEqual(readdirSync(join(fx.evalRoot, "trials")), [], "no trial workspace remains");
  } finally {
    fx.close();
  }
});

test("a result that adds a hidden file the reference lacks does not keep it", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const ghost = "tests/ghost.test.txt";
    fx.store.write(tx => {
      tx.run("UPDATE eval_tasks SET payload = ? WHERE task_id = ?",
        tx.seal("eval_tasks", TASK, { ...PAYLOAD, anchorCommit: fx.anchor, commit: fx.commit, hiddenFiles: [HIDDEN, ghost], expectedCases: [keyOf(ghost)] }), TASK);
    });
    const ctx = contextOf(fx, graderOf(fx), identityOf(fx));
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n", [ghost]: "fixed\n" });
    const graded = await gradeTrial(fx.store, inputOf(source, result), ctx);
    assert.equal(graded.kind, "graded", JSON.stringify(graded));
    if (graded.kind !== "graded") return;
    assert.equal(graded.grade.expectedPassed, 0);
    assert.equal(graded.grade.resolved, false);
  } finally {
    fx.close();
  }
});

test("a second round runs when the first leaves no report", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const source = await prepareTrialSource(fx.store, TASK, contextOf(fx, grader, identity));
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    let focusedRuns = 0;
    const flaky: Grader = {
      ...grader,
      async run(job, dir, seconds, argv, options) {
        if (argv[0] === process.execPath) {
          focusedRuns += 1;
          if (focusedRuns === 1) return { exitCode: 0, timedOut: false, truncated: false, failed: false };
        }
        return grader.run(job, dir, seconds, argv, options);
      },
    };
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n" });
    const graded = await gradeTrial(fx.store, inputOf(source, result), contextOf(fx, flaky, identity));
    assert.equal(graded.kind, "graded", JSON.stringify(graded));
    if (graded.kind !== "graded") return;
    assert.equal(focusedRuns, 2);
    assert.equal(graded.grade.expectedPassed, 1);
    assert.equal(graded.grade.resolved, true);
  } finally {
    fx.close();
  }
});

test("a failing guard check keeps a passing trial from resolving", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const check = (code: number) => ({ command: process.execPath, args: ["-e", `process.exit(${code})`] });
    const source = await prepareTrialSource(fx.store, TASK, contextOf(fx, grader, identity));
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;
    const result = memberCommit(source.workspace, { "src/x.txt": "fixed\n" });
    const failing = await gradeTrial(fx.store, inputOf(source, result), contextOf(fx, grader, identity, { settings: { ...SETTINGS, guardChecks: [check(1)] } }));
    assert.equal(failing.kind, "graded", JSON.stringify(failing));
    if (failing.kind !== "graded") return;
    assert.equal(failing.grade.expectedPassed, 1);
    assert.equal(failing.grade.guardPassed, false);
    assert.equal(failing.grade.resolved, false);
    const passing = await gradeTrial(fx.store, inputOf(source, result), contextOf(fx, grader, identity, { settings: { ...SETTINGS, guardChecks: [check(0)] } }));
    assert.equal(passing.kind, "graded", JSON.stringify(passing));
    if (passing.kind !== "graded") return;
    assert.equal(passing.grade.guardPassed, true);
    assert.equal(passing.grade.resolved, true);
  } finally {
    fx.close();
  }
});

test("a refused, oversize, or secret-shaped result is never graded as resolved or stored whole", { timeout: 120_000 }, async () => {
  const fx = rig();
  try {
    const grader = graderOf(fx);
    const identity = identityOf(fx);
    const ctx = contextOf(fx, grader, identity);
    const source = await prepareTrialSource(fx.store, TASK, ctx);
    assert.equal(source.kind, "ready", JSON.stringify(source));
    if (source.kind !== "ready") return;

    const mid = memberCommit(source.workspace, { "src/x.txt": "mid\n" });
    const last = memberCommit(source.workspace, { "src/x.txt": "fixed\n" });
    const refused = await gradeTrial(fx.store, inputOf(source, last, mid), ctx);
    assert.equal(refused.kind, "graded", JSON.stringify(refused));
    if (refused.kind !== "graded") return;
    assert.equal(refused.grade.ending, "scope-violation");
    assert.equal(refused.grade.resolved, false);
    assert.equal(refused.grade.expectedPassed, null);

    const secret = memberCommit(source.workspace, { "src/x.txt": "fixed\n", "notes.txt": `${TOKEN}\n` });
    const marked = await gradeTrial(fx.store, inputOf(source, secret), ctx);
    assert.equal(marked.kind, "graded", JSON.stringify(marked));
    if (marked.kind !== "graded") return;
    assert.equal(marked.patch, "secret-shaped");
    assert.equal(marked.grade.resolved, true);

    const big = memberCommit(source.workspace, { "src/x.txt": "fixed\n", "big.txt": `${"x".repeat(1_100_000)}\n` });
    const large = await gradeTrial(fx.store, inputOf(source, big), ctx);
    assert.equal(large.kind, "graded", JSON.stringify(large));
    if (large.kind !== "graded") return;
    assert.equal(large.patch, "too-large");
    assert.equal(large.grade.ending, "scope-violation");
    assert.equal(large.grade.resolved, false);
  } finally {
    fx.close();
  }
});
