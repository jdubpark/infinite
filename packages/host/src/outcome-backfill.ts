import { profileIdentityKey } from "./config-identity.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import { type EvidenceIndexClass, canonicalJson } from "./evidence/crypto.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import { type Disposition, type Flag, type LinkState, exclusionOf, levels, replaces, reportDisposition, roundCounts } from "./outcome-rules.js";
import { OUTCOMES_MODULE, type OutcomePayload, type OutcomeRow, type RunSummaryPayload, type RunSummaryRow, readOutcome, readSummary, writeOutcome, writeSummary } from "./outcome-store.js";
import { type FeatureMap, taskFeatures } from "./task-features.js";
import { profileIdentity, runEventKey, runSummaryCounts } from "./run-events.js";
import type { TeamMember, TeamRun, TeamTask } from "./team-types.js";

/**
 * Rows from sealed run records that predate outcome emission (spec delivery order 2). Backfilled rows carry the
 * `backfilled` flag and never overwrite an event-derived row. The functions here hold no clock, store, or Git
 * access except `backfillTick`, which writes through the store.
 */

const DEFAULT_LIMIT = 20;
/** The stop reason the team service writes for a member with no activity. */
const NO_ACTIVITY = "No activity for ";
const UNKNOWN = "(unknown)";
const UNKNOWN_FEATURE_MAP = "unknown";
/** The project a summary holds when an event other than `run.created` made it (the projector's sentinel). */
const EVENT_UNKNOWN_PROJECT = "unknown";
/** Run statuses after which no event will change the run. */
const SETTLED: ReadonlySet<string> = new Set(["ready-for-review", "merged", "no-change", "cancelled"]);

type WriteOutcome = "written" | "unreadable";
/** A store failure inside the backfill. It leaves the run pending instead of marking the record. */
class StoreFailure extends Error {}
/** Logged once per process, so a bad record or a failing store never floods the log. */
let loggedUnreadable = false;
let loggedFailure = false;

type BackfillContext = {
  map?: FeatureMap;
  epoch: (identity: string, at: string) => number;
  index: (cls: EvidenceIndexClass, value: string) => string;
};

type Snapshot = { revision: number; tasks: TeamTask[]; review?: TeamRun["review"] };

/**
 * Pure. Paths are read for features and dropped. A member whose ending the record cannot show is skipped and
 * counted. For an integrated row, accepted is yes only under an approved review of the same snapshot and is never
 * no, and held stays unknown. A counted failure is no on every level, as for any row.
 */
