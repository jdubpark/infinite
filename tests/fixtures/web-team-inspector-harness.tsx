import { createRoot } from "react-dom/client";
import "../../apps/web/src/style.css";
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
import type { TeamEntryDetail, TeamEntryHead } from "../../apps/web/src/team-inspector/types";

const params = new URLSearchParams(window.location.search);
const pagedMode = params.get("paged") === "1";

const pagedEntries: TeamEntryDetail[] = Array.from({ length: 55 }, (_, index) => {
  const seq = index + 1;
  const entryId = `99999999-9999-4999-8999-${String(seq).padStart(12, "0")}`;
  const head: TeamEntryHead = {
    entryId,
    seq,
    scope: "run",
    runId: TEAM_ID,
    revision: 2,
    at: "2026-11-26T01:00:00.000Z",
    kind: "check",
    author: "host",
    authority: "receipt",
    paths: [],
    summary: `paged check ${seq}`,
    bodyBytes: 120,
    state: "active",
  };
  return { head, body: { status: "passed", output: `ok ${seq}` } };
});

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
    const url = new URL(path, "http://127.0.0.1");
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const source = pagedMode ? pagedEntries : fixtureEntries;
    const heads = source
      .map(item => (control.withdrawn.has(item.head.entryId) ? { ...item.head, state: "withdrawn" as const } : item.head))
      .filter(head => head.seq > since);
    const slice = heads.slice(0, limit);
    return {
      entries: slice,
      cursor: slice.length > 0 ? slice[slice.length - 1]!.seq : since,
      more: heads.length > limit,
    };
  }
  const detailMatch = path.match(new RegExp(`^/teams/${TEAM_ID}/entries/([^/]+)$`));
  if (detailMatch) {
    const source = pagedMode ? pagedEntries : fixtureEntries;
    const found = source.find(item => item.head.entryId === detailMatch[1]);
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
