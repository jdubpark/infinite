import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskCapture, type TaskCaptureOptions } from "../packages/host/src/eval-capture.js";
import { captureGit } from "../packages/host/src/eval-git.js";
import type { CaptureGit, ApprovalStart, BaseRead, CaptureStart, NameRead, PatchRead, TreeCompare } from "../packages/host/src/eval-types.js";
import { type Promoted, capturedTaskId, readEvalTask, readMaterial, runEvalTasks } from "../packages/host/src/eval-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeId } from "../packages/host/src/outcome-projector.js";
import { outcomeModule, writeOutcome, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import type { ProjectSourceService } from "../packages/host/src/project-source.js";
import { commandScope } from "../packages/host/src/team-workspace.js";

const PROJECT = "project-a";
const RUN = "run-1";
const MEMBER = "member-a";
const OTHER_MEMBER = "member-b";
const WORKSPACE = "/unused/workspace";
const ANCHOR = "a".repeat(40);
const MEMBER_BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "9".repeat(40);
const HEAD = "d".repeat(40);
const REVIEWED = "e".repeat(40);
const REVIEWED_2 = "f".repeat(40);
const MIRROR_HEAD = "8".repeat(40);
const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T10:05:00.000Z";
const TASK = capturedTaskId(RUN, MEMBER);
const LEDGER_TASK_ID = "a";
const SETTLE = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeGit implements CaptureGit {
  readonly calls: string[] = [];
  readonly scopes: unknown[] = [];
  readonly answers = new Map<string, unknown>();
  private readonly gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  silent = false;
  closes = 0;

  close(): void {
    this.closes += 1;
  }

  hold(id: string): void {
    if (this.gates.has(id)) return;
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    this.gates.set(id, { promise, open });
  }

  release(id: string): void {
    const gate = this.gates.get(id);
    this.gates.delete(id);
    gate?.open();
  }

  releaseAll(): void {
    for (const id of [...this.gates.keys()]) this.release(id);
  }

  answer(method: string, id: string, value: unknown): void {
    this.answers.set(`${method}:${id}`, value);
  }

  private async call<T>(method: string, id: string, fallback: T): Promise<T> {
    this.calls.push(`${method}:${id}`);
    if (this.silent) return new Promise<T>(() => undefined);
    await this.gates.get(id)?.promise;
    const key = `${method}:${id}`;
    return (this.answers.has(key) ? this.answers.get(key) : fallback) as T;
  }

  patch(_cwd: string, _from: string, to: string): Promise<PatchRead> {
    return this.call<PatchRead>("patch", to, { state: "read", bytes: Buffer.from(`patch ${to}`) });
  }

  sameTree(_cwd: string, _from: string, to: string): Promise<TreeCompare> {
    return this.call<TreeCompare>("sameTree", to, "different");
  }

  names(_cwd: string, _from: string, to: string): Promise<NameRead> {
    this.scopes.push(commandScope.getStore());
    return this.call<NameRead>("names", to, { state: "read", names: [] });
  }

  onBaseBranch(_mirror: string, _anchor: string, head: string): Promise<BaseRead> {
    return this.call<BaseRead>("base", head, "proven");
  }
}

type World = {
  root: string;
  path: string;
  key: Buffer;
  store: EvidenceStore;
  git: FakeGit;
  capture: TaskCapture;
  close(): void;
};

type Setup = { capture?: boolean; source?: "github" | "laptop"; deadlineMs?: number; onPromoted?: Promoted };

function openStore(root: string, key: Buffer): EvidenceStore {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: key });
  store.register(outcomeModule({ now: () => T0 }));
  return store;
}

function captureOptions(root: string, store: EvidenceStore, git: FakeGit, setup: Setup): TaskCaptureOptions {
  const mode = setup.source ?? "github";
  const projects = [{
    id: PROJECT,
    name: "Project",
    path: join(root, "project"),
    source: { mode },
    ...(setup.capture === undefined ? {} : { team: { eval: { capture: setup.capture } } }),
  }];
  const source = {
    mirrorPath: () => join(root, "mirror.git"),
    status: () => ({ mode, mirrorHead: MIRROR_HEAD }),
  } as unknown as Pick<ProjectSourceService, "mirrorPath" | "status">;
  return {
    config: { projects } as unknown as TaskCaptureOptions["config"],
    store,
    source,
    git,
    now: () => T0,
    deadlineMs: setup.deadlineMs ?? 10_000,
    ...(setup.onPromoted === undefined ? {} : { onPromoted: setup.onPromoted }),
  };
}

