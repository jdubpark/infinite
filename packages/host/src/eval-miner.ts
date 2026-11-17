import { createHash } from "node:crypto";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { type EvalProjectSettings, mineSettings } from "./eval-config.js";
import { applyDuplicateRule, ensureGroup, lineageRoots, mergeRoots, rootOf } from "./eval-groups.js";
import type { MineGit } from "./eval-mine-git.js";
import { capsuleVerdict, isRevert, minedCapsule, mineVerdict } from "./eval-mine-rules.js";
import { CAPSULE_MAX_BYTES, capsuleBytes } from "./eval-rules.js";
import { HOST_MATERIAL_MAX_BYTES, PROJECT_MATERIAL_MAX_BYTES, pathRef, pathsPending, rejectTask } from "./eval-store.js";
import {
  type Capsule,
  EVAL_MODULE,
  type EvalFeatures,
  type EvalReason,
  type MinedPayload,
  type MiningState,
  type MiningStatus,
  type RejectedPayload,
} from "./eval-types.js";
import type { ProjectSourceService } from "./project-source.js";
import type { FeatureMap } from "./task-features.js";
import type { TeamRun } from "./team-types.js";
import type { Config } from "./types.js";

/** The owner defaults of the mining pass (see the plan's "Rulings before the build"). */
export const MINING_BATCH = 50, MINING_BACKFILL_MAX = 2_000, MINED_TASK_MAX = 5_000, MINING_RETRY_MS = 3_600_000;
/** The room one pass needs: a batch of capsules at their largest. */
const MINING_ROOM_BYTES = MINING_BATCH * CAPSULE_MAX_BYTES;
/** Commits per form-4 read of first parents: the most one `parents` call takes. */
const PARENT_CHUNK = 50;

/** Mined rows of one project, read through `eval_tasks_summary`. */
export const MINED_COUNT_SQL = "SELECT count(*) AS n FROM eval_tasks WHERE project_ref = ? AND origin = 'mined'";
/** The mining row of one project, read by its primary key. */
export const MINING_ROW_SQL = "SELECT state, visited, mined, skipped, failures, retry_at, payload FROM eval_mining WHERE project_ref = ?";
/** One project's material bytes, read through `eval_tasks_bytes`. */
export const PROJECT_BYTES_SQL = "SELECT COALESCE(SUM(material_bytes), 0) AS n FROM eval_tasks WHERE project_ref = ?";
/** The host's material bytes: every project's, through the same covering index. Once per pass. */
export const HOST_BYTES_SQL = "SELECT COALESCE(SUM(material_bytes), 0) AS n FROM eval_tasks";
/** Whether a commit already has a row, read through `eval_tasks_commit`. */
export const EXISTING_COMMIT_SQL = "SELECT task_id FROM eval_tasks WHERE project_ref = ? AND commit_ref = ? LIMIT 1";
/** The run group that landed a commit, read through `eval_groups_landing`. */
export const LANDING_JOIN_SQL = "SELECT group_id FROM eval_groups WHERE project_ref = ? AND landing_ref = ? LIMIT 1";
const UPSERT_MINING_SQL = "INSERT INTO eval_mining (project_ref, state, visited, mined, skipped, failures, retry_at, updated_at, payload) "
  + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_ref) DO UPDATE SET state = excluded.state, visited = excluded.visited, "
  + "mined = excluded.mined, skipped = excluded.skipped, failures = excluded.failures, retry_at = excluded.retry_at, "
  + "updated_at = excluded.updated_at, payload = excluded.payload";

/** Sealed in eval_mining.payload, row id project_ref. `backfill.visited` counts the backfill's own commits. */
export type MiningCursor = { projectId: string; forward?: string; backfill?: { next: string; visited: number; done: boolean } };

/** The mined task of one commit: `mined:` and the first 40 hex digits of SHA-256 over the project ref and the commit ref. */
export function minedTaskId(projectRef: string, commitRef: string): string {
  return `mined:${createHash("sha256").update(`${projectRef}:${commitRef}`).digest("hex").slice(0, 40)}`;
}

export type MinedInsert =
  | { kind: "candidate"; projectId: string; commit: string; parent: string; commitTime: string; capsule: Capsule;
      promptOrigin: "run-objective" | "commit-message"; runId?: string; files: string[]; hiddenFiles: string[]; features: EvalFeatures }
  | { kind: "rejected"; projectId: string; commit: string; reason: EvalReason };
