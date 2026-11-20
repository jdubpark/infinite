import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../packages/host/src/config.js";
import { Manager } from "../packages/host/src/manager.js";
import { prepareMemberTrace } from "../packages/host/src/member-traces.js";
import type { Provider } from "../packages/host/src/types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { TeamAssignment, TeamMember } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture } from "./team-fixture.js";
import { waitFor } from "./helpers.js";

const STAND_IN = resolve("tests/fixtures/trace-agent.mjs");
const MANIFEST = "infinite-trace.json";
const TRACE = "trace-fixture-0001-thread-0001";
const traces = (stateDir: string, ...parts: string[]) => join(stateDir, "teams", "traces", ...parts);
const manifest = (directory: string) => JSON.parse(readFileSync(join(directory, MANIFEST), "utf8"));
const shape = (directory: string) => ({ ...manifest(directory), at: undefined });
/** Writes `bytes` of trace where Codex's recorder would: an event log and one payload file. */
function writeTrace(root: string, bytes: number) {
  mkdirSync(join(root, TRACE, "payloads"), { recursive: true });
  writeFileSync(join(root, TRACE, "trace.jsonl"), "x".repeat(bytes - 2));
  writeFileSync(join(root, TRACE, "payloads", "1.json"), "{}");
}
/** Collects console.warn output as text while `body` runs. */
async function warnings(body: () => Promise<void>) {
  const lines: string[] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(arg => arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)).join(" ")); };
  try { await body(); } finally { console.warn = warn; }
  return lines;
}

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
    assert.ok(existsSync(join(directory, TRACE, "trace.jsonl")), "the recorder could write there");
    assert.deepEqual(shape(directory), { version: 1, sessionId: codex.id, state: "recording", caps: { memberBytes: 1_000_000, runBytes: 5_000_000 }, at: undefined, sessionRecord: "kept" },
      "the caps in force at the start are kept with the trace");
    assert.equal(statSync(join(directory, MANIFEST)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(codex.receipt.argv).includes(directory), false, "the prompt and arguments do not name it");
    assert.equal(JSON.stringify(manager.meta(codex.id)).includes(directory), false, "the session record does not name it");

    const claude = await launch("claude");
    assert.equal(claude.receipt.traceRoot, null);
    assert.equal(existsSync(traces(config.stateDir, runId, claude.memberId)), false);

    const separate = await launch("codex", true);
    assert.equal(separate.receipt.traceRoot, null, "a launch under another account gets no directory to write to");
    assert.deepEqual(shape(traces(config.stateDir, runId, separate.memberId)),
      { version: 1, sessionId: separate.id, state: "not-recorded", bytes: 0, at: undefined, reason: "separate-account", sessionRecord: "kept" });
  } finally { await team.close(); }
});

type Internals = { records: Map<string, unknown>; retire(record: unknown): Promise<void>; step(record: unknown): Promise<void> };
const internal = (teams: TeamService) => teams as unknown as Internals;

/**
 * A scheduler fixture whose run is a Codex team with its project manager queued, and the setting on with `caps`. The
 * fake manager prepares the member's trace at launch, as the real one does, and then writes `bytes` of trace there,
 * plus any `extra` files by name and size, as Codex would.
 */