function world(setup: Setup = { capture: true }): World {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-capture-"));
  const key = randomBytes(32);
  const store = openStore(root, key);
  const git = new FakeGit();
  git.answer("names", COMMIT, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
  const capture = new TaskCapture(captureOptions(root, store, git, setup));
  const hold = setInterval(() => undefined, 1_000);
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key,
    store,
    git,
    capture,
    close() {
      clearInterval(hold);
      git.releaseAll();
      capture.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function finish(w: World): Promise<void> {
  w.git.releaseAll();
  w.capture.close();
  await w.capture.idle();
  w.close();
}

function start(overrides: Partial<CaptureStart> = {}): CaptureStart {
  return {
    runId: RUN,
    memberId: MEMBER,
    projectId: PROJECT,
    workspace: WORKSPACE,
    anchorCommit: ANCHOR,
    memberBaseCommit: MEMBER_BASE,
    commit: COMMIT,
    integratedHead: HEAD,
    at: T0,
    uiChanges: false,
    capsule: {
      objective: "Ship the scheduler",
      steering: [],
      ownerAnswers: [],
      task: { id: LEDGER_TASK_ID, title: "Task a", instructions: "Do a", paths: ["a.txt"] },
    },
    ...overrides,
  };
}

function approval(reviewedHead = REVIEWED, at = T0): ApprovalStart {
  return { runId: RUN, workspace: WORKSPACE, anchorCommit: ANCHOR, reviewedHead, at };
}

function ledger(overrides: Partial<OutcomeRow> & { memberId?: string } = {}): OutcomeRow {
  const memberId = overrides.memberId ?? MEMBER;
  return {
    outcomeId: outcomeId(RUN, memberId),
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: RUN,
    revision: 1,
    memberId,
    sessionId: "session-1",
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: "profile-a",
    provider: "opencode",
    model: "model-one",
    effort: "high",
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: "feature",
    risk: "normal",
    featureVersion: 1,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    acceptance: 1,
    firstPass: 1,
    held: null,
    startedAt: T0,
    endedAt: T0,
    frozenAt: T0,
    holdUntil: null,
    runDeletedAt: null,
    payload: {
      projectId: PROJECT,
      taskId: LEDGER_TASK_ID,
      area: "host",
      featureMap: "map-1",
      rounds: { run: 0, attributed: 0, unknown: 0 },
    },
    ...overrides,
  };
}

function writeLedger(store: EvidenceStore, row: OutcomeRow): void {
  store.write(tx => writeOutcome(tx, row));
}

function taskRow(store: EvidenceStore, memberId = MEMBER) {
  return store.read(db => readEvalTask(db, capturedTaskId(RUN, memberId)));
}

function partsOf(store: EvidenceStore, memberId = MEMBER) {
  return store.read(db => readMaterial(db, capturedTaskId(RUN, memberId)));
}

function snapshot(store: EvidenceStore) {
  return store.read(db => {
    const row = readEvalTask(db, TASK);
    if (row === undefined) return { row: undefined, parts: readMaterial(db, TASK) };
    const { checkedAt: _checked, decidedAt: _decided, projectRef: _ref, ...stable } = row;
    return { row: stable, parts: readMaterial(db, TASK) };
  });
}

const EXPECTED_FEATURES = { role: "implementer", area: "host", kind: "feature", risk: "normal", featureVersion: 1 };

test("capture off writes nothing and reads nothing", async () => {
  const cases: Setup[] = [
    { capture: false },
    { source: "laptop", capture: true },
    {},
  ];
  for (const setup of cases) {
    const w = world(setup);
    try {
      assert.equal(w.capture.enabled(PROJECT), false);
      w.capture.integrated(start());
      w.capture.approved(approval());
      await w.capture.idle();
      assert.deepEqual(w.store.read(db => runEvalTasks(db, RUN)), []);
      assert.deepEqual(w.git.calls, []);
    } finally {
      await finish(w);
    }
  }
});

test("the three facts give one result in every order", async () => {
  const orders = [
    ["C", "A", "R"], ["C", "R", "A"], ["A", "C", "R"], ["A", "R", "C"], ["R", "C", "A"], ["R", "A", "C"],
  ] as const;
  const cases = [
    { name: "accepted, no later change", later: [], accepted: 1 as const },
    { name: "accepted, later change", later: ["a.txt"], accepted: 1 as const },
    { name: "refused", later: [], accepted: 0 as const },
  ];
  for (const c of cases) {
    let first: (ReturnType<typeof snapshot> & { promoted: string[] }) | undefined;
    for (const order of orders) {
      const promoted: string[] = [];
      const w = world({ capture: true, onPromoted: (_tx, task) => { promoted.push(`${task.taskId} ${task.state}`); } });
      try {
        w.git.answer("names", REVIEWED, { state: "read", names: c.later });
        w.git.hold(COMMIT);
        w.git.hold(REVIEWED);
        w.capture.integrated(start());
        w.capture.approved(approval());
        for (const step of order) {
          if (step === "C") w.git.release(COMMIT);
          if (step === "A") w.git.release(REVIEWED);
          if (step === "R") writeLedger(w.store, ledger({ accepted: c.accepted, acceptance: c.accepted }));
          await SETTLE();
          w.capture.reconcile();
        }
        await w.capture.idle();
        const result = { ...snapshot(w.store), promoted };
        if (first === undefined) {
          first = result;
          const row = result.row;
          assert.deepEqual(promoted, row?.state === "candidate" ? [`${capturedTaskId(RUN, MEMBER)} candidate`] : [], c.name);
          if (c.accepted === 0) {
            assert.equal(row?.state, "rejected", c.name);
            assert.equal(row?.reason, "not-accepted", c.name);
          } else if (c.later.length > 0) {
            assert.equal(row?.state, "rejected", c.name);
            assert.equal(row?.reason, "reference-ambiguous", c.name);
          } else {
            assert.equal(row?.state, "candidate", c.name);
            assert.equal(row?.reason, null, c.name);
            assert.deepEqual((row?.payload as { features?: unknown }).features, EXPECTED_FEATURES, c.name);
          }
        } else {
          assert.deepEqual(result, first, `${c.name} in order ${order.join("")}`);
        }
      } finally {
        await finish(w);
      }
    }
  }
});

test("a later approval replaces an earlier one", async () => {
  const a = world();
  try {
    a.git.answer("names", REVIEWED_2, { state: "read", names: ["a.txt"] });
    a.git.answer("names", REVIEWED, { state: "read", names: [] });
    a.git.hold(COMMIT);
    a.git.hold(REVIEWED);
    a.git.hold(REVIEWED_2);
    a.capture.integrated(start());
    a.capture.approved(approval(REVIEWED, T0));
    a.capture.approved(approval(REVIEWED_2, T1));
    a.git.release(COMMIT);
    a.git.release(REVIEWED_2);
    await SETTLE();
    a.git.release(REVIEWED);
    await SETTLE();
    const row = taskRow(a.store);
    assert.equal(row?.approval, "read");
    assert.equal(row?.approvedAt, T1);
    assert.deepEqual((row?.payload as { laterFiles?: string[] }).laterFiles, ["a.txt"]);
  } finally {
    await finish(a);
  }

  const b = world();
  try {
    b.git.answer("names", REVIEWED_2, { state: "read", names: ["a.txt"] });
    b.git.hold(REVIEWED_2);
    b.capture.integrated(start());
    b.capture.approved(approval(REVIEWED, T0));
    await b.capture.idle();
    writeLedger(b.store, ledger());
    assert.equal(b.capture.reconcile().promoted, 1);
    assert.equal(taskRow(b.store)?.state, "candidate");
    b.capture.approved(approval(REVIEWED_2, T1));
    b.git.release(REVIEWED_2);
    await b.capture.idle();
    const result = b.capture.reconcile();
    assert.equal(result.demoted, 1);
    assert.equal(taskRow(b.store)?.reason, "reference-ambiguous");
    assert.deepEqual(partsOf(b.store), {});
  } finally {
    await finish(b);
  }
});

test("a stalled read refuses new work, never the run", async () => {
  const stalled = world({ capture: true, deadlineMs: 50 });
  try {
    stalled.git.silent = true;
    for (let i = 0; i < 4; i++) stalled.capture.integrated(start({ memberId: `m${i}` }));
    await stalled.capture.idle();
    for (let i = 0; i < 4; i++) {
      const row = taskRow(stalled.store, `m${i}`);
      assert.equal(row?.state, "rejected", `m${i}`);
      assert.equal(row?.reason, "capture-failed", `m${i}`);
    }
    stalled.capture.integrated(start({ memberId: "m4" }));
    const busy = taskRow(stalled.store, "m4");
    assert.equal(busy?.state, "rejected");
    assert.equal(busy?.reason, "capture-busy");
  } finally {
    await finish(stalled);
  }

  const queued = world({ capture: true, deadlineMs: 60_000 });
  try {
    queued.git.hold(COMMIT);
    for (let i = 0; i < 64; i++) queued.capture.integrated(start({ memberId: `q${i}` }));
    queued.capture.integrated(start({ memberId: "q64" }));
    const late = taskRow(queued.store, "q64");
    assert.equal(late?.state, "rejected");
    assert.equal(late?.reason, "capture-busy");
    assert.equal(taskRow(queued.store, "q63")?.state, "captured");
  } finally {
    await finish(queued);
  }

  const held = world({ capture: true, deadlineMs: 50 });
  try {
    for (let i = 1; i <= 5; i++) {
      const id = String(i).repeat(40);
      held.git.hold(id);
      held.capture.integrated(start({ memberId: `h${i}`, commit: id }));
    }
    held.capture.integrated(start({ memberId: "c6" }));
    await held.capture.idle();
    const refused = taskRow(held.store, "c6");
    assert.equal(refused?.state, "rejected");
    assert.equal(refused?.reason, "capture-failed");
    assert.equal(held.git.calls.includes(`names:${COMMIT}`), false, "the sixth job starts no read");
    held.git.releaseAll();
    await SETTLE();
    await SETTLE();
    held.capture.integrated(start({ memberId: "c7" }));
    await held.capture.idle();
    assert.equal(taskRow(held.store, "c7")?.state, "captured", "after the stalled reads ended, a new task is captured");
  } finally {
    await finish(held);
  }
});

test("closing stops the read chain", async () => {
  const w = world({ capture: true, deadlineMs: 60_000 });
  try {
    w.git.hold(MEMBER_BASE);
    w.capture.integrated(start());
    await SETTLE();
    await SETTLE();
    assert.deepEqual(w.git.calls, [`names:${COMMIT}`, `patch:${MEMBER_BASE}`]);
    w.capture.close();
    assert.equal(w.git.closes, 1, "close stops the Git reads in flight");
    let timer: NodeJS.Timeout | undefined;
    const waiting = new Promise<string>(resolve => { timer = setTimeout(() => resolve("waiting"), 500); });
    const outcome = await Promise.race([w.capture.idle().then(() => "idle"), waiting]);
    clearTimeout(timer);
    assert.equal(outcome, "idle");
    w.git.release(MEMBER_BASE);
    await SETTLE();
    await SETTLE();
    assert.deepEqual(w.git.calls, [`names:${COMMIT}`, `patch:${MEMBER_BASE}`]);
  } finally {
    await finish(w);
  }
});

test("a capture read reports to no operation", async () => {
  const w = world();
  try {
    const scope = { starting: () => undefined, started: () => undefined };
    commandScope.run(scope, () => w.capture.integrated(start()));
    await w.capture.idle();
    assert.equal(w.git.scopes.length, 1);
    assert.deepEqual(w.git.scopes, [undefined]);

    w.git.scopes.length = 0;
    w.git.hold(COMMIT);
    commandScope.run(scope, () => w.capture.integrated(start({ memberId: "m-first" })));
    commandScope.run(scope, () => w.capture.integrated(start({ memberId: OTHER_MEMBER, commit: OTHER_COMMIT })));
    w.git.release(COMMIT);
    await w.capture.idle();
    assert.equal(w.git.scopes.length, 2);
    assert.deepEqual(w.git.scopes, [undefined, undefined]);
  } finally {
    await finish(w);
  }
});

test("a restart turns pending facts into failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-restart-"));
  const key = randomBytes(32);
  const git = new FakeGit();
  git.answer("names", COMMIT, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
  git.answer("names", OTHER_COMMIT, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
  git.hold(COMMIT);
  git.hold(REVIEWED);
  const store1 = openStore(root, key);
  const first = new TaskCapture(captureOptions(root, store1, git, { capture: true }));
  first.integrated(start({ memberId: MEMBER }));
  first.integrated(start({ memberId: OTHER_MEMBER, commit: OTHER_COMMIT }));
  first.approved(approval());
  await SETTLE();
  first.close();
  store1.close();
  git.releaseAll();
  await first.idle();

  const store2 = openStore(root, key);
  const second = new TaskCapture(captureOptions(root, store2, git, { capture: true }));
  try {
    writeLedger(store2, ledger({ memberId: OTHER_MEMBER }));
    second.reconcile();
    const pendingMaterial = taskRow(store2, MEMBER);
    assert.equal(pendingMaterial?.state, "rejected");
    assert.equal(pendingMaterial?.reason, "capture-failed");
    const pendingApproval = taskRow(store2, OTHER_MEMBER);
    assert.equal(pendingApproval?.state, "rejected");
    assert.equal(pendingApproval?.reason, "reference-unknown");
  } finally {
    second.close();
    store2.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable store takes nothing and throws nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-closed-"));
  const key = randomBytes(32);
  const store = openStore(root, key);
  store.close();
  const capture = new TaskCapture(captureOptions(root, store, new FakeGit(), { capture: true }));
  try {
    assert.equal(capture.enabled(PROJECT), false);
    assert.doesNotThrow(() => {
      capture.integrated(start());
      capture.approved(approval());
    });
    assert.deepEqual(capture.reconcile(), { visited: 0, promoted: 0, rejected: 0, demoted: 0, waiting: 0, unreadable: 0 });
    assert.equal(capture.sweep(), 0);
    await capture.idle();
  } finally {
    capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted run's late read writes nothing", async () => {
  const w = world();
  try {
    w.git.hold(COMMIT);
    w.capture.integrated(start());
    w.store.write(tx => w.store.appendEvent(tx, {
      key: "run-1:deleted",
      runId: RUN,
      revision: 1,
      at: T0,
      kind: "run.deleted",
      data: { status: "cancelled" },
    }));
    assert.equal(w.store.deleteRun(RUN), true);
    w.git.release(COMMIT);
    await w.capture.idle();
    assert.deepEqual(w.store.read(db => runEvalTasks(db, RUN)), []);
    assert.deepEqual(partsOf(w.store), {});
  } finally {
    await finish(w);
  }
});

test("an owner exclusion demotes a candidate", async () => {
  const w = world();
  try {
    w.capture.integrated(start());
    w.capture.approved(approval(REVIEWED));
    await w.capture.idle();
    writeLedger(w.store, ledger());
    assert.equal(w.capture.reconcile().promoted, 1);
    assert.equal(taskRow(w.store)?.state, "candidate");
    writeLedger(w.store, ledger({ exclusion: "owner" }));
    const result = w.capture.reconcile();
    assert.equal(result.demoted, 1);
    const row = taskRow(w.store);
    assert.equal(row?.state, "rejected");
    assert.equal(row?.reason, "excluded");
    assert.deepEqual(partsOf(w.store), {});
  } finally {
    await finish(w);
  }
});

test("a missing patch ref leaves the patch missing while stream and empty reference failures reject explicitly", async () => {
  const w = world();
  try {
    w.git.answer("patch", COMMIT, { state: "missing" });
    w.capture.integrated(start());
    w.capture.approved(approval(REVIEWED));
    await w.capture.idle();
    const partial = taskRow(w.store);
    assert.equal(partial?.material, "partial");
    assert.equal((partial?.payload as { reference?: string } | undefined)?.reference, "missing");
    const parts = partsOf(w.store);
    assert.notEqual(parts.capsule, undefined);
    assert.equal(parts.reference, undefined);
    writeLedger(w.store, ledger());
    w.capture.reconcile();
    const row = taskRow(w.store);
    assert.equal(row?.state, "rejected");
    assert.equal(row?.reason, "patch-missing");
    assert.deepEqual(partsOf(w.store), {});

    const missingBase = "7".repeat(40);
    w.git.answer("names", OTHER_COMMIT, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
    w.git.answer("patch", missingBase, { state: "missing" });
    w.capture.integrated(start({ memberId: "m-missing-base", memberBaseCommit: missingBase, commit: OTHER_COMMIT }));
    await w.capture.idle();
    const partialBase = taskRow(w.store, "m-missing-base");
    assert.equal(partialBase?.material, "partial");
    assert.equal((partialBase?.payload as { baseDelta?: string } | undefined)?.baseDelta, "missing");

    const failedCommit = "6".repeat(40);
    w.git.answer("names", failedCommit, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
    w.git.answer("patch", failedCommit, { state: "failed" });
    w.capture.integrated(start({ memberId: "m-failed-ref", commit: failedCommit }));
    await w.capture.idle();
    const failedRef = taskRow(w.store, "m-failed-ref");
    assert.equal(failedRef?.state, "rejected");
    assert.equal(failedRef?.reason, "capture-failed");
    assert.equal(failedRef?.material, "none");
    assert.deepEqual(partsOf(w.store, "m-failed-ref"), {});

    const emptyCommit = "5".repeat(40);
    w.git.answer("names", emptyCommit, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
    w.git.answer("patch", emptyCommit, { state: "empty" });
    w.capture.integrated(start({ memberId: "m-empty-ref", commit: emptyCommit }));
    await w.capture.idle();
    const emptyRef = taskRow(w.store, "m-empty-ref");
    assert.equal(emptyRef?.state, "rejected");
    assert.equal(emptyRef?.reason, "capture-failed");
    assert.equal(emptyRef?.material, "none");
    assert.deepEqual(partsOf(w.store, "m-empty-ref"), {});

    const zeroCommit = "4".repeat(40);
    w.git.answer("names", zeroCommit, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
    w.git.answer("patch", zeroCommit, { state: "read", bytes: Buffer.alloc(0) });
    w.capture.integrated(start({ memberId: "m-zero-ref", commit: zeroCommit }));
    await w.capture.idle();
    const zeroRef = taskRow(w.store, "m-zero-ref");
    assert.equal(zeroRef?.state, "rejected");
    assert.equal(zeroRef?.reason, "capture-failed");
    assert.equal(zeroRef?.material, "none");
    assert.deepEqual(partsOf(w.store, "m-zero-ref"), {});

    const failedBase = "3".repeat(40);
    w.git.answer("patch", failedBase, { state: "failed" });
    w.capture.integrated(start({ memberId: "m-failed-base", memberBaseCommit: failedBase, commit: OTHER_COMMIT }));
    await w.capture.idle();
    const failedBaseRow = taskRow(w.store, "m-failed-base");
    assert.equal(failedBaseRow?.state, "rejected");
    assert.equal(failedBaseRow?.reason, "capture-failed");
    assert.equal(failedBaseRow?.material, "none");

    const equalBase = "2".repeat(40);
    w.git.answer("patch", equalBase, { state: "empty" });
    w.git.answer("sameTree", equalBase, "same");
    w.capture.integrated(start({ memberId: "m-empty-base", memberBaseCommit: equalBase, commit: OTHER_COMMIT }));
    w.capture.approved(approval(REVIEWED));
    await w.capture.idle();
    const equalBaseRow = taskRow(w.store, "m-empty-base");
    assert.equal(equalBaseRow?.state, "captured");
    assert.equal(equalBaseRow?.material, "stored");
    assert.equal((equalBaseRow?.payload as { baseDelta?: string } | undefined)?.baseDelta, "stored");
    assert.deepEqual(partsOf(w.store, "m-empty-base").baseDelta, Buffer.alloc(0));
    writeLedger(w.store, ledger({ memberId: "m-empty-base" }));
    assert.equal(w.capture.reconcile().promoted, 1);
    assert.equal(taskRow(w.store, "m-empty-base")?.state, "candidate");

    const diffBase = "1".repeat(40);
    w.git.answer("patch", diffBase, { state: "empty" });
    w.git.answer("sameTree", diffBase, "different");
    w.capture.integrated(start({ memberId: "m-empty-base-diff", memberBaseCommit: diffBase, commit: OTHER_COMMIT }));
    await w.capture.idle();
    const diffBaseRow = taskRow(w.store, "m-empty-base-diff");
    assert.equal(diffBaseRow?.state, "rejected");
    assert.equal(diffBaseRow?.reason, "capture-failed");
    assert.equal(diffBaseRow?.material, "none");

    const missingTreeBase = "0".repeat(40);
    w.git.answer("patch", missingTreeBase, { state: "empty" });
    w.git.answer("sameTree", missingTreeBase, "missing");
    w.capture.integrated(start({ memberId: "m-empty-base-missing", memberBaseCommit: missingTreeBase, commit: OTHER_COMMIT }));
    await w.capture.idle();
    const missingTreeRow = taskRow(w.store, "m-empty-base-missing");
    assert.equal(missingTreeRow?.material, "partial");
    assert.equal((missingTreeRow?.payload as { baseDelta?: string } | undefined)?.baseDelta, "missing");
  } finally {
    await finish(w);
  }
});

test("empty baseDelta requires proven equal trees with real git and rejects silent prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-real-git-"));
  const repo = join(root, "repo");
  const mirror = join(root, "mirror.git");
  const key = randomBytes(32);
  const runGit = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
    return res.stdout.trim();
  };
  const commitFiles = (files: Record<string, string>, message: string) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), content);
    }
    runGit(repo, "add", "-A");
    runGit(repo, "commit", "-q", "--allow-empty", "-m", message);
    return runGit(repo, "rev-parse", "HEAD");
  };
  mkdirSync(repo, { recursive: true });
  runGit(repo, "init", "-q", "--template=");
  runGit(repo, "config", "user.name", "Placeholder Author");
  runGit(repo, "config", "user.email", "placeholder@example.invalid");
  const anchor = commitFiles({ "a.txt": "base\n" }, "anchor");
  const equalBase = commitFiles({}, "equal tree");
  const equalCommit = commitFiles({ "a.txt": "changed\n", "tests/a.test.ts": "test\n" }, "equal ref");
  runGit(repo, "checkout", "-q", "--detach", anchor);
  const diffBase = commitFiles({ "other.txt": "diverged\n" }, "different tree");
  const diffCommit = commitFiles({ "a.txt": "changed\n", "tests/a.test.ts": "test\n" }, "diff ref");
  runGit(root, "clone", "-q", "--bare", repo, mirror);

  const silentBaseOnly = join(root, "silent-base-only.sh");
  writeFileSync(
    silentBaseOnly,
    `#!/bin/sh\nb=0; a=0; d=0\nfor arg in "$@"; do\n  [ "$arg" = "--binary" ] && b=1\n  [ "$arg" = "${anchor}" ] && a=1\n  [ "$arg" = "${diffBase}" ] && d=1\ndone\nif [ "$b" = 1 ] && [ "$a" = 1 ] && [ "$d" = 1 ]; then exit 0; fi\nshift\nexec git "$@"\n`,
  );
  const silentBaseAndTree = join(root, "silent-base-and-tree.sh");
  writeFileSync(
    silentBaseAndTree,
    `#!/bin/sh\nb=0; a=0; d=0; l=0\nfor arg in "$@"; do\n  [ "$arg" = "--binary" ] && b=1\n  [ "$arg" = "${anchor}" ] && a=1\n  [ "$arg" = "${diffBase}" ] && d=1\n  [ "$arg" = "--no-walk=unsorted" ] && l=1\ndone\nif [ "$l" = 1 ] || { [ "$b" = 1 ] && [ "$a" = 1 ] && [ "$d" = 1 ]; }; then exit 0; fi\nshift\nexec git "$@"\n`,
  );

  const openRun = (label: string, prefix?: { command: string; args: string[] }) => {
    const store = openStore(join(root, label), key);
    const source = {
      mirrorPath: () => mirror,
      status: () => ({ mode: "github" as const, mirrorHead: equalCommit }),
    } as unknown as Pick<ProjectSourceService, "mirrorPath" | "status">;
    const projects = [{ id: PROJECT, name: "Project", path: repo, source: { mode: "github" as const }, team: { eval: { capture: true } } }];
    const capture = new TaskCapture({
      config: { projects } as unknown as TaskCaptureOptions["config"],
      store,
      source,
      git: captureGit(() => prefix),
      now: () => T0,
    });
    return { store, capture };
  };

  const direct = openRun("direct");
  const swallowedPatch = openRun("swallowed-patch", { command: "/bin/sh", args: [silentBaseOnly] });
  const swallowedBoth = openRun("swallowed-both", { command: "/bin/sh", args: [silentBaseAndTree] });
  try {
    const refControl = await captureGit(() => ({ command: "/bin/sh", args: [silentBaseOnly] })).patch(repo, diffBase, diffCommit);
    assert.equal(refControl.state, "read");
    assert.ok(refControl.state === "read" && refControl.bytes.length > 0);
    const refControlBoth = await captureGit(() => ({ command: "/bin/sh", args: [silentBaseAndTree] })).patch(repo, diffBase, diffCommit);
    assert.equal(refControlBoth.state, "read");

    swallowedPatch.capture.integrated(start({ memberId: "m-silent-diff", workspace: repo, anchorCommit: anchor, memberBaseCommit: diffBase, commit: diffCommit, integratedHead: diffCommit }));
    await swallowedPatch.capture.idle();
    const silentDiffRow = taskRow(swallowedPatch.store, "m-silent-diff");
    assert.equal(silentDiffRow?.state, "rejected");
    assert.equal(silentDiffRow?.reason, "capture-failed");
    assert.deepEqual(partsOf(swallowedPatch.store, "m-silent-diff"), {});

    swallowedBoth.capture.integrated(start({ memberId: "m-silent-both", workspace: repo, anchorCommit: anchor, memberBaseCommit: diffBase, commit: diffCommit, integratedHead: diffCommit }));
    await swallowedBoth.capture.idle();
    const silentBothRow = taskRow(swallowedBoth.store, "m-silent-both");
    assert.equal(silentBothRow?.state, "rejected");
    assert.equal(silentBothRow?.reason, "capture-failed");

    direct.capture.integrated(start({ memberId: "m-equal-real", workspace: repo, anchorCommit: anchor, memberBaseCommit: equalBase, commit: equalCommit, integratedHead: equalCommit }));
    direct.capture.approved({ ...approval(equalCommit), workspace: repo, anchorCommit: anchor });
    await direct.capture.idle();
    const equalRow = taskRow(direct.store, "m-equal-real");
    assert.equal(equalRow?.state, "captured");
    assert.equal(equalRow?.material, "stored");
    assert.equal((equalRow?.payload as { baseDelta?: string } | undefined)?.baseDelta, "stored");
    assert.deepEqual(partsOf(direct.store, "m-equal-real").baseDelta, Buffer.alloc(0));
    assert.ok((partsOf(direct.store, "m-equal-real").reference?.length ?? 0) > 0);
    writeLedger(direct.store, ledger({ memberId: "m-equal-real" }));
    assert.equal(direct.capture.reconcile().promoted, 1);
    assert.equal(taskRow(direct.store, "m-equal-real")?.state, "candidate");
  } finally {
    direct.capture.close();
    swallowedPatch.capture.close();
    swallowedBoth.capture.close();
    direct.store.close();
    swallowedPatch.store.close();
    swallowedBoth.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("seeded randomized durable-state simulator preserves capture outcomes across approvals, reconciles, and reopens", async () => {
  const SEED = 0x439c0de;
  let rng = SEED >>> 0;
  const nextInt = (max: number) => {
    rng = (rng + 0x6d2b79f5) >>> 0;
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % max);
  };
  type Kind = "stored" | "empty-equal" | "empty-diff" | "failed" | "missing";
  type Spec = { memberId: string; kind: Kind; base: string; commit: string };
  type Model = { integrated: boolean; approved: boolean; ledgered: boolean; state: "none" | "captured" | "candidate" | "rejected"; reason: string | null };
  const kinds: readonly Kind[] = ["stored", "empty-equal", "empty-diff", "failed", "missing"];

  for (let trial = 0; trial < 8; trial++) {
    const root = mkdtempSync(join(tmpdir(), `infinite-eval-sim-${trial}-`));
    const key = randomBytes(32);
    const git = new FakeGit();
    const specs: Spec[] = kinds.map((kind, i) => ({
      memberId: `m-${kind}`,
      kind,
      base: `${(i + 1).toString(16)}`.repeat(40),
      commit: `${(i + 6).toString(16)}`.repeat(40),
    }));
    const model = new Map<string, Model>();
    for (const s of specs) {
      model.set(s.memberId, { integrated: false, approved: false, ledgered: false, state: "none", reason: null });
      git.answer("names", s.commit, { state: "read", names: ["a.txt", "tests/a.test.ts"] });
      if (s.kind === "missing") git.answer("patch", s.commit, { state: "missing" });
      if (s.kind === "failed") git.answer("patch", s.commit, trial % 2 === 0 ? { state: "failed" } : { state: "empty" });
      if (s.kind === "empty-equal") { git.answer("patch", s.base, { state: "empty" }); git.answer("sameTree", s.base, "same"); }
      if (s.kind === "empty-diff") { git.answer("patch", s.base, { state: "empty" }); git.answer("sameTree", s.base, "different"); }
    }
    git.answer("names", REVIEWED, { state: "read", names: [] });

    const ops: Array<{ kind: "integrate" | "ledger"; spec: Spec } | { kind: "approve" | "reconcile" | "reopen" }> = [
      ...specs.map(spec => ({ kind: "integrate" as const, spec })),
      ...specs.map(spec => ({ kind: "ledger" as const, spec })),
      { kind: "approve" },
      { kind: "approve" },
      { kind: "reconcile" },
      { kind: "reopen" },
      { kind: "reopen" },
    ];
    for (let i = ops.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      [ops[i], ops[j]] = [ops[j]!, ops[i]!];
    }
    ops.push({ kind: "approve" }, { kind: "reconcile" }, { kind: "reopen" }, { kind: "reconcile" });

    let store = openStore(root, key);
    let capture = new TaskCapture(captureOptions(root, store, git, { capture: true }));
    let approvalStep = 0;
    const checkAll = (step: number) => {
      const tag = `seed=0x${SEED.toString(16)} trial=${trial} step=${step}`;
      for (const s of specs) {
        const m = model.get(s.memberId)!;
        const row = taskRow(store, s.memberId);
        const parts = partsOf(store, s.memberId);
        if (m.state === "none") {
          assert.equal(row, undefined, `${tag} ${s.memberId}`);
          assert.deepEqual(parts, {}, `${tag} ${s.memberId}`);
          continue;
        }
        assert.equal(row?.state, m.state, `${tag} ${s.memberId} state`);
        assert.equal(row?.reason, m.reason, `${tag} ${s.memberId} reason`);
        if (m.state === "rejected") {
          assert.equal(row?.material, "none", `${tag} ${s.memberId} material`);
          assert.deepEqual(parts, {}, `${tag} ${s.memberId} parts cleared`);
        } else if (s.kind === "missing") {
          assert.equal(row?.material, "partial", `${tag} ${s.memberId} partial`);
          assert.notEqual(parts.capsule, undefined, `${tag} ${s.memberId} capsule`);
          assert.equal(parts.reference, undefined, `${tag} ${s.memberId} no ref`);
        } else {
          assert.equal(row?.material, "stored", `${tag} ${s.memberId} stored`);
          assert.notEqual(parts.capsule, undefined, `${tag} ${s.memberId} capsule`);
          assert.ok((parts.reference?.length ?? 0) > 0, `${tag} ${s.memberId} ref`);
          if (s.kind === "empty-equal") assert.deepEqual(parts.baseDelta, Buffer.alloc(0), `${tag} ${s.memberId} empty base`);
          else assert.ok((parts.baseDelta?.length ?? 0) > 0, `${tag} ${s.memberId} base`);
        }
      }
    };

    try {
      for (let step = 0; step < ops.length; step++) {
        const op = ops[step]!;
        if (op.kind === "integrate") {
          capture.integrated(start({ memberId: op.spec.memberId, memberBaseCommit: op.spec.base, commit: op.spec.commit }));
          await capture.idle();
          const m = model.get(op.spec.memberId)!;
          m.integrated = true;
          if (op.spec.kind === "failed" || op.spec.kind === "empty-diff") { m.state = "rejected"; m.reason = "capture-failed"; }
          else { m.state = "captured"; m.reason = null; }
        } else if (op.kind === "ledger") {
          writeLedger(store, ledger({ memberId: op.spec.memberId }));
          model.get(op.spec.memberId)!.ledgered = true;
        } else if (op.kind === "approve") {
          const at = new Date(Date.parse(T0) + (++approvalStep) * 60_000).toISOString();
          capture.approved(approval(REVIEWED, at));
          await capture.idle();
          for (const m of model.values()) if (m.state === "captured" || m.state === "candidate") m.approved = true;
        } else if (op.kind === "reconcile") {
          capture.reconcile();
          for (const s of specs) {
            const m = model.get(s.memberId)!;
            if (m.state !== "captured" || !m.ledgered) continue;
            if (s.kind === "missing") { m.state = "rejected"; m.reason = "patch-missing"; }
            else if (!m.approved) { m.state = "rejected"; m.reason = "reference-unknown"; }
            else { m.state = "candidate"; m.reason = null; }
          }
        } else {
          capture.close();
          await capture.idle();
          store.close();
          store = openStore(root, key);
          capture = new TaskCapture(captureOptions(root, store, git, { capture: true }));
        }
        checkAll(step);
      }
    } finally {
      capture.close();
      await capture.idle();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unreadable records are never promoted", async () => {
  const a = world();
  try {
    a.capture.integrated(start());
    a.capture.approved(approval(REVIEWED));
    await a.capture.idle();
    writeLedger(a.store, ledger());
    a.store.write((tx: EvidenceTx) => {
      tx.run("UPDATE eval_tasks SET payload=? WHERE task_id=?", "not-sealed", TASK);
    });
    a.capture.reconcile();
    const raw = a.store.read(db => db.get<{ state: string; reason: string }>("SELECT state, reason FROM eval_tasks WHERE task_id=?", TASK));
    assert.equal(raw?.state, "rejected");
    assert.equal(raw?.reason, "unreadable");
    assert.deepEqual(partsOf(a.store), {});
  } finally {
    await finish(a);
  }

  const b = world();
  try {
    b.capture.integrated(start());
    b.capture.approved(approval(REVIEWED));
    await b.capture.idle();
    writeLedger(b.store, ledger());
    b.store.write((tx: EvidenceTx) => {
      tx.run("UPDATE outcomes SET payload=? WHERE outcome_id=?", "not-sealed", outcomeId(RUN, MEMBER));
    });
    const result = b.capture.reconcile();
    assert.equal(result.unreadable, 1);
    assert.equal(taskRow(b.store)?.state, "captured");
  } finally {
    await finish(b);
  }
});
