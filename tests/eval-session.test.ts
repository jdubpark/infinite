import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attention } from "@infinite/attention";
import { CLAUDE_CODE_MODE_ENV } from "../packages/host/src/code-mode.js";
import { hashToken } from "../packages/host/src/config.js";
import { readDecisionQueue } from "../packages/host/src/decision-queue-read.js";
import { installHostEgress, sessionEgressIdentity } from "../packages/host/src/egress.js";
import type { FuseGate, FuseLaunch } from "../packages/host/src/fuse/types.js";
import { sessionGithubScopeFor } from "../packages/host/src/github-grants.js";
import { sessionAgentProfile, withoutSharedContext } from "../packages/host/src/launch.js";
import { Manager } from "../packages/host/src/manager.js";
import { Notifier } from "../packages/host/src/notifier.js";
import { ProjectContexts } from "../packages/host/src/project-context.js";
import { PushStore } from "../packages/host/src/push.js";
import { createApp } from "../packages/host/src/server.js";
import { TeamService } from "../packages/host/src/teams.js";
import type { TeamAssignment } from "../packages/host/src/team-types.js";
import type { Config, ExecutionIdentity, SessionPurpose } from "../packages/host/src/types.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { stopSessionWorkers } from "./helpers.js";

type Mark = { label: string; codeMode: string | null; proxyProject: string | null };

function rig(options: { eval?: boolean; codeMode?: "off" | "headless" | "all"; egressKeyPath?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-session-")));
  const project = join(root, "project"), workspaceDir = join(root, "teams"), cwd = join(workspaceDir, "run");
  const stateDir = join(root, "state"), marks = join(root, "marks.jsonl");
  const runDir = join(root, "run"), socketDir = mkdtempSync(join(tmpdir(), "es-"));
  for (const dir of [project, cwd, stateDir]) mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, [
    "import { appendFileSync } from \"node:fs\";",
    "const proxy = process.env.HTTPS_PROXY;",
    "let proxyProject = null;",
    "if (proxy) { try { proxyProject = decodeURIComponent(new URL(proxy).username).split(\".\")[0] ?? null; } catch {} }",
    `appendFileSync(process.argv[2], JSON.stringify({ label: process.argv[3], codeMode: process.env[${JSON.stringify(CLAUDE_CODE_MODE_ENV)}] ?? null, proxyProject }) + "\\n");`,
  ].join("\n") + "\n");
  const profile = (label: string) => ({ command: process.execPath, args: [agent, marks, label] });
  const config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir, runDir, socketDir, environment: "local", enableDemo: false, maxSessions: 16,
    agents: { claude: profile("production") },
    projects: [{ id: "fixture", name: "Fixture", path: project }],
    teams: { workspaceDir },
    tokens: [],
    ...(options.codeMode ? { codeMode: { claude: options.codeMode } } : {}),
    ...(options.egressKeyPath ? { autonomy: { boundary: { egress: { proxyUrl: "http://127.0.0.1:4199", keyPath: options.egressKeyPath } } } } : {}),
    attention: { hooks: { claude: false, codex: false }, idleAfterMs: 3000, limitConfirmMs: 30000 },
    ...(options.eval ? { eval: { member: { prefix: { command: "true", args: [] }, root, agents: { claude: profile("eval") } } } } : {}),
  } as unknown as Config;
  const manager = new Manager(config, key);
  const admitted: FuseLaunch[] = [];
  const fuse = {
    check: () => ({ state: "closed" }) as never,
    admit: (launch: FuseLaunch) => { admitted.push(launch); return { ok: true as const, launchId: launch.launchId }; },
    release() {}, started() {},
  } satisfies FuseGate;
  manager.useFuse(fuse);
  const readMarks = (): Mark[] => existsSync(marks) ? readFileSync(marks, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Mark) : [];
  return {
    root, config, key, manager, cwd, admitted, stateDir,
    marks: readMarks,
    labels: () => readMarks().map(mark => mark.label),
    close: async () => {
      await stopSessionWorkers(config);
      await new Promise(done => setTimeout(done, 1000));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
type Rig = ReturnType<typeof rig>;

async function launch(r: Rig, header: { purpose?: SessionPurpose; executionIdentity?: ExecutionIdentity }) {
  const id = randomUUID();
  const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" };
  const session = await r.manager.createTeamSession(
    { requestId: id, provider: "claude", projectId: "fixture", title: `${header.purpose ?? "none"} ${header.executionIdentity ?? "default"}`, prompt: "Say hello" },
    team, r.cwd, undefined, join(r.cwd, ".."), true, header,
  );
  return { id, session };
}

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the agent log");
    await new Promise(done => setTimeout(done, 50));
  }
}

