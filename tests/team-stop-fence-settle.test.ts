import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Manager } from "../packages/host/src/manager.js";
import { newWitness, type CensusResult, type HostProcesses, type ProcessWitness } from "../packages/host/src/process-census.js";
import { ANCHOR_SETTLE_MS } from "../packages/host/src/team-command-fence.js";
import { COMMAND_STOP_UNCONFIRMED_REASON } from "../packages/host/src/team-workspace.js";
import { TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;

const RUNNING: CensusResult = { ok: true, findings: [{ pid: 101, reason: "recorded-group" }] };
const ENDED: CensusResult = { ok: true, findings: [] };

function witness(pid: number): ProcessWitness {
  return { ...newWitness(), processes: [{ pid, start: `start-${pid}` }], sessions: [pid], groups: [pid] };
}

function fencedPrefixedRun(f: Fixture) {
  const at = new Date().toISOString();
  f.run.status = "blocked";
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.reason = COMMAND_STOP_UNCONFIRMED_REASON;
  f.run.blockCode = "command-stop-unconfirmed";
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.writeTeam({ pending: { id: randomUUID(), kind: "check", revision: f.run.revision, witness: witness(101),
    failure: { code: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON, at } } });
  f.config.teams!.commandPrefix = { command: "env", args: [] };
}

async function watched(results: (count: number) => CensusResult, waitMs: number) {
  const f = schedulerFixture();
  fencedPrefixedRun(f);
  const seen = { count: 0 };
  const processes: HostProcesses = { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async () => results(++seen.count) };
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => Date.now(), processes });
  try {
    const internals = teams as unknown as { fence: { watch(stored: unknown): void }; records: Map<string, unknown> };
    internals.fence.watch(internals.records.get(f.run.id));
    await delay(waitMs);
    return { count: seen.count, events: teams.get(f.run.id).events.map(event => event.text) };
  } finally {
    await teams.close();
    f.close();
  }
}

test("under a prefix the first census retries while the anchor's group still reads running and records only the last result", { timeout: 40_000 }, async () => {
  const result = await watched(count => (count <= 2 ? RUNNING : ENDED), ANCHOR_SETTLE_MS + 4_000);
  assert.equal(result.count, 3);
  assert.equal(result.events.filter(text => /still sees/.test(text)).length, 0, JSON.stringify(result.events));
  assert.equal(result.events.filter(text => /sees no process/.test(text)).length, 1, JSON.stringify(result.events));
});

test("under a prefix a census that reads running every time is retried 8 times and records one still-sees event", { timeout: 40_000 }, async () => {
  const result = await watched(() => RUNNING, ANCHOR_SETTLE_MS + 9_500);
  assert.equal(result.count, 9);
  assert.equal(result.events.filter(text => /still sees/.test(text)).length, 1, JSON.stringify(result.events));
  assert.equal(result.events.filter(text => /sees no process/.test(text)).length, 0);
});
