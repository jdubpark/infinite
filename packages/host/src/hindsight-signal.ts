import { createHash } from "node:crypto";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb } from "./evidence/types.js";
import { isRevert } from "./eval-mine-rules.js";
import type { CapturedPayload } from "./eval-types.js";
import { MemoryStoreError } from "./memory/policy.js";
import type { MemoryPrincipalSelector, MemoryStore } from "./memory/types.js";
import { COMMIT_ID, landedIds, revertPattern } from "./outcome-hold.js";
import type { AppliedScan } from "./outcome-scan.js";
import { recomputeRun, revertSignalId, SignalUnreadableError } from "./outcome-signals.js";
import { OUTCOMES_MODULE, projectLandings, runSignals, writeSignal, type SignalRow } from "./outcome-store.js";
import { teamPathAllowed } from "./team-workspace.js";

export const HINDSIGHT_LOOKBACK_DAYS = 30;
export const HINDSIGHT_MAX_LANDINGS = 200;

const DAY_MS = 86_400_000;
const FIX_KEYWORD_RE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|hotfix|regression|repair(?:e[sd])?)\b/i;
const REVERT_SHA_RE = /\bThis reverts commit ([0-9a-f]{7,64})\b/gi;
const FIX_SHA_RE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#?([0-9a-f]{7,64})\b/gi;

export type HindsightKind = "revert" | "linked-fix";
export type HindsightMatchReason =
  | "revert-signal"
  | "linked-fix-signal"
  | "revert-commit-message"
  | "fix-commit-message"
  | "path-overlap-fix";

export type HindsightInput = {
  projectId: string;
  commit: string;
  at: string;
  message?: string;
  revertedCommits?: readonly string[];
  touchedPaths?: readonly string[];
  priorPathsByRun?: ReadonlyMap<string, readonly string[]>;
  runId?: string;
  scanSeq?: number;
  lookbackDays?: number;
  maxLandings?: number;
};

export type HindsightDetection = {
  projectId: string;
  runId: string;
  landingSignalId: string;
  targetCommit: string;
  commit: string;
  kind: HindsightKind;
  reason: HindsightMatchReason;
  reverts?: string;
  matchedPaths: string[];
  at: string;
  alreadyRecorded: boolean;
  advisoryOnly: boolean;
};

export type HindsightEvalCandidate = {
  projectId: string;
  commit: string;
  targetRunId: string;
  targetCommit: string;
  kind: HindsightKind;
  matchedPaths: string[];
  at: string;
};

export type HindsightMemorySink = {
  store: MemoryStore;
  actor: MemoryPrincipalSelector;
  workspaceId: string;
  collectionId: string;
};

