import { createRoot } from "react-dom/client";
import "../../apps/web/src/style.css";
import { ApiContext, ApiError, type Api, type GoalMetricsView, type Me, type TeamModelProfile } from "../../apps/web/src/api";
import { MachineProvider } from "../../apps/web/src/machines";
import { GoalDetail, type ProductGoal } from "../../apps/web/src/goals";

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "series";
const requests: string[] = [];
Object.assign(window, { __goalMetricsTest: { requests } });

const profile: TeamModelProfile = { id: "p1", label: "Lead", model: "model-a", provider: "claude", effort: "high" };
const me: Me = { role: "owner", environment: "cloud", providers: ["claude"], projects: [{ id: "proj", name: "Core repo" }], goals: { enabled: true } };
const cycle = (number: number, teamId: string) => ({ teamId, cycle: number, goalRevision: 1, status: "finished", startedAt: "2026-11-27T10:00:00.000Z", memberCount: 2 });
const goal: ProductGoal = {
  id: "goal-1", revision: 4, status: "running", createdAt: "2026-11-27T09:00:00.000Z", updatedAt: "2026-11-27T12:00:00.000Z", deadlineAt: "2026-11-28T09:00:00.000Z",
  projectId: "proj", title: "Cut cold start time", objective: "Cold start under one second.", successCriteria: "The cold start benchmark stays under one second.",
  nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 8, maxMinutes: 60, maxMembers: 6, parallelism: 2, memberCount: 2,
  lineup: { coordinator: profile, implementers: [profile], integrator: profile, reviewer: profile },
  cycles: [cycle(1, "t1"), cycle(2, "t2"), cycle(3, "t3"), cycle(4, "t4")], steering: [], events: [], outcomes: [],
};
const point = (cycle: number, value: number) => ({ cycle, run: "t" + cycle, revision: 1, head: "a".repeat(40), value, at: "2026-11-27T1" + cycle + ":00:00.000Z" });
const metrics: GoalMetricsView = {
  series: [
    { command: "npm run bench", label: "npm run bench -- --suite cold-start --iterations 20 --warmup 3 --reporter json --output results/cold-start.json", name: "cold_start_ms", configured: true, points: [point(1, 1840), point(2, 1520), point(4, 960)] },
    { command: "npm run size", label: "npm run size", name: "bundle_kb", configured: false, points: [point(1, 412), point(2, 405), point(3, 405), point(4, 398)] },
  ],
  omittedSeries: 2, omittedValues: 3, dropped: 5,
};

const host = (async (path: string) => {
  requests.push(path);
  if (path === "/goals/goal-1") return goal;
  if (path === "/goals/goal-1/metrics") {
    if (scenario === "fail") throw new ApiError("Metrics unavailable", 503, "unavailable");
    if (scenario === "empty") return { series: [], omittedSeries: 0, omittedValues: 0, dropped: 0 };
    return metrics;
  }
  throw new Error("Unexpected request: " + path);
}) as unknown as Api;

createRoot(document.getElementById("root")!).render(
  <MachineProvider>
    <ApiContext.Provider value={host}>
      <GoalDetail id="goal-1" me={me} connected teams={[]} teamsStale={false} refreshGoals={() => undefined} openTeam={() => undefined} />
    </ApiContext.Provider>
  </MachineProvider>,
);
