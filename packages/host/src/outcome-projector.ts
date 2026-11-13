import { type ConfigComponents, configId, profileIdentityKey } from "./config-identity.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import type { EventProjector } from "./evidence/outbox.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx, RunEvent } from "./evidence/types.js";
import {
  BLOCK_DISPOSITIONS,
  type Disposition,
  exclusionOf,
  type Flag,
  freezeAccepted,
  levels,
  type LinkState,
  linkAfterPaths,
  reportDisposition,
  replaces,
  roundCounts,
  type RowState,
  stopDisposition,
} from "./outcome-rules.js";
import {
  readMemberResult,
  readOutcome,
  readSummary,
  type MemberResultDisposition,
  type MemberResultRow,
  OUTCOME_KINDS,
  OUTCOMES_MODULE,
  type OutcomePayload,
  type OutcomeRow,
  type RunSummaryPayload,
  type RunSummaryRow,
  runOutcomes,
  writeMemberResult,
  writeOutcome,
  writeSummary,
} from "./outcome-store.js";
import { MEMBER_STOP_REASONS, type MemberStopReason, type ReplacementCause, type RunSummaryCounts } from "./run-events.js";

const UNKNOWN = "unknown";
const DEFAULT_PROFILE = "default";
const UNKNOWN_AREA = "(unknown)";
const UNKNOWN_FEATURE_MAP = "unknown";
const EVENT_PAGE = 500;
const REPLACEMENT_CAUSES: readonly string[] = ["stall", "limit", "escalation", "answer"];
const STOP_REASONS: readonly string[] = MEMBER_STOP_REASONS;
const COUNT_KEYS = [
  "tasks", "integrated", "members", "round", "checks", "recoveries", "decisionsByOwner",
  "decisionsByCoordinator", "steering", "permissionEscalations", "continuations",
] as const;

type RowRole = RowState["role"];
type Data = Record<string, unknown>;
type Facts = { projectId: string; goal?: OutcomePayload["goal"]; missionId?: string; gap: boolean };
type Features = { area: string; kind: string | null; risk: string; featureVersion: number; featureMap: string };
type Ctx = { tx: EvidenceTx; store: EvidenceStore; event: RunEvent; log: (line: string) => void };

/**
 * The `outcomes` projector (spec parts 3 and 4). It turns the run events into one row per attempt, one summary per
 * run, and one member result per member without a task. Every rule reads `seq` order and the event's own time, never
 * the clock. Every write is a set or a recount, so a replayed page writes the same rows. No path or text is written:
 * owned and changed paths are compared in memory and dropped. It throws while the configurations module is not ready,
 * so its page rolls back and the cursor waits.
 */
export function outcomeProjector(store: EvidenceStore, options?: { log?: (line: string) => void }): EventProjector {
  const log = options?.log ?? ((line: string) => console.warn(line));
  return {
    name: "outcomes",
    module: OUTCOMES_MODULE,
    kinds: OUTCOME_KINDS,
    project(tx, event) {
      if (store.status().modules[CONFIGURATIONS_MODULE] !== "ready") {
        throw new Error("The configurations module is unavailable.");
      }
      apply({ tx, store, event, log });
      tx.run(
        "INSERT INTO outcome_state (key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        event.seq,
      );
    },
  };
}

function apply(ctx: Ctx): void {
  switch (ctx.event.kind) {
    case "run.created": return runCreated(ctx);
    case "run.prepared": return runPrepared(ctx);
    case "member.started": return memberStarted(ctx);
    case "member.configured": return memberConfigured(ctx);
    case "member.reported": return memberReported(ctx);
    case "member.stopped": return memberStopped(ctx);
    case "task.integrated": return taskIntegrated(ctx);
    case "scout.completed": return scoutCompleted(ctx);
    case "task.escalated": return taskEscalated(ctx);
    case "review.recorded": return reviewRecorded(ctx);
    case "review.tree": return reviewTree(ctx);
    case "repair.started": return repairStarted(ctx);
    case "repair.integrated": return repairIntegrated(ctx);
    case "repair.paths": return repairPaths(ctx);
    case "delivery.recorded": return deliveryRecorded(ctx);
    case "rating.recorded": return ratingRecorded(ctx);
    case "run.blocked": return runBlocked(ctx);
    case "run.revision-advanced": return revisionAdvanced(ctx);
    case "run.settled": return runSettled(ctx);
    case "ledger.gap": return ledgerGap(ctx);
    default: return; // run.deleted: the deleteRun hook stamps the rows, and the cursor advances.
  }
}

