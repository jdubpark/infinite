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

export type VerdictState = {
  revision: number; head: string; kind: "reviewed" | "no-change"; verdictId: string;
  status: "testing" | "queued" | "evaluating" | "releasing" | "done";
  failures: 0 | 1; excluded?: string[];
  since?: string;
  judged?: Record<string, string>;
  receiptsFrom: string;
  evaluatorMemberId?: string;
  heldMemberId?: string;
  choice?: { profileId: string; provider: Provider; model?: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  report?: VerdictReport; composed?: ComposedVerdict; reason?: VerdictReason;
  written?: "wrote" | "log-full" | "record-unavailable" | "write-failed";
};

export type VerdictHolder = { run: TeamRun; verdict?: VerdictState; objectiveRecord?: unknown; checkHead?: string };

export type VerdictHost = {
  holder(runId: string): VerdictHolder | undefined;
  prepare(holder: VerdictHolder, onPrepared: (member: TeamMember) => void, prebuilt: { prompt: string; profile: TeamModelProfile }): void;
  consume(holder: VerdictHolder, member: TeamMember): void;
  operation(holder: VerdictHolder, perform: (signal: AbortSignal) => Promise<boolean | undefined>, complete: (clean: boolean | undefined) => void, member: TeamMember): void;
  save(holder: VerdictHolder): void;
  event(holder: VerdictHolder, text: string): void;
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

export const VERDICT_TESTING_WAIT_MS = 300_000;
const STOPPED: readonly TeamRun["status"][] = ["paused", "cancelled", "blocked"];
const EVENT_PROVIDERS: readonly Provider[] = ["claude", "codex", "opencode"];

const headOf = (run: TeamRun): string | undefined => run.headCommit ?? run.baseCommit;

function checksPassed(holder: VerdictHolder, head: string): boolean | undefined {
  if (holder.checkHead !== head) return undefined;
  const rows = finalCheckRound(holder.run, head);
  if (rows.length === 0) return undefined;
  return rows.every(row => row.status === "passed");
}

function reviewApproved(run: TeamRun, head: string): boolean | undefined {
  if (run.headCommit !== head || run.review === undefined || run.review.revision !== run.revision) return undefined;
  return run.review.verdict === "approved";
}

function changedPathsOf(run: TeamRun, head: string): { paths: string[]; truncated: boolean } {
  if (run.changes?.headCommit !== head) return { paths: [], truncated: true };
  return { paths: run.changes.files.map(file => file.path), truncated: run.changes.truncated };
}

function digestsOf(record: ObjectiveRecord): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const item of record.criteria) {
    if (item.state !== "active") continue;
    const statement = item.statementOf === "objective" ? record.statement.objective : item.statement;
    digests[item.id] = createHash("sha256").update(canonicalJson({ statement, check: item.check })).digest("hex");
  }
  return digests;
}

function emptyVerdict(reason: VerdictReason): ComposedVerdict {
  return { result: "inconclusive", reason, criteria: [], counts: { met: 0, notMet: 0, inconclusive: 0, pendingOwner: 0 }, dropped: { unknownIds: 0, handles: 0 } };
}

type Cycle = { authors: TeamModelProfile[]; reviewers: TeamModelProfile[]; managers: TeamModelProfile[] };

export class TeamVerdicts {
  goals?: GoalRecordPort;

  constructor(private readonly host: VerdictHost) {}

  reviewed(holder: VerdictHolder): boolean {
    if (holder.run.verdicts !== "on") return false;
    this.dropStale(holder);
    const state = holder.verdict;
    if (!state) return this.startReviewed(holder);
    if (state.kind !== "reviewed" || state.status === "done") return false;
    this.advance(holder, state);
    return true;
  }

