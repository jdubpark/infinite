import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { completeApproval, evalCorpusModule, markApproval, readEvalTask } from "../packages/host/src/eval-store.js";
import { parseReport, type CaseStatus } from "../packages/host/src/eval-report.js";
import { focusedArgv, nextRound, restoreLists, type RoundOutcome, type RoundFacts } from "../packages/host/src/eval-validate-rules.js";
import { HALT_POLL_MS, prepareJob, validateTask, type BundleState, type ValidateContext } from "../packages/host/src/eval-validate.js";
import type { Grader, GraderRun } from "../packages/host/src/eval-grader.js";
import type { ValidationSettings } from "../packages/host/src/eval-config.js";

const NOW = "2026-11-16T10:00:00.000Z";
const PROJECT = "project-validate-1";
const RUN = "run-validate-1";
const JOB = "11111111-2222-4333-8444-555555555555";
const OTHER_JOB = "22222222-3333-4444-8555-666666666666";
const TASK = "captured:run-validate-1:m-1";
const ANCHOR = "a".repeat(40);
const COMMIT = "c".repeat(40);
const HEAD = "e".repeat(40);
const SRC = "src/x.ts";
const TEST = "tests/a.test.js";
const REFERENCE = Buffer.from("reference patch bytes");
const BUNDLE = Buffer.from("bundle bytes");
const SETTINGS: ValidationSettings = {
  focusedTest: { command: "node", args: ["--test", "{files}", "--test-reporter=junit", "--test-reporter-destination={report}"] },
  reportFormat: "junit",
  gradingPaths: [],
  guardChecks: [],
};
const CAPTURED_PAYLOAD = {
  projectId: PROJECT, anchorCommit: ANCHOR, memberBaseCommit: ANCHOR, commit: COMMIT, integratedHead: HEAD,
  files: [SRC, TEST], hiddenFiles: [TEST], baseDelta: "none", reference: "stored",
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const parsed = (cases: Record<string, CaseStatus>): RoundOutcome => ({
  kind: "report",
  report: { state: "parsed", cases: new Map(Object.entries(cases)) },
});
const junit = (cases: Record<string, "passed" | "failed">): Buffer => Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="suite">${Object.entries(cases)
    .map(([name, status]) => `<testcase name="${name}" classname="cls">${status === "failed" ? '<failure message="x"/>' : ""}</testcase>`)
    .join("")}</testsuite></testsuites>`,
);
/** The stored key of the case named `name` in the suite that `junit` writes. */
const keyOf = (name: string): string => [...parseReport("junit", junit({ [name]: "passed" })).cases.keys()][0];

// Pure rules.

test("every round decides as the plan says", () => {
  const passBoth = parsed({ a: "passed", b: "passed" });
  const failBoth = parsed({ a: "failed", b: "failed" });
  const next = (facts: RoundFacts) => nextRound(facts);

  assert.deepEqual(next({}), { kind: "next", step: "R1" });
  assert.deepEqual(next({ R1: parsed({ a: "failed", b: "failed" }) }), { kind: "reject", reason: "not-fail-to-pass" });
  assert.deepEqual(next({ R1: passBoth, guards: "failed" }), { kind: "reject", reason: "guard-failed" });
  assert.deepEqual(next({ R1: passBoth, guards: "passed", B1: passBoth }), { kind: "reject", reason: "not-fail-to-pass" });
  assert.deepEqual(next({ R1: passBoth, guards: "passed", B1: failBoth, R2: parsed({ a: "passed" }) }), { kind: "reject", reason: "flaky" });
  assert.deepEqual(
    next({ R1: passBoth, guards: "passed", B1: parsed({ a: "passed", b: "failed" }), R2: passBoth, B2: parsed({ a: "failed", b: "passed" }) }),
    { kind: "reject", reason: "flaky" },
  );
  assert.deepEqual(
    next({ R1: passBoth, guards: "passed", B1: failBoth, R2: passBoth, B2: failBoth, R3: passBoth }),
    { kind: "valid", expected: ["a", "b"] },
  );
  assert.deepEqual(
    next({ R1: passBoth, guards: "passed", B1: failBoth, R2: passBoth, B2: failBoth, R3: parsed({ a: "passed" }) }),
    { kind: "reject", reason: "flaky" },
  );

  const complete: RoundFacts = { R1: passBoth, guards: "passed", B1: failBoth, R2: passBoth, B2: failBoth };
  for (const round of ["R1", "B1", "R2", "B2", "R3"] as const) {
    assert.deepEqual(next({ ...complete, [round]: { kind: "timeout" } }), { kind: "reject", reason: "too-slow" }, `${round} timeout`);
  }
  for (const round of ["R1", "B1", "R2", "B2", "R3"] as const) {
    assert.deepEqual(next({ ...complete, [round]: { kind: "missing" } }), { kind: "undecided", cause: "report-missing" }, `${round} missing`);
    assert.deepEqual(next({ ...complete, [round]: { kind: "setup-failed" } }), { kind: "undecided", cause: "setup-failed" }, `${round} setup`);
    assert.deepEqual(
      next({ ...complete, [round]: { kind: "report", report: { state: "invalid" } } }),
      { kind: "undecided", cause: "report-invalid" },
      `${round} invalid`,
    );
  }
  const wide = new Map(Array.from({ length: 5_001 }, (_, i) => [`k${i}`, "passed" as const]));
  assert.deepEqual(next({ R1: { kind: "report", report: { state: "parsed", cases: wide } } }), { kind: "reject", reason: "reference-too-wide" });
});

test("the argv cannot carry an option", () => {
  const command = { command: "node", args: ["--test", "{files}", "--out={report}"] };
  const report = "/R/jobs/J/work/reports/round-1.xml";
  assert.deepEqual(focusedArgv(command, ["-x.test.js", "tests/a.test.js"], report), ["--test", "./-x.test.js", "./tests/a.test.js", `--out=${report}`]);

  const kept = restoreLists({
    present: ["tests/a.test.js", "src/x.ts", "tests/extra.test.js", "src/a.ts", "src2/a.ts"],
    hiddenFiles: ["tests/a.test.js", "tests/missing.test.js"],
    files: ["tests/a.test.js", "src/x.ts", "src/a.ts", "src2/a.ts"],
    gradingPaths: ["src"],
  });
  assert.deepEqual(kept, { focus: ["tests/a.test.js"], restore: ["tests/a.test.js", "src/x.ts", "src/a.ts"] });
  assert.deepEqual(
    restoreLists({ present: ["tests/a.test.js"], hiddenFiles: ["tests/none.test.js"], files: [], gradingPaths: [] }),
    { reject: "no-hidden-tests" },
  );
  const many = Array.from({ length: 101 }, (_, i) => `tests/t${i}.test.js`);
  assert.deepEqual(restoreLists({ present: many, hiddenFiles: many, files: [], gradingPaths: [] }), { reject: "reference-too-wide" });
});

// Integration: a real store, and a scripted grader that records every operation.

type Fixture = { store: EvidenceStore; root: string; close: () => void };
function open(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-validate-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  return { store, root, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function insertTask(store: EvidenceStore, taskId: string, state: "candidate" | "valid", payload: object = CAPTURED_PAYLOAD, attempts = 0): void {
  store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, attempts) VALUES (?, 'captured', ?, 'm-1', ?, ?, NULL, 'stored', 'proven', ?, ?, ?, ?, ?, ?)",
      taskId, RUN, tx.index("project", PROJECT), state, REFERENCE.length, NOW, NOW, tx.seal("eval_tasks", taskId, payload), `run:${RUN}`, attempts,
    );
    tx.run(
      "INSERT INTO eval_material (task_id, part, bytes, payload) VALUES (?, 'reference', ?, ?)",
      taskId, REFERENCE.length, tx.seal("eval_material", `${taskId}/reference`, { patch: REFERENCE.toString("base64") }),
    );
  });
}

/** A plain copy of the row: the store's rows have no prototype, which `deepStrictEqual` would compare. */
function rowOf(store: EvidenceStore, taskId: string) {
  const row = store.read(db => db.get<{ state: string; reason: string | null; attempts: number }>(
    "SELECT state, reason, attempts FROM eval_tasks WHERE task_id=?", taskId));
  return row === undefined ? undefined : { ...row };
}

function partCount(store: EvidenceStore, taskId: string): number {
  return store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_material WHERE task_id=?", taskId)?.n ?? 0);
}

const bundleSpawn = (): ChildProcess => spawn(process.execPath, ["-e", "process.stdout.write('bundle bytes')"], { stdio: ["ignore", "pipe", "ignore"] });

function freshBundle(): BundleState {
  return { spawn: bundleSpawn, job: null, sha256: null, restreamedFor: null, tooLarge: null };
}

function context(fx: Fixture, grader: Grader, over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    jobId: JOB, projectId: PROJECT, settings: SETTINGS, grader, graderRoot: join(fx.root, "grader"), uid: 4242,
    mirror: "/mirror", mirrorHead: HEAD, git: { isAncestor: async () => "yes" }, halted: () => false,
    inventory: async () => [], now: () => NOW, bundle: freshBundle(), ...over,
  };
}

type Call = { op: string; dir?: string; argv?: readonly string[]; name?: string; report?: string; stdin?: string; at: number };
type Script = {
  /** Overrides the fields of a run's result, by its argv. */
  result?: (argv: readonly string[]) => Partial<GraderRun> | undefined;
  reports?: (report: string) => Buffer | undefined;
  digest?: () => { state: "read"; sha256: string } | { state: "missing" | "failed" };
  diff?: string;
  /** The focused command never exits until `stop`. */
  hang?: boolean;
  onFocused?: () => void;
};

async function collect(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function scripted(script: Script = {}): { grader: Grader; calls: Call[] } {
  const calls: Call[] = [];
  const hung: Array<() => void> = [];
  let streamed: Buffer = Buffer.alloc(0);
  const grader: Grader = {
    async probe() {
      return { state: "ready" };
    },
    async receive(_job, name, input) {
      const bytes = Buffer.isBuffer(input) ? input : await collect(input);
      calls.push({ op: "receive", name, at: Date.now() });
      if (name === "base.bundle") streamed = bytes;
      return "stored";
    },
    async run(_job, dir, _seconds, argv, options): Promise<GraderRun> {
      calls.push({ op: "run", dir, argv, stdin: options?.input?.toString("utf8"), at: Date.now() });
      if (argv[0] === "node") script.onFocused?.();
      if (argv[0] === "node" && script.hang) {
        return new Promise(resolve => hung.push(() => resolve({ exitCode: null, timedOut: false, truncated: false, failed: true })));
      }
      const stdout = argv.includes("diff") ? Buffer.from(script.diff ?? `${TEST}\0${SRC}\0`) : undefined;
      return { exitCode: 0, timedOut: false, truncated: false, failed: false, stdout, ...script.result?.(argv) };
    },
    async read(_job, report) {
      calls.push({ op: "read", report, at: Date.now() });
      const bytes = script.reports?.(report);
      return bytes ? { state: "read", bytes } : { state: "missing" };
    },
    async digest() {
      calls.push({ op: "digest", at: Date.now() });
      return script.digest ? script.digest() : { state: "read", sha256: sha256(streamed) };
    },
    async stop() {
      calls.push({ op: "stop", at: Date.now() });
      hung.splice(0).forEach(resolve => resolve());
      return true;
    },
    async clean() {
      calls.push({ op: "clean", at: Date.now() });
      return true;
    },
    async remove() {
      calls.push({ op: "remove", at: Date.now() });
      return true;
    },
  };
  return { grader, calls };
}

test("an exit code never validates", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    const { grader, calls } = scripted();
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "undecided", cause: "report-missing", attempts: 1 });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "undecided", cause: "report-missing", attempts: 2 });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "decided", state: "rejected", reason: "unvalidated" });
    assert.deepEqual(rowOf(fx.store, TASK), { state: "rejected", reason: "unvalidated", attempts: 3 });
    assert.equal(partCount(fx.store, TASK), 0);
    assert.equal(calls.filter(call => call.op === "run" && call.argv?.[0] === "node").length, 3, "one focused run per attempt");
  } finally {
    fx.close();
  }
});

test("a missing anchor retires a valid task", async () => {
  const fx = open();
  try {
    insertTask(fx.store, "captured:gone", "valid");
    const gone = scripted();
    const no = context(fx, gone.grader, { git: { isAncestor: async () => "no" } });
    assert.deepEqual(await validateTask(fx.store, "captured:gone", no), { kind: "decided", state: "retired", reason: "anchor-missing" });
    assert.deepEqual(rowOf(fx.store, "captured:gone"), { state: "retired", reason: "anchor-missing", attempts: 0 });
    assert.equal(gone.calls.filter(call => call.op === "run").length, 0, "no focused or git run after an answer of no");

    insertTask(fx.store, "captured:unknown", "valid");
    const unknown = context(fx, scripted().grader, { git: { isAncestor: async () => "failed" } });
    assert.deepEqual(await validateTask(fx.store, "captured:unknown", unknown), { kind: "environment", cause: "anchor-unknown" });
    assert.deepEqual(rowOf(fx.store, "captured:unknown"), { state: "valid", reason: null, attempts: 0 });
  } finally {
    fx.close();
  }
});

test("a halt stops the round within ten seconds", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    let halted = false;
    let flippedAt = 0;
    const { grader, calls } = scripted({
      hang: true,
      onFocused: () => {
        setTimeout(() => {
          halted = true;
          flippedAt = Date.now();
        }, 500);
      },
    });
    const result = await validateTask(fx.store, TASK, context(fx, grader, { halted: () => halted }));
    assert.deepEqual(result, { kind: "environment", cause: "halted" });
    assert.deepEqual(rowOf(fx.store, TASK), { state: "candidate", reason: null, attempts: 0 });
    const stop = calls.find(call => call.op === "stop" && call.at >= flippedAt);
    assert.ok(stop, "the host runs stop after the halt");
    assert.ok(stop.at - flippedAt <= 11_000, `stop came ${stop.at - flippedAt} ms after the halt`);
    assert.equal(HALT_POLL_MS, 10_000);
  } finally {
    fx.close();
  }
});

test("unreadable records are never validated", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    fx.store.write(tx => tx.run("UPDATE eval_tasks SET payload = ? WHERE task_id = ?", "not-a-sealed-payload", TASK));
    const { grader, calls } = scripted();
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "decided", state: "rejected", reason: "unreadable" });
    assert.equal(calls.length, 0, "no grader command before the rejection");
    assert.equal(rowOf(fx.store, TASK)?.state, "rejected");

    const option = "captured:option-anchor";
    insertTask(fx.store, option, "candidate", { ...CAPTURED_PAYLOAD, anchorCommit: "--upload-pack=x" });
    const optionScript = scripted();
    assert.deepEqual(await validateTask(fx.store, option, context(fx, optionScript.grader)), { kind: "decided", state: "rejected", reason: "unreadable" });
    const acting = optionScript.calls.filter(call => ["run", "receive", "digest", "read"].includes(call.op));
    assert.equal(acting.length, 0, "an anchor that is an option never reaches a grader command that acts on the task");
  } finally {
    fx.close();
  }
});

test("the host reads only reports, and only as the grader", async () => {
  const fx = open();
  const graderRoot = join(fx.root, "grader");
  mkdirSync(graderRoot);
  chmodSync(graderRoot, 0o000);
  try {
    insertTask(fx.store, TASK, "candidate", CAPTURED_PAYLOAD, 2);
    const reports: Record<string, Buffer> = {
      "reports/round-1.xml": junit({ a: "passed" }),
      "reports/round-3.xml": junit({ a: "failed" }),
      "reports/round-4.xml": junit({ a: "passed" }),
      "reports/round-5.xml": junit({ a: "failed" }),
      "reports/round-6.xml": junit({ a: "passed" }),
    };
    const { grader, calls } = scripted({ reports: name => reports[name] });
    const result = await validateTask(fx.store, TASK, context(fx, grader, { graderRoot }));
    assert.deepEqual(result, { kind: "decided", state: "valid", reason: null });
    assert.equal(rowOf(fx.store, TASK)?.attempts, 0, "a validated task ends with no attempts");
    const payload = fx.store.read(db => readEvalTask(db, TASK))?.payload as { expectedCases?: string[] };
    assert.deepEqual(payload.expectedCases, [keyOf("a")]);

    const reads = calls.filter(call => call.op === "read").map(call => call.report);
    assert.deepEqual(reads, ["reports/round-1.xml", "reports/round-3.xml", "reports/round-4.xml", "reports/round-5.xml", "reports/round-6.xml"]);
    for (const call of calls) {
      assert.ok(["receive", "run", "read", "digest", "stop", "clean", "remove"].includes(call.op), `operation ${call.op}`);
    }
  } finally {
    chmodSync(graderRoot, 0o700);
    fx.close();
  }
});

test("a changed bundle is streamed again", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");

    // The digest differs once: the bundle is streamed a second time, then the digest matches and the clone runs.
    let digests = 0;
    const once = scripted({ digest: () => (digests++ === 0 ? { state: "read", sha256: "0".repeat(64) } : { state: "read", sha256: sha256(BUNDLE) }) });
    await validateTask(fx.store, TASK, context(fx, once.grader));
    const receives = once.calls.flatMap((call, index) => (call.op === "receive" && call.name === "base.bundle" ? [index] : []));
    const clone = once.calls.findIndex(call => call.op === "run" && call.argv?.[0] === "git" && call.argv[1] === "clone");
    assert.equal(receives.length, 2, "a second receive");
    assert.ok(clone > receives[1], "the clone follows the second receive");

    // The digest differs twice: bundle-missing, and no clone.
    const attemptsBefore = rowOf(fx.store, TASK)?.attempts;
    const twice = scripted({ digest: () => ({ state: "read", sha256: "0".repeat(64) }) });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, twice.grader)), { kind: "environment", cause: "bundle-missing" });
    assert.equal(twice.calls.filter(call => call.op === "receive" && call.name === "base.bundle").length, 2);
    assert.equal(twice.calls.filter(call => call.op === "run").length, 0, "no clone after a second mismatch");
    assert.equal(rowOf(fx.store, TASK)?.attempts, attemptsBefore, "a bundle failure counts no attempt");
  } finally {
    fx.close();
  }
});

test("prepareJob streams the bundle and records its digest", async () => {
  const fx = open();
  try {
    const { grader, calls } = scripted();
    const ctx = context(fx, grader);
    assert.equal(await prepareJob(ctx, bundleSpawn), "ready");
    assert.equal(ctx.bundle.job, JOB);
    assert.equal(ctx.bundle.sha256, sha256(BUNDLE));
    assert.deepEqual(calls.map(call => call.op), ["stop", "remove", "receive"]);
  } finally {
    fx.close();
  }
});

test("a bundle that exits non-zero is never ready", async () => {
  const fx = open();
  try {
    const ctx = context(fx, scripted().grader);
    const exits = (): ChildProcess => spawn("/bin/sh", ["-c", "printf PARTIAL; exit 128"], { stdio: ["ignore", "pipe", "ignore"] });
    assert.equal(await prepareJob(ctx, exits), "failed");
    assert.equal(ctx.bundle.job, null);
    assert.equal(ctx.bundle.sha256, null);
  } finally {
    fx.close();
  }
});

test("a bundle that cannot start is never ready", async () => {
  const fx = open();
  try {
    const ctx = context(fx, scripted().grader);
    const missing = (): ChildProcess => spawn(join(fx.root, "no-such-bundle"), [], { stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(await prepareJob(ctx, missing), "failed");
    assert.equal(ctx.bundle.job, null);
    assert.equal(ctx.bundle.sha256, null);
  } finally {
    fx.close();
  }
});

test("a bundle over the limit is not streamed again for its job", async () => {
  const fx = open();
  try {
    const grader: Grader = { ...scripted().grader, receive: async () => "too-large" };
    const children: ChildProcess[] = [];
    // A bundle the grader stopped reading would block on its full pipe, so the host must stop it. This one would
    // end by itself after 3 seconds; a clean exit means the host waited instead of stopping it.
    const counted = (): ChildProcess => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3_000)"], { stdio: ["ignore", "pipe", "ignore"] });
      children.push(child);
      return child;
    };
    const ctx = context(fx, grader);
    assert.equal(await prepareJob(ctx, counted), "too-large");
    assert.equal(children[0]?.signalCode, "SIGTERM", "the host stops a bundle the grader refused");
    assert.equal(await prepareJob(ctx, counted), "too-large");
    assert.equal(children.length, 1, "the bundle is streamed once for the job");

    const other = context(fx, grader, { jobId: OTHER_JOB, bundle: ctx.bundle });
    assert.equal(await prepareJob(other, counted), "too-large");
    assert.equal(children.length, 2, "another job streams its own bundle");
  } finally {
    fx.close();
  }
});

test("a decision keeps what an approval wrote during the task", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    const reports: Record<string, Buffer> = {
      "reports/round-1.xml": junit({ a: "passed" }),
      "reports/round-3.xml": junit({ a: "failed" }),
      "reports/round-4.xml": junit({ a: "passed" }),
      "reports/round-5.xml": junit({ a: "failed" }),
      "reports/round-6.xml": junit({ a: "passed" }),
    };
    const at = "2026-11-16T10:30:00.000Z";
    let approved = false;
    // An approval lands while the first focused test runs, then the rounds carry on as in a valid run.
    const { grader } = scripted({
      reports: name => reports[name],
      onFocused: () => {
        if (approved) return;
        approved = true;
        fx.store.write(tx => {
          markApproval(tx, { runId: RUN, workspace: "/workspace", anchorCommit: ANCHOR, reviewedHead: HEAD, at });
          completeApproval(tx, TASK, at, ["later/extra.ts"]);
        });
      },
    });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "decided", state: "valid", reason: null });
    const payload = fx.store.read(db => readEvalTask(db, TASK))?.payload as { laterFiles?: string[]; expectedCases?: string[] };
    assert.deepEqual(payload.laterFiles, ["later/extra.ts"], "the approval's files survive the decision");
    assert.deepEqual(payload.expectedCases, [keyOf("a")]);
  } finally {
    fx.close();
  }
});

test("a full validation runs the planned commands in each round", async () => {
  const fx = open();
  const graderRoot = join(fx.root, "grader");
  try {
    insertTask(fx.store, TASK, "candidate");
    const reports: Record<string, Buffer> = {
      "reports/round-1.xml": junit({ a: "passed" }),
      "reports/round-3.xml": junit({ a: "failed" }),
      "reports/round-4.xml": junit({ a: "passed" }),
      "reports/round-5.xml": junit({ a: "failed" }),
      "reports/round-6.xml": junit({ a: "passed" }),
    };
    const { grader, calls } = scripted({ reports: name => reports[name] });
    const settings: ValidationSettings = { ...SETTINGS, setup: { command: "setup-tool", args: ["--ci"] }, guardChecks: [{ command: "guard-tool", args: ["lint"] }] };
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader, { graderRoot, settings })), { kind: "decided", state: "valid", reason: null });

    const runs = calls.filter(call => call.op === "run");
    const inDir = (dir: string) => runs.filter(call => call.dir === dir).map(call => call.argv ?? []);
    const report = (n: number) => join(graderRoot, "jobs", JOB, "work", "reports", `round-${n}.xml`);
    const focused = (n: number) => ["node", "--test", "./tests/a.test.js", "--test-reporter=junit", `--test-reporter-destination=${report(n)}`];
    const checkout = (ref: string) => ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", ref];
    const restore = ["git", "--literal-pathspecs", "restore", "--source=eval-reference", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"];
    const setup = ["setup-tool", "--ci"];

    assert.deepEqual(
      runs.filter(call => call.dir === "." && call.argv?.[1] === "clone").map(call => call.argv?.at(-1)),
      ["task", "round-1", "round-2", "round-3", "round-4", "round-5", "round-6"],
      "one clone per round, after the task clone",
    );
    assert.deepEqual(inDir("round-1"), [checkout("eval-reference"), setup, focused(1)]);
    assert.deepEqual(inDir("round-2"), [checkout("eval-reference"), setup, ["guard-tool", "lint"]]);
    assert.deepEqual(inDir("round-3"), [checkout("eval-base"), restore, setup, focused(3)]);
    assert.deepEqual(inDir("round-4"), [checkout("eval-reference"), setup, focused(4)]);
    assert.deepEqual(inDir("round-5"), [checkout("eval-base"), restore, setup, focused(5)]);
    assert.deepEqual(inDir("round-6"), [checkout("eval-reference"), setup, focused(6)]);
    assert.equal(runs.find(call => call.dir === "round-3" && call.argv?.includes("restore"))?.stdin, `${TEST}\0`, "the restore list on stdin");
    assert.deepEqual(runs.filter(call => call.argv?.[0] === "guard-tool").map(call => call.dir), ["round-2"], "the guard check runs in round-2 only");

    for (const n of [1, 3, 4, 5, 6]) {
      const ran = calls.findIndex(call => call.op === "run" && call.dir === `round-${n}` && call.argv?.[0] === "node");
      const read = calls.findIndex(call => call.op === "read" && call.report === `reports/round-${n}.xml`);
      assert.ok(read > ran, `round ${n} reads its report after the focused test`);
    }
  } finally {
    fx.close();
  }
});

test("a failed preparation is undecided", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    const { grader } = scripted({ result: argv => (argv[1] === "apply" ? { exitCode: 1 } : undefined) });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "undecided", cause: "setup-failed", attempts: 1 });
    assert.equal(rowOf(fx.store, TASK)?.attempts, 1);
  } finally {
    fx.close();
  }
});

test("a focused test at its limit is too slow", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    const { grader } = scripted({ result: argv => (argv[0] === "node" ? { exitCode: 124, timedOut: true } : undefined) });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "decided", state: "rejected", reason: "too-slow" });
    assert.equal(rowOf(fx.store, TASK)?.state, "rejected");
  } finally {
    fx.close();
  }
});

test("a row that changed meanwhile is not written", async () => {
  const fx = open();
  try {
    insertTask(fx.store, TASK, "candidate");
    // The owner retires the task while the focused test runs. The round is then undecided, so the decision must not write.
    const { grader } = scripted({
      onFocused: () => fx.store.write(tx => tx.run("UPDATE eval_tasks SET state='retired', reason='owner-retired' WHERE task_id=?", TASK)),
    });
    assert.deepEqual(await validateTask(fx.store, TASK, context(fx, grader)), { kind: "environment", cause: "state-changed" });
    assert.deepEqual(rowOf(fx.store, TASK), { state: "retired", reason: "owner-retired", attempts: 0 });
  } finally {
    fx.close();
  }
});

