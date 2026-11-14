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

/** `lastHeads` holds the head each project's last fetch returned, so the next fetch names it as `previousHead`. */
type Repos = { root: string; mirror: string; seed: string; lastHeads: Map<string, string>; close(): void };

/** A bare mirror and a seed clone that pushes to it. Both live in one temporary directory. */
function repos(): Repos {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-outcome-scan-")));
  const mirror = join(root, "mirror.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", mirror);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "remote", "add", "origin", mirror);
  return { root, mirror, seed, lastHeads: new Map(), close: () => rmSync(root, { recursive: true, force: true }) };
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

type Refs = { mergeCommit?: string; reviewedHead?: string; reviewedTree?: string; currentBase?: string };

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

/** A fetch of the mirror's head. Its `previousHead` is the head that this project's previous fetch returned. */
function fetchOf(repo: Repos, n: number, projectId = PROJECT): MirrorFetch {
  const current = head(repo.mirror);
  const previous = repo.lastHeads.get(projectId);
  repo.lastHeads.set(projectId, current);
  return {
    projectId, repository: REPO, baseBranch: "main", head: current, fetchedAt: day(n),
    ...(previous === undefined ? {} : { previousHead: previous }),
  };
}

/** A Git runner whose every command fails with exit code 1. */
const broken: ScanGit = async () => ({ exitCode: 1, output: "", stdout: "", interrupted: false, truncated: false });

/** Moves the seed's main to `sha` and pushes it to the mirror with force. */
function forceMain(seed: string, sha: string): void {
  git(seed, "reset", "-q", "--hard", sha);
  git(seed, "push", "-q", "--force", "origin", "main");
}

/** One scan of a fetch that the test built, with the unread fetches the test passes. */
function scanFetch(
  store: EvidenceStore,
  repo: Repos,
  fetch: MirrorFetch,
  options: { git?: ScanGit; earlier?: readonly MirrorFetch[]; lost?: boolean } = {},
): Promise<ScanResult> {
  return scanOnce({ store, git: options.git ?? scanGit(), mirror: repo.mirror, fetch, holdDays: 30, earlier: options.earlier, lost: options.lost });
}

function newestScan(store: EvidenceStore) {
  return store.read(db => lastScan(db, db.index("project", PROJECT)));
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
    // The failed fetch is unread by any recorded scan, so the resumed scan is passed it.
    const unread = fetchOf(repo, 1);
    assert.equal((await scanFetch(store, repo, unread, { git: refusingLog })).state, "failed");
    assert.equal(store.read(db => readScanState(db, db.index("project", PROJECT)))?.seq, 1);
    assert.equal(store.read(db => lastScan(db, db.index("project", PROJECT)))?.seq, 1);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-r"))), undefined);

    const resumed = await scanFetch(store, repo, fetchOf(repo, 2), { earlier: [unread] });
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

test("a head that left and came back is a gap", async () => {
  const a = repos();
  const b = repos();
  const storeA = openStore(a.root, "state");
  const storeB = openStore(b.root, "state");
  try {
    for (const repo of [a, b]) {
      commitFile(repo.seed, "base.txt", "base");
      branchCommit(repo.seed, "run-r", "r.txt");
      const merge = mergeBranch(repo.seed, "run-r");
      push(repo.seed);
      recordRun(repo === a ? storeA : storeB, "run-r", { mergeCommit: merge });
    }
    const h1 = head(a.mirror);
    assert.equal((await scanFetch(storeA, a, fetchOf(a, 0))).landings, 1);
    assert.equal((await scanFetch(storeB, b, fetchOf(b, 0))).landings, 1);

    // Repository A: a revert moves the head to H2, its scan fails, and a forced push restores H1.
    commitFile(a.seed, "revert.txt", "revert");
    push(a.seed);
    const day10 = fetchOf(a, 10);
    assert.equal((await scanFetch(storeA, a, day10, { git: broken })).state, "failed");
    forceMain(a.seed, h1);
    const day12 = await scanFetch(storeA, a, fetchOf(a, 12), { earlier: [day10] });
    assert.deepEqual({ state: day12.state, gap: day12.gap }, { state: "scanned", gap: "rewrite" });
    assert.equal((await scanFetch(storeA, a, fetchOf(a, 31))).state, "checked");
    const rowA = outcomeOf(storeA, "run-r");
    assert.equal(rowA?.held, null);
    assert.equal(rowA?.flags.includes("scan-gap"), true);

    // Repository B, the control: no failed scan and no forced push.
    assert.equal((await scanFetch(storeB, b, fetchOf(b, 12))).state, "checked");
    assert.equal((await scanFetch(storeB, b, fetchOf(b, 31))).state, "checked");
    assert.equal(outcomeOf(storeB, "run-r")?.held, 1);
  } finally {
    storeA.close();
    storeB.close();
    a.close();
    b.close();
  }
});

test("a restart with an unread fetch is a gap", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    branchCommit(repo.seed, "run-r", "r.txt");
    const merge = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { mergeCommit: merge });
    const h1 = head(repo.mirror);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 0))).landings, 1);

    commitFile(repo.seed, "revert.txt", "revert");
    push(repo.seed);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 10), { git: broken })).state, "failed");
    forceMain(repo.seed, h1);
    // The scanner restarted, so the day 10 fetch is not passed. Its previousHead is H2, not the stored H1.
    const restarted = await scanFetch(store, repo, fetchOf(repo, 12));
    assert.deepEqual({ state: restarted.state, gap: restarted.gap }, { state: "scanned", gap: "rewrite" });
  } finally {
    store.close();
    repo.close();
  }
});

