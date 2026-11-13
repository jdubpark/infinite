import { useMemo, useRef, useState } from "react";
import { ApiError, useApi, type Api } from "../api";
import { useLiveRefresh } from "../live-refresh";
import { contextRequests, nextBatch, SESSION_BATCH } from "./graph-model";
import type { CodeMap, SessionTouches, SwarmModel, TeamTouches } from "./types";

// Code maps change slowly; touches follow the agents' tool use.
const MAP_INTERVAL = 60_000;
const CONTEXT_INTERVAL = 5_000;

const EMPTY_MAPS: Record<string, CodeMap | undefined> = {};
const EMPTY_TOUCHES: Record<string, SessionTouches | undefined> = {};

/** Paths that answered 404 this page load. A host that predates the endpoints is not asked again. */
const unavailablePaths = new Set<string>();

type Request = { key: string; path: string };

/**
 * Fetches each path once. Every request stands alone: one failure never discards another's result.
 * A 404 retires the path and is not a failure; anything else is counted and the path is asked again next cycle.
 */
async function fetchEach<T>(api: Api, requests: Request[]): Promise<{ results: Map<string, T>; failed: number }> {
  const results = new Map<string, T>();
  let failed = 0;
  await Promise.all(requests.map(async ({ key, path }) => {
    if (unavailablePaths.has(path)) return;
    try { results.set(key, await api<T>(path)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) unavailablePaths.add(path);
      else failed++;
    }
  }));
  return { results, failed };
}

/** Keeps a fresh value for each wanted key, the previous value where this cycle brought none, and nothing else. */
function settle<T>(wanted: string[], fresh: Map<string, T>, previous: Record<string, T>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const key of wanted) {
    const value = fresh.get(key) ?? previous[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/**
 * Code maps and observed touches for the Graph view. Requests only when `enabled`; each poll goes
 * through useLiveRefresh, so nothing polls while the tab is hidden. Never throws into render.
 * `failing` is true while some context could not be refreshed and the last received values are shown.
 */
export function useSwarmContext(model: SwarmModel, enabled: boolean): {
  maps: Record<string, CodeMap | undefined>;
  touches: Record<string, SessionTouches | undefined>;
  failing: boolean;
} {
  const api = useApi();
  const plan = contextRequests(model);
  const [maps, setMaps] = useState<Record<string, CodeMap>>({});
  const [teamTouches, setTeamTouches] = useState<Record<string, TeamTouches>>({});
  const [sessionTouches, setSessionTouches] = useState<Record<string, SessionTouches>>({});
  const [failures, setFailures] = useState({ maps: 0, teams: 0, sessions: 0 });
  const sessionOffset = useRef(0);

  // A changed set of projects, teams, or sessions restarts only that feed, so its new members are fetched at once.
  const projectKey = enabled && plan.projects.length ? `projects:${plan.projects.join(",")}` : undefined;
  const teamKey = enabled && plan.teams.length ? `teams:${plan.teams.join(",")}` : undefined;
  const sessionKey = enabled && plan.sessions.length ? `sessions:${plan.sessions.join(",")}` : undefined;

  useLiveRefresh(async current => {
    const { results, failed } = await fetchEach<CodeMap>(api, plan.projects.map(id => ({ key: id, path: `/projects/${encodeURIComponent(id)}/graph/map` })));
    if (!current()) return;
    setMaps(previous => settle(plan.projects, results, previous));
    setFailures(previous => ({ ...previous, maps: failed }));
  }, MAP_INTERVAL, projectKey);

  useLiveRefresh(async current => {
    const { results, failed } = await fetchEach<TeamTouches>(api, plan.teams.map(id => ({ key: id, path: `/teams/${encodeURIComponent(id)}/context` })));
    if (!current()) return;
    setTeamTouches(previous => settle(plan.teams, results, previous));
    setFailures(previous => ({ ...previous, teams: failed }));
  }, CONTEXT_INTERVAL, teamKey);

  useLiveRefresh(async current => {
    const { batch, offset } = nextBatch(plan.sessions, sessionOffset.current, SESSION_BATCH);
    sessionOffset.current = offset;
    const { results, failed } = await fetchEach<SessionTouches>(api, batch.map(id => ({ key: id, path: `/sessions/${encodeURIComponent(id)}/context` })));
    if (!current()) return;
    setSessionTouches(previous => settle(plan.sessions, results, previous));
    setFailures(previous => ({ ...previous, sessions: failed }));
  }, CONTEXT_INTERVAL, sessionKey);

  const touches = useMemo(() => {
    const all: Record<string, SessionTouches | undefined> = { ...sessionTouches };
    for (const team of Object.values(teamTouches)) for (const member of team.members) all[member.sessionId] = member;
    return all;
  }, [teamTouches, sessionTouches]);

  if (!enabled) return { maps: EMPTY_MAPS, touches: EMPTY_TOUCHES, failing: false };
  return { maps, touches, failing: failures.maps + failures.teams + failures.sessions > 0 };
}
