import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "../packages/host/src/evidence/types.js";
import { mineGit, type MineGit } from "../packages/host/src/eval-mine-git.js";
import {
  EXISTING_COMMIT_SQL,
  HOST_BYTES_SQL,
  LANDING_JOIN_SQL,
  MINED_COUNT_SQL,
  MINED_TASK_MAX,
  MINING_BACKFILL_MAX,
  MINING_BATCH,
  MINING_ROW_SQL,
  MINING_RETRY_MS,
  Miner,
  type MinerOptions,
  type MiningCursor,
  PROJECT_BYTES_SQL,
  insertMined,
  minedTaskId,
} from "../packages/host/src/eval-miner.js";
import { HOST_MATERIAL_MAX_BYTES, evalCorpusModule, readEvalTask, readMaterial } from "../packages/host/src/eval-store.js";
import type { Capsule, EvalFeatures } from "../packages/host/src/eval-types.js";
import type { TeamCommand, TeamRun } from "../packages/host/src/team-types.js";

const PROJECT = "project-a";
const NOW = "2026-11-16T12:00:00.000Z";
const TIME0 = 1_700_000_000;
const TESTS = { prefixes: ["tests"], suffixes: [".test.ts"] };
const PROJECT_CONFIG = { id: PROJECT, source: { mode: "github" }, team: { eval: { mine: true, testPaths: TESTS } } };
const FEATURES: EvalFeatures = { role: "implementer", area: "host", kind: null, risk: "normal", featureVersion: 1 };
const CAPSULE: Capsule = { objective: "Ship", steering: [], ownerAnswers: [], task: { id: "mined", title: "Ship", instructions: "", paths: ["src"] } };

type Commit = { files: Record<string, string>; message?: string };
type Rig = { dir: string; store: EvidenceStore; cleanup(): void };

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "infinite-eval-miner-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function importCommits(mirror: string, ref: string, commits: Commit[], from?: string): string[] {
  const out: string[] = [];
  commits.forEach((commit, index) => {
    const message = commit.message ?? `commit ${index}`;
    out.push(`commit ${ref}\nmark :${index + 1}\ncommitter Placeholder Author <placeholder@example.invalid> ${TIME0 + index * 60} +0000\n`);
    out.push(`data ${Buffer.byteLength(message)}\n${message}\n`);
    if (index === 0 && from !== undefined) out.push(`from ${from}\n`);
    else if (index > 0) out.push(`from :${index}\n`);
    for (const [path, content] of Object.entries(commit.files)) {
      out.push(`M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}\n`);
    }
  });
  const result = spawnSync("git", ["fast-import", "--quiet"], { cwd: mirror, input: out.join(""), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fast-import failed: ${result.stderr}`);
  const branch = git(mirror, ["rev-list", "--reverse", "--first-parent", ref]).split("\n");
  return branch.slice(branch.length - commits.length);
}

function mirrorWith(dir: string, commits: Commit[]): { mirror: string; ids: string[] } {
  const mirror = join(dir, "mirror.git");
  mkdirSync(mirror);
  git(mirror, ["init", "-q", "--bare", "--template="]);
  return { mirror, ids: importCommits(mirror, "refs/heads/main", commits) };
}

function change(index: number, withTest: boolean, message?: string): Commit {
  const files: Record<string, string> = { [`src/c${index}.ts`]: `export const c${index} = ${index};\n` };
  if (withTest) files[`tests/c${index}.test.ts`] = `test("c${index}", () => {});\n`;
  return message === undefined ? { files } : { files, message };
}

type HeadBox = { value: string };

function minerFor(
  r: Rig,
  options: { mirror: string; head: HeadBox; git?: MineGit; store?: EvidenceStore; now?: () => string; runs?: () => TeamRun[] },
): Miner {
  const sourceStub = {
    mirrorPath: () => options.mirror,
    status: () => ({ mirrorHead: options.head.value }),
  };
  return new Miner({
    config: { projects: [PROJECT_CONFIG] } as unknown as MinerOptions["config"],
    store: options.store ?? r.store,
    source: sourceStub as unknown as MinerOptions["source"],
    git: options.git ?? mineGit(() => undefined),
    runs: options.runs ?? (() => []),
    now: options.now ?? (() => NOW),
  });
}

function countingGit(inner: MineGit = mineGit(() => undefined)): { git: MineGit; calls: string[] } {
  const calls: string[] = [];
  const git: MineGit = {
    isAncestor: (mirror, older, newer) => { calls.push("isAncestor"); return inner.isAncestor(mirror, older, newer); },
    firstParents: (mirror, head, exclude) => { calls.push("firstParents"); return inner.firstParents(mirror, head, exclude); },
    parents: (mirror, ids) => { calls.push("parents"); return inner.parents(mirror, ids); },
    present: (mirror, id) => { calls.push("present"); return inner.present(mirror, id); },
    numstat: (mirror, parent, commit) => { calls.push("numstat"); return inner.numstat(mirror, parent, commit); },
    message: (mirror, commit) => { calls.push("message"); return inner.message(mirror, commit); },
  };
  return { git, calls };
}

function scriptedPrefix(dir: string, name: string, rules: { pattern: string; code: number }[]): TeamCommand {
  const script = join(dir, `${name}.sh`);
  const cases = rules.map(rule => `  *${rule.pattern}*) exit ${rule.code};;`).join("\n");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, "calls.txt")}"\ncase "$*" in\n${cases}\nesac\nshift\nexec git "$@"\n`);
  return { command: "/bin/sh", args: [script] };
}

