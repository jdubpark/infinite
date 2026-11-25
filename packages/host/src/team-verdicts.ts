import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence/crypto.js";
import { chooseEvaluator } from "./evaluator-profiles.js";
import { heldRecordState, writeHeldRecord } from "./objective-holder.js";
import type { GoalRecordPort } from "./objective-intent.js";
import type { ObjectiveReceipt } from "./objective-receipts.js";
import { VERDICT_OPS } from "./objective-record.js";
import type { ObjectiveRecord } from "./objective-types.js";
import type { TeamRegister } from "./team-register.js";
import { memberLimit } from "./team-types.js";
import type { TeamCommand, TeamMember, TeamModelProfile, TeamReport, TeamRun } from "./team-types.js";
import { assertMemberReadOnly } from "./team-workspace.js";
import { composeVerdict, verdictRecord } from "./verdict-compose.js";
import type { ComposedCriterion, ComposedVerdict } from "./verdict-compose.js";
import { evaluatorPrompt, finalCheckRound, verdictContext } from "./verdict-prompt.js";
import type { VerdictContext } from "./verdict-prompt.js";
import type { VerdictEventData } from "./verdict-store.js";
import type { AssessedState, RunAssessment, VerdictCounts, VerdictReason, VerdictReport } from "./verdict-types.js";
import type { Provider } from "./types.js";

export { verdictPin } from "./evaluator-profiles.js";

/*
 * What a restart finds in each status, and what resumes it. A restart is a JSON round trip of the holder (state, run, record, outbox)
 * as last saved. Every status change, run event, row event, and assessment is made in memory and followed by one save, so a saved
 * holder never holds half of one. The one write outside the holder is a goal's record through its port.
 *
 * The host fences an operation that a restart interrupted and never replays it (ruling 22). So a reported evaluator whose
 * read-only check was cut short is not consumed again; the run is fenced and a new revision starts. The rows below say what each
 * status holds, and what this class does if it is driven again anyway.
 *
 *  status      | a restart finds                                  | what drives it
 *  ------------+--------------------------------------------------+--------------------------------------------------------------
 *  testing     | the state and `since`; the register's pass in    | reviewed/step read the pass again, and go on once it is done
 *              | its own state                                    | or VERDICT_TESTING_WAIT_MS passed; markReviewed ran once
 *  queued      | the state, failures, excluded; no evaluator      | launch chooses again, skipping excluded, and prepares once
 *  evaluating  | evaluatorMemberId set and the member present,    | the evaluator's report, or its failure. With no member,
 *              | maybe reported, with the full report in the      | step goes back to queued without a failure.
 *              | state; or no id/member (prepare did not finish)  |
 *  releasing   | composed, written, assessment, row, events       | step consumes the held report; its hold sees releasing and
 *              |                                                  | sets done. A missing held report sets done.
 *  done        | everything                                       | nothing; reviewed and holdNoChange return false
 *
 * Crash window: a goal's record is written before the save. A crash between the two leaves one verdict.recorded entry in the
 * record for a verdict with no assessment on the run and no row event; the fenced run does not replay it, so nothing is written
 * twice. complete still looks for the entry with handle verdict:<verdictId> before it writes, as a defence if it is driven again.
 * The row event goes to the holder's outbox in the same save as the state.
 */

