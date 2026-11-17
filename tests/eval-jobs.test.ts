import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { Config } from "../packages/host/src/types.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import {
  ACTIVE_JOBS_SQL,
  ACTIVE_PROJECT_JOBS_SQL,
  EvalJobs,
  JOBS_SQL,
  JOB_SWEEP_SQL,
  NEXT_TASK_SQL,
  PROJECT_JOBS_SQL,
  type Gates,
  type NextWork,
} from "../packages/host/src/eval-jobs.js";
import type { TaskValidation } from "../packages/host/src/eval-validate.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-16T10:00:00.000Z");
const PROJECT = "project-jobs-1";
const PROJECT_TWO = "project-jobs-2";
const BARE = "project-jobs-bare";
const REQUEST_ONE = "11111111-1111-4111-8111-111111111111";
const REQUEST_TWO = "22222222-2222-4222-8222-222222222222";
const REQUEST_THREE = "33333333-3333-4333-8333-333333333333";
const REQUEST_FOUR = "44444444-4444-4444-8444-444444444444";
const REQUEST_FIVE = "55555555-5555-4555-8555-555555555555";
const FOCUSED = {
  command: "node",
  args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"],
};

type Fixture = {
  store: EvidenceStore;
  jobs: EvalJobs;
  config: Pick<Config, "projects" | "eval">;
  gate: { halted: Set<string>; hostLoad: boolean; grader: { state: string; storage?: boolean } };
  gates: () => Gates;
  setClock: (ms: number) => void;
  clock: () => number;
  cleanup: () => void;
};

function project(id: string, team: Record<string, unknown>) {
  return { id, name: id, path: "/srv/unused", source: { mode: "github" }, team: { eval: team } };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-jobs-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  let clock = START;
  const now = () => new Date(clock).toISOString();
  store.register(evalCorpusModule(store, now));
  const config = {
    projects: [
      project(PROJECT, { mine: true, focusedTest: FOCUSED, reportFormat: "junit" }),
      project(PROJECT_TWO, { mine: true, focusedTest: FOCUSED, reportFormat: "junit" }),
      project(BARE, { mine: true }),
    ],
    eval: { grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" } },
  } as unknown as Pick<Config, "projects" | "eval">;
  const gate = { halted: new Set<string>(), hostLoad: false, grader: { state: "ready", storage: true } as { state: string; storage?: boolean } };
  return {
    store,
    jobs: new EvalJobs({ store, config, now }),
    config,
    gate,
    gates: () => ({
      grader: gate.grader as Gates["grader"],
      hostLoadHeld: gate.hostLoad,
      halted: projectId => gate.halted.has(projectId),
    }),
    setClock: ms => { clock = ms; },
    clock: () => clock,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A candidate, valid, or rejected captured or mined row, written the way the store's own tests write one. */
function addTask(f: Fixture, taskId: string, options: { state?: string; origin?: string; area?: string; validatedAt?: string | null; projectId?: string } = {}): void {
  const at = new Date(START).toISOString();
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
      + "VALUES (?, ?, 'run-1', 'member-1', ?, ?, 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', ?, ?)",
      taskId,
      options.origin ?? "captured",
      tx.index("project", options.projectId ?? PROJECT),
      options.state ?? "candidate",
      at,
      at,
      tx.seal("eval_tasks", taskId, { projectId: options.projectId ?? PROJECT }),
      options.area ?? "host",
      options.validatedAt ?? null,
    );
  });
}

