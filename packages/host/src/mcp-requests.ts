import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { IntakeService, outboundText } from "./intake.js";
import { deterministicUuid, missionRequestId, type IntakeExternalScope, type IntakeRecord } from "./intake-types.js";
import type { IntakeStore } from "./intake-store.js";
import type { MissionService } from "./missions.js";
import type { Mission } from "./mission-types.js";
import type { ProjectGroupService } from "./project-groups.js";
import type { ProjectGroup } from "./project-group-types.js";
import type { Config } from "./types.js";
import {
  McpRequestError, mcpStartSchema, mcpReplySchema, mcpControlSchema,
  type ConnectorSource, type McpConnector, type McpRequestApi, type McpRequestView,
  type McpStartInput, type McpReplyInput, type McpControlInput,
} from "./mcp-types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const denied = () => new McpRequestError("request-unavailable", "This request or project is unavailable.");
const conflict = () => new McpRequestError("request-conflict", "This request ID belongs to different content.");
const notStarted = () => new McpRequestError("request-not-started", "This request has not started. Read it again before sending an action.");
export const mcpRequestErrorMessages: Readonly<Record<string, string>> = {
  "request-unavailable": "This request or project is unavailable.",
  "request-conflict": "This request ID belongs to different content.",
  "request-not-started": "This request has not started. Read it again before sending an action.",
  "request-action-unavailable": "This action is unavailable. Read the request again.",
  "stale-mission-revision": "The request changed. Read it again before sending an action.",
  "decision-not-found": "This question is unavailable. Read the request again.",
  "decision-answered": "This question has already been answered. Read the request again.",
  "mission-not-running": "This request is not running.",
  "mission-not-paused": "This request is not paused.",
  "mission-cancelled": "This request has already been cancelled.",
  "mission-deadline": "This request's time limit has expired.",
  "mission-steering-limit": "This request cannot accept more direction.",
};

/** Scoped producer and reader over the host's sealed intake queue and mission receipts. */
export class McpRequestService implements McpRequestApi {
  constructor(
    private readonly config: Config,
    private readonly store: IntakeStore,
    private readonly intake: IntakeService,
    private readonly missions: MissionService,
    private readonly groups: Pick<ProjectGroupService, "get" | "list">,
  ) {
    intake.useExternalAdmission(record => this.authorize(record));
  }

  private connector(id: string): McpConnector {
    const connector = this.config.mcp?.connectors.find(item => item.id === id);
    if (!connector || !this.config.intake || !this.config.linear || !this.intake.enabled()) throw denied();
    return connector;
  }

  private scope(connector: McpConnector, group: ProjectGroup): IntakeExternalScope {
    if (group.hidden || group.repos.length === 0) throw denied();
    const selectedCheckouts: string[] = [];
    const repositories = group.repos.map(repo => {
      if (!repo.checkouts.length) throw denied();
      const selected = repo.checkouts.find(checkout => checkout.primary && checkout.teamReady)
        ?? repo.checkouts.find(checkout => checkout.teamReady)
        ?? repo.checkouts.find(checkout => checkout.primary) ?? repo.checkouts[0];
      selectedCheckouts.push(selected.projectId);
      const checkouts = repo.checkouts.map(checkout => {
        if (!connector.projectIds.includes(checkout.projectId)) throw denied();
        const project = this.config.projects.find(item => item.id === checkout.projectId);
        if (!project) throw denied();
        // Resolve the enrolled path again so symlink retargeting cannot silently change queued execution.
        return { projectId: checkout.projectId, path: realpathSync(project.path), primary: checkout.primary };
      }).sort((a, b) => a.projectId.localeCompare(b.projectId));
      return { projectId: repo.projectId, ...(repo.key ? { key: repo.key } : {}), checkouts };
    }).sort((a, b) => a.projectId.localeCompare(b.projectId));
    return { groupId: group.id, repositories, selectedCheckouts: selectedCheckouts.sort() };
  }

  private authorize(record: IntakeRecord): ConnectorSource {
    try {
      if (!record?.external || !record.request) throw denied();
      const connector = this.connector(record.external.connectorId);
      const current = this.scope(connector, this.groups.get(record.external.scope.groupId));
      if (digest(current) !== digest(record.external.scope)) throw denied();
      return { kind: "connector", id: connector.id, name: connector.name };
    } catch { throw denied(); }
  }

  listProjects(connectorId: string) {
    const connector = this.connector(connectorId);
    const projects = this.groups.list().groups.flatMap(group => {
      try {
        this.scope(connector, group);
        return [{ id: group.id, name: outboundText(this.config, group.name) }];
      } catch { return []; }
    });
    return { projects };
  }

