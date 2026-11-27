import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { MirrorFetch } from "../packages/host/src/project-source.js";
import { type OutcomeRow, outcomeModule, type RunSummaryRow, writeOutcome, writeSummary } from "../packages/host/src/outcome-store.js";
import { scanGit, scanOnce } from "../packages/host/src/outcome-scan.js";
import { landingSignalId, revertSignalId } from "../packages/host/src/outcome-signals.js";
import { readSignals } from "../packages/host/src/signals/consume.js";
import { MAX_SIGNAL_KEYS, MAX_SIGNAL_ROWS, SignalService } from "../packages/host/src/signals/service.js";
import { inProcessHost } from "./helpers.js";

const DAY_MS = 86_400_000;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function openStore(root: string, key: Buffer): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: key });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-signals-")));
  const key = randomBytes(32);
  const clock = { now: Date.parse("2026-11-01T00:00:00.000Z") };
  const store = openStore(root, key);
  const signals = new SignalService({ store, now: () => clock.now });
  return { root, key, clock, store, signals, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the inbox records each project, kind, and key once and reads oldest first by cursor and kind", () => {
  const f = fixture();
  try {
    const reader = f.signals.reader();
    assert.equal(reader.head(), 0);
    const requestId = randomUUID();
    const first = f.signals.record({ projectId: "alpha", kind: "owner", key: requestId, text: "Look at the flaky upload test" });
    assert.equal(first.recorded, true);
    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "owner", key: requestId, text: "Different text" }), { recorded: false, signal: "signal" in first ? first.signal : undefined });
    f.signals.record({ projectId: "beta", kind: "external-commit", key: COMMIT_A, commit: COMMIT_A });
    f.signals.record({ projectId: "alpha", kind: "revert", key: "revert-1", runId: "run-1", commit: COMMIT_B });
    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "revert", key: "revert-2", text: "From a commit message" }), { recorded: false, failure: "invalid" });

    assert.equal(reader.head(), 3);
    assert.deepEqual(reader.after("alpha", 0).map(signal => [signal.seq, signal.kind]), [[1, "owner"], [3, "revert"]]);
    assert.deepEqual(reader.after("alpha", 1).map(signal => signal.runId), ["run-1"]);
    assert.deepEqual(reader.after("alpha", 0, { kinds: ["revert"] }).map(signal => signal.seq), [3]);
    assert.deepEqual(reader.after("alpha", 0, { limit: 1 }).map(signal => signal.seq), [1]);
    assert.equal(reader.after("alpha", 0)[0]!.text, "Look at the flaky upload test");

    assert.deepEqual(readSignals(reader, "alpha", 0, ["owner"])?.cursor, 3);
    assert.deepEqual(readSignals(reader, "alpha", undefined), { cursor: 3, signals: [], more: false }, "a new consumer starts at the head");
    let reads = 0;
    const read = f.store.read.bind(f.store);
    (f.store as { read: unknown }).read = (fn: Parameters<EvidenceStore["read"]>[0]) => { reads++; return read(fn); };
    assert.deepEqual(readSignals(reader, "alpha", 3, ["owner"]), { cursor: 3, signals: [], more: false });
    assert.equal(reads, 0, "a cursor at the head reads no database");
    const full = readSignals(reader, "alpha", 0, undefined, 1);
    assert.deepEqual([full?.cursor, full?.more], [1, true]);
    (f.store as { read: unknown }).read = () => { throw new Error("locked"); };
    assert.equal(readSignals(reader, "alpha", 0, ["owner"]), undefined);
    (f.store as { read: unknown }).read = read;
    f.clock.now += 6_000;
    assert.equal(readSignals(reader, "alpha", 0, ["owner"])?.signals.length, 1);

    f.store.close();
    const reopened = openStore(f.root, f.key);
    try {
      const service = new SignalService({ store: reopened });
      assert.equal(service.head(), 3);
      assert.deepEqual(service.reader().after("alpha", 0).map(signal => signal.seq), [1, 3]);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("retention drops signals after 30 days and keeps at most 20,000 rows", () => {
  const f = fixture();
  try {
    const reader = f.signals.reader();
    f.signals.record({ projectId: "alpha", kind: "owner", key: randomUUID(), text: "Old direction" });
    f.clock.now += 31 * DAY_MS;
    const keptKey = randomUUID();
    const kept = f.signals.record({ projectId: "alpha", kind: "owner", key: keptKey, text: "New direction" });
    f.signals.sweep();
    assert.deepEqual(reader.after("alpha", 0).map(signal => signal.seq), [2]);
    assert.deepEqual(readSignals(reader, "alpha", 0, ["owner"])?.signals.map(signal => signal.id), ["signal" in kept ? kept.signal.id : ""]);

    const bulk = f.signals.recordAll(Array.from({ length: MAX_SIGNAL_ROWS + 1 }, (_, index) => ({ projectId: "bulk", kind: "delivery-landed" as const, key: `landing-${index}` })));
    assert.ok(bulk.every(result => result.recorded));
    assert.equal(f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM project_signals"))?.n, MAX_SIGNAL_ROWS);
    assert.deepEqual(reader.after("alpha", 0), [], "the oldest rows went first");
    assert.equal(reader.after("bulk", 0, { limit: 1 })[0]!.key, "landing-1");
    assert.equal(reader.head(), MAX_SIGNAL_ROWS + 3, "seq never goes back");

    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "owner", key: keptKey, text: "New direction" }), { recorded: false, failure: "gone" });
    assert.equal(reader.head(), MAX_SIGNAL_ROWS + 3);
    f.clock.now += 31 * DAY_MS;
    f.signals.sweep();
    assert.equal(f.signals.record({ projectId: "alpha", kind: "owner", key: keptKey, text: "New direction" }).recorded, true);
  } finally { f.close(); }
});

