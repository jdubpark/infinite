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
import { teamCommand, teamGitArgs } from "../packages/host/src/team-workspace.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/team-agent.mjs", import.meta.url));
const PROJECT = "example";
const REPO = "example-repo";
const DAY_MS = 86_400_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONFIG = ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const ID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const FORMS = [
  new RegExp(`^merge-base --is-ancestor ${ID} ${ID}$`),
  new RegExp(`^rev-list --first-parent --max-count=501 ${ID} \\^${ID}$`),
  new RegExp(`^rev-list --first-parent --max-count=500 ${ID}$`),
  new RegExp(`^log --no-walk=unsorted --no-show-signature --format=%H %T %P(?: ${ID}){1,50}$`),
  new RegExp(`^log --no-walk=unsorted --no-show-signature --format=%H --fixed-strings(?: --grep=This reverts commit ${ID}){1,50}(?: ${ID}){1,50}$`),
];

const day = (n: number) => new Date(Date.parse("2026-11-13T00:00:00.000Z") + n * DAY_MS).toISOString();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...CONFIG, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

type Repos = { root: string; mirror: string; seed: string; lastHeads: Map<string, { head: string; since: string }>; close(): void };

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
  const current = head(repo.mirror);
  const previous = repo.lastHeads.get(projectId);
  if (previous === undefined || previous.head !== current) repo.lastHeads.set(projectId, { head: current, since: day(n) });
  return {
    projectId, repository: REPO, baseBranch: "main", head: current, fetchedAt: day(n),
    ...(previous === undefined ? {} : { previousHead: previous.head, previousSince: previous.since }),
  };
}

const broken: ScanGit = async () => ({ exitCode: 1, output: "", stdout: "", interrupted: false, truncated: false });

function forceMain(seed: string, sha: string): void {
  git(seed, "reset", "-q", "--hard", sha);
  git(seed, "push", "-q", "--force", "origin", "main");
}

function scanFetch(
  store: EvidenceStore,
  repo: Repos,
  fetch: MirrorFetch,
  options: { git?: ScanGit; earlier?: readonly MirrorFetch[] } = {},
): Promise<ScanResult> {
  return scanOnce({ store, git: options.git ?? scanGit(), mirror: repo.mirror, fetch, holdDays: 30, earlier: options.earlier });
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

    assert.equal((await scanAt(store, repo, 0)).landings, 2);
    git(repo.seed, "revert", "--no-edit", "-m", "1", mergeE);
    push(repo.seed);
    assert.equal((await scanAt(store, repo, 10)).reverts, 1);
    assert.equal(outcomeOf(store, "run-e")?.held, 0);
    assert.equal(outcomeOf(store, "run-f")?.held, null);

    assert.equal((await scanAt(store, repo, 31)).state, "checked");
    assert.equal(outcomeOf(store, "run-f")?.held, 1);

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

    const refusingLog: ScanGit = (cwd, args) => args[0] === "log"
      ? Promise.resolve({ exitCode: 1, output: "", stdout: "", interrupted: false, truncated: false })
      : scanGit()(cwd, args);
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
    push(repo.seed);
    const first = fetchOf(repo, 0);
    git(repo.seed, "revert", "--no-edit", "-m", "1", mergeR);
    push(repo.seed);
    const second = fetchOf(repo, 1);
    const scanBoth = async (store: EvidenceStore, runner: ScanGit) => {
      recordRun(store, "run-r", { mergeCommit: mergeR });
      const landed = await scanFetch(store, repo, first, { git: runner });
      assert.deepEqual({ state: landed.state, gap: landed.gap, landings: landed.landings }, { state: "scanned", gap: "first", landings: 1 });
      const reverted = await scanFetch(store, repo, second, { git: runner });
      assert.deepEqual({ state: reverted.state, gap: reverted.gap, reverts: reverted.reverts }, { state: "scanned", gap: null, reverts: 1 });
      assert.equal(outcomeOf(store, "run-r")?.held, 0);
    };

    const store = openStore(repo.root, "state");
    const receipts = join(repo.root, "receipts");
    mkdirSync(receipts);
    const prefix = { command: process.execPath, args: [FIXTURE, "--command-prefix", receipts] };
    try {
      await scanBoth(store, scanGit(prefix));
    } finally {
      store.close();
    }
    const logged = readFileSync(join(receipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { command: string; args: string[]; cwd: string });
    const used = new Set<number>();
    for (const line of logged) {
      assert.equal(line.command, "git");
      assert.equal(line.cwd, realpathSync(repo.mirror));
      assert.deepEqual(line.args.filter((_, index) => index < 12 && index % 2 === 0), ["-c", "-c", "-c", "-c", "-c", "-c"]);
      const rest = line.args.slice(12).join(" ");
      const form = FORMS.findIndex(candidate => candidate.test(rest));
      assert.notEqual(form, -1, `not a listed form: ${rest.slice(0, 120)}`);
      used.add(form);
    }
    assert.deepEqual([...used].sort(), [0, 1, 2, 3, 4], "the two scans use all five forms");

    const restrictedStore = openStore(repo.root, "restricted");
    const restrictedReceipts = join(repo.root, "restricted-receipts");
    mkdirSync(restrictedReceipts);
    const restricted = { command: process.execPath, args: [FIXTURE, "--mirror-restricted-prefix", restrictedReceipts] };
    try {
      await scanBoth(restrictedStore, scanGit(restricted));
      const refusedFile = join(restrictedReceipts, "mirror-commands.jsonl");
      assert.ok(!existsSync(refusedFile) || readFileSync(refusedFile, "utf8").trim() === "");
      const catFile = await teamCommand({ command: "git", args: ["cat-file", "-t", "HEAD"] }, repo.mirror, undefined, 30_000, restricted);
      assert.equal(catFile.exitCode, 126);
      const form3 = ["rev-list", "--first-parent", "--max-count=500", second.head];
      const extra = await teamCommand({ command: "git", args: [...teamGitArgs(repo.mirror, []), "-c", "core.pager=cat", ...form3] }, repo.mirror, undefined, 30_000, restricted);
      assert.equal(extra.exitCode, 126);
      const bare = await teamCommand({ command: "git", args: form3 }, repo.mirror, undefined, 30_000, restricted);
      assert.equal(bare.exitCode, 126);
      const altered = teamGitArgs(repo.mirror, form3).map(arg => (arg === "core.hooksPath=/dev/null" ? "core.hooksPath=/elsewhere" : arg));
      assert.equal((await teamCommand({ command: "git", args: altered }, repo.mirror, undefined, 30_000, restricted)).exitCode, 126);
      const exact = await teamCommand({ command: "git", args: teamGitArgs(repo.mirror, form3) }, repo.mirror, undefined, 30_000, restricted);
      assert.equal(exact.exitCode, 0);
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
    const restarted = await scanFetch(store, repo, fetchOf(repo, 12));
    assert.deepEqual({ state: restarted.state, gap: restarted.gap }, { state: "scanned", gap: "rewrite" });
  } finally {
    store.close();
    repo.close();
  }
});