function callLines(dir: string): number {
  try {
    return readFileSync(join(dir, "calls.txt"), "utf8").split("\n").filter(line => line !== "").length;
  } catch {
    return 0;
  }
}

function cursorOf(store: EvidenceStore): MiningCursor | undefined {
  return store.read(db => {
    const ref = db.index("project", PROJECT);
    const row = db.get<{ payload: string }>("SELECT payload FROM eval_mining WHERE project_ref = ?", ref);
    return row === undefined ? undefined : db.open<MiningCursor>("eval_mining", ref, row.payload);
  });
}

type MiningRowView = { state: string; visited: number; mined: number; skipped: number; failures: number; retry_at: string | null };

function miningRow(store: EvidenceStore): MiningRowView | undefined {
  return store.read(db => db.get<MiningRowView>(
    "SELECT state, visited, mined, skipped, failures, retry_at FROM eval_mining WHERE project_ref = ?",
    db.index("project", PROJECT),
  ));
}

function minedOf(store: EvidenceStore, commit: string): { state: string; reason: string | null } | undefined {
  return store.read(db => db.get<{ state: string; reason: string | null }>(
    "SELECT state, reason FROM eval_tasks WHERE project_ref = ? AND commit_ref = ?",
    db.index("project", PROJECT),
    db.index("eval-commit", commit),
  ));
}

function minedCount(store: EvidenceStore): number {
  return store.read(db => db.get<{ n: number }>(MINED_COUNT_SQL, db.index("project", PROJECT))?.n ?? 0);
}

function failingWrite(store: EvidenceStore, failAt: number): EvidenceStore {
  let calls = 0;
  const wrapped = {
    status: () => store.status(),
    read: <T>(fn: (db: EvidenceDb) => T) => store.read(fn),
    write: <T>(fn: (tx: EvidenceTx) => T) => store.write(fn),
    tryWrite: (fn: (tx: EvidenceTx) => void) => {
      calls += 1;
      if (calls === failAt) return false;
      return store.tryWrite(fn);
    },
  };
  return wrapped as unknown as EvidenceStore;
}

function fillMined(store: EvidenceStore, count: number): void {
  store.write(tx => {
    const ref = tx.index("project", PROJECT);
    for (let index = 0; index < count; index++) {
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id, commit_ref, paths_indexed) "
        + "VALUES (?, 'mined', '', '', ?, 'candidate', 'none', 'proven', ?, ?, 'x', ?, ?, 1)",
        `filler:${index}`,
        ref,
        NOW,
        NOW,
        `filler:${index}`,
        tx.index("eval-commit", String(index).padStart(40, "0")),
      );
    }
  });
}