export type VerdictState = {
  revision: number; head: string; kind: "reviewed" | "no-change"; verdictId: string;
  status: "testing" | "queued" | "evaluating" | "releasing" | "done";
  failures: 0 | 1; excluded?: string[];
  /** When the verdict entered `testing`. */
  since?: string;
  /** For each criterion in the evaluator's context, a SHA-256 of its statement and check; the answer holds only for that. */
  judged?: Record<string, string>;
  /** The run whose reviewed pass gives the receipts: this run, or the parent run. */
  receiptsFrom: string;
  evaluatorMemberId?: string;
  /** The project manager whose no-change report waits. */
  heldMemberId?: string;
  choice?: { profileId: string; provider: Provider; model?: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  report?: VerdictReport; composed?: ComposedVerdict; reason?: VerdictReason;
  written?: "wrote" | "log-full" | "record-unavailable" | "write-failed";
};

/** The part of teams.ts' Stored that verdicts read and write. */
export type VerdictHolder = { run: TeamRun; verdict?: VerdictState; objectiveRecord?: unknown; checkHead?: string };

/** Closures over TeamService's private methods, built in one field initializer in teams.ts. */
export type VerdictHost = {
  holder(runId: string): VerdictHolder | undefined;
  prepare(holder: VerdictHolder, onPrepared: (member: TeamMember) => void, prebuilt: { prompt: string; profile: TeamModelProfile }, onFailed: () => void): void;
  consume(holder: VerdictHolder, member: TeamMember): void;
  operation(holder: VerdictHolder, perform: (signal: AbortSignal) => Promise<boolean | undefined>, complete: (clean: boolean | undefined) => void, member: TeamMember): void;
  save(holder: VerdictHolder): void;
  event(holder: VerdictHolder, text: string): void;
  /** The run event "verdict.recorded". */
  emit(holder: VerdictHolder, data: VerdictEventData): void;
  configured(run: TeamRun): readonly TeamCommand[];
  limited(): Set<Provider>;
  prefix(): TeamCommand | undefined;
  register: Pick<TeamRegister, "markReviewed" | "reviewedReceipts">;
  now(): string;
  uuid(): string;
};

export const VERDICT_EVENTS = {
  held: "The host is assessing this revision against the objective record before it settles.",
  recorded: (result: AssessedState, counts: VerdictCounts) =>
    `Agent assessment, provisional: ${result}. ${counts.met} met, ${counts.notMet} not met, ${counts.inconclusive} inconclusive, ${counts.pendingOwner} waiting for the owner.`,
  contradicted: (count: number) => `The evaluator contradicted ${count} host receipts; the receipts stand.`,
  replaced: "The evaluator stopped without a usable report; one replacement starts.",
  skipped: {
    "no-independent-evaluator": "No evaluator of another model family that authored nothing in this run is listed, so the assessment is inconclusive.",
    "evaluator-unavailable": "The evaluator could not finish, so the assessment is inconclusive.",
    "record-unavailable": "The objective record could not be read, so the assessment is inconclusive.",
    "context-too-large": "The evaluator's context would pass its limit, so the assessment is inconclusive.",
  },
  logFull: "The objective record's log is full, so the assessment was kept on the run and the goal but not written to the record.",
  writeFailed: "The objective record could not be saved, so the assessment was kept on the run and the goal but not written to the record.",
} as const;

export type VerdictDetail = {
  verdictId: string; kind: "reviewed" | "no-change"; revision: number; head: string;
  result: AssessedState; evaluatorResult?: AssessedState; reason?: VerdictReason;
  criteria: ComposedCriterion[]; evaluator?: VerdictState["choice"]; written?: VerdictState["written"];
};

/** A verdict waits this long in `testing` for a register pass; then it goes on with the receipts that exist. */
export const VERDICT_TESTING_WAIT_MS = 300_000;
const STOPPED: readonly TeamRun["status"][] = ["paused", "cancelled", "blocked"];
const EVENT_PROVIDERS: readonly Provider[] = ["claude", "codex", "opencode"];

/** A reviewed run's head, and a no-change run's base, which is its head. */
const headOf = (run: TeamRun): string | undefined => run.headCommit ?? run.baseCommit;

/** True when the final round at the check head passed in every row; undefined when no round was kept at `head`. */
function checksPassed(holder: VerdictHolder, head: string): boolean | undefined {
  if (holder.checkHead !== head) return undefined;
  const rows = finalCheckRound(holder.run, head);
  if (rows.length === 0) return undefined;
  return rows.every(row => row.status === "passed");
}

/** True when the run's review of its current revision approved the head; undefined when the review was not of this head. */
function reviewApproved(run: TeamRun, head: string): boolean | undefined {
  if (run.headCommit !== head || run.review === undefined || run.review.revision !== run.revision) return undefined;
  return run.review.verdict === "approved";
}

function changedPathsOf(run: TeamRun, head: string): { paths: string[]; truncated: boolean } {
  // A change list recorded at another head describes another tree, so it is not offered; the missing list is marked incomplete.
  if (run.changes?.headCommit !== head) return { paths: [], truncated: true };
  return { paths: run.changes.files.map(file => file.path), truncated: run.changes.truncated };
}

/** For each active criterion, a SHA-256 of its statement (c0's is the objective) and check, as the evaluator's context states them. */
function digestsOf(record: ObjectiveRecord): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const item of record.criteria) {
    if (item.state !== "active") continue;
    const statement = item.statementOf === "objective" ? record.statement.objective : item.statement;
    digests[item.id] = createHash("sha256").update(canonicalJson({ statement, check: item.check })).digest("hex");
  }
  return digests;
}

