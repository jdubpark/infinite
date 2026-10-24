import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";
import { workerCall } from "../packages/host/src/ipc.js";

function alive(pid: number) {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch { return false; }
}

test("an already-running recording-error reviewer can be retired and replaced once", { timeout: 120000 }, async () => {
  const f = await fixture("reviewer-recording-error");
  const modes = new Map<string, number>();
  let holdPid = 0, descendantPid = 0, discoveredPid = 0, workerPid = 0;
  let unrelated: ReturnType<typeof spawn> | undefined;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id as string;
    await waitFor(() => existsSync(join(f.receipts, "reviewer-hold.json")), Boolean, 90000);
    const hold = JSON.parse(readFileSync(join(f.receipts, "reviewer-hold.json"), "utf8")) as { pid: number; descendantPid: number };
    holdPid = hold.pid; descendantPid = hold.descendantPid;
    let run = await f.get(id);
    const firstReviewer = run.members.find((member: any) => member.role === "reviewer")!;
    assert.ok(firstReviewer);
    workerPid = firstReviewer.workerPid ?? 0;
    const events = join(f.host.config.stateDir, "sessions", firstReviewer.sessionId, "events");
    const journals = readdirSync(events).filter(name => name.endsWith(".journal")).map(name => join(events, name));
    assert.ok(journals.length, "the recording journal exists before failure is injected");
    for (const journal of journals) { modes.set(journal, 0o600); chmodSync(journal, 0o400); }
    run = await waitFor(() => f.get(id), (value: any) => value.reason === "An agent runtime is unavailable; the team is waiting for confirmed state." &&
      value.members.some((member: any) => member.memberId === firstReviewer.memberId && member.status === "unavailable"), 30000);
    assert.ok(alive(holdPid) && alive(descendantPid), "the legacy reviewer and detached descendant remain alive after recording failure");
    const lease = await workerCall(f.host.config.runDir, firstReviewer.sessionId, { op: "control", action: "claim", actor: { id: "fixture-human", label: "Fixture human" } });
    const leased = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/runtime`, "owner");
    assert.equal(leased.status, 409, JSON.stringify(leased.body));
    assert.equal(leased.body.code, "control-busy");
    await workerCall(f.host.config.runDir, firstReviewer.sessionId, { op: "control", action: "release", leaseId: lease.id,
      actor: { id: "fixture-human", label: "Fixture human" } });
    const stop = await f.host.fetchApi(`/sessions/${firstReviewer.sessionId}/stop`, "owner", { requestId: randomUUID() });
    assert.notEqual(stop.status, 200, "the legacy worker stop route continues to reject recording-error");
    assert.ok(alive(holdPid) && alive(descendantPid));

    unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const inspected = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/runtime`, "owner");
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    workerPid = inspected.body.workerPid;
    const requestId = randomUUID();
    const body = { requestId, revision: run.revision, sessionId: firstReviewer.sessionId, identity: inspected.body.identity, text: "Confirmed the recording gap; preserve the original journal and obtain a fresh review." };
    const wrong = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", { ...body, requestId: randomUUID(), identity: "0".repeat(64) });
    assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
    assert.equal(wrong.body.code, "runtime-identity-changed");
    const stale = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", { ...body, requestId: randomUUID(), revision: run.revision + 1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "stale-team-revision");

    const originalPrefix = f.host.config.teams!.commandPrefix!;
    f.host.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--retirement-fail-prefix", f.receipts, String(workerPid)] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const interrupted = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", body);
    assert.equal(interrupted.status, 409, JSON.stringify(interrupted.body));
    assert.equal(interrupted.body.code, "retirement-boundary-unavailable");
    await waitFor(async () => !alive(workerPid), Boolean, 5000);
    assert.ok(existsSync(join(f.receipts, "retirement-failed-after-worker-exit")));
    discoveredPid = JSON.parse(readFileSync(join(f.receipts, "retirement-discovered-pid.json"), "utf8")).pid;
    assert.ok(alive(discoveredPid), "a new descendant appeared after the original inspection");
    f.host.config.teams!.commandPrefix = originalPrefix;
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();

    const retired = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", body);
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    await waitFor(() => !alive(holdPid) && !alive(descendantPid) && !alive(discoveredPid) && !alive(workerPid), Boolean, 10000);
    assert.ok(alive(unrelated.pid!), "unrelated process survives retirement");
    assert.ok(journals.every(path => existsSync(path)), "the failed journal is retained");
    const commands = readFileSync(join(f.receipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(commands.some(call => call.cwd === firstReviewer.cwd && call.command === process.execPath && call.args[0] === "-e"),
      "agent-owned process signals cross the configured team command boundary in the reviewer workspace");

    const finished = await f.settled(id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    const reviewers = finished.members.filter((member: any) => member.role === "reviewer");
    assert.equal(reviewers.length, 2);
    const retiredMember = reviewers.find((member: any) => member.memberId === firstReviewer.memberId);
    assert.equal(retiredMember.status, "stopped");
    assert.equal(retiredMember.report, undefined);
    assert.equal(retiredMember.retirement.identity, inspected.body.identity);
    assert.equal(retiredMember.retirement.seq, inspected.body.seq);
    assert.ok(retiredMember.retirement.processes >= 4, "the retry retained the newly discovered process identity");
    const replay = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.members.filter((member: any) => member.role === "reviewer").length, 2);
    const second = await f.host.fetchApi(`/teams/${id}/members/${firstReviewer.memberId}/retire`, "owner", { ...body, requestId: randomUUID() });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, "member-retirement-unavailable");
  } finally {
    for (const [path, mode] of modes) { try { chmodSync(path, mode); } catch { /* session cleanup may have removed it */ } }
    for (const pid of [holdPid, descendantPid, discoveredPid, workerPid]) if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    if (unrelated?.pid && alive(unrelated.pid)) { try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* already gone */ } }
    await f.close();
  }
});