export type HindsightReport = {
  detections: HindsightDetection[];
  recordedSignals: number;
  recordedMemories: number;
  evalCandidates: HindsightEvalCandidate[];
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deterministicUuid(seed: string): string {
  const hex = sha256(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function hindsightFixSignalId(landingSignalId: string, commit: string): string {
  return sha256(`hindsight-fix:${landingSignalId}:${commit}`);
}

function hasEvalTasksTable(db: EvidenceDb): boolean {
  return db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='eval_tasks'") !== undefined;
}

function evalRunPaths(db: EvidenceDb, runId: string): string[] {
  try {
    const rows = db.all<{ task_id: string; payload: string }>(
      "SELECT task_id, payload FROM eval_tasks WHERE run_id = ? AND origin = 'captured' LIMIT 32",
      runId,
    );
    const files = new Set<string>();
    for (const row of rows) {
      try {
        const payload = db.open<CapturedPayload>("eval_tasks", row.task_id, row.payload);
        for (const file of payload.files ?? []) files.add(file);
      } catch {
      }
    }
    return [...files].sort();
  } catch {
    return [];
  }
}

function overlapPaths(touched: readonly string[] | undefined, prior: readonly string[] | undefined): string[] {
  if (!touched || touched.length === 0 || !prior || prior.length === 0) return [];
  const priorList = prior.filter(candidate => candidate !== "" && candidate !== ".");
  if (priorList.length === 0) return [];
  const matched = new Set<string>();
  for (const path of touched) {
    if (!path || path === ".") continue;
    if (teamPathAllowed(path, priorList) || priorList.some(candidate => teamPathAllowed(candidate, [path]))) {
      matched.add(path);
    }
  }
  return [...matched].sort();
}

function extractMatches(pattern: RegExp, message: string): string[] {
  const results: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    if (match[1]) results.push(match[1].toLowerCase());
  }
  return results;
}

function matchesSha(candidates: readonly string[], ids: readonly string[]): string | undefined {
  for (const id of ids) {
    const lower = id.toLowerCase();
    for (const candidate of candidates) {
      if (lower === candidate || (candidate.length >= 7 && lower.startsWith(candidate))) return id;
    }
  }
  return undefined;
}

export function detectHindsightSignals(db: EvidenceDb, input: HindsightInput): HindsightDetection[] {
  if (!input.projectId || !COMMIT_ID.test(input.commit)) return [];
  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs)) return [];
  const atIso = new Date(atMs).toISOString();
  const lookbackDays = Math.min(365, Math.max(1, input.lookbackDays ?? HINDSIGHT_LOOKBACK_DAYS));
  const since = new Date(atMs - lookbackDays * DAY_MS).toISOString();
  const maxLandings = Math.min(500, Math.max(1, input.maxLandings ?? HINDSIGHT_MAX_LANDINGS));
  const projectRef = db.index("project", input.projectId);
  const landings = projectLandings(db, projectRef, since).slice(-maxLandings);
  if (landings.length === 0) return [];
  const message = input.message ?? "";
  const revertShas = [
    ...(message ? extractMatches(REVERT_SHA_RE, message) : []),
    ...(input.revertedCommits ?? []).map(sha => sha.toLowerCase()),
  ];
  const fixShas = message ? extractMatches(FIX_SHA_RE, message) : [];
  const commitIsRevert = message ? isRevert(message) : false;
  const hasFixKeyword = message ? FIX_KEYWORD_RE.test(message) : false;
  const hasTouchedPaths = input.touchedPaths !== undefined && input.touchedPaths.some(path => path !== "" && path !== ".");
  const canQueryEval = hasTouchedPaths && hasEvalTasksTable(db);
  const detections: HindsightDetection[] = [];

  for (const landing of landings) {
    if (landing.payload.kind !== "landing") continue;
    if (input.runId !== undefined && landing.runId === input.runId) continue;
    if (Date.parse(landing.at) > atMs) continue;
    const holdUntilMs = Date.parse(landing.payload.holdUntil);
    if (!Number.isFinite(holdUntilMs) || atMs > holdUntilMs) continue;
    const ids = landedIds(landing.payload.method, landing.payload.commit, landing.payload.reviewedHead);
    const activeSignals = runSignals(db, landing.runId).filter(signal => signal.state === "active");
    const existingRevert = activeSignals.find(
      signal => signal.payload.kind === "revert" && signal.payload.commit === input.commit,
    );
    const existingFix = activeSignals.find(
      signal => signal.payload.kind === "linked-fix" && signal.payload.commit === input.commit,
    );
    const priorPaths = hasTouchedPaths
      ? (input.priorPathsByRun?.get(landing.runId) ?? (canQueryEval ? evalRunPaths(db, landing.runId) : []))
      : [];
    const matchedPaths = hasTouchedPaths ? overlapPaths(input.touchedPaths, priorPaths) : [];

    if (existingRevert && existingRevert.payload.kind === "revert") {
      detections.push({
        projectId: input.projectId,
        runId: landing.runId,
        landingSignalId: landing.signalId,
        targetCommit: landing.payload.commit,
        commit: input.commit,
        kind: "revert",
        reason: "revert-signal",
        reverts: existingRevert.payload.reverts,
        matchedPaths,
        at: atIso,
        alreadyRecorded: true,
        advisoryOnly: false,
      });
      continue;
    }

    const revertedByMessage = matchesSha(revertShas, ids)
      ?? (message && ids.some(id => message.includes(revertPattern(id))) ? landing.payload.commit : undefined);
    if (revertedByMessage !== undefined) {
      detections.push({
        projectId: input.projectId,
        runId: landing.runId,
        landingSignalId: landing.signalId,
        targetCommit: landing.payload.commit,
        commit: input.commit,
        kind: "revert",
        reason: "revert-commit-message",
        reverts: revertedByMessage,
        matchedPaths,
        at: atIso,
        alreadyRecorded: false,
        advisoryOnly: false,
      });
      continue;
    }

    if (existingFix) {
      detections.push({
        projectId: input.projectId,
        runId: landing.runId,
        landingSignalId: landing.signalId,
        targetCommit: landing.payload.commit,
        commit: input.commit,
        kind: "linked-fix",
        reason: "linked-fix-signal",
        matchedPaths,
        at: atIso,
        alreadyRecorded: true,
        advisoryOnly: false,
      });
      continue;
    }

    const fixedBySha = matchesSha(fixShas, ids);
    const fixedByRunRef = hasFixKeyword && message.includes(landing.runId);
    if (fixedBySha !== undefined || fixedByRunRef) {
      detections.push({
        projectId: input.projectId,
        runId: landing.runId,
        landingSignalId: landing.signalId,
        targetCommit: landing.payload.commit,
        commit: input.commit,
        kind: "linked-fix",
        reason: "fix-commit-message",
        matchedPaths,
        at: atIso,
        alreadyRecorded: false,
        advisoryOnly: false,
      });
      continue;
    }

    if ((commitIsRevert || hasFixKeyword) && matchedPaths.length > 0) {
      detections.push({
        projectId: input.projectId,
        runId: landing.runId,
        landingSignalId: landing.signalId,
        targetCommit: landing.payload.commit,
        commit: input.commit,
        kind: "linked-fix",
        reason: "path-overlap-fix",
        matchedPaths,
        at: atIso,
        alreadyRecorded: false,
        advisoryOnly: true,
      });
    }
  }
  return detections;
}

