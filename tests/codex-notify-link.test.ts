import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitFor } from "./helpers.js";
import { Manager } from "../packages/host/src/manager.js";
import { fixture } from "./team-fixture.js";

const THREAD = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";

/** One team Codex member, run by the scripted stand-in. Returns its journal and worker state. */
async function runCodexMember(codexHooks: boolean, mode?: "later-turn") {
  const home = mkdtempSync(join(tmpdir(), "infinite-codex-home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  let host: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    host = await fixture("success", undefined, {
      attention: { idleAfterMs: 3000, limitConfirmMs: 30000, hooks: { claude: true, codex: codexHooks } },
    }, { noServer: true });
    const config = host.host.config;
    config.agents.codex = { command: process.execPath, args: [resolve("tests/fixtures/codex-notify-agent.mjs"), ...(mode ? [mode] : [])] };
    const manager = new Manager(config, readFileSync(config.keyFile));
    const cwd = join(config.teams!.workspaceDir, randomUUID(), "integration");
    mkdirSync(cwd, { recursive: true });
    const assignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer", taskId: "a" } as never;
    const id = randomUUID();
    await manager.createTeamSession({ requestId: id, projectId: "rehearsal", provider: "codex", title: "Codex notify", prompt: "go" }, assignment, cwd);
    const events = await waitFor(
      () => manager.events(id, 0, 200).events,
      (found) => found.some((event) => event.type === "usage-coverage"),
      60000,
    );
    const state = await manager.state(id);
    return { events, state };
  } finally {
    await host?.close();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const ofType = (events: { type: string; data: any }[], type: string) => events.filter((event) => event.type === type);

test("with Codex hooks off, a turn-end notify links the record and journals no attention signal (INF-213)", { timeout: 120000 }, async (t) => {
  const { events, state } = await runCodexMember(false);
  const [coverage] = ofType(events, "usage-coverage");
  t.diagnostic(`observed usage-coverage: ${JSON.stringify(coverage.data)}`);
  assert.equal(ofType(events, "usage-coverage").length, 1);
  assert.equal(coverage.data.coverage, "complete");
  assert.equal(coverage.data.reason, undefined);
  assert.ok(ofType(events, "usage").length >= 1, "the rollout's token usage is journaled");
  const kinds = ofType(events, "signal").map((event) => event.data.kind);
  assert.ok(!kinds.includes("hooks-ready"), `no hooks-ready signal, saw ${kinds.join(",")}`);
  assert.ok(!kinds.includes("turn-end"), `no turn-end signal, saw ${kinds.join(",")}`);
  assert.equal(state.attention.hooks, "none");
  assert.equal(state.nativeSession?.id, THREAD);
});

test("with Codex hooks off, a later turn cut short after a notify is not reported as complete usage (INF-213)", { timeout: 120000 }, async () => {
  const { events } = await runCodexMember(false, "later-turn");
  const [coverage] = ofType(events, "usage-coverage");
  assert.deepEqual(coverage.data, { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex", finalDrain: "complete" });
  assert.ok(ofType(events, "usage").length >= 1, "the first turn's usage is still journaled");
});

test("with Codex hooks on, the same notify still journals its turn-end signal (INF-213)", { timeout: 120000 }, async () => {
  const { events, state } = await runCodexMember(true);
  const kinds = ofType(events, "signal").map((event) => `${event.data.kind}/${event.data.source}`);
  assert.ok(kinds.includes("turn-end/hook"), `turn-end from the hook source, saw ${kinds.join(",")}`);
  assert.equal(state.nativeSession?.id, THREAD);
});
