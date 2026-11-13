import { useState } from "react";
import { ApiError, useApi, type Api } from "../api";
import { useLiveRefresh } from "../live-refresh";
import { contextRequests } from "./graph-model";
import type { CodeMap, SessionTouches, SwarmModel, TeamTouches } from "./types";

// Code maps change slowly; touches follow the agents' tool use.
const MAP_INTERVAL = 60_000;
const CONTEXT_INTERVAL = 5_000;

const EMPTY_MAPS: Record<string, CodeMap | undefined> = {};
const EMPTY_TOUCHES: Record<string, SessionTouches | undefined> = {};

/** Paths that answered 404 this page load. A host that predates the endpoints is not asked again. */
const unavailablePaths = new Set<string>();

type Request = { key: string; path: string };

/** Fetches each path once per cycle. A 404 retires the path; other failures are rethrown after the rest finish. */
async function fetchEach<T>(api: Api, requests: Request[]): Promise<[string, T][]> {
  const results: [string, T][] = [];
  let failure: unknown;
  await Promise.all(requests.map(async ({ key, path }) => {
    if (unavailablePaths.has(path)) return;
    try {
      results.push([key, await api<T>(path)]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) unavailablePaths.add(path);
      else failure ??= error;
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
}

/**
 * Code maps and observed touches for the Graph view. Requests only when `enabled`; each poll
 * goes through useLiveRefresh, so nothing polls while the tab is hidden. Never throws into render.
 */
export function useSwarmContext(model: SwarmModel, enabled: boolean): {
  maps: Record<string, CodeMap | undefined>;
  touches: Record<string, SessionTouches | undefined>;
} {
  const api = useApi();
  const plan = contextRequests(model);
  const [maps, setMaps] = useState<Record<string, CodeMap | undefined>>(EMPTY_MAPS);
  const [touches, setTouches] = useState<Record<string, SessionTouches | undefined>>(EMPTY_TOUCHES);

  // A changed set of projects, teams, or sessions restarts only that feed, so its new members are fetched at once.
  const projectKey = enabled && plan.projects.length ? `projects:${plan.projects.join(",")}` : undefined;
  const teamKey = enabled && plan.teams.length ? `teams:${plan.teams.join(",")}` : undefined;
  const sessionKey = enabled && plan.sessions.length ? `sessions:${plan.sessions.join(",")}` : undefined;

  useLiveRefresh(async current => {
    const results = await fetchEach<CodeMap>(api, plan.projects.map(id => ({ key: id, path: `/projects/${encodeURIComponent(id)}/graph/map` })));
    if (current() && results.length) setMaps(prev => ({ ...prev, ...Object.fromEntries(results) }));
  }, MAP_INTERVAL, projectKey);

  useLiveRefresh(async current => {
    const results = await fetchEach<TeamTouches>(api, plan.teams.map(id => ({ key: id, path: `/teams/${encodeURIComponent(id)}/context` })));
    if (!current() || !results.length) return;
    setTouches(prev => {
      const next = { ...prev };
      for (const [, team] of results) for (const member of team.members) next[member.sessionId] = member;
      return next;
    });
  }, CONTEXT_INTERVAL, teamKey);

  useLiveRefresh(async current => {
    const results = await fetchEach<SessionTouches>(api, plan.sessions.map(id => ({ key: id, path: `/sessions/${encodeURIComponent(id)}/context` })));
    if (!current() || !results.length) return;
    setTouches(prev => ({ ...prev, ...Object.fromEntries(results.map(([key, value]) => [key, value])) }));
  }, CONTEXT_INTERVAL, sessionKey);

  return { maps: enabled ? maps : EMPTY_MAPS, touches: enabled ? touches : EMPTY_TOUCHES };
}