function runCreated({ tx, event }: Ctx): void {
  const summary = ensureSummary(tx, event, true);
  const data = event.data;
  summary.payload.projectId = str(data.projectId) ?? UNKNOWN;
  const goal = goalOf(data);
  if (goal) summary.payload.goal = goal;
  const missionId = str(data.missionId);
  if (missionId) summary.payload.missionId = missionId;
  summary.revision = event.revision;
  summary.createdAt = event.at;
  writeSummary(tx, summary);
}

function runPrepared({ tx, event }: Ctx): void {
  const summary = ensureSummary(tx, event);
  const base = str(event.data.baseCommit);
  if (base) summary.payload.currentBase = base;
  writeSummary(tx, summary);
}

function memberStarted(ctx: Ctx): void {
  const { tx, event } = ctx;
  const data = event.data;
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const role = str(data.role) ?? UNKNOWN;
  const facts = factsOf(tx, event);
  const provider = str(data.provider);
  const modelName = str(data.model);
  const effort = str(data.effort) ?? null;
  const startedAt = str(data.startedAt) ?? event.at;
  // An unknown provider has no identity, so its epoch is 0 and the row carries a gap.
  const epoch = provider === undefined
    ? 0
    : epochAt(tx, profileIdentityKey({ provider, model: modelName ?? null, effort }), startedAt);
  const sessionId = str(data.sessionId) ?? null;
  const replacement = replacementOf(data.replaces);
  const profileId = str(data.profileId) ?? DEFAULT_PROFILE;
  const model = modelName ?? DEFAULT_PROFILE;
  if (isRowRole(role)) {
    const runId = event.runId;
    const row = readOutcome(tx, outcomeId(runId, memberId)) ?? blankOutcome(ctx, memberId, role, facts, facts.gap ? ["gap"] : []);
    const predecessor = replacement ? readOutcome(tx, outcomeId(runId, replacement.memberId)) : undefined;
    row.revision = event.revision;
    row.sessionId = sessionId;
    // A predecessor with no start holds the sentinel 0, and its replacement is still the second attempt.
    row.attemptIndex = replacement ? (predecessor ? Math.max(predecessor.attemptIndex, 1) + 1 : 2) : 1;
    row.inherited = replacement !== undefined;
    row.profileId = profileId;
    row.provider = provider ?? UNKNOWN;
    row.model = model;
    row.effort = effort;
    row.profileEpoch = epoch;
    row.startedAt = startedAt;
    row.payload = { ...row.payload, ...payloadFacts(facts), ...(replacement ? { replaces: replacement } : {}) };
    const features = startFeatures(ctx, role);
    if (features) applyFeatures(row, features);
    else row.flags = withFlag(row.flags, "gap");
    if (provider === undefined) row.flags = withFlag(row.flags, "gap");
    saveRow(tx, row);
    return;
  }
  const result = readMemberResult(tx, outcomeId(event.runId, memberId)) ?? blankResult(ctx, memberId, role, facts, facts.gap ? ["gap"] : []);
  result.revision = event.revision;
  result.sessionId = sessionId;
  result.role = role;
  result.profileId = profileId;
  result.provider = provider ?? UNKNOWN;
  result.model = model;
  result.effort = effort;
  result.profileEpoch = epoch;
  result.startedAt = startedAt;
  result.payload = { ...result.payload, projectId: facts.projectId, ...(replacement ? { replaces: replacement } : {}) };
  if (provider === undefined) result.flags = withFlag(result.flags, "gap");
  writeMemberResult(tx, result);
}

function memberConfigured({ tx, event }: Ctx): void {
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const id = configIdOf(event.data);
  if (id === undefined) return;
  const row = readOutcome(tx, outcomeId(event.runId, memberId));
  if (row) {
    row.configId = id;
    saveRow(tx, row);
    return;
  }
  const result = readMemberResult(tx, outcomeId(event.runId, memberId));
  if (result) {
    result.configId = id;
    writeMemberResult(tx, result);
  }
}