test("an inbox that remembers its maximum number of keys refuses new signals and forgets no key", () => {
  const f = fixture();
  try {
    const first = f.signals.record({ projectId: "alpha", kind: "owner", key: "first", text: "Direction" });
    assert.equal(first.recorded, true);
    const at = new Date(f.clock.now).toISOString();
    f.store.write(tx => { tx.run("INSERT INTO project_signal_keys (dedup, seq, at) VALUES (?, ?, ?)", "far", -MAX_SIGNAL_KEYS, at); });
    assert.equal(f.signals.record({ projectId: "alpha", kind: "owner", key: "second", text: "More direction" }).recorded, true);
    f.store.write(tx => {
      tx.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO project_signal_keys (dedup, seq, at) SELECT 'filler-' || i, -i, ? FROM n", MAX_SIGNAL_KEYS - 3, at);
    });
    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "owner", key: "third", text: "Even more" }), { recorded: false, failure: "full" });
    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "owner", key: "first", text: "Direction" }), { recorded: false, signal: "signal" in first ? first.signal : undefined });
    f.clock.now += 31 * DAY_MS;
    f.signals.sweep();
    assert.equal(f.signals.record({ projectId: "alpha", kind: "owner", key: "third", text: "Even more" }).recorded, true);
  } finally { f.close(); }
});

test("an unavailable store fails soft", () => {
  const f = fixture();
  try {
    f.store.close();
    assert.deepEqual(f.signals.record({ projectId: "alpha", kind: "owner", key: randomUUID(), text: "Anything" }), { recorded: false, failure: "unavailable" });
    const reader = f.signals.reader();
    assert.equal(reader.head(), undefined);
    assert.deepEqual(reader.after("alpha", 0), []);
    assert.equal(readSignals(reader, "alpha", 0), undefined, "a consumer keeps its cursor");
    assert.equal(f.signals.page("alpha", 0), undefined);
    const scan = { projectId: "alpha", head: COMMIT_A, continuous: true, commits: [{ id: COMMIT_A, tree: COMMIT_B, parents: [] }], landings: [], reverts: [], recorded: [] };
    assert.deepEqual(f.signals.recordScan(scan), [{ recorded: false, failure: "unavailable" }]);
    f.signals.sweep();
  } finally { f.close(); }
});

