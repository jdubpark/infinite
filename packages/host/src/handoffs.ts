import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import type { Manager } from "./manager.js";
import type { TeamService } from "./teams.js";
import { handoffEnvelopeSchema, handoffObjective, handoffPathsOverlap, type HandoffPolicy, type HandoffRequest, type HandoffView } from "./handoff-types.js";
import { cleanTeamCheckpoint } from "./team-workspace.js";
import { unseal, writeSealed } from "./vault.js";

type Stored = HandoffView & { sessionId: string; projectId: string; teamId: string; stopId: string; acceptedAt: string; deadlineAt: string; request: HandoffRequest; policy: HandoffPolicy };
type StartInProject = <T>(projectId: string, action: () => Promise<T>) => Promise<T>;
/** One durable transfer per source. Creation retries reuse the persisted team identity. */
export class HandoffService {
  private readonly records = new Map<string, Stored>();
  private readonly directory: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly teams: TeamService, private readonly startInProject: StartInProject, private readonly assertProjectAlone?: (sessionId: string, projectId: string) => Promise<void>) {
    this.directory = join(config.stateDir, "handoffs");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7), record = unseal<Stored>(key, `handoff:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (record.sessionId !== id) throw new Error("Invalid handoff record");
      this.records.set(id, record);
      if (!["started", "blocked"].includes(record.status)) {
        try { manager.reserveHandoff(record.projectId); }
        catch { record.status = "blocked"; record.reason = "The source project is no longer available in host configuration."; this.save(record); }
      }
    }
  }
  private save(record: Stored) { writeSealed(join(this.directory, `${record.sessionId}.sealed`), this.key, `handoff:${record.sessionId}`, record); }
  private discover(sessionId: string): Stored | undefined {
    const previous = this.records.get(sessionId);
    if (previous) return previous;
    const source = this.manager.meta(sessionId).session;
    if (!source.handoff?.policy) return;
    const event = this.manager.handoffRequest(sessionId);
    if (!event) return;
    const envelope = handoffEnvelopeSchema.parse(event.data);
    if (envelope.sessionId !== sessionId) throw new Error("Invalid handoff source");
    const policy = source.handoff.policy;
    const identityValid = policy.sourceSessionId === sessionId && policy.projectId === source.projectId;
    const record: Stored = { sessionId, projectId: source.projectId, teamId: randomUUID(), stopId: randomUUID(), acceptedAt: event.at,
      deadlineAt: new Date(Date.parse(event.at) + policy.maxMinutes * 60000).toISOString(), request: envelope.request, policy,
      status: identityValid ? "requested" : "blocked",
      ...(!identityValid ? { reason: "The handoff policy does not belong to its source session and project." } : {}) };
    this.save(record); this.records.set(sessionId, record);
    if (identityValid) this.manager.reserveHandoff(record.projectId);
    return record;
  }
  view(sessionId: string): HandoffView {
    const record = this.discover(sessionId);
    if (record) return { status: record.status, teamId: record.teamId, ...(record.reason ? { reason: record.reason } : {}) };
    const source = this.manager.meta(sessionId).session;
    return source.handoff?.policy ? { status: "available" } : { status: "unavailable", reason: source.handoff?.reason ?? "This session was created without a handoff capability." };
  }
  activeForProject(projectId: string) {
    const project = this.config.projects.find(project => project.id === projectId);
    const canonical = project ? realpathSync(project.path) : undefined;
    return [...this.records.values()].some(record => (record.projectId === projectId || (canonical && handoffPathsOverlap(record.policy.path, canonical))) && !["started", "blocked"].includes(record.status));
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick().catch(() => {}), 500); this.timer.unref(); void this.tick().catch(() => {});
  }
  close() { this.running = false; if (this.timer) clearInterval(this.timer); }
  private async tick() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      for (const source of await this.manager.list()) this.discover(source.id);
      for (const record of this.records.values()) {
        if (["started", "blocked"].includes(record.status)) continue;
        try { await this.step(record); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "control-busy") {
            record.status = "waiting-for-control"; record.reason = "The controlling client must detach before transfer."; this.save(record); continue;
          }
          record.status = "blocked"; record.reason = error instanceof Error ? error.message : "Handoff could not be confirmed; inspect the preserved source.";
          this.save(record); this.manager.releaseHandoff(record.projectId);
        }
      }
    } finally { this.busy = false; }
  }
  private async step(record: Stored) {
    // A crash after creation must find the same team before inspecting a changed source.
    try {
      const team = this.teams.get(record.teamId);
      if (team.handoff?.sourceSessionId !== record.sessionId || team.projectId !== record.projectId) throw new Error("Conflicting handoff team identity");
      if (!team.baseCommit && team.status !== "blocked") return;
      record.status = team.baseCommit ? "started" : "blocked";
      record.reason = team.baseCommit ? undefined : team.reason;
      this.save(record); this.manager.releaseHandoff(record.projectId); return;
    } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "team-not-found")) throw error; }
    if (Date.now() >= Date.parse(record.deadlineAt)) throw new Error("Handoff expired before team creation; the source and its edits were preserved.");
    const source = this.manager.meta(record.sessionId).session;
    if (record.policy.sourceSessionId !== record.sessionId || record.policy.projectId !== record.projectId || source.projectId !== record.projectId)
      throw new Error("The handoff policy no longer matches its source session and project.");
    const state = await this.manager.state(record.sessionId);
    if (state.control && state.control.expiresAt > Date.now()) {
      record.status = "waiting-for-control"; record.reason = "The source yielded. Detach its controlling client to allow transfer."; this.save(record); return;
    }
    await this.startInProject(record.projectId, async () => {
      await this.manager.assertHandoffAlone(record.sessionId);
      await this.assertProjectAlone?.(record.sessionId, record.projectId);
      if (this.teams.activeForProject(record.projectId)) throw new Error("Another team is active in this project.");
      if (realpathSync(record.policy.path) !== record.policy.path) throw new Error("The source repository path changed.");
      this.teams.assertHandoffPolicy(record.policy);
      const objective = handoffObjective(record.policy, record.request);
      await cleanTeamCheckpoint(record.policy.path, record.request.checkpointHead, record.policy.commandPrefix);
      if (!this.running) return;
      record.status = "stopping"; delete record.reason; this.save(record);
      const stopped = await this.manager.stopHandoffSession(record.sessionId, record.stopId);
      if (stopped.status !== "exited") return;
      await cleanTeamCheckpoint(record.policy.path, record.request.checkpointHead, record.policy.commandPrefix);
      record.status = "creating"; this.save(record);
      await this.teams.createForHandoff({ requestId: record.teamId, projectId: record.projectId, provider: record.policy.lineup.coordinator.provider,
        title: this.manager.meta(record.sessionId).session.title.slice(0, 100), objective, parallelism: record.request.parallelism },
        { sourceSessionId: record.sessionId, checkpointHead: record.request.checkpointHead, deadlineAt: record.deadlineAt, maxMembers: record.policy.maxMembers, project: record.policy.project,
          extendMinutes: record.policy.extendMinutes ?? 0, ceilingAt: new Date(Date.parse(record.acceptedAt) + (record.policy.maxTotalMinutes ?? record.policy.maxMinutes) * 60000).toISOString() }, record.policy);
      // Keep admission fenced until the pinned copy is fully prepared.
      this.save(record);
    });
  }
}