/** A verdict with nothing to compose from: the record did not read. */
function emptyVerdict(reason: VerdictReason): ComposedVerdict {
  return { result: "inconclusive", reason, criteria: [], counts: { met: 0, notMet: 0, inconclusive: 0, pendingOwner: 0 }, dropped: { unknownIds: 0, handles: 0 } };
}

/** The profiles of a run's members that the evaluator must differ from or be weighed against. */
type Cycle = { authors: TeamModelProfile[]; reviewers: TeamModelProfile[]; managers: TeamModelProfile[] };

/**
 * The verdict of one revision. Holds a reviewed revision (or a goal cycle's no-change report) while a register pass, then one
 * read-only evaluator, produce the facts; composes the evaluator's report with host receipts and owner values; writes the
 * record, the run's assessment, and one row event; then lets the run go on. Every path ends in `done`. It changes no run
 * status and never marks anything achieved or approved.
 */
export class TeamVerdicts {
  goals?: GoalRecordPort;

  constructor(private readonly host: VerdictHost) {}

  /** The review approved the revision: true holds the run (no delivery, no settle). */
  reviewed(holder: VerdictHolder): boolean {
    if (holder.run.verdicts !== "on") return false;
    this.dropStale(holder);
    const state = holder.verdict;
    if (!state) return this.startReviewed(holder);
    if (state.kind !== "reviewed" || state.status === "done") return false;
    this.advance(holder, state);
    return true;
  }

  /** A project manager's no-change report on a goal cycle that has a parent run: true holds the report. */
  holdNoChange(holder: VerdictHolder, member: TeamMember): boolean {
    const run = holder.run;
    if (run.verdicts !== "on" || run.goal?.parentRunId === undefined) return false;
    // The validity rule of the no-change report itself: no task, and the head still the base.
    if (run.tasks.length > 0 || run.headCommit !== run.baseCommit) return false;
    this.dropStale(holder);
    const state = holder.verdict;
    if (!state) return this.startNoChange(holder, member, run.goal.parentRunId);
    if (state.kind !== "no-change") return false;
    if (state.status === "done") return false;
    if (state.status === "releasing") {
      state.status = "done";
      this.host.save(holder);
      return false;
    }
    if (state.heldMemberId !== member.memberId) {
      state.heldMemberId = member.memberId;
      this.host.save(holder);
    }
    return true;
  }

  /** Where a new project manager would start: true when the verdict owns the run's next step. */
  step(holder: VerdictHolder): boolean {
    if (holder.run.verdicts !== "on") return false;
    this.dropStale(holder);
    const state = holder.verdict;
    if (!state || state.status === "done") return false;
    if (STOPPED.includes(holder.run.status)) return false;
    this.advance(holder, state);
    return true;
  }

  /** Keeps the full report in the state and returns the stub; any other kind becomes fixed blocked text. */
  screen(holder: VerdictHolder, member: TeamMember, report: TeamReport): TeamReport {
    if (member.role !== "evaluator") return report;
    if (report.kind !== "verdict") {
      return { kind: "blocked", summary: `The evaluator sent a ${report.kind} report instead of a verdict; its text is withheld.` };
    }
    const state = holder.verdict;
    if (state && this.liveEvaluator(holder, state, member)) state.report = report;
    return { kind: "verdict", result: report.result, criteria: report.criteria.map(item => ({ id: item.id, state: item.state, evidence: [] })) };
  }

