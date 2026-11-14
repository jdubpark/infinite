import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { MirrorFetch } from "../packages/host/src/project-source.js";
import { type OutcomeRow, outcomeModule, lastScan, readOutcome, readScanState, readSignal, type RunSummaryRow, writeOutcome, writeSummary } from "../packages/host/src/outcome-store.js";
import { landingSignalId } from "../packages/host/src/outcome-signals.js";
import { BaseScanner, type ScanGit, scanGit, scanOnce, type ScanResult } from "../packages/host/src/outcome-scan.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/team-agent.mjs", import.meta.url));
const PROJECT = "example";
const REPO = "example-repo";
const DAY_MS = 86_400_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONFIG = ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const ID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
/** The five forms of the plan's table, matched against the arguments after the six `-c` pairs, joined by spaces. */
const FORMS = [
  new RegExp(`^merge-base --is-ancestor ${ID} ${ID}$`),
  new RegExp(`^rev-list --first-parent --max-count=501 ${ID} \\^${ID}$`),
  new RegExp(`^rev-list --first-parent --max-count=500 ${ID}$`),
  new RegExp(`^log --no-walk=unsorted --no-show-signature --format=%H %T %P(?: ${ID}){1,50}$`),
  new RegExp(`^log --no-walk=unsorted --no-show-signature --format=%H --fixed-strings(?: --grep=This reverts commit ${ID}){1,50}(?: ${ID}){1,50}$`),
];

/** Day N of the scan clock. Day 0 is 2026-11-13T00:00:00.000Z. */
const day = (n: number) => new Date(Date.parse("2026-11-13T00:00:00.000Z") + n * DAY_MS).toISOString();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...CONFIG, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

type Repos = { root: string; mirror: string; seed: string; close(): void };

/** A bare mirror and a seed clone that pushes to it. Both live in one temporary directory. */
function repos(): Repos {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-outcome-scan-")));
  const mirror = join(root, "mirror.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", mirror);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "remote", "add", "origin", mirror);
  return { root, mirror, seed, close: () => rmSync(root, { recursive: true, force: true }) };
}

function commitFile(seed: string, name: string, message: string): string {
  writeFileSync(join(seed, name), `${message}\n`);
  git(seed, "add", name);
  git(seed, "commit", "-m", message);
  return git(seed, "rev-parse", "HEAD");
}

/** One commit on a branch off main. The seed is left on main. */
function branchCommit(seed: string, branch: string, name: string): string {
  git(seed, "checkout", "-q", "-b", branch, "main");
  const tip = commitFile(seed, name, `work on ${branch}`);
  git(seed, "checkout", "-q", "main");
  return tip;
}

function mergeBranch(seed: string, branch: string): string {
  git(seed, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);
  return git(seed, "rev-parse", "HEAD");
}

function push(seed: string): void {
  git(seed, "push", "-q", "origin", "main");
}

function head(repo: string, ref = "main"): string {
  return git(repo, "rev-parse", ref);
}

/** Bulk commits on main, made with one `git fast-import` stream. */
function addCommits(seed: string, count: number): void {
  const parts: string[] = [];
  const tip = git(seed, "rev-parse", "main");
  for (let index = 1; index <= count; index += 1) {
    const message = `bulk ${index}`;
    const body = `${index}\n`;
    parts.push(
      `commit refs/heads/main\ncommitter Test <test@example.invalid> 1700000000 +0000\n`
      + `data ${message.length}\n${message}\n${index === 1 ? `from ${tip}\n` : ""}`
      + `M 100644 inline bulk/${index}.txt\ndata ${body.length}\n${body}\n`,
    );
  }
  execFileSync("git", [...CONFIG, "fast-import", "--quiet"], { cwd: seed, input: parts.join("\n") });
  git(seed, "reset", "-q", "--hard", "main");
}

function openStore(root: string, name: string): EvidenceStore {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, name)), vaultKey: randomBytes(32) });
  store.register(outcomeModule());
  return store;
}