function assertRefusal(result: unknown, status: number, code: string): void {
  assert.ok(result && typeof result === "object" && "code" in result, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal((result as { status: number }).status, status);
  assert.equal((result as { code: string }).code, code);
}

function taskOf(work: NextWork): string {
  if (work.kind !== "task") assert.fail(`expected a task, got ${JSON.stringify(work)}`);
  return work.taskId;
}

const DECIDED_VALID: TaskValidation = { kind: "decided", state: "valid", reason: null };
const UNDECIDED: TaskValidation = { kind: "undecided", cause: "report-missing", attempts: 1 };
const ENVIRONMENT = (cause: "anchor-unknown" | "grader-failed" | "bundle-missing"): TaskValidation => ({ kind: "environment", cause });

test("a request id makes one job", () => {
  const f = fixture();
  try {
    const request = { kind: "validate" as const, limits: { maxWallMinutes: 60 } };
    const first = f.jobs.create(PROJECT, request, REQUEST_ONE);
    assert.ok("job" in first, "the first create makes a job");
    assert.equal(first.created, true);
    assert.deepEqual(
      Object.keys(first.job).sort(),
      ["counts", "createdAt", "expiresAt", "finishedAt", "jobId", "kind", "projectId", "reason", "startedAt", "status", "waiting"],
      "a job view holds only ids, enumerations, counts and times",
    );
    assert.equal(first.job.projectId, PROJECT);
    assert.equal(first.job.status, "scheduled");

    // The default expiry is the clock plus 30 days, so a replay later must still match the body as sent.
    f.setClock(START + 1);
    const moved = f.jobs.create(PROJECT, request, REQUEST_ONE);
    assert.ok("job" in moved, "a replay 1 ms later is not a conflict");
    assert.equal(moved.created, false);
    assert.equal(moved.job.jobId, first.job.jobId);
    f.setClock(START + DAY_MS);
    const laterDay = f.jobs.create(PROJECT, request, REQUEST_ONE);
    assert.ok("job" in laterDay, "a replay a day later is not a conflict");
    assert.equal(laterDay.created, false);
    assert.equal(laterDay.job.jobId, first.job.jobId);
    f.setClock(START);

    const again = f.jobs.create(PROJECT, request, REQUEST_ONE);
    assert.ok("job" in again);
    assert.equal(again.created, false, "the same id and body return the same job");
    assert.equal(again.job.jobId, first.job.jobId);

    assertRefusal(f.jobs.create(PROJECT, { ...request, taskFilter: { maxTasks: 5 } }, REQUEST_ONE), 409, "request-conflict");
    assert.equal(f.jobs.list().length, 1, "still one job");

    assert.ok(!("code" in f.jobs.control(first.job.jobId, "pause")), "pause answers the job, not a refusal");
    assertRefusal(f.jobs.create(PROJECT, request, REQUEST_TWO), 409, "job-active");
    assertRefusal(f.jobs.create(BARE, request, REQUEST_THREE), 409, "eval-config-incomplete");
    assertRefusal(f.jobs.create("no-such-project", request, REQUEST_FOUR), 404, "unknown-project");
  } finally {
    f.cleanup();
  }
});

test("a changed configuration blocks the job", () => {
  const f = fixture();
  try {
    const job = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, REQUEST_ONE);
    assert.ok("job" in job);
    const jobId = job.job.jobId;
    for (const n of [1, 2, 3, 4, 5]) addTask(f, `captured:run-1:t0${n}`);

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01");
    f.jobs.record(jobId, "captured:run-1:t01", DECIDED_VALID);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02");
    f.jobs.record(jobId, "captured:run-1:t02", DECIDED_VALID);

    const eval_ = (f.config.projects[0].team as { eval: { focusedTest: unknown } }).eval;
    eval_.focusedTest = { command: "node", args: ["--test", "{files}", "--test-reporter-destination={report}", "--changed"] };
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "none" }, "a changed focused test returns no task");
    assert.equal(f.jobs.view(jobId)?.status, "blocked");
    assert.equal(f.jobs.view(jobId)?.reason, "configuration-changed");

    assert.ok(!("code" in f.jobs.control(jobId, "resume")), "resume answers the job, not a refusal");
    assert.equal(f.jobs.view(jobId)?.status, "running");
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t03", "resume pins the new digest and the cursor holds");
    f.jobs.record(jobId, "captured:run-1:t03", DECIDED_VALID);

    f.config.eval!.grader!.root = "/var/lib/another-root";
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "none" }, "a changed grader root blocks the job too");
    assert.equal(f.jobs.view(jobId)?.reason, "configuration-changed");
    assert.ok(!("code" in f.jobs.control(jobId, "resume")), "resume answers the job, not a refusal");
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t04");
  } finally {
    f.cleanup();
  }
});

