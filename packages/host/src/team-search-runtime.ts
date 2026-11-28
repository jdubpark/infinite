import { randomUUID } from "node:crypto";
import { heldRecordState } from "./objective-holder.js";
import type { GoalRecordPort } from "./objective-intent.js";
import { commandDigest } from "./objective-input.js";
import type { Criterion } from "./objective-types.js";
import { familyOf } from "./permission-families.js";
import {
  admit,
  isOpen,
  outcomeSource,
  searchPolicy,
  step,
  type Admission,
  type AdmissionFacts,
  type Decision,
  type GateOutcome,
  type LeaveReason,
  type RunView,
  type SearchClass,
  type SearchEvent,
  type SearchPolicy,
  type SearchState,
  type TeamSearch,
} from "./search-engine.js";
import { coversPoint, memberLimit, type TeamCommand, type TeamMember, type TeamModelProfile, type TeamRun, type TeamTask } from "./team-types.js";
import { teamPathAllowed } from "./team-workspace.js";
import type { Config, Provider } from "./types.js";

const MAX_START_HISTORY = 100;
const MAX_WIDENED_HISTORY = 10;

export type SearchHolder = {
  run: TeamRun;
  objectiveRecord?: unknown;
  prepared?: boolean;
};

export interface SearchHost {
  readonly config: Config;
  now(): string;
  limited(): ReadonlySet<Provider>;
  requiredChecks(run: TeamRun): readonly TeamCommand[] | undefined;
  freeSessionSlots(): number;
  activeWorkerCount(run: TeamRun): number;
  save(holder: SearchHolder): void;
  event(holder: SearchHolder, text: string): void;
  runCheckCommand(holder: SearchHolder, search: SearchState, command: TeamCommand, commit: string, memberId?: string): void;
  captureCandidate(holder: SearchHolder, search: SearchState, member: TeamMember, task: TeamTask): void;
  startChallengers(holder: SearchHolder, search: SearchState, task: TeamTask, launch: number, profiles: TeamModelProfile[], baseCommit: string): void;
  cancelChallengerLaunch(holder: SearchHolder, search: SearchState, launch: number): void;
  stopMember(holder: SearchHolder, member: TeamMember, reason: string): void;
  stopOperations(holder: SearchHolder, search: SearchState): void;
  integrateWinner(holder: SearchHolder, search: SearchState, member: TeamMember, task: TeamTask): void;
  releaseChampion(holder: SearchHolder, search: SearchState, member: TeamMember, task: TeamTask, state: "exhausted" | "abandoned", reason: string): void;
  pauseForBrake(holder: SearchHolder, reason: string): void;
  isExploratoryStart?(run: TeamRun, task: TeamTask): boolean;
  close?(): void;
}

export interface SearchAdmissionOptions {
  criterion?: Criterion;
  pinnedAtBase?: boolean;
  explore?: boolean;
  now?: string;
}

export function projectSearchConfig(run: Pick<TeamRun, "projectId" | "handoff">, config: Pick<Config, "projects">): TeamSearch | undefined {
  return run.handoff?.project?.search ?? config.projects.find(item => item.id === run.projectId)?.team?.search;
}

export function resolveTaskCriterion(
  holder: SearchHolder,
  task: TeamTask,
  goals?: GoalRecordPort,
  override?: Criterion,
): { criterion?: Criterion; shared: boolean } {
  if (override) {
    const shared = holder.run.tasks.some(other => other.id !== task.id && other.criterionRefs?.criteria.includes(override.id));
    return { criterion: override, shared };
  }
  const refs = task.criterionRefs?.criteria ?? [];
  if (refs.length !== 1) return { shared: false };
  const criterionId = refs[0]!;
  const state = heldRecordState(holder, goals);
  if (state.kind !== "ready") return { shared: false };
  const criterion = state.record.criteria.find(item => item.id === criterionId);
  const shared = holder.run.tasks.some(other => other.id !== task.id && other.criterionRefs?.criteria.includes(criterionId));
  return { criterion, shared };
}

export function searchCommandFor(run: TeamRun, search: SearchState, required: readonly TeamCommand[] | undefined): TeamCommand | undefined {
  return (required ?? []).find(command => commandDigest(command) === search.command);
}

export class TeamSearchRuntime {
  goals?: GoalRecordPort;
  private readonly projectStarts = new Map<string, boolean[]>();
  private readonly projectWidened = new Map<string, SearchClass[]>();
  private readonly pausedProjects = new Set<string>();
  private readonly resumedSearches = new Set<string>();

