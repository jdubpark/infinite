import { createRoot } from "react-dom/client";
import "../../apps/web/src/style.css";
import { ApiContext, ApiError, type Api, type Me, type RepairLoopReport, type UsageDaily, type UsageProject, type UsageSummary } from "../../apps/web/src/api";
import { MachineProvider } from "../../apps/web/src/machines";
import { CostPage } from "../../apps/web/src/cost";
import { useSessionLocation } from "../../apps/web/src/session-navigation";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "mixed";

const requests: string[] = [];
Object.assign(window, { __repairMetricsTest: { requests } });

const fixtureMe: Me = {
  role: "owner",
  environment: "cloud",
  providers: ["claude"],
  projects: [{ id: "proj-alpha", name: "Core repo" }],
  usage: { enabled: true, budgets: {} },
};

const fixtureSummary: UsageSummary = {
  period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
  providers: {},
  month: {
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-12-01T00:00:00.000Z",
    spent: { usd: 125, unpriced: 0 },
    previous: { usd: 100, unpriced: 0 },
    plansUsd: 20,
    unmeasuredSessions: 0,
  },
  accounts: [
    { id: "claude", kind: "subscription", planUsd: 20, planSource: "config", balance: null },
  ],
};

const fixtureDaily: UsageDaily = {
  tz: "UTC",
  accounts: ["claude"],
  days: [
    { date: "2026-11-25", usd: 12.5, byAccount: { claude: 12.5 } },
    { date: "2026-11-26", usd: 18.2, byAccount: { claude: 18.2 } },
  ],
};

const fixtureProject: UsageProject = {
  id: "proj-alpha",
  name: "Core repo",
  total: { usd: 125, unpriced: 0 },
  byKind: { goals: 40, teams: 70, sessions: 10, briefings: 5 },
  goals: [],
  teams: [],
  sessions: [],
  briefings: { total: { usd: 5, unpriced: 0 }, runs: 2, unmeasured: 0 },
};

const mixedReport: RepairLoopReport = {
  windowDays: 30,
  totals: {
    runsExamined: 12,
    eventCoverage: "complete",
    incompleteRuns: 0,
    loopsTotal: 4,
    resolved: 2,
    unresolved: 1,
    inProgress: 1,
    byCause: { review: 2, check: 1, delivery: 1 },
    coldReplacements: 2,
    failedResumes: 1,
    measuredLoops: 2,
    unmeasuredLoops: 2,
    unfinishedLoops: 0,
    unmeasuredMembers: 3,
    medianMinutes: 12.5,
    p90Minutes: 28,
    medianTokens: 45200,
    medianUsd: 0.42,
  },
  loops: [
    {
      runId: "aaaaaaaa-1111-4111-8111-111111111111",
      projectId: "proj-alpha",
      revision: 2,
      cause: "check",
      outcome: "resolved",
      rounds: 1,
      attempts: 3,
      coldReplacements: 1,
      failedResumes: 0,
      startedAt: "2026-11-25T10:00:00.000Z",
      finishedAt: "2026-11-25T10:12:30.000Z",
      durationMs: 750_000,
      failedCommit: "1111aaaa",
      passingCommit: "2222bbbb",
      measured: true,
      tokens: 45200,
      usd: 0.42,
    },
    {
      runId: "bbbbbbbb-2222-4222-8222-222222222222",
      projectId: "proj-alpha",
      revision: 1,
      cause: "review",
      outcome: "blocked",
      rounds: 2,
      attempts: 5,
      coldReplacements: 1,
      failedResumes: 1,
      startedAt: "2026-11-24T08:00:00.000Z",
      measured: false,
    },
  ],
};

const projectUnmeasuredReport: RepairLoopReport = {
  windowDays: 30,
  projectId: "proj-alpha",
  totals: {
    runsExamined: 3,
    eventCoverage: "complete",
    incompleteRuns: 0,
    loopsTotal: 1,
    resolved: 1,
    unresolved: 0,
    inProgress: 0,
    byCause: { review: 1, check: 0, delivery: 0 },
    coldReplacements: 0,
    failedResumes: 1,
    measuredLoops: 0,
    unmeasuredLoops: 1,
    unfinishedLoops: 0,
    unmeasuredMembers: 4,
    medianMinutes: 8,
    p90Minutes: 8,
    medianTokens: null,
    medianUsd: null,
  },
  loops: [
    {
      runId: "cccccccc-3333-4333-8333-333333333333",
      projectId: "proj-alpha",
      revision: 1,
      cause: "review",
      outcome: "resolved",
      rounds: 1,
      attempts: 2,
      coldReplacements: 0,
      failedResumes: 1,
      startedAt: "2026-11-25T09:00:00.000Z",
      finishedAt: "2026-11-25T09:08:00.000Z",
      durationMs: 480_000,
      measured: false,
    },
  ],
};

