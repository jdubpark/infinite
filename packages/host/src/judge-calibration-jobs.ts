import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { judgePromptVersion, profileIdentityKey } from "./config-identity.js";
import { epochAt } from "./configuration-store.js";
import { calibrationPairs } from "./eval-calibration.js";
import { JOB_EXPIRY_DAYS_MAX } from "./eval-jobs.js";
import { trialProfileKey } from "./eval-trial-rules.js";
import { TRIAL_SLOTS_FREE_MIN, type TrialGates } from "./eval-trial-jobs.js";
import type { TrialPayload } from "./eval-trial-store.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import {
  CALIBRATION_DEFAULT_PAIRS, CALIBRATION_MAX_PAIRS, CALIBRATION_MIN_PAIRS, CALIBRATION_RETRIES, calibrationSummary, type OrderingResult,
} from "./judge-calibration-rules.js";
import { labelDraw } from "./judge-package.js";
import {
  activeCalibration, calibrationJudgements, calibrationViews, dropJudgement, finishCalibration, finishJudgement, insertCalibration,
  insertJudgement, liveJudgements, readCalibration, releaseJudgement, startJudgement, sweepJudge, type CalibrationEnd, type CalibrationPairRef, type CalibrationRow,
  type CalibrationView, type JudgementRow,
} from "./judge-store.js";
import { JUDGE_VOID_ENDINGS, type Judgement, type JudgeEnding } from "./judge-types.js";
import type { TeamModelProfile } from "./team-types.js";
import type { Config } from "./types.js";

// The calibration job: an owner-created, finite measurement of one judge profile against known answers. It selects
// resolved and unresolved pairs of past dev-set trials, hands the pump one judgement at a time (each pair in both label
// orders), and stores the judge's fitness only when it completes with its pins intact. It writes only judge rows.
// The owner's request is the budget: at most 2 x pairs x 3 judge sessions (Ruling 17).

export const CALIBRATION_PAGE = 20, CALIBRATION_MINUTES_DEFAULT = 10, CALIBRATION_MINUTES_MIN = 2, CALIBRATION_MINUTES_MAX = 30;
const DAY_MS = 86_400_000;
const REQUEST_ID_MAX = 200, PROFILE_ID_MAX = 200, PROJECTS_MAX = 20;

export const calibrationRequestSchema = z.object({
  requestId: z.string().min(1).max(REQUEST_ID_MAX),
  judgeProfileId: z.string().min(1).max(PROFILE_ID_MAX),
  pairs: z.number().int().min(CALIBRATION_MIN_PAIRS).max(CALIBRATION_MAX_PAIRS).optional(),
  projects: z.array(z.string().min(1).max(PROFILE_ID_MAX)).min(1).max(PROJECTS_MAX).refine(list => new Set(list).size === list.length, "Name each project once").optional(),
  judgeMinutes: z.number().int().min(CALIBRATION_MINUTES_MIN).max(CALIBRATION_MINUTES_MAX).optional(),
  expiresAt: z.iso.datetime().optional(),
}).strict();
export type CalibrationRequest = z.infer<typeof calibrationRequestSchema>;

export type CalibrationRefusal = { status: 400 | 404 | 409; code: "invalid-calibration-request" | "judge-not-configured"
  | "judge-profile-mismatch" | "judge-launch-missing" | "calibration-active" | "request-conflict" | "eval-config-incomplete"
  | "too-few-pairs" | "unknown-calibration" };
export type NextJudgement = { kind: "idle" } | { kind: "wait"; reason: string } | { kind: "start"; calibrationId: string;
  judgementId: string; projectId: string; taskId: string; pairIndex: number; ordering: 0 | 1; attempt: number; resolvedIsA: boolean;
  resolvedTrialId: string; unresolvedTrialId: string; judgeMinutes: number; profile: TeamModelProfile };
export type JudgementOutcome = { ending: JudgeEnding; judgement?: Judgement; sessionId: string | null }
  | { dropped: "patch-missing" | "source-skipped" | "not-isolated" | "package-too-large" };

