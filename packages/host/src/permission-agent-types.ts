/**
 * The shared contract of the host permission agent. The decision core, the pipeline, interactive
 * delivery, the headless channel and the owner review surfaces are built against these types, so a
 * part can be tested with fakes of the others. Nothing here decides a request.
 *
 * The parts, in call order:
 *   requester adapter  ->  PermissionDeliveryService (interactive) or the headless channel
 *                      ->  PermissionPipeline.decide
 *                      ->  PermissionAgentCore (class rules, qualify, raise, model turns)
 * The pipeline records every decision in the permission journal before anything is delivered.
 */
import type { Prompt } from "@infinite/attention";
import type { PermissionDelivery, PermissionTier, PermissionVerdict } from "./evidence/permission-journal.js";
import type { InterruptClass, RejectCode } from "./permission-policy.js";

export type PermissionRequesterKind = "team-member" | "session" | "headless";

/**
 * Who asks. A requester adapter builds it from authenticated host records: the session record, the
 * team assignment, the launch profile. No field ever comes from model text or from the request.
 */
export interface PermissionRequester {
  kind: PermissionRequesterKind;
  sessionId: string;
  /** The session's stored host project id. Coverage is resolved from it, never from a path. */
  projectId: string;
  /** The team run id for a member, across members and revisions. The session id for a session outside a run. */
  taskId: string;
  /**
   * The seat the requester works in. For a member: the run and the member's task, or the run and the
   * role when the member has no task of its own. A replacement member and a new run revision keep it.
   * For a session outside a run: the session id.
   */
  assignment: string;
  role?: string;
  provider: string;
  /** The model id of the session's current profile, when the host knows it. The core derives the family. */
  model?: string;
  /** Canonical path of the directory the host assigned to the session. */
  sessionRoot: string;
  /** Host-assigned scratch directories. They count as inside the session root. */
  scratchRoots: string[];
  /** Bounded task text. It is untrusted evidence for a model turn and is never an instruction. */
  task: { title: string; text: string };
}

/** Structural facts about a request. The adapter establishes them; the qualify step and the class rules read them. */
export interface PermissionRequestShape {
  /** The host holds the whole action: complete tool input, or a pinned dialog that shows its whole command. */
  completeEvidence: boolean;
  /** The request offers a recognised one-shot accept. */
  oneShotAccept: boolean;
  /** The request offers a recognised one-shot reject. */
  oneShotReject: boolean;
  /** The request can be granted only as a persistent approval. */
  persistentOnly: boolean;
  /** The request is a workspace trust prompt. */
  trustPrompt: boolean;
}

/** Bounded read-only workspace evidence that the host collected for a model turn. */
export interface PermissionEvidence {
  files: Array<{ path: string; sha256: string; content: string }>;
  limitations: string[];
  digest: string;
}

/** One yes-or-no tool permission that a provider raised for one action. */
export interface PermissionRequest {
  /** Stable for one raised request. A delivery retry keeps it; a new request never reuses it. */
  id: string;
  requester: PermissionRequester;
  /** The tool as the provider names it, or "dialog" for a screen dialog with no tool evidence. */
  tool: string;
  /** The complete tool input, when the host holds it. */
  input?: Record<string, unknown>;
  /** The command or action as the host extracted it, bounded to 2,000 characters. */
  action: string;
  /** The interactive dialog as the host holds it. Absent for a headless call. */
  prompt?: Prompt;
  /** Set when the host's destructive detector matched. It raises the request; it does not disqualify it. */
  destructive?: { pattern: string };
  shape: PermissionRequestShape;
  /** Hash of everything the decision is for. A changed request has another hash. */
  evidenceHash: string;
  /** Identical requests under one authority share it. Absent when the request cannot be replayed. */
  reuseKey?: string;
  evidence?: PermissionEvidence;
  /** Commands that the workspace's delivery or deployment configuration names as deploy, promote, roll-out or release. */
  deliveryCommands?: string[];
}

/* ---------------------------------------------------------------- decision core */

export interface PermissionClassMatch {
  interruptClass: InterruptClass;
  /** The host predicate that established the class, for the record. */
  rule: string;
}