test("a history is mined newest first, new commits oldest first, within its bounds", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: 60 }, (_, index) =>
      change(index, index !== 0 && !(index % 3 === 2 && index <= 56)));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[ids.length - 1] };
    const counted = countingGit();
    const miner = minerFor(r, { mirror, head, git: counted.git });

    miner.pump();
    await miner.idle();
    assert.equal(miner.status(PROJECT).visited, 50, "the first pass decides 50 commits");
    assert.equal(miner.status(PROJECT).backfillDone, false);
    const firstPassParents = counted.calls.filter(call => call === "parents").length;
    assert.ok(firstPassParents <= 2, `at most one parents read per list chunk, saw ${firstPassParents}`);
    counted.calls.length = 0;

    miner.pump();
    await miner.idle();
    const status = miner.status(PROJECT);
    assert.deepEqual([status.visited, status.mined, status.skipped, status.backfillDone], [60, 40, 20, true]);
    assert.equal(minedCount(r.store), 40, "one row per mined commit");
    assert.equal(minedOf(r.store, ids[59])?.state, "candidate", "the newest commit is mined first and is a candidate");
    assert.equal(minedOf(r.store, ids[0]), undefined, "the root commit leaves no row");

    const added = importCommits(mirror, "refs/heads/main", Array.from({ length: 60 }, (_, index) => change(60 + index, true)), head.value);
    head.value = added[added.length - 1];
    miner.pump();
    await miner.idle();
    miner.pump();
    await miner.idle();
    assert.equal(minedCount(r.store), 100, "every new commit has a row");
  } finally {
    r.cleanup();
  }
});

test("the backfill stops at 2,000 first-parent commits, and later heads are still mined", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: MINING_BACKFILL_MAX + 100 }, (_, index) => change(index, false));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[ids.length - 1] };
    const read = new Set<string>();
    const inner = mineGit(() => undefined);
    const git: MineGit = { ...inner, parents: (dir, list) => { list.forEach(id => read.add(id)); return inner.parents(dir, list); } };
    const miner = minerFor(r, { mirror, head, git });
    miner.pump();
    await miner.idle();
    [head.value] = importCommits(mirror, "refs/heads/main", [change(MINING_BACKFILL_MAX + 100, true)], head.value);
    for (let pass = 1; pass < MINING_BACKFILL_MAX / MINING_BATCH + 1; pass++) {
      miner.pump();
      await miner.idle();
    }
    const status = miner.status(PROJECT);
    assert.equal(status.visited, MINING_BACKFILL_MAX + 1, "the new commit and 2,000 backfill commits");
    assert.equal(status.backfillDone, false);
    assert.equal(status.state, "caught-up");
    assert.equal(minedCount(r.store), 1, "only the new commit changes a test file");
    assert.ok(read.has(ids[ids.length - MINING_BACKFILL_MAX]), "the 2,000th backfill commit is read");
    assert.ok(!read.has(ids[ids.length - MINING_BACKFILL_MAX - 1]), "the 2,001st is never read");

    const [rewritten] = importCommits(mirror, "refs/heads/rewrite", [change(MINING_BACKFILL_MAX + 101, true)], ids[ids.length - 2]);
    head.value = rewritten;
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(r.store, rewritten)?.state, "candidate", "the rewritten head is mined");
    assert.equal(cursorOf(r.store)?.forward, rewritten);
    const [next] = importCommits(mirror, "refs/heads/rewrite", [change(MINING_BACKFILL_MAX + 102, true)], rewritten);
    head.value = next;
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(r.store, next)?.state, "candidate", "the commit after it is mined");
  } finally {
    r.cleanup();
  }
});

test("a commit is mined once across a restart", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: 10 }, (_, index) => change(index, true));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[ids.length - 1] };
    const crashing = minerFor(r, { mirror, head, store: failingWrite(r.store, 2) });
    crashing.pump();
    await crashing.idle();
    assert.equal(minedOf(r.store, ids[9])?.state, "candidate", "the first decision is kept");
    assert.equal(minedOf(r.store, ids[8]), undefined, "the failed decision is not kept");
    assert.equal(minedCount(r.store), 1);
    assert.equal(miningRow(r.store)?.visited, 1, "only the first decision was written");

    const counted = countingGit();
    const restarted = minerFor(r, { mirror, head, git: counted.git });
    restarted.pump();
    await restarted.idle();
    assert.equal(minedCount(r.store), 9, "each of the nine test commits has one row");
    assert.equal(restarted.status(PROJECT).visited, 10, "visited counts each commit once");
    assert.equal(restarted.status(PROJECT).skipped, 1);

    counted.calls.length = 0;
    restarted.pump();
    await restarted.idle();
    assert.deepEqual(counted.calls, [], "a second pass over an unchanged head reads no commit");
  } finally {
    r.cleanup();
  }
});

