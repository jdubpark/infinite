import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { GoalService } from "../../packages/host/src/goals.js";
import type { CreateGoal, ProductGoal } from "../../packages/host/src/goal-types.js";
import { createTeamSchema, teamGoalContextSchema, type CreateTeam, type TeamGoalContext, type TeamLineup, type TeamView } from "../../packages/host/src/team-types.js";
import { emptyUsage } from "../../packages/host/src/team-usage.js";
import { TeamError, type TeamService } from "../../packages/host/src/teams.js";
import type { VerdictDetail } from "../../packages/host/src/team-verdicts.js";
import type { RunAssessment } from "../../packages/host/src/verdict-types.js";
import type { Project } from "../../packages/host/src/types.js";
import { startHost, waitFor, type Host } from "../helpers.js";
import { schedulerFixture } from "./team-scheduler.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
};

export const SWITCHES = { evaluator: "on", register: "on", prompts: "on", intentCheck: "off" } as const;
export const NOTE = "evaluator-note-marker-4471";
export const criterion = (statement: string, item: string) => ({ statement, check: { kind: "judgement", item }, threshold: { kind: "pass" } });
const minute = 60_000;
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

type Mode = "autonomous" | "supervised";

export async function hostFixture(options: { objective: Record<string, string>; mode: Mode }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-verdict-goal-"));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true });
  mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));',
    'assert.deepEqual(Object.keys(progress), ["completed"]);',
    'assert.ok(Number.isInteger(progress.completed) && progress.completed >= 1 && progress.completed <= 2);',
  ].join("\n"));
  git(source, "init", "--initial-branch=main");
  git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial goal fixture");
  let started: Host | undefined;
  try {
    started = await startHost({ agents: {
      claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "plain", receipts, "claude"] },
      codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "plain", receipts, "codex"] },
    }, config: {
      teams: { workspaceDir: join(root, "teams"), lineup, publishHeads: false },
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } as Project["team"] }],
    } });
    started.config.sync = { homeDir: dirname(source) };
    await started.stopApi();
    writeFileSync(join(started.root, "config.json"), JSON.stringify(started.config));
    await started.start();
    const view = (await started.fetchApi("/projects/rehearsal/team", "owner")).body;
    const team = { ...view.team, objective: options.objective };
    const enrolled = await started.fetchApi("/projects/rehearsal/team", "owner", { requestId: randomUUID(), revision: view.revision, team, teamwork: "teamwork" }, {}, "PUT");
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    if (options.mode === "supervised") {
      const changed = await started.fetchApi("/projects/rehearsal/autonomy", "owner", { requestId: randomUUID(), revision: enrolled.body.revision, mode: "supervised" }, {}, "PUT");
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
    }
  } catch (error) {
    await started?.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const host = started as Host;
  const create = (extra: Partial<CreateGoal> = {}): CreateGoal => ({ requestId: randomUUID(), projectId: "rehearsal", title: "Improve the progress flow",
    objective: "Build two small progress improvements using the existing data", successCriteria: "Two useful progress steps are available",
    nonGoals: ["Publishing or changing files outside the feature directory"], allowedPaths: ["features"],
    evidence: ["The fixture progress data starts at zero"], maxRuns: 3, maxMinutes: 5, maxMembers: 12, parallelism: 2, ...extra });
  const goal = async (id: string): Promise<ProductGoal> => {
    const response = await host.fetchApi(`/goals/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const stopped = (id: string, accept: (value: ProductGoal) => boolean = () => true) => waitFor(() => goal(id),
    value => !value.activeTeamId && ["ready-for-review", "no-opportunity", "blocked", "limit-reached"].includes(value.status) && accept(value), 120000);
  const prompt = async (id: string, cycle: number, role: string): Promise<string> => {
    const teamId = (await waitFor(() => goal(id), value => value.cycles.some(item => item.cycle === cycle), 120000)).cycles.find(item => item.cycle === cycle)!.teamId;
    const found = await waitFor(async () => readdirSync(receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(receipts, name), "utf8")))
      .find(item => item.runId === teamId && item.role === role), value => value !== undefined, 120000);
    assert.equal(typeof found.prompt, "string");
    return found.prompt as string;
  };
  const verdictFile = (cycle: number, value: unknown) => writeFileSync(join(receipts, `verdict-${cycle}.json`), JSON.stringify(value), { mode: 0o600 });
  const close = async () => {
    try {
      for (const value of (await host.fetchApi("/goals")).body.goals ?? [])
        if (value.status !== "cancelled") await host.fetchApi(`/goals/${value.id}/cancel`, "owner", { requestId: randomUUID(), revision: value.revision });
    } finally {
      await host.stop();
      rmSync(root, { recursive: true, force: true });
    }
  };
  return { host, receipts, create, goal, stopped, prompt, verdictFile, close };
}

export const outcomeOf = (goal: Pick<ProductGoal, "revision">, extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(), revision: goal.revision, result: "not-achieved", summary: "Rank the founders by their sources", evidence: "The owner read the shortlist", ...extra,
});

export function stubTeams() {
  const views = new Map<string, TeamView>();
  const launches: { request: CreateTeam; context: TeamGoalContext }[] = [];
  const cancels: string[] = [];
  const details = new Map<string, unknown>();
  const usage = () => ({ total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0, partialMembers: 0 });
  const service = {
    launches, cancels,
    get(id: string) {
      const found = views.get(id);
      if (!found) throw new TeamError(404, "team-not-found", "The team was not found.");
      return structuredClone(found);
    },
    goalIdOf: (id: string) => views.get(id)?.goal?.id,
    assessmentOf: (id: string) => { const view = views.get(id); return view === undefined ? undefined : { revision: view.revision, assessment: view.assessment }; },
    verdicts: { detail: (id: string) => details.get(id) as VerdictDetail | undefined },
    detail(id: string, value: Pick<VerdictDetail, "verdictId" | "revision" | "head" | "criteria">) { details.set(id, value); },
    forget(id: string) { views.delete(id); details.delete(id); },
    hasDeliveryAttempt: () => false,
    async createForGoal(request: CreateTeam, context: TeamGoalContext) {
      createTeamSchema.parse(request);
      teamGoalContextSchema.parse(context);
      const prior = views.get(request.requestId);
      if (prior) return structuredClone(prior);
      if (Date.now() >= Date.parse(context.deadlineAt)) throw new TeamError(409, "goal-deadline", "The goal reached its deadline.");
      launches.push(structuredClone({ request, context }));
      const at = new Date().toISOString();
      views.set(request.requestId, { id: request.requestId, projectId: request.projectId, status: "planning", revision: 1, createdAt: at, updatedAt: at,
        goal: structuredClone(context), members: [], tasks: [], usage: usage(), branch: "main", baseCommit: "a".repeat(40) } as unknown as TeamView);
      return service.get(request.requestId);
    },
    settle(id: string, status: string, extra: Partial<TeamView> = {}, members = 0) {
      const view = views.get(id)!;
      Object.assign(view, { status, members: Array.from({ length: members }, () => ({ memberId: randomUUID(), role: "implementer", revision: 1, status: "stopped" })) }, extra);
    },
    async cancel(id: string) { cancels.push(id); service.settle(id, "cancelled"); return service.get(id); },
    async pause(id: string) { service.settle(id, "paused"); return service.get(id); },
    async resume(id: string) { service.settle(id, "planning"); return service.get(id); },
    async removeRun() {},
  };
  return service;
}

export function assessmentOf(met: number, notMet: number): RunAssessment {
  return { verdictId: randomUUID(), revision: 1, head: "a".repeat(40), kind: "reviewed", result: notMet === 0 ? "met" : "not-met",
    counts: { met, notMet, inconclusive: 0, pendingOwner: 0 },
    criteria: [{ id: "c0", state: met > 0 ? "met" : "not-met" }, { id: "c1", state: notMet === 0 ? "met" : "not-met" }], at: new Date().toISOString() };
}

export const BRIEF = { title: "Feature", expectedOutcome: "Outcome" } as TeamView["brief"];

export function stubFixture(t: TestContext, mode: Mode = "autonomous", scanned = false) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T00:00:00.000Z") });
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }], objective: { ...SWITCHES } } as Project["team"];
  f.config.projects[0]!.autonomy = mode;
  if (scanned) f.config.projects[0]!.source = { mode: "github", repository: "example/fixture", baseBranch: "main" };
  const teams = stubTeams();
  const goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
  t.after(() => { goals.close(); f.close(); });
  const advance = (minutes: number) => t.mock.timers.setTime(Date.now() + minutes * minute);
  return { teams, goals, advance, config: f.config };
}

export async function until<T>(read: () => T, accept: (value: T) => boolean, what: string, ms = 8000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)?.slice(0, 1500)}`);
    await sleep(20);
  }
}

export const finite = (extra: Partial<CreateGoal> = {}): CreateGoal => ({
  requestId: randomUUID(), projectId: "fixture", title: "Improve the fixture", objective: "Find and fix the most useful problem",
  successCriteria: "The fixture is better", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 5, maxMinutes: 5, maxMembers: 24, parallelism: 2, ...extra } as CreateGoal);

export const standing = (cadenceMinutes = 30): CreateGoal => ({
  requestId: randomUUID(), projectId: "fixture", title: "Keep the fixture healthy", objective: "Find and fix the most useful problem",
  successCriteria: "Each cycle leaves the fixture better", nonGoals: [], allowedPaths: ["."], evidence: [], maxMinutes: 5, maxMembers: 6, parallelism: 3,
  standing: { shape: "objective", cadenceMinutes } } as CreateGoal);
