import type { TeamModelProfile, TeamRun } from "../../packages/host/src/team-types.js";

export const ENTRY_PROVIDERS = ["claude", "codex", "opencode"] as const;
export const ENTRY_PROFILE: TeamModelProfile = {
  id: "fixture-profile",
  label: "Fixture profile",
  provider: "claude",
  model: "fixture-model",
  effort: "high",
};

export function smallRun(extra: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    projectId: "example-project",
    provider: "claude",
    title: "Entry prompt run",
    objective: "Preserve the owner-visible contract.",
    parallelism: 1,
    revision: 1,
    status: "implementing",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    workspace: "/home/dev/projects/example",
    branch: "infinite/team-entry",
    baseCommit: "a".repeat(40),
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 1,
    ...extra,
  } as TeamRun;
}