const att = (state: Attention["state"], promptId?: number): Attention => ({
  state, since: "t", source: "hook", now: state === "needs-you" ? "Do you want to proceed?" : "Finished a turn",
  prompt: promptId ? { id: promptId, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook" } : undefined,
  lastActivityAt: "t", hooks: "active", hookErrors: 0, sawTurnEnd: false,
});

test("executionIdentity routes production duel challengers to production while isolating eval runs", { timeout: 120_000 }, async () => {
  const r = rig({ eval: true });
  try {
    const replay = await launch(r, { purpose: "replay", executionIdentity: "eval" });
    await until(() => r.labels().length === 1);
    const evalDuel = await launch(r, { purpose: "duel", executionIdentity: "eval" });
    await until(() => r.labels().length === 2);
    const prodChallenger = await launch(r, { purpose: "duel", executionIdentity: "production" });
    await until(() => r.labels().length === 3);
    const work = await launch(r, { purpose: "work", executionIdentity: "production" });
    await until(() => r.labels().length === 4);

    assert.deepEqual(r.labels(), ["eval", "eval", "production", "production"]);
    assert.equal(r.manager.meta(replay.id).session.executionIdentity, "eval");
    assert.equal(r.manager.meta(evalDuel.id).session.executionIdentity, "eval");
    assert.equal(r.manager.meta(prodChallenger.id).session.executionIdentity, "production");
    assert.equal(r.manager.meta(prodChallenger.id).session.purpose, "duel");
    assert.equal(r.manager.meta(work.id).session.executionIdentity, "production");

    assert.equal(r.admitted.find(item => item.launchId === replay.id)?.purpose, "replay");
    assert.equal(r.admitted.find(item => item.launchId === evalDuel.id)?.purpose, "duel");
    assert.equal(r.admitted.find(item => item.launchId === prodChallenger.id)?.purpose, "duel");
    assert.equal(r.admitted.find(item => item.launchId === work.id)?.purpose, "work");
  } finally {
    await r.close();
  }

  const bare = rig({});
  try {
    const challenger = await launch(bare, { purpose: "duel", executionIdentity: "production" });
    await until(() => bare.labels().length === 1);
    assert.deepEqual(bare.labels(), ["production"]);
    assert.equal(bare.manager.meta(challenger.id).session.executionIdentity, "production");
    assert.equal(bare.manager.meta(challenger.id).session.purpose, "duel");

    for (const evalHeader of [
      { purpose: "replay" as const, executionIdentity: "eval" as const },
      { purpose: "replay" as const },
      { purpose: "gate" as const },
      { purpose: "duel" as const, executionIdentity: "eval" as const },
    ]) {
      const id = randomUUID();
      const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" };
      await assert.rejects(
        bare.manager.createTeamSession({ requestId: id, provider: "claude", projectId: "fixture", title: "Eval", prompt: "Say hello" },
          team, bare.cwd, undefined, join(bare.cwd, ".."), true, evalHeader),
        (error: { status?: number; code?: string }) => error.status === 409 && error.code === "eval-identity-missing",
      );
      assert.equal(existsSync(join(bare.stateDir, "sessions", id)), false);
    }
    assert.deepEqual(bare.labels(), ["production"]);
  } finally {
    await bare.close();
  }
});

test("shared context, Code Mode, egress identity, and GitHub grants follow executionIdentity rather than purpose", { timeout: 120_000 }, async () => {
  const egressDir = mkdtempSync(join(tmpdir(), "eval-session-egress-"));
  const keyPath = join(egressDir, "egress.key");
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const r = rig({ eval: true, codeMode: "all", egressKeyPath: keyPath });
  installHostEgress(r.config);
  try {
    new ProjectContexts(r.config, r.key).setContext("fixture", "Owner rule: keep the release notes current", 0);
    const evalReplay = await launch(r, { purpose: "replay", executionIdentity: "eval" });
    await until(() => r.marks().length === 1);
    const evalJudge = await launch(r, { purpose: "duel", executionIdentity: "eval" });
    await until(() => r.marks().length === 2);
    const prodChallenger = await launch(r, { purpose: "duel", executionIdentity: "production" });
    await until(() => r.marks().length === 3);
    const prodWork = await launch(r, { purpose: "work", executionIdentity: "production" });
    await until(() => r.marks().length === 4);

    const marks = r.marks();
    assert.deepEqual(marks, [
      { label: "eval", codeMode: null, proxyProject: "_eval" },
      { label: "eval", codeMode: null, proxyProject: "_eval" },
      { label: "production", codeMode: "1", proxyProject: "fixture" },
      { label: "production", codeMode: "1", proxyProject: "fixture" },
    ]);

    for (const id of [evalReplay.id, evalJudge.id]) {
      const session = r.manager.meta(id).session;
      assert.equal(session.context, "");
      assert.deepEqual(session.contextSources, []);
      assert.equal(session.codeMode, false);
      assert.equal(session.executionIdentity, "eval");
    }
    for (const id of [prodChallenger.id, prodWork.id]) {
      const session = r.manager.meta(id).session;
      assert.match(session.context ?? "", /Owner rule: keep the release notes current/);
      assert.ok((session.contextSources ?? []).length > 0);
      assert.equal(session.codeMode, true);
      assert.equal(session.executionIdentity, "production");
    }

    const teamScope = { sub: "team:implementer", repo: "example/app", ops: ["fetch" as const] };
    assert.deepEqual(sessionGithubScopeFor({ team: true, origin: { team: teamScope }, repository: "example/app", executionIdentity: "production" }), teamScope);
    assert.equal(sessionGithubScopeFor({ team: true, origin: { team: teamScope }, repository: "example/app", executionIdentity: "eval" }), undefined);
    assert.equal(sessionAgentProfile(r.config, "claude", "production"), r.config.agents.claude);
    assert.equal(sessionAgentProfile(r.config, "claude", "eval"), r.config.eval!.member!.agents!.claude);
    assert.deepEqual(withoutSharedContext({ text: "secret", sources: ["a"] }, "eval"), { text: "", sources: [] });
    assert.deepEqual(withoutSharedContext({ text: "secret", sources: ["a"] }, "production"), { text: "secret", sources: ["a"] });
    assert.equal(sessionEgressIdentity("fixture", prodChallenger.id, "production").project, "fixture");
    assert.equal(sessionEgressIdentity("fixture", evalJudge.id, "eval").project, "_eval");
  } finally {
    installHostEgress({});
    await r.close();
    rmSync(egressDir, { recursive: true, force: true });
  }
});

test("executionIdentity is host-owned, strictly validated, and unspoofable across Manager and HTTP", { timeout: 60_000 }, async () => {
  const r = rig({ eval: true });
  const token = randomBytes(32).toString("base64url");
  r.config.tokens = [{ id: "owner", label: "owner", role: "owner", hash: hashToken(token) }];
  const app = createApp(r.config, r.key);
  const server = app.server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  r.config.port = port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" };
    const req = () => ({ requestId: randomUUID(), provider: "claude" as const, projectId: "fixture", title: "Check", prompt: "Say hello" });
    const bad400 = (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400;

    assert.throws(() => r.manager.createTeamSession(req(), team, r.cwd, undefined, join(r.cwd, ".."), true, { purpose: "duel" }), bad400);
    assert.throws(() => r.manager.createTeamSession(req(), team, r.cwd, undefined, join(r.cwd, ".."), true, { purpose: "replay", executionIdentity: "production" }), bad400);
    assert.throws(() => r.manager.createTeamSession(req(), team, r.cwd, undefined, join(r.cwd, ".."), true, { purpose: "gate", executionIdentity: "production" }), bad400);
    assert.throws(() => r.manager.createTeamSession(req(), team, r.cwd, undefined, join(r.cwd, ".."), true, { purpose: "work", executionIdentity: "eval" }), bad400);
    assert.throws(() => r.manager.createTeamSession(req(), team, r.cwd, undefined, join(r.cwd, ".."), true, { executionIdentity: "sandbox" as never }), bad400);
    assert.throws(() => r.manager.create({ ...req(), executionIdentity: "eval" } as never), bad400);
    assert.throws(() => r.manager.create({ ...req(), purpose: "replay" } as never), bad400);

    for (const spoof of [{ executionIdentity: "eval" }, { executionIdentity: "production" }, { purpose: "duel" }, { purpose: "replay" }]) {
      const response = await fetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...req(), ...spoof }),
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { code?: string };
      assert.equal(body.code, "invalid-create");
    }

    const writeRecord = (id: string, extra: Record<string, unknown>) => {
      const dir = join(r.stateDir, "sessions", id);
      mkdirSync(dir, { recursive: true });
      writeSealed(join(dir, "meta.sealed"), r.key, `${id}:meta`, {
        session: {
          id, provider: "claude", title: String(extra.title ?? "Session"), projectId: "fixture", cwd: r.cwd,
          createdAt: "2026-11-26T00:00:00.000Z", status: "exited", contextVersion: 0, context: "", initialPrompt: "",
          ...extra,
        },
        fingerprint: "fixture",
      });
      writeSealed(join(dir, "status.sealed"), r.key, `${id}:status`, {
        status: "exited", seq: 1, screen: "", attention: att("exited"),
      });
    };

    const prodDuelId = randomUUID();
    const evalDuelId = randomUUID();
    const evalReplayId = randomUUID();
    const legacyDuelId = randomUUID();
    const legacyReplayId = randomUUID();
    const legacyWorkId = randomUUID();
    writeRecord(prodDuelId, { title: "Production duel", team, purpose: "duel", executionIdentity: "production" });
    writeRecord(evalDuelId, { title: "Eval judge", team, purpose: "duel", executionIdentity: "eval" });
    writeRecord(evalReplayId, { title: "Eval replay", team, purpose: "replay", executionIdentity: "eval" });
    writeRecord(legacyDuelId, { title: "Legacy judge", team, purpose: "duel" });
    writeRecord(legacyReplayId, { title: "Legacy replay", team, purpose: "replay" });
    writeRecord(legacyWorkId, { title: "Legacy work", team, purpose: "work" });

    const listedResponse = await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(listedResponse.status, 200);
    const listed = ((await listedResponse.json()) as { sessions: { id: string; executionIdentity?: string; purpose?: string }[] }).sessions;
    const listedIds = new Set(listed.map(row => row.id));
    assert.equal(listedIds.has(prodDuelId), true);
    assert.equal(listedIds.has(legacyWorkId), true);
    assert.equal(listedIds.has(evalDuelId), false);
    assert.equal(listedIds.has(evalReplayId), false);
    assert.equal(listedIds.has(legacyDuelId), false);
    assert.equal(listedIds.has(legacyReplayId), false);
    assert.equal(listed.find(row => row.id === prodDuelId)?.executionIdentity, "production");

    await assert.rejects(() => r.manager.remove(prodDuelId), (error: { status?: number }) => error.status === 409);
    await r.manager.remove(evalDuelId);
    await r.manager.remove(evalReplayId);
    await r.manager.remove(legacyDuelId);
    assert.equal(existsSync(join(r.stateDir, "sessions", prodDuelId)), true);
    assert.equal(existsSync(join(r.stateDir, "sessions", evalDuelId)), false);
    assert.equal(existsSync(join(r.stateDir, "sessions", evalReplayId)), false);
    assert.equal(existsSync(join(r.stateDir, "sessions", legacyDuelId)), false);
  } finally {
    app.closeConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await r.close();
  }
});