function codexTeam(bytes: number, caps: { memberBytes: number; runBytes: number }, extra: Record<string, number> = {}) {
  const f = schedulerFixture();
  let clock = Date.now();
  f.run.provider = "codex";
  const pm = f.run.members[0]!;
  pm.status = "queued";
  delete pm.startedAt;
  f.config.teams!.memberTraces = { enabled: true, ...caps };
  const create = f.manager.createTeamSession;
  f.manager.createTeamSession = async (...args: Parameters<typeof create>) => {
    const [request, assignment] = args;
    const root = prepareMemberTrace(f.config, request.requestId, request.provider as Provider, assignment, { command: process.execPath, args: [] });
    if (root) {
      writeTrace(root, bytes);
      for (const [name, size] of Object.entries(extra)) writeFileSync(join(root, name), "y".repeat(size));
    }
    return create(...args);
  };
  f.writeTeam();
  const teams = f.openTeam({ now: () => clock } as Parameters<typeof f.openTeam>[0]);
  const directory = () => traces(f.config.stateDir, f.run.id, pm.memberId);
  const step = async () => { const internals = internal(teams); await internals.step(internals.records.get(f.run.id)); await teams.idle(); };
  return {
    f, teams, pm, directory, step,
    member: () => (internal(teams).records.get(f.run.id) as { run: { members: TeamMember[] } }).run.members[0]!,
    /** One retention pass, `advanceMs` after the last. */
    sweep: async (advanceMs = 0) => { clock += advanceMs; const internals = internal(teams); await internals.retire(internals.records.get(f.run.id)); await teams.idle(); },
    /** The owner cancels the run, and the scheduler stops its members. */
    cancel: async () => { await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 }); await step(); },
    close: () => { teams.close(); f.close(); },
  };
}

test("a project manager waiting on the owner has exited, so its trace is settled", async () => {
  const t = codexTeam(64, { memberBytes: 1000, runBytes: 5000 });
  try {
    await t.step();
    assert.equal(t.member().status, "running");
    assert.ok(existsSync(join(t.directory(), TRACE, "trace.jsonl")), "the launch prepared the directory and Codex wrote there");
    await t.sweep();
    assert.equal(manifest(t.directory()).state, "recording", "a running session's trace is not measured");

    t.f.report(t.pm.sessionId, { requestId: randomUUID(), runId: t.f.run.id, memberId: t.pm.memberId, revision: t.pm.revision,
      report: { kind: "question", question: "Which file?", options: [], recommendation: { answers: ["a.txt"], reason: "It holds the change." } } });
    await t.step();
    assert.equal(t.member().status, "waiting", "the scheduler confirmed the exit and left the manager waiting");
    assert.equal((await t.f.manager.state(t.pm.sessionId)).status, "exited");
    await t.sweep(10_000);
    assert.deepEqual(shape(t.directory()), { version: 1, sessionId: t.pm.sessionId, state: "kept", caps: { memberBytes: 1000, runBytes: 5000 },
      bytes: 64, at: undefined, sessionRecord: "kept" });
  } finally { t.close(); }
});