type Refs = { mergeCommit?: string; reviewedHead?: string; reviewedTree?: string };

/** A run approved the day before the first scan: its summary, and one accepted, integrated, frozen row. */
function recordRun(store: EvidenceStore, runId: string, refs: Refs = {}, projectId = PROJECT): void {
  const summary: RunSummaryRow = {
    runId, source: "test", projectRef: "", revision: 1, status: "approved", blockCode: null, flags: [],
    createdAt: null, settledAt: null, approvedAt: day(-1), runDeletedAt: null,
    payload: { projectId, attempts: { completed: 1 }, rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 }, ...refs },
  };
  const row: OutcomeRow = {
    outcomeId: `${runId}:member`, source: "test", projectRef: "", taskRef: "", areaRef: "", runId, revision: 1,
    memberId: "member", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "profile",
    provider: "opencode", model: "model", effort: null, profileEpoch: 1, configId: null, experimentRef: null,
    kind: null, risk: "low", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
    integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: null, startedAt: null, endedAt: null,
    frozenAt: day(-1), holdUntil: null, runDeletedAt: null,
    payload: {
      projectId, taskId: "task", area: "core", featureMap: "map",
      rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none",
    },
  };
  store.write(tx => {
    writeSummary(tx, summary);
    writeOutcome(tx, row);
  });
}

function outcomeOf(store: EvidenceStore, runId: string): OutcomeRow | undefined {
  return store.read(db => readOutcome(db, `${runId}:member`));
}

function fetchOf(repo: Repos, n: number, projectId = PROJECT): MirrorFetch {
  return { projectId, repository: REPO, baseBranch: "main", head: head(repo.mirror), fetchedAt: day(n) };
}

function scanAt(store: EvidenceStore, repo: Repos, n: number, git: ScanGit = scanGit()): Promise<ScanResult> {
  return scanOnce({ store, git, mirror: repo.mirror, fetch: fetchOf(repo, n), holdDays: 30 });
}

test("a first scan reads the newest commits", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "a.txt", "one");
    commitFile(repo.seed, "b.txt", "two");
    commitFile(repo.seed, "c.txt", "three");
    push(repo.seed);
    const result = await scanAt(store, repo, 0);
    assert.deepEqual(
      { state: result.state, gap: result.gap, commits: result.commits },
      { state: "scanned", gap: "first", commits: 3 },
    );
    const scan = store.read(db => lastScan(db, db.index("project", PROJECT)));
    assert.equal(scan?.payload.to, head(repo.mirror));
    assert.equal("from" in (scan?.payload ?? {}), false);
  } finally {
    store.close();
    repo.close();
  }
});

test("each rule lands its run", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-a", "a.txt");
    const mergeA = mergeBranch(repo.seed, "run-a");
    const tipB = branchCommit(repo.seed, "run-b", "b.txt");
    const mergeB = mergeBranch(repo.seed, "run-b");
    const tipC = branchCommit(repo.seed, "run-c", "c.txt");
    git(repo.seed, "merge", "-q", "--ff-only", "run-c");
    const treeC = git(repo.seed, "rev-parse", `${tipC}^{tree}`);
    push(repo.seed);
    recordRun(store, "run-a", { mergeCommit: mergeA });
    recordRun(store, "run-b", { reviewedHead: tipB });
    recordRun(store, "run-c", { reviewedHead: tipC, reviewedTree: treeC });

    const result = await scanAt(store, repo, 0);
    assert.equal(result.state, "scanned");
    assert.equal(result.landings, 3);
    const landed = (runId: string) => store.read(db => readSignal(db, landingSignalId(runId)))?.payload;
    assert.deepEqual(landed("run-a"), { kind: "landing", commit: mergeA, method: "merge-commit", scanSeq: 1, holdDays: 30, holdUntil: day(30) });
    assert.equal(landed("run-b")?.kind === "landing" && landed("run-b")?.method, "merge-parent");
    assert.equal(landed("run-b")?.kind === "landing" && landed("run-b")?.commit, mergeB);
    assert.equal(landed("run-c")?.kind === "landing" && landed("run-c")?.method, "tree-equal");
    assert.equal(landed("run-c")?.kind === "landing" && landed("run-c")?.commit, tipC);
  } finally {
    store.close();
    repo.close();
  }
});

