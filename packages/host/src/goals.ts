import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { TeamService, TeamError } from "./teams.js";
import { createGoalSchema, goalActionSchema, goalOutcomeSchema, goalSteerSchema, type CreateGoal, type ProductGoal } from "./goal-types.js";
import type { Config } from "./types.js";
import type { CreateTeam, TeamGoalContext, TeamView } from "./team-types.js";
import type { LinearService } from "./linear.js";

type Action = { requestId: string; revision: number };
type PendingControl = { action: "pause" | "resume" | "cancel" | "steer"; requestId: string; teamId: string; revision: number; text?: string };
type Stored = {
  goal: ProductGoal;
  fingerprint: string;
  receipts: Record<string, string>;
  launch?: { request: CreateTeam; context: TeamGoalContext };
  control?: PendingControl;
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"]);

/** Goals select bounded work; the Team executor owns every agent and Git operation. */
export class GoalService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly teams: TeamService, private readonly linear?: LinearService) {
    this.directory = join(config.stateDir, "goals");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `goal:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.goal.id !== id) throw new TeamError(409, "invalid-goal-record", "A goal record cannot be authenticated.");
      this.records.set(id, stored);
      this.saved.set(id, JSON.stringify(stored));
    }
  }
  enabled() {
    const lineup = this.config.teams?.lineup;
    return Boolean(lineup && lineup.coordinator.tier === "strong" && lineup.reviewer.tier === "strong");
  }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "goal-not-found", "This goal does not exist.");
    return stored;
  }
  private save(stored: Stored) {
    if (this.saved.get(stored.goal.id) === JSON.stringify(stored)) return;
    stored.goal.updatedAt = now();
    writeSealed(join(this.directory, `${stored.goal.id}.sealed`), this.key, `goal:${stored.goal.id}`, stored);
    this.saved.set(stored.goal.id, JSON.stringify(stored));
  }
  private event(stored: Stored, text: string) {
    stored.goal.events.push({ at: now(), text });
    if (stored.goal.events.length > 200) stored.goal.events.splice(0, stored.goal.events.length - 200);
  }
  list() { return [...this.records.values()].map(({ goal }) => this.get(goal.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string) {
    const goal = structuredClone(this.record(id).goal);
    const tracking = this.linear?.updateGoal(goal, goal.linearTracking === true);
    goal.linear = this.linear?.getGoal(id) ?? tracking ?? goal.linear;
    goal.usage = this.teams.usageForRuns(goal.cycles.map(cycle => cycle.teamId));
    for (const cycle of goal.cycles) cycle.usage = this.teams.usageForRuns([cycle.teamId])?.total;
    return goal;
  }
  answer(teamId: string, decisionId: string, body: Action & { text: string }) {
    return this.enqueue(async () => {
      const team = this.teams.get(teamId);
      if (!team.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      return this.teams.answer(teamId, decisionId, body, () => {
        const { goal } = this.record(team.goal!.id);
        if (goal.activeTeamId !== teamId || !["running", "needs-input"].includes(goal.status) || Date.now() >= Date.parse(goal.deadlineAt))
          throw new TeamError(409, "goal-not-running", "Only the active team of a running goal can receive a decision.");
      });
    });
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ goal, launch, control }) => goal.projectId === projectId && (Boolean(launch || control || goal.activeTeamId) || ["running", "needs-input", "paused"].includes(goal.status)));
  }
  create(input: CreateGoal) {
    const request = createGoalSchema.parse(input);
    return this.enqueue(() => {
      const fingerprint = digest(request), prior = this.records.get(request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal.");
        return structuredClone(prior.goal);
      }
      if (!this.enabled()) throw new TeamError(409, "goals-not-configured", "Configure a team lineup with a strong coordinator and reviewer before starting a goal.");
      if (Buffer.byteLength(JSON.stringify(request)) > 40000) throw new TeamError(409, "goal-too-large", "Keep the goal and evidence below 40 KiB. Link to longer source material.");
      const project = this.config.projects.find(value => value.id === request.projectId);
      if (!project?.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "goal-project-not-configured", "Configure required checks or authorize the team to establish them before a goal can start.");
      if (request.linearIssueId && !project.linear) throw new TeamError(409, "linear-not-configured", "Configure Linear for this project before linking an issue.");
      const { requestId, ...fields } = request;
      const createdAt = now();
      const stored: Stored = { fingerprint, receipts: {}, goal: {
        ...fields, linearTracking: Boolean(project.linear), id: requestId, revision: 1, status: "running", createdAt, updatedAt: createdAt,
        deadlineAt: new Date(Date.now() + request.maxMinutes * 60000).toISOString(),
        lineup: structuredClone(this.config.teams!.lineup!), cycles: [], memberCount: 0, steering: [], events: [], outcomes: [],
      } };
      this.event(stored, "Goal approved. The coordinator can select and build work within its scope and limits.");
      this.records.set(requestId, stored); this.save(stored);
      stored.goal.linear = this.linear?.updateGoal(stored.goal, stored.goal.linearTracking === true); this.save(stored);
      return structuredClone(stored.goal);
    });
  }
  private replay(stored: Stored, action: string, body: Action & object) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ action, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal action.");
    return true;
  }
  private admit(stored: Stored, action: string, body: Action & object) {
    if (body.revision !== stored.goal.revision) throw new TeamError(409, "stale-goal-revision", "The goal changed. Refresh it before sending this action.");
    if (stored.control) throw new TeamError(409, "goal-control-pending", "The previous goal action is still being applied.");
    stored.receipts[body.requestId] = digest({ action, ...body });
    stored.goal.revision++;
  }
  private setControl(stored: Stored, action: PendingControl["action"], text?: string) {
    if (!stored.goal.activeTeamId) return;
    const team = this.teams.get(stored.goal.activeTeamId);
    if (["ready-for-review", "merged", "no-change", "cancelled", "blocked"].includes(team.status)) return;
    stored.control = { action, requestId: randomUUID(), teamId: team.id, revision: team.revision, ...(text ? { text } : {}) };
  }
  pause(id: string, input: Action) { return this.action(id, "pause", goalActionSchema.parse(input)); }
  resume(id: string, input: Action) { return this.action(id, "resume", goalActionSchema.parse(input)); }
  cancel(id: string, input: Action) { return this.action(id, "cancel", goalActionSchema.parse(input)); }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, action, body)) return structuredClone(goal);
      if (action !== "cancel" && terminal.has(goal.status)) throw new TeamError(409, "goal-not-running", "This goal has stopped. Start a new goal to approve more work.");
      if (action === "resume" && goal.status !== "paused") throw new TeamError(409, "goal-not-paused", "Only a paused goal can resume.");
      if (action === "resume" && Date.now() >= Date.parse(goal.deadlineAt)) throw new TeamError(409, "goal-deadline", "This goal's time limit has expired. Start a new goal to approve more time.");
      this.admit(stored, action, body);
      goal.status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "running";
      goal.reason = action === "resume" ? undefined : "The goal is stopping its active team. Existing work will remain available.";
      this.setControl(stored, action);
      this.event(stored, `Goal ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
      this.save(stored); return structuredClone(goal);
    });
  }
  steer(id: string, input: Action & { text: string }) {
    const body = goalSteerSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "steer", body)) return structuredClone(goal);
      if (!["running", "needs-input"].includes(goal.status)) throw new TeamError(409, "goal-not-running", "Resume the goal before sending direction, or start a new goal if it has stopped.");
      if (stored.launch) throw new TeamError(409, "goal-launch-pending", "The next feature is being attached. Retry this direction after it appears.");
      if (goal.steering.length >= 20 || Buffer.byteLength([goal.objective, ...goal.steering.map(item => `User direction: ${item.text}`), `User direction: ${body.text}`].join("\n\n")) > 24000)
        throw new TeamError(409, "goal-steering-limit", "Start a new goal with consolidated directions.");
      this.admit(stored, "steer", body);
      goal.steering.push({ text: body.text, revision: goal.revision, at: now() });
      this.setControl(stored, "steer", body.text);
      this.event(stored, "Direction recorded. The approved scope and execution limits remain in force.");
      this.save(stored); return structuredClone(goal);
    });
  }
  outcome(id: string, input: Action & { result: "achieved" | "not-achieved" | "inconclusive"; summary: string; evidence: string }) {
    const body = goalOutcomeSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "outcome", body)) return structuredClone(goal);
      if (!terminal.has(goal.status) || goal.activeTeamId || stored.control || stored.launch)
        throw new TeamError(409, "goal-still-active", "Stop the active work before recording a product outcome.");
      this.admit(stored, "outcome", body);
      goal.outcomes.push({ result: body.result, summary: body.summary, evidence: body.evidence, at: now(), revision: goal.revision });
      if (body.result === "achieved") goal.status = "achieved";
      else if (goal.status === "achieved") goal.status = goal.cycles.some(cycle => ["ready-for-review", "merged"].includes(cycle.status)) ? "ready-for-review" : "no-opportunity";
      this.event(stored, "A user recorded a product outcome with supporting evidence.");
      this.save(stored); return structuredClone(goal);
    });
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.tickQueued || this.closed) return;
      this.tickQueued = true;
      void this.enqueue(async () => {
        try {
          for (const stored of this.records.values()) {
            try { await this.step(stored); }
            catch (error) {
              if (this.closed) return;
              const reason = error instanceof TeamError ? error.message : "The goal could not advance. Its work and evidence remain available.";
              if (stored.goal.status !== "blocked" || stored.goal.reason !== reason) this.event(stored, reason);
              if (!["paused", "cancelled", "limit-reached"].includes(stored.goal.status)) stored.goal.status = "blocked";
              stored.goal.reason = reason; this.save(stored);
            }
          }
        } finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  private refresh(stored: Stored, team: TeamView) {
    const cycle = stored.goal.cycles.find(value => value.teamId === team.id)!;
    Object.assign(cycle, { status: team.status, memberCount: team.members.length, baseCommit: team.baseCommit, headCommit: team.headCommit, branch: team.branch, workspace: team.workspace, brief: team.brief, reason: team.reason });
    if (["ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(team.status)) cycle.finishedAt ??= now();
    stored.goal.memberCount = stored.goal.cycles.reduce((sum, value) => sum + value.memberCount, 0);
  }
  private async applyControl(stored: Stored) {
    const control = stored.control;
    if (!control) return true;
    const body = { requestId: control.requestId, revision: control.revision };
    try {
      if (control.action === "steer") await this.teams.steer(control.teamId, { ...body, text: control.text! });
      else await this.teams[control.action](control.teamId, body);
    } catch (error) {
      if (this.closed) return false;
      if (!(error instanceof TeamError)) throw error;
      if (["members-stopping", "team-operation-running"].includes(error.code)) return false;
      if (error.code === "stale-team-revision" && ["pause", "cancel"].includes(control.action)) {
        const team = this.teams.get(control.teamId);
        stored.control = { ...control, requestId: randomUUID(), revision: team.revision };
        this.save(stored); return false;
      }
      stored.control = undefined;
      if (!["paused", "cancelled", "limit-reached"].includes(stored.goal.status)) stored.goal.status = "blocked";
      stored.goal.reason = error.message;
      this.event(stored, `The goal action could not be applied: ${error.message}`); this.save(stored); return false;
    }
    if (this.closed) return false;
    stored.control = undefined; this.save(stored); return true;
  }
  private async launch(stored: Stored) {
    const pending = stored.launch!;
    const team = await this.teams.createForGoal(pending.request, pending.context, stored.goal.lineup, stored.goal.linearTracking === true);
    if (this.closed) return;
    if (!stored.goal.cycles.some(cycle => cycle.teamId === team.id)) stored.goal.cycles.push({ teamId: team.id, cycle: pending.context.cycle, goalRevision: pending.context.revision, status: team.status, startedAt: team.createdAt, memberCount: team.members.length });
    stored.goal.activeTeamId = team.id; stored.launch = undefined;
    this.event(stored, `Started feature ${pending.context.cycle}. The coordinator will inspect evidence before choosing work.`);
    this.refresh(stored, team); this.save(stored);
  }
  private async step(stored: Stored) {
    if (this.closed) return;
    const goal = stored.goal;
    goal.linear = this.linear?.updateGoal(goal, goal.linearTracking === true) ?? goal.linear;
    if (goal.linear?.status === "blocked" && !terminal.has(goal.status)) {
      goal.status = "blocked"; goal.reason = goal.linear.reason ?? "The Linear issue no longer matches this approved goal. Review it before starting another goal.";
      this.setControl(stored, "cancel"); this.event(stored, goal.reason);
    }
    this.save(stored);
    const trackingReady = !goal.linear || goal.linear.status === "synced";
    if (["running", "needs-input", "paused"].includes(goal.status) && Date.now() >= Date.parse(goal.deadlineAt)) {
      goal.status = "limit-reached"; goal.reason = "The approved time limit has expired.";
      this.setControl(stored, "cancel"); this.event(stored, goal.reason); this.save(stored);
    }
    if (stored.launch) {
      if (goal.status === "paused" || terminal.has(goal.status)) {
        try {
          const team = this.teams.get(stored.launch.request.requestId);
          if (!goal.cycles.some(cycle => cycle.teamId === team.id)) goal.cycles.push({ teamId: team.id, cycle: stored.launch.context.cycle, goalRevision: stored.launch.context.revision, status: team.status, startedAt: team.createdAt, memberCount: team.members.length });
          goal.activeTeamId = team.id; this.setControl(stored, goal.status === "paused" ? "pause" : "cancel");
        } catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
        stored.launch = undefined; this.save(stored);
      } else if (trackingReady) await this.launch(stored);
    }
    if (!await this.applyControl(stored) || this.closed) return;
    if (goal.activeTeamId) {
      const team = this.teams.get(goal.activeTeamId);
      this.refresh(stored, team);
      if (["ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(team.status)) {
        if (["running", "needs-input"].includes(goal.status) && ["ready-for-review", "merged", "no-change"].includes(team.status) && team.linear && team.linear.status !== "synced") {
          if (team.linear.status === "blocked") {
            goal.status = "blocked"; goal.reason = team.linear.reason ?? "The feature's Linear issue no longer permits continuation.";
            this.event(stored, goal.reason);
          } else { this.save(stored); return; }
        }
        if (team.members.every(member => ["stopped", "waiting"].includes(member.status))) goal.activeTeamId = undefined;
        if (["running", "needs-input"].includes(goal.status)) {
          if (team.status === "blocked" || team.status === "cancelled") {
            goal.status = team.stopReason ? "limit-reached" : "blocked"; goal.reason = team.reason ?? "The active team stopped before producing a reviewed result.";
          } else if (team.status === "no-change") {
            goal.status = goal.cycles.some(cycle => ["ready-for-review", "merged"].includes(cycle.status)) ? "ready-for-review" : "no-opportunity";
            goal.reason = team.reason ?? "The coordinator found no further work justified by the available evidence.";
          } else {
            goal.status = "running"; goal.reason = undefined;
            this.event(stored, "A feature passed checks and independent review. The next feature will use its recorded commit.");
          }
        }
      } else if (["running", "needs-input"].includes(goal.status)) {
        if (team.status === "paused") { goal.status = "paused"; goal.reason = "The active team was paused."; }
        else { goal.status = team.status === "needs-input" ? "needs-input" : "running"; goal.reason = team.reason; }
      }
      this.save(stored);
    }
    if (terminal.has(goal.status) || goal.status === "paused") return;
    if (Date.now() >= Date.parse(goal.deadlineAt) || (!goal.activeTeamId && goal.memberCount >= goal.maxMembers)) {
      goal.status = "limit-reached";
      goal.reason = Date.now() >= Date.parse(goal.deadlineAt) ? "The approved time limit has expired." : "The approved agent-attempt limit has been reached.";
      this.setControl(stored, "cancel"); this.event(stored, goal.reason); this.save(stored); await this.applyControl(stored); return;
    }
    if (goal.activeTeamId) return;
    if (goal.cycles.length >= goal.maxRuns) {
      goal.status = "ready-for-review"; goal.reason = "The approved feature-run limit has been reached. Review the accumulated changes; product impact has not been inferred.";
      this.event(stored, goal.reason); this.save(stored); return;
    }
    if (!trackingReady) return;
    const parent = [...goal.cycles].reverse().find(cycle => ["ready-for-review", "merged"].includes(cycle.status));
    const cycle = goal.cycles.length + 1;
    const sourceIssue = goal.linear?.issue;
    const context: TeamGoalContext = { id: goal.id, revision: goal.revision, cycle, successCriteria: goal.successCriteria, nonGoals: goal.nonGoals, allowedPaths: goal.allowedPaths, evidence: goal.evidence,
      ...(sourceIssue ? { sourceIssue: { id: sourceIssue.id, identifier: sourceIssue.identifier, url: sourceIssue.url, title: sourceIssue.title, description: sourceIssue.description } } : {}),
      previousWork: goal.cycles.filter(value => ["ready-for-review", "merged"].includes(value.status)).map(value => `${value.brief?.title ?? `Feature ${value.cycle}`}: ${value.brief?.expectedOutcome ?? "Reviewed change"}`.slice(0, 2000)),
      deadlineAt: goal.deadlineAt, maxMembers: Math.min(60, goal.maxMembers - goal.memberCount), ...(parent ? { parentRunId: parent.teamId } : {}) };
    const objective = [goal.objective, ...goal.steering.map(value => `User direction: ${value.text}`)].join("\n\n");
    stored.launch = { context, request: { requestId: randomUUID(), projectId: goal.projectId, provider: goal.lineup.coordinator.provider, useConfiguredLineup: true, title: `${goal.title} · ${cycle}`.slice(0, 100), objective, parallelism: goal.parallelism } };
    this.save(stored); await this.launch(stored);
  }
}