function buildSignalRow(detection: HindsightDetection, scanSeq: number): SignalRow {
  if (detection.kind === "revert") {
    return {
      signalId: revertSignalId(detection.landingSignalId, detection.commit),
      runId: detection.runId,
      outcomeId: null,
      kind: "revert",
      author: "host",
      authority: "receipt",
      state: "active",
      at: detection.at,
      payload: {
        kind: "revert",
        commit: detection.commit,
        reverts: detection.reverts ?? detection.targetCommit,
        landingSignalId: detection.landingSignalId,
        scanSeq,
      },
    };
  }
  return {
    signalId: hindsightFixSignalId(detection.landingSignalId, detection.commit),
    runId: detection.runId,
    outcomeId: null,
    kind: "linked-fix",
    author: "host",
    authority: "claim",
    state: "active",
    at: detection.at,
    payload: {
      kind: "linked-fix",
      commit: detection.commit,
      request: sha256(`hindsight:${detection.projectId}:${detection.runId}:${detection.commit}`),
    },
  };
}

function toEvalCandidates(detections: readonly HindsightDetection[]): HindsightEvalCandidate[] {
  return detections.map(detection => ({
    projectId: detection.projectId,
    commit: detection.commit,
    targetRunId: detection.runId,
    targetCommit: detection.targetCommit,
    kind: detection.kind,
    matchedPaths: detection.matchedPaths,
    at: detection.at,
  }));
}

export function recordHindsightSignals(
  store: EvidenceStore,
  input: HindsightInput,
  options: { onEvalCandidate?: (candidate: HindsightEvalCandidate) => void } = {},
): HindsightReport {
  if (store.status().modules[OUTCOMES_MODULE] !== "ready") {
    return { detections: [], recordedSignals: 0, recordedMemories: 0, evalCandidates: [] };
  }
  let detections: HindsightDetection[] = [];
  let recordedSignals = 0;
  store.tryWrite(tx => {
    detections = detectHindsightSignals(tx, input);
    const scanSeq = input.scanSeq ?? 0;
    const touchedRuns = new Set<string>();
    for (const detection of detections) {
      if (detection.alreadyRecorded || detection.advisoryOnly) continue;
      const signal = buildSignalRow(detection, scanSeq);
      const exists = tx.get("SELECT 1 AS found FROM outcome_signals WHERE signal_id=?", signal.signalId) !== undefined;
      if (exists) continue;
      writeSignal(tx, signal);
      recordedSignals += 1;
      touchedRuns.add(detection.runId);
    }
    for (const runId of touchedRuns) {
      try {
        recomputeRun(tx, runId);
      } catch (error) {
        if (!(error instanceof SignalUnreadableError)) throw error;
      }
    }
  });
  const evalCandidates = toEvalCandidates(detections);
  for (const candidate of evalCandidates) {
    try { options.onEvalCandidate?.(candidate); } catch {}
  }
  return { detections, recordedSignals, recordedMemories: 0, evalCandidates };
}

