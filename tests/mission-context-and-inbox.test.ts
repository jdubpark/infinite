import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySignal, initialAttention, type Attention, type Signal, type SignalEvent } from "@infinite/attention";
import { Manager } from "../packages/host/src/manager.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import type { CreateMission, Mission, MissionReport, MissionSubtaskPlan } from "../packages/host/src/mission-types.js";
import type { MissionMessage } from "../packages/host/src/team-prompts.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { CreateTeam, NativeContinuation, TeamAssignment, TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import { emptyRollup } from "../packages/host/src/team-usage.js";
import type { Config, Event } from "../packages/host/src/types.js";
import { Journal, writeSealed } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import { lineup, scriptedMissionHarness } from "./mission-harness.js";

type PromptMessage = MissionMessage & {
  text?: string;
  reason?: string;
  check?: string;
  answer?: string;
  forwardedTo?: { subtaskId: string; childDecisionId: string };
};

const plan = (id: string, repoProjectId: string, dependsOn: string[] = []): MissionSubtaskPlan => ({
  id,
  repoProjectId,
  title: `Change ${id}`,
  objective: `Deliver ${id}`,
  size: "solo",
  parallelism: 1,
  dependsOn,
});

const missionRequest = (maxMinutes = 240): CreateMission => ({
  requestId: randomUUID(),
  groupId: "shop",
  objective: "Coordinate repository changes reliably",
  maxSubtasks: 8,
  maxMinutes,
});

const followUp = (inMinutes = 10, reason = "Check subteam status"): MissionReport => ({
  kind: "follow-up",
  inMinutes,
  reason,
  check: "Inspect the subteam run and checks",
});

const openFollowUpCount = (mission: Mission) => (mission.followUps ?? []).filter(item => item.state === "open").length;
const until = <T>(read: () => T, ready: (value: T) => boolean, timeoutMs = 20000) =>
  waitFor(async () => read(), ready, timeoutMs);