  /** Every report of an evaluator member. Only the current evaluator's verdict report is applied. */
  consume(holder: VerdictHolder, member: TeamMember): void {
    const state = holder.verdict;
    if (!state || !this.liveEvaluator(holder, state, member)) return;
    if (member.report?.kind !== "verdict" || state.report === undefined) {
      this.failure(holder, state);
      return;
    }
    const evaluator = member.memberId;
    const { verdictId, revision } = state;
    this.host.operation(holder, signal => this.readOnly(member, signal), clean => this.complete(holder, evaluator, verdictId, revision, clean), member);
  }

  /** A member that stopped without a usable report: true for an evaluator (handled), false for every other role. */
  failed(holder: VerdictHolder, member: TeamMember): boolean {
    if (member.role !== "evaluator") return false;
    const state = holder.verdict;
    if (state && this.liveEvaluator(holder, state, member)) this.failure(holder, state);
    return true;
  }

  /** The evaluator's context at launch, or null after the verdict finished without it and the member stopped. */
  context(holder: VerdictHolder, member: TeamMember): VerdictContext | null {
    const state = holder.verdict;
    if (!state || !this.liveEvaluator(holder, state, member)) return null;
    const record = this.readyRecord(holder);
    if (!record) {
      this.stopEvaluator(holder, state, member, "record-unavailable");
      return null;
    }
    const built = verdictContext({ run: holder.run, record, head: state.head, kind: state.kind, receipts: this.receiptsOf(state), changedPaths: this.changeListOf(holder, state) });
    if (!built) {
      this.stopEvaluator(holder, state, member, "context-too-large");
      return null;
    }
    const digests = digestsOf(record);
    // The host builds the context on every tick while a fuse holds the launch, so save only when what the evaluator reads changed.
    if (canonicalJson(state.judged ?? null) !== canonicalJson(digests)) {
      state.judged = digests;
      this.host.save(holder);
    }
    return built;
  }

  /** The composed verdict of the run's current revision, from memory. */
  detail(runId: string): VerdictDetail | undefined {
    const holder = this.host.holder(runId);
    const state = holder?.verdict;
    if (!holder || !state?.composed || !this.current(holder.run, state)) return undefined;
    const { composed } = state;
    return {
      verdictId: state.verdictId, kind: state.kind, revision: state.revision, head: state.head, result: composed.result,
      ...(composed.evaluatorResult === undefined ? {} : { evaluatorResult: composed.evaluatorResult }),
      ...(composed.reason === undefined ? {} : { reason: composed.reason }),
      criteria: composed.criteria,
      ...(state.choice === undefined || !this.applied(composed) ? {} : { evaluator: state.choice }),
      ...(state.written === undefined ? {} : { written: state.written }),
    };
  }

  private startReviewed(holder: VerdictHolder): boolean {
    const run = holder.run;
    if (run.headCommit === undefined) return false;
    holder.verdict = {
      revision: run.revision, head: run.headCommit, kind: "reviewed", verdictId: this.host.uuid(),
      status: "testing", failures: 0, receiptsFrom: run.id, since: this.host.now(),
    };
    // The event comes first: markReviewed saves, so a crash between the two saves cannot lose it.
    this.host.event(holder, VERDICT_EVENTS.held);
    // Best effort: without a pass the receipts read as absent and host criteria are inconclusive (no-receipt).
    this.host.register.markReviewed(holder);
    this.host.save(holder);
    return true;
  }

  private startNoChange(holder: VerdictHolder, member: TeamMember, parentRunId: string): boolean {
    const run = holder.run;
    const head = headOf(run);
    if (head === undefined) return false;
    holder.verdict = {
      revision: run.revision, head, kind: "no-change", verdictId: this.host.uuid(),
      status: "testing", failures: 0, receiptsFrom: parentRunId, heldMemberId: member.memberId, since: this.host.now(),
    };
    this.host.event(holder, VERDICT_EVENTS.held);
    this.host.save(holder);
    return true;
  }