export function backfillRun(run: TeamRun, context: BackfillContext): { rows: OutcomeRow[]; summary: RunSummaryRow; skipped: number; rounds: number } {
  const snapshots: Snapshot[] = [
    { revision: run.revision, tasks: run.tasks, review: run.review },
    ...(run.continuations ?? []).map(continuation => ({ revision: continuation.revision, tasks: continuation.tasks, review: continuation.review })),
  ];
  const rounds = runRounds(run, snapshots);
  const goal = run.goal ? { id: run.goal.id, cycle: run.goal.cycle } : undefined;
  const rows: OutcomeRow[] = [];
  let skipped = 0;

  for (const [position, member] of run.members.entries()) {
    if (member.role !== "implementer" && member.role !== "scout") {
      skipped++;
      continue;
    }
    const snapshot = member.role === "implementer" ? snapshotOf(snapshots, member) : undefined;
    const task = snapshot?.tasks.find(item => item.id === member.taskId);
    const disposition = endingOf(run, member, task);
    if (disposition === undefined) {
      skipped++;
      continue;
    }

    const group = run.members.slice(0, position).filter(earlier => earlier.revision === member.revision
      && earlier.role === member.role && earlier.taskId === member.taskId);
    const inherited = group.some(earlier => earlier.cwd === member.cwd);
    const features = member.role === "scout"
      ? taskFeatures({ role: "scout", paths: [] }, context.map)
      : task
        ? taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, context.map)
        : undefined;
    const sentinel = features === undefined;
    const area = features?.area ?? UNKNOWN;
    const identity = profileIdentity(member.modelProfile, member.provider ?? run.provider);
    const model = identity.model ?? "default";
    const effort = identity.effort ?? null;
    const epoch = context.epoch(profileIdentityKey({ provider: identity.provider, model: identity.model ?? null, effort }), member.startedAt ?? run.createdAt);

    const covering = snapshot !== undefined && snapshot.review !== undefined && snapshot.review.revision === snapshot.revision;
    const accepted = disposition === "integrated" && covering && snapshot.review?.verdict === "approved" ? 1 : null;
    const links: LinkState[] = Array.from({ length: rounds }, (): LinkState => "unknown");
    // Only an approval is kept. A stored review that requested changes would freeze as accepted no at a later
    // settle, and the backfill never claims that.
    const lastReview = covering && snapshot.review?.verdict === "approved" ? "approved" as const : undefined;
    const counts = roundCounts(links);
    const integrated = disposition === "integrated";

    const payload: OutcomePayload = {
      projectId: run.projectId,
      taskId: member.taskId ?? UNKNOWN,
      area,
      featureMap: features?.featureMap ?? UNKNOWN_FEATURE_MAP,
      ...(goal ? { goal } : {}),
      ...(run.missionId ? { missionId: run.missionId } : {}),
      ...(lastReview ? { lastReview } : {}),
      rounds: counts,
      ...(integrated && task?.rubric ? { rubric: rubricOf(task.rubric) } : {}),
      ...(integrated && task?.ownerRating ? { ownerRating: { score: task.ownerRating.score, at: task.ownerRating.at } } : {}),
      ...(integrated && task?.diffStat ? { diff: { ...task.diffStat } } : {}),
      limitEvents: (task?.limitSwitches ?? []).filter(item => item.memberId === member.memberId).length,
      costCoverage: "none",
    };
    const flags: Flag[] = ["backfilled"];
    if (integrated && task?.commit === undefined) flags.push("empty-result");
    if (sentinel && member.role === "implementer") flags.push("gap");

    const lv = levels({ role: member.role, disposition, accepted, links });
    rows.push({
      outcomeId: `${run.id}:${member.memberId}`,
      source: "production",
      projectRef: context.index("project", run.projectId),
      taskRef: context.index("task", payload.taskId),
      areaRef: context.index("area", area),
      runId: run.id,
      revision: member.revision,
      memberId: member.memberId,
      sessionId: member.sessionId,
      attemptIndex: group.length + 1,
      inherited,
      role: member.role,
      profileId: identity.profileId ?? "default",
      provider: identity.provider,
      model,
      effort,
      profileEpoch: epoch,
      configId: null,
      experimentRef: null,
      kind: features?.kind ?? null,
      risk: features?.risk ?? "unknown",
      featureVersion: features?.featureVersion ?? 0,
      disposition,
      exclusion: exclusionOf(disposition) ?? null,
      flags,
      integrated: lv.integrated,
      accepted: lv.accepted,
      firstPass: lv.firstPass,
      held: lv.held,
      startedAt: member.startedAt ?? null,
      endedAt: member.reportedAt ?? member.stalledAt ?? null,
      frozenAt: null,
      holdUntil: null,
      runDeletedAt: null,
      payload,
    });
  }

  const attempts: Partial<Record<Disposition, number>> = {};
  for (const row of rows) attempts[row.disposition] = (attempts[row.disposition] ?? 0) + 1;
  const payload: RunSummaryPayload = {
    projectId: run.projectId,
    ...(goal ? { goal } : {}),
    ...(run.missionId ? { missionId: run.missionId } : {}),
    counts: runSummaryCounts(run),
    attempts,
    rounds: { total: rounds, attributed: 0, unattributed: 0, unknown: rounds },
    ...(run.baseCommit ? { currentBase: run.baseCommit } : {}),
  };
  const summary: RunSummaryRow = {
    runId: run.id,
    source: "production",
    projectRef: context.index("project", run.projectId),
    revision: run.revision,
    status: run.status,
    blockCode: run.blockCode ?? null,
    flags: ["backfilled"],
    createdAt: run.createdAt,
    settledAt: null,
    approvedAt: null,
    runDeletedAt: null,
    payload,
  };
  return { rows, summary, skipped, rounds };
}

/**
 * Backfills every qualifying run that is not settled and at most `limit` settled ones, one store write each. A run
 * qualifies when the store has no `run.created` event for it and no `backfill_runs` row. An existing row or summary is
 * never overwritten. A run whose record cannot be read, or lacks a field a row needs, is marked with `skipped` -1
 * and never retried, so the write step fails only for a reason of the store.
 *
 * Returns `{ written: 0, remaining: 0 }` at once, before `runs()` is called, when the store, the `outcomes` module,
 * or the `configurations` module is not ready. A module that is not ready stays so for the life of the process, and
 * the next start tries again. Never throws.
 */