test("an unread head outside the history is a gap", async () => {
  const repo = repos();
  const control = repos();
  const store = openStore(repo.root, "state");
  const controlStore = openStore(control.root, "state");
  try {
    for (const r of [repo, control]) {
      commitFile(r.seed, "base.txt", "base");
      push(r.seed);
      assert.equal((await scanFetch(r === repo ? store : controlStore, r, fetchOf(r, 0))).state, "scanned");
    }
    const h1 = head(repo.mirror);
    const controlH1 = head(control.mirror);

    // Repository: an unread fetch to X, then a forced push that replaces X with H3, which descends from H1 only.
    const x = commitFile(repo.seed, "x.txt", "x");
    push(repo.seed);
    const unreadX = fetchOf(repo, 1);
    assert.equal((await scanFetch(store, repo, unreadX, { git: broken })).state, "failed");
    git(repo.seed, "reset", "-q", "--hard", h1);
    const h3 = commitFile(repo.seed, "y.txt", "y");
    git(repo.seed, "push", "-q", "--force", "origin", "main");
    assert.notEqual(h3, x);
    const day2 = await scanFetch(store, repo, fetchOf(repo, 2), { earlier: [unreadX] });
    assert.equal(day2.gap, "rewrite");

    // Control: X stays in the history, so H3 descends from X and from H1.
    commitFile(control.seed, "x.txt", "x");
    push(control.seed);
    const controlX = fetchOf(control, 1);
    assert.equal((await scanFetch(controlStore, control, controlX, { git: broken })).state, "failed");
    commitFile(control.seed, "y.txt", "y");
    push(control.seed);
    const controlDay2 = await scanFetch(controlStore, control, fetchOf(control, 2), { earlier: [controlX] });
    assert.deepEqual({ state: controlDay2.state, gap: controlDay2.gap }, { state: "scanned", gap: null });
    assert.equal(newestScan(controlStore)?.payload.from, controlH1);
  } finally {
    store.close();
    controlStore.close();
    repo.close();
    control.close();
  }
});