function customCoordinatorHarness(options?: {
  realManager?: boolean;
  emitInitialTurnStart?: boolean;
  onEvents?: (
    sessionId: string,
    after: number,
    limit: number,
    types: Set<string> | undefined,
    fallback: () => { events: Event[]; cursor: number; more: boolean },
  ) => { events: Event[]; cursor: number; more: boolean };
}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-c3-"));
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  const checks = [{ command: process.execPath, args: ["-e", "0"] }];
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile,
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    tokens: [],
    environment: "local",
    enableDemo: false,
    maxSessions: 24,
    agents: { claude: { command: process.execPath, args: [] } },
    projects: [
      { id: "api", name: "API", path: repo("api"), team: { checks } },
      { id: "web", name: "Web", path: repo("web"), team: { checks } },
    ],
    teams: { workspaceDir: join(root, "teams"), lineup },
  };
  const realManager = options?.realManager ? new Manager(config, key) : undefined;
  type CoordinatorRequest = { requestId: string; prompt: string; continuation?: NativeContinuation };
  const attempts: { sessionId: string; assignment: TeamAssignment; prompt: string; request: CoordinatorRequest }[] = [];
  const reports = new Map<string, { report: MissionReport; note?: string }>();
  const signals = new Map<string, SignalEvent[]>();
  const transcriptMessages = new Map<string, Event[]>();
  const usage = new Map<string, Event[]>();
  const attention = new Map<string, Attention>();
  const stateReads = new Map<string, number>();
  const sessionStatuses = new Map<string, "running" | "exited">();
  const nativeSessions = new Map<string, { id: string; source: "hook" }>();
  let launchHold: string | undefined;

  const pushSignal = (sessionId: string, data: Signal, source: "hook" | "screen" = "hook", at = new Date()) => {
    const journal = signals.get(sessionId)!;
    const event: SignalEvent = {
      seq: journal.length + 1,
      at: at.toISOString(),
      type: "signal",
      data: { ...data, source, provider: "claude" },
    };
    journal.push(event);
    attention.set(sessionId, applySignal(attention.get(sessionId)!, event));
  };

  const pushTranscriptMessage = (sessionId: string, role: "user" | "assistant" | "tool", text: string) => {
    const list = transcriptMessages.get(sessionId) ?? [];
    list.push({
      seq: list.length + 1,
      at: new Date().toISOString(),
      type: "message",
      data: { id: randomUUID(), role, text },
    });
    transcriptMessages.set(sessionId, list);
  };

  const pushUsage = (sessionId: string, contextTokens: number) => {
    const list = usage.get(sessionId) ?? [];
    const at = new Date().toISOString();
    list.push({
      seq: list.length + 1,
      at,
      type: "usage",
      data: {
        provider: "claude",
        providerId: "claude",
        modelId: "test-model",
        messageId: randomUUID(),
        partId: "",
        modelSource: "requested",
        completedAt: at,
        tokens: { input: contextTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        reportedCost: 0,
      },
    });
    usage.set(sessionId, list);
  };

  const seedSessionMeta = (sessionId: string, assignment: TeamAssignment) => {
    if (!realManager) return;
    const sessionDir = join(config.stateDir, "sessions", sessionId);
    mkdirSync(join(sessionDir, "events"), { recursive: true, mode: 0o700 });
    writeSealed(join(sessionDir, "meta.sealed"), key, `${sessionId}:meta`, {
      session: {
        id: sessionId,
        team: assignment,
        provider: "claude",
        title: "Mission coordinator",
        projectId: "api",
        cwd: config.projects[0].path,
        createdAt: new Date().toISOString(),
        status: "running",
        contextVersion: 0,
        context: "",
        initialPrompt: "",
      },
      fingerprint: "fixture",
    });
  };

  const defaultEvents = (sessionId: string, cursor: number, limit: number, types?: Set<string>) => {
    if (realManager && (!types || types.has("usage"))) {
      return realManager.events(sessionId, cursor, limit, types);
    }
    if (types?.has("usage")) {
      const events = (usage.get(sessionId) ?? []).filter(event => event.seq > cursor);
      return { events, cursor: events.at(-1)?.seq ?? cursor, more: false };
    }
    if (types?.has("signal") || types?.has("message")) {
      const combined: Event[] = [];
      if (types.has("signal")) {
        for (const event of signals.get(sessionId) ?? []) {
          combined.push(event as unknown as Event);
        }
      }
      if (types.has("message")) {
        for (const event of transcriptMessages.get(sessionId) ?? []) {
          combined.push({ ...event, seq: combined.length + 1000 });
        }
      }
      const events = combined.filter(event => event.seq > cursor);
      return { events, cursor: events.at(-1)?.seq ?? cursor, more: false };
    }
    const filed = reports.get(sessionId);
    const current = attempts.find(item => item.sessionId === sessionId)!;
    if (!filed || cursor > 0) return { events: [], cursor, more: false };
    const { runId, memberId, revision } = current.assignment;
    return {
      events: [{ seq: 1, at: new Date().toISOString(), type: "mission-report", data: { requestId: randomUUID(), missionId: runId, memberId, revision, ...filed } }],
      cursor: 1,
      more: false,
    };
  };

  const manager = {
    async createTeamSession(request: CoordinatorRequest, assignment: TeamAssignment) {
      if (!attempts.some(item => item.sessionId === request.requestId)) {
        attempts.push({ sessionId: request.requestId, assignment, prompt: request.prompt, request });
        signals.set(request.requestId, []);
        transcriptMessages.set(request.requestId, []);
        attention.set(request.requestId, initialAttention(new Date().toISOString(), true));
        sessionStatuses.set(request.requestId, "running");
        seedSessionMeta(request.requestId, assignment);
        if (options?.emitInitialTurnStart !== false) {
          pushSignal(request.requestId, { kind: "turn-start" });
        }
      }
      return { status: "running" };
    },
    events(sessionId: string, cursor: number, limit: number, types?: Set<string>) {
      const fallback = () => defaultEvents(sessionId, cursor, limit, types);
      return options?.onEvents ? options.onEvents(sessionId, cursor, limit, types, fallback) : fallback();
    },
    meta(sessionId: string) {
      if (launchHold !== undefined && !attempts.some(item => item.sessionId === sessionId)) {
        throw Object.assign(new Error("No such session"), { code: "ENOENT" });
      }
      return {};
    },
    hostLoad: { held: () => launchHold },
    async state(sessionId: string) {
      stateReads.set(sessionId, (stateReads.get(sessionId) ?? 0) + 1);
      return {
        status: sessionStatuses.get(sessionId) ?? "running",
        attention: attention.get(sessionId),
        nativeSession: nativeSessions.get(sessionId),
      };
    },
    async stopTeamSession(sessionId: string) {
      sessionStatuses.set(sessionId, "exited");
      return { status: "exited", nativeSession: nativeSessions.get(sessionId) };
    },
  };

  const runs = new Map<string, TeamView>();
  const teams = {
    useMissionReservations() {},
    isActiveRun(id: string) {
      const current = runs.get(id);
      return Boolean(current && !["cancelled", "ready-for-review", "merged", "no-change"].includes(current.status));
    },
    async createForMission(request: CreateTeam, missionId: string) {
      const existing = runs.get(request.requestId);
      if (existing) return structuredClone(existing);
      const created: TeamView = {
        id: request.requestId,
        projectId: request.projectId,
        missionId,
        title: request.title,
        status: "implementing",
        revision: 1,
        decisions: [],
        tasks: [],
        members: [],
        updatedAt: new Date().toISOString(),
        parallelism: request.parallelism,
        usage: emptyRollup(),
      } as unknown as TeamView;
      runs.set(request.requestId, created);
      return structuredClone(created);
    },
    get(id: string) {
      const value = runs.get(id);
      if (!value) throw new TeamError(404, "team-not-found", "This team does not exist.");
      return structuredClone(value);
    },
    list: () => [...runs.values()].map(item => structuredClone(item)),
    async answer(id: string, decisionId: string, body: { text: string }) {
      const target = runs.get(id)!;
      const decision = target.decisions.find(item => item.id === decisionId);
      if (decision) decision.answer = body.text;
      return structuredClone(target);
    },
    async pause(id: string) {
      const target = runs.get(id)!;
      target.status = "paused";
      return structuredClone(target);
    },
    async resume(id: string) {
      const target = runs.get(id)!;
      target.status = "implementing";
      return structuredClone(target);
    },
    async cancel(id: string) {
      const target = runs.get(id)!;
      target.status = "cancelled";
      return structuredClone(target);
    },
    activeForProject: (projectId: string) =>
      [...runs.values()].some(item => item.projectId === projectId && !["cancelled", "ready-for-review", "merged", "no-change"].includes(item.status)),
  };

  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = {
    get: id => {
      if (id !== "shop") throw new TeamError(404, "project-group-not-found", "This project does not exist.");
      return {
        id,
        name: "Shop",
        kind: "owner",
        hidden: false,
        implicit: false,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        repos: [
          { projectId: "api", name: "API", path: config.projects[0].path, checkouts: [{ projectId: "api", name: "API", path: config.projects[0].path, primary: true, teamReady: true }] },
          { projectId: "web", name: "Web", path: config.projects[1].path, checkouts: [{ projectId: "web", name: "Web", path: config.projects[1].path, primary: true, teamReady: true }] },
        ],
      };
    },
  };

  const open = () => {
    const service = new MissionService(config, key, manager as unknown as Manager, teams as unknown as TeamService, groups);
    service.start();
    return service;
  };
  let missions = open();
  const attempt = async (n: number) => (await waitFor(async () => attempts[n - 1], value => Boolean(value), 20000))!;
  const parse = (prompt: string, label: string) => JSON.parse(prompt.split("\n").find(line => line.startsWith(label))!.slice(label.length));

  return {
    get missions() { return missions; },
    config,
    key,
    runs,
    attempt,
    attempts: () => attempts.length,
    holdLaunches: (reason?: string) => { launchHold = reason; },
    pushSignal: async (n: number, data: Signal, source: "hook" | "screen" = "hook") => pushSignal((await attempt(n)).sessionId, data, source),
    pushTranscriptMessage: async (n: number, role: "user" | "assistant" | "tool", text: string) => pushTranscriptMessage((await attempt(n)).sessionId, role, text),
    pushUsage: async (n: number, tokens: number) => pushUsage((await attempt(n)).sessionId, tokens),
    confirmNative: async (n: number) => {
      const current = await attempt(n);
      const nativeSessionId = current.request.continuation?.nativeSessionId;
      if (!nativeSessionId) throw new Error("Coordinator attempt has no native continuation ID");
      const previousReads = stateReads.get(current.sessionId) ?? 0;
      nativeSessions.set(current.sessionId, { id: nativeSessionId, source: "hook" });
      await waitFor(async () => stateReads.get(current.sessionId) ?? 0, reads => reads > previousReads, 5000);
    },
    messages: async (n: number) => parse((await attempt(n)).prompt, "Messages since your last attempt (JSON): ") as PromptMessage[],
    report: async (n: number, report: MissionReport) => { reports.set((await attempt(n)).sessionId, { report }); },
    restart: async () => { missions.close(); await missions.idle(); missions = open(); },
    close: () => { missions.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("INF-455: observeContext emits a bounded warning on unexpected manager.events read failures, deduplicates across repeated reads, and clears after recovery", { timeout: 60000 }, async () => {
  let failingSessionId: string | undefined;
  let failureError: Error | undefined;
  let usageReads = 0;
  const warnings: string[] = [];
  const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(arg => String(arg)).join(" "));
  });
  const h = customCoordinatorHarness({
    onEvents: (sessionId, _after, _limit, types, fallback) => {
      if (types?.has("usage") && sessionId === failingSessionId) {
        usageReads += 1;
        if (failureError) throw failureError;
      }
      return fallback();
    },
  });
  try {
    const { id } = await h.missions.create(missionRequest(240));
    const first = await h.attempt(1);
    failingSessionId = first.sessionId;
    await h.confirmNative(1);
    await h.report(1, followUp(120));
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    failureError = Object.assign(new Error("EIO: disk read failed\nsecret-line"), { code: "EIO" });
    h.holdLaunches("Waiting for host capacity: memory is low");
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.missions.get(id).revision, text: "First check" });
    const held1 = await until(() => h.missions.get(id), mission => mission.reason === "Waiting for host capacity: memory is low");
    assert.equal(usageReads, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(id));
    assert.match(warnings[0], new RegExp(first.sessionId));
    assert.match(warnings[0], /EIO/);
    assert.doesNotMatch(warnings[0], /\n/);

    await h.missions.pause(id, { requestId: randomUUID(), revision: held1.revision });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "stopped");
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.missions.get(id).revision });
    const held2 = await until(() => h.missions.get(id), mission => mission.reason === "Waiting for host capacity: memory is low");
    assert.equal(usageReads, 2);
    assert.equal(warnings.length, 1);

    failureError = undefined;
    await h.pushUsage(1, 40000);
    await h.missions.pause(id, { requestId: randomUUID(), revision: held2.revision });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "stopped");
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.missions.get(id).revision });
    const held3 = await until(() => h.missions.get(id), mission => mission.reason === "Waiting for host capacity: memory is low");
    assert.equal(usageReads, 3);
    assert.equal(warnings.length, 1);

    failureError = Object.assign(new Error("EACCES: journal unreadable"), { code: "EACCES" });
    await h.missions.pause(id, { requestId: randomUUID(), revision: held3.revision });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "stopped");
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.missions.get(id).revision });
    const held4 = await until(() => h.missions.get(id), mission => mission.reason === "Waiting for host capacity: memory is low");
    assert.equal(usageReads, 4);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /EACCES/);

    failureError = undefined;
    await h.pushUsage(1, 130000);
    await h.missions.pause(id, { requestId: randomUUID(), revision: held4.revision });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "stopped");
    h.holdLaunches();
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.missions.get(id).revision });
    const rotated = await h.attempt(2);
    assert.equal(rotated.request.continuation?.mode, "start");
    assert.notEqual(rotated.request.continuation?.nativeSessionId, first.request.continuation?.nativeSessionId);
  } finally {
    warnMock.mock.restore();
    h.close();
  }
});

