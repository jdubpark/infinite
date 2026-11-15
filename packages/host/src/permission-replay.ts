/**
 * The replay runner: it sends labelled permission requests through the class rules, qualify, the raise
 * rules and the configured tiers, and measures how often a request that should not be allowed is
 * allowed. It delivers nothing, touches no session, and writes no decision: each case is a measurement
 * in the permission-measurements module.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { matchDestructive } from "@infinite/attention";
import type { PermissionEvidence, PermissionRequest, PermissionReview } from "./permission-agent-types.js";
import { PermissionReviewHeld } from "./permission-agent-types.js";
import { INTERRUPT_CLASSES, REJECT_CODES, interruptClassesInForce } from "./permission-policy.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { PermissionMeasurements, StoredReplayResult } from "./evidence/permission-measurements.js";
import type { PermissionAgentCoreService, RateFigure } from "./permission-core.js";

export const REPLAY_LABELS = ["should-allow", "should-reject", "should-reach-owner"] as const;
export type ReplayLabel = typeof REPLAY_LABELS[number];
export const MAX_REPLAY_CASES = 2_000;
export const REPLAY_SET_BYTES = 4 * 1024 * 1024;

const rejectRef = z.object({ id: z.string().min(1).max(200), tool: z.string().min(1).max(200), action: z.string().max(2_000), code: z.enum(REJECT_CODES) }).strict();
const replayCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  label: z.enum(REPLAY_LABELS),
  /** The interrupt class the case is about, for the per-class figures. */
  class: z.enum(INTERRUPT_CLASSES).optional(),
  /** The labeller's note. It is never shown to a model. */
  note: z.string().max(2_000).optional(),
  request: z.object({
    tool: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()).optional(),
    action: z.string().max(2_000),
    destructive: z.object({ pattern: z.string().min(1).max(100) }).strict().optional(),
    shape: z.object({ completeEvidence: z.boolean(), oneShotAccept: z.boolean(), oneShotReject: z.boolean(), persistentOnly: z.boolean(), trustPrompt: z.boolean() }).partial().strict().optional(),
    deliveryCommands: z.array(z.string().min(1).max(2_000)).max(32).optional(),
    requester: z.object({
      kind: z.enum(["team-member", "session", "headless"]).default("team-member"),
      role: z.string().min(1).max(100).optional(),
      provider: z.string().min(1).max(40),
      model: z.string().min(1).max(180).optional(),
      sessionRoot: z.string().min(1).max(4_096).refine(path => path.startsWith("/"), "The session root must be absolute"),
      scratchRoots: z.array(z.string().min(1).max(4_096)).max(8).default([]),
      task: z.object({ title: z.string().max(500), text: z.string().max(8_000) }).strict(),
    }).strict(),
  }).strict(),
  context: z.object({
    direction: z.string().max(4_000).optional(),
    openRejects: z.array(rejectRef).max(50).default([]),
    evidenceRejects: z.array(rejectRef).max(50).default([]),
    rejectHistory: z.boolean().default(false),
  }).strict().default({ openRejects: [], evidenceRejects: [], rejectHistory: false }),
  /** Source files the strong tier can ask for, by path relative to the session root. */
  sources: z.record(z.string().min(1).max(512), z.string().max(200_000)).optional(),
}).strict();
export const replaySetSchema = z.object({
  version: z.literal(1),
  name: z.string().max(200).optional(),
  cases: z.array(replayCaseSchema).min(1).max(MAX_REPLAY_CASES),
}).strict().superRefine((set, context) => {
  const ids = new Set<string>();
  for (const [index, item] of set.cases.entries()) {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["cases", index, "id"], message: "Case IDs must be unique" });
    ids.add(item.id);
  }
});
export type ReplaySet = z.infer<typeof replaySetSchema>;
export type ReplayCase = ReplaySet["cases"][number];

export type ReplayOutcome = "allow" | "reject" | "owner" | "unqualified";
export type ReplayDecider = "class-rule" | "light" | "strong" | "no-turn";

export interface ReplayCaseResult {
  caseId: string;
  label: ReplayLabel;
  class?: string;
  outcome: ReplayOutcome;
  decidedBy: ReplayDecider;
  code?: string;
  interruptClass?: string;
  rule?: string;
  raised: string[];
  tiers: PermissionReview["tiers"];
  note?: string;
}

export interface ReplayFigures {
  cases: number;
  outcomes: Record<ReplayOutcome, number>;
  missRate: RateFigure;
  wrongfulRejectRate: RateFigure;
}

export interface ReplayResult {
  id: string;
  binding: string;
  setDigest: string;
  startedAt: string;
  finishedAt: string;
  cases: number;
  set: ReplayFigures;
  byClass: Record<string, ReplayFigures>;
  byTier: Record<string, ReplayFigures>;
}

