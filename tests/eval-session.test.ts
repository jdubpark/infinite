import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attention } from "@infinite/attention";
import { Manager } from "../packages/host/src/manager.js";
import { Notifier } from "../packages/host/src/notifier.js";
import { PushStore } from "../packages/host/src/push.js";
import { ProjectContexts } from "../packages/host/src/project-context.js";
import type { FuseGate, FuseLaunch } from "../packages/host/src/fuse/types.js";
import type { TeamAssignment } from "../packages/host/src/team-types.js";
import type { Config, SessionPurpose } from "../packages/host/src/types.js";
import { stopSessionWorkers } from "./helpers.js";

function rig(options: { eval?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-session-")));
  const project = join(root, "project"), workspaceDir = join(root, "teams"), cwd = join(workspaceDir, "run");
  const stateDir = join(root, "state"), marks = join(root, "marks.log");
  const runDir = join(root, "run"), socketDir = mkdtempSync(join(tmpdir(), "es-"));
  for (const dir of [project, cwd, stateDir]) mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, "import { appendFileSync } from \"node:fs\";\nappendFileSync(process.argv[2], `${process.argv[3]}\\n`);\n");
  const profile = (label: string) => ({ command: process.execPath, args: [agent, marks, label] });
  const config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir, runDir, socketDir, environment: "local", enableDemo: false, maxSessions: 8,
    agents: { claude: profile("production") },
    projects: [{ id: "fixture", name: "Fixture", path: project }],
    teams: { workspaceDir },
    tokens: [],
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
  return {
    root, config, key, manager, cwd, admitted, stateDir,
    labels: () => existsSync(marks) ? readFileSync(marks, "utf8").split("\n").filter(Boolean) : [],
    close: async () => {
      await stopSessionWorkers(config);
      await new Promise(done => setTimeout(done, 1000));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
type Rig = ReturnType<typeof rig>;

async function launch(r: Rig, purpose: SessionPurpose | undefined) {
  const id = randomUUID();
  const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" };
  const session = await r.manager.createTeamSession({ requestId: id, provider: "claude", projectId: "fixture", title: `${purpose ?? "none"} session`, prompt: "Say hello" },
    team, r.cwd, undefined, join(r.cwd, ".."), true, { purpose });
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

test("a learning session launches only as the eval identity", { timeout: 90_000 }, async () => {
  const r = rig({ eval: true });
  try {
    const replay = await launch(r, "replay");
    await until(() => r.labels().length === 1);
    assert.deepEqual(r.labels(), ["eval"]);
    const work = await launch(r, "work");
    await until(() => r.labels().length === 2);
    assert.deepEqual(r.labels(), ["eval", "production"]);
    assert.equal(r.admitted.find(launch => launch.launchId === replay.id)?.purpose, "replay");
    assert.equal(r.admitted.find(launch => launch.launchId === work.id)?.purpose, "work");
  } finally {
    await r.close();
  }

  const bare = rig({});
  try {
    const id = randomUUID();
    const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" };
    await assert.rejects(
      bare.manager.createTeamSession({ requestId: id, provider: "claude", projectId: "fixture", title: "Replay", prompt: "Say hello" },
        team, bare.cwd, undefined, join(bare.cwd, ".."), true, { purpose: "replay" }),
      (error: { status?: number; code?: string }) => error.status === 409 && error.code === "eval-identity-missing",
    );
    assert.equal(existsSync(join(bare.stateDir, "sessions", id)), false);
    assert.deepEqual(bare.labels(), []);
  } finally {
    await bare.close();
  }
});

test("a learning session gets no shared project context", { timeout: 90_000 }, async () => {
  const r = rig({ eval: true });
  try {
    new ProjectContexts(r.config, r.key).setContext("fixture", "Owner rule: keep the release notes current", 0);
    const replay = await launch(r, "replay");
    const work = await launch(r, "work");
    await until(() => r.labels().length === 2);
    const learning = r.manager.meta(replay.id).session;
    const production = r.manager.meta(work.id).session;
    assert.equal(learning.context, "");
    assert.deepEqual(learning.contextSources, []);
    assert.match(production.context ?? "", /Owner rule: keep the release notes current/);
    assert.ok((production.contextSources ?? []).length > 0);
  } finally {
    await r.close();
  }
});

test("no learning session reaches the owner's devices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-session-push-"));
  try {
    const store = new PushStore(dir, randomBytes(32));
    store.add("controller", "ExponentPushToken[a]", "android");
    const sent: { to: string; data: { url: string } }[][] = [];
    const rows = [
      { id: "replay-1", title: "Replay trial", provider: "claude", status: "running", purpose: "replay", attention: att("working") },
      { id: "work-1", title: "Retry logic", provider: "claude", status: "running", purpose: "work", attention: att("working") },
    ];
    const manager = { list: async () => rows } as never;
    const sender = async (messages: { to: string; data: { url: string } }[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
    const notifier = new Notifier(manager, store, sender, { detail: "minimal", events: ["needs-you", "turn-finished", "exited", "recording-error"], intervalMs: 100000 });
    await notifier.tick();
    rows[0].attention = att("needs-you", 7);
    rows[1].attention = att("needs-you", 8);
    await notifier.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 1);
    assert.equal(sent[0][0].data.url, "/session/work-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
