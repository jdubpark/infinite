import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../packages/host/src/config.js";
import { Manager } from "../packages/host/src/manager.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { TeamAssignment, TeamMember } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture } from "./team-fixture.js";
import { waitFor } from "./helpers.js";

const STAND_IN = resolve("tests/fixtures/trace-agent.mjs");
const MANIFEST = "infinite-trace.json";
const traces = (stateDir: string, ...parts: string[]) => join(stateDir, "teams", "traces", ...parts);
const manifest = (directory: string) => JSON.parse(readFileSync(join(directory, MANIFEST), "utf8"));

test("member traces parse only off, or on with both caps", () => {
  const root = mkdtempSync(join(tmpdir(), "inf-trace-config-"));
  try {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    mkdirSync(join(root, "project"));
    const base = {
      port: 0, origin: "http://127.0.0.1:4780", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
      environment: "local", tokens: [{ id: "o", label: "o", role: "owner", hash: "a".repeat(64) }],
      projects: [{ id: "p", name: "P", path: join(root, "project") }],
    };
    const parse = (memberTraces?: object) => {
      writeFileSync(join(root, "config.json"), JSON.stringify({ ...base, teams: { workspaceDir: join(root, "workspace"), ...(memberTraces ? { memberTraces } : {}) } }));
      return readConfig(join(root, "config.json")).config.teams;
    };
    assert.equal("memberTraces" in parse()!, false, "absent stays absent: the switch has no default");
    assert.deepEqual(parse({ enabled: false })!.memberTraces, { enabled: false });
    assert.deepEqual(parse({ enabled: true, memberBytes: 1000, runBytes: 5000 })!.memberTraces, { enabled: true, memberBytes: 1000, runBytes: 5000 });
    for (const refused of [{ enabled: true }, { enabled: true, memberBytes: 1000 }, { enabled: true, runBytes: 5000 },
      { enabled: true, memberBytes: 0, runBytes: 5000 }, { enabled: true, memberBytes: 1.5, runBytes: 5000 }, { memberBytes: 1000, runBytes: 5000 },
      { enabled: true, memberBytes: 1000, runBytes: 5000, path: "/elsewhere" }])
      assert.throws(() => parse(refused), JSON.stringify(refused));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only a Codex member launched under the host's account gets a private trace directory, which its arguments and session record do not name", { timeout: 120000 }, async () => {
  const team = await fixture("success", undefined, {}, { noServer: true });
  try {
    const config = team.host.config, receipts = team.receipts;
    const sudo = join(team.host.root, "bin", "sudo");
    mkdirSync(join(team.host.root, "bin"));
    // A stand-in for sudo: it drops the wrapper options and runs the provider in the same account.
    writeFileSync(sudo, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
    chmodSync(sudo, 0o700);
    const manager = new Manager(config, readFileSync(config.keyFile));
    const runId = randomUUID(), cwd = join(config.teams!.workspaceDir, runId, "integration");
    mkdirSync(cwd, { recursive: true });
    const launch = async (provider: "codex" | "claude", viaSudo = false) => {
      const args = [STAND_IN, receipts];
      config.agents[provider] = viaSudo ? { command: sudo, args: ["-n", "-u", "agent", "--", process.execPath, ...args] } : { command: process.execPath, args };
      const assignment = { runId, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "a" } satisfies TeamAssignment;
      const id = randomUUID();
      await manager.createTeamSession({ requestId: id, projectId: "rehearsal", provider, title: "Member", prompt: "Do the task" }, assignment, cwd);
      const file = join(receipts, `${assignment.memberId}.json`);
      const receipt = await waitFor(async () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined, Boolean, 30000);
      return { id, memberId: assignment.memberId, receipt: receipt as { traceRoot: string | null; argv: string[] } };
    };

    const off = await launch("codex");
    assert.equal(off.receipt.traceRoot, null, "with the switch off the launch environment has no trace variable");
    assert.equal(existsSync(traces(config.stateDir)), false, "with the switch off no trace directory exists");

    config.teams!.memberTraces = { enabled: true, memberBytes: 1_000_000, runBytes: 5_000_000 };
    const codex = await launch("codex");
    const directory = traces(config.stateDir, runId, codex.memberId);
    assert.equal(codex.receipt.traceRoot, directory);
    for (const path of [traces(config.stateDir), traces(config.stateDir, runId), directory])
      assert.equal(statSync(path).mode & 0o777, 0o700, path);
    assert.ok(existsSync(join(directory, "trace-fixture-0001-thread-0001", "trace.jsonl")), "the recorder could write there");
    assert.equal(JSON.stringify(codex.receipt.argv).includes(directory), false, "the prompt and arguments do not name it");
    assert.equal(JSON.stringify(manager.meta(codex.id)).includes(directory), false, "the session record does not name it");

    const claude = await launch("claude");
    assert.equal(claude.receipt.traceRoot, null);
    assert.equal(existsSync(traces(config.stateDir, runId, claude.memberId)), false);

    const separate = await launch("codex", true);
    assert.equal(separate.receipt.traceRoot, null, "a launch under another account gets no directory to write to");
    assert.deepEqual({ ...manifest(traces(config.stateDir, runId, separate.memberId)), at: undefined },
      { version: 1, sessionId: separate.id, state: "not-recorded", bytes: 0, at: undefined, reason: "separate-account", sessionRecord: "kept" });
  } finally { await team.close(); }
});

type Internals = { records: Map<string, { run: { members: TeamMember[] } }>; retire(record: unknown): Promise<void> };

/** A run whose members are given, with a trace of the given size written where the host keeps it. */
function tracedRun(members: { provider: "codex" | "claude"; status: TeamMember["status"]; exitConfirmedAt?: string; bytes?: number }[]) {
  const f = schedulerFixture();
  const base = f.run.members[0]!;
  f.run.status = "cancelled";
  f.run.members = members.map(({ bytes, ...fields }, index) => {
    const member: TeamMember = { ...base, ...fields, memberId: randomUUID(), sessionId: randomUUID(), role: "implementer", title: `Member ${index}` };
    if (bytes !== undefined) {
      const trace = traces(f.config.stateDir, f.run.id, member.memberId, "trace-fixture-0001-thread-0001");
      mkdirSync(join(trace, "payloads"), { recursive: true, mode: 0o700 });
      writeFileSync(join(trace, "trace.jsonl"), "x".repeat(bytes - 2));
      writeFileSync(join(trace, "payloads", "1.json"), "{}");
    }
    return member;
  });
  f.writeTeam();
  return f;
}
async function sweep(teams: TeamService, id: string) {
  const internals = teams as unknown as Internals;
  await internals.retire(internals.records.get(id));
  await teams.idle();
}

test("an ended Codex member's trace over a cap is removed and its manifest says so; a running member's trace waits", async () => {
  const at = new Date().toISOString();
  const f = tracedRun([
    { provider: "codex", status: "stopped", bytes: 120 },
    { provider: "codex", status: "stopped", bytes: 80 },
    { provider: "codex", status: "reported", exitConfirmedAt: at, bytes: 80 },
    { provider: "codex", status: "running", bytes: 500 },
  ]);
  f.config.teams!.memberTraces = { enabled: true, memberBytes: 100, runBytes: 150 };
  const teams = f.openTeam();
  try {
    const [over, kept, overRun, running] = f.run.members.map(member => ({ member, directory: traces(f.config.stateDir, f.run.id, member.memberId) }));
    const recordBefore = JSON.stringify(f.readRecord("team", f.run.id));
    await sweep(teams, f.run.id);

    const shape = (directory: string) => ({ ...manifest(directory), at: undefined });
    assert.deepEqual(shape(over.directory), { version: 1, sessionId: over.member.sessionId, state: "removed", bytes: 120, at: undefined, reason: "member-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(over.directory), [MANIFEST], "only the manifest is left");
    assert.deepEqual(shape(kept.directory), { version: 1, sessionId: kept.member.sessionId, state: "kept", bytes: 80, at: undefined, sessionRecord: "kept" });
    assert.ok(existsSync(join(kept.directory, "trace-fixture-0001-thread-0001", "trace.jsonl")));
    assert.deepEqual(shape(overRun.directory), { version: 1, sessionId: overRun.member.sessionId, state: "removed", bytes: 80, at: undefined, reason: "run-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(overRun.directory), [MANIFEST]);
    assert.equal(existsSync(join(running.directory, MANIFEST)), false, "a running member is not measured");
    assert.ok(existsSync(join(running.directory, "trace-fixture-0001-thread-0001", "trace.jsonl")));
    assert.ok(statSync(join(over.directory, MANIFEST)).size < 300, "the manifest stays small");
    assert.equal(statSync(join(over.directory, MANIFEST)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(f.readRecord("team", f.run.id)), recordBefore, "the run record is unchanged");

    const first = readFileSync(join(kept.directory, MANIFEST), "utf8");
    await sweep(teams, f.run.id);
    assert.equal(readFileSync(join(kept.directory, MANIFEST), "utf8"), first, "a later tick does not measure the same session again");
  } finally { teams.close(); f.close(); }
});

test("removing a run removes its member traces, also after the switch is turned off, and leaves other runs' traces", async () => {
  const f = tracedRun([{ provider: "codex", status: "stopped", bytes: 64 }]);
  const other = traces(f.config.stateDir, randomUUID(), randomUUID());
  mkdirSync(other, { recursive: true, mode: 0o700 });
  writeFileSync(join(other, "trace.jsonl"), "{}");
  const teams = f.openTeam();
  try {
    assert.ok(existsSync(traces(f.config.stateDir, f.run.id)));
    await teams.removeRun(f.run.id);
    assert.equal(existsSync(traces(f.config.stateDir, f.run.id)), false);
    assert.ok(existsSync(join(other, "trace.jsonl")));
  } finally { teams.close(); f.close(); }
});