test("a restart after the head left and came back is a gap", async () => {
  const repo = repos();
  const control = repos();
  const store = openStore(repo.root, "state");
  const controlStore = openStore(control.root, "state");
  try {
    for (const r of [repo, control]) {
      commitFile(r.seed, "base.txt", "base");
      branchCommit(r.seed, "run-r", "r.txt");
      const merge = mergeBranch(r.seed, "run-r");
      push(r.seed);
      recordRun(r === repo ? store : controlStore, "run-r", { mergeCommit: merge });
      assert.equal((await scanFetch(r === repo ? store : controlStore, r, fetchOf(r, 0))).landings, 1);
    }
    const h1 = head(repo.mirror);

    commitFile(repo.seed, "revert.txt", "revert");
    push(repo.seed);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 10), { git: broken })).state, "failed");
    forceMain(repo.seed, h1);
    const day11 = fetchOf(repo, 11);
    assert.equal((await scanFetch(store, repo, day11, { git: broken, earlier: [] })).state, "failed");

    const day12 = fetchOf(repo, 12);
    assert.deepEqual([day12.previousHead, day12.previousSince], [h1, day(11)]);
    const restarted = await scanFetch(store, repo, day12);
    assert.deepEqual({ state: restarted.state, gap: restarted.gap }, { state: "scanned", gap: "rewrite" });
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 31))).state, "checked");
    const row = outcomeOf(store, "run-r");
    assert.equal(row?.held, null);
    assert.equal(row?.flags.includes("scan-gap"), true);

    fetchOf(control, 10);
    fetchOf(control, 11);
    const quiet = fetchOf(control, 12);
    assert.deepEqual([quiet.previousHead, quiet.previousSince], [head(control.mirror), day(0)]);
    assert.equal((await scanFetch(controlStore, control, quiet)).state, "checked");
    assert.equal((await scanFetch(controlStore, control, fetchOf(control, 31))).state, "checked");
    assert.equal(outcomeOf(controlStore, "run-r")?.held, 1);
  } finally {
    store.close();
    controlStore.close();
    repo.close();
    control.close();
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

    const side = repos();
    const sideStore = openStore(side.root, "state");
    try {
      commitFile(side.seed, "base.txt", "base");
      push(side.seed);
      assert.equal((await scanFetch(sideStore, side, fetchOf(side, 0))).state, "scanned");
      const sideH1 = head(side.mirror);
      const sideX = commitFile(side.seed, "x.txt", "x");
      push(side.seed);
      const unreadSide = fetchOf(side, 1);
      assert.equal((await scanFetch(sideStore, side, unreadSide, { git: broken })).state, "failed");
      git(side.seed, "reset", "-q", "--hard", sideH1);
      const z = commitFile(side.seed, "z.txt", "z");
      git(side.seed, "merge", "-q", "--no-ff", "-m", "Merge the old head", sideX);
      push(side.seed);
      const merged = head(side.mirror);
      assert.deepEqual(git(side.mirror, "rev-list", "--first-parent", merged, `^${sideH1}`).split("\n"), [merged, z]);
      git(side.mirror, "merge-base", "--is-ancestor", sideX, merged);
      const sideDay2 = await scanFetch(sideStore, side, fetchOf(side, 2), { earlier: [unreadSide] });
      assert.deepEqual({ state: sideDay2.state, gap: sideDay2.gap }, { state: "scanned", gap: "rewrite" });
      assert.equal("from" in (newestScan(sideStore)?.payload ?? {}), false);
    } finally {
      sideStore.close();
      side.close();
    }

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
      for (let index = 2; index <= 10; index += 1) {
        remembering.notify(fetchOf(fresh, index));
        await remembering.settled(PROJECT);
      }
      assert.equal(newestScan(freshStore)?.seq, 1, "no scan was recorded while Git failed");
      broke = false;
      remembering.notify(fetchOf(fresh, 11));
      await remembering.settled(PROJECT);
      assert.deepEqual([newestScan(freshStore)?.seq, newestScan(freshStore)?.gap], [2, "rewrite"]);
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

test("fetches that all name the stored head are a check unless the head moved between", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 0))).state, "scanned");
    const unread = [fetchOf(repo, 1), fetchOf(repo, 2)];

    const moved = await scanFetch(store, repo, fetchOf(repo, 3), { earlier: [{ ...unread[0]!, previousSince: day(1) }, unread[1]!] });
    assert.deepEqual({ state: moved.state, gap: moved.gap }, { state: "scanned", gap: "rewrite" });
    const kept = await scanFetch(store, repo, fetchOf(repo, 6), { earlier: [fetchOf(repo, 4), fetchOf(repo, 5)] });
    assert.equal(kept.state, "checked");
    assert.equal(newestScan(store)?.checkedAt, day(6));

    const before = fetchOf(repo, 6.25);
    const after = { ...fetchOf(repo, 6.5), previousSince: day(6.5) };
    const missing = await scanFetch(store, repo, fetchOf(repo, 6.75), { earlier: [before, after] });
    assert.deepEqual({ state: missing.state, gap: missing.gap }, { state: "scanned", gap: "rewrite" });

    const first = fetchOf(repo, 7);
    commitFile(repo.seed, "next.txt", "next");
    push(repo.seed);
    const second = fetchOf(repo, 8);
    const third = fetchOf(repo, 9);
    const swapped = await scanFetch(store, repo, third, { earlier: [second, first] });
    assert.equal(swapped.gap, "rewrite");

    const { previousHead: _head, ...headless } = fetchOf(repo, 10);
    const noPrevious = await scanFetch(store, repo, headless);
    assert.deepEqual({ state: noPrevious.state, gap: noPrevious.gap }, { state: "scanned", gap: "rewrite" });
    const { previousSince: _since, ...sinceless } = fetchOf(repo, 11);
    const noSince = await scanFetch(store, repo, sinceless);
    assert.deepEqual({ state: noSince.state, gap: noSince.gap }, { state: "scanned", gap: "rewrite" });
    assert.equal((await scanFetch(store, repo, fetchOf(repo, 12))).state, "checked");
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

    commitFile(repo.seed, "a.txt", "a");
    push(repo.seed);
    const headA = head(repo.mirror);
    scanner.notify(fetchOf(repo, 1));
    commitFile(repo.seed, "revert.txt", "revert");
    push(repo.seed);
    scanner.notify(fetchOf(repo, 2));
    forceMain(repo.seed, headA);
    scanner.notify(fetchOf(repo, 3));
    scanner.notify(fetchOf(repo, 4));
    release();
    await scanner.settled(PROJECT);

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

