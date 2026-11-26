import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Manager } from "../packages/host/src/manager.js";
import { bootId, liveWitness, newWitness, type ProcessRow } from "../packages/host/src/process-census.js";
import type { StoredLeftover } from "../packages/host/src/team-leftover.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun } from "../packages/host/src/team-types.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type StoredRun = { run: TeamRun; pending?: { witness?: unknown }; leftover?: StoredLeftover; halt?: string };
type Internals = {
  records: Map<string, StoredRun>;
  operation(stored: StoredRun, kind: "check", perform: () => Promise<unknown>, complete: () => void): void;
};

const code = (expected: string) => (error: unknown) => error instanceof TeamError && error.code === expected;
const groupGone = (group: number) => { try { process.kill(-group, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };

async function until(check: () => boolean, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(message);
}

test("a check that starts a server writing to a file leaves a hold: the cancelled run's directories stay, the view shows it running, and the next census after it ends removes them", { timeout: 120_000, skip: process.platform === "win32" && "process groups are POSIX" }, async () => {
  const f = schedulerFixture();
  const out = mkdtempSync(join(tmpdir(), "witness-hold-"));
  const at = new Date().toISOString();
  f.run.status = "implementing";
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 1 };
  f.writeTeam();
  let now = Date.parse(at);
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  const internal = teams as unknown as Internals;
  let group: number | undefined;
  try {
    const stored = internal.records.get(f.run.id)!;
    stored.halt = undefined;
    internal.operation(stored, "check", () => teamCommand({ command: "sh", args: ["-c", "sleep 600 >out.log 2>&1 &"] }, out), () => {});
    await until(() => !stored.pending, "the operation should settle");
    group = stored.leftover?.witness.groups[0];
    assert.ok(group !== undefined && !groupGone(group), `the server the check started is held: ${JSON.stringify(stored.leftover)}`);
    assert.match(stored.run.events.at(-1)?.text ?? "", /still run after the command ended/);
    stored.run.status = "cancelled";
    now += 60_001;
    await assert.rejects(teams.removeRun(f.run.id), code("team-leftover-running"));
    assert.equal(existsSync(dirname(f.run.workspace)), true, "the directories stay");
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running");
    process.kill(-group, "SIGKILL");
    await until(() => groupGone(group!), "the server ends");
    await teams.removeRun(f.run.id);
    assert.equal(existsSync(dirname(f.run.workspace)), false, "the next census finds none and the directories go");
  } finally {
    if (group !== undefined) try { process.kill(-group, "SIGKILL"); } catch { }
    await teams.close();
    f.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test("the witness kept at settle holds only what still has a live member", () => {
  const boot = bootId();
  const row = (pid: number, pgid: number, sid: number, start = `s${pid}`): ProcessRow => ({ pid, ppid: 1, pgid, sid, uid: 0, start, command: "x" });
  const witness = { ...newWitness(), processes: [{ pid: 40, start: "s40" }, { pid: 41, start: "old" }], groups: [5, 77], sessions: [9, 88] };
  const kept = liveWitness(witness, { boot: witness.boot, rows: [row(40, 40, 40), row(41, 41, 41, "new"), row(60, 5, 9)] });
  assert.deepEqual(kept?.witness.processes, [{ pid: 40, start: "s40" }], "a reused pid with another start is not kept");
  assert.deepEqual(kept?.witness.groups, [5], "a group with no live member is dropped");
  assert.deepEqual(kept?.witness.sessions, [9]);
  assert.equal(kept?.count, 2);
  assert.equal(liveWitness(witness, { boot: witness.boot, rows: [row(1, 1, 1)] }), undefined, "nothing live holds nothing");
  assert.equal(liveWitness(witness, { boot: `${boot}-other`, rows: [row(60, 5, 9)] }), undefined, "another boot holds nothing");
});
