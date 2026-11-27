import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Transform } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import type { ValidationSettings } from "./eval-config.js";
import { type Grader, type GraderDir, type GraderInput, type GraderRun, stopGrader } from "./eval-grader.js";
import type { MineGit } from "./eval-mine-git.js";
import { COMMIT_ID } from "./outcome-hold.js";
import { parseReport, REPORT_MAX_BYTES } from "./eval-report.js";
import { readEvalTask, readMaterial, rejectTask, retireTask } from "./eval-store.js";
import type { CapturedPayload, EvalReason, EvalState, EvalTaskRow, MinedPayload } from "./eval-types.js";
import { ATTEMPTS_MAX, FOCUSED_SECONDS, focusedArgv, GUARD_SECONDS, nextRound, PREPARE_SECONDS, restoreLists, SETUP_SECONDS, type RoundFacts, type RoundOutcome } from "./eval-validate-rules.js";
import type { RuntimeProcess } from "./team-retirement.js";

export const HALT_POLL_MS = 10_000;
const BUNDLE_MAX_BYTES = 1_073_741_824;
const ROUND_OF = { R1: 1, guards: 2, B1: 3, R2: 4, B2: 5, R3: 6 } as const;
const IDENTITY = ["-c", "user.name=Infinite", "-c", "user.email=agent@example.invalid"];
const PAUSE_CODES: ReadonlySet<string> = new Set(["anchor-unknown", "grader-failed", "grader-processes-alive", "bundle-missing"]);

export type BundleState = {
  spawn: () => ChildProcess; job: string | null; sha256: string | null; restreamedFor: string | null; tooLarge: string | null;
};
export type ValidateContext = {
  jobId: string; projectId: string; settings: ValidationSettings; grader: Grader; graderRoot: string; uid: number;
  mirror: string; mirrorHead: string; git: Pick<MineGit, "isAncestor">; halted: () => boolean;
  inventory?: () => Promise<RuntimeProcess[]>; now: () => string;
  bundle: BundleState;
};
export type TaskValidation =
  | { kind: "decided"; state: "valid" | "rejected" | "retired"; reason: EvalReason | null }
  | { kind: "undecided"; cause: "report-missing" | "report-invalid" | "setup-failed"; attempts: number }
  | { kind: "environment"; cause: "anchor-unknown" | "grader-failed" | "grader-processes-alive" | "halted" | "bundle-missing" | "state-changed" | "storage" };

type ActiveTask = Extract<EvalTaskRow, { state: "candidate" | "valid" }>;
type EnvCause = Extract<TaskValidation, { kind: "environment" }>["cause"];
type Verdict = { kind: "valid"; expected: string[] } | { kind: "reject"; reason: EvalReason } | { kind: "undecided"; cause: "report-missing" | "report-invalid" | "setup-failed" };
type Outcome = { kind: "verdict"; verdict: Verdict } | { kind: "environment"; cause: EnvCause };
type Material = { baseDelta?: Buffer; reference?: Buffer };
type Loaded = { kind: "task"; task: ActiveTask; material: Material } | { kind: "unreadable"; state: EvalState } | { kind: "absent" };
type Step = "R1" | "guards" | "B1" | "R2" | "B2" | "R3";
type Exec = { dir: GraderDir; seconds: number; argv: string[]; input?: Buffer; keepStdout?: boolean };

export class Stop extends Error {
  constructor(readonly outcome: Outcome) {
    super("validation stopped");
  }
}

function fail(cause: EnvCause): never {
  throw new Stop({ kind: "environment", cause });
}
function undecided(cause: "report-missing" | "report-invalid" | "setup-failed"): never {
  throw new Stop({ kind: "verdict", verdict: { kind: "undecided", cause } });
}
function refuse(reason: EvalReason): never {
  throw new Stop({ kind: "verdict", verdict: { kind: "reject", reason } });
}