  constructor(private readonly host: SearchHost) {}

  policyFor(run: Pick<TeamRun, "projectId" | "handoff">): SearchPolicy {
    return searchPolicy(projectSearchConfig(run, this.host.config));
  }

  isEnabled(run: Pick<TeamRun, "projectId" | "handoff">): boolean {
    return this.policyFor(run).mode !== "off";
  }

  hasOpenSearch(run: TeamRun, memberId?: string): boolean {
    return Boolean(run.searches?.some(item => isOpen(item) && (memberId === undefined || item.contestants.some(c => c.memberId === memberId))));
  }

  isOpenMember(run: TeamRun, memberId: string): boolean {
    return this.findOpenMemberSearch(run, memberId) !== undefined;
  }

  findMemberSearch(run: TeamRun, memberId: string, mode?: SearchState["mode"]): SearchState | undefined {
    return run.searches?.find(
      item => (mode === undefined || item.mode === mode) && item.contestants.some(c => c.memberId === memberId),
    );
  }

  findOpenMemberSearch(run: TeamRun, memberId: string, mode?: SearchState["mode"]): SearchState | undefined {
    return run.searches?.find(
      item => isOpen(item) && (mode === undefined || item.mode === mode) && item.contestants.some(c => c.memberId === memberId),
    );
  }

  close(): void {
    this.host.close?.();
  }

  hasPausedBrake(projectId: string): boolean {
    return this.pausedProjects.has(projectId);
  }

  clearPausedBrake(projectId: string): void {
    this.pausedProjects.delete(projectId);
  }

  outcomeSourceForTask(run: TeamRun, task: TeamTask): "search" | "production" {
    const search = run.searches?.find(item => item.decisionKey === task.id);
    return outcomeSource(search);
  }

  widenedHistory(projectId: string): readonly SearchClass[] {
    return this.projectWidened.get(projectId) ?? [];
  }

  startHistory(projectId: string): readonly boolean[] {
    return this.projectStarts.get(projectId) ?? [];
  }

  admitTaskSearch(holder: SearchHolder, member: TeamMember, task: TeamTask, options?: SearchAdmissionOptions): Admission | undefined {
    const run = holder.run;
    const policy = this.policyFor(run);
    if (policy.mode === "off") return undefined;

    const { criterion, shared } = resolveTaskCriterion(holder, task, this.goals, options?.criterion);
    const required = (this.host.requiredChecks(run) ?? []).map(commandDigest);
    const existing = run.searches ?? [];
    const owned = Boolean(
      criterion?.pinned?.some(pin => teamPathAllowed(pin.path, task.paths) || task.paths.some(path => teamPathAllowed(path, [pin.path]))),
    );
    const firstAttempt = !run.members.some(
      other => other.revision === run.revision && other.taskId === task.id && other.memberId !== member.memberId,
    );
    const atBase = options?.pinnedAtBase ?? (Boolean(criterion?.pinned?.length) && Boolean(member.baseCommit) && run.headCommit === member.baseCommit);

    const facts: AdmissionFacts = {
      id: randomUUID(),
      now: options?.now ?? this.host.now(),
      policy,
      routing: {
        mode: run.routing?.mode ?? "off",
        coversStart: coversPoint(run, "start"),
        revoked: Boolean(run.routingRevokedAt),
      },
      run: {
        goalCycle: Boolean(run.goal),
        recordDigest: Boolean(run.goal?.record),
        requiredChecks: required,
        searches: existing.length,
        wideSearch: existing.some(item => item.state === "wide"),
        ...(run.goal?.deadlineAt ? { deadline: run.goal.deadlineAt } : {}),
      },
      task: {
        role: member.role,
        risk: task.risk ?? "normal",
        firstAttempt,
        ...(criterion ? { criterionId: criterion.id } : {}),
        criterionShared: shared,
        duel: Boolean(run.replay),
        exploratoryStart: options?.explore ?? this.host.isExploratoryStart?.(run, task) ?? false,
        baseCommit: member.baseCommit,
        decisionKey: task.id,
      },
      champion: {
        memberId: member.memberId,
        profileId: member.modelProfile?.id ?? "",
      },
      ...(criterion ? { criterion } : {}),
      pins: { atBase, owned },
      project: {
        paused: this.pausedProjects.has(run.projectId),
        starts: this.startHistory(run.projectId),
      },
    };

    const result = admit(facts);
    if (policy.mode === "live" && (result.admitted || result.condition === 7)) {
      this.recordStart(run.projectId, result.admitted);
    }
    if (!result.admitted) return result;

    (run.searches ??= []).push(result.search);
    this.resumedSearches.add(result.search.id);
    this.host.event(holder, `Admitted ${result.search.mode} search ${result.search.id} for task ${task.title}.`);
    this.applyDecisions(holder, result.search, task, result.decisions);
    this.host.save(holder);
    return result;
  }

