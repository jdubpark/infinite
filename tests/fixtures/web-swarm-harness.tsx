// The web client's real Swarm view on a stand-in host. tests/web-swarm.test.ts drives it through `window.swarm`:
// it switches views, delivers a new poll, and reads the requests the view sent.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiContext, ApiError, type Api, type Me } from "../../apps/web/src/api";
import { SwarmView, type SwarmViewName } from "../../apps/web/src/swarm/SwarmView";
import type { SwarmSession, SwarmTeam } from "../../apps/web/src/swarm/types";
import { swarmFixture, type SwarmFixture } from "./web-swarm-data";

type Variant = { shuffleUpdated: boolean; flipState: boolean };
const control = {
  requests: [] as string[],
  /** `off` answers the context paths with 404, as a host that predates them does. */
  context: (new URLSearchParams(window.location.search).get("context") === "off" ? "off" : "on") as "on" | "off",
  variant: { shuffleUpdated: false, flipState: false } as Variant,
  view: (_view: SwarmViewName) => {},
  poll: (_variant: Partial<Variant>) => {},
};
Object.assign(window, { swarm: control });

const NOW = Date.now();
function fixture(): SwarmFixture {
  const base = swarmFixture(NOW);
  if (control.variant.shuffleUpdated) {
    // The host rewrites `updatedAt` on every monitor pass; a later poll can carry any order of these times.
    base.teams.forEach((team, index) => { if (team.status !== "merged" && team.status !== "cancelled" && team.status !== "blocked") team.updatedAt = new Date(NOW - ((index * 7919) % 97) * 1000).toISOString(); });
    base.missions.forEach(mission => { mission.updatedAt = new Date(NOW - 50_000).toISOString(); });
  }
  if (control.variant.flipState) {
    // One working agent finishes its turn: a state change with no change to who exists.
    const working = base.sessions.find(session => session.attention?.state === "working" && session.title.includes("implementer"));
    if (working?.attention) working.attention = { ...working.attention, state: "turn-finished", lastTool: undefined };
  }
  return base;
}

const host = (async (path: string) => {
  control.requests.push(path);
  const data = fixture();
  if (path === "/missions") return { missions: data.missions };
  if (path === "/machine/resources") return { cpu: { usagePercent: 41 }, memory: { totalBytes: 64 * 2 ** 30, availableBytes: 30 * 2 ** 30 } };
  const contextPath = /^\/projects\/[a-z0-9-]+\/graph\/map|^\/(teams|sessions)\/[0-9a-f-]+\/context$/.test(path);
  if (contextPath && control.context === "off") throw new ApiError("Not found", 404);
  const map = /^\/projects\/([a-z0-9-]+)\/graph\/map/.exec(path);
  if (map) return data.maps[map[1]] ?? { state: "unavailable", reason: "none-built" };
  const team = /^\/teams\/([0-9a-f-]+)\/context$/.exec(path);
  if (team) return data.touches[team[1]] ?? { teamId: team[1], revision: 1, members: [] };
  const session = /^\/sessions\/([0-9a-f-]+)\/context$/.exec(path);
  if (session) return data.sessionTouches[session[1]] ?? { sessionId: session[1], observable: true, complete: true, graphQueries: 0, files: [], truncated: false };
  throw new Error(`Unexpected request: ${path}`);
}) as unknown as Api;

function Harness() {
  const [view, setView] = useState<SwarmViewName>("lanes");
  const [feed, setFeed] = useState<{ sessions: SwarmSession[]; teams: SwarmTeam[] }>(() => fixture());
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    control.view = setView;
    control.poll = variant => { control.variant = { ...control.variant, ...variant }; const next = fixture(); setFeed({ sessions: next.sessions, teams: next.teams }); };
  }, []);
  const me: Me = { role: "owner", environment: "cloud", providers: ["claude", "codex", "opencode"], projects: swarmFixture(NOW).projects,
    teams: { enabled: true }, missions: { enabled: true }, capabilities: { signals: true, answer: true, push: false, ...(control.context === "on" ? { swarmContext: 1 as const } : {}) } };
  return <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
    <SwarmView me={me} sessions={feed.sessions} teams={feed.teams} fresh stale={false} seen={new Date(NOW).toISOString()} view={view} setView={setView}
      openSession={() => {}} openTeam={() => {}} focus={focus} setFocus={setFocus} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<ApiContext.Provider value={host}><Harness /></ApiContext.Provider>);