export async function prepareJob(ctx: ValidateContext, bundle: () => ChildProcess): Promise<"ready" | "too-large" | "failed"> {
  ctx.bundle.job = null;
  ctx.bundle.sha256 = null;
  if (ctx.bundle.tooLarge === ctx.jobId) return "too-large";
  if ((await stopGrader(ctx.grader, ctx.uid, ctx.inventory)) !== "stopped") return "failed";
  if (!(await ctx.grader.remove(ctx.jobId))) return "failed";
  let child: ChildProcess;
  try {
    child = bundle();
  } catch {
    return "failed";
  }
  const exit = exitOf(child);
  const out = child.stdout;
  if (!out) {
    child.kill();
    return "failed";
  }
  child.stderr?.resume();
  const hash = createHash("sha256");
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > BUNDLE_MAX_BYTES) {
        out.destroy();
        child.kill();
      } else {
        hash.update(chunk);
      }
      callback(null, chunk);
    },
  });
  out.pipe(counter);
  const result = await ctx.grader.receive(ctx.jobId, "base.bundle", counter, BUNDLE_MAX_BYTES);
  if (result !== "stored" || total > BUNDLE_MAX_BYTES) {
    out.destroy();
    child.kill();
  }
  const ended = await exit;
  if (total > BUNDLE_MAX_BYTES || result === "too-large") {
    ctx.bundle.tooLarge = ctx.jobId;
    return "too-large";
  }
  if (result !== "stored" || ended.error || ended.code !== 0) return "failed";
  ctx.bundle.job = ctx.jobId;
  ctx.bundle.sha256 = hash.digest("hex");
  return "ready";
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; error: boolean }> {
  return new Promise(resolve => {
    child.once("error", () => resolve({ code: null, error: true }));
    child.once("close", code => resolve({ code, error: false }));
  });
}

export async function validateTask(store: EvidenceStore, taskId: string, ctx: ValidateContext): Promise<TaskValidation> {
  const loaded = loadTask(store, taskId);
  if (loaded.kind === "absent") return { kind: "environment", cause: "state-changed" };
  if (loaded.kind === "unreadable") return decide(store, ctx, taskId, loaded.state, { kind: "reject", reason: "unreadable" });

  let outcome: Outcome;
  try {
    outcome = { kind: "verdict", verdict: await evaluate(loaded.task, loaded.material, ctx) };
  } catch (error) {
    if (!(error instanceof Stop)) {
      await finish(ctx);
      throw error;
    }
    outcome = error.outcome;
  }
  const cleanup = await finish(ctx);
  if (outcome.kind === "environment") return environment(outcome.cause);
  if (cleanup) return environment(cleanup);
  return decide(store, ctx, taskId, loaded.task.state, outcome.verdict);
}

function environment(cause: EnvCause): TaskValidation {
  if (PAUSE_CODES.has(cause)) pause(cause);
  return { kind: "environment", cause };
}

const paused = new Set<string>();
function pause(code: string): void {
  if (paused.has(code)) return;
  paused.add(code);
  console.warn(`Eval validation paused (${code}).`);
}

export function loadTask(store: EvidenceStore, taskId: string): Loaded {
  return store.read((db): Loaded => {
    const head = db.get<{ state: string }>("SELECT state FROM eval_tasks WHERE task_id=?", taskId);
    if (!head || (head.state !== "candidate" && head.state !== "valid")) return { kind: "absent" };
    try {
      const task = readEvalTask(db, taskId);
      if (!task || (task.state !== "candidate" && task.state !== "valid")) return { kind: "absent" };
      return { kind: "task", task, material: task.origin === "captured" ? readMaterial(db, taskId) : {} };
    } catch {
      return { kind: "unreadable", state: head.state as EvalState };
    }
  });
}