test("a squash onto a moved base lands nothing", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    const tipD = branchCommit(repo.seed, "run-d", "d.txt");
    commitFile(repo.seed, "moved.txt", "moved");
    commitFile(repo.seed, "d.txt", "work on run-d");
    push(repo.seed);
    recordRun(store, "run-d", { reviewedHead: tipD, reviewedTree: git(repo.seed, "rev-parse", `${tipD}^{tree}`) });

    assert.equal((await scanAt(store, repo, 0)).landings, 0);
    const row = outcomeOf(store, "run-d");
    assert.equal(row?.held, null);
    assert.equal(row?.flags.includes("scan-gap"), false);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-d"))), undefined);
  } finally {
    store.close();
    repo.close();
  }
});

test("acceptance 6", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-e", "e.txt");
    const mergeE = mergeBranch(repo.seed, "run-e");
    branchCommit(repo.seed, "run-f", "f.txt");
    const mergeF = mergeBranch(repo.seed, "run-f");
    push(repo.seed);
    recordRun(store, "run-e", { mergeCommit: mergeE });
    recordRun(store, "run-f", { mergeCommit: mergeF });
    recordRun(store, "run-g", { mergeCommit: mergeF }, "other");

    // Run E lands on day 0, and its merge is reverted before day 10.
    assert.equal((await scanAt(store, repo, 0)).landings, 2);
    git(repo.seed, "revert", "--no-edit", "-m", "1", mergeE);
    push(repo.seed);
    assert.equal((await scanAt(store, repo, 10)).reverts, 1);
    assert.equal(outcomeOf(store, "run-e")?.held, 0);
    assert.equal(outcomeOf(store, "run-f")?.held, null);

    // Run F's window closes at day 31 with a check at the same head.
    assert.equal((await scanAt(store, repo, 31)).state, "checked");
    assert.equal(outcomeOf(store, "run-f")?.held, 1);

    // A project with no mirror is never scanned.
    const absent = await scanOnce({
      store, git: scanGit(), mirror: join(repo.root, "absent.git"), fetch: fetchOf(repo, 0, "other"), holdDays: 30,
    });
    assert.equal(absent.state, "skipped");
    assert.equal(outcomeOf(store, "run-g")?.held, null);
  } finally {
    store.close();
    repo.close();
  }
});

test("a jump past 500 commits is a gap", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-r", "r.txt");
    const mergeR = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { mergeCommit: mergeR });
    assert.equal((await scanAt(store, repo, 0)).landings, 1);

    addCommits(repo.seed, 501);
    push(repo.seed);
    const jump = await scanAt(store, repo, 1);
    assert.deepEqual({ state: jump.state, gap: jump.gap, commits: jump.commits }, { state: "scanned", gap: "bound", commits: 500 });
    // The scan keeps the newest 500 commits, and it does not claim the range from the previous head.
    const newest = git(repo.mirror, "rev-list", "--first-parent", "--max-count=500", "main").split("\n");
    const bounded = store.read(db => lastScan(db, db.index("project", PROJECT)));
    assert.equal(bounded?.payload.to, head(repo.mirror));
    assert.equal(bounded?.payload.oldest, newest[newest.length - 1]);
    assert.equal("from" in (bounded?.payload ?? {}), false);

    assert.equal((await scanAt(store, repo, 31)).state, "checked");
    const row = outcomeOf(store, "run-r");
    assert.equal(row?.held, null);
    assert.equal(row?.flags.includes("scan-gap"), true);
  } finally {
    store.close();
    repo.close();
  }
});