  holdNoChange(holder: VerdictHolder, member: TeamMember): boolean {
    const run = holder.run;
    if (run.verdicts !== "on" || run.goal?.parentRunId === undefined) return false;
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

  step(holder: VerdictHolder): boolean {
    if (holder.run.verdicts !== "on") return false;
    this.dropStale(holder);
    const state = holder.verdict;
    if (!state || state.status === "done") return false;
    if (STOPPED.includes(holder.run.status)) return false;
    this.advance(holder, state);
    return true;
  }

  screen(holder: VerdictHolder, member: TeamMember, report: TeamReport): TeamReport {
    if (member.role !== "evaluator") return report;
    if (report.kind !== "verdict") {
      return { kind: "blocked", summary: `The evaluator sent a ${report.kind} report instead of a verdict; its text is withheld.` };
    }
    const state = holder.verdict;
    if (state && this.liveEvaluator(holder, state, member)) state.report = report;
    return { kind: "verdict", result: report.result, criteria: report.criteria.map(item => ({ id: item.id, state: item.state, evidence: [] })) };
  }

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

  failed(holder: VerdictHolder, member: TeamMember): boolean {
    if (member.role !== "evaluator") return false;
    const state = holder.verdict;
    if (state && this.liveEvaluator(holder, state, member)) this.failure(holder, state);
    return true;
  }

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
    if (canonicalJson(state.judged ?? null) !== canonicalJson(digests)) {
      state.judged = digests;
      this.host.save(holder);
    }
    return built;
  }

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
    this.host.event(holder, VERDICT_EVENTS.held);
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
    if (this.host.register.reviewedReceipts(state.receiptsFrom, state.head) === "pending" && Number.isFinite(waited) && waited < VERDICT_TESTING_WAIT_MS) return;
    state.status = "queued";
    this.host.save(holder);
  }

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
    }, { prompt: evaluatorPrompt(profile.provider, profile), profile });
    this.host.save(holder);
  }

  private evaluating(holder: VerdictHolder, state: VerdictState): void {
    if (holder.run.members.some(member => member.memberId === state.evaluatorMemberId)) return;
    state.status = "queued";
    delete state.evaluatorMemberId;
    delete state.report;
    delete state.judged;
    this.host.save(holder);
  }

  private release(holder: VerdictHolder, state: VerdictState): void {
    const held = holder.run.members.find(member => member.memberId === state.heldMemberId);
    if (held?.report?.kind !== "no-change") {
      state.status = "done";
      this.host.save(holder);
      return;
    }
    this.host.consume(holder, held);
  }

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
    if (STOPPED.includes(holder.run.status) || holder.run.recovery?.status === "stopping") return;
    if (clean !== true || state.report === undefined) {
      this.failure(holder, state);
      return;
    }
    this.finish(holder, state, state.report);
  }

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

  private stopEvaluator(holder: VerdictHolder, state: VerdictState, member: TeamMember, reason: VerdictReason): void {
    member.status = "stopped";
    member.stoppedReason = VERDICT_EVENTS.skipped[reason];
    this.finish(holder, state, undefined, reason);
  }

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

  private judgedOnly(state: VerdictState, record: ObjectiveRecord, report: VerdictReport): VerdictReport {
    const digests = digestsOf(record);
    return { ...report, criteria: report.criteria.filter(item => digests[item.id] === undefined || state.judged?.[item.id] === digests[item.id]) };
  }

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

  private applied(composed: ComposedVerdict): boolean {
    return composed.criteria.some(item => item.evaluatorState !== undefined);
  }

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

  private factsOf(holder: VerdictHolder, state: VerdictState): { checksPassed?: boolean; reviewApproved?: boolean } {
    const source = state.kind === "reviewed" ? holder : this.host.holder(state.receiptsFrom);
    if (!source) return {};
    const passed = checksPassed(source, state.head);
    const approved = reviewApproved(source.run, state.head);
    return { ...(passed === undefined ? {} : { checksPassed: passed }), ...(approved === undefined ? {} : { reviewApproved: approved }) };
  }

  private changeListOf(holder: VerdictHolder, state: VerdictState): { paths: string[]; truncated: boolean } {
    if (state.kind === "reviewed") return changedPathsOf(holder.run, state.head);
    const parent = this.host.holder(state.receiptsFrom)?.run;
    if (parent?.changes?.headCommit === state.head) return changedPathsOf(parent, state.head);
    return { paths: [], truncated: false };
  }

  private receiptsOf(state: VerdictState): readonly ObjectiveReceipt[] | undefined {
    const receipts = this.host.register.reviewedReceipts(state.receiptsFrom, state.head);
    return receipts === "pending" ? undefined : receipts;
  }

  private cycleFor(run: TeamRun, state: VerdictState): Cycle | undefined {
    const own = this.cycleOf(run);
    if (state.kind === "reviewed") return own;
    const parent = this.host.holder(state.receiptsFrom)?.run;
    if (parent === undefined) return undefined;
    const before = this.cycleOf(parent);
    return { authors: [...own.authors, ...before.authors], reviewers: [...own.reviewers, ...before.reviewers], managers: [...own.managers, ...before.managers] };
  }

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

  private current(run: TeamRun, state: VerdictState): boolean {
    return state.revision === run.revision && state.head === headOf(run);
  }

  private liveEvaluator(holder: VerdictHolder, state: VerdictState, member: TeamMember): boolean {
    return state.status === "evaluating" && this.current(holder.run, state) && state.evaluatorMemberId === member.memberId;
  }

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
