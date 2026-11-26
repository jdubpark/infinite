import { PassThrough } from "node:stream";
import { posix } from "node:path";
import type { EvidenceStore } from "./evidence/store.js";
import { findSecret } from "./evidence/secret-scan.js";
import { captureGit } from "./eval-git.js";
import { stopGrader } from "./eval-grader.js";
import { type EvalIdentity, type EvalProbe, stopEvalIdentity } from "./eval-identity.js";
import { readMaterial } from "./eval-store.js";
import { type GradeFacts, gradeOf, isolationLabel, restoreSet } from "./eval-trial-rules.js";
import type { Capsule, EvalFeatures, EvalTaskRow, PatchRead, TrialGrade } from "./eval-types.js";
import { PREPARE_SECONDS, type RoundOutcome, SETUP_SECONDS } from "./eval-validate-rules.js";
import { applyCaptured, applyPatch, changedNames, cloneTask, ensureBundle, expectZero, exec, finish, focused, guardChecks, loadTask, Stop, tagMined, type ValidateContext } from "./eval-validate.js";
import type { GraderDir } from "./eval-grader.js";
import { COMMIT_ID } from "./outcome-hold.js";
import { isTestPath } from "./task-features.js";

export const TRIAL_BUNDLE_MAX_BYTES = 1_073_741_824, GRADE_ROUNDS = 2, DIFF_OUTPUT_MAX = 65_536;

export type TrialContext = ValidateContext & {
  trialId: string; identity: EvalIdentity; evalUid: number; probe: EvalProbe;
  root: string;
};
export type SourceResult =
  | { kind: "ready"; baseCommit: string; workspace: string; hiddenFiles: string[]; isolation: "isolated" | "none"; capsule: Capsule; features: EvalFeatures }
  | { kind: "skip"; reason: "unreadable" | "not-valid" | "expected-missing" | "secret-shaped" | "source-leaked" }
  | { kind: "environment"; cause: "grader-failed" | "grader-processes-alive" | "eval-failed" | "eval-processes-alive" | "bundle-missing" | "halted" | "storage" };
export type GradeResult =
  | { kind: "graded"; grade: TrialGrade; patch?: Buffer | "too-large" | "secret-shaped" }
  | { kind: "environment"; cause: "grader-failed" | "grader-processes-alive" | "eval-processes-alive" | "task-gone" | "halted" };

type ActiveTask = Extract<EvalTaskRow, { state: "candidate" | "valid" }>;
type SourceCause = Extract<SourceResult, { kind: "environment" }>["cause"];
type GradeCause = Extract<GradeResult, { kind: "environment" }>["cause"];
type Transfer = "ok" | "storage" | "grader-failed" | "eval-failed";

function fail(cause: "grader-failed" | "bundle-missing"): never {
  throw new Stop({ kind: "environment", cause });
}

function haltedNow(ctx: ValidateContext): void {
  if (ctx.halted()) throw new Stop({ kind: "environment", cause: "halted" });
}

function cloneIds(task: ActiveTask): string[] {
  return task.origin === "mined" ? [task.payload.anchorCommit, task.payload.commit] : [task.payload.anchorCommit];
}

function capsuleOf(store: EvidenceStore, taskId: string): Capsule | undefined {
  try {
    return store.read(db => readMaterial(db, taskId).capsule);
  } catch {
    return undefined;
  }
}

function sourceCause(cause: string): SourceCause {
  if (cause === "grader-processes-alive" || cause === "halted" || cause === "bundle-missing") return cause;
  return "grader-failed";
}

function gradeCause(cause: string): GradeCause {
  if (cause === "grader-processes-alive" || cause === "halted") return cause;
  return "grader-failed";
}