test("the scanner remembers the fetches no scan recorded", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    const h1 = head(repo.mirror);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 0))).state, "scanned");

    // The first scan the scanner runs fails. Its day 10 fetch is remembered.
    let failing = true;
    const flaky: ScanGit = (cwd, args) => (failing ? broken(cwd, args) : scanGit()(cwd, args));
    const scanner = new BaseScanner({ store, mirrorPath: () => repo.mirror, holdDays: () => 30, git: flaky, log: () => undefined });
    commitFile(repo.seed, "revert.txt", "revert");
    push(repo.seed);
    scanner.notify(fetchOf(repo, 10));
    await scanner.settled(PROJECT);
    failing = false;
    forceMain(repo.seed, h1);
    scanner.notify(fetchOf(repo, 12));
    await scanner.settled(PROJECT);
    assert.equal(newestScan(store)?.gap, "rewrite");
    assert.equal(newestScan(store)?.seq, 2);

    // The head leaves and comes back, and then eight more scans fail at the old head. The two fetches that saw the
    // move are dropped past the limit, and every fetch that is left names the stored head. Only the lost mark
    // still says that the history between is unknown.
    const fresh = repos();
    const freshStore = openStore(fresh.root, "state");
    try {
      commitFile(fresh.seed, "base.txt", "base");
      push(fresh.seed);
      const h0 = head(fresh.mirror);
      assert.equal((await scanFetch(freshStore, fresh, fetchOf(fresh, 0))).state, "scanned");
      let broke = true;
      const gate: ScanGit = (cwd, args) => (broke ? broken(cwd, args) : scanGit()(cwd, args));
      const remembering = new BaseScanner({ store: freshStore, mirrorPath: () => fresh.mirror, holdDays: () => 30, git: gate, log: () => undefined });
      commitFile(fresh.seed, "revert.txt", "revert");
      push(fresh.seed);
      remembering.notify(fetchOf(fresh, 1));
      await remembering.settled(PROJECT);
      forceMain(fresh.seed, h0);
      // A fetch at the stored head is a commit scan here, because an unread head differs. It fails like the others.
      for (let index = 2; index <= 10; index += 1) {
        remembering.notify(fetchOf(fresh, index));
        await remembering.settled(PROJECT);
      }
      assert.equal(newestScan(freshStore)?.seq, 1, "no scan was recorded while Git failed");
      broke = false;
      remembering.notify(fetchOf(fresh, 11));
      await remembering.settled(PROJECT);
      assert.deepEqual([newestScan(freshStore)?.seq, newestScan(freshStore)?.gap], [2, "rewrite"]);
      // After the recorded scan the list is empty again: the next fetch at the same head is a check.
      remembering.notify(fetchOf(fresh, 12));
      await remembering.settled(PROJECT);
      assert.deepEqual([newestScan(freshStore)?.seq, newestScan(freshStore)?.checkedAt], [2, day(12)]);
      remembering.close();
    } finally {
      freshStore.close();
      fresh.close();
    }
    scanner.close();
  } finally {
    store.close();
    repo.close();
  }
});

test("fetches that all name the stored head are a check unless one was lost", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 0))).state, "scanned");
    const unread = [fetchOf(repo, 1), fetchOf(repo, 2)];

    // A dropped fetch may have held another head, so the same chain is a gap when one was lost.
    const lost = await scanFetch(store, repo, fetchOf(repo, 3), { earlier: unread, lost: true });
    assert.deepEqual({ state: lost.state, gap: lost.gap }, { state: "scanned", gap: "rewrite" });
    const kept = await scanFetch(store, repo, fetchOf(repo, 4), { earlier: [] });
    assert.equal(kept.state, "checked");

    // A chain in the wrong order does not continue the stored head.
    const first = fetchOf(repo, 5);
    commitFile(repo.seed, "next.txt", "next");
    push(repo.seed);
    const second = fetchOf(repo, 6);
    const third = fetchOf(repo, 7);
    const swapped = await scanFetch(store, repo, third, { earlier: [second, first] });
    assert.equal(swapped.gap, "rewrite");

    // A fetch that names no previous head cannot continue a stored head.
    const { previousHead: _none, ...unnamed } = fetchOf(repo, 8);
    const noPrevious = await scanFetch(store, repo, unnamed);
    assert.deepEqual({ state: noPrevious.state, gap: noPrevious.gap }, { state: "scanned", gap: "rewrite" });
  } finally {
    store.close();
    repo.close();
  }
});