test("notifier, decision queue, and production provider limits include production duel challengers and exclude eval sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-session-push-"));
  try {
    const store = new PushStore(dir, randomBytes(32));
    store.add("controller", "ExponentPushToken[a]", "android");
    const sent: { to: string; data: { url: string } }[][] = [];
    const rows = [
      { id: "replay-1", title: "Replay trial", provider: "claude" as const, projectId: "fixture", status: "running" as const, purpose: "replay" as const, executionIdentity: "eval" as const, attention: att("working") },
      { id: "judge-1", title: "Eval judge", provider: "claude" as const, projectId: "fixture", status: "running" as const, purpose: "duel" as const, executionIdentity: "eval" as const, attention: att("working") },
      { id: "legacy-judge-1", title: "Legacy judge", provider: "claude" as const, projectId: "fixture", status: "running" as const, purpose: "duel" as const, attention: att("working") },
      { id: "challenger-1", title: "Duel challenger", provider: "claude" as const, projectId: "fixture", status: "running" as const, purpose: "duel" as const, executionIdentity: "production" as const, attention: att("working") },
      { id: "work-1", title: "Retry logic", provider: "claude" as const, projectId: "fixture", status: "running" as const, purpose: "work" as const, executionIdentity: "production" as const, attention: att("working") },
    ];
    const manager = { list: async () => rows } as never;
    const sender = async (messages: { to: string; data: { url: string } }[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
    const notifier = new Notifier(manager, store, sender, { detail: "minimal", events: ["needs-you", "turn-finished", "exited", "recording-error"], intervalMs: 100000 });
    await notifier.tick();
    rows[0].attention = att("needs-you", 7);
    rows[1].attention = att("needs-you", 8);
    rows[2].attention = att("needs-you", 9);
    rows[3].attention = att("needs-you", 10);
    rows[4].attention = att("needs-you", 11);
    await notifier.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].map(message => message.data.url).sort(), ["/session/challenger-1", "/session/work-1"]);

    const queue = await readDecisionQueue({
      manager,
      cmux: undefined,
      permissions: { holder: () => "owner" },
      teams: { decisionQueueCandidates: () => [], decisionQueueSessionOrigin: () => undefined, promptOwner: () => "user" },
      goals: { decisionAnswerable: () => false },
      missions: { decisionQueueCandidates: () => [] },
    });
    assert.deepEqual(queue.decisions.map(item => item.key).sort(), ["session:challenger-1:10", "session:work-1:11"]);

    const now = "2026-11-26T12:00:00.000Z";
    const resetsAt = "2026-11-26T13:00:00.000Z";
    const key = randomBytes(32);
    const stateDir = join(dir, "team-state"), runDir = join(dir, "team-run"), workspaceDir = join(dir, "team-ws");
    for (const d of [stateDir, runDir, workspaceDir]) mkdirSync(d, { recursive: true });
    const limitRows = [
      { id: "judge-limit", provider: "codex" as const, purpose: "duel" as const, executionIdentity: "eval" as const, attention: { limit: { confidence: "corroborated", since: now, resetsAt } } },
      { id: "legacy-judge-limit", provider: "codex" as const, purpose: "duel" as const, attention: { limit: { confidence: "corroborated", since: now, resetsAt } } },
      { id: "challenger-limit", provider: "claude" as const, purpose: "duel" as const, executionIdentity: "production" as const, attention: { limit: { confidence: "corroborated", since: now, resetsAt } } },
    ];
    let listedOnce = false;
    const teamManager = {
      list: async () => { listedOnce = true; return limitRows; },
      events: () => ({ events: [], cursor: 0, more: false }),
    } as never;
    const config = {
      port: 0, origin: "http://127.0.0.1", keyFile: join(dir, "k"), stateDir, runDir, environment: "local", enableDemo: false, maxSessions: 4,
      agents: {}, projects: [], teams: { workspaceDir }, tokens: [],
    } as unknown as Config;
    const teams = new TeamService(config, key, teamManager, (_projectId, fn) => fn(), undefined, undefined, { now: () => Date.parse(now) });
    try {
      teams.start();
      await until(() => listedOnce && teams.providerLimits().length > 0, 10_000);
      await teams.idle();
      assert.deepEqual(teams.providerLimits().map(item => ({ provider: item.provider, sessionId: item.sessionId })), [
        { provider: "claude", sessionId: "challenger-limit" },
      ]);
    } finally {
      await teams.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
