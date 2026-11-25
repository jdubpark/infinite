import { randomUUID } from "node:crypto";
import { chooseIntentChecker } from "./evaluator-profiles.js";
import { correctionFeedback, intentCheckerPrompt, intentContext } from "./intent-prompt.js";
import type { IntentContext } from "./intent-prompt.js";
import type { IntentCheckReport } from "./intent-report.js";
import {
  answerIntentQuestions,
  applyIntentReport,
  criteriaDue,
  intentApplied,
  intentDecision,
  releaseIntentQuestions,
  screenIntentReport,
  skipIntentCheck,
} from "./objective-intent.js";
import type {
  GoalRecordPort,
  IntentApplied,
  IntentApplyContext,
  IntentMode,
  IntentReleaseCause,
  IntentScreenDrop,
  IntentSkipReason,
  IntentStatement,
} from "./objective-intent.js";
import { heldRecordState, writeHeldRecord } from "./objective-holder.js";
import type { ObjectiveState, ObjectiveUnavailable } from "./objective-record.js";
import { planRunObjective, runObjectiveNote } from "./objective-runs.js";
import type { ObjectiveRecord } from "./objective-types.js";
import type { Project, Provider } from "./types.js";
import type { TeamCommand, TeamDecision, TeamMember, TeamModelProfile, TeamReport, TeamRun } from "./team-types.js";
import { TeamError, assertMemberReadOnly } from "./team-workspace.js";

export type { GoalRecordPort } from "./objective-intent.js";

