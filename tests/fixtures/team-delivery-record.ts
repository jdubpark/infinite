import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "../team-fixture.js";
import type { TeamService } from "../../packages/host/src/teams.js";
import type { TeamMember, TeamReport, TeamRun } from "../../packages/host/src/team-types.js";
import type { ProjectSourceService } from "../../packages/host/src/project-source.js";
import { EventOutbox } from "../../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../../packages/host/src/evidence/store.js";

/** A run's host-private record as the delivery tests read it. */
export type DeliveryStored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root: string;
  checkHead?: string; halt?: string; deliveryAttempt?: { memberId: string; revision: number; headCommit: string };
  pending?: { id: string; kind: "result" | "member" | "check" | "prepare"; revision: number;
    source?: { memberId: string; role: TeamMember["role"]; cwd: string; baseCommit: string; headCommit: string; workspace: "member" | "integration" };
    failure?: { code?: string; reason: string; at: string } };
};
export const deliveryInternals = (teams: TeamService) => teams as unknown as {
  records: Map<string, DeliveryStored>; commands: Map<string, AbortController>;
  save(stored: DeliveryStored): void; step(stored: DeliveryStored): Promise<void>; consume(stored: DeliveryStored, member: TeamMember): void;
  recovery: { startAutomaticDeliveryRecovery(stored: DeliveryStored, trackingReady: boolean): Promise<boolean> };
};

/**
 * A run whose delivery member is reporting: checked and approved at its integration head, with a stopped scheduler, so a
 * test hands the host one delivery report at a time through `consume`.
 */
export async function deliveryRecord(mode: "merge" | "pr", onMerged?: (projectId: string) => void,
  source?: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> | ((fixture: Awaited<ReturnType<typeof fixture>>) => Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">),
  options: { events?: boolean } = {}) {
  const f = await fixture("delivery-fast", limitLineup, {}, { deliveryMode: mode, noServer: true });
  const id = randomUUID(), memberId = randomUUID(), branch = "infinite/team-delivery-test";
  git(f.source, "checkout", "-b", branch);
  const sourceService = typeof source === "function" ? source(f) : source;
  const store = options.events ? new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) }) : undefined;
  const teams = await f.openTeamService({ onMerged, ...(sourceService ? { source: sourceService } : {}), ...(store ? { events: new EventOutbox(store) } : {}), start: false });
  const root = join(f.host.config.teams!.workspaceDir, id);
  const workspace = join(root, "integration"), members = join(root, "members"), cwd = join(members, memberId);
  mkdirSync(members, { recursive: true, mode: 0o700 });
  git(f.source, "clone", "--no-hardlinks", f.source, workspace);
  git(workspace, "remote", "remove", "origin");
  const headCommit = git(workspace, "rev-parse", "HEAD");
  git(workspace, "clone", "--no-hardlinks", workspace, cwd);
  git(cwd, "remote", "remove", "origin");
  const at = new Date().toISOString();
  const policy = structuredClone(f.host.config.projects[0]!.team!.delivery!);
  const member: TeamMember = { runId: id, memberId, revision: 1, role: "delivery", provider: "codex", sessionId: randomUUID(),
    title: "delivery: Implement a small feature", status: "reported", cwd, baseCommit: headCommit, prompt: "", cursor: 0, stopRequestId: randomUUID(), startedAt: at };
  const run: TeamRun = { id, projectId: "rehearsal", provider: "codex", title: "Implement a small feature", objective: "Record an owner-authorized delivery.",
    parallelism: 2, revision: 1, status: "delivering", createdAt: at, updatedAt: at, workspace, branch, baseCommit: headCommit, headCommit,
    tasks: [], members: [member], decisions: [], checks: [], steering: [], events: [], round: 0, delivery: policy,
    review: { verdict: "approved", summary: "Reviewed the exact integration head.", revision: 1 } };
  const stored: DeliveryStored = { run, fingerprint: "fixture", receipts: {}, prepared: true, root: f.host.config.teams!.workspaceDir,
    checkHead: headCommit, deliveryAttempt: { memberId, revision: 1, headCommit } };
  const internals = teams as unknown as { records: Map<string, typeof stored>; consume: (record: typeof stored, member: TeamMember) => void };
  internals.records.set(id, stored);
  return { f, teams, run, member, stored, headCommit, id, store, consume(report: TeamReport) { member.report = report; internals.consume(stored, member); } };
}
