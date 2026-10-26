import { useRef, useState } from "react";
import type { WorkBrief, WorkNarrativeStatus } from "@infinite/remote";
import { ApiError, api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";

export type WorkBriefResult =
  | { scope: string; state: "ready"; brief: WorkBrief; canRefresh: boolean }
  | { scope: string; state: "missing" | "upgrade" | "denied"; error: string };

/** `failed` is the outcome of a refresh request that did not reach the host. */
export type RefreshState = "idle" | "sent" | "denied" | "failed";

const REFRESH_ROLES: Me["role"][] = ["owner", "controller"];

function needsNarrative(narrative: WorkNarrativeStatus): boolean {
  return narrative.state !== "ready" && narrative.state !== "pending";
}

/**
 * Reads one work brief every five seconds. When the first ready brief has no current narrative and
 * the role may refresh, it requests one refresh per scope. Viewers never send a refresh.
 */
export function useWorkBrief(connection: Connection, workspaceId: string, workId: string) {
  // Credential changes stay inside the poll scope so a late response cannot cross pairings.
  const key = `${connectionKey(connection)}|${connection.url}|${connection.relay?.machineId ?? "direct"}|${connection.token}|${connection.access?.clientId ?? ""}|${connection.access?.clientSecret ?? ""}`;
  const scope = `${key}\u0000${workspaceId}\u0000${workId}`;
  const base = `/project-groups/${encodeURIComponent(workspaceId)}/understanding/work/${encodeURIComponent(workId)}`;
  const roleFor = useRef<{ scope: string; role: Me["role"] } | null>(null);
  const requestedFor = useRef("");
  const [refresh, setRefresh] = useState<{ scope: string; state: RefreshState }>({ scope: "", state: "idle" });

  const sendRefresh = async (): Promise<RefreshState> => {
    try {
      await api<{ narrative: WorkNarrativeStatus }>(connection, `${base}/refresh`, { method: "POST", body: {} });
      return "sent";
    } catch (error) {
      return error instanceof ApiError && error.status === 403 ? "denied" : "failed";
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
      setRefresh({ scope, state: await sendRefresh() });
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
    /** Asks the host for a narrative now. Owners and controllers only; a `sent` result refreshes the poll. */
    requestRefresh: async () => {
      const state = await sendRefresh();
      setRefresh({ scope, state });
      if (state === "sent") poll.refresh();
    },
  };
}
