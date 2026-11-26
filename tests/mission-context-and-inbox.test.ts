import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySignal, initialAttention, type Attention, type Signal, type SignalEvent } from "@infinite/attention";
import { Manager } from "../packages/host/src/manager.js";
import {
  classifyAttemptDelivery,
  hasPendingCoordinatorInbox,
  reconcileDeliveredUnapplied,
  returnConsumedMessages,
  settleUnappliedConsumed,
  type ConsumedAttempt,
  type MissionQueueState,
} from "../packages/host/src/mission-coordinator.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import type { CreateMission, Mission, MissionReport, MissionSubtaskPlan } from "../packages/host/src/mission-types.js";
import type { MissionMessage } from "../packages/host/src/team-prompts.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { CreateTeam, NativeContinuation, TeamAssignment, TeamView } from "../packages/host/src/team-types.js";
import { emptyRollup } from "../packages/host/src/team-usage.js";
import type { Config, Event } from "../packages/host/src/types.js";
import { Journal, unseal, writeSealed } from "../packages/host/src/vault.js";
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
  id, repoProjectId, title: `Change ${id}`, objective: `Deliver ${id}`, size: "solo", parallelism: 1, dependsOn,
});
const missionRequest = (maxMinutes = 240, objective = "Coordinate repository changes reliably"): CreateMission => ({
  requestId: randomUUID(), groupId: "shop", objective, maxSubtasks: 8, maxMinutes,
});
const followUp = (inMinutes = 10, reason = "Check subteam status"): MissionReport => ({
  kind: "follow-up", inMinutes, reason, check: "Inspect the subteam run and checks",
});
const openFollowUpCount = (mission: Mission) => (mission.followUps ?? []).filter(item => item.state === "open").length;
const until = <T>(read: () => T, ready: (value: T) => boolean, timeoutMs = 20000) => waitFor(async () => read(), ready, timeoutMs);
const confirmDurableDelivery = async (h: ReturnType<typeof scriptedMissionHarness>, n: number) => {
  await h.confirmNative(n);
  await h.signal(n, { kind: "tool-start", tool: "Read", input: {}, quiet: true });
};

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
  const repo = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
  const checks = [{ command: process.execPath, args: ["-e", "0"] }];
  const key = randomBytes(32), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"), tokens: [],
    environment: "local", enableDemo: false, maxSessions: 24, agents: { claude: { command: process.execPath, args: [] } },
    projects: [{ id: "api", name: "API", path: repo("api"), team: { checks } }, { id: "web", name: "Web", path: repo("web"), team: { checks } }],
    teams: { workspaceDir: join(root, "teams"), lineup },
  };
  const realManager = options?.realManager ? new Manager(config, key) : undefined;
  type CoordinatorRequest = { requestId: string; prompt: string; continuation?: NativeContinuation };
  const attempts: { sessionId: string; assignment: TeamAssignment; prompt: string; request: CoordinatorRequest }[] = [];
  const reports = new Map<string, { report: MissionReport; note?: string }>();
  const signals = new Map<string, SignalEvent[]>(), transcriptMessages = new Map<string, Event[]>(), usage = new Map<string, Event[]>();
  const attention = new Map<string, Attention>(), stateReads = new Map<string, number>(), sessionStatuses = new Map<string, "running" | "exited">();
  const nativeSessions = new Map<string, { id: string; source: "hook" }>();
  let launchHold: string | undefined;

  const pushSignal = (sessionId: string, data: Signal, source: "hook" | "screen" = "hook", at = new Date()) => {
    const journal = signals.get(sessionId)!;
    const event: SignalEvent = { seq: journal.length + 1, at: at.toISOString(), type: "signal", data: { ...data, source, provider: "claude" } };
    journal.push(event);
    attention.set(sessionId, applySignal(attention.get(sessionId)!, event));
  };
  const pushTranscriptMessage = (sessionId: string, role: "user" | "assistant" | "tool", text: string) => {
    const list = transcriptMessages.get(sessionId) ?? [];
    list.push({ seq: list.length + 1, at: new Date().toISOString(), type: "message", data: { id: randomUUID(), role, text } });
    transcriptMessages.set(sessionId, list);
  };
  const pushUsage = (sessionId: string, contextTokens: number) => {
    const list = usage.get(sessionId) ?? [], at = new Date().toISOString();
    list.push({
      seq: list.length + 1, at, type: "usage",
      data: {
        provider: "claude", providerId: "claude", modelId: "test-model", messageId: randomUUID(), partId: "",
        modelSource: "requested", completedAt: at, tokens: { input: contextTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
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
        id: sessionId, team: assignment, provider: "claude", title: "Mission coordinator", projectId: "api",
        cwd: config.projects[0].path, createdAt: new Date().toISOString(), status: "running", contextVersion: 0, context: "", initialPrompt: "",
      },
      fingerprint: "fixture",
    });
  };
  const defaultEvents = (sessionId: string, cursor: number, limit: number, types?: Set<string>) => {
    if (realManager && (!types || types.has("usage"))) return realManager.events(sessionId, cursor, limit, types);
    if (types?.has("usage")) {
      const events = (usage.get(sessionId) ?? []).filter(event => event.seq > cursor);
      return { events, cursor: events.at(-1)?.seq ?? cursor, more: false };
    }
    if (types?.has("signal") || types?.has("message")) {
      const combined: Event[] = [];
      if (types.has("signal")) for (const event of signals.get(sessionId) ?? []) combined.push(event as unknown as Event);
      if (types.has("message")) for (const event of transcriptMessages.get(sessionId) ?? []) combined.push({ ...event, seq: combined.length + 1000 });
      const events = combined.filter(event => event.seq > cursor);
      return { events, cursor: events.at(-1)?.seq ?? cursor, more: false };
    }
    const filed = reports.get(sessionId), current = attempts.find(item => item.sessionId === sessionId)!;
    if (!filed || cursor > 0) return { events: [], cursor, more: false };
    const { runId, memberId, revision } = current.assignment;
    return {
      events: [{ seq: 1, at: new Date().toISOString(), type: "mission-report", data: { requestId: randomUUID(), missionId: runId, memberId, revision, ...filed } }],
      cursor: 1, more: false,
    };
  };
  const manager = {
    async createTeamSession(request: CoordinatorRequest, assignment: TeamAssignment) {
      if (!attempts.some(item => item.sessionId === request.requestId)) {
        attempts.push({ sessionId: request.requestId, assignment, prompt: request.prompt, request });
        signals.set(request.requestId, []); transcriptMessages.set(request.requestId, []);
        attention.set(request.requestId, initialAttention(new Date().toISOString(), true));
        sessionStatuses.set(request.requestId, "running");
        seedSessionMeta(request.requestId, assignment);
        if (options?.emitInitialTurnStart !== false) pushSignal(request.requestId, { kind: "turn-start" });
      }
      return { status: "running" };
    },
    events(sessionId: string, cursor: number, limit: number, types?: Set<string>) {
      const fallback = () => defaultEvents(sessionId, cursor, limit, types);
      return options?.onEvents ? options.onEvents(sessionId, cursor, limit, types, fallback) : fallback();
    },
    meta(sessionId: string) {
      if (launchHold !== undefined && !attempts.some(item => item.sessionId === sessionId)) throw Object.assign(new Error("No such session"), { code: "ENOENT" });
      return {};
    },
    hostLoad: { held: () => launchHold },
    async state(sessionId: string) {
      stateReads.set(sessionId, (stateReads.get(sessionId) ?? 0) + 1);
      return { status: sessionStatuses.get(sessionId) ?? "running", attention: attention.get(sessionId), nativeSession: nativeSessions.get(sessionId) };
    },
    async stopTeamSession(sessionId: string) {
      sessionStatuses.set(sessionId, "exited");
      return { status: "exited", nativeSession: nativeSessions.get(sessionId) };
    },
  };
  const runs = new Map<string, TeamView>();
  const teams = {
    useMissionReservations() {},
    isActiveRun(id: string) { const current = runs.get(id); return Boolean(current && !["cancelled", "ready-for-review", "merged", "no-change"].includes(current.status)); },
    async createForMission(request: CreateTeam, missionId: string) {
      const existing = runs.get(request.requestId);
      if (existing) return structuredClone(existing);
      const created = {
        id: request.requestId, projectId: request.projectId, missionId, title: request.title, status: "implementing",
        revision: 1, decisions: [], tasks: [], members: [], updatedAt: new Date().toISOString(), parallelism: request.parallelism, usage: emptyRollup(),
      } as unknown as TeamView;
      runs.set(request.requestId, created);
      return structuredClone(created);
    },
    get(id: string) { const value = runs.get(id); if (!value) throw new TeamError(404, "team-not-found", "This team does not exist."); return structuredClone(value); },
    list: () => [...runs.values()].map(item => structuredClone(item)),
    async answer(id: string, decisionId: string, body: { text: string }) {
      const target = runs.get(id)!, decision = target.decisions.find(item => item.id === decisionId);
      if (decision) decision.answer = body.text;
      return structuredClone(target);
    },
    async pause(id: string) { const target = runs.get(id)!; target.status = "paused"; return structuredClone(target); },
    async resume(id: string) { const target = runs.get(id)!; target.status = "implementing"; return structuredClone(target); },
    async cancel(id: string) { const target = runs.get(id)!; target.status = "cancelled"; return structuredClone(target); },
    activeForProject: (projectId: string) => [...runs.values()].some(item => item.projectId === projectId && !["cancelled", "ready-for-review", "merged", "no-change"].includes(item.status)),
  };
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = {
    get: id => {
      if (id !== "shop") throw new TeamError(404, "project-group-not-found", "This project does not exist.");
      return {
        id, name: "Shop", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
        repos: [
          { projectId: "api", name: "API", path: config.projects[0].path, checkouts: [{ projectId: "api", name: "API", path: config.projects[0].path, primary: true, teamReady: true }] },
          { projectId: "web", name: "Web", path: config.projects[1].path, checkouts: [{ projectId: "web", name: "Web", path: config.projects[1].path, primary: true, teamReady: true }] },
        ],
      };
    },
  };
  const open = () => { const service = new MissionService(config, key, manager as unknown as Manager, teams as unknown as TeamService, groups); service.start(); return service; };
  let missions = open();
  const attempt = async (n: number) => (await waitFor(async () => attempts[n - 1], value => Boolean(value), 20000))!;
  const parse = (prompt: string, label: string) => JSON.parse(prompt.split("\n").find(line => line.startsWith(label))!.slice(label.length));
  return {
    get missions() { return missions; },
    config, key, runs, attempt, attempts: () => attempts.length,
    holdLaunches: (reason?: string) => { launchHold = reason; },
    pushSignal: async (n: number, data: Signal, source: "hook" | "screen" = "hook") => pushSignal((await attempt(n)).sessionId, data, source),
    pushTranscriptMessage: async (n: number, role: "user" | "assistant" | "tool", text: string) => pushTranscriptMessage((await attempt(n)).sessionId, role, text),
    pushUsage: async (n: number, tokens: number) => pushUsage((await attempt(n)).sessionId, tokens),
    confirmNative: async (n: number) => {
      const current = await attempt(n), nativeSessionId = current.request.continuation?.nativeSessionId;
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

test("INF-455: observeContext emits redacted bounded warnings on unexpected manager.events failures, deduplicates across ticks, and clears on recovery", { timeout: 60000 }, async () => {
  let failingSessionId: string | undefined;
  let failureError: Error | undefined;
  let usageReads = 0;
  const warnings: string[] = [];
  const warnMock = mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(arg => String(arg)).join(" ")); });
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
    assert.match(warnings[0], /\(EIO\)/);
    assert.doesNotMatch(warnings[0], /secret-line|disk read failed|\n/);

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

    failureError = Object.assign(new Error("EACCES: permission denied, open '/private/state/sessions/meta.sealed'"), { code: "EACCES" });
    await h.missions.pause(id, { requestId: randomUUID(), revision: held3.revision });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "stopped");
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.missions.get(id).revision });
    const held4 = await until(() => h.missions.get(id), mission => mission.reason === "Waiting for host capacity: memory is low");
    assert.equal(usageReads, 4);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /\(EACCES\)/);
    assert.doesNotMatch(warnings[1], /\/private\/state|meta\.sealed|permission denied/);

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