  private isReleasedChampion(search: SearchState, memberId: string): boolean {
    return (search.state === "exhausted" || search.state === "abandoned")
      && search.contestants[0]?.memberId === memberId
      && search.contestants[0]?.left === undefined;
  }

  onMemberResult(holder: SearchHolder, member: TeamMember): boolean {
    const search = this.findMemberSearch(holder.run, member.memberId, "live");
    if (!search) return false;
    if (isOpen(search)) {
      this.dispatchEvent(holder, search.id, { kind: "result", memberId: member.memberId });
      return true;
    }
    if (this.isReleasedChampion(search, member.memberId) && member.status !== "stopped") return false;
    member.status = "stopped";
    this.host.event(holder, `Ignored late result from search contestant ${member.title}; search ${search.id} is already ${search.state}.`);
    this.host.save(holder);
    return true;
  }

  onMemberCaptured(holder: SearchHolder, searchId: string, input: { memberId: string; commit: string; tree: string; scope: "ok" | "violation"; empty: boolean }): void {
    this.dispatchEvent(holder, searchId, { kind: "captured", ...input });
  }

  onGateCompleted(holder: SearchHolder, searchId: string, input: { outcome: GateOutcome; ms: number; failures?: number; memberId?: string }): void {
    if (input.memberId === undefined) {
      this.dispatchEvent(holder, searchId, { kind: "base", outcome: input.outcome, ms: input.ms, ...(input.failures !== undefined ? { failures: input.failures } : {}) });
    } else {
      this.dispatchEvent(holder, searchId, { kind: "gated", memberId: input.memberId, outcome: input.outcome, ms: input.ms, ...(input.failures !== undefined ? { failures: input.failures } : {}) });
    }
  }

  onTaskIntegrated(holder: SearchHolder, member: TeamMember, task: TeamTask, commit: string, tree: string, empty: boolean): void {
    const search = this.findOpenMemberSearch(holder.run, member.memberId, "measure");
    if (!search) return;
    this.dispatchEvent(holder, search.id, { kind: "integrated", memberId: member.memberId, commit, tree, empty });
    const count = (holder.run.searches ?? []).length;
    if (count > 0) this.dispatchEvent(holder, search.id, { kind: "boundary", searches: count });
  }

  onMemberLeft(holder: SearchHolder, member: TeamMember, reason: LeaveReason): boolean {
    const search = this.findMemberSearch(holder.run, member.memberId);
    if (!search) return false;
    if (isOpen(search)) {
      const isChampion = search.contestants[0]?.memberId === member.memberId;
      const updated = this.dispatchEvent(holder, search.id, { kind: "left", memberId: member.memberId, reason });
      if (search.mode !== "live") return false;
      if (!isChampion) return true;
      return Boolean(updated && isOpen(updated));
    }
    if (search.mode !== "live") return false;
    if (this.isReleasedChampion(search, member.memberId)) return false;
    member.status = "stopped";
    this.host.save(holder);
    return true;
  }

  onHalt(holder: SearchHolder, reason: Extract<SearchEvent, { kind: "halt" }>["reason"]): void {
    for (const search of holder.run.searches ?? []) {
      if (isOpen(search)) this.dispatchEvent(holder, search.id, { kind: "halt", reason });
    }
  }

  onTick(holder: SearchHolder): void {
    for (const search of holder.run.searches ?? []) {
      if (!isOpen(search)) continue;
      if (!this.resumedSearches.has(search.id)) {
        this.resumedSearches.add(search.id);
        this.dispatchEvent(holder, search.id, { kind: "resume" });
      } else {
        this.dispatchEvent(holder, search.id, { kind: "tick" });
      }
    }
  }

  dispatchEvent(holder: SearchHolder, searchId: string, event: SearchEvent): SearchState | undefined {
    const run = holder.run;
    const searches = run.searches;
    if (!searches) return undefined;
    const index = searches.findIndex(item => item.id === searchId);
    if (index < 0) return undefined;

    const current = searches[index]!;
    const task = run.tasks.find(item => item.id === current.decisionKey);
    const view = this.buildRunView(run, current);
    const result = step(current, event, view);
    searches[index] = result.search;
    if (task) this.applyDecisions(holder, result.search, task, result.decisions);
    this.host.save(holder);
    return result.search;
  }

