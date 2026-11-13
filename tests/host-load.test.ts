import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { missionHarness } from "./mission-harness.js";
import { fixture } from "./team-fixture.js";
import { TeamService } from "../packages/host/src/teams.js";
import { HOST_LOAD_REASON_PREFIX, HostLoadGate, LaunchHeldError, type HostLoadProbe, type HostReading } from "../packages/host/src/host-load.js";
import { Manager } from "../packages/host/src/manager.js";
import type { Config } from "../packages/host/src/types.js";

const GiB = 2 ** 30;
const limits = { minAvailableMemoryGiB: 8, maxLoadPerCpu: 1.5 };
const healthy: HostReading = { availableMemoryBytes: 32 * GiB, load1: 1, cpus: 16 };
const starved: HostReading = { availableMemoryBytes: 5.2 * GiB, load1: 1, cpus: 16 };

/** A probe whose reading the test changes; the gate reads it through the same closure. */
const flippable = (initial: HostReading) => {
  let reading = initial;
  const probe: HostLoadProbe = () => reading;
  return { probe, set: (next: HostReading) => { reading = next; } };
};

test("the gate holds below the memory floor", () =>
  assert.match(new HostLoadGate(limits, () => ({ availableMemoryBytes: 5.2 * GiB, load1: 1, cpus: 16 }), 0).held()!, /^Waiting for host capacity: 5\.2 GiB of memory is available, below the 8 GiB floor\.$/));

test("the gate holds above the load ceiling and not at it", () => {
  assert.match(new HostLoadGate(limits, () => ({ availableMemoryBytes: 32 * GiB, load1: 26.1, cpus: 16 }), 0).held()!, /load 26\.1 on 16 CPUs/);
  assert.equal(new HostLoadGate(limits, () => ({ availableMemoryBytes: 32 * GiB, load1: 24, cpus: 16 }), 0).held(), undefined);
});

test("no hostLoad block and a failing probe hold nothing", () => {
  assert.equal(new HostLoadGate(undefined, () => ({ availableMemoryBytes: 0, load1: 99, cpus: 1 }), 0).held(), undefined);
  assert.equal(new HostLoadGate(limits, () => { throw new Error("probe"); }, 0).held(), undefined);
});

test("the gate re-reads the host at most once per TTL", () => {
  let reads = 0;
  const gate = new HostLoadGate(limits, () => { reads++; return starved; }, 60000);
  assert.ok(gate.held());
  assert.ok(gate.held());
  assert.equal(reads, 1, "a reading inside the TTL is reused");
});

test("a held mission shows the reason, starts no coordinator, and proceeds when the host recovers", { timeout: 90000 }, async () => {
  const host = flippable(starved);
  const h = missionHarness({ configure: config => { config.hostLoad = limits; }, hostProbe: host.probe });
  const { missions } = h.open();
  try {
    const created = await missions.create(h.create());
    await waitFor(async () => missions.peek(created.id), mission => Boolean(mission?.reason?.startsWith(HOST_LOAD_REASON_PREFIX)), 20000);
    await new Promise(done => setTimeout(done, 1200));
    assert.equal(h.coordinatorReceipts().length, 0, "no coordinator starts while the host is short of memory");
    assert.equal(missions.peek(created.id)!.events.filter(event => event.text.startsWith("The coordinator launch is waiting")).length, 1, "the hold is recorded once");
    host.set(healthy);
    await waitFor(async () => missions.peek(created.id), mission => mission?.reason === undefined, 20000);
    await waitFor(async () => h.coordinatorReceipts(), receipts => receipts.length === 1, 20000);
  } finally { await h.close(); }
});

test("a held team member waits with the reason and launches after recovery", { timeout: 90000 }, async () => {
  const host = flippable(starved);
  const h = missionHarness({ configure: config => { config.hostLoad = limits; }, hostProbe: host.probe });
  const { teams } = h.open();
  try {
    const created = await teams.create({ requestId: randomUUID(), projectId: "api", provider: "claude", useConfiguredLineup: true,
      title: "Held standalone run", objective: "Make an independent repository change", parallelism: 1 });
    await waitFor(async () => teams.get(created.id), run => Boolean(run.reason?.startsWith(HOST_LOAD_REASON_PREFIX)), 20000);
    const held = teams.get(created.id);
    assert.ok(held.members.every(member => member.status === "queued"), "no member session starts while the host is short of memory");
    host.set(healthy);
    await waitFor(async () => teams.get(created.id), run => run.members.some(member => Boolean(member.startedAt)), 30000);
    assert.ok(!teams.get(created.id).reason?.startsWith(HOST_LOAD_REASON_PREFIX), "the hold reason clears once a member launches");
  } finally { await h.close(); }
});