export async function prepareTrialSource(store: EvidenceStore, taskId: string, ctx: TrialContext): Promise<SourceResult> {
  const loaded = loadTask(store, taskId);
  if (loaded.kind === "absent") return { kind: "skip", reason: "not-valid" };
  if (loaded.kind === "unreadable") return { kind: "skip", reason: "unreadable" };
  const { task, material } = loaded;
  if (task.state !== "valid") return { kind: "skip", reason: "not-valid" };
  const expected = task.payload.expectedCases;
  const hidden = task.payload.hiddenFiles;
  const features = task.payload.features;
  if (!expected?.length) return { kind: "skip", reason: "expected-missing" };
  if (!hidden?.length || !features) return { kind: "skip", reason: "not-valid" };
  const capsule = capsuleOf(store, taskId);
  if (capsule === undefined) return { kind: "skip", reason: "unreadable" };
  if (findSecret(capsule, { token: "", url: "" }) !== undefined) return { kind: "skip", reason: "secret-shaped" };

  let result: SourceResult;
  try {
    result = await buildSource(ctx, task, material, capsule, features, hidden);
  } catch (error) {
    if (!(error instanceof Stop)) {
      await finish(ctx);
      throw error;
    }
    const outcome = error.outcome;
    if (outcome.kind === "environment") result = { kind: "environment", cause: sourceCause(outcome.cause) };
    else if (outcome.verdict.kind === "reject") result = { kind: "skip", reason: "not-valid" };
    else result = { kind: "environment", cause: "grader-failed" };
  }
  const cleanup = await finish(ctx);
  if (cleanup) {
    if (result.kind === "ready") await ctx.identity.clean();
    return { kind: "environment", cause: sourceCause(cleanup) };
  }
  return result;
}

async function buildSource(
  ctx: TrialContext, task: Extract<EvalTaskRow, { state: "valid" }>,
  material: { baseDelta?: Buffer; reference?: Buffer }, capsule: Capsule, features: EvalFeatures, hidden: string[],
): Promise<SourceResult> {
  await ensureBundle(ctx);
  await cloneTask(ctx, cloneIds(task));
  if (task.origin === "mined") await tagMined(ctx, task.payload.anchorCommit, task.payload.commit);
  else await applyCaptured(ctx, task.payload, material);
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/heads/trial", "refs/tags/eval-base"] }));
  const { base, reference } = await tagCommits(ctx);
  const blobs = await hiddenBlobs(ctx, hidden);

  haltedNow(ctx);
  const reset = await resetEval(ctx);
  if (reset) return { kind: "environment", cause: reset };
  haltedNow(ctx);
  const transfer = await transferTrial(ctx);
  if (transfer !== "ok") {
    await ctx.identity.clean();
    return { kind: "environment", cause: transfer };
  }
  if ((await ctx.identity.prepare(ctx.trialId)) !== "ready") {
    await ctx.identity.clean();
    return { kind: "environment", cause: "eval-failed" };
  }
  const integrated = task.origin === "captured" ? [task.payload.integratedHead] : [];
  const objects = [...new Set([task.payload.commit, ...integrated, reference, ctx.mirrorHead, ...blobs])];
  const verdict = await ctx.identity.check(ctx.trialId, objects);
  if (verdict === "failed") {
    await ctx.identity.clean();
    return { kind: "environment", cause: "eval-failed" };
  }
  if (verdict === "leaked") {
    await ctx.identity.clean();
    return { kind: "skip", reason: "source-leaked" };
  }
  return {
    kind: "ready", baseCommit: base, workspace: posix.join(ctx.root, "trials", ctx.trialId, "work"), hiddenFiles: hidden,
    isolation: isolationLabel({ probe: ctx.probe, sourceClean: true }), capsule, features,
  };
}

async function tagCommits(ctx: ValidateContext): Promise<{ base: string; reference: string }> {
  const run = await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, keepStdout: true, argv: ["git", "rev-parse", "eval-base", "eval-reference"] });
  expectZero(run);
  const lines = (run.stdout ?? Buffer.alloc(0)).toString("utf8").trim().split("\n");
  if (lines.length !== 2 || !lines.every(line => COMMIT_ID.test(line))) fail("grader-failed");
  return { base: lines[0], reference: lines[1] };
}

async function hiddenBlobs(ctx: ValidateContext, hidden: string[]): Promise<string[]> {
  if (hidden.length === 0) return [];
  const run = await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, keepStdout: true, argv: ["git", "ls-tree", "-z", "eval-reference", "--", ...hidden] });
  expectZero(run);
  if (run.truncated) fail("grader-failed");
  return (run.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean)
    .map(entry => entry.split("\t")[0].split(" ")[2])
    .filter((blob): blob is string => blob !== undefined && COMMIT_ID.test(blob));
}

async function resetEval(ctx: TrialContext): Promise<"eval-failed" | "eval-processes-alive" | undefined> {
  const stopState = await stopEvalIdentity(ctx.identity, ctx.evalUid, ctx.inventory);
  if (stopState === "alive") return "eval-processes-alive";
  if (stopState === "failed") return "eval-failed";
  if (!(await ctx.identity.clean()) || !(await ctx.identity.scrub())) return "eval-failed";
  const probe = await ctx.identity.probe({ canaries: [], graderUid: ctx.uid });
  if (probe.state === "ready") return undefined;
  return probe.state === "busy" ? "eval-processes-alive" : "eval-failed";
}