test("INF-455: real Manager missing-session ENOENT stays quiet while corrupted session journal emits a bounded warning without leaking contents", { timeout: 60000 }, async () => {
  const warnings: string[] = [];
  const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(arg => String(arg)).join(" "));
  });
  const h = customCoordinatorHarness({ realManager: true });
  try {
    const { id } = await h.missions.create(missionRequest(240));
    const first = await h.attempt(1);
    await h.confirmNative(1);
    await h.report(1, followUp(120));
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    rmSync(join(h.config.stateDir, "sessions", first.sessionId), { recursive: true, force: true });
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.missions.get(id).revision, text: "Check after missing session" });
    const second = await h.attempt(2);
    assert.equal(second.request.continuation?.mode, "resume");
    assert.equal(warnings.length, 0);

    await h.confirmNative(2);
    const journal = new Journal(join(h.config.stateDir, "sessions", second.sessionId, "events"), h.key, second.sessionId);
    journal.append("usage", {
      provider: "claude",
      providerId: "claude",
      modelId: "test-model",
      messageId: randomUUID(),
      partId: "",
      modelSource: "requested",
      completedAt: new Date().toISOString(),
      tokens: { input: 50000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      reportedCost: 0,
    });
    writeFileSync(join(h.config.stateDir, "sessions", second.sessionId, "events", "0000000000.journal"), "SECRET_CORRUPT_PAYLOAD_DO_NOT_LEAK\n");
    await h.report(2, { kind: "wait", summary: "Waiting for updates" });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "waiting" && mission.events.some(event => /waiting for subteam progress/.test(event.text)));

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.missions.get(id).revision, text: "Check corrupted journal" });
    const third = await h.attempt(3);
    assert.equal(third.request.continuation?.mode, "resume");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(id));
    assert.match(warnings[0], new RegExp(second.sessionId));
    assert.doesNotMatch(warnings[0], /SECRET_CORRUPT_PAYLOAD_DO_NOT_LEAK/);
  } finally {
    warnMock.mock.restore();
    h.close();
  }
});