async function writeAdvisoryMemory(
  sink: HindsightMemorySink,
  detection: HindsightDetection,
): Promise<boolean> {
  if (!sink.store.recoveryReady || sink.actor.kind !== "device") return false;
  try {
    const ws = sink.store.getWorkspace(sink.actor, sink.workspaceId);
    sink.store.revalidateResponse(sink.actor, ws.fence);
    const cols = sink.store.listCollections(sink.actor, sink.workspaceId, { collectionId: sink.collectionId });
    sink.store.revalidateResponse(sink.actor, cols.fence);
    const collection = cols.value.items.find(item => item.collectionId === sink.collectionId);
    if (!collection) return false;
    const requestId = deterministicUuid(`hindsight-mem:${detection.projectId}:${detection.runId}:${detection.kind}:${detection.commit}`);
    let alreadyMutated = false;
    try {
      const prior = sink.store.getMutationStatus(sink.actor, sink.workspaceId, requestId);
      sink.store.revalidateResponse(sink.actor, prior.fence);
      alreadyMutated = true;
    } catch (error) {
      if (!(error instanceof MemoryStoreError && error.error === "not_found")) return false;
    }
    if (alreadyMutated) return false;
    const pathText = detection.matchedPaths.length > 0 ? `; paths: ${detection.matchedPaths.slice(0, 8).join(", ")}` : "";
    const content = `Host observed ${detection.kind} commit ${detection.commit} for prior landed run ${detection.runId} (landed commit ${detection.targetCommit}${pathText}). Advisory host signal only.`;
    const result = await sink.store.mutate({
      actor: sink.actor,
      workspaceId: sink.workspaceId,
      request: {
        requestId,
        expectedRevision: collection.revision,
        expectedBindingEpoch: ws.value.workspace.bindingEpoch,
        op: {
          type: "record_create",
          collectionId: sink.collectionId,
          payload: {
            content,
            kind: "outcome",
            sensitivity: "standard",
            sourceRefs: [],
            derivedFrom: [],
            validFrom: detection.at,
            validUntil: null,
            metadata: {
              projectId: detection.projectId,
              signalKind: detection.kind,
              reason: detection.reason,
              commit: detection.commit,
              targetRunId: detection.runId,
              targetCommit: detection.targetCommit,
              paths: detection.matchedPaths.slice(0, 16),
            },
          },
        },
      },
    });
    sink.store.revalidateResponse(sink.actor, result.fence);
    return "receipt" in result.value;
  } catch {
    return false;
  }
}

export async function recordHindsight(
  store: EvidenceStore,
  input: HindsightInput,
  options: { memory?: HindsightMemorySink; onEvalCandidate?: (candidate: HindsightEvalCandidate) => void } = {},
): Promise<HindsightReport> {
  const report = recordHindsightSignals(store, input, { onEvalCandidate: options.onEvalCandidate });
  let recordedMemories = 0;
  if (options.memory && report.detections.length > 0) {
    for (const detection of report.detections) {
      if (await writeAdvisoryMemory(options.memory, detection)) recordedMemories += 1;
    }
  }
  return { ...report, recordedMemories };
}

export function recordHindsightFromScan(
  store: EvidenceStore,
  scan: AppliedScan,
  options: { at?: string; onEvalCandidate?: (candidate: HindsightEvalCandidate) => void } = {},
): HindsightReport {
  if (scan.reverts.length === 0) {
    return { detections: [], recordedSignals: 0, recordedMemories: 0, evalCandidates: [] };
  }
  const at = options.at ?? new Date().toISOString();
  const detections: HindsightDetection[] = [];
  const evalCandidates: HindsightEvalCandidate[] = [];
  let recordedSignals = 0;
  const revertsByCommit = new Map<string, string[]>();
  for (const revert of scan.reverts) {
    const list = revertsByCommit.get(revert.commit);
    if (list) list.push(revert.reverts);
    else revertsByCommit.set(revert.commit, [revert.reverts]);
  }
  for (const [commit, revertedCommits] of revertsByCommit) {
    const report = recordHindsightSignals(
      store,
      { projectId: scan.projectId, commit, at, revertedCommits },
      options,
    );
    detections.push(...report.detections);
    recordedSignals += report.recordedSignals;
    evalCandidates.push(...report.evalCandidates);
  }
  return { detections, recordedSignals, recordedMemories: 0, evalCandidates };
}