async function transferTrial(ctx: TrialContext): Promise<Transfer> {
  const pass = new PassThrough();
  pass.on("error", () => undefined);
  const exporting = ctx.grader.export(ctx.jobId, pass, TRIAL_BUNDLE_MAX_BYTES).then(
    result => {
      pass.end();
      return result;
    },
    () => {
      pass.end();
      return "failed" as const;
    },
  );
  const stored = await ctx.identity.receive(ctx.trialId, pass, TRIAL_BUNDLE_MAX_BYTES);
  pass.destroy();
  const exported = await exporting;
  if (exported === "too-large" || stored === "too-large") return "storage";
  if (exported !== "exported") return "grader-failed";
  return stored === "stored" ? "ok" : "eval-failed";
}

export async function gradeTrial(
  store: EvidenceStore,
  input: { taskId: string; baseCommit: string; resultCommit: string | undefined; workspace: string; hiddenFiles: string[]; isolation: "isolated" | "none" },
  ctx: TrialContext,
): Promise<GradeResult> {
  const loaded = loadTask(store, input.taskId);
  if (loaded.kind !== "task") return { kind: "environment", cause: "task-gone" };
  const { task, material } = loaded;
  const expected = task.payload.expectedCases ?? [];
  const common = { expected, isolation: input.isolation };
  if (input.resultCommit === undefined) {
    return { kind: "graded", grade: gradeOf({ ...common, ending: "no-result", overwritten: 0, diff: null }) };
  }

  const git = captureGit(() => ctx.identity.teamPrefix());
  let read: PatchRead;
  try {
    read = await git.patch(input.workspace, input.baseCommit, input.resultCommit);
  } finally {
    git.close?.();
  }
  if (read.state === "too-large") {
    return { kind: "graded", grade: gradeOf({ ...common, ending: "scope-violation", overwritten: 0, diff: null }), patch: "too-large" };
  }
  if (read.state !== "read") {
    const stopState = await stopEvalIdentity(ctx.identity, ctx.evalUid, ctx.inventory);
    return { kind: "environment", cause: stopState === "stopped" ? "grader-failed" : "eval-processes-alive" };
  }
  const secret = findSecret(read.bytes.toString("utf8"), { token: "", url: "" }) !== undefined;
  const patch = secret ? "secret-shaped" as const : read.bytes;

  const stopped = await stopGrader(ctx.grader, ctx.uid, ctx.inventory);
  if (stopped === "alive") return { kind: "environment", cause: "grader-processes-alive" };
  if (stopped === "failed") return { kind: "environment", cause: "grader-failed" };

  let facts: Omit<GradeFacts, "expected" | "isolation">;
  try {
    facts = await gradeSteps(ctx, task, material, read.bytes, expected);
  } catch (error) {
    if (!(error instanceof Stop)) {
      await finish(ctx);
      throw error;
    }
    const outcome = error.outcome;
    if (outcome.kind === "environment") {
      await finish(ctx);
      return { kind: "environment", cause: gradeCause(outcome.cause) };
    }
    facts = { ending: "scope-violation", overwritten: 0, diff: null };
  }
  const cleanup = await finish(ctx);
  if (cleanup) return { kind: "environment", cause: gradeCause(cleanup) };
  return { kind: "graded", grade: gradeOf({ ...common, ...facts }), patch };
}