export function backfillTick(store: EvidenceStore, runs: () => TeamRun[], options: { mapOf: (projectId: string) => FeatureMap | undefined; limit?: number; now: () => string }): { written: number; remaining: number } {
  try {
    if (!ready(store)) return { written: 0, remaining: 0 };
    const limit = options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : DEFAULT_LIMIT;
    const pending = runs().filter(run => !store.hasEvent(runEventKey("run.created", run.id)) && !hasBackfillRow(store, run.id));
    // Every run that can still emit an event is written now, so none of its events is projected before its rows.
    // Settled runs are history, and take `limit` per tick.
    const ordered = [...pending.filter(run => !SETTLED.has(run.status)), ...pending.filter(run => SETTLED.has(run.status)).slice(0, limit)];
    let written = 0;
    for (const run of ordered) {
      const seen: { outcome?: WriteOutcome } = {};
      const done = store.tryWrite(tx => { seen.outcome = writeRun(store, tx, run, options); });
      if (!done) continue;
      written++;
      if (seen.outcome === "unreadable" && !loggedUnreadable) {
        loggedUnreadable = true;
        console.warn("Outcome backfill marked a run record that could not be read.");
      }
    }
    return { written, remaining: pending.length - written };
  } catch {
    if (!loggedFailure) {
      loggedFailure = true;
      console.warn("Outcome backfill failed.");
    }
    return { written: 0, remaining: 0 };
  }
}

/**
 * The driver the server calls. Its first call writes EVERY pending run, so a reader of the rows never sees a part
 * of the history as if it were all of it. Later calls write at most `limit` settled runs, for a run whose write
 * failed. Once a call reports nothing remaining, the driver does nothing for the life of the process.
 */
export function outcomeBackfill(store: EvidenceStore, runs: () => TeamRun[], options: { mapOf: (projectId: string) => FeatureMap | undefined; limit?: number; now: () => string }): () => void {
  let done = false;
  let first = true;
  return () => {
    if (done) return;
    const tick = backfillTick(store, runs, first ? { ...options, limit: Number.MAX_SAFE_INTEGER } : options);
    // One fixed line: the first call writes one run after another before the host serves, and this explains the wait.
    if (first && tick.written > 0) console.log(`Outcome backfill wrote ${tick.written} run(s) at start; ${tick.remaining} remain.`);
    first = false;
    if (tick.remaining === 0) done = true;
  };
}

function ready(store: EvidenceStore): boolean {
  const status = store.status();
  return status.state === "ready" && status.modules[OUTCOMES_MODULE] === "ready" && status.modules[CONFIGURATIONS_MODULE] === "ready";
}

/** Writes one run inside the caller's transaction. Store errors propagate and leave the run pending. */
function writeRun(store: EvidenceStore, tx: EvidenceTx, run: TeamRun, options: { mapOf: (projectId: string) => FeatureMap | undefined; now: () => string }): WriteOutcome {
  const map = options.mapOf(run.projectId);
  let result: ReturnType<typeof backfillRun>;
  try {
    result = backfillRun(run, {
      map,
      epoch: (identity, at) => { const since = text(at); return storeCall(() => epochAt(tx, identity, since)); },
      index: (cls, value) => { const plain = text(value); return storeCall(() => tx.index(cls, plain)); },
    });
    // A legacy record can lack a field its type requires. Such a value cannot be bound, so the record is unreadable.
    if (!bindable(run, result)) throw new TypeError("The record lacks a field a row needs.");
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    tx.run("INSERT INTO backfill_runs (run_id, at, rows, skipped) VALUES (?, ?, 0, -1) ON CONFLICT(run_id) DO NOTHING", run.id, options.now());
    return "unreadable";
  }
  const inserted: string[] = [];
  for (const row of result.rows) {
    if (readOutcome(tx, row.outcomeId) !== undefined) continue;
    writeOutcome(tx, row);
    inserted.push(row.outcomeId);
  }
  const existing = readSummary(tx, run.id);
  if (existing === undefined) writeSummary(tx, result.summary);
  else if (existing.payload.projectId === EVENT_UNKNOWN_PROJECT) {
    // An event reached this run before its backfill and made a summary with no `run.created` facts. Every event
    // fact stays. The record supplies the project, goal, mission, and creation time, and the summary is marked.
    existing.payload.projectId = result.summary.payload.projectId;
    if (result.summary.payload.goal) existing.payload.goal = result.summary.payload.goal;
    if (result.summary.payload.missionId) existing.payload.missionId = result.summary.payload.missionId;
    existing.createdAt ??= result.summary.createdAt;
    // The gap flag stood for the missing `run.created` facts. It stays only when the ledger recorded lost events,
    // so that a later row of the run does not copy a gap that never was.
    const lost = store.eventsIn(tx, { runId: run.id, kinds: ["ledger.gap"], after: 0, limit: 1 }).events.length > 0;
    const flags = new Set<Flag>(existing.flags);
    flags.add("backfilled");
    if (!lost) flags.delete("gap");
    existing.flags = [...flags].sort();
    writeSummary(tx, existing);
  }
  for (let round = 1; round <= result.rounds; round++) {
    tx.run(
      "INSERT OR IGNORE INTO outcome_rounds (run_id, revision, round, cause, state, started_at, run_deleted_at) VALUES (?, 0, ?, 'unknown', 'unknown', ?, NULL)",
      run.id,
      round,
      run.createdAt,
    );
    for (const outcomeId of inserted) {
      tx.run(
        "INSERT OR IGNORE INTO outcome_round_links (outcome_id, run_id, revision, round, state) VALUES (?, ?, 0, ?, 'unknown')",
        outcomeId,
        run.id,
        round,
      );
    }
  }
  tx.run(
    "INSERT INTO backfill_runs (run_id, at, rows, skipped) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING",
    run.id,
    options.now(),
    inserted.length,
    result.skipped,
  );
  return "written";
}

