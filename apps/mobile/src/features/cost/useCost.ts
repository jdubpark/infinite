import { useState } from "react";
import * as Crypto from "expo-crypto";
import { api, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { deviceTz, type DailySeries, type ModelsScorecard, type ProjectCost, type ProjectsList, type UsageOverview } from "./model";

/** Day buckets follow the phone's timezone so the bars match the owner's calendar. */
const tz = () => `tz=${encodeURIComponent(deviceTz())}`;

export function useUsageOverview(connection: Connection) {
  return usePoll(() => api<UsageOverview>(connection, "/usage"), 10000, [connection]);
}
export function useDaily(connection: Connection, project?: string) {
  const query = `?days=30&${tz()}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
  return usePoll(() => api<DailySeries>(connection, `/usage/daily${query}`), 30000, [connection, project]);
}
export function useProjects(connection: Connection) {
  return usePoll(() => api<ProjectsList>(connection, `/usage/projects?${tz()}`), 30000, [connection]);
}
export function useProject(connection: Connection, id: string) {
  return usePoll(() => api<ProjectCost>(connection, `/usage/projects/${encodeURIComponent(id)}?${tz()}`), 10000, [connection, id]);
}
export function useModels(connection: Connection, role: string) {
  const query = `?role=${encodeURIComponent(role)}`;
  return usePoll(() => api<ModelsScorecard>(connection, `/usage/models${query}`), 30000, [connection, role]);
}

/** Owner ratings are independent of team revisions, so a successful receipt only refreshes the view. */
export function useTaskRating(connection: Connection, teamId: string, onRecorded: () => void) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function rate(taskId: string, score: 1 | 2 | 3 | 4 | 5) {
    if (busy) return;
    setBusy(taskId); setError("");
    try {
      await api(connection, `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/rating`, {
        method: "POST", body: { requestId: Crypto.randomUUID(), score },
      });
      onRecorded();
    } catch { setError("Rating failed"); }
    finally { setBusy(""); }
  }
  return { rate, busy, error };
}