const incompleteUnfinishedReport: RepairLoopReport = {
  windowDays: 30,
  totals: {
    runsExamined: 5,
    eventCoverage: "incomplete",
    incompleteRuns: 2,
    loopsTotal: 3,
    resolved: 1,
    unresolved: 1,
    inProgress: 1,
    byCause: { review: 1, check: 1, delivery: 1 },
    coldReplacements: 1,
    failedResumes: 0,
    measuredLoops: 1,
    unmeasuredLoops: 0,
    unfinishedLoops: 2,
    unmeasuredMembers: 0,
    medianMinutes: 10,
    p90Minutes: 10,
    medianTokens: 21000,
    medianUsd: 0.19,
  },
  loops: [
    {
      runId: "dddddddd-4444-4444-8444-444444444444",
      projectId: "proj-alpha",
      revision: 1,
      cause: "check",
      outcome: "resolved",
      rounds: 1,
      attempts: 2,
      coldReplacements: 0,
      failedResumes: 0,
      startedAt: "2026-11-26T08:00:00.000Z",
      finishedAt: "2026-11-26T08:10:00.000Z",
      durationMs: 600_000,
      measured: true,
      tokens: 21000,
      usd: 0.19,
    },
    {
      runId: "eeeeeeee-5555-4555-8555-555555555555",
      projectId: "proj-alpha",
      revision: 2,
      cause: "review",
      outcome: "in-progress",
      rounds: 1,
      attempts: 1,
      coldReplacements: 0,
      failedResumes: 0,
      startedAt: "2026-11-26T09:00:00.000Z",
      measured: false,
      unfinished: true,
    },
    {
      runId: "ffffffff-6666-4666-8666-666666666666",
      projectId: "proj-alpha",
      revision: 1,
      cause: "delivery",
      outcome: "superseded",
      rounds: 1,
      attempts: 2,
      coldReplacements: 1,
      failedResumes: 0,
      startedAt: "2026-11-26T07:00:00.000Z",
      measured: false,
      unfinished: true,
    },
  ],
};

const emptyIncompleteReport: RepairLoopReport = {
  windowDays: 30,
  totals: {
    runsExamined: 4,
    eventCoverage: "incomplete",
    incompleteRuns: 3,
    loopsTotal: 0,
    resolved: 0,
    unresolved: 0,
    inProgress: 0,
    byCause: { review: 0, check: 0, delivery: 0 },
    coldReplacements: 0,
    failedResumes: 0,
    measuredLoops: 0,
    unmeasuredLoops: 0,
    unfinishedLoops: 0,
    unmeasuredMembers: 0,
    medianMinutes: null,
    p90Minutes: null,
    medianTokens: null,
    medianUsd: null,
  },
  loops: [],
};

const incompleteHighVolumeReport: RepairLoopReport = {
  windowDays: 30,
  totals: {
    runsExamined: 30,
    eventCoverage: "incomplete",
    incompleteRuns: 2,
    loopsTotal: 25,
    resolved: 22,
    unresolved: 1,
    inProgress: 2,
    byCause: { review: 12, check: 10, delivery: 3 },
    coldReplacements: 2,
    failedResumes: 1,
    measuredLoops: 22,
    unmeasuredLoops: 1,
    unfinishedLoops: 2,
    unmeasuredMembers: 1,
    medianMinutes: 9.5,
    p90Minutes: 21,
    medianTokens: 32000,
    medianUsd: 0.31,
  },
  loops: [
    {
      runId: "12121212-7777-4777-8777-777777777777",
      projectId: "proj-alpha",
      revision: 1,
      cause: "review",
      outcome: "resolved",
      rounds: 1,
      attempts: 2,
      coldReplacements: 0,
      failedResumes: 0,
      startedAt: "2026-11-26T10:00:00.000Z",
      finishedAt: "2026-11-26T10:09:30.000Z",
      durationMs: 570_000,
      measured: true,
      tokens: 32000,
      usd: 0.31,
    },
  ],
};

const host = (async (path: string) => {
  requests.push(path);
  if (path === "/usage") return fixtureSummary;
  if (path.startsWith("/usage/daily?")) return fixtureDaily;
  if (path.startsWith("/usage/projects/proj-alpha?")) return fixtureProject;
  if (path.startsWith("/usage/repair-loops?")) {
    if (scenario === "legacy-404") throw new ApiError("Not found", 404, "not-found");
    if (scenario === "unavailable-503") throw new ApiError("Usage ledger unavailable", 503, "unavailable");
    if (scenario === "incomplete-unfinished") return incompleteUnfinishedReport;
    if (scenario === "empty-incomplete") return emptyIncompleteReport;
    if (scenario === "incomplete-high-volume") return incompleteHighVolumeReport;
    if (path.includes("project=proj-alpha")) return projectUnmeasuredReport;
    return mixedReport;
  }
  throw new Error(`Unexpected request: ${path}`);
}) as unknown as Api;

function Harness() {
  const route = useSessionLocation("direct");
  return (
    <CostPage
      me={fixtureMe}
      view={route.costView}
      projectId={route.costProjectId}
      navigate={route.navigateCost}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <MachineProvider>
    <ApiContext.Provider value={host}>
      <Harness />
    </ApiContext.Provider>
  </MachineProvider>,
);