export type PermissionQualification =
  | { qualified: true }
  | { qualified: false; reason: "incomplete-evidence" | "no-one-shot-accept" | "no-one-shot-reject" };

/** A recorded reject as a model turn sees it. */
export interface PermissionRejectRef {
  id: string;
  tool: string;
  action: string;
  code: RejectCode;
}

export interface PermissionReviewContext {
  /** The requester's model family, or undefined when the host cannot establish it. */
  requesterFamily: string | undefined;
  /** The classes in force for the project's delegation. */
  interruptClasses: readonly string[];
  /** The owner's direction text for the workspace. It can only narrow what is allowed. */
  direction?: string;
  /** The task's open effect rejects. */
  openRejects: PermissionRejectRef[];
  /** The requesting assignment's evidence rejects. */
  evidenceRejects: PermissionRejectRef[];
  /** The raise rules that matched. A non-empty list sends the fresh turn to the strong tier. */
  raised: string[];
  /** False for a request that did not qualify. The turn can reject or name the owner; an allow is discarded. */
  canAllow: boolean;
  /** Bounded read-only collection of source paths that the strong model asked for (at most eight). */
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
  signal?: AbortSignal;
}

/** The result of the model turns for one fresh review. The host has validated it against the closed schema. */
export interface PermissionReview {
  verdict: PermissionVerdict;
  /** Set for a reject. `unavailable` when no qualifying model gave a valid report in time. */
  code?: RejectCode;
  /** Set for an owner verdict. */
  interruptClass?: InterruptClass;
  /** The model's note. It goes only to the record, never to an agent. */
  note?: string;
  /** The open reject that the strong model named as repeated. The pipeline validates it before it counts. */
  repeats?: string;
  /** The turns that ran, in order. Empty when no turn could start. */
  tiers: PermissionTier[];
}

export interface PermissionReadiness {
  ready: boolean;
  /** Host-written sentences that say why the host is not ready. Empty when it is. */
  reasons: string[];
}

/**
 * Thrown by `review` when the reviewer launch gate holds a turn (an owner halt). No verdict exists: the
 * caller records nothing and evaluates the request again after the release.
 */
export class PermissionReviewHeld extends Error {
  constructor() {
    super("A permission review turn is held by the launch gate.");
    this.name = "PermissionReviewHeld";
  }
}

/** Class rules, qualification, raise rules and model turns. It records nothing and delivers nothing. */
export interface PermissionAgentCore {
  /** Whether the permission agent may serve any workspace on this host now. */
  readiness(): PermissionReadiness;
  /** A profile's family is its model vendor. Undefined when the host cannot establish it. */
  familyOf(profile: { provider: string; model?: string }): string | undefined;
  /** The interrupt class that a host predicate establishes for this request, among the classes in force. */
  classify(request: PermissionRequest, interruptClasses: readonly string[]): PermissionClassMatch | undefined;
  qualify(request: PermissionRequest): PermissionQualification;
  /** The raise rules that match. They only select the tier of a fresh turn. */
  raise(request: PermissionRequest, context: { rejectHistory: boolean }): string[];
  /** Runs the light turn, the strong turn, or both. Never throws for a model failure: that is `reject` with `unavailable`. */
  review(request: PermissionRequest, context: PermissionReviewContext): Promise<PermissionReview>;
}

/* ---------------------------------------------------------------- pipeline */

export type PermissionServed = { served: true } | { served: false; reason: "not-covered" | "not-ready" };

export type PermissionOutcome =
  /** The permission agent does not serve this request. It is handled as before: it stays with the owner. */
  | { kind: "not-served"; reason: "not-covered" | "not-ready" }
  /** A class rule or a strong verdict names the owner. The request stays pending and the owner is pushed with the class. */
  | { kind: "owner"; decisionId: string; interruptClass: InterruptClass }
  /**
   * An owner halt covers the project, or the launch gate held the review turn. Nothing is recorded and
   * nothing is delivered: the request stays pending and the caller evaluates it again after the release.
   */
  | { kind: "held" }
  /** The host cannot answer this request in either direction. It goes to the owner. This is a host limit, not a class. */
  | { kind: "undeliverable"; reason: string }
  /** `strongTier` says whether the allow came from the strong tier. A destructive request is delivered only then. */
  | { kind: "allow"; decisionId: string; strongTier: boolean }
  /** `notice` is the host's fixed text for the requester. No model text is in it. */
  | { kind: "reject"; decisionId: string; code: RejectCode; notice: string };