async function evaluate(task: ActiveTask, material: Material, ctx: ValidateContext): Promise<Verdict> {
  const ids = task.origin === "mined" ? [task.payload.anchorCommit, task.payload.commit] : [task.payload.anchorCommit];
  if (!ids.every(id => COMMIT_ID.test(id))) return { kind: "reject", reason: "unreadable" };
  for (const id of ids) {
    const answer = await ctx.git.isAncestor(ctx.mirror, id, ctx.mirrorHead);
    if (answer === "no") return { kind: "reject", reason: "anchor-missing" };
    if (answer === "failed") fail("anchor-unknown");
  }

  await ensureBundle(ctx);
  await cloneTask(ctx, ids);
  if (task.origin === "mined") await tagMined(ctx, task.payload.anchorCommit, task.payload.commit);
  else await applyCaptured(ctx, task.payload, material);

  const lists = restoreLists({
    present: await changedNames(ctx),
    hiddenFiles: task.payload.hiddenFiles ?? [],
    files: task.payload.files ?? [],
    gradingPaths: ctx.settings.gradingPaths,
  });
  if ("reject" in lists) return { kind: "reject", reason: lists.reject };
  return rounds(ctx, lists.focus, lists.restore);
}

export async function ensureBundle(ctx: ValidateContext): Promise<void> {
  if (ctx.bundle.job !== ctx.jobId && (await prepareJob(ctx, ctx.bundle.spawn)) !== "ready") fail("bundle-missing");
  if (await bundleMatches(ctx)) return;
  if ((await prepareJob(ctx, ctx.bundle.spawn)) !== "ready") fail("bundle-missing");
  if (!(await bundleMatches(ctx))) fail("bundle-missing");
}

async function bundleMatches(ctx: ValidateContext): Promise<boolean> {
  const digest = await call(ctx, () => ctx.grader.digest(ctx.jobId));
  return digest.state === "read" && ctx.bundle.sha256 !== null && digest.sha256 === ctx.bundle.sha256;
}

export async function cloneTask(ctx: ValidateContext, ids: string[]): Promise<void> {
  const bundlePath = posix.join(ctx.graderRoot, "jobs", ctx.jobId, "in", "base.bundle");
  for (;;) {
    await reset(ctx);
    expectZero(await exec(ctx, { dir: ".", seconds: PREPARE_SECONDS, argv: ["git", "clone", "--quiet", "--template=", "--no-checkout", "--", bundlePath, "task"] }));
    const present = await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "rev-list", "--no-walk", "--quiet", ...ids] });
    if (present.failed) fail("grader-failed");
    if (!present.timedOut && present.exitCode === 0) return;
    if (ctx.bundle.restreamedFor === ctx.jobId) fail("bundle-missing");
    ctx.bundle.restreamedFor = ctx.jobId;
    if ((await prepareJob(ctx, ctx.bundle.spawn)) !== "ready") fail("bundle-missing");
  }
}

export async function tagMined(ctx: ValidateContext, parent: string, commit: string): Promise<void> {
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/tags/eval-base", parent] }));
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/tags/eval-reference", commit] }));
}

export async function applyCaptured(ctx: ValidateContext, payload: CapturedPayload, material: Material): Promise<void> {
  if (payload.baseDelta === "missing" || (payload.baseDelta === "stored" && !material.baseDelta)) refuse("patch-missing");
  if (payload.reference !== "stored" || !material.reference) refuse("patch-missing");
  expectZero(await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS,
    argv: ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", payload.anchorCommit],
  }));
  if (payload.baseDelta === "stored" && material.baseDelta) await applyPatch(ctx, "base-delta.patch", material.baseDelta);
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/tags/eval-base", "HEAD"] }));
  await applyPatch(ctx, "reference.patch", material.reference);
  expectZero(await exec(ctx, { dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "update-ref", "refs/tags/eval-reference", "HEAD"] }));
}

export async function applyPatch(ctx: ValidateContext, name: Exclude<GraderInput, "base.bundle">, bytes: Buffer): Promise<void> {
  const stored = await call(ctx, () => ctx.grader.receive(ctx.jobId, name, bytes, bytes.length));
  if (stored === "too-large") refuse("patch-too-large");
  if (stored !== "stored") fail("grader-failed");
  expectZero(await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS, argv: ["git", "apply", "--index", posix.join(ctx.graderRoot, "jobs", ctx.jobId, "in", name)],
  }));
  expectZero(await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS, argv: ["git", ...IDENTITY, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "eval"],
  }));
}

