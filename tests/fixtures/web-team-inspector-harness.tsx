import { createRoot } from "react-dom/client";
import { ApiContext, type Api } from "../../apps/web/src/api";
import { MachineProvider } from "../../apps/web/src/machines";
import { TeamDetail } from "../../apps/web/src/teams";
import {
  TEAM_ID,
  fixtureEntries,
  fixtureMe,
  fixtureSessions,
  fixtureTeam,
} from "./web-team-inspector-data";

const control = {
  requests: [] as string[],
  openedSessions: [] as string[],
  withdrawn: new Set<string>(),
};
Object.assign(window, { inspector: control });

const host = (async (path: string, body?: unknown) => {
  control.requests.push(path);
  if (path === `/teams/${TEAM_ID}`) return fixtureTeam;
  if (path.startsWith(`/teams/${TEAM_ID}/entries?`)) {
    return {
      entries: fixtureEntries.map(item =>
        control.withdrawn.has(item.head.entryId)
          ? { ...item.head, state: "withdrawn" as const }
          : item.head,
      ),
      cursor: 106,
      more: false,
    };
  }
  const detailMatch = path.match(new RegExp(`^/teams/${TEAM_ID}/entries/([^/]+)$`));
  if (detailMatch) {
    const found = fixtureEntries.find(item => item.head.entryId === detailMatch[1]);
    if (!found) throw new Error(`Unknown entry ${detailMatch[1]}`);
    return control.withdrawn.has(found.head.entryId)
      ? { ...found, head: { ...found.head, state: "withdrawn" as const } }
      : found;
  }
  const withdrawMatch = path.match(new RegExp(`^/teams/${TEAM_ID}/entries/([^/]+)/withdraw$`));
  if (withdrawMatch && body) {
    control.withdrawn.add(withdrawMatch[1]!);
    return { entryId: withdrawMatch[1]!, state: "withdrawn", changed: true };
  }
  if (path.includes("/summary?status=1")) return { state: "empty" };
  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) return fixtureSessions.find(s => s.id === sessionMatch[1]) ?? fixtureSessions[0];
  if (path.includes("/events?")) return { events: [], cursor: 1, more: false };
  throw new Error(`Unexpected request: ${path}`);
}) as unknown as Api;

createRoot(document.getElementById("root")!).render(
  <MachineProvider>
    <ApiContext.Provider value={host}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <TeamDetail
          id={TEAM_ID}
          me={fixtureMe}
          connected
          sessions={fixtureSessions}
          refreshTeams={() => {}}
          openSession={sessionId => control.openedSessions.push(sessionId)}
        />
      </div>
    </ApiContext.Provider>
  </MachineProvider>,
);