export interface PermissionDecideOptions {
  signal?: AbortSignal;
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
}

/**
 * Decides one request: coverage, class rules, qualify, lock, replay, raise, model turns. It records the
 * decision in the journal and returns it. It never delivers.
 */
export interface PermissionPipeline {
  /** Whether the host serves this project now: an owner act covers it and the host is ready. */
  serves(projectId: string): PermissionServed;
  /** The class rule that sends this request to the owner, for a served project. It records nothing. */
  classOf(request: PermissionRequest): PermissionClassMatch | undefined;
  /**
   * `collect` is the requester adapter's bounded read-only collection inside the session root. The
   * strong turn can ask for source paths only through it; without it no path is collected.
   */
  decide(request: PermissionRequest, options?: PermissionDecideOptions): Promise<PermissionOutcome>;
  /**
   * Whether a recorded decision may still be applied now: its project is still covered under the same
   * authority, the host is ready, no owner halt covers it, and no revoke, regrouping or direction change retired it.
   */
  applicable(decisionId: string): boolean;
  /** Linked delivery events. The decision is in the journal before the first one. */
  recordDelivery(decisionId: string, kind: PermissionDelivery["kind"], detail?: string): void;
  /** A task ended: its open rejects close and its locks end. */
  taskEnded(taskId: string): void;
}

/* ---------------------------------------------------------------- interactive delivery */

/** One pending interactive dialog and the live operations on it. A requester adapter builds it. */
export interface PermissionInteractiveTarget {
  request: PermissionRequest;
  /**
   * The live checks immediately before a key is sent: the session still runs, the session root, the
   * prompt identity and evidence are unchanged, and no person holds input control. `accept` and
   * `reject` are the recognised one-shot option indexes that the dialog offers now.
   */
  check(): Promise<
    | { ok: true; accept?: number; reject?: number }
    | { ok: false; stale: boolean; reason: string }
  >;
  /**
   * Sends one option under a control lease. `refused` means nothing was sent. `uncertain` is never retried.
   * `notice` is the host's fixed reject notice. A target sends it only after a reject option that accepts text.
   */
  answer(option: number, decisionId: string, notice?: string): Promise<"delivered" | "refused" | "uncertain">;
  /** Aborted when the requester's authority ends while the decision runs, for example a revoke or a halt. */
  signal?: AbortSignal;
  /** The adapter's bounded read-only collection inside the session root, for source paths the strong turn asks for. */
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
}

export type PermissionHandled =
  /**
   * Not served: the request is the owner's, with today's notifications. `held` marks an owner halt: the
   * adapter hands the request again later, and it is decided from the evidence of that time.
   */
  | { handled: false; reason: string; held?: true }
  | {
    handled: true;
    result: "allowed" | "rejected" | "owner" | "undeliverable" | "stale";
    decisionId?: string;
    interruptClass?: InterruptClass;
    /** The reject code, for a reject. The run status shows it; the model's note is never here. */
    code?: RejectCode;
    /** The last delivery event the service recorded, when it reached delivery. `uncertain` is never repeated. */
    delivery?: "receipt" | "refusal" | "uncertain";
  };

/** Decides an interactive request through the pipeline and delivers the result with the live checks. */
export interface PermissionDeliveryService {
  handle(target: PermissionInteractiveTarget): Promise<PermissionHandled>;
  /**
   * Who a pending request belongs to right now, for the notifier: the permission agent while it can
   * still decide it, the owner otherwise.
   */
  holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided";
}

/* ---------------------------------------------------------------- wiring */

/** The parts that exist on this host. A missing part means the requests it would serve are handled as before. */
export interface PermissionAgentServices {
  core?: PermissionAgentCore;
  pipeline?: PermissionPipeline;
  delivery?: PermissionDeliveryService;
}
