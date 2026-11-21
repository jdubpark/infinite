/**
 * The permission pipeline: it decides one request and records the decision. It delivers nothing.
 *
 * Precedence, as the design orders it: coverage, class rules, qualify, lock, replay, raise, then the
 * model turns through the decision core. A host rule here can send a request to the owner, reject a
 * locked assignment, replay a recorded verdict or force the strong tier. No host rule allows: an
 * allow is recorded only from a model turn that the host validated, or replayed from one.
 */
import { createHash } from "node:crypto";
import { PermissionReviewHeld } from "./permission-agent-types.js";
import type {
  PermissionAgentCore,
  PermissionClassMatch,
  PermissionDecideOptions,
  PermissionOutcome,
  PermissionPipeline,
  PermissionRejectRef,
  PermissionRequest,
  PermissionReview,
  PermissionReviewContext,
  PermissionServed,
} from "./permission-agent-types.js";
import type { PermissionDelegationService } from "./permission-delegation.js";
import type { CoverageResult } from "./permission-delegation-types.js";
import {
  PermissionJournal,
  type PermissionDecision,
  type PermissionDelivery,
  type PermissionTier,
} from "./evidence/permission-journal.js";
import type { EvidenceModule, EvidenceTx } from "./evidence/types.js";
import type { EvidenceStore } from "./evidence/store.js";
import {
  HOST_REJECT_CODES,
  INTERRUPT_CLASSES,
  isEffectReject,
  isEvidenceReject,
  requesterNotice,
  type InterruptClass,
  type RejectCode,
} from "./permission-policy.js";
import { TeamError } from "./team-workspace.js";

const MODULE = "permission-pipeline";
const JOURNAL_MODULE = "permission-journal";
const DECISIONS = "permission_pipeline_decisions";
const RECEIPTS = "permission_pipeline_receipts";
const MAX_TEXT = 2_000;

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (text: string) => text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
const sameFamily = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
const isHostCode = (code: string | undefined) => (HOST_REJECT_CODES as readonly string[]).includes(code ?? "");

/**
 * What the pipeline keeps beside the journal: for each decision, the project and the authority it was
 * made under, so `applicable` answers after a restart, and the reuse key the replay step looks up. The
 * owner controls keep their request receipts here. The journal's schema is not changed.
 */