test("a refused read mines nothing and claims nothing", async t => {
  const warned = t.mock.method(console, "warn", () => undefined);
  const warnings = () => warned.mock.calls.map(call => call.arguments[0]);
  const r = rig();
  try {
    const commits = Array.from({ length: 3 }, (_, index) => change(index, true));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[ids.length - 1] };
    let clock = NOW;
    const refusedNumstat = minerFor(r, {
      mirror,
      head,
      git: mineGit(() => scriptedPrefix(r.dir, "numstat", [{ pattern: "--numstat", code: 126 }])),
      now: () => clock,
    });
    refusedNumstat.pump();
    await refusedNumstat.idle();
    let row = miningRow(r.store);
    assert.equal(row?.state, "failing");
    assert.equal(row?.failures, 1);
    assert.equal(minedCount(r.store), 0, "no row for a refused read");
    assert.deepEqual(cursorOf(r.store), { projectId: PROJECT }, "the cursor is unchanged, so nothing is claimed");
    assert.deepEqual(warnings(), ["Eval mining paused (read-failed)."]);

    const calls = callLines(r.dir);
    refusedNumstat.pump();
    await refusedNumstat.idle();
    assert.equal(callLines(r.dir), calls, "no pass before retry_at");

    clock = new Date(Date.parse(NOW) + MINING_RETRY_MS).toISOString();
    refusedNumstat.pump();
    await refusedNumstat.idle();
    row = miningRow(r.store);
    assert.equal(row?.failures, 2, "the retry after an hour reads again and fails again");
    assert.equal(minedCount(r.store), 0);
    assert.equal(warnings().length, 1, "a project already failing logs nothing more");

    const other = rig();
    try {
      const { mirror: mirror2, ids: ids2 } = mirrorWith(other.dir, commits);
      const refusedMessage = minerFor(other, {
        mirror: mirror2,
        head: { value: ids2[ids2.length - 1] },
        git: mineGit(() => scriptedPrefix(other.dir, "message", [{ pattern: "--format=%ct", code: 126 }])),
      });
      refusedMessage.pump();
      await refusedMessage.idle();
      assert.equal(miningRow(other.store)?.state, "failing");
      assert.equal(minedCount(other.store), 0);
      assert.deepEqual(cursorOf(other.store), { projectId: PROJECT });
      assert.equal(warnings().length, 2, "another project that starts failing logs again");
    } finally {
      other.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

test("a rewrite answer that cannot be followed moves no cursor", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: 3 }, (_, index) => change(index, true));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[2] };
    const first = minerFor(r, { mirror, head });
    first.pump();
    await first.idle();
    assert.equal(cursorOf(r.store)?.forward, ids[2]);

    const [rewritten] = importCommits(mirror, "refs/heads/rewrite", [change(7, true)], ids[1]);
    head.value = rewritten;
    const refused = minerFor(r, {
      mirror,
      head,
      git: mineGit(() => scriptedPrefix(r.dir, "rewrite", [
        { pattern: "merge-base", code: 1 },
        { pattern: "rev-list", code: 1 },
        { pattern: "--no-walk", code: 1 },
        { pattern: "--numstat", code: 1 },
      ])),
    });
    refused.pump();
    await refused.idle();
    assert.equal(cursorOf(r.store)?.forward, ids[2], "the rewrite is not claimed");
    assert.equal(minedOf(r.store, rewritten), undefined, "the new head is not mined");
    assert.equal(miningRow(r.store)?.state, "failing");
  } finally {
    r.cleanup();
  }
});

