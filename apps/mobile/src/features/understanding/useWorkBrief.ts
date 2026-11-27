import { useRef, useState } from "react";
import type { WorkBrief, WorkNarrativeStatus } from "@infinite/remote";
import { ApiError, api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";

export type WorkBriefResult =
  | { scope: string; state: "ready"; brief: WorkBrief; canRefresh: boolean }
  | { scope: string; state: "missing" | "upgrade" | "denied"; error: string };

export type RefreshState = "idle" | "sent" | "denied" | "failed";

const REFRESH_ROLES: Me["role"][] = ["owner", "controller"];

function needsNarrative(narrative: WorkNarrativeStatus): boolean {
  return narrative.state !== "ready" && narrative.state !== "pending";
}

export function useWorkBrief(connection: Connection, workspaceId: string, workId: string) {
  const key = `${connectionKey(connection)}|${connection.url}|${connection.relay?.machineId ?? "direct"}|${connection.token}|${connection.access?.clientId ?? ""}|${connection.access?.clientSecret ?? ""}`;
  const scope = `${key}\u0000${workspaceId}\u0000${workId}`;
  const base = `/project-groups/${encodeURIComponent(workspaceId)}/understanding/work/${encodeURIComponent(workId)}`;
  const roleFor = useRef<{ scope: string; role: Me["role"] } | null>(null);
  const requestedFor = useRef("");
  const [refresh, setRefresh] = useState<{ scope: string; state: RefreshState; narrative?: WorkNarrativeStatus }>({ scope: "", state: "idle" });

  const sendRefresh = async (): Promise<{ state: RefreshState; narrative?: WorkNarrativeStatus }> => {
    try {
      const result = await api<{ narrative: WorkNarrativeStatus }>(connection, `${base}/refresh`, { method: "POST", body: {} });
      return { state: "sent", narrative: result.narrative };
    } catch (error) {
      return { state: error instanceof ApiError && error.status === 403 ? "denied" : "failed" };
    }
  };

  const canRefreshFor = async (current: string): Promise<boolean> => {
    if (roleFor.current?.scope !== current) {
      const me = await api<Me>(connection, "/me").catch(() => null);
      if (!me) return false;
      roleFor.current = { scope: current, role: me.role };
    }
    return REFRESH_ROLES.includes(roleFor.current.role);
  };

  const poll = usePoll<WorkBriefResult>(async () => {
    const fail = (state: "missing" | "upgrade" | "denied", error: string): WorkBriefResult => ({ scope, state, error });
    let brief: WorkBrief;
    try {
      brief = await api<WorkBrief>(connection, base);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return error.code === "understanding-work"
          ? fail("missing", "This work is no longer available.")
          : fail("upgrade", "Update this host to read work briefs.");
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        return fail("denied", "This device no longer has access to this workspace.");
      }
      throw error;
    }
    if (brief.schemaVersion !== 1 || brief.workId !== workId) return fail("upgrade", "This host returned an unsupported work brief version.");
    const canRefresh = await canRefreshFor(scope);
    if (canRefresh && needsNarrative(brief.narrative) && requestedFor.current !== scope) {
      requestedFor.current = scope;
      setRefresh({ scope, ...await sendRefresh() });
    }
    return { scope, state: "ready", brief, canRefresh };
  }, 5000, [connection, scope]);

  const result = poll.data?.scope === scope ? poll.data : null;

  return {
    poll,
    result,
    brief: result?.state === "ready" ? result.brief : null,
    canRefresh: result?.state === "ready" ? result.canRefresh : false,
    refreshState: refresh.scope === scope ? refresh.state : "idle",
    refreshNarrative: refresh.scope === scope ? refresh.narrative ?? null : null,
    requestRefresh: async () => {
      const result = await sendRefresh();
      setRefresh({ scope, ...result });
      if (result.state === "sent") poll.refresh();
    },
  };
}