  /** One status change per call. */
  private advance(holder: VerdictHolder, state: VerdictState): void {
    switch (state.status) {
      case "testing":
        this.testing(holder, state);
        return;
      case "queued":
        this.launch(holder, state);
        return;
      case "evaluating":
        this.evaluating(holder, state);
        return;
      case "releasing":
        this.release(holder, state);
        return;
      default:
        return;
    }
  }

  private testing(holder: VerdictHolder, state: VerdictState): void {
    const since = Date.parse(state.since ?? "");
    const waited = Date.parse(this.host.now()) - since;
    // A missing or unparsable time counts as expired.
    if (this.host.register.reviewedReceipts(state.receiptsFrom, state.head) === "pending" && Number.isFinite(waited) && waited < VERDICT_TESTING_WAIT_MS) return;
    state.status = "queued";
    this.host.save(holder);
  }

  /** The record, the choice, the context, and room for one more member, in that order; any miss finishes the verdict without an evaluator. */
  private launch(holder: VerdictHolder, state: VerdictState): void {
    const run = holder.run;
    const record = this.readyRecord(holder);
    if (!record) {
      this.finish(holder, state, undefined, "record-unavailable");
      return;
    }
    const cycle = this.cycleFor(run, state);
    if (cycle === undefined) {
      this.finish(holder, state, undefined, "no-independent-evaluator");
      return;
    }
    const choice = chooseEvaluator(run.lineup, cycle, this.host.limited(), new Set(state.excluded ?? []));
    if ("skipped" in choice) {
      this.finish(holder, state, undefined, choice.skipped);
      return;
    }
    if (!verdictContext({ run, record, head: state.head, kind: state.kind, receipts: this.receiptsOf(state), changedPaths: this.changeListOf(holder, state) })) {
      this.finish(holder, state, undefined, "context-too-large");
      return;
    }
    // The evaluator is one more member. A run at its limit of members settles as it would without verdicts; it is never stopped for the limit here.
    if (run.members.length >= memberLimit(run)) {
      this.finish(holder, state, undefined, "evaluator-unavailable");
      return;
    }
    const { profile } = choice;
    if (state.failures === 1 && state.choice === undefined) this.host.event(holder, VERDICT_EVENTS.replaced);
    state.choice = {
      profileId: profile.id, provider: profile.provider, ...(profile.model === undefined ? {} : { model: profile.model }),
      family: choice.family, sharedFamily: choice.sharedFamily, alsoReviewed: choice.alsoReviewed,
    };
    state.status = "evaluating";
    delete state.evaluatorMemberId;
    delete state.report;
    delete state.judged;
    const verdictId = state.verdictId;
    this.host.prepare(holder, member => {
      const live = holder.verdict;
      if (live?.verdictId === verdictId && live.status === "evaluating") live.evaluatorMemberId = member.memberId;
    }, { prompt: evaluatorPrompt(profile.provider, profile), profile }, () => {
      // A working copy that cannot be made costs the verdict its evaluator, never the run its review.
      const live = holder.verdict;
      // As in `complete`: a stopped run, or one whose recovery is stopping its members, writes nothing; its next revision drops this state.
      if (STOPPED.includes(holder.run.status) || holder.run.recovery?.status === "stopping") return;
      if (live?.verdictId === verdictId && live.status === "evaluating" && live.evaluatorMemberId === undefined) this.finish(holder, live, undefined, "evaluator-unavailable");
    });
    this.host.save(holder);
  }

  /** While the evaluator exists, whatever its status, nothing starts. One that is gone was never prepared: it is replaced without a failure. */
  private evaluating(holder: VerdictHolder, state: VerdictState): void {
    if (holder.run.members.some(member => member.memberId === state.evaluatorMemberId)) return;
    state.status = "queued";
    delete state.evaluatorMemberId;
    delete state.report;
    delete state.judged;
    this.host.save(holder);
  }

  /** Consumes the held no-change report again; its hold sees `releasing` and lets it through. */
  private release(holder: VerdictHolder, state: VerdictState): void {
    const held = holder.run.members.find(member => member.memberId === state.heldMemberId);
    if (held?.report?.kind !== "no-change") {
      state.status = "done";
      this.host.save(holder);
      return;
    }
    this.host.consume(holder, held);
  }