export type MinedCandidate = Extract<MinedInsert, { kind: "candidate" }>;

/**
 * Writes one mined row with its own group. `exists` when the commit has a row already; `full` at 5,000 mined rows of the
 * project. A candidate also stores its capsule part, as `insertMarker` does for a captured task.
 */
export function insertMined(tx: EvidenceTx, input: MinedInsert, at: string): "inserted" | "exists" | "full" {
  const projectRef = tx.index("project", input.projectId);
  const commitRef = tx.index("eval-commit", input.commit);
  const taskId = minedTaskId(projectRef, commitRef);
  if (tx.get(EXISTING_COMMIT_SQL, projectRef, commitRef) !== undefined) return "exists";
  if ((tx.get<{ n: number }>(MINED_COUNT_SQL, projectRef)?.n ?? 0) >= MINED_TASK_MAX) return "full";
  const bytes = input.kind === "candidate" ? capsuleBytes(input.capsule) : 0;
  const payload: MinedPayload | RejectedPayload = input.kind === "candidate"
    ? {
      projectId: input.projectId,
      anchorCommit: input.parent,
      commit: input.commit,
      commitTime: input.commitTime,
      promptOrigin: input.promptOrigin,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      files: input.files,
      hiddenFiles: input.hiddenFiles,
      features: input.features,
    }
    : { projectId: input.projectId };
  ensureGroup(tx, taskId, "mined", projectRef, at);
  const inserted = tx.run(
    "INSERT OR IGNORE INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, "
    + "approved_at, base, material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload, group_id, commit_ref, "
    + "area_ref, paths_indexed) VALUES (?, 'mined', '', '', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1)",
    taskId,
    projectRef,
    input.kind === "candidate" ? "candidate" : "rejected",
    input.kind === "candidate" ? null : input.reason,
    input.kind === "candidate" ? "stored" : "none",
    input.kind === "candidate" ? "proven" : "none",
    bytes,
    at,
    at,
    at,
    tx.seal("eval_tasks", taskId, payload),
    taskId,
    commitRef,
    input.kind === "candidate" ? tx.index("area", input.features.area) : null,
  );
  if (inserted.changes === 0) return "exists";
  if (input.kind === "candidate") {
    tx.run(
      "INSERT INTO eval_material (task_id, part, bytes, payload) VALUES (?, 'capsule', ?, ?)",
      taskId,
      bytes,
      tx.seal("eval_material", `${taskId}/capsule`, { capsule: input.capsule }),
    );
  }
  return "inserted";
}

export type MinerOptions = {
  config: Pick<Config, "projects">;
  store: EvidenceStore;
  source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  git: MineGit;
  runs: () => readonly TeamRun[];
  now?: () => string;
};

/** The counts a pass keeps, as the row holds them. */
type Saved = { cursor: MiningCursor; visited: number; mined: number; skipped: number; failures: number };
type Loaded = { state: MiningState | undefined; saved: Saved; retryAt: string | null };
type MiningRow = { state: string; visited: number; mined: number; skipped: number; failures: number; retry_at: string | null; payload: string };

type CandidateVerdict = {
  kind: "candidate"; commit: string; parent: string; commitTime: string; capsule: Capsule;
  promptOrigin: "run-objective" | "commit-message"; runId?: string; files: string[]; hiddenFiles: string[];
  features: EvalFeatures; paths: string[];
};
/** What one commit comes to. `failed` is a refused or failed read: nothing is written for it. */
type Verdict =
  | { kind: "exists" } | { kind: "skip" } | { kind: "reject"; reason: EvalReason } | { kind: "failed" } | CandidateVerdict;

/** `ok` when the commit's decision and cursor committed. `stop` ends the pass with nothing written. */
type Outcome = "ok" | "failed" | "stop" | "full";
/** A rewrite's head moves `forward` like a new commit and restarts the backfill below it. */
type CursorPath = "forward" | "backfill" | "rewrite";
type End = "budget" | "done" | Outcome;

type Pass = {
  projectId: string; ref: string; mirror: string; head: string; settings: EvalProjectSettings; map: FeatureMap | undefined;
  at: string;
  /** The row's state as last written or read. */
  state: MiningState | undefined;
  /** The counts and cursor the store holds. */
  saved: Saved;
  /** The cursor the walk is on. It differs from `saved` only after a rewrite answer, which is written with the next commit. */
  cursor: MiningCursor;
  budget: number;
  /** The run records by merge commit. Built on first use, so a pass that decides no commit copies none. */
  runs?: Map<string, TeamRun>;
};