/** The 95% Wilson score interval for `count` of `relevant`. */
export function wilson(count: number, relevant: number, z = 1.959963984540054): RateFigure {
  if (relevant <= 0) return { count: 0, relevant: 0, rate: null, lower: 0, upper: 1 };
  const p = count / relevant, z2 = z * z;
  const denominator = 1 + z2 / relevant;
  const centre = (p + z2 / (2 * relevant)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / relevant + z2 / (4 * relevant * relevant))) / denominator;
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return { count, relevant, rate: round(p), lower: round(Math.max(0, centre - half)), upper: round(Math.min(1, centre + half)) };
}

const isMiss = (result: ReplayCaseResult) => result.label !== "should-allow" && result.outcome === "allow";

export function replayFigures(results: readonly ReplayCaseResult[]): ReplayFigures {
  const outcomes: Record<ReplayOutcome, number> = { allow: 0, reject: 0, owner: 0, unqualified: 0 };
  for (const result of results) outcomes[result.outcome]++;
  const notAllowed = results.filter(result => result.label !== "should-allow");
  const allowed = results.filter(result => result.label === "should-allow");
  return {
    cases: results.length, outcomes,
    missRate: wilson(notAllowed.filter(isMiss).length, notAllowed.length),
    wrongfulRejectRate: wilson(allowed.filter(result => result.outcome === "reject").length, allowed.length),
  };
}

const groupBy = (results: readonly ReplayCaseResult[], key: (result: ReplayCaseResult) => string) => {
  const groups = new Map<string, ReplayCaseResult[]>();
  for (const result of results) groups.set(key(result), [...(groups.get(key(result)) ?? []), result]);
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, replayFigures(group)]));
};

export function setDigest(set: ReplaySet): string {
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(set)))).digest("hex");
}

/** The request a case stands for. The host's destructive detector runs on it as it does on a live request. */
export function caseRequest(item: ReplayCase): PermissionRequest {
  const shape = { completeEvidence: true, oneShotAccept: true, oneShotReject: true, persistentOnly: false, trustPrompt: false, ...item.request.shape };
  const pattern = item.request.destructive?.pattern ?? matchDestructive(item.request.action) ?? undefined;
  const requester = item.request.requester;
  return {
    id: `replay:${item.id}`,
    requester: {
      kind: requester.kind, sessionId: `replay:${item.id}`, projectId: "replay", taskId: `replay:${item.id}`, assignment: `replay:${item.id}`,
      ...(requester.role ? { role: requester.role } : {}), provider: requester.provider, ...(requester.model ? { model: requester.model } : {}),
      sessionRoot: requester.sessionRoot, scratchRoots: requester.scratchRoots, task: requester.task,
    },
    tool: item.request.tool,
    ...(item.request.input ? { input: item.request.input } : {}),
    action: item.request.action,
    ...(pattern ? { destructive: { pattern } } : {}),
    shape,
    evidenceHash: createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify({ tool: item.request.tool, input: item.request.input ?? {}, action: item.request.action })))).digest("hex"),
    ...(item.request.deliveryCommands ? { deliveryCommands: item.request.deliveryCommands } : {}),
  };
}

/** Read-only collection from the case's own sources. Nothing on disk is read. */
function collectFromCase(item: ReplayCase, paths: string[]): PermissionEvidence {
  const files: PermissionEvidence["files"] = [];
  const limitations: string[] = [];
  for (const path of paths.slice(0, 8)) {
    const content = item.sources?.[path];
    if (content === undefined) limitations.push(`${path} is not available.`);
    else files.push({ path, sha256: createHash("sha256").update(content).digest("hex"), content });
  }
  return { files, limitations, digest: createHash("sha256").update(canonicalJson({ files, limitations })).digest("hex") };
}

/** One case through class rules, qualify, raise and the tiers. Lock and replay need a journal and are not part of a measurement. */
export async function replayCase(core: PermissionAgentCoreService, item: ReplayCase, signal?: AbortSignal): Promise<ReplayCaseResult> {
  const request = caseRequest(item);
  const base = { caseId: item.id, label: item.label, ...(item.class ? { class: item.class } : {}) };
  const classes = interruptClassesInForce([]);
  const match = core.classify(request, classes);
  if (match) return { ...base, outcome: "owner", decidedBy: "class-rule", interruptClass: match.interruptClass, rule: match.rule, raised: [], tiers: [] };
  const qualification = core.qualify(request);
  if (!qualification.qualified) return { ...base, outcome: "unqualified", decidedBy: "no-turn", rule: qualification.reason, raised: [], tiers: [] };
  const raised = core.raise(request, { rejectHistory: item.context.rejectHistory });
  const review = await core.review(request, {
    requesterFamily: core.familyOf({ provider: request.requester.provider, model: request.requester.model }),
    interruptClasses: classes,
    ...(item.context.direction ? { direction: item.context.direction } : {}),
    openRejects: item.context.openRejects,
    evidenceRejects: item.context.evidenceRejects,
    raised,
    canAllow: true,
    collect: async paths => collectFromCase(item, paths),
    ...(signal ? { signal } : {}),
  });
  return {
    ...base, outcome: review.verdict, decidedBy: review.tiers.at(-1)?.tier ?? "no-turn", raised, tiers: review.tiers,
    ...(review.code ? { code: review.code } : {}), ...(review.interruptClass ? { interruptClass: review.interruptClass } : {}),
    ...(review.note ? { note: review.note } : {}),
  };
}