test("INF-455: real Manager missing-session ENOENT stays quiet while corrupted session journal emits a redacted category warning", { timeout: 60000 }, async () => {
  const warnings: string[] = [];
  const warnMock = mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(arg => String(arg)).join(" ")); });
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
      provider: "claude", providerId: "claude", modelId: "test-model", messageId: randomUUID(), partId: "",
      modelSource: "requested", completedAt: new Date().toISOString(), tokens: { input: 50000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
    });
    writeFileSync(join(h.config.stateDir, "sessions", second.sessionId, "events", "0000000000.journal"), "SECRET_CORRUPT_PAYLOAD_DO_NOT_LEAK\n");
    await h.report(2, { kind: "wait", summary: "Waiting for updates" });
    await until(() => h.missions.get(id), mission => mission.coordinator?.status === "waiting" && mission.events.some(event => /waiting for subteam progress/.test(event.text)));

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.missions.get(id).revision, text: "Check corrupted journal" });
    const third = await h.attempt(3);
    assert.equal(third.request.continuation?.mode, "resume");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\(invalid-json\)/);
    assert.doesNotMatch(warnings[0], /SECRET_CORRUPT_PAYLOAD_DO_NOT_LEAK/);
  } finally {
    warnMock.mock.restore();
    h.close();
  }
});