test("a notice that arrives as a scan ends is scanned", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    const first = fetchOf(repo, 0);
    const second = fetchOf(repo, 1);

    let failing = true;
    const flaky: ScanGit = (cwd, args) => (failing ? broken(cwd, args) : scanGit()(cwd, args));
    const scanner: BaseScanner = new BaseScanner({
      store, mirrorPath: () => repo.mirror, holdDays: () => 30, git: flaky,
      log: () => { failing = false; queueMicrotask(() => scanner.notify(second)); },
    });
    scanner.notify(first);
    await scanner.settled(PROJECT);
    assert.deepEqual([newestScan(store)?.seq, newestScan(store)?.at], [1, day(1)], "the late notice ran without a further notice");
    scanner.close();
  } finally {
    store.close();
    repo.close();
  }
});

test("a fetch whose head is not a commit id is ignored", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    push(repo.seed);
    const scanner = new BaseScanner({ store, mirrorPath: () => repo.mirror, holdDays: () => 30, log: () => undefined });
    scanner.notify(fetchOf(repo, 0));
    await scanner.settled(PROJECT);
    assert.equal(newestScan(store)?.seq, 1);

    scanner.notify({ ...fetchOf(repo, 1), head: "refs/heads/main" });
    await scanner.settled(PROJECT);
    scanner.notify(fetchOf(repo, 2));
    await scanner.settled(PROJECT);
    assert.deepEqual([newestScan(store)?.seq, newestScan(store)?.gap, newestScan(store)?.checkedAt], [1, "first", day(2)]);
    scanner.close();
  } finally {
    store.close();
    repo.close();
  }
});