export async function changedNames(ctx: ValidateContext, from = "eval-base", to = "eval-reference"): Promise<string[]> {
  const run = await exec(ctx, {
    dir: "task", seconds: PREPARE_SECONDS, keepStdout: true,
    argv: ["git", "diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--diff-filter=d", "-z", from, to, "--"],
  });
  if (run.failed) fail("grader-failed");
  if (run.truncated) refuse("reference-too-wide");
  expectZero(run);
  return (run.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(name => name.length > 0);
}

async function rounds(ctx: ValidateContext, focus: string[], restore: string[]): Promise<Verdict> {
  const facts: RoundFacts = {};
  for (;;) {
    const verdict = nextRound(facts);
    if (verdict.kind !== "next") return verdict;
    Object.assign(facts, await runStep(ctx, verdict.step, focus, restore));
  }
}

async function runStep(ctx: ValidateContext, step: Step, focus: string[], restore: string[]): Promise<Partial<RoundFacts>> {
  if (step === "guards" && ctx.settings.guardChecks.length === 0) return { guards: "passed" };
  const n = ROUND_OF[step];
  const dir = `round-${n}` as GraderDir;
  const base = step === "B1" || step === "B2";
  expectZero(await exec(ctx, {
    dir: ".", seconds: PREPARE_SECONDS,
    argv: ["git", "clone", "--quiet", "--template=", "--no-local", "--no-hardlinks", "--no-checkout", "--", "task", dir],
  }));
  expectZero(await exec(ctx, {
    dir, seconds: PREPARE_SECONDS,
    argv: ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", base ? "eval-base" : "eval-reference"],
  }));
  if (base) {
    expectZero(await exec(ctx, {
      dir, seconds: PREPARE_SECONDS, input: Buffer.from(restore.map(name => `${name}\0`).join("")),
      argv: ["git", "--literal-pathspecs", "restore", "--source=eval-reference", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
    }));
  }
  const setup = ctx.settings.setup;
  if (setup) expectZero(await exec(ctx, { dir, seconds: SETUP_SECONDS, argv: [setup.command, ...setup.args] }));

  let partial: Partial<RoundFacts>;
  if (step === "guards") partial = { guards: await guardChecks(ctx, dir) };
  else partial = { [step]: await focused(ctx, dir, focus, n) } as Partial<RoundFacts>;
  await settle(ctx);
  return partial;
}

export async function guardChecks(ctx: ValidateContext, dir: GraderDir): Promise<"passed" | "failed"> {
  for (const check of ctx.settings.guardChecks) {
    const run = await exec(ctx, { dir, seconds: GUARD_SECONDS, argv: [check.command, ...check.args] });
    if (run.failed) fail("grader-failed");
    if (run.timedOut || run.exitCode !== 0) return "failed";
  }
  return "passed";
}

export async function focused(ctx: ValidateContext, dir: GraderDir, focus: string[], n: number): Promise<RoundOutcome> {
  const format = ctx.settings.reportFormat;
  const reportName = `reports/round-${n}.${format === "junit" ? "xml" : "tap"}`;
  const reportPath = posix.join(ctx.graderRoot, "jobs", ctx.jobId, "work", reportName);
  const run = await exec(ctx, {
    dir, seconds: FOCUSED_SECONDS,
    argv: [ctx.settings.focusedTest.command, ...focusedArgv(ctx.settings.focusedTest, focus, reportPath)],
  });
  if (run.failed) fail("grader-failed");
  if (run.timedOut) return { kind: "timeout" };
  const read = await call(ctx, () => ctx.grader.read(ctx.jobId, reportName, REPORT_MAX_BYTES));
  if (read.state === "read") return { kind: "report", report: parseReport(format, read.bytes) };
  if (read.state === "missing") return { kind: "missing" };
  if (read.state === "too-large") return { kind: "report", report: { state: "invalid" } };
  return fail("grader-failed");
}

export async function call<T>(ctx: ValidateContext, start: () => Promise<T>): Promise<T> {
  if (ctx.halted()) throw new Stop({ kind: "environment", cause: "halted" });
  const pending = start();
  let timer: NodeJS.Timeout | undefined;
  const halted = new Promise<"halted">(resolve => {
    timer = setInterval(() => {
      if (ctx.halted()) resolve("halted");
    }, HALT_POLL_MS);
  });
  try {
    const settled = await Promise.race([pending.then(value => ({ value })), halted]);
    if (settled !== "halted") return settled.value;
  } finally {
    clearInterval(timer);
  }
  await stopGrader(ctx.grader, ctx.uid, ctx.inventory);
  await pending;
  throw new Stop({ kind: "environment", cause: "halted" });
}

export function exec(ctx: ValidateContext, options: Exec): Promise<GraderRun> {
  return call(ctx, () => ctx.grader.run(ctx.jobId, options.dir, options.seconds, options.argv, { input: options.input, keepStdout: options.keepStdout }));
}

export function expectZero(run: GraderRun): void {
  if (run.failed) fail("grader-failed");
  if (run.timedOut || run.exitCode !== 0) undecided("setup-failed");
}

export async function finish(ctx: ValidateContext): Promise<EnvCause | undefined> {
  const stopped = await stopGrader(ctx.grader, ctx.uid, ctx.inventory);
  if (stopped === "alive") return "grader-processes-alive";
  if (stopped === "failed") return "grader-failed";
  return (await ctx.grader.clean(ctx.jobId)) ? undefined : "grader-failed";
}

export async function reset(ctx: ValidateContext): Promise<void> {
  const cause = await finish(ctx);
  if (cause) fail(cause);
}

async function settle(ctx: ValidateContext): Promise<void> {
  const stopped = await stopGrader(ctx.grader, ctx.uid, ctx.inventory);
  if (stopped === "alive") fail("grader-processes-alive");
  if (stopped === "failed") fail("grader-failed");
}

function decide(store: EvidenceStore, ctx: ValidateContext, taskId: string, state: EvalState, verdict: Verdict): TaskValidation {
  return store.write((tx: EvidenceTx): TaskValidation => {
    const row = tx.get<{ state: string; attempts: number; payload: string }>(
      "SELECT state, attempts, payload FROM eval_tasks WHERE task_id=?",
      taskId,
    );
    if (row === undefined || row.state !== state) return { kind: "environment", cause: "state-changed" };
    const at = ctx.now();
    if (verdict.kind === "valid") {
      const current = tx.open<CapturedPayload | MinedPayload>("eval_tasks", taskId, row.payload);
      tx.run(
        "UPDATE eval_tasks SET state='valid', reason=NULL, validated_at=?, attempts=0, payload=? WHERE task_id=?",
        at,
        tx.seal("eval_tasks", taskId, { ...current, expectedCases: verdict.expected }),
        taskId,
      );
      return { kind: "decided", state: "valid", reason: null };
    }
    if (verdict.kind === "undecided") {
      const attempts = row.attempts + 1;
      if (attempts < ATTEMPTS_MAX) {
        tx.run("UPDATE eval_tasks SET attempts=? WHERE task_id=?", attempts, taskId);
        return { kind: "undecided", cause: verdict.cause, attempts };
      }
      tx.run("UPDATE eval_tasks SET attempts=? WHERE task_id=?", attempts, taskId);
      return drop(tx, taskId, row.state, "unvalidated", at, ctx.projectId);
    }
    return drop(tx, taskId, row.state, verdict.reason, at, ctx.projectId);
  });
}

function drop(tx: EvidenceTx, taskId: string, state: string, reason: EvalReason, at: string, projectId: string): TaskValidation {
  if (state === "valid") {
    retireTask(tx, taskId, reason, at, projectId);
    return { kind: "decided", state: "retired", reason };
  }
  rejectTask(tx, taskId, reason, at, projectId);
  return { kind: "decided", state: "rejected", reason };
}