export type IntentCheckState = {
  revision: number; planMemberId: string;
  status: "queued" | "checking" | "waiting" | "correcting" | "accepting" | "done" | "skipped";
  failures: 0 | 1 | 2; checkerMemberId?: string; decisionId?: string; correctedMemberId?: string; reason?: IntentSkipReason;
  screened?: Partial<Record<IntentScreenDrop, number>>;
};
export type IntentHolder = { run: TeamRun; intentCheck?: IntentCheckState; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
export type IntentHost = {
  prepare(holder: IntentHolder, role: "project-manager" | "intent-checker", feedback: string | undefined,
    onPrepared: (member: TeamMember) => void, prebuilt?: { prompt: string; profile: TeamModelProfile }): void;
  consume(holder: IntentHolder, member: TeamMember): void;
  operation(holder: IntentHolder, perform: (signal: AbortSignal) => Promise<boolean | undefined>, complete: (clean: boolean | undefined) => void, member: TeamMember): void;
  save(holder: IntentHolder): void;
  event(holder: IntentHolder, text: string): void;
  block(holder: IntentHolder, error: unknown, member?: TeamMember): void;
  project(run: TeamRun): Project | undefined;
  limited(): Set<Provider>;
  prefix(): TeamCommand | undefined;
};

export const INTENT_EVENTS: {
  held: string; accepted: string; waiting: string; answered: string; correcting: string; replaced: string;
  answerUnrecorded: string; releaseUnrecorded: string; skipped: Record<IntentSkipReason, string>; released: Record<IntentReleaseCause, string>;
} = {
  held: "The plan is held while a read-only intent check compares it with the objective record.",
  accepted: "The intent check recorded its items; the plan is accepted.",
  waiting: "The intent check needs the owner's answer before the plan proceeds.",
  answered: "The project manager will correct its plan with this answer.",
  correcting: "The project manager is correcting its plan with the intent check's items.",
  replaced: "The intent checker stopped without a usable report; one replacement starts.",
  answerUnrecorded: "The objective record could not record the owner's answer; the run goes on.",
  releaseUnrecorded: "The objective record could not release the intent check's questions; the run goes on.",
  skipped: {
    "checker-failed": "The intent check was skipped: the checker failed twice. The plan is accepted unchecked.",
    "no-eligible-profile": "The intent check was skipped: no evaluator profile differs in family from the coordinator and the plan's author. The plan is accepted unchecked.",
    "record-unavailable": "The intent check was skipped: the objective record could not be read or written. The plan is accepted unchecked.",
    "log-full": "The intent check was skipped: the objective record's log is full. The plan is accepted unchecked.",
    "context-too-large": "The intent check was skipped: the checker's context is over 1 MiB. The plan is accepted unchecked.",
  },
  released: {
    replanned: "The intent check's questions no longer wait: the plan was replaced.",
    cancelled: "The intent check's questions no longer wait: the run was cancelled.",
    "delegated-answer": "The intent check's questions no longer wait: a delegate answered, so the record keeps them open.",
  },
};

const DECISION_LIMIT = 40;
const PROBE_REPORT: IntentCheckReport = { kind: "intent-check", summary: "Probe.", items: [] };

const now = (): string => new Date().toISOString();

export function intentCheckDue(run: TeamRun): boolean {
  return run.intentCheck === "on";
}

const modeOf = (run: TeamRun): IntentMode => (run.autonomy === "autonomous" ? "autonomous" : "supervised");

const codeOf = (error: unknown): string | undefined => (error instanceof TeamError ? error.code : undefined);
const STOPPED: readonly TeamRun["status"][] = ["paused", "cancelled", "blocked"];

function statementOf(record: ObjectiveRecord): IntentStatement {
  return { objective: record.statement.objective, directions: record.statement.directions.map(item => item.text) };
}

export class TeamIntent {
  goals?: GoalRecordPort;

  constructor(private readonly host: IntentHost) {}

  hold(holder: IntentHolder, member: TeamMember): boolean {
    const run = holder.run;
    if (!intentCheckDue(run)) return false;
    const state = holder.intentCheck;
    if (state?.revision === run.revision) return this.holdCurrent(holder, state, member);
    if (state) {
      this.releaseWaits(holder, state, "replanned");
      delete holder.intentCheck;
    }
    return this.holdNew(holder, member);
  }

  step(holder: IntentHolder): boolean {
    const state = holder.intentCheck;
    if (!state) return false;
    if (state.revision !== holder.run.revision) {
      this.releaseWaits(holder, state, "replanned");
      delete holder.intentCheck;
      this.host.save(holder);
      return false;
    }
    switch (state.status) {
      case "queued": return this.launch(holder, state);
      case "checking": return this.checkingStep(holder, state);
      case "waiting": return this.waitingStep(holder, state);
      case "correcting": return state.correctedMemberId === undefined ? this.correct(holder, state) : false;
      case "accepting": return this.consumeHeld(holder, state);
      default: return false;
    }
  }

  screen(holder: IntentHolder, member: TeamMember, report: TeamReport): TeamReport {
    if (member.role !== "intent-checker") return report;
    if (report.kind !== "intent-check") {
      return { kind: "blocked", summary: `The intent checker sent a ${report.kind} report instead of an intent check; its text is withheld.` };
    }
    const record = this.readyRecord(holder);
    const statement = record ? statementOf(record) : undefined;
    const { kept, dropped } = screenIntentReport(report, { statement, configured: this.configured(holder.run) });
    const state = holder.intentCheck;
    if (state && state.revision === holder.run.revision && state.checkerMemberId === member.memberId) state.screened = { ...dropped };
    return kept;
  }

  consume(holder: IntentHolder, member: TeamMember): void {
    const state = holder.intentCheck;
    if (!state || state.status !== "checking" || state.revision !== holder.run.revision || state.checkerMemberId !== member.memberId) return;
    const report = member.report;
    if (report?.kind !== "intent-check") {
      this.failure(holder, state);
      return;
    }
    const checker = member.memberId;
    const revision = state.revision;
    this.host.operation(holder, signal => this.readOnly(member, signal), clean => this.complete(holder, checker, revision, report, clean), member);
  }

  failed(holder: IntentHolder, member: TeamMember): boolean {
    if (member.role !== "intent-checker") return false;
    const state = holder.intentCheck;
    if (state?.status === "checking" && state.revision === holder.run.revision && state.checkerMemberId === member.memberId) this.failure(holder, state);
    return true;
  }

  context(holder: IntentHolder, member: TeamMember): IntentContext | null {
    const state = holder.intentCheck;
    if (!state || state.status !== "checking" || state.checkerMemberId !== member.memberId) return null;
    const run = holder.run;
    const record = this.readyRecord(holder);
    if (!record) {
      this.stopChecker(holder, state, member, "record-unavailable");
      return null;
    }
    const plan = run.members.find(item => item.memberId === state.planMemberId);
    const built = plan
      ? intentContext({ run, record, planMember: plan, mode: modeOf(run), criteriaDue: criteriaDue(record), checks: this.configured(run) })
      : undefined;
    if (!built) {
      this.stopChecker(holder, state, member, "context-too-large");
      return null;
    }
    return built;
  }

  release(holder: IntentHolder, cause: "cancelled" | "replanned"): void {
    this.releaseWaits(holder, holder.intentCheck, cause);
  }

  answerNote(holder: IntentHolder, decision: TeamDecision): string | undefined {
    return holder.intentCheck?.decisionId === decision.id ? INTENT_EVENTS.answered : undefined;
  }

  private holdCurrent(holder: IntentHolder, state: IntentCheckState, member: TeamMember): boolean {
    switch (state.status) {
      case "queued":
      case "checking":
      case "waiting":
        state.planMemberId = member.memberId;
        return true;
      case "accepting":
      case "correcting":
        state.status = state.reason ? "skipped" : "done";
        this.host.save(holder);
        return false;
      default:
        return false;
    }
  }

  private holdNew(holder: IntentHolder, member: TeamMember): boolean {
    const run = holder.run;
    if (!run.goal) {
      const note = runObjectiveNote(holder, planRunObjective(holder, member.memberId, now()));
      if (note !== undefined) this.host.event(holder, note);
    }
    const record = this.readyRecord(holder);
    if (!record) return this.skipAtHold(holder, member, "record-unavailable");
    if ("skipped" in chooseIntentChecker(run.lineup, member.modelProfile, this.host.limited())) {
      return this.skipAtHold(holder, member, "no-eligible-profile");
    }
    const room = this.probeRoom(holder, record);
    if (room) return this.skipAtHold(holder, member, room);
    holder.intentCheck = { revision: run.revision, planMemberId: member.memberId, status: "queued", failures: 0 };
    this.host.event(holder, INTENT_EVENTS.held);
    this.host.save(holder);
    return true;
  }

  private skipAtHold(holder: IntentHolder, member: TeamMember, reason: IntentSkipReason): boolean {
    holder.intentCheck = { revision: holder.run.revision, planMemberId: member.memberId, status: "skipped", failures: 0, reason };
    this.writeSkipLog(holder, reason);
    this.host.event(holder, INTENT_EVENTS.skipped[reason]);
    this.host.save(holder);
    return false;
  }

  private lateSkip(holder: IntentHolder, state: IntentCheckState, reason: IntentSkipReason): void {
    state.status = "accepting";
    state.reason = reason;
    this.writeSkipLog(holder, reason);
    this.host.event(holder, INTENT_EVENTS.skipped[reason]);
    this.host.save(holder);
  }

  private stopChecker(holder: IntentHolder, state: IntentCheckState, member: TeamMember, reason: IntentSkipReason): void {
    member.status = "stopped";
    member.stoppedReason = INTENT_EVENTS.skipped[reason];
    this.lateSkip(holder, state, reason);
  }

  private writeSkipLog(holder: IntentHolder, reason: IntentSkipReason): void {
    try {
      const record = this.readyRecord(holder);
      if (!record) return;
      const next = skipIntentCheck(record, { runId: holder.run.id, revision: holder.run.revision, reason, at: now() });
      if (next) this.writeRecord(holder, record, next);
    } catch {
    }
  }

  private probeRoom(holder: IntentHolder, record: ObjectiveRecord): IntentSkipReason | undefined {
    try {
      applyIntentReport(record, PROBE_REPORT, {
        runId: holder.run.id, revision: holder.run.revision, checkerMemberId: "probe", decisionId: "probe",
        mode: modeOf(holder.run), goal: holder.run.goal !== undefined, configured: this.configured(holder.run), at: now(),
      });
      return undefined;
    } catch (error) {
      return codeOf(error) === "objective-log-full" ? "log-full" : "record-unavailable";
    }
  }

  private launch(holder: IntentHolder, state: IntentCheckState): boolean {
    const plan = holder.run.members.find(member => member.memberId === state.planMemberId);
    const choice = chooseIntentChecker(holder.run.lineup, plan?.modelProfile, this.host.limited());
    if ("skipped" in choice) {
      this.lateSkip(holder, state, "no-eligible-profile");
      return true;
    }
    state.status = "checking";
    this.host.prepare(holder, "intent-checker", undefined, member => {
      state.checkerMemberId = member.memberId;
    }, { prompt: intentCheckerPrompt(choice.profile.provider, choice.profile), profile: choice.profile });
    this.host.save(holder);
    return true;
  }

  private checkingStep(holder: IntentHolder, state: IntentCheckState): boolean {
    if (holder.run.members.some(member => member.memberId === state.checkerMemberId)) return true;
    state.status = "queued";
    delete state.checkerMemberId;
    this.host.save(holder);
    return true;
  }

  private waitingStep(holder: IntentHolder, state: IntentCheckState): boolean {
    const decision = holder.run.decisions.find(item => item.id === state.decisionId);
    if (!decision || decision.answer === undefined) {
      if (holder.run.status !== "needs-input") {
        holder.run.status = "needs-input";
        this.host.save(holder);
      }
      return true;
    }
    this.recordAnswer(holder, decision);
    state.status = "correcting";
    this.host.save(holder);
    return this.correct(holder, state, decision);
  }

  private recordAnswer(holder: IntentHolder, decision: TeamDecision): void {
    const owner = decision.answeredBy === "owner";
    try {
      const record = this.readyRecord(holder);
      if (!record) throw new Error("the objective record is unavailable");
      if (owner) {
        const next = answerIntentQuestions(record, { decisionId: decision.id, runId: holder.run.id, text: decision.answer ?? "", at: now() });
        if (next) this.writeRecord(holder, record, next);
        return;
      }
      const next = releaseIntentQuestions(record, { decisionId: decision.id, runId: holder.run.id, cause: "delegated-answer", at: now() });
      if (next) {
        this.writeRecord(holder, record, next);
        this.host.event(holder, INTENT_EVENTS.released["delegated-answer"]);
      }
    } catch {
      this.host.event(holder, owner ? INTENT_EVENTS.answerUnrecorded : INTENT_EVENTS.releaseUnrecorded);
    }
  }

  private correct(holder: IntentHolder, state: IntentCheckState, decision?: TeamDecision): boolean {
    if (state.correctedMemberId !== undefined) return false;
    const record = this.readyRecord(holder);
    const applied = record && state.checkerMemberId !== undefined ? intentApplied(record, state.checkerMemberId) : undefined;
    if (!record || !applied) {
      this.lateSkip(holder, state, "record-unavailable");
      return true;
    }
    const feedback = correctionFeedback(record, applied, decision ?? holder.run.decisions.find(item => item.id === state.decisionId));
    state.status = "correcting";
    this.host.prepare(holder, "project-manager", feedback, member => {
      state.correctedMemberId = member.memberId;
    });
    this.host.event(holder, INTENT_EVENTS.correcting);
    this.host.save(holder);
    return true;
  }

  private consumeHeld(holder: IntentHolder, state: IntentCheckState): boolean {
    const plan = holder.run.members.find(member => member.memberId === state.planMemberId);
    if (plan?.report?.kind !== "plan") {
      state.status = "skipped";
      this.host.save(holder);
      return false;
    }
    this.host.consume(holder, plan);
    return true;
  }

  private readOnly(member: TeamMember, signal: AbortSignal): Promise<boolean | undefined> {
    return assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefix(), signal).then(() => true, () => signal.aborted ? undefined : false);
  }

  private complete(holder: IntentHolder, checker: string, revision: number, report: IntentCheckReport, clean: boolean | undefined): void {
    const state = holder.intentCheck;
    if (!state || state.status !== "checking" || state.revision !== revision || state.checkerMemberId !== checker || holder.run.revision !== revision) return;
    if (clean === undefined || STOPPED.includes(holder.run.status) || holder.run.recovery?.status === "stopping") return;
    if (!clean) {
      this.failure(holder, state);
      return;
    }
    const record = this.readyRecord(holder);
    if (!record) {
      this.lateSkip(holder, state, "record-unavailable");
      return;
    }
    const decisionId = randomUUID();
    const existing = intentApplied(record, checker);
    let current = record;
    let waitingId: string | undefined;
    if (existing) {
      waitingId = (existing.after as { inline: { decision?: string } }).inline.decision;
    } else {
      let applied: IntentApplied;
      try {
        applied = applyIntentReport(record, report, this.applyContext(holder, state, checker, decisionId));
      } catch (error) {
        this.lateSkip(holder, state, codeOf(error) === "objective-log-full" ? "log-full" : "record-unavailable");
        return;
      }
      if (applied.decision && holder.run.decisions.length >= DECISION_LIMIT) {
        this.host.block(holder, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team."));
        return;
      }
      try {
        this.writeRecord(holder, record, applied.record);
      } catch {
        this.lateSkip(holder, state, "record-unavailable");
        return;
      }
      current = applied.record;
      waitingId = applied.decision ? decisionId : undefined;
    }
    const decision = waitingId !== undefined ? intentDecision(current, waitingId) : undefined;
    if (waitingId === undefined || decision === undefined) {
      state.status = "accepting";
      this.host.event(holder, INTENT_EVENTS.accepted);
      this.host.save(holder);
      return;
    }
    if (!holder.run.decisions.some(item => item.id === waitingId)) {
      holder.run.decisions.push({
        id: waitingId, memberId: checker, revision, question: decision.question, options: decision.options,
        intentQuestions: decision.questions, createdAt: now(),
      });
    }
    state.decisionId = waitingId;
    state.status = "waiting";
    holder.run.status = "needs-input";
    this.host.event(holder, INTENT_EVENTS.waiting);
    this.host.save(holder);
  }

  private applyContext(holder: IntentHolder, state: IntentCheckState, checker: string, decisionId: string): IntentApplyContext {
    return {
      runId: holder.run.id, revision: holder.run.revision, checkerMemberId: checker, decisionId, mode: modeOf(holder.run),
      goal: holder.run.goal !== undefined, configured: this.configured(holder.run), at: now(), screened: state.screened,
    };
  }

  private failure(holder: IntentHolder, state: IntentCheckState): void {
    state.failures = (state.failures + 1) as 1 | 2;
    if (state.failures >= 2) {
      this.lateSkip(holder, state, "checker-failed");
      return;
    }
    state.status = "queued";
    delete state.checkerMemberId;
    delete state.screened;
    this.host.event(holder, INTENT_EVENTS.replaced);
    this.host.save(holder);
  }

  private releaseWaits(holder: IntentHolder, state: IntentCheckState | undefined, cause: IntentReleaseCause): void {
    if (state?.decisionId === undefined) return;
    try {
      const record = this.readyRecord(holder);
      if (!record) throw new Error("the objective record is unavailable");
      const next = releaseIntentQuestions(record, { decisionId: state.decisionId, runId: holder.run.id, cause, at: now() });
      if (next === undefined) return;
      this.writeRecord(holder, record, next);
      this.host.event(holder, INTENT_EVENTS.released[cause]);
    } catch {
      this.host.event(holder, INTENT_EVENTS.releaseUnrecorded);
    }
  }

  private configured(run: TeamRun): TeamCommand[] {
    return [...(this.host.project(run)?.team?.checks ?? [])];
  }

  private stateOfRecord(holder: IntentHolder): ObjectiveState {
    return heldRecordState(holder, this.goals);
  }

  private readyRecord(holder: IntentHolder): ObjectiveRecord | undefined {
    const state = this.stateOfRecord(holder);
    return state.kind === "ready" ? state.record : undefined;
  }

  private writeRecord(holder: IntentHolder, previous: ObjectiveRecord, next: ObjectiveRecord): void {
    writeHeldRecord(holder, this.goals, previous, next);
  }
}