  startRequest(connectorId: string, input: McpStartInput): McpRequestView {
    const request = mcpStartSchema.parse(input);
    const connector = this.connector(connectorId);
    const issueId = deterministicUuid("mcp-intake", `${connectorId}:${request.requestId}`);
    const fingerprint = digest(request);
    const prior = this.store.get(issueId);
    if (prior) {
      if (prior.external?.connectorId !== connectorId) throw denied();
      this.authorize(prior);
      if (prior.external.fingerprint !== fingerprint) throw conflict();
      return this.view(prior);
    }
    let scope: IntakeExternalScope;
    try { scope = this.scope(connector, this.groups.get(request.projectId)); }
    catch { throw denied(); }
    const at = new Date().toISOString();
    const title = request.title ?? request.objective.split("\n")[0].slice(0, 100);
    const record = this.store.create({
      issueId, identifier: "", url: "", title, description: "", issueCreatedAt: at, issueUpdatedAt: at,
      state: "queued", rule: "authenticated delegated connector request",
      external: { connectorId, requestId: request.requestId, fingerprint, scope },
      request: { requestId: missionRequestId(issueId), groupId: scope.groupId, title, objective: request.objective,
        checkouts: scope.selectedCheckouts, maxSubtasks: this.config.intake!.mission.maxSubtasks, maxMinutes: this.config.intake!.mission.maxMinutes },
      comments: {}, messages: [], questions: [], inbound: [], createdAt: at, updatedAt: at,
    });
    // Intake's existing timer owns filing and execution. The response only promises the sealed admission above.
    return this.view(record);
  }

  private owned(connectorId: string, runId: string): IntakeRecord {
    this.connector(connectorId);
    const record = this.store.list().find(item => item.external?.connectorId === connectorId && item.request?.requestId === runId);
    if (!record) throw denied();
    this.authorize(record);
    return record;
  }

  getRequest(connectorId: string, runId: string): McpRequestView { return this.view(this.owned(connectorId, runId)); }

  private async mutate(connectorId: string, runId: string, perform: (mission: Mission, source: ConnectorSource, authorize: () => void) => Promise<Mission>): Promise<McpRequestView> {
    const record = this.owned(connectorId, runId);
    const mission = this.missions.peek(runId);
    if (!mission) throw notStarted();
    const authorize = () => { this.authorize(this.owned(connectorId, runId)); };
    const source = this.authorize(record);
    try { await perform(mission, source, authorize); }
    catch (error) {
      if (error instanceof McpRequestError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "request-conflict") throw conflict();
      if (code && Object.hasOwn(mcpRequestErrorMessages, code)) throw new McpRequestError(code, mcpRequestErrorMessages[code]);
      throw new McpRequestError("request-action-unavailable", "This action is unavailable. Read the request again.");
    }
    return this.getRequest(connectorId, runId);
  }

  replyToRequest(connectorId: string, input: McpReplyInput): Promise<McpRequestView> {
    const request = mcpReplySchema.parse(input);
    const body = { requestId: deterministicUuid("mcp-action", `${connectorId}:${request.runId}:${request.requestId}`), revision: request.revision, text: request.text };
    return this.mutate(connectorId, request.runId, (_mission, source, authorize) => request.decisionId
      ? this.missions.answer(request.runId, request.decisionId, body, source, authorize)
      : this.missions.steer(request.runId, body, source, authorize));
  }

  controlRequest(connectorId: string, input: McpControlInput): Promise<McpRequestView> {
    const request = mcpControlSchema.parse(input);
    const body = { requestId: deterministicUuid("mcp-action", `${connectorId}:${request.runId}:${request.requestId}`), revision: request.revision };
    return this.mutate(connectorId, request.runId, (_mission, source, authorize) => request.action === "pause"
      ? this.missions.pause(request.runId, body, undefined, source, authorize)
      : this.missions[request.action](request.runId, body, source, authorize));
  }

  private view(record: IntakeRecord): McpRequestView {
    const mission = this.missions.peek(record.request!.requestId);
    let url: string | undefined;
    try {
      const parsed = new URL(record.url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.href;
    } catch { /* Pending tracking has no URL. */ }
    const live = mission && ["planning", "working", "needs-input"].includes(mission.status);
    return {
      runId: record.request!.requestId, projectId: record.external!.scope.groupId, title: outboundText(this.config, record.title),
      status: mission?.status ?? "queued", ...(mission ? { revision: mission.revision } : {}),
      tracking: record.external!.filedAt ? { state: "linked", identifier: record.identifier, ...(url ? { url } : {}) } : { state: "pending" },
      questions: mission?.decisions.filter(decision => !decision.answer).map(decision => ({ id: decision.id,
        question: outboundText(this.config, decision.question), options: decision.options.map(option => outboundText(this.config, option)) })) ?? [],
      ...(mission?.result ? { result: { kind: "agent-report" as const, summary: outboundText(this.config, mission.result.summary) } } : {}),
      ...(!mission ? { message: record.holdReason ? "This request is queued and waiting for tracking or execution admission." : "This request is queued." } : {}),
      availableActions: !mission ? [] : live ? ["reply", "pause", "cancel"] : mission.status === "paused" ? ["resume", "cancel"] : mission.status === "cancelled" ? [] : ["cancel"],
    };
  }
}