test("the job waits for every gate and says which", () => {
  const f = fixture();
  try {
    const window = { startHourUtc: 9, endHourUtc: 12 };
    const job = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 }, windows: [window] }, REQUEST_ONE);
    assert.ok("job" in job);
    const jobId = job.job.jobId;
    addTask(f, "captured:run-1:t01");
    addTask(f, "captured:run-1:t02");

    f.gate.halted.add(PROJECT);
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId, waiting: "halt" });
    assert.equal(f.jobs.view(jobId)?.waiting, "halt");
    f.gate.halted.delete(PROJECT);

    f.gate.hostLoad = true;
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId, waiting: "host-load" });
    f.gate.hostLoad = false;

    f.gate.grader = { state: "exposed" };
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId, waiting: "grader" });
    assert.equal(f.jobs.view(jobId)?.waiting, "grader");

    f.gate.grader = { state: "ready", storage: false };
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId, waiting: "storage" });

    f.gate.grader = { state: "ready", storage: true };
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01", "every gate open starts the task");
    assert.equal(f.jobs.view(jobId)?.waiting, null, "a task that starts clears the wait");
    f.jobs.record(jobId, "captured:run-1:t01", DECIDED_VALID);

    f.setClock(START + 2 * HOUR_MS);
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId, waiting: "window" }, "12:00 is outside 09 to 12");
    f.setClock(START + HOUR_MS);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02", "one hour back, inside the window, runs the task");
  } finally {
    f.cleanup();
  }
});

test("undecided tasks pause the job, environments count nothing", () => {
  const f = fixture();
  try {
    const job = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    assert.ok("job" in job);
    const jobId = job.job.jobId;
    for (const n of [1, 2, 3, 4]) addTask(f, `captured:run-1:t0${n}`);

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01");
    f.jobs.record(jobId, "captured:run-1:t01", ENVIRONMENT("anchor-unknown"));
    assert.equal(f.jobs.view(jobId)?.waiting, "mirror");
    f.jobs.record(jobId, "captured:run-1:t01", ENVIRONMENT("grader-failed"));
    f.jobs.record(jobId, "captured:run-1:t01", ENVIRONMENT("bundle-missing"));
    assert.deepEqual(f.jobs.view(jobId)?.counts, { visited: 0, valid: 0, rejected: 0, retired: 0, undecided: 0 });
    assert.equal(f.jobs.view(jobId)?.status, "running", "environments never pause the job");
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01", "the cursor did not move, so the task is visited again");

    f.jobs.record(jobId, "captured:run-1:t01", UNDECIDED);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02");
    f.jobs.record(jobId, "captured:run-1:t02", UNDECIDED);
    assert.equal(f.jobs.view(jobId)?.status, "running", "two undecided results do not pause the job");
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t03");
    f.jobs.record(jobId, "captured:run-1:t03", UNDECIDED);

    const stuck = f.jobs.view(jobId);
    assert.equal(stuck?.status, "paused");
    assert.equal(stuck?.reason, "validation-stuck");
    assert.equal(stuck?.counts.undecided, 3);
    assert.equal(stuck?.counts.visited, 3);
  } finally {
    f.cleanup();
  }
});

test("a job ends at its limits", () => {
  const f = fixture();
  try {
    const first = f.jobs.create(PROJECT, { kind: "validate", taskFilter: { maxTasks: 2 }, limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    assert.ok("job" in first);
    for (const n of [1, 2, 3, 4, 5]) addTask(f, `captured:run-1:t0${n}`);

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01");
    f.jobs.record(first.job.jobId, "captured:run-1:t01", DECIDED_VALID);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02");
    f.jobs.record(first.job.jobId, "captured:run-1:t02", DECIDED_VALID);

    assert.deepEqual(f.jobs.next(f.gates()), { kind: "none" }, "the third pass finds the limit");
    assert.equal(f.jobs.view(first.job.jobId)?.status, "completed");
    assert.equal(f.jobs.view(first.job.jobId)?.reason, "limit-reached");

    assertRefusal(
      f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 }, expiresAt: new Date(START + 31 * DAY_MS).toISOString() }, REQUEST_TWO),
      400,
      "invalid-eval-request",
    );
    const second = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 }, expiresAt: new Date(START + HOUR_MS).toISOString() }, REQUEST_THREE);
    assert.ok("job" in second);
    f.setClock(START + 2 * HOUR_MS);
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "none" });
    assert.equal(f.jobs.view(second.job.jobId)?.status, "expired");
    assert.equal(f.jobs.view(second.job.jobId)?.reason, "expired");

    f.setClock(START + 2 * HOUR_MS + 91 * DAY_MS);
    assert.equal(f.jobs.sweep(), 2, "both finished jobs are older than 90 days");
    assert.equal(f.jobs.list().length, 0);
  } finally {
    f.cleanup();
  }
});