function memberReported(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const kind = str(event.data.reportKind);
  const role = str(event.data.role) ?? UNKNOWN;
  if (isRowRole(role)) {
    const row = readOutcome(tx, outcomeId(event.runId, memberId)) ?? sentinelRow(ctx, memberId, role);
    const next = kind === undefined ? undefined : reportDisposition(kind);
    // A question or a blocker ends the attempt at its report.
    if (next !== undefined && replaces(row.disposition, next)) {
      row.disposition = next;
      row.endedAt = event.at;
    }
    saveRow(tx, row);
    return;
  }
  const result = readMemberResult(tx, outcomeId(event.runId, memberId)) ?? sentinelResult(ctx, memberId, role);
  if (result.disposition === "open") {
    result.disposition = "reported";
    result.reportKind = kind ?? null;
    result.endedAt = event.at;
  }
  writeMemberResult(tx, result);
}

function memberStopped(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  const reason = str(event.data.reason);
  if (memberId === undefined || reason === undefined || !STOP_REASONS.includes(reason)) return;
  const next = stopDisposition(reason as MemberStopReason);
  const role = str(event.data.role) ?? UNKNOWN;
  if (isRowRole(role)) {
    const row = readOutcome(tx, outcomeId(event.runId, memberId)) ?? sentinelRow(ctx, memberId, role);
    if (replaces(row.disposition, next)) {
      row.disposition = next;
      row.endedAt = event.at;
    }
    saveRow(tx, row);
    return;
  }
  const result = readMemberResult(tx, outcomeId(event.runId, memberId)) ?? sentinelResult(ctx, memberId, role);
  if (result.disposition === "open") {
    result.disposition = next as MemberResultDisposition;
    result.endedAt = event.at;
  }
  writeMemberResult(tx, result);
}

function taskIntegrated(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const data = event.data;
  const row = readOutcome(tx, outcomeId(event.runId, memberId)) ?? sentinelRow(ctx, memberId, "implementer");
  if (replaces(row.disposition, "integrated")) {
    // A stored acceptance belongs to an integration. Only a review of this integration sets it.
    if (row.disposition !== "integrated") row.accepted = null;
    row.disposition = "integrated";
    row.endedAt = event.at;
  }
  const base = str(data.baseCommit);
  if (base !== undefined) row.payload.baseCommit = base;
  const diff = diffOf(data.diff);
  if (diff) row.payload.diff = diff;
  // An integration with no commit changed nothing, so the attempt is an empty result.
  if (str(data.commit) === undefined) row.flags = withFlag(row.flags, "empty-result");
  saveRow(tx, row);
  const summary = ensureSummary(tx, event);
  if (base !== undefined) summary.payload.currentBase = base;
  writeSummary(tx, summary);
}

function scoutCompleted(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const row = readOutcome(tx, outcomeId(event.runId, memberId)) ?? sentinelRow(ctx, memberId, "scout");
  if (replaces(row.disposition, "completed")) {
    row.disposition = "completed";
    row.endedAt = event.at;
  }
  saveRow(tx, row);
}

function taskEscalated(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  if (memberId === undefined) return;
  const row = readOutcome(tx, outcomeId(event.runId, memberId)) ?? sentinelRow(ctx, memberId, "implementer");
  if (replaces(row.disposition, "escalated")) {
    row.disposition = "escalated";
    row.endedAt = event.at;
  }
  saveRow(tx, row);
}

function reviewRecorded(ctx: Ctx): void {
  const { tx, event } = ctx;
  const data = event.data;
  const verdict = str(data.verdict);
  const head = str(data.headCommit);
  const base = str(data.baseCommit);
  const summary = ensureSummary(tx, event);
  if (head !== undefined) {
    // The reviewed head, its tree, and its approval are one fact: a tree of another head does not stand.
    if (summary.payload.reviewedHead !== head) delete summary.payload.reviewedTree;
    summary.payload.reviewedHead = head;
  }
  if (base !== undefined) summary.payload.currentBase = base;
  summary.approvedAt = verdict === "approved" ? event.at : null;
  writeSummary(tx, summary);
  if (base === undefined || (verdict !== "approved" && verdict !== "changes-requested")) return;
  const reviewer = obj(data.reviewer);
  const reviewerProfile = str(reviewer?.profileId) ?? UNKNOWN;
  const reviewerModel = str(reviewer?.model);
  const rubric = arrayOf(data.rubric).map(obj).filter((entry): entry is Data => entry !== undefined);
  for (const row of runOutcomes(tx, event.runId)) {
    if (row.disposition !== "integrated" || row.frozenAt !== null || row.payload.baseCommit !== base) continue;
    row.payload.lastReview = verdict;
    if (verdict === "approved") {
      row.accepted = 1;
      if (reviewerModel !== undefined && reviewerModel === row.model) row.flags = withFlag(row.flags, "same-model-review");
      const entry = rubric.find(item => item.taskId === row.payload.taskId);
      const kept = entry ? rubricOf(entry, reviewerProfile) : undefined;
      if (kept) row.payload.rubric = kept;
    }
    saveRow(tx, row);
  }
}