  /** The read-only check of the evaluator's working copy. `undefined` is a check that a stop aborted before it answered. */
  private readOnly(member: TeamMember, signal: AbortSignal): Promise<boolean | undefined> {
    return assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefix(), signal).then(() => true, () => signal.aborted ? undefined : false);
  }

  private complete(holder: VerdictHolder, evaluator: string, verdictId: string, revision: number, clean: boolean | undefined): void {
    const state = holder.verdict;
    if (!state || state.verdictId !== verdictId || state.revision !== revision) {
      this.dropStale(holder);
      return;
    }
    if (!this.current(holder.run, state)) {
      this.dropStale(holder);
      return;
    }
    if (state.status !== "evaluating" || state.evaluatorMemberId !== evaluator) return;
    // A stopped run, or one whose recovery is stopping its members, judges no evaluator and writes nothing: the resume or the
    // recovery starts a new revision, which drops this state.
    if (STOPPED.includes(holder.run.status) || holder.run.recovery?.status === "stopping") return;
    // A check that ended without a result on a run that is not stopped is a failure of the evaluator.
    if (clean !== true || state.report === undefined) {
      this.failure(holder, state);
      return;
    }
    this.finish(holder, state, state.report);
  }

  /** One replacement on a fresh choice, then the verdict finishes without an answer. */
  private failure(holder: VerdictHolder, state: VerdictState): void {
    if (state.failures >= 1) {
      this.finish(holder, state, undefined, "evaluator-unavailable");
      return;
    }
    state.failures = 1;
    state.excluded = [...(state.excluded ?? []), ...(state.choice === undefined ? [] : [state.choice.profileId])];
    state.status = "queued";
    delete state.evaluatorMemberId;
    delete state.report;
    delete state.judged;
    delete state.choice;
    this.host.save(holder);
  }

  /** The member is stopped before the finish's save, so a restart never finds it queued. */
  private stopEvaluator(holder: VerdictHolder, state: VerdictState, member: TeamMember, reason: VerdictReason): void {
    member.status = "stopped";
    member.stoppedReason = VERDICT_EVENTS.skipped[reason];
    this.finish(holder, state, undefined, reason);
  }

  /**
   * Composes, writes the record (once), sets the assessment, emits the row, adds the fixed events, and saves. `report` is the
   * evaluator's answer; without it `reason` says why. A no-change verdict goes to `releasing`, every other to `done`.
   */
  private finish(holder: VerdictHolder, state: VerdictState, report?: VerdictReport, reason?: VerdictReason): void {
    const run = holder.run;
    const record = this.readyRecord(holder);
    let composed: ComposedVerdict;
    let written: VerdictState["written"];
    let version = 0;
    if (!record) {
      composed = emptyVerdict("record-unavailable");
      written = "record-unavailable";
    } else {
      composed = composeVerdict({
        record, head: state.head, kind: state.kind, configured: this.host.configured(run), receipts: this.receiptsOf(state),
        facts: this.factsOf(holder, state), changedPaths: this.changeListOf(holder, state),
        ...(report === undefined ? {} : { report: this.judgedOnly(state, record, report) }), ...(reason === undefined ? {} : { reason }),
      });
      const outcome = this.writeRecord(holder, state, record, composed);
      written = outcome.written;
      version = outcome.version;
    }
    state.composed = composed;
    state.written = written;
    if (composed.reason !== undefined) state.reason = composed.reason;
    else delete state.reason;
    const at = this.host.now();
    run.assessment = this.assessmentOf(state, composed, at);
    if (record) this.host.emit(holder, this.rowOf(holder, state, composed, record, version, this.applied(composed)));
    this.events(holder, composed, written);
    state.status = state.kind === "no-change" ? "releasing" : "done";
    this.host.save(holder);
  }

  private events(holder: VerdictHolder, composed: ComposedVerdict, written: VerdictState["written"]): void {
    this.host.event(holder, VERDICT_EVENTS.recorded(composed.result, composed.counts));
    const contradicted = composed.criteria.filter(item => item.contradicted === true).length;
    if (contradicted > 0) this.host.event(holder, VERDICT_EVENTS.contradicted(contradicted));
    if (composed.reason !== undefined) this.host.event(holder, VERDICT_EVENTS.skipped[composed.reason]);
    if (written === "log-full") this.host.event(holder, VERDICT_EVENTS.logFull);
    if (written === "write-failed") this.host.event(holder, VERDICT_EVENTS.writeFailed);
  }

  /** Drops an answer for an active criterion that the evaluator's context did not hold, or held with another statement or check. */
  private judgedOnly(state: VerdictState, record: ObjectiveRecord, report: VerdictReport): VerdictReport {
    const digests = digestsOf(record);
    return { ...report, criteria: report.criteria.filter(item => digests[item.id] === undefined || state.judged?.[item.id] === digests[item.id]) };
  }

  /** Writes the verdict's entries once: an entry with this verdict's handle means a crash came between the write and the save. */
  private writeRecord(holder: VerdictHolder, state: VerdictState, record: ObjectiveRecord, composed: ComposedVerdict): { written: "wrote" | "log-full" | "write-failed"; version: number } {
    const handle = `verdict:${state.verdictId}`;
    const existing = record.log.find(entry => entry.op === VERDICT_OPS.recorded && entry.handle === handle);
    if (existing) return { written: "wrote", version: existing.version };
    try {
      const next = verdictRecord(record, composed, { verdictId: state.verdictId, kind: state.kind, revision: state.revision, head: state.head, at: this.host.now() });
      if (next === "log-full") return { written: "log-full", version: record.version };
      writeHeldRecord(holder, this.goals, record, next);
      return { written: "wrote", version: next.version };
    } catch {
      return { written: "write-failed", version: record.version };
    }
  }

  private assessmentOf(state: VerdictState, composed: ComposedVerdict, at: string): RunAssessment {
    return {
      verdictId: state.verdictId, revision: state.revision, head: state.head, kind: state.kind, result: composed.result,
      ...(composed.evaluatorResult === undefined ? {} : { evaluatorResult: composed.evaluatorResult }),
      ...(composed.reason === undefined ? {} : { reason: composed.reason }),
      counts: composed.counts, criteria: composed.criteria.map(item => ({ id: item.id, state: item.state })), at,
    };
  }

  /** True when an evaluator's answer was recorded on some criterion; a report whose answers were all dropped names no evaluator. */
  private applied(composed: ComposedVerdict): boolean {
    return composed.criteria.some(item => item.evaluatorState !== undefined);
  }

  /** Ids, enumerations, and counts only. The profile is named only when an evaluator answer was applied. */
  private rowOf(holder: VerdictHolder, state: VerdictState, composed: ComposedVerdict, record: ObjectiveRecord, version: number, answered: boolean): VerdictEventData {
    const run = holder.run;
    const choice = answered ? state.choice : undefined;
    return {
      verdictId: state.verdictId,
      projectId: run.projectId,
      ...(run.goal === undefined ? {} : { goalId: run.goal.id, cycle: run.goal.cycle }),
      kind: state.kind,
      recordVersion: version,
      rubricVersion: record.rubricVersion,
      ...(choice === undefined ? {} : { profileId: choice.profileId, family: choice.family }),
      ...(choice === undefined || !EVENT_PROVIDERS.includes(choice.provider) ? {} : { provider: choice.provider as "claude" | "codex" | "opencode" }),
      ...(choice?.model === undefined ? {} : { model: choice.model }),
      sharedFamily: choice?.sharedFamily ?? false,
      alsoReviewed: choice?.alsoReviewed ?? false,
      result: composed.result,
      ...(composed.evaluatorResult === undefined ? {} : { evaluatorResult: composed.evaluatorResult }),
      ...(composed.reason === undefined ? {} : { reason: composed.reason }),
      met: composed.counts.met,
      notMet: composed.counts.notMet,
      inconclusive: composed.counts.inconclusive,
      pendingOwner: composed.counts.pendingOwner,
    };
  }

  /** Host facts at the verdict's head: this run's for a reviewed verdict, the parent run's for a no-change one (undefined when it is gone). */
  private factsOf(holder: VerdictHolder, state: VerdictState): { checksPassed?: boolean; reviewApproved?: boolean } {
    const source = state.kind === "reviewed" ? holder : this.host.holder(state.receiptsFrom);
    if (!source) return {};
    const passed = checksPassed(source, state.head);
    const approved = reviewApproved(source.run, state.head);
    return { ...(passed === undefined ? {} : { checksPassed: passed }), ...(approved === undefined ? {} : { reviewApproved: approved }) };
  }

  /**
   * The change list a verdict reads, for the composition and the evaluator's context alike. A reviewed verdict reads the run's own.
   * A no-change run never sets one: it reads the parent run's when that list is at the verdict's head, else nothing changed between
   * the base and the head, and the list is empty and complete.
   */
  private changeListOf(holder: VerdictHolder, state: VerdictState): { paths: string[]; truncated: boolean } {
    if (state.kind === "reviewed") return changedPathsOf(holder.run, state.head);
    const parent = this.host.holder(state.receiptsFrom)?.run;
    if (parent?.changes?.headCommit === state.head) return changedPathsOf(parent, state.head);
    return { paths: [], truncated: false };
  }

  /** The reviewed pass's receipts at the head; undefined while pending, when no pass ran there, or when the run is gone. */
  private receiptsOf(state: VerdictState): readonly ObjectiveReceipt[] | undefined {
    const receipts = this.host.register.reviewedReceipts(state.receiptsFrom, state.head);
    return receipts === "pending" ? undefined : receipts;
  }

  /** The members the evaluator must be independent of: this run's, and for a no-change verdict also those of the parent run, which made the head. Undefined when that run is gone. */
  private cycleFor(run: TeamRun, state: VerdictState): Cycle | undefined {
    const own = this.cycleOf(run);
    if (state.kind === "reviewed") return own;
    const parent = this.host.holder(state.receiptsFrom)?.run;
    if (parent === undefined) return undefined;
    const before = this.cycleOf(parent);
    return { authors: [...own.authors, ...before.authors], reviewers: [...own.reviewers, ...before.reviewers], managers: [...own.managers, ...before.managers] };
  }

  /**
   * Every implementer and integrator member with a profile is an author, whatever its report and revision: an escalated or stopped
   * member's edits can be in the head, and steer and resume reset run.tasks. Every reviewer member is a reviewer, and every project manager member with a profile is a manager.
   */
  private cycleOf(run: TeamRun): Cycle {
    const authors: TeamModelProfile[] = [];
    const reviewers: TeamModelProfile[] = [];
    const managers: TeamModelProfile[] = [];
    for (const member of run.members) {
      if (member.modelProfile === undefined) continue;
      if (member.role === "reviewer") reviewers.push(member.modelProfile);
      else if (member.role === "project-manager") managers.push(member.modelProfile);
      else if (member.role === "integrator" || member.role === "implementer") authors.push(member.modelProfile);
    }
    return { authors, reviewers, managers };
  }

  /** The state belongs to the run's current revision and head. */
  private current(run: TeamRun, state: VerdictState): boolean {
    return state.revision === run.revision && state.head === headOf(run);
  }

  /** The state is evaluating, current, and this member is its evaluator. */
  private liveEvaluator(holder: VerdictHolder, state: VerdictState, member: TeamMember): boolean {
    return state.status === "evaluating" && this.current(holder.run, state) && state.evaluatorMemberId === member.memberId;
  }

  /** A verdict never outlives its revision: drops a state and an assessment that are not the run's current ones, and saves. */
  private dropStale(holder: VerdictHolder): void {
    const run = holder.run;
    let changed = false;
    if (holder.verdict && !this.current(run, holder.verdict)) {
      delete holder.verdict;
      changed = true;
    }
    const assessment = run.assessment;
    if (assessment && (assessment.revision !== run.revision || assessment.head !== headOf(run))) {
      delete run.assessment;
      changed = true;
    }
    if (changed) this.host.save(holder);
  }

  private readyRecord(holder: VerdictHolder): ObjectiveRecord | undefined {
    const state = heldRecordState(holder, this.goals);
    return state.kind === "ready" ? state.record : undefined;
  }
}