test("a rewrite whose old commits were pruned restarts the walk", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: 3 }, (_, index) => change(index, true));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[2] };
    const miner = minerFor(r, { mirror, head });
    miner.pump();
    await miner.idle();
    assert.equal(minedCount(r.store), 2, "the root is skipped; two rows");

    const [rewritten] = importCommits(mirror, "refs/heads/rewrite", [change(9, true)], ids[1]);
    git(mirror, ["update-ref", "refs/heads/main", rewritten]);
    head.value = rewritten;
    const unread = minerFor(r, { mirror, head, git: mineGit(() => scriptedPrefix(r.dir, "ancestry", [{ pattern: "merge-base", code: 128 }])) });
    unread.pump();
    await unread.idle();
    assert.equal(miningRow(r.store)?.state, "failing", "both commits read, so the failed answer stays a failure");
    assert.equal(cursorOf(r.store)?.forward, ids[2], "the walk does not move");

    git(mirror, ["reflog", "expire", "--expire=now", "--all"]);
    git(mirror, ["gc", "--prune=now", "--quiet"]);
    const refused = minerFor(r, {
      mirror, head,
      git: mineGit(() => scriptedPrefix(r.dir, "refused", [{ pattern: `no-walk*${ids[2]}`, code: 1 }])),
      now: () => new Date(Date.parse(NOW) + MINING_RETRY_MS).toISOString(),
    });
    refused.pump();
    await refused.idle();
    assert.equal(miningRow(r.store)?.state, "failing", "a refused read of the old commit is not its absence");
    assert.equal(cursorOf(r.store)?.forward, ids[2], "the walk does not move");
    const later = minerFor(r, { mirror, head, now: () => new Date(Date.parse(NOW) + 2 * MINING_RETRY_MS).toISOString() });
    later.pump();
    await later.idle();
    assert.notEqual(miningRow(r.store)?.state, "failing", "a pruned forward commit is a rewrite, not a failed read");
    assert.equal(cursorOf(r.store)?.forward, rewritten, "the forward cursor moves to the new head");
    assert.equal(minedOf(r.store, rewritten)?.state, "candidate", "the new head is mined");
  } finally {
    r.cleanup();
  }
});

test("a rewritten branch restarts the walk", async () => {
  const r = rig();
  try {
    const commits = Array.from({ length: 3 }, (_, index) => change(index, true));
    const { mirror, ids } = mirrorWith(r.dir, commits);
    const head = { value: ids[2] };
    const miner = minerFor(r, { mirror, head });
    miner.pump();
    await miner.idle();
    assert.equal(minedCount(r.store), 2, "the root is skipped; two rows");

    const [rewritten] = importCommits(mirror, "refs/heads/rewrite", [change(9, true)], ids[1]);
    head.value = rewritten;
    miner.pump();
    await miner.idle();
    assert.equal(cursorOf(r.store)?.forward, rewritten, "the forward cursor moves to the new head");
    assert.equal(minedOf(r.store, rewritten)?.state, "candidate", "the new head is mined");
    assert.equal(minedOf(r.store, ids[2])?.state, "candidate", "the earlier row stays");
    assert.equal(minedOf(r.store, ids[1])?.state, "candidate", "the earlier row stays");
    assert.equal(minedCount(r.store), 3);
  } finally {
    r.cleanup();
  }
});

test("mined rows stop at their own cap, and host bytes take the room", async () => {
  const r = rig();
  try {
    const { mirror, ids } = mirrorWith(r.dir, [change(0, false), change(1, true)]);
    const head = { value: ids[1] };
    fillMined(r.store, MINED_TASK_MAX);
    const counted = countingGit();
    const miner = minerFor(r, { mirror, head, git: counted.git });
    miner.pump();
    await miner.idle();
    assert.equal(miner.status(PROJECT).state, "full");
    assert.deepEqual(counted.calls, [], "no commit is read at the cap");
    assert.deepEqual(cursorOf(r.store), { projectId: PROJECT }, "the cursor stays");

    r.store.write(tx => {
      tx.run("DELETE FROM eval_tasks WHERE task_id = ?", "filler:0");
    });
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(r.store, ids[1])?.state, "candidate", "one free row lets the next pass mine");
  } finally {
    r.cleanup();
  }

  const host = rig();
  try {
    const { mirror, ids } = mirrorWith(host.dir, [change(0, false), change(1, true)]);
    const head = { value: ids[1] };
    const room = 3_276_800;
    const other = (bytes: number) => host.store.write(tx => {
      tx.run(
        "INSERT OR REPLACE INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, "
        + "material_bytes, captured_at, checked_at, payload, group_id, paths_indexed) "
        + "VALUES ('other', 'captured', 'run-other', 'm', ?, 'candidate', 'stored', 'proven', ?, ?, ?, ?, 'run:run-other', 1)",
        tx.index("project", "project-other"),
        bytes,
        NOW,
        NOW,
        "x",
      );
    });
    other(HOST_MATERIAL_MAX_BYTES - (room - 1));
    const counted = countingGit();
    const miner = minerFor(host, { mirror, head, git: counted.git });
    miner.pump();
    await miner.idle();
    assert.equal(miner.status(PROJECT).state, "full", "3,276,799 bytes short of the room is full");
    assert.deepEqual(counted.calls, [], "no read without room");

    other(HOST_MATERIAL_MAX_BYTES - room);
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(host.store, ids[1])?.state, "candidate", "exactly the room fits");
  } finally {
    host.cleanup();
  }
});