function reviewTree({ tx, event }: Ctx): void {
  const head = str(event.data.headCommit);
  const tree = str(event.data.tree);
  const summary = readSummary(tx, event.runId);
  if (!summary || head === undefined || tree === undefined || summary.payload.reviewedHead !== head) return;
  summary.payload.reviewedTree = tree;
  writeSummary(tx, summary);
}

function repairStarted(ctx: Ctx): void {
  const { tx, event } = ctx;
  const round = num(event.data.round);
  if (round === undefined) return;
  const cause = str(event.data.cause) ?? UNKNOWN;
  tx.run(
    "INSERT INTO outcome_rounds (run_id, revision, round, cause, state, started_at, run_deleted_at) VALUES (?, ?, ?, ?, 'started', ?, NULL) "
    + "ON CONFLICT(run_id, revision, round) DO UPDATE SET cause=excluded.cause, state=excluded.state, started_at=excluded.started_at",
    event.runId,
    event.revision,
    round,
    cause,
    event.at,
  );
  const base = readSummary(tx, event.runId)?.payload.currentBase;
  for (const row of runOutcomes(tx, event.runId)) {
    if (row.disposition !== "integrated" || row.frozenAt !== null) continue;
    if (base !== undefined && row.payload.baseCommit !== base) continue;
    setLink(tx, row.outcomeId, event.runId, event.revision, round, "pending");
    saveRow(tx, row);
  }
}

function repairIntegrated(ctx: Ctx): void {
  const { tx, event } = ctx;
  const round = num(event.data.round);
  if (round === undefined) return;
  const commit = str(event.data.commit);
  const base = str(event.data.baseCommit);
  ensureRound(tx, event, round);
  const touched = new Set<string>();
  for (const link of roundLinks(tx, event, round)) {
    if (link.state !== "pending") continue;
    const row = readOutcome(tx, link.outcome_id);
    if (!row) continue;
    // A row with another base is not in this round's scope. Without a commit, nothing is left to answer.
    const otherBase = base !== undefined && row.payload.baseCommit !== base;
    if (commit === undefined || otherBase) {
      setLink(tx, row.outcomeId, event.runId, event.revision, round, "clear");
      touched.add(row.outcomeId);
    }
  }
  for (const id of touched) saveRow(tx, readOutcome(tx, id)!);
  setRoundState(tx, event, round, commit === undefined ? "resolved" : "answered");
}

function repairPaths(ctx: Ctx): void {
  const { tx, event } = ctx;
  const round = num(event.data.round);
  if (round === undefined) return;
  const changed: string[] | "omitted" = Array.isArray(event.data.paths) && event.data.paths.every(item => typeof item === "string")
    ? event.data.paths as string[]
    : "omitted";
  ensureRound(tx, event, round);
  const planned = eventsOf(ctx, ["task.planned"]);
  const touched: string[] = [];
  for (const link of roundLinks(tx, event, round)) {
    if (link.state !== "pending") continue;
    const row = readOutcome(tx, link.outcome_id);
    if (!row) continue;
    setLink(tx, row.outcomeId, event.runId, event.revision, round, linkAfterPaths(ownedPaths(row, planned), changed));
    touched.push(row.outcomeId);
  }
  for (const id of touched) saveRow(tx, readOutcome(tx, id)!);
  setRoundState(tx, event, round, changed === "omitted" ? "unknown" : "resolved");
  // A path event after the settle still corrects the summary's rounds.
  const summary = readSummary(tx, event.runId);
  if (summary) {
    summary.payload.rounds = roundTotals(tx, event.runId);
    writeSummary(tx, summary);
  }
}

/**
 * The run's rounds, counted per round. A round is attributed when one of its links is attributed; else unknown when
 * its state is not resolved or one of its links is pending or unknown; else unattributed, which includes a resolved
 * round with no link.
 */