  private buildRunView(run: TeamRun, current: SearchState): RunView {
    const policy = this.policyFor(run);
    const championId = current.contestants[0]?.memberId;
    const champion = run.members.find(item => item.memberId === championId);
    const championFamily = champion?.modelProfile ? familyOf(champion.modelProfile) : undefined;
    const limited = this.host.limited();
    const candidates = (run.lineup?.implementers ?? []).map(profile => ({
      profileId: profile.id,
      ...(familyOf(profile) ? { family: familyOf(profile) } : {}),
      limited: limited.has(profile.provider),
    }));
    const activeWorkers = this.host.activeWorkerCount(run);
    const spareWorkerSlots = Math.max(0, run.parallelism - activeWorkers);
    const spareAttempts = Math.max(0, memberLimit(run) - run.members.length);

    return {
      now: this.host.now(),
      policy,
      checkMinutes: this.host.config.teams?.checkMinutes ?? 60,
      ...(run.goal?.deadlineAt ? { deadline: run.goal.deadlineAt } : {}),
      otherSearchWide: (run.searches ?? []).some(other => other.id !== current.id && itemIsOpenWide(other)),
      ...(championFamily ? { championFamily } : {}),
      candidates,
      spareWorkerSlots,
      freeSessionSlots: Math.max(0, this.host.freeSessionSlots()),
      spareAttempts,
      widened: this.widenedHistory(run.projectId),
    };
  }

  private applyDecisions(holder: SearchHolder, search: SearchState, task: TeamTask, decisions: readonly Decision[]): void {
    const run = holder.run;
    for (const decision of decisions) {
      if (decision.kind === "base-run") {
        const command = searchCommandFor(run, search, this.host.requiredChecks(run));
        if (command) this.host.runCheckCommand(holder, search, command, decision.commit);
      } else if (decision.kind === "capture") {
        const member = run.members.find(item => item.memberId === decision.memberId);
        if (member) this.host.captureCandidate(holder, search, member, task);
      } else if (decision.kind === "gate") {
        const command = searchCommandFor(run, search, this.host.requiredChecks(run));
        if (command) this.host.runCheckCommand(holder, search, command, decision.commit, decision.memberId);
      } else if (decision.kind === "start-challengers") {
        const profiles = decision.profileIds
          .map(id => run.lineup?.implementers.find(profile => profile.id === id))
          .filter((profile): profile is TeamModelProfile => profile !== undefined);
        if (profiles.length) this.host.startChallengers(holder, search, task, decision.launch, profiles, decision.baseCommit);
      } else if (decision.kind === "stop") {
        for (const memberId of decision.memberIds) {
          const member = run.members.find(item => item.memberId === memberId);
          if (member) this.host.stopMember(holder, member, decision.reason);
        }
      } else if (decision.kind === "stop-operations") {
        this.host.stopOperations(holder, search);
      } else if (decision.kind === "integrate") {
        const member = run.members.find(item => item.memberId === decision.memberId);
        if (member) this.host.integrateWinner(holder, search, member, task);
      } else if (decision.kind === "release") {
        const member = run.members.find(item => item.memberId === decision.memberId);
        if (member) this.host.releaseChampion(holder, search, member, task, decision.state, decision.reason);
      } else if (decision.kind === "cancel-launch") {
        this.host.cancelChallengerLaunch(holder, search, decision.launch);
      } else if (decision.kind === "widened") {
        this.recordWidened(run.projectId, decision.class);
      } else if (decision.kind === "pause") {
        this.pausedProjects.add(run.projectId);
        this.host.pauseForBrake(holder, "Widened search rescue rate fell below the project safety threshold; pausing search.");
      }
    }
  }

  private recordStart(projectId: string, admitted: boolean): void {
    const history = [...(this.projectStarts.get(projectId) ?? []), admitted];
    if (history.length > MAX_START_HISTORY) history.splice(0, history.length - MAX_START_HISTORY);
    this.projectStarts.set(projectId, history);
  }

  private recordWidened(projectId: string, result: SearchClass): void {
    const history = [...(this.projectWidened.get(projectId) ?? []), result];
    if (history.length > MAX_WIDENED_HISTORY) history.splice(0, history.length - MAX_WIDENED_HISTORY);
    this.projectWidened.set(projectId, history);
  }
}

function itemIsOpenWide(search: SearchState): boolean {
  return isOpen(search) && search.state === "wide";
}