test("INF-458: pause after delivery to a resumable native session does not redeliver duplicate inbox or note messages on resume", { timeout: 60000 }, async () => {
  const h = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await h.missions.create(missionRequest(240));
    const first = await h.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await h.confirmNative(1);
    await h.report(1, { kind: "dispatch", summary: "Start API work", subtasks: [plan("a", "api")] });
    const started = await until(() => h.get(id), mission => Boolean(mission.subtasks.find(item => item.id === "a")?.teamId));
    const teamId = started.subtasks[0].teamId!;
    const childDecisionId = randomUUID();
    h.set(teamId, {
      status: "needs-input",
      decisions: [{
        id: childDecisionId,
        memberId: randomUUID(),
        revision: 1,
        question: "Use JSON or NDJSON?",
        options: ["JSON", "NDJSON"],
        createdAt: new Date().toISOString(),
      }],
    });
    const second = await h.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await h.confirmNative(2);
    await h.report(2, {
      kind: "question",
      question: "Use JSON or NDJSON?",
      options: ["JSON", "NDJSON"],
      subtaskId: "a",
      childDecisionId,
      recommendation: { answers: ["JSON"], reason: "Existing clients parse JSON." },
    });
    const asked = await until(() => h.get(id), mission => mission.status === "needs-input" && mission.coordinator?.status === "waiting");

    await h.missions.answer(id, asked.decisions[0].id, { requestId: randomUUID(), revision: asked.revision, text: "JSON" });
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Focus on API error codes" });
    const third = await h.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const thirdMessages = await h.messages(3) as PromptMessage[];
    assert.equal(thirdMessages.filter(message => message.type === "owner-direction" && message.text === "Focus on API error codes").length, 1);
    assert.equal(thirdMessages.filter(message => message.type === "owner-answer" && message.forwardedTo?.childDecisionId === childDecisionId).length, 1);
    await h.confirmNative(3);

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Also check timeout handling" });
    await h.missions.pause(id, { requestId: randomUUID(), revision: h.get(id).revision });
    await until(() => h.get(id), mission => mission.coordinator?.status === "stopped");

    mock.timers.tick(5 * 60000);
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.get(id).revision });
    const fourth = await h.attempt(4);
    assert.deepEqual([fourth.request.continuation?.mode, fourth.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const fourthMessages = await h.messages(4) as PromptMessage[];
    assert.equal(fourthMessages.filter(message => message.type === "owner-direction" && message.text === "Focus on API error codes").length, 0);
    assert.equal(fourthMessages.filter(message => message.type === "owner-answer" && message.forwardedTo?.childDecisionId === childDecisionId).length, 0);
    assert.equal(fourthMessages.filter(message => message.type === "owner-direction" && message.text === "Also check timeout handling").length, 1);
    assert.equal(fourthMessages.filter(message => message.type === "resumed").length, 1);
  } finally {
    h.close();
    mock.timers.reset();
  }
});