function roundTotals(tx: EvidenceDb, runId: string): RunSummaryPayload["rounds"] {
  const rounds = tx.all<{ revision: number; round: number; state: string }>(
    "SELECT revision, round, state FROM outcome_rounds WHERE run_id=?",
    runId,
  );
  const totals = { total: rounds.length, attributed: 0, unattributed: 0, unknown: 0 };
  for (const round of rounds) {
    const states = tx.all<{ state: string }>(
      "SELECT state FROM outcome_round_links WHERE run_id=? AND revision=? AND round=?",
      runId,
      round.revision,
      round.round,
    ).map(link => link.state);
    if (states.includes("attributed")) totals.attributed += 1;
    else if (round.state !== "resolved" || states.some(state => state === "pending" || state === "unknown")) totals.unknown += 1;
    else totals.unattributed += 1;
  }
  return { total: totals.total, attributed: totals.attributed, unattributed: totals.unattributed, unknown: totals.unknown };
}

function deliveryRecorded({ tx, event }: Ctx): void {
  const summary = ensureSummary(tx, event);
  const method = str(event.data.method);
  if (method === "pull-request") summary.payload.deliveryMethod = "pull-request";
  if (method === "merge") {
    summary.payload.deliveryMethod = "merge";
    const merge = str(event.data.mergeCommit);
    if (merge !== undefined) summary.payload.mergeCommit = merge;
  }
  writeSummary(tx, summary);
}

function ratingRecorded(ctx: Ctx): void {
  const { tx, event } = ctx;
  const memberId = event.memberId;
  const score = num(event.data.score);
  if (memberId === undefined || score === undefined) return;
  // A rating never makes a row: a run that predates emission is backfilled later, and must not be shadowed.
  const row = readOutcome(tx, outcomeId(event.runId, memberId));
  if (!row) return;
  const current = row.payload.ownerRating;
  if (!current || event.at >= current.at) row.payload.ownerRating = { score, at: event.at };
  saveRow(tx, row);
}

function runBlocked(ctx: Ctx): void {
  const { tx, event } = ctx;
  const code = str(event.data.code);
  const summary = ensureSummary(tx, event);
  summary.status = "blocked";
  summary.blockCode = code ?? null;
  writeSummary(tx, summary);
  const source = str(event.data.sourceMemberId);
  if (code !== undefined && source !== undefined) applyBlock(ctx, source, code);
}

function revisionAdvanced(ctx: Ctx): void {
  const { tx, event } = ctx;
  const summary = ensureSummary(tx, event);
  summary.revision = event.revision;
  if (event.data.baseChanged === true) delete summary.payload.currentBase;
  writeSummary(tx, summary);
  // A recovery names the attempt that caused it, so the attempt takes the same disposition as a block.
  const code = str(event.data.sourceCode);
  const source = str(event.data.sourceMemberId);
  if (code !== undefined && source !== undefined) applyBlock(ctx, source, code);
}

/**
 * Freezes the integrated rows the first time they settle. A later late fact still resolves their links, because
 * the rounds predate the freeze. Totals are recounted from the rows, so a replay gives the same summary.
 */
function runSettled(ctx: Ctx): void {
  const { tx, event } = ctx;
  const status = str(event.data.status) ?? null;
  const summary = ensureSummary(tx, event);
  summary.status = status;
  summary.settledAt = event.at;
  const counts = countsOf(event.data.summary);
  if (counts) summary.payload.counts = counts;
  for (const row of runOutcomes(tx, event.runId)) {
    if (row.disposition !== "integrated" || row.frozenAt !== null) continue;
    row.frozenAt = event.at;
    // The backfill never claims a refusal, and a freeze adds none to its rows.
    if (!row.flags.includes("backfilled")) row.accepted = freezeAccepted(row.accepted, row.payload.lastReview, status ?? "");
    saveRow(tx, row);
  }
  const rows = runOutcomes(tx, event.runId);
  const attempts: Partial<Record<Disposition, number>> = {};
  for (const row of rows) attempts[row.disposition] = (attempts[row.disposition] ?? 0) + 1;
  summary.payload.attempts = attempts;
  summary.payload.rounds = roundTotals(tx, event.runId);
  // A block code names the block that stopped the run. A run that settles without one keeps no code.
  if (status !== "blocked") summary.blockCode = null;
  writeSummary(tx, summary);
  const integrated = rows.filter(row => row.revision === event.revision && row.disposition === "integrated").length;
  if (counts && integrated !== counts.integrated) {
    ctx.log(`Outcome rows for revision ${event.revision} count ${integrated} integrated; the run summary counts ${counts.integrated}.`);
  }
}

