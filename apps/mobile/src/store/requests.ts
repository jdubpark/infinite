import { useCallback, useSyncExternalStore } from "react";

export type CreationRequest = { requestId: string; backend: "infinite" | "cmux"; provider: string; projectId: string; title: string; prompt: string };
export type LifecycleRequest = { requestId: string; action: "stop" | "resume" };
export type TeamCreationRequest = { requestId: string; projectId: string; provider: string; useConfiguredLineup?: boolean; title: string; objective: string; parallelism: number };
export type GoalCreationRequest = {
  requestId: string; projectId: string; linearIssueId?: string; title: string; objective: string; successCriteria: string;
  nonGoals: string[]; allowedPaths: string[]; evidence: string[]; maxRuns: number; maxMinutes: number; maxMembers: number; parallelism: number;
};
export type MissionCreationRequest = { requestId: string; groupId: string; objective: string };
/** A steer, answer, lifecycle action or outcome for one team or goal, sent with the revision it was decided against. */
export type RunRequest = { requestId: string; revision: number; path: string; label: string; fields: Record<string, string> };
type RequestState<Request, Result> = { pending?: Request; result?: Result; message: string };

/** In-memory receipts survive screen changes; only their own request may settle them. */
function requestStore<Request extends { requestId: string }, Result>() {
  const empty: RequestState<Request, Result> = { message: "" };
  const values = new Map<string, RequestState<Request, Result>>();
  const listeners = new Map<string, Set<() => void>>();
  const read = (key: string) => values.get(key) ?? empty;
  const write = (key: string, value: RequestState<Request, Result>) => {
    if (value === empty) values.delete(key); else values.set(key, value);
    listeners.get(key)?.forEach(listener => listener());
  };
  return {
    read,
    begin(key: string, request: Request): Request {
      const pending = read(key).pending;
      if (pending) return pending;
      write(key, { pending: request, message: "" });
      return request;
    },
    complete(key: string, requestId: string, result?: Result, message = "") {
      if (read(key).pending?.requestId !== requestId) return false;
      write(key, { result, message });
      return true;
    },
    fail(key: string, requestId: string, message: string, rejected = false) {
      const current = read(key);
      if (current.pending?.requestId !== requestId) return;
      write(key, { ...current, pending: rejected ? undefined : current.pending, message });
    },
    clear(key: string) { write(key, empty); },
    clearMachine(machine: string) {
      for (const key of values.keys()) if (key === machine || key.startsWith(`${machine}/`)) write(key, empty);
    },
    use(key: string) {
      const subscribe = useCallback((listener: () => void) => {
        let group = listeners.get(key);
        if (!group) { group = new Set(); listeners.set(key, group); }
        group.add(listener);
        return () => { group.delete(listener); if (!group.size) listeners.delete(key); };
      }, [key]);
      const snapshot = useCallback(() => read(key), [key]);
      return useSyncExternalStore(subscribe, snapshot);
    },
  };
}

export const creations = requestStore<CreationRequest, { id: string }>();
export const lifecycles = requestStore<LifecycleRequest, { id: string }>();
export const teamCreations = requestStore<TeamCreationRequest, { id: string }>();
export const goalCreations = requestStore<GoalCreationRequest, { id: string }>();
export const missionCreations = requestStore<MissionCreationRequest, { id: string }>();
/** Keyed by machine and run, so a pending request follows its team or goal across screens. */
export const runRequests = requestStore<RunRequest, { id: string }>();