type Start = Extract<NextJudgement, { kind: "start" }>;
type Options = { store: EvidenceStore; config: Pick<Config, "projects" | "eval" | "teams">; now: () => string };
type Pair = { kind: "pending"; ordering: 0 | 1; attempt: number } | { kind: "dropped" } | { kind: "done"; first: OrderingResult; second: OrderingResult };
type Pins = { judgeKey: string; epoch: number; promptVersion: string };

const refuse = (status: CalibrationRefusal["status"], code: CalibrationRefusal["code"]): CalibrationRefusal => ({ status, code });
const IDLE: NextJudgement = { kind: "idle" };
const isVoid = (ending: JudgeEnding | null) => ending !== null && JUDGE_VOID_ENDINGS.includes(ending);

/** A UUID built from a seed, shaped as version 4, so the launchers' ID checks accept it. */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = "89ab"[Number.parseInt(h.charAt(16), 16) & 3] as string;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A stable UUID for one slot, so a retried `begin` or `finish` names the same judgement. The judge report echoes it as `duelId`. */
export function judgementIdOf(calibrationId: string, pairIndex: number, ordering: 0 | 1, attempt: number): string {
  return stableUuid(`${calibrationId}:${pairIndex}:${ordering}:${attempt}`);
}

/**
 * The grader's job for one project of a calibration. The grader keeps one base bundle per job, and a bundle holds one
 * project's repository, so two projects never share a job.
 */
export function graderJobOf(calibrationId: string, projectId: string): string {
  return stableUuid(`${calibrationId}:grader:${projectId}`);
}

/**
 * The state of one ordering: its deciding row, a drop, or the attempt to run next. A drop, or three attempts spent on
 * void endings, ends the pair at once, and its other ordering never starts. A row in flight counts as the attempt that holds it. */
function orderingState(rows: readonly JudgementRow[]): { drop: true } | { result: OrderingResult } | { attempt: number } {
  if (rows.some(row => row.state === "dropped")) return { drop: true };
  const decided = rows.find(row => row.state === "final" && !isVoid(row.ending));
  if (decided !== undefined) return { result: { resolvedIsA: decided.resolvedIsA, preferred: decided.ending === "judged" ? decided.preferred : null } };
  if (rows.filter(row => row.state === "final").length > CALIBRATION_RETRIES) return { drop: true };
  return { attempt: rows.length };
}

/** Every pair's state from the stored rows. A failed judge answers `preferred: null`, which scores the pair incorrect. */
function pairStates(count: number, rows: readonly JudgementRow[]): Pair[] {
  const slots = new Map<string, JudgementRow[]>();
  for (const row of rows) {
    const key = `${row.pairIndex}/${row.ordering}`;
    slots.set(key, [...(slots.get(key) ?? []), row]);
  }
  const states: Pair[] = [];
  for (let index = 0; index < count; index += 1) {
    const first = orderingState(slots.get(`${index}/0`) ?? []);
    if ("drop" in first) { states.push({ kind: "dropped" }); continue; }
    if ("attempt" in first) { states.push({ kind: "pending", ordering: 0, attempt: first.attempt }); continue; }
    const second = orderingState(slots.get(`${index}/1`) ?? []);
    if ("attempt" in second) states.push({ kind: "pending", ordering: 1, attempt: second.attempt });
    else if ("result" in second) states.push({ kind: "done", first: first.result, second: second.result });
    else states.push({ kind: "dropped" });
  }
  return states;
}

function modelOf(db: EvidenceDb, trialId: string): { provider: string; model: string | null } | undefined {
  const row = db.get<{ payload: string }>("SELECT payload FROM eval_trials WHERE trial_id = ?", trialId);
  if (row === undefined) return undefined;
  const profile = db.open<TrialPayload>("eval_trials", trialId, row.payload).configuration.profile;
  return { provider: profile.provider, model: profile.model ?? null };
}

