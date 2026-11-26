import { createRoot } from "react-dom/client";
import "../../apps/web/src/style.css";
import { ApiContext, type Api } from "../../apps/web/src/api";
import { MachineProvider } from "../../apps/web/src/machines";
import { MissionPage } from "../../apps/web/src/missions";
import {
  buildResyncPolls,
  CHILD_TEAM_1,
  createFixtureMission,
  createProgressSnapshot,
  fixtureChildEntries,
  fixtureMe,
  GEN_1,
  INST_1,
  MISSION_ID,
} from "./web-mission-inspector-data";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "inspector";
const resyncPolls = buildResyncPolls();

let mission = createFixtureMission();
let progressPollIndex = 0;

const control = {
  requests: [] as { path: string; body?: unknown }[],
  mutations: [] as { path: string; body: unknown }[],
  openedTeams: [] as string[],
};
Object.assign(window, { missionInspector: control });

const host = (async (path: string, body?: unknown) => {
  control.requests.push({ path, ...(body === undefined ? {} : { body }) });

  if (path === `/missions/${MISSION_ID}`) {
    return structuredClone(mission);
  }

  const answerMatch = path.match(new RegExp(`^/missions/${MISSION_ID}/answer/([^/]+)$`));
  if (answerMatch && body && typeof body === "object") {
    const payload = body as { requestId: string; revision: number; text: string };
    control.mutations.push({ path, body: payload });
    const decisionId = answerMatch[1]!;
    mission = {
      ...mission,
      revision: mission.revision + 1,
      status: "working",
      updatedAt: new Date(Date.parse(mission.updatedAt) + 1000).toISOString(),
      decisions: mission.decisions.map(item =>
        item.id === decisionId
          ? {
              ...item,
              answer: payload.text,
              answeredBy: "owner",
              answeredAt: "2026-11-26T01:12:00.000Z",
            }
          : item,
      ),
    };
    return structuredClone(mission);
  }

  if (path === `/missions/${MISSION_ID}/steer` && body && typeof body === "object") {
    const payload = body as { requestId: string; revision: number; text: string };
    control.mutations.push({ path, body: payload });
    const nextRevision = mission.revision + 1;
    mission = {
      ...mission,
      revision: nextRevision,
      updatedAt: new Date(Date.parse(mission.updatedAt) + 1000).toISOString(),
      steering: [
        ...mission.steering,
        { text: payload.text, revision: nextRevision, at: "2026-11-26T01:13:00.000Z" },
      ],
    };
    return structuredClone(mission);
  }

  if (path.startsWith(`/missions/${MISSION_ID}/progress`)) {
    if (scenario === "resync") {
      const idx = Math.min(progressPollIndex, resyncPolls.length - 1);
      progressPollIndex += 1;
      if (progressPollIndex > resyncPolls.length) {
        const last = resyncPolls[resyncPolls.length - 1]!;
        return { ...last, observations: [] };
      }
      return structuredClone(resyncPolls[idx]!);
    }
    const hasCursor = path.includes("cursor=");
    return {
      missionId: MISSION_ID,
      generation: GEN_1,
      cursor: `mp1.${GEN_1}.${MISSION_ID}.${INST_1}.1`,
      observedAt: "2026-11-26T01:10:00.000Z",
      resync: hasCursor ? { required: false } : { required: true, reason: "initial" },
      observations: [],
      snapshot: createProgressSnapshot(mission.revision, mission.status, "unavailable"),
    };
  }

  if (path === `/teams/${CHILD_TEAM_1}/entries` || path.startsWith(`/teams/${CHILD_TEAM_1}/entries?`)) {
    const url = new URL(path, "http://127.0.0.1");
    const kind = url.searchParams.get("kind");
    const since = Number(url.searchParams.get("since") ?? "0");
    const heads = fixtureChildEntries
      .map(item => item.head)
      .filter(head => head.seq > since && (!kind || head.kind === kind));
    return {
      entries: heads,
      cursor: heads.length ? heads[heads.length - 1]!.seq : since,
      more: false,
    };
  }

  const detailMatch = path.match(new RegExp(`^/teams/${CHILD_TEAM_1}/entries/([^/]+)$`));
  if (detailMatch) {
    const found = fixtureChildEntries.find(item => item.head.entryId === detailMatch[1]);
    if (!found) throw new Error(`Unknown entry ${detailMatch[1]}`);
    return structuredClone(found);
  }

  throw new Error(`Unexpected request: ${path}`);
}) as unknown as Api;

createRoot(document.getElementById("root")!).render(
  <MachineProvider>
    <ApiContext.Provider value={host}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <MissionPage
          id={MISSION_ID}
          me={fixtureMe}
          connected
          openTeam={teamId => control.openedTeams.push(teamId)}
          halt={null}
        />
      </div>
    </ApiContext.Provider>
  </MachineProvider>,
);