export const permissionPipelineModule: EvidenceModule = {
  name: MODULE,
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${DECISIONS} (`
      + "seq INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, "
      + "project_id TEXT NOT NULL, task_id TEXT NOT NULL, authority_hash TEXT NOT NULL, reuse_key TEXT, "
      + "replayable INTEGER NOT NULL)",
    );
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_pipeline_replay ON ${DECISIONS}(task_id, reuse_key, replayable, seq DESC)`);
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${RECEIPTS} (`
      + "request_id TEXT PRIMARY KEY, at TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL)",
    );
  },
};

type DecisionRow = { decision_id: string; project_id: string; task_id: string; authority_hash: string };

/** The pipeline's own durable state in the evidence store. */
export class PermissionPipelineState {
  constructor(private readonly store: EvidenceStore) {
    if (store.status().modules[MODULE] !== "ready") {
      throw new TypeError("The permission-pipeline evidence module must be registered and ready.");
    }
  }

  /** Both this module and the journal can be read and written now. */
  ready(): boolean {
    const modules = this.store.status().modules;
    return modules[MODULE] === "ready" && modules[JOURNAL_MODULE] === "ready";
  }

  remember(row: {
    decisionId: string; at: string; projectId: string; taskId: string; authorityHash: string;
    reuseKey?: string; replayable: boolean;
  }): void {
    this.store.write(tx => {
      tx.run(
        `INSERT INTO ${DECISIONS} (decision_id,at,project_id,task_id,authority_hash,reuse_key,replayable) VALUES (?,?,?,?,?,?,?)`,
        row.decisionId, row.at, row.projectId, row.taskId, row.authorityHash, row.reuseKey ?? null, row.replayable ? 1 : 0,
      );
    });
  }

  decision(decisionId: string): { projectId: string; taskId: string; authorityHash: string } | undefined {
    const row = this.store.read(db => db.get<DecisionRow>(
      `SELECT decision_id,project_id,task_id,authority_hash FROM ${DECISIONS} WHERE decision_id=?`, decisionId,
    ));
    return row && { projectId: row.project_id, taskId: row.task_id, authorityHash: row.authority_hash };
  }

  /** The latest decision of the task that answered this reuse key with a reviewer's verdict, or a replay of one. */
  latestReplayable(taskId: string, reuseKey: string): string | undefined {
    return this.store.read(db => db.get<{ decision_id: string }>(
      `SELECT decision_id FROM ${DECISIONS} WHERE task_id=? AND reuse_key=? AND replayable=1 ORDER BY seq DESC LIMIT 1`,
      taskId, reuseKey,
    ))?.decision_id;
  }

  receipt(requestId: string): { fingerprint: string; result: unknown } | undefined {
    const row = this.store.read(db => db.get<{ fingerprint: string; result_json: string }>(
      `SELECT fingerprint,result_json FROM ${RECEIPTS} WHERE request_id=?`, requestId,
    ));
    return row && { fingerprint: row.fingerprint, result: JSON.parse(row.result_json) as unknown };
  }

  saveReceipt(requestId: string, at: string, fingerprint: string, result: unknown): void {
    this.store.write(tx => {
      tx.run(
        `INSERT INTO ${RECEIPTS} (request_id,at,fingerprint,result_json) VALUES (?,?,?,?)`,
        requestId, at, fingerprint, JSON.stringify(result),
      );
    });
  }
}

/** Registers the module and opens its state, or returns undefined when the store cannot hold it. */
export function openPermissionPipelineState(store: EvidenceStore): PermissionPipelineState | undefined {
  try {
    store.register(permissionPipelineModule);
    return new PermissionPipelineState(store);
  } catch {
    return undefined;
  }
}

type Covered = Extract<CoverageResult, { covered: true }>;
type Coverage = Pick<PermissionDelegationService, "coverage">;
type Validated = {
  verdict: PermissionDecision["verdict"];
  code?: RejectCode;
  interruptClass?: InterruptClass;
  note?: string;
  repeats?: string;
  tiers: PermissionTier[];
  rules: string[];
};

export interface HostPermissionPipelineOptions {
  core: PermissionAgentCore;
  journal: PermissionJournal;
  delegation: Coverage;
  state: PermissionPipelineState;
  /** Whether an owner halt covers the project now. Under a halt nothing is decided and nothing is delivered. */
  halted?: (projectId: string) => boolean;
  /**
   * The project's halt epoch: it changes at every engage and every release of a halt that covers the project, and is
   * undefined while the halt record cannot be read. It is part of each decision's authority, so a verdict reached
   * before a halt or its release no longer applies after it.
   */
  haltEpoch?: (projectId: string) => string | undefined;
  now?: () => number;
}

export class HostPermissionPipeline implements PermissionPipeline {
  private readonly core: PermissionAgentCore;
  private readonly journal: PermissionJournal;
  private readonly delegation: Coverage;
  private readonly state: PermissionPipelineState;
  private readonly haltedOf: ((projectId: string) => boolean) | undefined;
  private readonly haltEpochOf: ((projectId: string) => string | undefined) | undefined;
  private readonly clock: () => number;
  /** One decision per request: a delivery retry while a review runs joins it instead of starting another. */
  private readonly inFlight = new Map<string, Promise<PermissionOutcome>>();

  constructor(options: HostPermissionPipelineOptions) {
    this.core = options.core;
    this.journal = options.journal;
    this.delegation = options.delegation;
    this.state = options.state;
    this.haltedOf = options.halted;
    this.haltEpochOf = options.haltEpoch;
    this.clock = options.now ?? Date.now;
  }

  /**
   * The coverage with the core's binding and the project's halt epoch in its authority. Each ends the authority that
   * earlier decisions were made under, as a new owner act does. A change to the policy text, the class rules or a
   * tier profile retires every verdict reached before it: none is delivered or replayed, and the same request is
   * decided again under the rules in force. A halt does the same, and so does its release. Undefined while the
   * epoch cannot be read.
   */
  private inForce(coverage: Covered): Covered | undefined {
    const epoch = this.haltEpochOf ? this.haltEpochOf(coverage.projectId) : null;
    if (epoch === undefined) return undefined;
    return { ...coverage, authorityHash: sha256(["permission-authority", coverage.authorityHash, this.core.binding(), epoch]) };
  }

  /**
   * A digest of what a review reads besides the request, the authority and the journal: the task text, and the
   * raise rules that match the request as its paths resolve now. A request whose task the owner narrowed, or whose
   * path now resolves outside the session root, is another request to the pipeline: no earlier verdict answers it.
   * The reject history is left out; it comes from the journal, and it selects the tier of a fresh turn only.
   */
  private reviewInputs(request: PermissionRequest): string {
    const { title, text } = request.requester.task;
    const raised = [...new Set(this.core.raise(request, { rejectHistory: false }))].sort();
    return sha256(["permission-review-inputs", title, text, raised]);
  }

  /** A halt that cannot be read counts as a halt. */
  halted(projectId: string): boolean {
    try { return this.haltedOf?.(projectId) ?? false; }
    catch { return true; }
  }

  private timestamp() { return new Date(this.clock()).toISOString(); }

  private ready(): boolean {
    try { return this.state.ready() && this.core.readiness().ready; }
    catch { return false; }
  }

  private coverage(projectId: string): { served: true; coverage: Covered } | { served: false; reason: "not-covered" | "not-ready" } {
    let coverage: CoverageResult;
    try { coverage = this.delegation.coverage(projectId); }
    catch { return { served: false, reason: "not-covered" }; }
    if (!coverage.covered) return { served: false, reason: "not-covered" };
    if (!this.ready()) return { served: false, reason: "not-ready" };
    let current: Covered | undefined;
    try { current = this.inForce(coverage); } catch { current = undefined; }
    return current ? { served: true, coverage: current } : { served: false, reason: "not-ready" };
  }

  serves(projectId: string): PermissionServed {
    const result = this.coverage(projectId);
    return result.served ? { served: true } : { served: false, reason: result.reason };
  }

  classOf(request: PermissionRequest): PermissionClassMatch | undefined {
    const result = this.coverage(request.requester.projectId);
    if (!result.served) return undefined;
    return this.core.classify(request, result.coverage.interruptClasses);
  }

  async decide(request: PermissionRequest, options: PermissionDecideOptions = {}): Promise<PermissionOutcome> {
    const served = this.coverage(request.requester.projectId);
    if (!served.served) return { kind: "not-served", reason: served.reason };
    if (this.halted(request.requester.projectId)) return { kind: "held" };
    let inputs: string;
    try { inputs = this.reviewInputs(request); }
    catch { return { kind: "undeliverable", reason: "The permission agent could not read this request." }; }
    const decisionId = decisionIdFor(request, served.coverage.authorityHash, inputs);
    const running = this.inFlight.get(decisionId);
    if (running) return running;
    const work = (async (): Promise<PermissionOutcome> => {
      try {
        // A delivery retry of one raised request gets the decision already recorded, so a repeat counts once.
        return this.recordedOutcome(decisionId) ?? await this.decideFresh(request, served.coverage, decisionId, inputs, options);
      } catch (error) {
        console.warn(`[Infinite] The permission pipeline could not decide a request (${error instanceof Error ? error.name : "error"}).`);
        return { kind: "undeliverable", reason: "The permission agent could not record a decision for this request." };
      }
    })().finally(() => this.inFlight.delete(decisionId));
    this.inFlight.set(decisionId, work);
    return work;
  }

  applicable(decisionId: string): boolean {
    try {
      const row = this.state.decision(decisionId);
      if (!row || this.halted(row.projectId)) return false;
      const current = this.coverage(row.projectId);
      // A revoke, an owner regrouping, a new owner act, a changed direction text, an owner halt and a change to the
      // rules or tier profiles in force each change or end the authority.
      return current.served && current.coverage.authorityHash === row.authorityHash;
    } catch {
      return false;
    }
  }

  recordDelivery(decisionId: string, kind: PermissionDelivery["kind"], detail?: string): void {
    this.journal.appendDelivery({
      decisionId,
      at: this.timestamp(),
      kind,
      ...(detail === undefined ? {} : { detail: bounded(detail) }),
    });
  }

  taskEnded(taskId: string): void {
    // Closing the task's open rejects also ends every lock that one of them held.
    try { this.journal.closeOpenRejects({ taskId, at: this.timestamp(), reason: "task-ended" }); }
    catch { console.warn("[Infinite] The permission journal could not close an ended task's rejects."); }
  }

  private recordedOutcome(decisionId: string): PermissionOutcome | undefined {
    const decision = this.journal.decision(decisionId);
    if (!decision) return undefined;
    if (!this.state.decision(decisionId)) {
      return { kind: "undeliverable", reason: "The permission agent could not record this decision's authority." };
    }
    // A second attempt at the same request (after a refused delivery or a restart) cannot read again what the
    // review read. An allow that depended on it is left with the owner; the decision and its count stay as recorded.
    if (decision.verdict === "allow" && decision.rules.includes(READ_SOURCE)) {
      return { kind: "undeliverable", reason: "The source files that this allow depends on cannot be read again." };
    }
    return this.outcomeOf(decision);
  }

  private async decideFresh(
    request: PermissionRequest,
    coverage: Covered,
    decisionId: string,
    inputs: string,
    options: PermissionDecideOptions,
  ): Promise<PermissionOutcome> {
    const requester = request.requester;
    const familyText = this.core.familyOf({ provider: requester.provider, ...(requester.model ? { model: requester.model } : {}) });
    const family = familyText ? familyText : undefined;
    const reuseKey = request.reuseKey ? reuseKeyFor(request.reuseKey, coverage, inputs) : undefined;
    const base = {
      id: decisionId,
      workspaceId: coverage.workspaceId,
      projectId: requester.projectId,
      taskId: requester.taskId,
      assignment: requester.assignment,
      sessionId: requester.sessionId,
      ...(requester.role ? { role: requester.role } : {}),
      provider: requester.provider,
      ...(family === undefined ? {} : { family }),
      evidenceHash: request.evidenceHash,
      action: { tool: request.tool, summary: bounded(request.action) },
    };

    // 1. Class rules: the owner answers, no model turn runs, and nothing is replayed for it.
    const match = this.core.classify(request, coverage.interruptClasses);
    if (match) {
      return this.record({ ...base, at: this.timestamp(), rules: [match.rule.startsWith("class:") ? match.rule : `class:${match.rule}`], tiers: [], verdict: "owner", interruptClass: match.interruptClass }, coverage, false);
    }

    // 2. Qualify. A request that cannot be allowed is still reviewed when it offers a one-shot reject.
    const qualification = this.core.qualify(request);
    const canAllow = qualification.qualified && request.shape.oneShotAccept;
    if (!request.shape.oneShotReject) {
      return {
        kind: "undeliverable",
        reason: request.shape.oneShotAccept
          ? "The request offers no one-shot reject, and it cannot be allowed."
          : "The request offers no one-shot accept or reject.",
      };
    }

    // 3. Lock.
    if (this.journal.isLocked(requester.assignment)) {
      return this.record({ ...base, at: this.timestamp(), ...(reuseKey ? { reuseKey } : {}), rules: ["host:locked"], tiers: [], verdict: "reject", code: "locked" }, coverage, false);
    }

    // 4. Replay. The journal judges eligibility; a request that cannot be allowed never replays an allow.
    if (reuseKey) {
      const candidate = this.replayCandidate(requester.taskId, reuseKey, family);
      if (candidate && (candidate.verdict !== "allow" || canAllow)) {
        return this.record({
          ...base, at: this.timestamp(), reuseKey, rules: ["host:replay"], tiers: [], verdict: candidate.verdict,
          ...(candidate.code === undefined ? {} : { code: candidate.code }), replayOf: candidate.id,
        }, coverage, true);
      }
    }

    // 5. Raise. Raise rules select the tier of a fresh turn and nothing else.
    const rejectHistory = this.journal.hasRejectHistory(requester.assignment);
    const raised = [...new Set(this.core.raise(request, { rejectHistory }))];
    if (rejectHistory && raised.length === 0) raised.push("reject-history");
    if (!canAllow) raised.push("not-qualified");

    // 6. The review, with the task's open rejects, the assignment's evidence rejects and the owner's direction.
    // A verdict reached after the review read source files depends on what those files held then. The delivery
    // that follows reads them again. No later request or attempt can, so the decision is marked and answers neither.
    let readSource = false;
    const collect = options.collect;
    const context: PermissionReviewContext = {
      requesterFamily: family,
      interruptClasses: coverage.interruptClasses,
      ...(coverage.coverage.direction === undefined ? {} : { direction: coverage.coverage.direction }),
      openRejects: this.journal.openRejects(requester.taskId).map(rejectRef),
      evidenceRejects: this.journal.evidenceRejects(requester.assignment)
        .filter(decision => decision.replayOf === undefined).map(rejectRef),
      raised,
      canAllow,
      ...(collect ? { collect: (paths: string[]) => { readSource = true; return collect(paths); } } : {}),
      // Every turn reads the halt again: one recorded after the light turn holds the strong turn.
      held: () => this.halted(requester.projectId),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let review: PermissionReview;
    try { review = await this.core.review(request, context); }
    catch (error) {
      // The launch gate held the turn: no verdict exists, so nothing is recorded.
      if (error instanceof PermissionReviewHeld) return { kind: "held" };
      review = { verdict: "reject", code: "unavailable", tiers: [] };
    }

    // 7. Validate the report before anything is recorded, then record it.
    const verdict = this.validate(review, { canAllow, raised, family, taskId: requester.taskId });
    const rules = [
      ...raised.map(rule => rule.startsWith("raise:") ? rule : `raise:${rule}`),
      ...(qualification.qualified ? [] : [`qualify:${qualification.reason}`]),
      ...verdict.rules,
      ...(readSource ? [READ_SOURCE] : []),
    ];
    const decision: PermissionDecision = {
      ...base,
      at: this.timestamp(),
      ...(reuseKey ? { reuseKey } : {}),
      rules,
      tiers: verdict.tiers,
      verdict: verdict.verdict,
      ...(verdict.code === undefined ? {} : { code: verdict.code }),
      ...(verdict.interruptClass === undefined ? {} : { interruptClass: verdict.interruptClass }),
      ...(verdict.note === undefined ? {} : { note: verdict.note }),
      ...(verdict.repeats === undefined ? {} : { repeats: verdict.repeats }),
    };
    try {
      return this.record(decision, coverage, !isHostCode(decision.code));
    } catch {
      // The journal refused the report as recorded (for example its tier list). That is a report with no verdict.
      const { note: _note, repeats: _repeats, code: _code, interruptClass: _class, ...rest } = decision;
      return this.record({
        ...rest, tiers: [], verdict: "reject", code: "unavailable", rules: [...rules, "host:invalid-review:unrecordable"],
      }, coverage, false);
    }
  }

  /** The decision an identical request may replay now, or undefined when a fresh review is needed. */
  private replayCandidate(taskId: string, reuseKey: string, family: string | undefined): PermissionDecision | undefined {
    const candidateId = this.state.latestReplayable(taskId, reuseKey);
    if (!candidateId) return undefined;
    const candidate = this.journal.decision(candidateId);
    // The latest verdict for the request stops the lookup when it cannot be replayed itself: an older one behind
    // it is not consulted. That holds for an owner verdict and for a verdict that read source files.
    if (!candidate || candidate.verdict === "owner" || candidate.rules.includes(READ_SOURCE)) return undefined;
    return this.journal.replayEligible(candidateId, { taskId, requesterFamily: family }) ? candidate : undefined;
  }

  /**
   * A host rule only restricts: a report that breaks a rule is a report with no verdict, which is a reject
   * with `unavailable`. A cited repeat counts only when it is an open effect reject of this task.
   */
  private validate(
    review: PermissionReview,
    context: { canAllow: boolean; raised: string[]; family: string | undefined; taskId: string },
  ): Validated {
    const tiers = Array.isArray(review?.tiers) ? review.tiers : [];
    const last = tiers.at(-1);
    const strong = last?.tier === "strong";
    const note = typeof review?.note === "string" && review.note.length > 0 ? bounded(review.note) : undefined;
    const invalid = (why: string): Validated => ({ verdict: "reject", code: "unavailable", tiers, rules: [`host:invalid-review:${why}`] });

    if (review?.verdict === "allow") {
      if (!context.canAllow) return invalid("allow-not-qualified");
      if (!last) return invalid("allow-without-turn");
      if (context.raised.length > 0 && !strong) return invalid("raised-light-allow");
      if (strong && (context.family === undefined || sameFamily(last.family, context.family))) return invalid("strong-family");
      return { verdict: "allow", tiers, rules: [], ...(note === undefined ? {} : { note }) };
    }
    if (review?.verdict === "reject") {
      if (review.code === "unavailable") return { verdict: "reject", code: "unavailable", tiers, rules: [], ...(note === undefined ? {} : { note }) };
      if (!isEffectReject(review.code) && !isEvidenceReject(review.code)) return invalid("reject-code");
      if (!strong) return invalid("light-reject");
      const repeats = isEffectReject(review.code) ? this.openRepeat(review.repeats, context.taskId) : undefined;
      return {
        verdict: "reject", code: review.code, tiers,
        rules: review.repeats !== undefined && repeats === undefined ? ["host:repeat-not-counted"] : [],
        ...(note === undefined ? {} : { note }),
        ...(repeats === undefined ? {} : { repeats }),
      };
    }
    if (review?.verdict === "owner") {
      if (!(INTERRUPT_CLASSES as readonly string[]).includes(review.interruptClass ?? "")) return invalid("owner-class");
      if (!strong) return invalid("light-owner");
      return { verdict: "owner", interruptClass: review.interruptClass, tiers, rules: [], ...(note === undefined ? {} : { note }) };
    }
    return invalid("verdict");
  }

  /**
   * The cited reject when it is an effect reject whose original is an open reject of this task. A repeat's
   * original is always in the repeat's own task, so membership in this task's open rejects settles both.
   */
  private openRepeat(cited: unknown, taskId: string): string | undefined {
    if (typeof cited !== "string" || cited.length === 0) return undefined;
    const decision = this.journal.decision(cited);
    if (!decision || decision.verdict !== "reject" || !isEffectReject(decision.code)) return undefined;
    const original = decision.repeats ?? decision.id;
    return this.journal.openRejects(taskId).some(open => open.id === original) ? cited : undefined;
  }

  /** The journal first, then the pipeline's authority row: a decision without its row is never applicable. */
  private record(decision: PermissionDecision, coverage: Covered, replayable: boolean): PermissionOutcome {
    this.journal.appendDecision(decision);
    try {
      this.state.remember({
        decisionId: decision.id,
        at: decision.at,
        projectId: decision.projectId,
        taskId: decision.taskId,
        authorityHash: coverage.authorityHash,
        ...(decision.reuseKey === undefined ? {} : { reuseKey: decision.reuseKey }),
        replayable,
      });
    } catch {
      return { kind: "undeliverable", reason: "The permission agent could not record this decision's authority." };
    }
    return this.outcomeOf(this.journal.decision(decision.id) ?? decision);
  }

  private outcomeOf(decision: PermissionDecision): PermissionOutcome {
    if (decision.verdict === "owner") {
      return { kind: "owner", decisionId: decision.id, interruptClass: decision.interruptClass! };
    }
    if (decision.verdict === "reject") {
      return { kind: "reject", decisionId: decision.id, code: decision.code!, notice: requesterNotice(decision.code!) };
    }
    const source = decision.replayOf === undefined ? decision : this.journal.decision(decision.replayOf);
    return { kind: "allow", decisionId: decision.id, strongTier: source?.tiers.at(-1)?.tier === "strong" };
  }
}

/**
 * Marks a decision whose review read source files through the adapter's collection. The verdict depends on what
 * those files held then, and the adapter can read them again only for the delivery that follows that review.
 */
const READ_SOURCE = "host:read-source";

/**
 * One raised request under one authority, read with one set of review inputs, has one decision id. A changed
 * request, a new authority or a changed input gets another.
 */
function decisionIdFor(request: PermissionRequest, authorityHash: string, inputs: string): string {
  return `pd-${sha256(["permission-decision", request.requester.sessionId, request.id, request.evidenceHash, authorityHash, inputs]).slice(0, 32)}`;
}

/**
 * The stored reuse key. It changes with the authority, so a new owner act, a direction text or a change to the rules
 * in force stops replay, and with the review inputs, so a changed task text or path resolution does.
 */
function reuseKeyFor(requestKey: string, coverage: Covered, inputs: string): string {
  return sha256(["permission-reuse", coverage.projectId, coverage.authorityHash, requestKey, inputs]);
}

function rejectRef(decision: PermissionDecision): PermissionRejectRef {
  return { id: decision.id, tool: decision.action.tool, action: decision.action.summary, code: decision.code! };
}

/* ---------------------------------------------------------------- owner controls */

export type PermissionReopenResult = {
  decisionId: string;
  /** The original reject whose state the decision shares. Reopening a repeat or a replay reopens it. */
  reject: string;
  code: RejectCode;
  assignment: string;
  /** Whether the assignment is still locked, by another open reject. */
  locked: boolean;
};

export type PermissionUnlockResult = { assignment: string; wasLocked: boolean; locked: boolean };

/**
 * The owner's two controls over the pipeline's state. Neither allows anything: a reopen closes a reject,
 * removes it from replay and resets its repeat count; an unlock ends the assignment's lock and resets its count.
 * A request ID makes each act safe to retry.
 */
export class PermissionOwnerControls {
  private readonly clock: () => number;

  constructor(
    private readonly journal: PermissionJournal,
    private readonly state: PermissionPipelineState,
    options: { now?: () => number } = {},
  ) {
    this.clock = options.now ?? Date.now;
  }

  private once<T>(requestId: string, fingerprint: string, act: (at: string) => T): T {
    const receipt = this.state.receipt(requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new TeamError(409, "request-conflict", "This request ID belongs to a different permission action.");
      }
      return receipt.result as T;
    }
    const at = new Date(this.clock()).toISOString();
    const result = act(at);
    this.state.saveReceipt(requestId, at, fingerprint, result);
    return result;
  }

  reopen(decisionId: string, input: { requestId: string }, actor: { deviceId: string }): PermissionReopenResult {
    const fingerprint = sha256(["reopen", decisionId, actor.deviceId]);
    return this.once(input.requestId, fingerprint, at => {
      const decision = this.journal.decision(decisionId);
      if (!decision) throw new TeamError(404, "permission-decision-not-found", "No permission decision has this id.");
      if (decision.verdict !== "reject") {
        throw new TeamError(409, "permission-decision-not-reject", "Only a reject can be reopened.");
      }
      if (isHostCode(decision.code)) {
        throw new TeamError(409, "permission-decision-host-result",
          "This reject is a host result, not a reviewer's reject, so nothing is open to reopen. Release a locked assignment with infinite permissions unlock.");
      }
      this.journal.reopen({ decisionId, at, by: actor.deviceId });
      return {
        decisionId,
        reject: decision.repeats ?? decision.replayOf ?? decision.id,
        code: decision.code!,
        assignment: decision.assignment,
        locked: this.journal.isLocked(decision.assignment),
      };
    });
  }

  unlock(assignment: string, input: { requestId: string }, actor: { deviceId: string }): PermissionUnlockResult {
    const fingerprint = sha256(["unlock", assignment, actor.deviceId]);
    return this.once(input.requestId, fingerprint, at => {
      if (!this.journal.hasRejectHistory(assignment)) {
        throw new TeamError(404, "permission-assignment-not-found", "No permission reject is recorded for this assignment.");
      }
      const wasLocked = this.journal.isLocked(assignment);
      this.journal.unlock({ assignment, at, by: actor.deviceId });
      return { assignment, wasLocked, locked: this.journal.isLocked(assignment) };
    });
  }
}

/* ---------------------------------------------------------------- direction text */

function directionInForce(delegation: Coverage, projectId: string): string | null | undefined {
  try {
    const coverage = delegation.coverage(projectId);
    return coverage.covered ? coverage.coverage.direction ?? null : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs an owner delegation act and closes the open rejects of each project whose direction text the act
 * changed. A project that was not covered before the act, or is not covered after it, has no change of
 * text in force, so its open rejects stay. A failed closure leaves them open, which only restricts.
 */
export function closeRejectsOnDirectionChange<T>(
  delegation: Coverage,
  journal: Pick<PermissionJournal, "closeOpenRejects"> | undefined,
  projectIds: readonly string[],
  act: () => T,
  now: () => number = Date.now,
): T {
  const before = new Map(projectIds.map(projectId => [projectId, directionInForce(delegation, projectId)]));
  const result = act();
  if (!journal) return result;
  for (const projectId of projectIds) {
    const prior = before.get(projectId), next = directionInForce(delegation, projectId);
    if (prior === undefined || next === undefined || prior === next) continue;
    try { journal.closeOpenRejects({ projectId, at: new Date(now()).toISOString(), reason: "direction-changed" }); }
    catch { console.warn("[Infinite] The permission journal could not close open rejects after a direction change."); }
  }
  return result;
}
