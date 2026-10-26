import type { NativeContinuation } from "./team-types.js";
import type { AgentProfile, WorkerState } from "./types.js";

export function withNativeContinuation(profile: AgentProfile, continuation: NativeContinuation): AgentProfile {
  const flag = continuation.mode === "start" ? "--session-id" : "--resume";
  return { ...profile, args: [...profile.args, flag, continuation.nativeSessionId] };
}

/** A resume that finds no conversation exits before any hook fires, so no native session ID is observed. */
export function resumeFailed(state: Pick<WorkerState, "status" | "nativeSession">, continuation: NativeContinuation | undefined): boolean {
  return continuation?.mode === "resume" && state.status === "exited" && (state.nativeSession === undefined || state.nativeSession === null);
}