test("a rescan of older history counts no revert from before the landing", async () => {
  const repo = repos();
  const store = openStore(repo.root, "state");
  try {
    commitFile(repo.seed, "base.txt", "base");
    const tip = branchCommit(repo.seed, "run-r", "r.txt");
    git(repo.seed, "commit", "-q", "--allow-empty", "-m", `Undo an earlier try\n\nThis reverts commit ${tip}.`);
    const merge = mergeBranch(repo.seed, "run-r");
    push(repo.seed);
    recordRun(store, "run-r", { reviewedHead: tip });
    const landed = await scanFetch(store, repo, fetchOf(repo, 0));
    assert.deepEqual({ landings: landed.landings, reverts: landed.reverts }, { landings: 1, reverts: 0 });
    const reverts = () => store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcome_signals WHERE kind='revert'"))?.n;

    commitFile(repo.seed, "next.txt", "next");
    push(repo.seed);
    const { previousSince: _first, ...unproven } = fetchOf(repo, 1);
    const reread = await scanFetch(store, repo, unproven);
    assert.deepEqual({ state: reread.state, gap: reread.gap, reverts: reread.reverts }, { state: "scanned", gap: "rewrite", reverts: 0 });
    assert.equal(reverts(), 0);
    assert.equal(outcomeOf(store, "run-r")?.held, null);

    git(repo.seed, "revert", "--no-edit", "-m", "1", merge);
    push(repo.seed);
    const { previousSince: _second, ...again } = fetchOf(repo, 2);
    const found = await scanFetch(store, repo, again);
    assert.deepEqual({ gap: found.gap, reverts: found.reverts }, { gap: "rewrite", reverts: 1 });
    assert.equal(reverts(), 1);
    assert.equal(outcomeOf(store, "run-r")?.held, 0);
  } finally {
    store.close();
    repo.close();
  }
});

test("commits pushed back after a rewind are no reverts of an earlier landing", async () => {
  for (const pushed of ["all", "part"] as const) {
    const repo = repos();
    const store = openStore(repo.root, "state");
    try {
      const a0 = commitFile(repo.seed, "base.txt", "base");
      const tip = branchCommit(repo.seed, "run-r", "r.txt");
      git(repo.seed, "commit", "-q", "--allow-empty", "-m", `Undo an earlier try\n\nThis reverts commit ${tip}.`);
      const x = head(repo.seed, "HEAD");
      const merge = mergeBranch(repo.seed, "run-r");
      push(repo.seed);
      recordRun(store, "run-r", { reviewedHead: tip });
      assert.deepEqual((await scanFetch(store, repo, fetchOf(repo, 0))).landings, 1);

      forceMain(repo.seed, a0);
      const rewound = await scanFetch(store, repo, fetchOf(repo, 1));
      assert.deepEqual({ gap: rewound.gap, reverts: rewound.reverts }, { gap: "rewrite", reverts: 0 });

      git(repo.seed, "reset", "-q", "--hard", pushed === "all" ? merge : x);
      push(repo.seed);
      const back = await scanFetch(store, repo, fetchOf(repo, 2));
      assert.deepEqual({ state: back.state, gap: back.gap, reverts: back.reverts }, { state: "scanned", gap: null, reverts: 0 }, pushed);
      assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcome_signals WHERE kind='revert'"))?.n, 0, pushed);

      assert.equal((await scanFetch(store, repo, fetchOf(repo, 31))).state, "checked");
      const row = outcomeOf(store, "run-r");
      assert.deepEqual([row?.held, row?.flags.includes("scan-gap")], [null, true], pushed);
    } finally {
      store.close();
      repo.close();
    }
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
    recordRun(store, "run-r", { reviewedTree: treeOf(c1), currentBase: c2 });
    recordRun(store, "run-s", { reviewedHead: c2, reviewedTree: treeOf(c2), currentBase: c1 });
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