test("a notice replaced during a scan stays unread", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 0))).state, "scanned");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const gated: ScanGit = async (cwd, args) => {
      await gate;
      return scanGit()(cwd, args);
    };
    const scanner = new BaseScanner({ store, mirrorPath: () => repo.mirror, holdDays: () => 30, git: gated, log: () => undefined });

    // Scan A reads a new commit and waits at its first Git command.
    commitFile(repo.seed, "a.txt", "a");
    push(repo.seed);
    const headA = head(repo.mirror);
    scanner.notify(fetchOf(repo, 1));
    // While it waits: the head moves to a revert, a forced push restores it, and one more fetch sees no move.
    commitFile(repo.seed, "revert.txt", "revert");
    push(repo.seed);
    scanner.notify(fetchOf(repo, 2));
    forceMain(repo.seed, headA);
    scanner.notify(fetchOf(repo, 3));
    scanner.notify(fetchOf(repo, 4));
    release();
    await scanner.settled(PROJECT);

    // Scan A is recorded, and the two replaced notices are still unread: the last scan cannot be a check.
    const newest = newestScan(store);
    assert.deepEqual([newest?.seq, newest?.gap, newest?.at], [3, "rewrite", day(4)]);
    const scans = store.read(db => db.all<{ seq: number; gap: string | null }>("SELECT seq, gap FROM base_scans ORDER BY seq"));
    assert.deepEqual(scans.map(scan => [scan.seq, scan.gap]), [[1, "first"], [2, null], [3, "rewrite"]]);
    scanner.close();
  } finally {
    store.close();
    repo.close();
  }
});

test("older history lands a tree only on the reviewed head", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    const c1 = commitFile(repo.seed, "a.txt", "one");
    const c2 = commitFile(repo.seed, "b.txt", "two");
    push(repo.seed);
    const treeOf = (commit: string) => git(repo.seed, "rev-parse", `${commit}^{tree}`);
    // R restores C1's tree but its base is C2, which is later than C1: no landing.
    recordRun(store, "run-r", { reviewedTree: treeOf(c1), currentBase: c2 });
    // S reviewed C2 itself, with its base C1: it lands on C2.
    recordRun(store, "run-s", { reviewedHead: c2, reviewedTree: treeOf(c2), currentBase: c1 });
    // U has C1's tree too, and a base that is not among the scanned commits: a scan of older history cannot place it.
    recordRun(store, "run-u", { reviewedTree: treeOf(c1), currentBase: "9".repeat(40) });

    const result = await scanFetch(store, repo, fetchOf(repo, 0));
    assert.equal(result.state, "scanned");
    assert.equal(result.gap, "first");
    assert.equal(result.landings, 1);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-r"))), undefined);
    assert.equal(store.read(db => readSignal(db, landingSignalId("run-u"))), undefined);
    const landed = store.read(db => readSignal(db, landingSignalId("run-s")))?.payload;
    assert.ok(landed?.kind === "landing");
    assert.deepEqual([landed.method, landed.commit], ["tree-equal", c2]);

    // A new commit with C1's tree arrives after the ledger's head. A scan of new commits only lands both runs on it.
    git(repo.seed, "revert", "--no-edit", c2);
    push(repo.seed);
    const c3 = head(repo.mirror);
    assert.equal(treeOf(c3), treeOf(c1));
    const next = await scanFetch(store, repo, fetchOf(repo, 1));
    assert.deepEqual({ state: next.state, gap: next.gap, landings: next.landings }, { state: "scanned", gap: null, landings: 2 });
    for (const runId of ["run-r", "run-u"]) {
      const payload = store.read(db => readSignal(db, landingSignalId(runId)))?.payload;
      assert.ok(payload?.kind === "landing", runId);
      assert.deepEqual([payload.method, payload.commit], ["tree-equal", c3], runId);
    }
  } finally {
    store.close();
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