test("INF-458: pause after confirmed delivery to a resumable native session suppresses duplicate inbox and note redelivery on resume", { timeout: 60000 }, async () => {
  const h = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await h.missions.create(missionRequest(240));
    const first = await h.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await h.confirmNative(1);
    await h.report(1, { kind: "dispatch", summary: "Start API work", subtasks: [plan("a", "api")] });
    const started = await until(() => h.get(id), mission => Boolean(mission.subtasks.find(item => item.id === "a")?.teamId));
    const teamId = started.subtasks[0].teamId!, childDecisionId = randomUUID();
    h.set(teamId, {
      status: "needs-input",
      decisions: [{ id: childDecisionId, memberId: randomUUID(), revision: 1, question: "Use JSON or NDJSON?", options: ["JSON", "NDJSON"], createdAt: new Date().toISOString() }],
    });
    const second = await h.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await h.confirmNative(2);
    await h.report(2, {
      kind: "question", question: "Use JSON or NDJSON?", options: ["JSON", "NDJSON"], subtaskId: "a", childDecisionId,
      recommendation: { answers: ["JSON"], reason: "Existing clients parse JSON." },
    });
    const asked = await until(() => h.get(id), mission => mission.status === "needs-input" && mission.coordinator?.status === "waiting");

    await h.missions.answer(id, asked.decisions[0].id, { requestId: randomUUID(), revision: asked.revision, text: "JSON" });
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Focus on API error codes" });
    const third = await h.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await confirmDurableDelivery(h, 3);

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

test("INF-458: turn-start alone and truncated >50-page scans are uncertain, rotate to a fresh conversation, and restore messages without loss", { timeout: 60000 }, async () => {
  const turnStartOnly = scriptedMissionHarness();
  try {
    const { id } = await turnStartOnly.missions.create(missionRequest(240));
    const first = await turnStartOnly.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await turnStartOnly.confirmNative(1);
    await turnStartOnly.report(1, followUp(120));
    await until(() => turnStartOnly.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    await turnStartOnly.missions.steer(id, { requestId: randomUUID(), revision: turnStartOnly.get(id).revision, text: "Must not drop on turn-start pause" });
    const second = await turnStartOnly.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await turnStartOnly.confirmNative(2);
    await turnStartOnly.missions.pause(id, { requestId: randomUUID(), revision: turnStartOnly.get(id).revision });
    await until(() => turnStartOnly.get(id), mission => mission.coordinator?.status === "stopped");

    await turnStartOnly.missions.resume(id, { requestId: randomUUID(), revision: turnStartOnly.get(id).revision });
    const third = await turnStartOnly.attempt(3);
    assert.equal(third.request.continuation?.mode, "start");
    assert.notEqual(third.request.continuation?.nativeSessionId, nativeId);
    const thirdMessages = await turnStartOnly.messages(3) as PromptMessage[];
    assert.deepEqual(
      thirdMessages.filter(message => message.type === "owner-direction").map(message => message.text),
      ["Must not drop on turn-start pause"],
    );
  } finally {
    turnStartOnly.close();
  }

  let pagedSessionId: string | undefined;
  let pagesServed = 0;
  const paged = customCoordinatorHarness({
    emitInitialTurnStart: false,
    onEvents: (sessionId, after, _limit, types, fallback) => {
      if (sessionId === pagedSessionId && (types?.has("signal") || types?.has("message"))) {
        pagesServed += 1;
        return {
          events: [{ seq: after + 1, at: new Date().toISOString(), type: "signal", data: { kind: "notice", type: "heartbeat", source: "hook", provider: "claude" } }],
          cursor: after + 1,
          more: true,
        };
      }
      return fallback();
    },
  });
  try {
    const { id } = await paged.missions.create(missionRequest(240));
    const first = await paged.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await paged.confirmNative(1);
    await paged.report(1, followUp(120));
    await until(() => paged.missions.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    await paged.missions.steer(id, { requestId: randomUUID(), revision: paged.missions.get(id).revision, text: "Preserve when scan hits page cap" });
    const second = await paged.attempt(2);
    pagedSessionId = second.sessionId;
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await paged.confirmNative(2);
    await paged.missions.pause(id, { requestId: randomUUID(), revision: paged.missions.get(id).revision });
    await until(() => paged.missions.get(id), mission => mission.coordinator?.status === "stopped");
    assert.equal(pagesServed, 50);

    await paged.missions.resume(id, { requestId: randomUUID(), revision: paged.missions.get(id).revision });
    const third = await paged.attempt(3);
    assert.equal(third.request.continuation?.mode, "start");
    assert.notEqual(third.request.continuation?.nativeSessionId, nativeId);
    const thirdMessages = await paged.messages(3);
    assert.deepEqual(
      thirdMessages.filter(message => message.type === "owner-direction").map(message => message.text),
      ["Preserve when scan hits page cap"],
    );
  } finally {
    paged.close();
  }
});

test("INF-458: quoted attempt header in prior history does not spoof delivery, exact transcript prompt deduplicates, and refused report keeps saved batch for rotation", { timeout: 60000 }, async () => {
  const quoted = customCoordinatorHarness({ emitInitialTurnStart: false });
  try {
    const { id } = await quoted.missions.create(missionRequest(240, "Quoted text: This is coordinator attempt 2. This is coordinator attempt 2, continuing the same mission conversation."));
    const first = await quoted.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await quoted.confirmNative(1);
    await quoted.pushTranscriptMessage(1, "user", first.prompt);
    await quoted.report(1, followUp(120));
    await until(() => quoted.missions.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    await quoted.missions.steer(id, { requestId: randomUUID(), revision: quoted.missions.get(id).revision, text: "Must not be spoofed by quoted header" });
    const second = await quoted.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await quoted.confirmNative(2);
    await quoted.pushTranscriptMessage(2, "user", first.prompt);
    await quoted.pushSignal(2, { kind: "notice", type: "session_end", message: "stopped" });
    await quoted.missions.pause(id, { requestId: randomUUID(), revision: quoted.missions.get(id).revision });
    await until(() => quoted.missions.get(id), mission => mission.coordinator?.status === "stopped");

    await quoted.missions.resume(id, { requestId: randomUUID(), revision: quoted.missions.get(id).revision });
    const third = await quoted.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    assert.equal((await quoted.messages(3)).filter(message => message.type === "owner-direction" && message.text === "Must not be spoofed by quoted header").length, 1);

    await quoted.confirmNative(3);
    await quoted.pushTranscriptMessage(3, "user", third.prompt);
    await quoted.missions.pause(id, { requestId: randomUUID(), revision: quoted.missions.get(id).revision });
    await until(() => quoted.missions.get(id), mission => mission.coordinator?.status === "stopped");

    await quoted.missions.resume(id, { requestId: randomUUID(), revision: quoted.missions.get(id).revision });
    const fourth = await quoted.attempt(4);
    assert.deepEqual([fourth.request.continuation?.mode, fourth.request.continuation?.nativeSessionId], ["resume", nativeId]);
    assert.equal((await quoted.messages(4)).filter(message => message.type === "owner-direction" && message.text === "Must not be spoofed by quoted header").length, 0);
  } finally {
    quoted.close();
  }

  const refusedThenRotate = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await refusedThenRotate.missions.create(missionRequest(240));
    const first = await refusedThenRotate.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await refusedThenRotate.confirmNative(1);
    await refusedThenRotate.report(1, { kind: "dispatch", summary: "Run API subtask", subtasks: [plan("a", "api")] });
    await until(() => refusedThenRotate.get(id), mission => Boolean(mission.subtasks.find(item => item.id === "a")?.teamId));

    await refusedThenRotate.missions.steer(id, { requestId: randomUUID(), revision: refusedThenRotate.get(id).revision, text: "Keep batch across refused report" });
    const second = await refusedThenRotate.attempt(2);
    assert.deepEqual([second.request.continuation?.mode, second.request.continuation?.nativeSessionId], ["resume", nativeId]);
    await confirmDurableDelivery(refusedThenRotate, 2);
    await refusedThenRotate.missions.pause(id, { requestId: randomUUID(), revision: refusedThenRotate.get(id).revision });
    await until(() => refusedThenRotate.get(id), mission => mission.coordinator?.status === "stopped");

    await refusedThenRotate.missions.resume(id, { requestId: randomUUID(), revision: refusedThenRotate.get(id).revision });
    const third = await refusedThenRotate.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    assert.equal((await refusedThenRotate.messages(3) as PromptMessage[]).filter(message => message.type === "owner-direction").length, 0);
    await refusedThenRotate.confirmNative(3);
    await refusedThenRotate.usage(3, 130000);
    await refusedThenRotate.report(3, { kind: "result", summary: "Premature result while subtask a runs" });

    const fourth = await refusedThenRotate.attempt(4);
    assert.equal(fourth.request.continuation?.mode, "start");
    assert.notEqual(fourth.request.continuation?.nativeSessionId, nativeId);
    const fourthMessages = await refusedThenRotate.messages(4) as PromptMessage[];
    assert.equal(fourthMessages.filter(message => message.type === "owner-direction" && message.text === "Keep batch across refused report").length, 1);
  } finally {
    refusedThenRotate.close();
    mock.timers.reset();
  }
});

test("INF-458: durable restart preserves deduplication on resume, deadline extension, idle rotation, and resume-failure fallback", { timeout: 60000 }, async () => {
  const resumeRestart = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await resumeRestart.missions.create(missionRequest(240));
    const first = await resumeRestart.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await resumeRestart.confirmNative(1);
    await resumeRestart.report(1, followUp(10, "Check release artifacts"));
    await until(() => resumeRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    mock.timers.tick(10 * 60000);
    await resumeRestart.attempt(2);
    await confirmDurableDelivery(resumeRestart, 2);
    await resumeRestart.missions.pause(id, { requestId: randomUUID(), revision: resumeRestart.get(id).revision });
    await until(() => resumeRestart.get(id), mission => mission.coordinator?.status === "stopped");

    await resumeRestart.restart();
    mock.timers.tick(5 * 60000);
    await resumeRestart.missions.resume(id, { requestId: randomUUID(), revision: resumeRestart.get(id).revision });
    const third = await resumeRestart.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    assert.equal((await resumeRestart.messages(3) as PromptMessage[]).filter(message => message.type === "follow-up").length, 0);

    await resumeRestart.exitWithoutNative(3);
    const fourth = await resumeRestart.attempt(4);
    assert.equal(fourth.request.continuation?.mode, "start");
    assert.notEqual(fourth.request.continuation?.nativeSessionId, nativeId);
    assert.equal((await resumeRestart.messages(4) as PromptMessage[]).filter(message => message.type === "follow-up" && message.reason === "Check release artifacts").length, 1);
    await resumeRestart.report(4, followUp(30, "Follow up settled"));
    await until(() => resumeRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);
    assert.equal((resumeRestart.stored(id) as unknown as { deliveredUnapplied?: unknown }).deliveredUnapplied, undefined);
  } finally {
    resumeRestart.close();
    mock.timers.reset();
  }

  const deadlineRestart = scriptedMissionHarness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T09:00:00Z") });
  try {
    const { id } = await deadlineRestart.missions.create(missionRequest(10));
    const first = await deadlineRestart.attempt(1), nativeId = first.request.continuation?.nativeSessionId;
    await deadlineRestart.confirmNative(1);
    await deadlineRestart.report(1, followUp(5, "Recheck build"));
    await until(() => deadlineRestart.get(id), mission => mission.coordinator?.status === "waiting" && openFollowUpCount(mission) === 1);

    mock.timers.tick(5 * 60000);
    await deadlineRestart.attempt(2);
    await confirmDurableDelivery(deadlineRestart, 2);
    mock.timers.tick(6 * 60000);
    const blocked = await until(() => deadlineRestart.get(id), mission => mission.status === "blocked" && mission.stopReason === "deadline" && mission.coordinator?.status === "stopped");

    await deadlineRestart.restart();
    await deadlineRestart.missions.extend(id, { requestId: randomUUID(), revision: blocked.revision, minutes: 30 });
    const third = await deadlineRestart.attempt(3);
    assert.deepEqual([third.request.continuation?.mode, third.request.continuation?.nativeSessionId], ["resume", nativeId]);
    const thirdMessages = await deadlineRestart.messages(3) as PromptMessage[];
    assert.equal(thirdMessages.filter(message => message.type === "follow-up").length, 0);
    assert.equal(thirdMessages.filter(message => message.type === "resumed").length, 1);
  } finally {
    deadlineRestart.close();
    mock.timers.reset();
  }
});

type SimMutant =
  | "none"
  | "mutant-suppress-on-turn-start"
  | "mutant-clear-delivered-on-refused-report"
  | "mutant-blind-return-on-confirmed-pause"
  | "mutant-resume-uncertain-native";

type SimAttempt = ConsumedAttempt & { status: "running" | "stopped"; rotated?: true };
type SimStored = MissionQueueState & { attempts: SimAttempt[] };

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runCoordinatorSimulator(seed: number, steps: number, mutant: SimMutant) {
  const rand = mulberry32(seed);
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-sim-"));
  const key = randomBytes(32), file = join(root, "mission.sealed"), scope = "mission:sim";
  const tag = (msg: MissionMessage) => (msg.type === "owner-direction" ? msg.text : msg.type === "owner-answer" ? msg.answer : msg.type);
  const mkPrompt = (revision: number, msgs: MissionMessage[]) =>
    `Connector requests and input are delegated agent content.\n\nThis is coordinator attempt ${revision}, continuing.\n\nMessages: ${JSON.stringify(msgs)}`;
  let stored: SimStored = { inbox: [], notes: [], attempts: [] };
  const reloadFromDisk = () => {
    writeSealed(file, key, scope, stored);
    stored = unseal<SimStored>(key, scope, readFileSync(file, "utf8"));
  };
  let nextSeq = 1, active: SimAttempt | undefined;
  let unsettledInbox: string[] = [], unsettledNotes: string[] = [];
  const confirmedByNative = new Map<string, Set<string>>();
  const retiredNative = new Set<string>();
  const stats = { deliverPause: 0, uncertain: 0, preDelivery: 0, failResume: 0, refuseWithDelivered: 0, acceptWithDelivered: 0, rotateWithDelivered: 0, reload: 0 };
  const ctx = (step: number, op: string) => `seed=0x${seed.toString(16)} mutant=${mutant} step=${step} op=${op}`;
  const assertConservation = (step: number, op: string) => {
    const activeInbox = active?.consumedInbox?.map(tag) ?? [];
    const activeNotes = active?.consumedNotes?.map(tag) ?? [];
    const deliveredInbox = (stored.deliveredUnapplied ?? []).flatMap(batch => batch.inbox.map(tag));
    const deliveredNotes = (stored.deliveredUnapplied ?? []).flatMap(batch => batch.notes.map(tag));
    const actualInbox = [...deliveredInbox, ...activeInbox, ...stored.inbox.map(tag)];
    const actualNotes = [...deliveredNotes, ...activeNotes, ...stored.notes.map(tag)];
    assert.deepEqual(actualInbox, unsettledInbox, `inbox conservation violated (${ctx(step, op)})`);
    assert.deepEqual(actualNotes, unsettledNotes, `notes conservation violated (${ctx(step, op)})`);
  };
  try {
    for (let step = 0; step < steps; step++) {
      if (!active) {
        const hasSaved = Boolean(stored.deliveredUnapplied?.length);
        const enqueueNew = !stored.inbox.length ? (!hasSaved || rand() < 0.75) : rand() < 0.25;
        if (enqueueNew) {
          const id = `i${nextSeq++}`;
          stored.inbox.push({ type: "owner-direction", text: id });
          unsettledInbox.push(id);
          if (rand() < 0.5) {
            const nid = `n${nextSeq++}`;
            stored.notes.push({ type: "owner-answer", decisionId: randomUUID(), question: "q", answer: nid });
            unsettledNotes.push(nid);
          }
          assertConservation(step, "enqueue");
          continue;
        }
        if (!hasPendingCoordinatorInbox(stored)) continue;
        const forceRotate = rand() < 0.2;
        let continuation: NativeContinuation | undefined;
        if (!forceRotate) {
          for (let index = stored.attempts.length - 1; index >= 0; index--) {
            const prev = stored.attempts[index], nid = prev.continuation?.nativeSessionId;
            const retired = (id: string) => stored.attempts.slice(index).some(item =>
              (item.resumeFailed || (mutant !== "mutant-resume-uncertain-native" && item.deliveryUncertain)) && item.continuation?.nativeSessionId === id);
            if (prev.nativeConfirmed && nid && !retired(nid)) { continuation = { mode: "resume", nativeSessionId: nid }; break; }
            if (prev.rotated) break;
          }
        }
        const rotated = Boolean(forceRotate);
        continuation ??= { mode: "start", nativeSessionId: `nat-${nextSeq++}` };
        if (continuation.mode === "start" && stored.deliveredUnapplied?.length) stats.rotateWithDelivered++;
        reconcileDeliveredUnapplied(stored, continuation.mode === "resume" ? continuation.nativeSessionId : undefined);
        if (!stored.inbox.length) { assertConservation(step, "wake-empty"); continue; }
        if (continuation.mode === "resume") {
          assert.equal(retiredNative.has(continuation.nativeSessionId), false, `resumed retired native session (${ctx(step, "wake")})`);
          const seen = confirmedByNative.get(continuation.nativeSessionId) ?? new Set<string>();
          for (const batch of stored.deliveredUnapplied ?? []) {
            if (batch.nativeSessionId !== continuation.nativeSessionId) continue;
            for (const msg of [...batch.inbox, ...batch.notes]) {
              assert.equal(seen.has(tag(msg)), true, `suppressed unconfirmed message ${tag(msg)} on resume (${ctx(step, "wake")})`);
            }
          }
          for (const msg of [...stored.inbox, ...stored.notes]) {
            assert.equal(seen.has(tag(msg)), false, `duplicate redelivery of ${tag(msg)} (${ctx(step, "wake")})`);
          }
        } else {
          assert.deepEqual(stored.inbox.map(tag), unsettledInbox, `fresh conversation missed unsettled inbox (${ctx(step, "wake")})`);
          assert.deepEqual(stored.notes.map(tag), unsettledNotes, `fresh conversation missed unsettled notes (${ctx(step, "wake")})`);
        }
        const takeInbox = stored.inbox.splice(0, Math.min(3, stored.inbox.length));
        const takeNotes = stored.notes.splice(0, Math.min(2, stored.notes.length));
        const revision = stored.attempts.length + 1;
        active = {
          sessionId: `sess-${revision}`, revision, prompt: mkPrompt(revision, [...takeInbox, ...takeNotes]),
          continuation, status: "running", ...(rotated ? { rotated: true } : {}), consumedInbox: takeInbox, consumedNotes: takeNotes,
        };
        stored.attempts.push(active);
        assertConservation(step, "wake");
        continue;
      }

      const roll = rand();
      if (roll < 0.08) {
        const id = `i${nextSeq++}`;
        stored.inbox.push({ type: "owner-direction", text: id });
        unsettledInbox.push(id);
        assertConservation(step, "enqueue-mid-attempt");
      } else if (roll < 0.18) {
        reloadFromDisk();
        stats.reload++;
        active = stored.attempts.at(-1)!;
        assertConservation(step, "reload");
      } else if (roll < 0.40) {
        active.nativeConfirmed = true;
        active.status = "stopped";
        const nativeId = active.continuation!.nativeSessionId;
        const confirmedItems = [...(active.consumedInbox ?? []), ...(active.consumedNotes ?? [])].map(tag);
        const mode = rand() < 0.5 ? "transcript" : "tool";
        const events: Event[] = mode === "transcript"
          ? [{ seq: 1, at: new Date().toISOString(), type: "message", data: { id: "u1", role: "user", text: active.prompt } }]
          : [{ seq: 1, at: new Date().toISOString(), type: "signal", data: { kind: "tool-start", source: "hook", provider: "claude" } }];
        if (mutant === "mutant-blind-return-on-confirmed-pause") {
          returnConsumedMessages(stored, active);
        } else {
          const outcome = settleUnappliedConsumed(stored, active, () => ({ events, cursor: 1, more: false }));
          assert.equal(outcome.kind, "confirmed", `expected confirmed (${ctx(step, "deliver-pause")})`);
        }
        const seen = confirmedByNative.get(nativeId) ?? new Set<string>();
        for (const item of confirmedItems) seen.add(item);
        confirmedByNative.set(nativeId, seen);
        stats.deliverPause++;
        active = undefined;
        assertConservation(step, "deliver-pause");
      } else if (roll < 0.54) {
        active.nativeConfirmed = true;
        active.status = "stopped";
        const nativeId = active.continuation!.nativeSessionId;
        const uncertainKind = rand();
        const reader = uncertainKind < 0.4
          ? () => ({ events: [{ seq: 1, at: new Date().toISOString(), type: "signal" as const, data: { kind: "turn-start", source: "hook", provider: "claude" } }], cursor: 1, more: false })
          : uncertainKind < 0.7
            ? () => { throw new Error("read failed"); }
            : (_id: string, after: number) => ({ events: [], cursor: after + 1, more: true });
        if (mutant === "mutant-suppress-on-turn-start") {
          assert.equal(classifyAttemptDelivery(active, reader).kind, "uncertain", `mutant precondition (${ctx(step, "uncertain")})`);
          const inbox = active.consumedInbox ?? [], notes = active.consumedNotes ?? [];
          (stored.deliveredUnapplied ??= []).push({ nativeSessionId: nativeId, inbox: [...inbox], notes: [...notes] });
          delete active.consumedInbox;
          delete active.consumedNotes;
        } else {
          const outcome = settleUnappliedConsumed(stored, active, reader);
          assert.equal(outcome.kind, "uncertain", `expected uncertain (${ctx(step, "uncertain")})`);
          retiredNative.add(nativeId);
        }
        stats.uncertain++;
        active = undefined;
        assertConservation(step, "uncertain-delivery");
      } else if (roll < 0.65) {
        active.nativeConfirmed = true;
        active.status = "stopped";
        const outcome = settleUnappliedConsumed(stored, active, () => ({
          events: [{ seq: 1, at: new Date().toISOString(), type: "signal", data: { kind: "notice", type: "session_end", source: "hook", provider: "claude" } }],
          cursor: 1, more: false,
        }));
        assert.equal(outcome.kind, "not-delivered", `expected not-delivered (${ctx(step, "pre-delivery-pause")})`);
        stats.preDelivery++;
        active = undefined;
        assertConservation(step, "pre-delivery-pause");
      } else if (roll < 0.75 && active.continuation?.mode === "resume") {
        active.resumeFailed = true;
        active.status = "stopped";
        retiredNative.add(active.continuation.nativeSessionId);
        returnConsumedMessages(stored, active);
        stats.failResume++;
        active = undefined;
        assertConservation(step, "fail-resume");
      } else if (roll < 0.88) {
        active.nativeConfirmed = true;
        active.status = "stopped";
        if (stored.deliveredUnapplied?.length) stats.refuseWithDelivered++;
        const consumedIn = new Set((active.consumedInbox ?? []).map(tag));
        const consumedNo = new Set((active.consumedNotes ?? []).map(tag));
        unsettledInbox = unsettledInbox.filter(item => !consumedIn.has(item));
        unsettledNotes = unsettledNotes.filter(item => !consumedNo.has(item));
        delete active.consumedInbox;
        delete active.consumedNotes;
        if (mutant === "mutant-clear-delivered-on-refused-report") delete stored.deliveredUnapplied;
        active = undefined;
        assertConservation(step, "refuse-report");
      } else {
        active.nativeConfirmed = true;
        active.status = "stopped";
        if (stored.deliveredUnapplied?.length) stats.acceptWithDelivered++;
        const settledIn = new Set([...(stored.deliveredUnapplied ?? []).flatMap(b => b.inbox.map(tag)), ...(active.consumedInbox ?? []).map(tag)]);
        const settledNo = new Set([...(stored.deliveredUnapplied ?? []).flatMap(b => b.notes.map(tag)), ...(active.consumedNotes ?? []).map(tag)]);
        unsettledInbox = unsettledInbox.filter(item => !settledIn.has(item));
        unsettledNotes = unsettledNotes.filter(item => !settledNo.has(item));
        delete stored.deliveredUnapplied;
        delete active.consumedInbox;
        delete active.consumedNotes;
        active = undefined;
        assertConservation(step, "accept-report");
      }
    }
    reloadFromDisk();
    if (active) active = stored.attempts.at(-1)!;
    assertConservation(steps, "final-reload");
    return stats;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("INF-458: seeded durable-state simulator enforces conservation, ordering, zero-duplicate resume, and catches named broken mutants", t => {
  const baseSeed = Number(process.env.MISSION_SIM_SEED ?? 0x51a7c3f1) >>> 0;
  t.diagnostic(`mission-coordinator simulator baseSeed=0x${baseSeed.toString(16)}`);
  const totals = { deliverPause: 0, uncertain: 0, preDelivery: 0, failResume: 0, refuseWithDelivered: 0, acceptWithDelivered: 0, rotateWithDelivered: 0, reload: 0 };
  for (let offset = 0; offset < 4; offset++) {
    const run = runCoordinatorSimulator((baseSeed + offset) >>> 0, 180, "none");
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += run[key];
  }
  for (const [key, count] of Object.entries(totals)) {
    assert.ok(count > 0, `simulator did not exercise ${key} (baseSeed=0x${baseSeed.toString(16)})`);
  }
  const mutants: { name: SimMutant; pattern: RegExp }[] = [
    { name: "mutant-suppress-on-turn-start", pattern: /suppressed unconfirmed message/ },
    { name: "mutant-clear-delivered-on-refused-report", pattern: /conservation violated/ },
    { name: "mutant-blind-return-on-confirmed-pause", pattern: /duplicate redelivery/ },
    { name: "mutant-resume-uncertain-native", pattern: /resumed retired native session/ },
  ];
  for (const { name, pattern } of mutants) {
    assert.throws(
      () => runCoordinatorSimulator(baseSeed, 240, name),
      pattern,
      `simulator failed to catch ${name} (seed=0x${baseSeed.toString(16)})`,
    );
  }
});