const OFF: MiningStatus = { state: "off", visited: null, mined: null, skipped: null, failures: null, backfillDone: null };

/**
 * Mines the base branch of each GitHub project with mining on. A pass decides at most 50 commits, each in its own
 * write with its cursor. It never throws, and it runs one pass at a time.
 */
export class Miner {
  private readonly config: Pick<Config, "projects">;
  private readonly store: EvidenceStore;
  private readonly source: MinerOptions["source"];
  private readonly git: MineGit;
  private readonly runs: () => readonly TeamRun[];
  private readonly now: () => string;
  private running: Promise<void> | undefined;
  private last = "";
  private closed = false;

  constructor(options: MinerOptions) {
    this.config = options.config;
    this.store = options.store;
    this.source = options.source;
    this.git = options.git;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Starts one pass when none runs. Never throws. */
  pump(): void {
    if (this.closed || this.running !== undefined) return;
    const run: Promise<void> = this.once()
      .catch(() => undefined)
      .finally(() => {
        if (this.running === run) this.running = undefined;
      });
    this.running = run;
  }

  /** Resolves when the pass in flight, if any, has ended. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  status(projectId: string): MiningStatus {
    if (mineSettings(this.project(projectId)) === undefined) return OFF;
    try {
      const ref = this.store.read(db => db.index("project", projectId));
      const loaded = this.store.read(db => loadWith(db, ref, projectId));
      return {
        state: loaded.state ?? "waiting",
        visited: loaded.saved.visited,
        mined: loaded.saved.mined,
        skipped: loaded.saved.skipped,
        failures: loaded.saved.failures,
        backfillDone: loaded.saved.cursor.backfill?.done ?? false,
      };
    } catch {
      return { state: "waiting", visited: null, mined: null, skipped: null, failures: null, backfillDone: null };
    }
  }

  /** Ends the chain: a read in flight ends without a write. */
  close(): void {
    this.closed = true;
  }

  private async once(): Promise<void> {
    if (this.closed || this.store.status().modules[EVAL_MODULE] !== "ready") return;
    const at = this.now();
    const projectId = this.pick(at);
    if (projectId !== undefined) await this.pass(projectId, at);
  }

  private project(projectId: string) {
    return this.config.projects.find(project => project.id === projectId);
  }

  /** The next project in id order after the last one picked, with a mirror head and no retry pending. */
  private pick(at: string): string | undefined {
    const ids = this.config.projects.filter(project => mineSettings(project) !== undefined).map(project => project.id).sort(compareText);
    const ordered = [...ids.filter(id => id > this.last), ...ids.filter(id => id <= this.last)];
    for (const id of ordered) {
      if (this.source.status(id).mirrorHead === undefined) continue;
      const ref = this.store.read(db => db.index("project", id));
      const loaded = this.store.read(db => loadWith(db, ref, id));
      if (loaded.retryAt !== null && loaded.retryAt > at) continue;
      this.last = id;
      return id;
    }
    return undefined;
  }

  private async pass(projectId: string, at: string): Promise<void> {
    const settings = mineSettings(this.project(projectId));
    const head = this.source.status(projectId).mirrorHead;
    if (settings === undefined || head === undefined) return;
    const ref = this.store.read(db => db.index("project", projectId));
    const loaded = this.store.read(db => loadWith(db, ref, projectId));
    const pass: Pass = {
      projectId, ref, head, settings, at,
      mirror: this.source.mirrorPath(projectId),
      map: this.project(projectId)?.team?.features,
      state: loaded.state,
      saved: loaded.saved,
      cursor: loaded.saved.cursor,
      budget: MINING_BATCH,
    };
    if (this.store.read(db => pathsPending(db, ref))) return this.note(pass, "waiting");
    if (!this.hasRoom(ref)) return this.note(pass, "full");
    // The first pass starts from the head: forward is empty, and the backfill walks down from it.
    if (pass.cursor.forward === undefined) {
      pass.cursor = { projectId, forward: head, backfill: { next: head, visited: 0, done: false } };
    }
    let end: End;
    try {
      end = await this.walk(pass);
    } catch {
      end = "stop";
    }
    if (end === "done") this.note(pass, "caught-up");
  }

  /** Forward first, then the backfill, at most `pass.budget` commits in all. */
  private async walk(p: Pass): Promise<End> {
    const forward = p.cursor.forward;
    if (forward !== undefined && forward !== p.head) {
      let answer = await this.git.isAncestor(p.mirror, forward, p.head);
      if (this.closed) return "stop";
      let headList: Map<string, string[]> | undefined;
      if (answer === "failed") {
        // Form 1 also fails when a rewrite and garbage collection pruned `forward`. The head reads and Git answers that it
        // holds no `forward`: that is a rewrite, and it takes the rewrite path. Any other failure stays failed, a read
        // that timed out or a launcher that refused included.
        headList = await this.git.parents(p.mirror, [p.head]);
        if (this.closed) return "stop";
        if (headList?.has(p.head) !== true) return this.failed(p);
        const held = await this.git.present(p.mirror, forward);
        if (this.closed) return "stop";
        if (held !== "no") return this.failed(p);
        answer = "no";
      }
      if (answer === "no") {
        // A rewrite. The head is decided first, and its write moves `forward` to it (ruling 12), so a backfill already at
        // its bound cannot stop the forward walk. The backfill then walks down from the head's first parent.
        headList ??= await this.git.parents(p.mirror, [p.head]);
        if (this.closed) return "stop";
        const outcome = await this.decide(p, p.head, "rewrite", headList?.get(p.head));
        if (outcome !== "ok") return outcome;
      } else {
        const list = await this.git.firstParents(p.mirror, p.head, forward);
        if (this.closed) return "stop";
        if (list === undefined) return this.failed(p);
        // The list is at most 500 commits, newest first. The oldest of them is mined first.
        const ordered = [...list.ids].reverse();
        let parents: Map<string, string[]> | undefined;
        let chunkEnd = 0;
        for (let index = 0; index < ordered.length; index++) {
          if (p.budget <= 0) return "budget";
          if (index === chunkEnd) {
            // A chunk holds no more commits than the pass can still decide, so no read reaches past the budget.
            chunkEnd = index + Math.min(PARENT_CHUNK, p.budget, ordered.length - index);
            parents = await this.git.parents(p.mirror, ordered.slice(index, chunkEnd));
            if (this.closed) return "stop";
          }
          const outcome = await this.decide(p, ordered[index], "forward", parents?.get(ordered[index]));
          if (outcome !== "ok") return outcome;
        }
      }
    }
    for (;;) {
      const bf = p.cursor.backfill;
      if (bf === undefined || bf.done || bf.visited >= MINING_BACKFILL_MAX) return "done";
      if (p.budget <= 0) return "budget";
      const list = await this.git.firstParents(p.mirror, bf.next);
      if (this.closed) return "stop";
      if (list === undefined || list.ids.length === 0) return this.failed(p);
      let parents: Map<string, string[]> | undefined;
      let chunkEnd = 0;
      for (let index = 0; index < list.ids.length; index++) {
        const current = p.cursor.backfill;
        if (current === undefined || current.done || current.visited >= MINING_BACKFILL_MAX) break;
        if (p.budget <= 0) return "budget";
        if (index === chunkEnd) {
          // As in the forward walk, a chunk never reads past what the pass can still decide: the budget or the bound.
          const allowed = Math.min(PARENT_CHUNK, p.budget, MINING_BACKFILL_MAX - current.visited);
          chunkEnd = index + Math.min(allowed, list.ids.length - index);
          parents = await this.git.parents(p.mirror, list.ids.slice(index, chunkEnd));
          if (this.closed) return "stop";
        }
        const outcome = await this.decide(p, list.ids[index], "backfill", parents?.get(list.ids[index]));
        if (outcome !== "ok") return outcome;
      }
    }
  }

  /** Decides one commit from its first-parent list, read in a chunk by the walk, then advances the cursor in one write. */
  private async decide(p: Pass, commit: string, path: CursorPath, list: string[] | undefined): Promise<Outcome> {
    if (list === undefined) return this.failed(p);
    const parent = list[0];
    const verdict = await this.verdict(p, commit, parent);
    if (this.closed) return "stop";
    if (verdict.kind === "failed") return this.failed(p);
    return this.apply(p, commit, advance(p, path, commit, parent), verdict);
  }

  /** The verdict on one commit, from its existing row or its first parent's change counts and message. */
  private async verdict(p: Pass, commit: string, parent: string | undefined): Promise<Verdict> {
    if (this.store.read(db => db.get(EXISTING_COMMIT_SQL, p.ref, db.index("eval-commit", commit))) !== undefined) {
      return { kind: "exists" };
    }
    if (parent === undefined) return { kind: "skip" };
    const numstat = await this.git.numstat(p.mirror, parent, commit);
    if (numstat.state === "failed") return { kind: "failed" };
    const counts = mineVerdict(numstat, p.settings, p.map);
    if (counts.kind === "skip") return { kind: "skip" };
    if (counts.kind === "reject") return { kind: "reject", reason: counts.reason };
    const message = await this.git.message(p.mirror, commit);
    if (message.state === "failed") return { kind: "failed" };
    if (message.state === "too-large") return { kind: "reject", reason: "capsule-too-large" };
    if (isRevert(message.message)) return { kind: "reject", reason: "revert" };
    p.runs ??= this.mergeRuns(p.projectId);
    const run = p.runs.get(commit);
    const built = minedCapsule(message.message, counts.paths, run);
    if ("reject" in built) return { kind: "reject", reason: built.reject };
    const check = capsuleVerdict(built.capsule);
    if (check !== "ok") return { kind: "reject", reason: check };
    return {
      kind: "candidate", commit, parent, commitTime: message.commitTime, capsule: built.capsule,
      promptOrigin: built.promptOrigin, files: counts.files, hiddenFiles: counts.hiddenFiles, features: counts.features,
      paths: counts.paths, ...(run !== undefined ? { runId: run.id } : {}),
    };
  }

  /** One write: the row, the group join, the counts, and the cursor. */
  private apply(p: Pass, commit: string, cursor: MiningCursor, verdict: Verdict): Outcome {
    let inserted = false as boolean;
    let full = false as boolean;
    let saved: Saved = p.saved;
    const written = this.store.tryWrite(tx => {
      if (verdict.kind === "candidate" || verdict.kind === "reject") {
        const input = minedInput(p.projectId, commit, verdict);
        const result = insertMined(tx, input, p.at);
        if (result === "full") {
          full = true;
          return;
        }
        inserted = result === "inserted";
        if (inserted && input.kind === "candidate") placeMined(tx, input, p.at);
      }
      saved = {
        cursor,
        visited: p.saved.visited + 1,
        mined: p.saved.mined + (inserted ? 1 : 0),
        skipped: p.saved.skipped + (verdict.kind === "skip" ? 1 : 0),
        failures: p.saved.failures,
      };
      save(tx, p.ref, "mining", saved, null, p.at);
    });
    if (!written) return "stop";
    if (full) {
      this.note(p, "full");
      return "full";
    }
    p.saved = saved;
    p.cursor = cursor;
    p.budget -= 1;
    p.state = "mining";
    return "ok";
  }

  /** Counts a refused or failed read: the row says `failing` with one more failure, and the cursor is what was saved. */
  private failed(p: Pass): "failed" {
    if (this.closed) return "failed";
    const counts = { ...p.saved, failures: p.saved.failures + 1 };
    const wasFailing = p.state === "failing";
    if (this.store.tryWrite(tx => save(tx, p.ref, "failing", counts, isoAfter(p.at, MINING_RETRY_MS), p.at))) p.state = "failing";
    // Once when a project starts failing, not at each hourly retry. The line names no project, commit, or path.
    if (!wasFailing) console.warn("Eval mining paused (read-failed).");
    return "failed";
  }

  /** Writes a state change, and nothing when the row already holds it. */
  private note(p: Pass, state: MiningState): void {
    if (this.closed || p.state === state) return;
    if (this.store.tryWrite(tx => save(tx, p.ref, state, p.saved, null, p.at))) p.state = state;
  }

  /** A pass starts only when a batch of capsules fits under both byte caps and the project holds fewer than 5,000 mined rows. */
  private hasRoom(ref: string): boolean {
    return this.store.read(db => {
      const projectBytes = db.get<{ n: number }>(PROJECT_BYTES_SQL, ref)?.n ?? 0;
      const hostBytes = db.get<{ n: number }>(HOST_BYTES_SQL)?.n ?? 0;
      const minedRows = db.get<{ n: number }>(MINED_COUNT_SQL, ref)?.n ?? 0;
      return minedRows < MINED_TASK_MAX
        && projectBytes + MINING_ROOM_BYTES <= PROJECT_MATERIAL_MAX_BYTES
        && hostBytes + MINING_ROOM_BYTES <= HOST_MATERIAL_MAX_BYTES;
    });
  }

  /** The commits whose merge a run record names, once per pass. */
  private mergeRuns(projectId: string): Map<string, TeamRun> {
    const runs = new Map<string, TeamRun>();
    for (const run of this.runs()) {
      const commit = run.deliveryReceipt?.mergeCommit;
      if (run.projectId === projectId && commit !== undefined) runs.set(commit, run);
    }
    return runs;
  }
}

function loadWith(db: EvidenceDb, ref: string, projectId: string): Loaded {
  const row = db.get<MiningRow>(MINING_ROW_SQL, ref);
  if (row === undefined) {
    return { state: undefined, saved: { cursor: { projectId }, visited: 0, mined: 0, skipped: 0, failures: 0 }, retryAt: null };
  }
  return {
    state: row.state as MiningState,
    saved: {
      cursor: db.open<MiningCursor>("eval_mining", ref, row.payload),
      visited: row.visited,
      mined: row.mined,
      skipped: row.skipped,
      failures: row.failures,
    },
    retryAt: row.retry_at,
  };
}

function save(tx: EvidenceTx, ref: string, state: MiningState, saved: Saved, retryAt: string | null, at: string): void {
  tx.run(
    UPSERT_MINING_SQL,
    ref,
    state,
    saved.visited,
    saved.mined,
    saved.skipped,
    saved.failures,
    retryAt,
    at,
    tx.seal("eval_mining", ref, saved.cursor),
  );
}

/**
 * The cursor after one decided commit: the forward cursor is the commit; the backfill moves to its first parent. A
 * rewrite's head does both, and keeps `visited`, so the 2,000 bound still holds.
 */
function advance(p: Pass, path: CursorPath, commit: string, parent: string | undefined): MiningCursor {
  if (path === "forward") return { ...p.cursor, forward: commit };
  const bf = p.cursor.backfill ?? { next: commit, visited: 0, done: false };
  const backfill = { next: parent ?? commit, visited: bf.visited + (path === "backfill" ? 1 : 0), done: parent === undefined };
  return { ...p.cursor, ...(path === "rewrite" ? { forward: commit } : {}), backfill };
}

function minedInput(projectId: string, commit: string, verdict: CandidateVerdict | Extract<Verdict, { kind: "reject" }>): MinedInsert {
  if (verdict.kind === "reject") return { kind: "rejected", projectId, commit, reason: verdict.reason };
  return {
    kind: "candidate", projectId, commit, parent: verdict.parent, commitTime: verdict.commitTime, capsule: verdict.capsule,
    promptOrigin: verdict.promptOrigin, files: verdict.files, hiddenFiles: verdict.hiddenFiles, features: verdict.features,
    ...(verdict.runId !== undefined ? { runId: verdict.runId } : {}),
  };
}

/**
 * The group step of a new candidate, in the write that inserted it. A run group that landed the commit is joined, `clear`.
 * Otherwise the lineage roots merge `devOnly`: `unclear`, or `clear` with none. More than 64 roots rejects the commit.
 */
export function placeMined(tx: EvidenceTx, input: MinedCandidate, at: string): void {
  const projectRef = tx.index("project", input.projectId);
  const commitRef = tx.index("eval-commit", input.commit);
  const taskId = minedTaskId(projectRef, commitRef);
  const landed = tx.get<{ group_id: string }>(LANDING_JOIN_SQL, projectRef, commitRef);
  if (landed !== undefined) {
    applyDuplicateRule(tx, mergeRoots(tx, [taskId, rootOf(tx, landed.group_id)], false), at);
    setLineage(tx, taskId, "clear");
    return;
  }
  const lineage = lineageRoots(tx, { pathRefs: input.files.map(file => pathRef(tx, input.projectId, file)), commitTime: input.commitTime });
  if ("tooWide" in lineage) {
    rejectTask(tx, taskId, "lineage-too-wide", at, input.projectId);
    return;
  }
  if (lineage.roots.length === 0) {
    setLineage(tx, taskId, "clear");
    return;
  }
  applyDuplicateRule(tx, mergeRoots(tx, [taskId, ...lineage.roots], true), at);
  setLineage(tx, taskId, "unclear");
}

function setLineage(tx: EvidenceTx, taskId: string, lineage: "clear" | "unclear"): void {
  tx.run("UPDATE eval_tasks SET lineage = ? WHERE task_id = ?", lineage, taskId);
}

function isoAfter(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

/** Code-unit order, the order SQLite's BINARY collation gives for these ASCII keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