test("turning the setting off stops new traces only: a recorded trace keeps its caps, and run removal still removes it", async () => {
  const t = codexTeam(120, { memberBytes: 100, runBytes: 5000 });
  try {
    await t.step();
    t.f.config.teams!.memberTraces = { enabled: false };
    await t.cancel();
    assert.equal(t.member().status, "stopped");
    assert.deepEqual(shape(t.directory()), { version: 1, sessionId: t.pm.sessionId, state: "removed", caps: { memberBytes: 100, runBytes: 5000 },
      bytes: 120, at: undefined, reason: "member-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(t.directory()), [MANIFEST], "only the manifest is left");
    assert.equal(statSync(join(t.directory(), MANIFEST)).mode & 0o777, 0o600);

    const other = traces(t.f.config.stateDir, randomUUID(), randomUUID());
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeFileSync(join(other, "trace.jsonl"), "{}");
    await t.teams.removeRun(t.f.run.id);
    assert.equal(existsSync(traces(t.f.config.stateDir, t.f.run.id)), false, "the run's traces went with it");
    assert.ok(existsSync(join(other, "trace.jsonl")), "another run's traces stay");
  } finally { t.close(); }
});

test("a failed measurement is retried later, and a trace is marked removed only after its removal finished", async () => {
  const measured = codexTeam(64, { memberBytes: 1000, runBytes: 5000 });
  try {
    await measured.step();
    chmodSync(measured.directory(), 0o300);
    const logged = await warnings(() => measured.cancel());
    chmodSync(measured.directory(), 0o700);
    assert.equal(manifest(measured.directory()).state, "recording", "nothing was measured");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, new RegExp(`member ${measured.pm.memberId} in team ${measured.f.run.id} .*EACCES`));
    assert.equal(logged[0]!.includes(measured.f.config.stateDir), false, "the log names the ids, not the path");
    await measured.sweep(1_000);
    assert.equal(manifest(measured.directory()).state, "recording", "the retry waits");
    await measured.sweep(60_000);
    assert.equal(manifest(measured.directory()).state, "kept", "a later tick measured it");
  } finally { measured.close(); }

  const removed = codexTeam(120, { memberBytes: 100, runBytes: 5000 });
  try {
    await removed.step();
    const payloads = join(removed.directory(), TRACE, "payloads");
    chmodSync(payloads, 0o500);
    await warnings(() => removed.cancel());
    chmodSync(payloads, 0o700);
    assert.equal(manifest(removed.directory()).state, "removing", "a removal that failed is not reported as done");
    assert.ok(existsSync(join(payloads, "1.json")));
    await removed.sweep(60_000);
    assert.deepEqual(shape(removed.directory()), { version: 1, sessionId: removed.pm.sessionId, state: "removed", caps: { memberBytes: 100, runBytes: 5000 },
      bytes: 120, at: undefined, reason: "member-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(removed.directory()), [MANIFEST]);
  } finally { removed.close(); }
});

test("only the manifest itself is exempt: a file named like it is trace, and a stale manifest write is removed", async () => {
  const stale = `.${MANIFEST}.${randomUUID()}.tmp`;
  const t = codexTeam(64, { memberBytes: 100, runBytes: 5000 }, { [`${MANIFEST}.big`]: 500, [stale]: 10 });
  try {
    await t.step();
    await t.cancel();
    assert.deepEqual(shape(t.directory()), { version: 1, sessionId: t.pm.sessionId, state: "removed", caps: { memberBytes: 100, runBytes: 5000 },
      bytes: 564, at: undefined, reason: "member-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(t.directory()), [MANIFEST]);
  } finally { t.close(); }
});

test("trace settlement never follows a link, and its log names no path", async () => {
  const outside = mkdtempSync(join(tmpdir(), "inf-trace-outside-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "z".repeat(1000));
    writeFileSync(join(outside, "keep-too.txt"), "kept");
    const inner = codexTeam(120, { memberBytes: 100, runBytes: 5000 });
    try {
      await inner.step();
      // A link inside the trace, and one at the name a fixed temporary file would have.
      symlinkSync(join(outside, "keep.txt"), join(inner.directory(), TRACE, "outside"));
      symlinkSync(join(outside, "keep-too.txt"), join(inner.directory(), `${MANIFEST}.tmp`));
      const links = lstatSync(join(inner.directory(), TRACE, "outside")).size + lstatSync(join(inner.directory(), `${MANIFEST}.tmp`)).size;
      await inner.cancel();
      assert.deepEqual(shape(inner.directory()), { version: 1, sessionId: inner.pm.sessionId, state: "removed", caps: { memberBytes: 100, runBytes: 5000 },
        bytes: 120 + links, at: undefined, reason: "member-cap", sessionRecord: "kept" }, "a link counts as itself");
      assert.deepEqual(readdirSync(inner.directory()), [MANIFEST], "the links were removed");
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "z".repeat(1000), "their targets were not");
      assert.equal(readFileSync(join(outside, "keep-too.txt"), "utf8"), "kept");
    } finally { inner.close(); }

    const swapped = codexTeam(120, { memberBytes: 100, runBytes: 5000 });
    try {
      await swapped.step();
      // The member directory itself becomes a link to a directory elsewhere that holds the trace.
      const moved = join(outside, "member");
      renameSync(swapped.directory(), moved);
      symlinkSync(moved, swapped.directory());
      const logged = await warnings(() => swapped.cancel());
      assert.ok(existsSync(join(moved, TRACE, "trace.jsonl")), "nothing behind the link was removed");
      assert.equal(manifest(moved).state, "recording", "nothing behind the link was written");
      assert.equal(logged.length, 1);
      assert.match(logged[0]!, new RegExp(swapped.pm.memberId));
      for (const line of logged) for (const path of [swapped.f.config.stateDir, outside, tmpdir()]) assert.equal(line.includes(path), false, line);

      // The run directory as a link: its removal is refused and the record kept.
      const runTraces = traces(swapped.f.config.stateDir, swapped.f.run.id);
      renameSync(runTraces, join(outside, "run"));
      symlinkSync(join(outside, "run"), runTraces);
      await assert.rejects(swapped.teams.removeRun(swapped.f.run.id), /member traces could not be removed/);
      assert.ok(existsSync(join(outside, "run")));
      assert.ok(existsSync(join(moved, TRACE, "trace.jsonl")));
    } finally { swapped.close(); }

    // A traces root that is a link is refused at launch; the warning names the member, not the path.
    const refused = codexTeam(64, { memberBytes: 100, runBytes: 5000 });
    try {
      const elsewhere = join(outside, "root");
      mkdirSync(elsewhere);
      mkdirSync(join(refused.f.config.stateDir, "teams"), { recursive: true });
      symlinkSync(elsewhere, traces(refused.f.config.stateDir));
      const logged = await warnings(() => refused.step());
      assert.deepEqual(readdirSync(elsewhere), [], "no directory was made behind the link");
      assert.equal(logged.filter(line => line.includes(refused.pm.memberId)).length, 1, logged.join("\n"));
      for (const line of logged) for (const path of [refused.f.config.stateDir, outside, tmpdir()]) assert.equal(line.includes(path), false, line);
    } finally { refused.close(); }
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("a manifest that is a FIFO does not hold settlement waiting for a writer", { timeout: 30000 }, async () => {
  const t = codexTeam(64, { memberBytes: 1000, runBytes: 5000 });
  try {
    await t.step();
    const file = join(t.directory(), MANIFEST);
    rmSync(file);
    execFileSync("mkfifo", [file]);
    let timer: NodeJS.Timeout | undefined;
    const ended = await Promise.race([t.cancel().then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    // A settlement blocked on the FIFO is released, so this test fails instead of hanging the file.
    if (!ended) closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
    assert.ok(ended, "settlement waited for a writer on the FIFO");
    assert.ok(lstatSync(file).isFIFO(), "a manifest that is no regular file is left in place");
    assert.ok(existsSync(join(t.directory(), TRACE, "trace.jsonl")), "and the trace is not measured or removed on its say");
  } finally { t.close(); }
});

/** A cancelled run whose members' sessions the fake manager knows, each with a trace of the given size. */
async function tracedRun(members: { exited: boolean; bytes: number }[], caps: { memberBytes: number; runBytes: number }) {
  const f = schedulerFixture();
  const base = f.run.members[0]!;
  f.run.status = "cancelled";
  f.run.provider = "codex";
  f.config.teams!.memberTraces = { enabled: true, ...caps };
  f.run.members = [];
  for (const [index, { exited, bytes }] of members.entries()) {
    const member: TeamMember = { ...base, memberId: randomUUID(), sessionId: randomUUID(), role: "implementer", title: `Member ${index}`, status: "running" };
    const assignment = { runId: f.run.id, memberId: member.memberId, revision: 1, role: "implementer", taskId: "a" } satisfies TeamAssignment;
    await f.manager.createTeamSession({ requestId: member.sessionId, provider: "codex", title: member.title, prompt: "Do the task" }, assignment, member.cwd);
    writeTrace(prepareMemberTrace(f.config, member.sessionId, "codex", assignment, { command: process.execPath, args: [] })!, bytes);
    if (exited) await f.manager.stopTeamSession(member.sessionId);
    f.run.members.push(member);
  }
  f.writeTeam();
  return f;
}
async function sweep(teams: TeamService, id: string) {
  await internal(teams).retire(internal(teams).records.get(id));
  await teams.idle();
}

test("an exited Codex member's trace over a cap is removed and its manifest says so; a running member's trace waits", async () => {
  const caps = { memberBytes: 100, runBytes: 150 };
  const f = await tracedRun([{ exited: true, bytes: 120 }, { exited: true, bytes: 80 }, { exited: true, bytes: 80 }, { exited: false, bytes: 500 }], caps);
  const teams = f.openTeam();
  try {
    const [over, kept, overRun, running] = f.run.members.map(member => ({ member, directory: traces(f.config.stateDir, f.run.id, member.memberId) }));
    const recordBefore = JSON.stringify(f.readRecord("team", f.run.id));
    await sweep(teams, f.run.id);

    assert.deepEqual(shape(over.directory), { version: 1, sessionId: over.member.sessionId, state: "removed", caps, bytes: 120, at: undefined, reason: "member-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(over.directory), [MANIFEST], "only the manifest is left");
    assert.deepEqual(shape(kept.directory), { version: 1, sessionId: kept.member.sessionId, state: "kept", caps, bytes: 80, at: undefined, sessionRecord: "kept" });
    assert.ok(existsSync(join(kept.directory, TRACE, "trace.jsonl")));
    assert.deepEqual(shape(overRun.directory), { version: 1, sessionId: overRun.member.sessionId, state: "removed", caps, bytes: 80, at: undefined, reason: "run-cap", sessionRecord: "kept" });
    assert.deepEqual(readdirSync(overRun.directory), [MANIFEST]);
    assert.equal(manifest(running.directory).state, "recording", "a running member is not measured");
    assert.ok(existsSync(join(running.directory, TRACE, "trace.jsonl")));
    assert.ok(statSync(join(over.directory, MANIFEST)).size < 400, "the manifest stays small");
    assert.equal(JSON.stringify(f.readRecord("team", f.run.id)), recordBefore, "the run record is unchanged");

    const first = readFileSync(join(kept.directory, MANIFEST), "utf8");
    await sweep(teams, f.run.id);
    assert.equal(readFileSync(join(kept.directory, MANIFEST), "utf8"), first, "a later tick does not measure the same session again");
  } finally { teams.close(); f.close(); }
});

test("a sibling manifest that cannot be read leaves the run cap undecided until it can be read", async () => {
  const caps = { memberBytes: 100, runBytes: 150 };
  const f = await tracedRun([{ exited: true, bytes: 80 }, { exited: false, bytes: 80 }], caps);
  let clock = Date.now();
  const teams = f.openTeam({ now: () => clock } as Parameters<typeof f.openTeam>[0]);
  const [first, second] = f.run.members.map(member => traces(f.config.stateDir, f.run.id, member.memberId));
  try {
    await sweep(teams, f.run.id);
    assert.equal(manifest(first!).state, "kept");
    chmodSync(join(first!, MANIFEST), 0o000);
    await f.manager.stopTeamSession(f.run.members[1]!.sessionId);
    clock += 10_000;
    const logged = await warnings(() => sweep(teams, f.run.id));
    chmodSync(join(first!, MANIFEST), 0o600);
    assert.equal(manifest(second!).state, "recording", "no cap is decided while a sibling's usage is unknown");
    assert.match(logged.join("\n"), /EACCES/);
    clock += 60_000;
    await sweep(teams, f.run.id);
    assert.deepEqual(shape(second!), { version: 1, sessionId: f.run.members[1]!.sessionId, state: "removed", caps, bytes: 80, at: undefined, reason: "run-cap", sessionRecord: "kept" });
  } finally { chmodSync(join(first!, MANIFEST), 0o600); teams.close(); f.close(); }
});