export interface ReplayProgress { done: number; total: number }

/** Runs a whole set with bounded concurrency and stores every measurement and the result. */
export async function runReplay(set: ReplaySet, deps: {
  core: PermissionAgentCoreService;
  measurements?: PermissionMeasurements;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReplayProgress) => void;
  now?: () => Date;
}): Promise<ReplayResult> {
  const now = deps.now ?? (() => new Date());
  const id = randomUUID();
  const binding = deps.core.binding();
  const startedAt = now().toISOString();
  const results: ReplayCaseResult[] = new Array(set.cases.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < set.cases.length) {
      if (deps.signal?.aborted) throw new Error("The replay was cancelled.");
      const index = next++;
      const item = set.cases[index];
      const result = await replayCase(deps.core, item, deps.signal);
      results[index] = result;
      deps.measurements?.recordCase(id, {
        caseId: item.id, label: item.label, outcome: result.outcome, tier: result.decidedBy, at: now().toISOString(),
        detail: JSON.parse(JSON.stringify({ ...result, binding })),
      });
      deps.onProgress?.({ done: ++done, total: set.cases.length });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 2, 8)) }, worker));
  const finishedAt = now().toISOString();
  const result: ReplayResult = {
    id, binding, setDigest: setDigest(set), startedAt, finishedAt, cases: results.length,
    set: replayFigures(results),
    byClass: groupBy(results, item => item.class ?? "none"),
    byTier: groupBy(results, item => item.decidedBy),
  };
  if (deps.measurements) {
    const stored: StoredReplayResult = {
      id, binding, setDigest: result.setDigest, startedAt, finishedAt, cases: result.cases, missRate: result.set.missRate,
      result: JSON.parse(JSON.stringify({ set: result.set, byClass: result.byClass, byTier: result.byTier })),
    };
    deps.measurements.recordRun(stored);
  }
  return result;
}

export type ReplayJobState = "running" | "finished" | "failed";
export interface ReplayJob {
  id: string;
  requestId: string;
  state: ReplayJobState;
  done: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  result?: ReplayResult;
  error?: string;
}

/**
 * Replay jobs. One runs at a time; a request ID names one job, so a retried start returns that job.
 * A job lives in memory: a host restart ends it, and its stored measurements stay.
 */
export class PermissionReplayJobs {
  private readonly jobs = new Map<string, ReplayJob>();
  private readonly byRequest = new Map<string, { digest: string; jobId: string }>();

  constructor(private readonly deps: {
    core: () => PermissionAgentCoreService | undefined; measurements?: PermissionMeasurements; concurrency?: number; now?: () => Date;
    /** A job ended and its result is recorded. A passing replay can make the host ready, so the caller reads its authority again. */
    onSettled?: () => void;
  }) {}

  current(): ReplayJob | undefined {
    return [...this.jobs.values()].find(job => job.state === "running");
  }

  get(id: string): ReplayJob | undefined {
    return this.jobs.get(id);
  }

  start(requestId: string, set: ReplaySet): { job: ReplayJob } | { error: "conflict" | "busy" | "unavailable" } {
    const digest = setDigest(set);
    const known = this.byRequest.get(requestId);
    if (known) return known.digest === digest ? { job: this.jobs.get(known.jobId)! } : { error: "conflict" };
    if (this.current()) return { error: "busy" };
    const core = this.deps.core();
    if (!core) return { error: "unavailable" };
    const now = this.deps.now ?? (() => new Date());
    const job: ReplayJob = { id: randomUUID(), requestId, state: "running", done: 0, total: set.cases.length, startedAt: now().toISOString() };
    this.jobs.set(job.id, job);
    this.byRequest.set(requestId, { digest, jobId: job.id });
    // Keep the last few jobs only.
    for (const old of [...this.jobs.values()].filter(item => item.state !== "running").slice(0, -5)) {
      this.jobs.delete(old.id);
      for (const [request, entry] of this.byRequest) if (entry.jobId === old.id) this.byRequest.delete(request);
    }
    void runReplay(set, { core, measurements: this.deps.measurements, concurrency: this.deps.concurrency, now,
      onProgress: progress => { job.done = progress.done; } })
      .then(result => { job.state = "finished"; job.result = result; })
      .catch(error => {
        job.state = "failed";
        job.error = error instanceof PermissionReviewHeld ? "A reviewer launch was held by the launch gate." : "The replay could not finish.";
      })
      .finally(() => {
        job.finishedAt = now().toISOString();
        try { this.deps.onSettled?.(); } catch { /* The job's record stands without it. */ }
      });
    return { job };
  }
}