function ledgerGap({ tx, event }: Ctx): void {
  const summary = ensureSummary(tx, event);
  summary.flags = withFlag(summary.flags, "gap");
  writeSummary(tx, summary);
  for (const row of runOutcomes(tx, event.runId)) {
    if (row.flags.includes("gap")) continue;
    row.flags = withFlag(row.flags, "gap");
    saveRow(tx, row);
  }
  const results = tx.all<{ result_id: string }>("SELECT result_id FROM member_results WHERE run_id=?", event.runId);
  for (const { result_id: resultId } of results) {
    const result = readMemberResult(tx, resultId);
    if (!result || result.flags.includes("gap")) continue;
    result.flags = withFlag(result.flags, "gap");
    writeMemberResult(tx, result);
  }
}

/** Sets a row's disposition from a block code, when the code names one and the row's precedence allows it. */
function applyBlock(ctx: Ctx, memberId: string, code: string): void {
  const next: Disposition | undefined = Object.hasOwn(BLOCK_DISPOSITIONS, code) ? BLOCK_DISPOSITIONS[code] : undefined;
  if (next === undefined) return;
  const row = readOutcome(ctx.tx, outcomeId(ctx.event.runId, memberId));
  if (!row || !replaces(row.disposition, next)) return;
  row.disposition = next;
  // A stop that already ended the attempt keeps its time. An attempt that was still open ends at the block.
  row.endedAt ??= ctx.event.at;
  saveRow(ctx.tx, row);
}

/** Writes a row after its links are read: levels, exclusion, and round counts follow from the stored links. */
function saveRow(tx: EvidenceTx, row: OutcomeRow): void {
  const links = linksOf(tx, row.outcomeId);
  const computed = levels({ role: row.role, disposition: row.disposition, accepted: row.accepted, links });
  row.integrated = computed.integrated;
  row.accepted = computed.accepted;
  row.firstPass = computed.firstPass;
  row.held = computed.held;
  row.exclusion = exclusionOf(row.disposition) ?? null;
  row.payload.rounds = roundCounts(links);
  writeOutcome(tx, row);
}

/** The summary of the run. A summary made by any event other than `run.created` carries a gap. */
function ensureSummary(tx: EvidenceTx, event: RunEvent, created = false): RunSummaryRow {
  const existing = readSummary(tx, event.runId);
  if (existing) return existing;
  return {
    runId: event.runId,
    source: "production",
    projectRef: "",
    revision: event.revision,
    status: null,
    blockCode: null,
    flags: created ? [] : ["gap"],
    createdAt: null,
    settledAt: null,
    approvedAt: null,
    runDeletedAt: null,
    payload: { projectId: UNKNOWN, attempts: {}, rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 } },
  };
}

/** What a new row or member result copies from its run. A run with no summary yet has a gap. */
function factsOf(tx: EvidenceDb, event: RunEvent): Facts {
  const summary = readSummary(tx, event.runId);
  if (!summary) return { projectId: UNKNOWN, gap: true };
  return {
    projectId: summary.payload.projectId,
    ...(summary.payload.goal ? { goal: summary.payload.goal } : {}),
    ...(summary.payload.missionId ? { missionId: summary.payload.missionId } : {}),
    gap: summary.flags.includes("gap"),
  };
}

function payloadFacts(facts: Facts): Pick<OutcomePayload, "projectId" | "goal" | "missionId"> {
  return {
    projectId: facts.projectId,
    ...(facts.goal ? { goal: facts.goal } : {}),
    ...(facts.missionId ? { missionId: facts.missionId } : {}),
  };
}

/** A row with no facts yet. Its sentinels and flags hold until a `member.started` fills them. */
function blankOutcome(ctx: Ctx, memberId: string, role: RowRole, facts: Facts, flags: Flag[]): OutcomeRow {
  return {
    outcomeId: outcomeId(ctx.event.runId, memberId),
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: ctx.event.runId,
    revision: ctx.event.revision,
    memberId,
    sessionId: null,
    attemptIndex: 0,
    inherited: false,
    role,
    profileId: UNKNOWN,
    provider: UNKNOWN,
    model: UNKNOWN,
    effort: null,
    profileEpoch: 0,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: UNKNOWN,
    featureVersion: 0,
    disposition: "open",
    exclusion: null,
    flags: [...flags],
    integrated: null,
    accepted: null,
    firstPass: null,
    held: null,
    startedAt: null,
    endedAt: null,
    frozenAt: null,
    holdUntil: null,
    runDeletedAt: null,
    payload: {
      ...payloadFacts(facts),
      taskId: ctx.event.taskId ?? UNKNOWN,
      area: UNKNOWN_AREA,
      featureMap: UNKNOWN_FEATURE_MAP,
      rounds: { run: 0, attributed: 0, unknown: 0 },
      limitEvents: 0,
      costCoverage: "none",
    },
  };
}