test("mining waits while a stored row's paths are not indexed", async () => {
  const r = rig();
  try {
    const { mirror, ids } = mirrorWith(r.dir, [change(0, false), change(1, true)]);
    const head = { value: ids[1] };
    r.store.write(tx => {
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id, paths_indexed) "
        + "VALUES ('pending', 'captured', 'run-p', 'm', ?, 'candidate', 'stored', 'proven', ?, ?, 'x', 'run:run-p', 0)",
        tx.index("project", PROJECT),
        NOW,
        NOW,
      );
    });
    const counted = countingGit();
    const miner = minerFor(r, { mirror, head, git: counted.git });
    miner.pump();
    await miner.idle();
    assert.equal(miner.status(PROJECT).state, "waiting");
    assert.deepEqual(counted.calls, [], "no commit is read while paths are pending");

    r.store.write(tx => { tx.run("UPDATE eval_tasks SET paths_indexed = 1 WHERE task_id = 'pending'"); });
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(r.store, ids[1])?.state, "candidate", "the next pass mines");
  } finally {
    r.cleanup();
  }
});

test("close ends a read in flight without a write", async () => {
  const r = rig();
  try {
    const { mirror, ids } = mirrorWith(r.dir, [change(0, false), change(1, true)]);
    const started = join(r.dir, "numstat.started");
    const script = join(r.dir, "slow.sh");
    writeFileSync(script, `#!/bin/sh\ncase "$*" in *--numstat*) : > "${started}"; sleep 1;; esac\nshift\nexec git "$@"\n`);
    const miner = minerFor(r, { mirror, head: { value: ids[1] }, git: mineGit(() => ({ command: "/bin/sh", args: [script] })) });
    miner.pump();
    for (let i = 0; i < 500 && !existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(started), "the numstat read started");
    miner.close();
    await miner.idle();
    assert.equal(minedCount(r.store), 0, "no row after close");
    assert.equal(cursorOf(r.store)?.forward, undefined, "no cursor after close");
  } finally {
    r.cleanup();
  }
});

test("a secret-shaped message is never stored", async () => {
  const r = rig();
  try {
    const token = `ghp_${"A".repeat(36)}`;
    const { mirror, ids } = mirrorWith(r.dir, [change(0, false), { ...change(1, true), message: `Ship it\n\nToken ${token}` }]);
    const miner = minerFor(r, { mirror, head: { value: ids[1] } });
    miner.pump();
    await miner.idle();
    const row = r.store.read(db => db.get<{ task_id: string; state: string; reason: string | null }>(
      "SELECT task_id, state, reason FROM eval_tasks WHERE project_ref = ? AND commit_ref = ?",
      db.index("project", PROJECT),
      db.index("eval-commit", ids[1]),
    ));
    assert.equal(row?.state, "rejected");
    assert.equal(row?.reason, "secret-shaped");
    assert.deepEqual(r.store.read(db => readMaterial(db, row!.task_id)), {});
    const dump = r.store.read(db => JSON.stringify([
      db.all("SELECT * FROM eval_tasks"),
      db.all("SELECT * FROM eval_material"),
      db.all("SELECT * FROM eval_groups"),
      db.all("SELECT * FROM eval_mining"),
    ]));
    assert.equal(dump.includes(token), false, "no table holds the token");
  } finally {
    r.cleanup();
  }
});