/** A record value that a store call takes as text. A record that lacks it is unreadable, and no store call is made. */
function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("The record lacks a text field.");
  return value;
}

/** Whether every value the write binds is plain. The write step then fails only for a reason of the store. */
function bindable(run: TeamRun, result: ReturnType<typeof backfillRun>): boolean {
  const plain = (value: unknown) => value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
  const columns = (row: OutcomeRow | RunSummaryRow) => Object.entries(row)
    .every(([name, value]) => name === "payload" || name === "flags" || plain(value));
  // A payload is sealed as canonical JSON, which refuses a value that JSON cannot hold, such as a missing field.
  const sealable = (payload: unknown) => { canonicalJson(payload); return true; };
  return typeof run.id === "string" && typeof run.createdAt === "string"
    && columns(result.summary) && typeof result.summary.payload.projectId === "string" && sealable(result.summary.payload)
    && result.rows.every(row => columns(row) && typeof row.payload.projectId === "string"
      && typeof row.payload.taskId === "string" && typeof row.payload.area === "string" && sealable(row.payload));
}

/** Runs a store call and marks its failure, so the record is not blamed for it. */
function storeCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new StoreFailure(error instanceof Error ? error.message : "store call failed");
  }
}

function hasBackfillRow(store: EvidenceStore, runId: string): boolean {
  return store.read(db => db.get("SELECT 1 AS found FROM backfill_runs WHERE run_id=?", runId) !== undefined);
}

/** The snapshot of the member's revision that holds the member's task. Undefined when no snapshot holds it. */
function snapshotOf(snapshots: readonly Snapshot[], member: TeamMember): Snapshot | undefined {
  return snapshots.find(snapshot => snapshot.revision === member.revision
    && snapshot.tasks.some(item => item.id === member.taskId));
}

/**
 * The member's ending from the record, folded by the precedence rules. Undefined when the record shows none, such
 * as an owner stop, which the record does not name.
 */
function endingOf(run: TeamRun, member: TeamMember, task: TeamTask | undefined): Disposition | undefined {
  const candidates: (Disposition | undefined)[] = [];
  if (member.role === "scout") {
    const discovery = run.discovery;
    const done = discovery?.revision === member.revision && discovery.tasks.some(item => item.memberId === member.memberId && item.status === "complete");
    candidates.push(done ? "completed" : undefined);
  } else {
    candidates.push(task?.status === "integrated" && task.memberId === member.memberId ? "integrated" : undefined);
    candidates.push(task?.escalation?.memberId === member.memberId ? "escalated" : undefined);
    candidates.push(task?.limitSwitches?.some(item => item.memberId === member.memberId) ? "limit" : undefined);
  }
  candidates.push(member.stalledAt !== undefined || member.stoppedReason?.startsWith(NO_ACTIVITY) ? "stalled" : undefined);
  candidates.push(member.report ? reportDisposition(member.report.kind) : undefined);

  let current: Disposition = "open";
  for (const next of candidates) {
    if (next !== undefined && replaces(current, next)) current = next;
  }
  return current === "open" ? undefined : current;
}

/**
 * The correction rounds the run shows: the largest per-task review round count, and at least one when a check
 * launched by a correction round exists. Each row's links keep this many unknown rounds, so no firstPass is claimed.
 */
function runRounds(run: TeamRun, snapshots: readonly Snapshot[]): number {
  let rounds = 0;
  for (const snapshot of snapshots) {
    for (const item of snapshot.tasks) rounds = Math.max(rounds, item.reviewRounds ?? 0);
  }
  if (run.checks.some(check => (check.round ?? 0) > 0)) rounds = Math.max(rounds, 1);
  return rounds;
}

function rubricOf(rubric: NonNullable<TeamTask["rubric"]>): NonNullable<OutcomePayload["rubric"]> {
  return {
    version: 1,
    correctness: rubric.correctness.score,
    cleanliness: rubric.cleanliness.score,
    extensibility: rubric.extensibility.score,
    docs: rubric.docs.score,
    reviewerProfileId: rubric.reviewerProfileId,
  };
}