test("the hot statements read through an index", () => {
  const f = fixture();
  try {
    const cut = new Date(START - 91 * DAY_MS).toISOString();
    // Each entry names the index the plan must use. JOBS_SQL has no predicate, so SQLite walks eval_jobs_created in
    // order and stops at LIMIT: the plan reads that index with a SCAN, not a SEARCH.
    const cases = [
      { name: "NEXT_TASK_SQL", sql: NEXT_TASK_SQL, params: ["p", "candidate", ""], index: "eval_tasks_next", search: true },
      { name: "ACTIVE_JOBS_SQL", sql: ACTIVE_JOBS_SQL, params: ["scheduled", 20], index: "eval_jobs_status", search: true },
      { name: "ACTIVE_PROJECT_JOBS_SQL", sql: ACTIVE_PROJECT_JOBS_SQL, params: ["p"], index: "eval_jobs_project", search: true },
      { name: "PROJECT_JOBS_SQL", sql: PROJECT_JOBS_SQL, params: ["p", 10], index: "eval_jobs_project", search: true },
      { name: "JOB_SWEEP_SQL", sql: JOB_SWEEP_SQL, params: [cut, cut, 100], index: "eval_jobs_created", search: true },
      { name: "JOBS_SQL", sql: JOBS_SQL, params: [100], index: "eval_jobs_created", search: false },
    ];
    for (const item of cases) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.params))
        .map(row => row.detail);
      const line = details.find(detail => detail.includes(`INDEX ${item.index}`));
      assert.ok(line, `${item.name} plan names ${item.index}: ${details.join(" | ")}`);
      if (item.search) assert.match(line, /^SEARCH /, `${item.name} plan: ${line}`);
      else assert.match(line, /^SCAN /, `${item.name} plan: ${line}`);
    }
  } finally {
    f.cleanup();
  }
});

test("a failed record frees the next job", () => {
  const f = fixture();
  try {
    const a = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    f.setClock(START + 1_000); // A is older than B, so the order does not depend on the random job id
    const b = f.jobs.create(PROJECT_TWO, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_TWO);
    assert.ok("job" in a && "job" in b);
    addTask(f, "captured:run-1:t01");
    addTask(f, "captured:run-1:t02", { projectId: PROJECT_TWO });

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01");
    assert.ok(!("code" in f.jobs.control(a.job.jobId, "pause")), "A leaves the active list, so only B can answer");
    const write = f.store.write.bind(f.store);
    let failNext = true;
    (f.store as unknown as { write: unknown }).write = (fn: never) => {
      if (failNext) {
        failNext = false;
        throw new Error("store failed");
      }
      return write(fn);
    };
    assert.throws(() => f.jobs.record(a.job.jobId, "captured:run-1:t01", DECIDED_VALID), /store failed/);

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02", "job B is not answered another-job after the failed write");
  } finally {
    f.cleanup();
  }
});

test("while one job's task is in flight, the other job waits", () => {
  const f = fixture();
  try {
    const a = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    f.setClock(START + 1_000); // A is older than B, so the order does not depend on the random job id
    const b = f.jobs.create(PROJECT_TWO, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_TWO);
    assert.ok("job" in a && "job" in b);
    addTask(f, "captured:run-1:t01");
    addTask(f, "captured:run-1:t02", { projectId: PROJECT_TWO });

    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01");
    assert.ok(!("code" in f.jobs.control(a.job.jobId, "pause")));
    assert.deepEqual(
      f.jobs.next(f.gates()),
      { kind: "wait", jobId: b.job.jobId, waiting: "another-job" },
      "B waits while A's task is in flight",
    );
    assert.equal(f.jobs.view(b.job.jobId)?.waiting, "another-job");

    f.jobs.record(a.job.jobId, "captured:run-1:t01", DECIDED_VALID);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02", "after A's record, B proceeds");
  } finally {
    f.cleanup();
  }
});