test("the verdicts reach the rows: a root is skipped, a run's merge is run-objective, a revert is rejected", async () => {
  const r = rig();
  try {
    const { mirror, ids } = mirrorWith(r.dir, [
      change(0, true),
      change(1, true, "Add the first feature"),
      change(2, true, 'Revert "Add the first feature"\n\nThis reverts commit ' + "e".repeat(40) + "."),
      change(3, true, "Add the third feature"),
    ]);
    const run = { id: "run-1", projectId: PROJECT, objective: "Ship the feature", deliveryReceipt: { mergeCommit: ids[1] } } as unknown as TeamRun;
    const miner = minerFor(r, { mirror, head: { value: ids[3] }, runs: () => [run] });
    miner.pump();
    await miner.idle();
    assert.equal(minedOf(r.store, ids[0]), undefined, "the root commit is skipped");
    assert.equal(minedOf(r.store, ids[2])?.reason, "revert");
    assert.equal(minedOf(r.store, ids[2])?.state, "rejected");
    assert.equal(minedOf(r.store, ids[3])?.state, "candidate");
    const copy = r.store.read(db => readEvalTask(db, minedTaskId(db.index("project", PROJECT), db.index("eval-commit", ids[1]))));
    assert.equal(copy?.state, "candidate");
    assert.equal((copy?.payload as { promptOrigin?: string }).promptOrigin, "run-objective");
    assert.equal(miningRow(r.store)?.skipped, 1);
  } finally {
    r.cleanup();
  }
});

test("the hot statements read through an index", () => {
  const r = rig();
  try {
    const ref = r.store.read(db => db.index("project", PROJECT));
    const commitRef = r.store.read(db => db.index("eval-commit", "c".repeat(40)));
    const cases: { name: string; sql: string; params: (string | number)[]; index: string }[] = [
      { name: "MINING_ROW_SQL", sql: MINING_ROW_SQL, params: [ref], index: "sqlite_autoindex_eval_mining_1" },
      { name: "MINED_COUNT_SQL", sql: MINED_COUNT_SQL, params: [ref], index: "eval_tasks_summary" },
      { name: "PROJECT_BYTES_SQL", sql: PROJECT_BYTES_SQL, params: [ref], index: "eval_tasks_bytes" },
      { name: "HOST_BYTES_SQL", sql: HOST_BYTES_SQL, params: [], index: "eval_tasks_bytes" },
      { name: "EXISTING_COMMIT_SQL", sql: EXISTING_COMMIT_SQL, params: [ref, commitRef], index: "eval_tasks_commit" },
      { name: "LANDING_JOIN_SQL", sql: LANDING_JOIN_SQL, params: [ref, commitRef], index: "eval_groups_landing" },
    ];
    for (const item of cases) {
      const details = r.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.params))
        .map(row => row.detail);
      assert.ok(details.some(detail => detail.includes(item.index)), `${item.name} plan: ${details.join(" | ")}`);
    }
  } finally {
    r.cleanup();
  }
});

test("insertMined writes a candidate once and refuses a full project", () => {
  const r = rig();
  try {
    const commit = "d".repeat(40);
    const input = {
      kind: "candidate" as const, projectId: PROJECT, commit, parent: "e".repeat(40), commitTime: NOW,
      capsule: CAPSULE, promptOrigin: "commit-message" as const, files: ["src/a.ts", "tests/a.test.ts"],
      hiddenFiles: ["tests/a.test.ts"], features: FEATURES,
    };
    assert.equal(r.store.write(tx => insertMined(tx, input, NOW)), "inserted");
    assert.equal(r.store.write(tx => insertMined(tx, input, NOW)), "exists");
    const id = minedTaskId(r.store.read(db => db.index("project", PROJECT)), r.store.read(db => db.index("eval-commit", commit)));
    assert.equal(r.store.read(db => readEvalTask(db, id))?.state, "candidate");
    assert.equal(r.store.read(db => readMaterial(db, id)).capsule?.objective, "Ship");

    fillMined(r.store, MINED_TASK_MAX - 1);
    const other = { ...input, commit: "f".repeat(40) };
    assert.equal(r.store.write(tx => insertMined(tx, other, NOW)), "full");
    assert.equal(minedOf(r.store, other.commit), undefined, "a full project gets no row");
  } finally {
    r.cleanup();
  }
});