async function gradeSteps(
  ctx: TrialContext, task: ActiveTask,
  material: { baseDelta?: Buffer; reference?: Buffer }, bytes: Buffer, expected: string[],
): Promise<Omit<GradeFacts, "expected" | "isolation">> {
  await ensureBundle(ctx);
  await cloneTask(ctx, cloneIds(task));
  if (task.origin === "mined") await tagMined(ctx, task.payload.anchorCommit, task.payload.commit);
  else await applyCaptured(ctx, task.payload, material);
  expectZero(await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS,
    argv: ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "eval-base"],
  }));
  haltedNow(ctx);
  await applyPatch(ctx, "result.patch", bytes);
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/tags/eval-result", "HEAD"] }));

  const resultChanged = await changedNames(ctx, "eval-base", "eval-result");
  const referenceChanged = await changedNames(ctx);
  const hidden = task.payload.hiddenFiles ?? [];
  const set = restoreSet({
    referenceChanged, resultChanged, hiddenFiles: hidden, gradingPaths: ctx.settings.gradingPaths, testPath: isTestPath,
  });
  const diff = await diffOf(ctx);

  let outcome: RoundOutcome = await gradeRound(ctx, 1, hidden, set.restore);
  for (let n = 2; n <= GRADE_ROUNDS && outcome.kind !== "timeout" && !parsed(outcome); n += 1) {
    outcome = await gradeRound(ctx, n as 1 | 2, hidden, set.restore);
  }
  if (outcome.kind === "timeout") return { ending: "timeout", overwritten: set.overwritten, diff };

  const report = outcome.kind === "report" ? outcome.report : undefined;
  const cases = report?.state === "parsed" ? report.cases : undefined;
  const allPassed = cases !== undefined && expected.every(key => cases.get(key) === "passed");
  const guard = allPassed ? await guardOf(ctx, set.restore) : undefined;
  return { ending: "graded", report, guard, overwritten: set.overwritten, diff };
}

function parsed(outcome: RoundOutcome): boolean {
  return outcome.kind === "report" && outcome.report.state === "parsed";
}

async function guardOf(ctx: TrialContext, restore: string[]): Promise<"passed" | "failed" | undefined> {
  if (ctx.settings.guardChecks.length === 0) return "passed";
  if (!(await prepareRound(ctx, "round-3", restore))) return undefined;
  return guardChecks(ctx, "round-3");
}

async function gradeRound(ctx: TrialContext, n: 1 | 2, focus: string[], restore: string[]): Promise<RoundOutcome> {
  const dir = `round-${n}` as GraderDir;
  if (!(await prepareRound(ctx, dir, restore))) return { kind: "setup-failed" };
  return focused(ctx, dir, focus, n);
}

async function prepareRound(ctx: ValidateContext, dir: GraderDir, restore: string[]): Promise<boolean> {
  expectZero(await exec(ctx, {
    dir: ".", seconds: PREPARE_SECONDS,
    argv: ["git", "clone", "--quiet", "--template=", "--no-local", "--no-hardlinks", "--no-checkout", "--", "task", dir],
  }));
  expectZero(await exec(ctx, {
    dir, seconds: PREPARE_SECONDS,
    argv: ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "eval-result"],
  }));
  await restoreFromReference(ctx, dir, restore);
  const setup = ctx.settings.setup;
  if (!setup) return true;
  const run = await exec(ctx, { dir, seconds: SETUP_SECONDS, argv: [setup.command, ...setup.args] });
  if (run.failed) fail("grader-failed");
  return !run.timedOut && run.exitCode === 0;
}

async function restoreFromReference(ctx: ValidateContext, dir: GraderDir, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const listed = await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS, keepStdout: true,
    argv: ["git", "ls-tree", "-z", "--name-only", "eval-reference", "--", ...names],
  });
  expectZero(listed);
  if (listed.truncated) fail("grader-failed");
  const present = new Set((listed.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean));
  const inReference = names.filter(name => present.has(name));
  const absent = names.filter(name => !present.has(name));
  if (absent.length > 0) expectZero(await exec(ctx, { dir, seconds: PREPARE_SECONDS, argv: ["rm", "-f", "--", ...absent] }));
  if (inReference.length === 0) return;
  expectZero(await exec(ctx, {
    dir, seconds: PREPARE_SECONDS,
    input: Buffer.from(inReference.map(name => `${name}\0`).join("")),
    argv: ["git", "--literal-pathspecs", "restore", "--source=eval-reference", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
  }));
}

async function diffOf(ctx: ValidateContext): Promise<GradeFacts["diff"]> {
  const result = await numstat(ctx, "eval-result");
  const reference = await numstat(ctx, "eval-reference");
  if (!result || !reference) return null;
  return { added: result.added, removed: result.removed, referenceAdded: reference.added, referenceRemoved: reference.removed };
}

async function numstat(ctx: ValidateContext, to: string): Promise<{ added: number; removed: number } | undefined> {
  const run = await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS, keepStdout: true,
    argv: ["git", "diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "eval-base", to, "--"],
  });
  if (run.failed) fail("grader-failed");
  if (run.truncated) return undefined;
  expectZero(run);
  let added = 0, removed = 0;
  for (const record of (run.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0")) {
    const [plus, minus] = record.split("\t");
    if (plus === undefined || minus === undefined) continue;
    added += Number(plus) || 0;
    removed += Number(minus) || 0;
  }
  return { added, removed };
}