test("a window that crosses midnight is open on both sides of it", () => {
  const f = fixture();
  try {
    const day = Date.parse("2026-11-16T00:00:00.000Z");
    const job = f.jobs.create(
      PROJECT,
      { kind: "validate", limits: { maxWallMinutes: 43_200 }, windows: [{ startHourUtc: 22, endHourUtc: 6 }] },
      REQUEST_ONE,
    );
    assert.ok("job" in job);
    addTask(f, "captured:run-1:t01");
    addTask(f, "captured:run-1:t02");
    addTask(f, "captured:run-1:t03");

    f.setClock(day + 23 * HOUR_MS);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t01", "23:00 is inside 22 to 06");
    f.jobs.record(job.job.jobId, "captured:run-1:t01", DECIDED_VALID);

    f.setClock(day + 29 * HOUR_MS);
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t02", "05:00 the next day is inside 22 to 06");
    f.jobs.record(job.job.jobId, "captured:run-1:t02", DECIDED_VALID);

    f.setClock(day + 36 * HOUR_MS);
    assert.deepEqual(f.jobs.next(f.gates()), { kind: "wait", jobId: job.job.jobId, waiting: "window" }, "12:00 is outside 22 to 06");
  } finally {
    f.cleanup();
  }
});

test("the sweep removes only finished jobs", () => {
  const f = fixture();
  try {
    const done = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    assert.ok("job" in done);
    assert.ok(!("code" in f.jobs.control(done.job.jobId, "cancel")));
    const paused = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_TWO);
    assert.ok("job" in paused);
    assert.ok(!("code" in f.jobs.control(paused.job.jobId, "pause")));

    f.setClock(START + 91 * DAY_MS);
    assert.equal(f.jobs.sweep(), 1, "only the cancelled job is older than the cutoff and finished");
    assert.equal(f.jobs.view(done.job.jobId), undefined);
    assert.equal(f.jobs.view(paused.job.jobId)?.status, "paused", "an old paused job is kept");
  } finally {
    f.cleanup();
  }
});

test("revalidation visits each valid task once", () => {
  const f = fixture();
  try {
    const job = f.jobs.create(
      PROJECT,
      { kind: "validate", taskFilter: { revalidate: true }, limits: { maxWallMinutes: 600 } },
      REQUEST_ONE,
    );
    assert.ok("job" in job);
    const jobId = job.job.jobId;
    // Both are valid and older than REVALIDATE_DAYS, so the revalidation phase reaches them.
    const validatedAt = new Date(START - 40 * DAY_MS).toISOString();
    addTask(f, "captured:run-1:v1", { state: "valid", validatedAt });
    addTask(f, "captured:run-1:v2", { state: "valid", validatedAt });

    const handed: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const work = f.jobs.next(f.gates());
      if (work.kind !== "task") break;
      handed.push(work.taskId);
      f.jobs.record(jobId, work.taskId, UNDECIDED);
    }
    assert.deepEqual(handed, ["captured:run-1:v1", "captured:run-1:v2"], "each valid task is handed out once, in order");
    assert.equal(f.jobs.view(jobId)?.status, "completed", "the job ends after the last valid task");
    assert.equal(f.jobs.view(jobId)?.reason, "done");
  } finally {
    f.cleanup();
  }
});

test("a decided outcome resets the undecided streak", () => {
  const f = fixture();
  try {
    const job = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 600 } }, REQUEST_ONE);
    assert.ok("job" in job);
    const jobId = job.job.jobId;
    for (const n of [1, 2, 3, 4, 5, 6]) addTask(f, `captured:run-1:t0${n}`);

    for (const n of [1, 2]) {
      assert.equal(taskOf(f.jobs.next(f.gates())), `captured:run-1:t0${n}`);
      f.jobs.record(jobId, `captured:run-1:t0${n}`, UNDECIDED);
    }
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t03");
    f.jobs.record(jobId, "captured:run-1:t03", DECIDED_VALID);
    for (const n of [4, 5]) {
      assert.equal(taskOf(f.jobs.next(f.gates())), `captured:run-1:t0${n}`);
      f.jobs.record(jobId, `captured:run-1:t0${n}`, UNDECIDED);
    }
    assert.equal(f.jobs.view(jobId)?.status, "running", "two undecided after a valid do not pause the job");
    assert.equal(taskOf(f.jobs.next(f.gates())), "captured:run-1:t06");
    f.jobs.record(jobId, "captured:run-1:t06", UNDECIDED);
    assert.equal(f.jobs.view(jobId)?.status, "paused");
    assert.equal(f.jobs.view(jobId)?.reason, "validation-stuck");
  } finally {
    f.cleanup();
  }
});