const GIT_CONFIG = ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const PROJECT = "example";
const day = (n: number) => new Date(Date.parse("2026-11-13T00:00:00.000Z") + n * DAY_MS).toISOString();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_CONFIG, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(seed: string, name: string, message: string): string {
  writeFileSync(join(seed, name), `${message}\n`);
  git(seed, "add", name);
  git(seed, "commit", "-q", "-m", message);
  return git(seed, "rev-parse", "HEAD");
}

function recordRun(store: EvidenceStore, runId: string, refs: { mergeCommit?: string; reviewedHead?: string; reviewedTree?: string }): void {
  const summary: RunSummaryRow = {
    runId, source: "test", projectRef: "", revision: 1, status: "approved", blockCode: null, flags: [],
    createdAt: null, settledAt: null, approvedAt: day(-1), runDeletedAt: null,
    payload: { projectId: PROJECT, attempts: { completed: 1 }, rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 }, ...refs },
  };
  const row: OutcomeRow = {
    outcomeId: `${runId}:member`, source: "test", projectRef: "", taskRef: "", areaRef: "", runId, revision: 1,
    memberId: "member", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "profile",
    provider: "opencode", model: "model", effort: null, profileEpoch: 1, configId: null, experimentRef: null,
    kind: null, risk: "low", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
    integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: null, startedAt: null, endedAt: null,
    frozenAt: day(-1), holdUntil: null, runDeletedAt: null,
    payload: { projectId: PROJECT, taskId: "task", area: "core", featureMap: "map", rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
  };
  store.write(tx => { writeSummary(tx, summary); writeOutcome(tx, row); });
}