test("a rewritten branch is a gap", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-r", "r.txt");
    const mergeR = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { mergeCommit: mergeR });
    assert.equal((await scanAt(store, repo, 0)).landings, 1);

    const unrelated = git(repo.seed, "commit-tree", EMPTY_TREE, "-m", "Unrelated history");
    git(repo.seed, "push", "-q", "--force", "origin", `${unrelated}:main`);
    const rewrite = await scanAt(store, repo, 1);
    assert.equal(rewrite.gap, "rewrite");

    const payload = store.read(db => readSignal(db, landingSignalId("run-r")))?.payload;
    assert.ok(payload?.kind === "landing");
    assert.equal(payload.window?.state, "gap");
    const row = outcomeOf(store, "run-r");
    assert.equal(row?.held, null);
    assert.equal(row?.flags.includes("scan-gap"), true);
  } finally {
    store.close();
    repo.close();
  }
});

test("a failed read writes nothing and the next scan resumes", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    assert.equal((await scanAt(store, repo, 0)).state, "scanned");
    const firstHead = head(repo.mirror);

    branchCommit(repo.seed, "run-r", "r.txt");
    const mergeR = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { mergeCommit: mergeR });

    // Form 4 is a `log`; a refusal there fails the whole scan.
    const refusingLog: ScanGit = (cwd, args) => args[0] === "log"
      ? Promise.resolve({ exitCode: 1, output: "", stdout: "", interrupted: false, truncated: false })
      : scanGit()(cwd, args);
    assert.equal((await scanAt(store, repo, 1, refusingLog)).state, "failed");
    assert.equal(store.read(db => readScanState(db, db.index("project", PROJECT)))?.seq, 1);
    assert.equal(store.read(db => lastScan(db, db.index("project", PROJECT)))?.seq, 1);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-r"))), undefined);

    const resumed = await scanAt(store, repo, 2);
    assert.equal(resumed.state, "scanned");
    assert.equal(resumed.landings, 1);
    const payload = store.read(db => readSignal(db, landingSignalId("run-r")))?.payload;
    assert.ok(payload?.kind === "landing");
    assert.equal(payload.commit, mergeR);
    // The resumed scan read every commit after the ledger's own head, so it names that head as its start.
    assert.equal(store.read(db => lastScan(db, db.index("project", PROJECT)))?.payload.from, firstHead);
  } finally {
    store.close();
    repo.close();
  }
});

test("a scan stops at its command limit", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-r", "r.txt");
    const mergeR = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { mergeCommit: mergeR });

    // A first scan with a landing runs three commands: the list, the commits, and the revert search.
    let calls = 0;
    const counting: ScanGit = (cwd, args) => { calls += 1; return scanGit()(cwd, args); };
    const stopped = await scanOnce({ store, git: counting, mirror: repo.mirror, fetch: fetchOf(repo, 0), holdDays: 30, commandLimit: 2 });
    assert.equal(stopped.state, "failed");
    assert.equal(calls, 2, "the command past the limit is never run");
    assert.equal(store.read(db => readScanState(db, db.index("project", PROJECT))), undefined);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-r"))), undefined);

    const full = await scanOnce({ store, git: counting, mirror: repo.mirror, fetch: fetchOf(repo, 0), holdDays: 30, commandLimit: 3 });
    assert.deepEqual({ state: full.state, landings: full.landings }, { state: "scanned", landings: 1 });
    assert.equal(calls, 5);
  } finally {
    store.close();
    repo.close();
  }
});