export class JudgeCalibrations {
  private readonly store: EvidenceStore;
  private readonly config: Pick<Config, "projects" | "eval" | "teams">;
  private readonly now: () => string;
  /** The gate that held the last start, in memory only: empty after a restart until the next step. */
  private waiting: string | null = null;

  constructor(options: Options) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now;
  }

  create(body: unknown): { calibration: CalibrationView } | CalibrationRefusal {
    const parsed = calibrationRequestSchema.safeParse(body);
    if (!parsed.success) return refuse(400, "invalid-calibration-request");
    const request = parsed.data;
    const nowMs = Date.parse(this.now());
    const expiresMs = request.expiresAt === undefined ? nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS : Date.parse(request.expiresAt);
    if (expiresMs <= nowMs || expiresMs > nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS) return refuse(400, "invalid-calibration-request");
    const judge = this.config.teams?.lineup?.judge;
    if (judge === undefined) return refuse(409, "judge-not-configured");
    if (request.judgeProfileId !== judge.id) return refuse(409, "judge-profile-mismatch");
    if (this.config.eval?.member?.agents?.[judge.provider] === undefined) return refuse(409, "judge-launch-missing");
    const early = this.store.read(db => this.replayOrActive(db, request));
    if (early !== undefined) return "replay" in early ? this.viewOrRefusal(early.replay) : early;
    const projects = this.poolOf(request.projects);
    if (projects === undefined) return refuse(409, "eval-config-incomplete");
    const pairs = this.select(judge, projects, request.pairs ?? CALIBRATION_DEFAULT_PAIRS);
    const count = pairs.list.length;
    if (count < CALIBRATION_MIN_PAIRS) return refuse(409, "too-few-pairs");
    const calibrationId = randomUUID();
    const at = this.now();
    const wrote = this.store.write(tx => {
      const raced = this.replayOrActive(tx, request);
      if (raced !== undefined) return raced;
      insertCalibration(tx, {
        calibrationId, requestId: request.requestId, judgeKey: profileIdentityKey(trialProfileKey(judge)),
        profileEpoch: epochAt(tx, profileIdentityKey(trialProfileKey(judge)), at), promptVersion: judgePromptVersion(judge.provider),
        pairsPlanned: count, judgeMinutes: request.judgeMinutes ?? CALIBRATION_MINUTES_DEFAULT, createdAt: at, expiresAt: new Date(expiresMs).toISOString(),
        payload: { profileId: judge.id, request, pairs: pairs.list, perProject: pairs.perProject },
      });
      return undefined;
    });
    if (wrote !== undefined) return "replay" in wrote ? this.viewOrRefusal(wrote.replay) : wrote;
    // A reason found before this calibration existed is not its reason.
    this.waiting = null;
    return this.viewOrRefusal(calibrationId);
  }

  cancel(id: string): { calibration: CalibrationView } | CalibrationRefusal {
    const row = this.store.read(db => readCalibration(db, id));
    if (row === undefined) return refuse(404, "unknown-calibration");
    if (row.status === "running") {
      this.store.write(tx => finishCalibration(tx, id, this.endOf(tx, row, "cancelled", "cancelled"), this.now()));
    }
    return this.viewOrRefusal(id);
  }

  views(): CalibrationView[] {
    const at = this.now();
    const judge = this.config.teams?.lineup?.judge;
    return this.store.read(db => calibrationViews(db, at, judgeKey => {
      if (judge === undefined || profileIdentityKey(trialProfileKey(judge)) !== judgeKey) return undefined;
      return { epoch: epochAt(db, judgeKey, at), promptVersion: judgePromptVersion(judge.provider) };
    })).map(view => view.status === "running" ? { ...view, waiting: this.waiting } : view);
  }

  /**
   * The next judgement of the running calibration: the first undecided ordering of the lowest undecided pair, once
   * every gate of Ruling 18 holds. A moved pin cancels the job with `identity-changed`. Free slots are read only
   * when a judgement would start. With no undecided pair left the calibration completes.
   */
  async next(gates: TrialGates): Promise<NextJudgement> {
    const at = this.now();
    const pass = this.store.write(tx => this.step(tx, gates, at));
    if (pass.kind !== "slots") {
      this.waiting = pass.kind === "wait" ? pass.reason : null;
      return pass;
    }
    const free = await gates.freeSlots();
    if (free < TRIAL_SLOTS_FREE_MIN) {
      this.waiting = "session-slots";
      return { kind: "wait", reason: "session-slots" };
    }
    this.waiting = null;
    return pass.start;
  }

  /** Remembers a gate the pump found after `next` answered `start`. */
  hold(reason: string): void {
    this.waiting = reason;
  }

  /** Takes back a start that failed before any judge session: the row goes, the ordering keeps its attempt, and the reason is remembered. */
  release(judgementId: string, reason: string): void {
    this.store.write(tx => { releaseJudgement(tx, judgementId); });
    this.waiting = reason;
  }

  begin(start: Start): "inserted" | "exists" {
    const at = this.now();
    return this.store.write(tx => insertJudgement(tx, {
      judgementId: start.judgementId, calibrationId: start.calibrationId, pairIndex: start.pairIndex, ordering: start.ordering,
      attempt: start.attempt, resolvedIsA: start.resolvedIsA, projectId: start.projectId,
    }, at));
  }

  launched(judgementId: string, sessionId: string | null): void {
    this.store.write(tx => { startJudgement(tx, judgementId, sessionId); });
  }

  /** Records one ending and completes the calibration after its last pair. A repeated call changes nothing. */
  finish(judgementId: string, outcome: JudgementOutcome): void {
    const at = this.now();
    this.store.write(tx => {
      const row = tx.get<{ calibration_id: string }>("SELECT calibration_id FROM judge_judgements WHERE judgement_id = ?", judgementId);
      if (row === undefined) return;
      if ("dropped" in outcome) dropJudgement(tx, judgementId, outcome.dropped, at);
      else finishJudgement(tx, judgementId, { ending: outcome.ending, sessionId: outcome.sessionId,
        ...(outcome.judgement === undefined ? {} : { judgement: outcome.judgement }) }, at);
      const calibration = readCalibration(tx, row.calibration_id);
      if (calibration?.status === "running") this.complete(tx, calibration, at);
    });
  }

  live(): { judgementId: string; calibrationId: string; state: "preparing" | "live" }[] {
    return this.store.read(db => liveJudgements(db)).map(row => ({ judgementId: row.judgementId, calibrationId: row.calibrationId, state: row.state }));
  }

  running(): string[] {
    const row = this.store.read(db => activeCalibration(db));
    return row === undefined ? [] : [row.calibrationId];
  }

  /** Expires the running calibration when its expiry has passed, and deletes the rows past their keep time. */
  sweep(): void {
    const at = this.now();
    this.store.write(tx => {
      const row = activeCalibration(tx);
      if (row !== undefined && Date.parse(row.expiresAt) <= Date.parse(at)) finishCalibration(tx, row.calibrationId, this.endOf(tx, row, "expired", "expired"), at);
      sweepJudge(tx, at);
    });
  }

  private viewOrRefusal(id: string): { calibration: CalibrationView } | CalibrationRefusal {
    const found = this.views().find(view => view.calibrationId === id);
    return found === undefined ? refuse(404, "unknown-calibration") : { calibration: found };
  }

  /** The same view for a repeated request, `request-conflict` for another body, `calibration-active` while one runs. */
  private replayOrActive(db: EvidenceDb, request: CalibrationRequest): { replay: string } | CalibrationRefusal | undefined {
    const stored = db.get<{ calibration_id: string }>("SELECT calibration_id FROM judge_calibrations WHERE request_id = ?", request.requestId);
    if (stored !== undefined) {
      const row = readCalibration(db, stored.calibration_id) as CalibrationRow;
      if (canonicalJson(row.payload.request) !== canonicalJson(request)) return refuse(409, "request-conflict");
      return { replay: row.calibrationId };
    }
    return activeCalibration(db) === undefined ? undefined : refuse(409, "calibration-active");
  }

  /** The named projects, or every project with an eval block, in ID order. Undefined when a named project has no eval block. */
  private poolOf(named: readonly string[] | undefined): string[] | undefined {
    const withEval = new Set(this.config.projects.filter(project => project.team?.eval !== undefined).map(project => project.id));
    if (named === undefined) return [...withEval].sort();
    return named.every(id => withEval.has(id)) ? [...named].sort() : undefined;
  }

  /**
   * Round-robin over the projects in ID order, a page of up to CALIBRATION_PAGE at a time. A pair is skipped when either
   * trial's recorded profile has the judge's provider and model. The kept pairs are then ordered by project: the grader
   * holds one project's bundle at a time, so the pairs of one project run together and its bundle is streamed once.
   */
  private select(judge: TeamModelProfile, projects: readonly string[], want: number): { list: CalibrationPairRef[]; perProject: { projectId: string; pairs: number }[] } {
    type Cursor = { projectId: string; queue: CalibrationPairRef[]; after: string | null | undefined; taken: number };
    const cursors: Cursor[] = projects.map(projectId => ({ projectId, queue: [], after: undefined, taken: 0 }));
    const list: CalibrationPairRef[] = [];
    while (list.length < want) {
      let moved = false;
      for (const cursor of cursors) {
        if (list.length >= want) break;
        while (cursor.queue.length === 0 && cursor.after !== null) this.fill(cursor, judge);
        const pair = cursor.queue.shift();
        if (pair === undefined) continue;
        list.push(pair);
        cursor.taken += 1;
        moved = true;
      }
      if (!moved) break;
    }
    list.sort((a, b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0);
    return { list, perProject: cursors.filter(cursor => cursor.taken > 0).map(cursor => ({ projectId: cursor.projectId, pairs: cursor.taken })) };
  }

  private fill(cursor: { projectId: string; queue: CalibrationPairRef[]; after: string | null | undefined }, judge: TeamModelProfile): void {
    const page = calibrationPairs(this.store, { projectId: cursor.projectId, ...(cursor.after === undefined || cursor.after === null ? {} : { after: cursor.after }), limit: CALIBRATION_PAGE });
    cursor.after = page.next;
    const own = (trialId: string) => {
      const used = this.store.read(db => modelOf(db, trialId));
      return used !== undefined && used.provider === judge.provider && used.model === (judge.model ?? null);
    };
    for (const pair of page.pairs) {
      if (own(pair.resolved.trialId) || own(pair.unresolved.trialId)) continue;
      cursor.queue.push({ projectId: cursor.projectId, taskId: pair.taskId, resolvedTrialId: pair.resolved.trialId, unresolvedTrialId: pair.unresolved.trialId });
    }
  }

  private pinsOf(db: EvidenceDb, judge: TeamModelProfile, at: string): Pins {
    const judgeKey = profileIdentityKey(trialProfileKey(judge));
    return { judgeKey, epoch: epochAt(db, judgeKey, at), promptVersion: judgePromptVersion(judge.provider) };
  }

  /** An ending that carries no state: the tallies so far, and nothing a router could read. */
  private endOf(db: EvidenceDb, row: CalibrationRow, status: "cancelled" | "expired", reason: string): CalibrationEnd {
    const done = pairStates(row.payload.pairs.length, calibrationJudgements(db, row.calibrationId)).flatMap(pair => pair.kind === "done" ? [pair] : []);
    const summary = calibrationSummary(done);
    return { status, reason, state: null, counted: summary.counted, correct: summary.correct, agree: summary.agree, accuracy: null, lowerBound: null, swapAgreement: null };
  }

  private complete(tx: EvidenceTx, row: CalibrationRow, at: string): void {
    const states = pairStates(row.payload.pairs.length, calibrationJudgements(tx, row.calibrationId));
    const pending = states.filter(pair => pair.kind === "pending").length;
    const summary = calibrationSummary(states.flatMap(pair => pair.kind === "done" ? [pair] : []));
    // Fewer than CALIBRATION_MIN_PAIRS pairs can be counted, now or ever: the result cannot be `ok`, so stop spending.
    // A request holds at least that many pairs, so only dropped pairs bring the count below it.
    const short = summary.counted + pending < CALIBRATION_MIN_PAIRS;
    if (pending > 0 && !short) return;
    finishCalibration(tx, row.calibrationId, { status: "completed", reason: short ? "pairs-dropped" : null, state: short ? "not-ok" : summary.state, counted: summary.counted, correct: summary.correct,
      agree: summary.agree, accuracy: summary.accuracy, lowerBound: summary.lowerBound, swapAgreement: summary.swapAgreement }, at);
  }

  private step(tx: EvidenceTx, gates: TrialGates, at: string): NextJudgement | { kind: "slots"; start: Start } {
    const row = activeCalibration(tx);
    if (row === undefined) return IDLE;
    if (Date.parse(row.expiresAt) <= Date.parse(at)) {
      finishCalibration(tx, row.calibrationId, this.endOf(tx, row, "expired", "expired"), at);
      return IDLE;
    }
    const judge = this.config.teams?.lineup?.judge;
    const pins = judge === undefined ? undefined : this.pinsOf(tx, judge, at);
    if (judge === undefined || pins === undefined || pins.judgeKey !== row.judgeKey || pins.epoch !== row.profileEpoch || pins.promptVersion !== row.promptVersion) {
      finishCalibration(tx, row.calibrationId, this.endOf(tx, row, "cancelled", "identity-changed"), at);
      return IDLE;
    }
    const rows = calibrationJudgements(tx, row.calibrationId);
    const states = pairStates(row.payload.pairs.length, rows);
    const index = states.findIndex(pair => pair.kind === "pending");
    if (index === -1) {
      this.complete(tx, row, at);
      return IDLE;
    }
    const pending = states[index] as Extract<Pair, { kind: "pending" }>;
    const pair = row.payload.pairs[index] as CalibrationPairRef;
    const wait = this.waitReason(tx, gates, judge, pair.projectId, rows);
    if (wait !== undefined) return { kind: "wait", reason: wait };
    const draw = labelDraw(`${row.calibrationId}:${index}`) === 0;
    return { kind: "slots", start: {
      kind: "start", calibrationId: row.calibrationId, judgementId: judgementIdOf(row.calibrationId, index, pending.ordering, pending.attempt),
      projectId: pair.projectId, taskId: pair.taskId, pairIndex: index, ordering: pending.ordering, attempt: pending.attempt,
      resolvedIsA: pending.ordering === 0 ? draw : !draw, resolvedTrialId: pair.resolvedTrialId, unresolvedTrialId: pair.unresolvedTrialId,
      judgeMinutes: row.judgeMinutes, profile: judge,
    } };
  }

  /** The gates of Ruling 18 that depend on the host, in order. Undefined when every one holds. */
  private waitReason(db: EvidenceDb, gates: TrialGates, judge: TeamModelProfile, projectId: string, rows: readonly JudgementRow[]): string | undefined {
    if (gates.halted(projectId)) return "halt";
    if (gates.hostLoadHeld) return "host-load";
    if (gates.identity.state !== "ready" || this.config.eval?.member?.agents?.[judge.provider] === undefined) return "eval-identity";
    if (gates.grader.state !== "ready") return "grader";
    if (gates.trialLive) return "another-job";
    if (liveJudgements(db).length > 0 || rows.some(row => row.state === "preparing" || row.state === "live")) return "another-judgement";
    if (gates.limited.has(judge.provider)) return "provider-limit";
    return undefined;
  }
}