test("INF-458: exit before delivery preserves messages on resume, transcript-only delivery deduplicates, and resume failure restores unapplied messages to a fresh conversation", { timeout: 60000 }, async () => {
  const preDelivery = customCoordinatorHarness({ emitInitialTurnStart: false });
  try {
    const { id } = await preDelivery.missions.create(missionRequest(240));
    const first = await preDelivery.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await preDelivery.confirmNative(1);
    await preDelivery.pushTranscriptMessage(1, "user", first.prompt);
    await preDelivery.report(1, followUp(120));
    await until(() => preDelivery.missions.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    await preDelivery.missions.steer(id, { requestId: randomUUID(), revision: preDelivery.missions.get(id).revision, text: "Deliver even if killed on SessionEnd" });
    const second = await preDelivery.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await preDelivery.confirmNative(2);
    await preDelivery.pushTranscriptMessage(2, "user", first.prompt);
    await preDelivery.pushSignal(2, { kind: "notice", type: "session_end", message: "stopped" });
    await preDelivery.missions.pause(id, { requestId: randomUUID(), revision: preDelivery.missions.get(id).revision });
    await until(() => preDelivery.missions.get(id), mission => mission.coordinator?.status === "stopped");

    await preDelivery.missions.resume(id, { requestId: randomUUID(), revision: preDelivery.missions.get(id).revision });
    const third = await preDelivery.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const thirdMessages = await preDelivery.messages(3);
    assert.equal(thirdMessages.filter(message => message.type === "owner-direction" && message.text === "Deliver even if killed on SessionEnd").length, 1);

    await preDelivery.confirmNative(3);
    await preDelivery.pushTranscriptMessage(3, "user", third.prompt);
    await preDelivery.missions.pause(id, { requestId: randomUUID(), revision: preDelivery.missions.get(id).revision });
    await until(() => preDelivery.missions.get(id), mission => mission.coordinator?.status === "stopped");

    await preDelivery.missions.resume(id, { requestId: randomUUID(), revision: preDelivery.missions.get(id).revision });
    const fourth = await preDelivery.attempt(4);
    assert.deepEqual([fourth.request.continuation?.mode, fourth.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const fourthMessages = await preDelivery.messages(4);
    assert.equal(fourthMessages.filter(message => message.type === "owner-direction" && message.text === "Deliver even if killed on SessionEnd").length, 0);
    assert.equal(fourthMessages.filter(message => message.type === "resumed").length, 1);
  } finally {
    preDelivery.close();
  }

  const fallback = scriptedMissionHarness();
  try {
    const { id } = await fallback.missions.create(missionRequest(240));
    const first = await fallback.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await fallback.confirmNative(1);
    await fallback.report(1, followUp(120));
    await until(() => fallback.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    await fallback.missions.steer(id, { requestId: randomUUID(), revision: fallback.get(id).revision, text: "Must survive resume failure" });
    const second = await fallback.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await fallback.confirmNative(2);
    await fallback.missions.pause(id, { requestId: randomUUID(), revision: fallback.get(id).revision });
    await until(() => fallback.get(id), mission => mission.coordinator?.status === "stopped");

    await fallback.missions.resume(id, { requestId: randomUUID(), revision: fallback.get(id).revision });
    const third = await fallback.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    assert.equal((await fallback.messages(3) as PromptMessage[]).filter(message => message.type === "owner-direction").length, 0);
    await fallback.exitWithoutNative(3);

    const fourth = await fallback.attempt(4);
    assert.equal(fourth.request.continuation?.mode, "start");
    assert.notEqual(fourth.request.continuation?.nativeSessionId, nativeId);
    const fourthMessages = await fallback.messages(4) as PromptMessage[];
    assert.deepEqual(
      fourthMessages.filter(message => message.type === "owner-direction").map(message => message.text),
      ["Must survive resume failure"],
    );
  } finally {
    fallback.close();
  }
});

test("INF-458: durable restart mid-cycle preserves deduplication on resume and clears receipts on applied report", { timeout: 60000 }, async () => {
  const resumeAfterRestart = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await resumeAfterRestart.missions.create(missionRequest(240));
    const first = await resumeAfterRestart.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await resumeAfterRestart.confirmNative(1);
    await resumeAfterRestart.report(1, followUp(10, "Check release artifacts"));
    await until(() => resumeAfterRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    mock.timers.tick(10 * 60000);
    const second = await resumeAfterRestart.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await resumeAfterRestart.confirmNative(2);
    await resumeAfterRestart.missions.pause(id, { requestId: randomUUID(), revision: resumeAfterRestart.get(id).revision });
    await until(() => resumeAfterRestart.get(id), mission => mission.coordinator?.status === "stopped");

    await resumeAfterRestart.restart();
    mock.timers.tick(5 * 60000);
    await resumeAfterRestart.missions.resume(id, { requestId: randomUUID(), revision: resumeAfterRestart.get(id).revision });
    const third = await resumeAfterRestart.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const thirdMessages = await resumeAfterRestart.messages(3) as PromptMessage[];
    assert.equal(thirdMessages.filter(message => message.type === "follow-up").length, 0);
    assert.equal(thirdMessages.filter(message => message.type === "resumed").length, 1);

    await resumeAfterRestart.confirmNative(3);
    await resumeAfterRestart.report(3, followUp(30, "Follow up after resume"));
    await until(() => resumeAfterRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);
    const settledRecord = resumeAfterRestart.stored(id) as unknown as { deliveredUnapplied?: unknown };
    assert.equal(settledRecord.deliveredUnapplied, undefined);
  } finally {
    resumeAfterRestart.close();
    mock.timers.reset();
  }
});

test("INF-458: durable restart preserves unapplied messages on idle rotation and deduplicates on deadline extension inside the idle window", { timeout: 60000 }, async () => {
  const rotateAfterRestart = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await rotateAfterRestart.missions.create(missionRequest(240));
    const first = await rotateAfterRestart.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await rotateAfterRestart.confirmNative(1);
    await rotateAfterRestart.report(1, followUp(10, "Check release artifacts"));
    await until(() => rotateAfterRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    mock.timers.tick(10 * 60000);
    await rotateAfterRestart.attempt(2);
    await rotateAfterRestart.confirmNative(2);
    await rotateAfterRestart.missions.pause(id, { requestId: randomUUID(), revision: rotateAfterRestart.get(id).revision });
    await until(() => rotateAfterRestart.get(id), mission => mission.coordinator?.status === "stopped");

    await rotateAfterRestart.restart();
    mock.timers.tick(61 * 60000);
    await rotateAfterRestart.missions.resume(id, { requestId: randomUUID(), revision: rotateAfterRestart.get(id).revision });
    const third = await rotateAfterRestart.attempt(3);
    assert.equal(third.request.continuation?.mode, "start");
    assert.notEqual(third.request.continuation?.nativeSessionId, nativeId);
    const thirdMessages = await rotateAfterRestart.messages(3) as PromptMessage[];
    assert.equal(thirdMessages.filter(message => message.type === "follow-up" && message.reason === "Check release artifacts").length, 1);
  } finally {
    rotateAfterRestart.close();
    mock.timers.reset();
  }

  const deadlineAfterRestart = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await deadlineAfterRestart.missions.create(missionRequest(10));
    const first = await deadlineAfterRestart.attempt(1);
    const nativeId = first.request.continuation?.nativeSessionId;
    await deadlineAfterRestart.confirmNative(1);
    await deadlineAfterRestart.report(1, followUp(5, "Recheck build"));
    await until(() => deadlineAfterRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    mock.timers.tick(5 * 60000);
    await deadlineAfterRestart.attempt(2);
    await deadlineAfterRestart.confirmNative(2);
    mock.timers.tick(6 * 60000);
    const blocked = await until(() => deadlineAfterRestart.get(id), mission => mission.status === "blocked" && mission.stopReason === "deadline" && mission.coordinator?.status === "stopped");

    await deadlineAfterRestart.restart();
    await deadlineAfterRestart.missions.extend(id, { requestId: randomUUID(), revision: blocked.revision, minutes: 30 });
    const third = await deadlineAfterRestart.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const thirdMessages = await deadlineAfterRestart.messages(3) as PromptMessage[];
    assert.equal(thirdMessages.filter(message => message.type === "follow-up").length, 0);
    assert.equal(thirdMessages.filter(message => message.type === "resumed").length, 1);
  } finally {
    deadlineAfterRestart.close();
    mock.timers.reset();
  }
});