test("base scans record landings, reverts, and outside commits with the run they belong to", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-signal-scan-")));
  const store = openStore(root, randomBytes(32));
  store.register(outcomeModule());
  const signals = new SignalService({ store });
  const mirror = join(root, "mirror.git"), seed = join(root, "seed");
  let previous: { head: string; since: string } | undefined;
  const fetchAt = (n: number): MirrorFetch => {
    const head = git(mirror, "rev-parse", "main");
    const fetch: MirrorFetch = { projectId: PROJECT, repository: "example-repo", baseBranch: "main", head, fetchedAt: day(n), ...(previous ? { previousHead: previous.head, previousSince: previous.since } : {}) };
    if (previous?.head !== head) previous = { head, since: day(n) };
    return fetch;
  };
  const scan = (n: number, onApplied = (applied: Parameters<SignalService["recordScan"]>[0]) => { signals.recordScan(applied); }) =>
    scanOnce({ store, git: scanGit(), mirror, fetch: fetchAt(n), holdDays: 30, onApplied });
  const kinds = () => signals.reader().after(PROJECT, 0).map(signal => [signal.kind, signal.runId ?? null, signal.commit ?? null]);
  try {
    git(root, "init", "-q", "--bare", "--initial-branch=main", mirror);
    git(root, "init", "-q", "--initial-branch=main", seed);
    git(seed, "remote", "add", "origin", mirror);
    commitFile(seed, "base.txt", "base");
    git(seed, "checkout", "-q", "-b", "run-a", "main");
    commitFile(seed, "a.txt", "work on run-a");
    git(seed, "checkout", "-q", "main");
    git(seed, "merge", "-q", "--no-ff", "-m", "Merge run-a", "run-a");
    const mergeA = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", "origin", "main");
    recordRun(store, "run-a", { mergeCommit: mergeA });

    assert.equal((await scan(0)).state, "scanned");
    assert.deepEqual(kinds(), [["delivery-landed", "run-a", mergeA]]);
    assert.equal(signals.reader().after(PROJECT, 0)[0]!.key, landingSignalId("run-a"));

    const outside = commitFile(seed, "outside.txt", "outside change");
    git(seed, "push", "-q", "origin", "main");
    await scan(1);
    assert.deepEqual(kinds().at(-1), ["external-commit", null, outside]);

    git(seed, "revert", "--no-edit", "-m", "1", mergeA);
    const revert = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", "origin", "main");
    await scan(2);
    assert.deepEqual(kinds().slice(2), [["revert", "run-a", revert]]);
    assert.equal(signals.reader().after(PROJECT, 0).at(-1)!.key, revertSignalId(landingSignalId("run-a"), revert));

    git(seed, "checkout", "-q", "-b", "run-b", "main");
    commitFile(seed, "b1.txt", "first part of run-b");
    const tipB = commitFile(seed, "b2.txt", "second part of run-b");
    git(seed, "checkout", "-q", "main");
    git(seed, "merge", "-q", "--ff-only", "run-b");
    git(seed, "push", "-q", "origin", "main");
    recordRun(store, "run-b", { reviewedHead: tipB, reviewedTree: git(seed, "rev-parse", `${tipB}^{tree}`) });
    await scan(3);
    assert.deepEqual(kinds().slice(3), [["delivery-landed", "run-b", tipB]]);

    git(seed, "checkout", "-q", "-b", "run-c", "main");
    commitFile(seed, "c1.txt", "first part of run-c");
    git(seed, "checkout", "-q", "main");
    const moved = commitFile(seed, "moved.txt", "base moved under run-c");
    git(seed, "push", "-q", "origin", "main");
    await scan(4);
    assert.deepEqual(kinds().slice(4), [["external-commit", null, moved]]);
    git(seed, "checkout", "-q", "run-c");
    git(seed, "merge", "-q", "--no-ff", "-m", "Merge main into run-c", "main");
    const tipC = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "-q", "main");
    git(seed, "merge", "-q", "--ff-only", "run-c");
    git(seed, "push", "-q", "origin", "main");
    recordRun(store, "run-c", { reviewedHead: tipC, reviewedTree: git(seed, "rev-parse", `${tipC}^{tree}`) });
    let applied: Parameters<SignalService["recordScan"]>[0] | undefined;
    await scan(5, value => { applied = value; signals.recordScan(value); });
    assert.equal(applied?.continuous, true);
    assert.deepEqual(applied?.commits.map(commit => commit.parents.length), [1, 2], "the scan read the run's first commit and its merge");
    assert.deepEqual(kinds().slice(5), [["delivery-landed", "run-c", tipC]]);

    commitFile(seed, "later.txt", "later outside change");
    git(seed, "push", "-q", "origin", "main");
    assert.equal((await scan(6, () => { throw new Error("listener failed"); })).state, "scanned");
    assert.equal(kinds().length, 6);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owner adds a signal once per request, and paired devices read the inbox", { timeout: 60000 }, async () => {
  const host = await inProcessHost();
  try {
    const body = { requestId: randomUUID(), text: "  Check the release notes before the next run  " };
    assert.equal((await host.fetchApi("/projects/rehearsal/signals", "viewer", body)).status, 403);
    assert.equal((await host.fetchApi("/projects/rehearsal/signals", "controller", body)).status, 403);
    assert.equal((await host.fetchApi("/projects/missing/signals", "owner", body)).status, 404);
    assert.equal((await host.fetchApi("/projects/rehearsal/signals", "owner", { ...body, kind: "revert" })).status, 400);

    const first = await host.fetchApi("/projects/rehearsal/signals", "owner", body);
    assert.equal(first.status, 200);
    assert.equal(first.body.recorded, true);
    assert.equal(first.body.signal.kind, "owner");
    assert.equal(first.body.signal.text, "Check the release notes before the next run");
    const replay = await host.fetchApi("/projects/rehearsal/signals", "owner", { ...body, text: "Something else" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.recorded, false);
    assert.deepEqual(replay.body.signal, first.body.signal);

    const listed = await host.fetchApi("/projects/rehearsal/signals", "viewer");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { signals: [first.body.signal], head: first.body.signal.seq });
    assert.deepEqual((await host.fetchApi(`/projects/rehearsal/signals?after=${first.body.signal.seq}`, "viewer")).body.signals, []);
    assert.equal((await host.fetchApi("/projects/rehearsal/signals?after=-1", "viewer")).status, 400);
  } finally { await host.stop(); }
});