test("every scan command is a listed form, run in the mirror", async () => {
  const repo = repos();
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-r", "r.txt");
    const mergeR = mergeBranch(repo.seed, "run-r");
    git(repo.seed, "revert", "--no-edit", "-m", "1", mergeR);
    push(repo.seed);

    // Through the command prefix, every logged Git command runs in the mirror and is one of the forms.
    const store = openStore(repo.root, "state");
    const receipts = join(repo.root, "receipts");
    mkdirSync(receipts);
    const prefix = { command: process.execPath, args: [FIXTURE, "--command-prefix", receipts] };
    try {
      recordRun(store, "run-r", { mergeCommit: mergeR });
      const result = await scanAt(store, repo, 0, scanGit(prefix));
      assert.deepEqual({ state: result.state, landings: result.landings, reverts: result.reverts }, { state: "scanned", landings: 1, reverts: 1 });
    } finally {
      store.close();
    }
    const logged = readFileSync(join(receipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { command: string; args: string[]; cwd: string });
    assert.ok(logged.length >= 3);
    for (const line of logged) {
      assert.equal(line.command, "git");
      assert.equal(line.cwd, realpathSync(repo.mirror));
      assert.deepEqual(line.args.filter((_, index) => index < 12 && index % 2 === 0), ["-c", "-c", "-c", "-c", "-c", "-c"]);
      const rest = line.args.slice(12).join(" ");
      assert.ok(FORMS.some(form => form.test(rest)), `not a listed form: ${rest.slice(0, 120)}`);
    }

    // Through the restricted launcher, the same scan is admitted, and any other mirror command is refused.
    const restrictedStore = openStore(repo.root, "restricted");
    const restrictedReceipts = join(repo.root, "restricted-receipts");
    mkdirSync(restrictedReceipts);
    const restricted = { command: process.execPath, args: [FIXTURE, "--mirror-restricted-prefix", restrictedReceipts] };
    try {
      recordRun(restrictedStore, "run-r", { mergeCommit: mergeR });
      const admitted = await scanAt(restrictedStore, repo, 0, scanGit(restricted));
      assert.deepEqual({ state: admitted.state, landings: admitted.landings, reverts: admitted.reverts }, { state: "scanned", landings: 1, reverts: 1 });
      const refusedFile = join(restrictedReceipts, "mirror-commands.jsonl");
      assert.ok(!existsSync(refusedFile) || readFileSync(refusedFile, "utf8").trim() === "");
      const catFile = await teamCommand({ command: "git", args: ["cat-file", "-t", "HEAD"] }, repo.mirror, undefined, 30_000, restricted);
      assert.equal(catFile.exitCode, 126);
    } finally {
      restrictedStore.close();
    }
  } finally {
    repo.close();
  }
});

test("notices coalesce and never throw", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const gated: ScanGit = async (cwd, args) => {
      await gate;
      return scanGit()(cwd, args);
    };
    let mirrorCalls = 0;
    const scanner = new BaseScanner({
      store,
      mirrorPath: () => { mirrorCalls += 1; return repo.mirror; },
      holdDays: () => 30,
      git: gated,
      log: () => undefined,
    });
    scanner.notify(fetchOf(repo, 0));
    scanner.notify(fetchOf(repo, 1));
    scanner.notify(fetchOf(repo, 2));
    release();
    await scanner.settled(PROJECT);
    assert.equal(mirrorCalls, 2, "one running scan and one coalesced scan");

    scanner.close();
    scanner.notify(fetchOf(repo, 3));
    await scanner.settled(PROJECT);
    assert.equal(mirrorCalls, 2, "a notice after close is dropped");

    const throwing = new BaseScanner({
      store,
      mirrorPath: () => { throw new Error("no mirror"); },
      holdDays: () => 30,
      log: () => undefined,
    });
    assert.doesNotThrow(() => throwing.notify(fetchOf(repo, 0)));
    await throwing.settled(PROJECT);

    const closedStore = openStore(repo.root, "closed");
    closedStore.close();
    const onClosed = new BaseScanner({ store: closedStore, mirrorPath: () => repo.mirror, holdDays: () => 30, log: () => undefined });
    assert.doesNotThrow(() => onClosed.notify(fetchOf(repo, 0)));
    await onClosed.settled(PROJECT);
  } finally {
    store.close();
    repo.close();
  }
});
