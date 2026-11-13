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
 * A 404 retires the path and is not a failure; any other failure is reported by path and asked again later.
 */
async function fetchEach<T>(api: Api, requests: Request[]): Promise<{ results: Map<string, T>; settled: Map<string, boolean> }> {
  const results = new Map<string, T>();
  const settled = new Map<string, boolean>();
  await Promise.all(requests.map(async ({ key, path }) => {
    if (unavailablePaths.has(path)) return;
    try { results.set(key, await api<T>(path)); settled.set(path, true); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) { unavailablePaths.add(path); settled.set(path, true); }
      else settled.set(path, false);
    }
  }));
  return { results, settled };
}

/** Failed paths after one cycle: a path leaves the set only when it is asked again and answers. */
function mark(failed: ReadonlySet<string>, settled: Map<string, boolean>): ReadonlySet<string> {
  const next = new Set(failed);
  for (const [path, ok] of settled) { if (ok) next.delete(path); else next.add(path); }
  return next.size === failed.size && [...next].every(path => failed.has(path)) ? failed : next;
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
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const sessionOffset = useRef(0);
  const mapPath = (id: string) => `/projects/${encodeURIComponent(id)}/graph/map`;
  const teamPath = (id: string) => `/teams/${encodeURIComponent(id)}/context`;
  const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}/context`;

  // A changed set of projects, teams, or sessions restarts only that feed, so its new members are fetched at once.
  const projectKey = enabled && plan.projects.length ? `projects:${plan.projects.join(",")}` : undefined;
  const teamKey = enabled && plan.teams.length ? `teams:${plan.teams.join(",")}` : undefined;
  const sessionKey = enabled && plan.sessions.length ? `sessions:${plan.sessions.join(",")}` : undefined;

  useLiveRefresh(async current => {
    const { results, settled } = await fetchEach<CodeMap>(api, plan.projects.map(id => ({ key: id, path: mapPath(id) })));
    if (!current()) return;
    setMaps(previous => settle(plan.projects, results, previous));
    setFailed(previous => mark(previous, settled));
  }, MAP_INTERVAL, projectKey);

  useLiveRefresh(async current => {
    const { results, settled } = await fetchEach<TeamTouches>(api, plan.teams.map(id => ({ key: id, path: teamPath(id) })));
    if (!current()) return;
    setTeamTouches(previous => settle(plan.teams, results, previous));
    setFailed(previous => mark(previous, settled));
  }, CONTEXT_INTERVAL, teamKey);

  useLiveRefresh(async current => {
    const { batch, offset } = nextBatch(plan.sessions, sessionOffset.current, SESSION_BATCH);
    sessionOffset.current = offset;
    const { results, settled } = await fetchEach<SessionTouches>(api, batch.map(id => ({ key: id, path: sessionPath(id) })));
    if (!current()) return;
    setSessionTouches(previous => settle(plan.sessions, results, previous));
    setFailed(previous => mark(previous, settled));
  }, CONTEXT_INTERVAL, sessionKey);

  const touches = useMemo(() => {
    const all: Record<string, SessionTouches | undefined> = { ...sessionTouches };
    for (const team of Object.values(teamTouches)) for (const member of team.members) all[member.sessionId] = member;
    return all;
  }, [teamTouches, sessionTouches]);

  if (!enabled) return { maps: EMPTY_MAPS, touches: EMPTY_TOUCHES, failing: false };
  // Only failures of what is still wanted count, so a team or session that left takes its failure with it.
  const wanted = [...plan.projects.map(mapPath), ...plan.teams.map(teamPath), ...plan.sessions.map(sessionPath)];
  return { maps, touches, failing: wanted.some(path => failed.has(path)) };
}