/** A row made by an event other than `member.started`. It carries the sentinels and a gap. */
function sentinelRow(ctx: Ctx, memberId: string, role: RowRole): OutcomeRow {
  return blankOutcome(ctx, memberId, role, factsOf(ctx.tx, ctx.event), ["gap"]);
}

function blankResult(ctx: Ctx, memberId: string, role: string, facts: Facts, flags: Flag[]): MemberResultRow {
  return {
    resultId: outcomeId(ctx.event.runId, memberId),
    source: "production",
    projectRef: "",
    runId: ctx.event.runId,
    revision: ctx.event.revision,
    memberId,
    sessionId: null,
    role,
    profileId: UNKNOWN,
    provider: UNKNOWN,
    model: UNKNOWN,
    effort: null,
    profileEpoch: 0,
    configId: null,
    reportKind: null,
    disposition: "open",
    flags: [...flags],
    startedAt: null,
    endedAt: null,
    runDeletedAt: null,
    payload: payloadFacts(facts),
  };
}

function sentinelResult(ctx: Ctx, memberId: string, role: string): MemberResultRow {
  return blankResult(ctx, memberId, role, factsOf(ctx.tx, ctx.event), ["gap"]);
}

/** The features a row takes from its plan (an implementer) or its discovery (a scout), both of the same revision. */
function startFeatures(ctx: Ctx, role: RowRole): Features | undefined {
  const { event } = ctx;
  if (event.taskId === undefined) return undefined;
  if (role === "scout") {
    let found: Features | undefined;
    for (const accepted of eventsOf(ctx, ["discovery.accepted"])) {
      if (accepted.revision !== event.revision) continue;
      for (const scout of arrayOf(accepted.data.scouts).map(obj)) {
        if (scout?.taskId === event.taskId) found = featuresOf(scout.features) ?? found;
      }
    }
    return found;
  }
  return featuresOf(lastPlanned(eventsOf(ctx, ["task.planned"]), event.taskId, event.revision)?.data.features);
}

function applyFeatures(row: OutcomeRow, features: Features): void {
  row.kind = features.kind;
  row.risk = features.risk;
  row.featureVersion = features.featureVersion;
  row.payload.area = features.area;
  row.payload.featureMap = features.featureMap;
}

/** The owned paths of an implementer's task, from the plan of the row's revision. Undefined when unknown. */
function ownedPaths(row: OutcomeRow, planned: RunEvent[]): string[] | undefined {
  if (row.role !== "implementer") return undefined;
  const paths = lastPlanned(planned, row.payload.taskId, row.revision)?.data.paths;
  return Array.isArray(paths) && paths.every(item => typeof item === "string") ? paths as string[] : undefined;
}

function lastPlanned(events: RunEvent[], taskId: string | undefined, revision: number): RunEvent | undefined {
  let found: RunEvent | undefined;
  for (const event of events) {
    if (event.taskId === taskId && event.revision === revision) found = event;
  }
  return found;
}

/** Every event of the run with one of the kinds, in `seq` order. Pages are read inside the caller's write. */
function eventsOf(ctx: Ctx, kinds: readonly string[]): RunEvent[] {
  const found: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = ctx.store.eventsIn(ctx.tx, { runId: ctx.event.runId, kinds: [...kinds], after, limit: EVENT_PAGE });
    found.push(...page.events);
    if (!page.more) return found;
    after = page.cursor;
  }
}

function ensureRound(tx: EvidenceTx, event: RunEvent, round: number): void {
  tx.run(
    "INSERT OR IGNORE INTO outcome_rounds (run_id, revision, round, cause, state, started_at, run_deleted_at) "
    + "VALUES (?, ?, ?, ?, 'unknown', ?, NULL)",
    event.runId,
    event.revision,
    round,
    UNKNOWN,
    event.at,
  );
}

function setRoundState(tx: EvidenceTx, event: RunEvent, round: number, state: string): void {
  tx.run(
    "UPDATE outcome_rounds SET state=? WHERE run_id=? AND revision=? AND round=?",
    state,
    event.runId,
    event.revision,
    round,
  );
}