test("a held check run does not start until the host recovers", { timeout: 120000 }, async () => {
  const host = flippable(healthy);
  const f = await fixture("success", undefined, { hostLoad: limits }, { noServer: true });
  const key = readFileSync(f.host.config.keyFile);
  const manager = new Manager(f.host.config, key, host.probe);
  const teams = new TeamService(f.host.config, key, manager, (_projectId, start) => start());
  teams.start();
  try {
    const created = await teams.create(f.create());
    // Hold once both implementers are running. Their integration takes seconds, and the next gated launch is the reviewer, which waits for the check.
    await waitFor(async () => teams.get(created.id), run => run.members.filter(member => member.role === "implementer" && Boolean(member.startedAt)).length === 2, 90000);
    host.set(starved);
    await waitFor(async () => teams.get(created.id), run => Boolean(run.reason?.startsWith(HOST_LOAD_REASON_PREFIX)), 90000);
    await new Promise(done => setTimeout(done, 1200));
    const held = teams.get(created.id);
    assert.notEqual(held.status, "verifying", "the check does not start while the host is held");
    assert.equal(held.checks.length, 0, "no check result exists while the host is held");
    host.set(healthy);
    await waitFor(async () => teams.get(created.id), run => run.checks.length > 0, 90000);
    assert.ok(!teams.get(created.id).reason?.startsWith(HOST_LOAD_REASON_PREFIX), "the hold reason clears when the check starts");
  } finally { teams.close(); await teams.idle(); await f.close(); }
});

test("a session the owner starts is not gated", { timeout: 60000 }, async () => {
  const host = flippable(starved);
  let config!: Config;
  const h = missionHarness({ configure: c => {
    config = c; c.hostLoad = limits;
    c.agents.demo = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
  }, hostProbe: host.probe });
  h.open();
  const manager = new Manager(config, readFileSync(config.keyFile), host.probe);
  try {
    assert.ok(manager.hostLoad.held(), "the gate is holding");
    await assert.doesNotReject(manager.create({ requestId: randomUUID(), provider: "demo", projectId: "api", title: "Owner session", prompt: "Say hello" }));
  } finally { await h.close(); }
});

test("a held launch stops no running session", { timeout: 90000 }, async () => {
  const host = flippable(healthy);
  let config!: Config;
  const h = missionHarness({ configure: c => { config = c; c.hostLoad = limits; }, hostProbe: host.probe });
  const { teams } = h.open();
  const observer = new Manager(config, readFileSync(config.keyFile), host.probe);
  const running = async (title: string) => (await observer.list()).filter(session => session.status === "running" && session.title === title).length;
  try {
    const first = await teams.create({ requestId: randomUUID(), projectId: "api", provider: "claude", useConfiguredLineup: true,
      title: "Original run", objective: "Make an independent repository change", parallelism: 1 });
    await waitFor(async () => teams.get(first.id), run => run.members.some(member => Boolean(member.startedAt)), 30000);
    await waitFor(() => running("project-manager: Original run"), count => count === 1, 20000);
    host.set(starved);
    // The gate reuses its last reading for 2 s; wait past that TTL so the next launch reads the starved host.
    await new Promise(done => setTimeout(done, 2500));
    // A second automatic launch through the same service: its hold must be visible before the original session is checked.
    const second = await teams.create({ requestId: randomUUID(), projectId: "web", provider: "claude", useConfiguredLineup: true,
      title: "Held second run", objective: "Make an independent repository change", parallelism: 1 });
    await waitFor(async () => teams.get(second.id), run => Boolean(run.reason?.startsWith(HOST_LOAD_REASON_PREFIX)), 20000);
    assert.equal(teams.get(second.id).members.filter(member => member.startedAt).length, 0, "the held member has not started");
    for (let tick = 0; tick < 3; tick++) {
      await new Promise(done => setTimeout(done, 500));
      assert.equal(await running("project-manager: Original run"), 1, `the original session keeps running on tick ${tick + 1}`);
    }
    assert.equal(teams.get(first.id).status !== "cancelled" && teams.get(first.id).status !== "blocked", true, "the original run was not stopped");
  } finally { await h.close(); }
});

test("a session-slot wait gives way to the capacity hold, and the launch clears it", { timeout: 90000 }, async () => {
  const host = flippable(healthy);
  let config!: Config;
  const h = missionHarness({ configure: c => { config = c; c.hostLoad = limits; c.maxSessions = 0; }, hostProbe: host.probe });
  const { teams } = h.open();
  try {
    const created = await teams.create({ requestId: randomUUID(), projectId: "api", provider: "claude", useConfiguredLineup: true,
      title: "Slot then capacity run", objective: "Make an independent repository change", parallelism: 1 });
    await waitFor(async () => teams.get(created.id), run => run.reason === "Waiting for an available host session slot.", 20000);
    host.set(starved);
    await waitFor(async () => teams.get(created.id), run => Boolean(run.reason?.startsWith(HOST_LOAD_REASON_PREFIX)), 20000);
    config.maxSessions = 24;
    host.set(healthy);
    await waitFor(async () => teams.get(created.id), run => run.members.some(member => Boolean(member.startedAt)), 30000);
    const launched = teams.get(created.id);
    assert.ok(!launched.reason?.startsWith(HOST_LOAD_REASON_PREFIX), "the capacity reason clears on launch");
    assert.notEqual(launched.reason, "Waiting for an available host session slot.", "the session-slot reason clears on launch");
  } finally { await h.close(); }
});