function roundLinks(tx: EvidenceDb, event: RunEvent, round: number): { outcome_id: string; state: string }[] {
  return tx.all<{ outcome_id: string; state: string }>(
    "SELECT outcome_id, state FROM outcome_round_links WHERE run_id=? AND revision=? AND round=? ORDER BY outcome_id",
    event.runId,
    event.revision,
    round,
  );
}

function setLink(tx: EvidenceTx, id: string, runId: string, revision: number, round: number, state: LinkState): void {
  tx.run(
    "INSERT INTO outcome_round_links (outcome_id, run_id, revision, round, state) VALUES (?, ?, ?, ?, ?) "
    + "ON CONFLICT(outcome_id, revision, round) DO UPDATE SET state=excluded.state",
    id,
    runId,
    revision,
    round,
    state,
  );
}

function linksOf(tx: EvidenceDb, id: string): LinkState[] {
  return tx.all<{ state: string }>("SELECT state FROM outcome_round_links WHERE outcome_id=? ORDER BY revision, round", id)
    .map(row => row.state as LinkState);
}

function outcomeId(runId: string, memberId: string): string {
  return `${runId}:${memberId}`;
}

function isRowRole(role: string): role is RowRole {
  return role === "implementer" || role === "scout";
}

function featuresOf(value: unknown): Features | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const area = str(source.area);
  const risk = str(source.risk);
  const featureMap = str(source.featureMap);
  const featureVersion = num(source.featureVersion);
  if (area === undefined || risk === undefined || featureMap === undefined || featureVersion === undefined) return undefined;
  return { area, kind: str(source.kind) ?? null, risk, featureVersion, featureMap };
}

function replacementOf(value: unknown): OutcomePayload["replaces"] | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const memberId = str(source.memberId);
  const cause = str(source.cause);
  if (memberId === undefined || cause === undefined || !REPLACEMENT_CAUSES.includes(cause)) return undefined;
  return { memberId, cause: cause as ReplacementCause };
}

/** The configuration identity of `member.configured`, when its `configId` matches its six components. */
function configIdOf(data: Data): string | undefined {
  const provider = str(data.provider);
  const promptVersion = str(data.promptVersion);
  const guidance = str(data.guidance);
  const shape = data.shape;
  if (provider === undefined || promptVersion === undefined || guidance === undefined) return undefined;
  if ((shape !== "team" && shape !== "trial") || data.knowledge !== "none" || data.routing !== "off") return undefined;
  const components: ConfigComponents = {
    profile: { provider, model: str(data.model) ?? null, effort: str(data.effort) ?? null },
    promptVersion,
    guidance,
    knowledge: "none",
    routing: "off",
    shape,
  };
  const id = configId(components);
  return str(data.configId) === id ? id : undefined;
}

function rubricOf(entry: Data, reviewerProfileId: string): OutcomePayload["rubric"] | undefined {
  const correctness = num(entry.correctness);
  const cleanliness = num(entry.cleanliness);
  const extensibility = num(entry.extensibility);
  const docs = num(entry.docs);
  if (correctness === undefined || cleanliness === undefined || extensibility === undefined || docs === undefined) return undefined;
  return { version: 1, correctness, cleanliness, extensibility, docs, reviewerProfileId };
}

function diffOf(value: unknown): OutcomePayload["diff"] | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const added = num(source.added);
  const removed = num(source.removed);
  const files = num(source.files);
  if (added === undefined || removed === undefined || files === undefined) return undefined;
  if (typeof source.docs !== "boolean" || typeof source.tests !== "boolean") return undefined;
  return { added, removed, files, docs: source.docs, tests: source.tests };
}

function countsOf(value: unknown): RunSummaryCounts | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const counts: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {};
  for (const key of COUNT_KEYS) {
    const count = num(source[key]);
    if (count === undefined) return undefined;
    counts[key] = count;
  }
  return counts as RunSummaryCounts;
}

function goalOf(data: Data): OutcomePayload["goal"] | undefined {
  const id = str(data.goalId);
  const cycle = num(data.goalCycle);
  return id === undefined || cycle === undefined ? undefined : { id, cycle };
}

function withFlag(flags: readonly Flag[], flag: Flag): Flag[] {
  return flags.includes(flag) ? [...flags] : [...flags, flag].sort();
}

function obj(value: unknown): Data | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
