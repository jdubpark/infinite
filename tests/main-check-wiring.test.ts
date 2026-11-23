import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { teamProjectSchema } from "../packages/host/src/team-types.js";
import { withoutMainCheck, type HandoffPolicy } from "../packages/host/src/handoff-types.js";
import { TeamService } from "../packages/host/src/teams.js";
import { Notifier } from "../packages/host/src/notifier.js";
import type { CheckSummary, MainCheckNotice } from "../packages/host/src/main-check.js";
import { emptyRecord, viewOf } from "../packages/host/src/main-check-state.js";
import { mainCheckRoute } from "../packages/host/src/main-check-route.js";

const command = { command: "node", args: ["--version"] };
const HEAD = "54b05b8c0ffee00ddba11c0ffee00ddba11c0ffe";
const NEXT = "9c1d2e3a0b1c2d3e4f5061728394a5b6c7d8e9f0";
const summary = (over: Partial<CheckSummary>): CheckSummary => ({
  head: HEAD, checks: "digest", observedAt: "2026-11-21T10:00:00.000Z", outcome: "failed", finishedAt: "2026-11-21T10:05:00.000Z", expected: 3, failed: { index: 2, exitCode: 1 }, ...over,
});

test("the schema accepts mainCheck with and without minutes and refuses what the setting does not allow", () => {
  const base = { checks: [command] };
  assert.equal(teamProjectSchema.safeParse({ ...base, mainCheck: {} }).success, true);
  assert.equal(teamProjectSchema.safeParse({ ...base, mainCheck: { minutes: 20 } }).success, true);
  assert.equal(teamProjectSchema.safeParse({ ...base, mainCheck: { minutes: 20, prefix: "x" } }).success, false, "an unknown key inside mainCheck is refused");
  assert.equal(teamProjectSchema.safeParse({ ...base, mainCheck: { minutes: 0 } }).success, false);
  const establish = teamProjectSchema.safeParse({ checks: [], establishChecks: true, mainCheck: {} });
  assert.equal(establish.success, false, "mainCheck is refused together with establishChecks");
  assert.deepEqual(establish.success ? [] : establish.error.issues.map(issue => issue.path.join(".")), ["mainCheck"]);
});

test("withoutMainCheck removes only the setting and leaves other teams unchanged", () => {
  const team = { checks: [command], mainCheck: { minutes: 20 } };
  assert.deepEqual(withoutMainCheck(team), { checks: [command] });
  assert.equal(withoutMainCheck(undefined), undefined);
});

test("assertHandoffPolicy accepts a policy taken before the main check was turned on or off", () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "inf-main-check-")));
  const profile = { command: "node", args: ["--version"] };
  const lineup = { coordinator: { id: "c", label: "C", provider: "claude", model: "m", effort: "high" }, implementers: [{ id: "i", label: "I", provider: "claude", model: "m", effort: "high" }], integrator: { id: "g", label: "G", provider: "claude", model: "m", effort: "high" }, reviewer: { id: "r", label: "R", provider: "claude", model: "m", effort: "high" } };
  const off = { checks: [command] };
  const on = { checks: [command], mainCheck: { minutes: 20 } };
  const policyFor = (project: object): HandoffPolicy => ({
    sourceSessionId: "00000000-0000-4000-8000-000000000001", projectId: "project", path, userRequest: "", lineup: lineup as never,
    project: project as never, workspaceDir: "/home/dev/projects/infinite/workspaces", maxMinutes: 60, maxMembers: 16, parallelism: 2,
  });
  const host = (team: object) => ({ config: { projects: [{ id: "project", path, team, linear: undefined }], teams: { workspaceDir: "/home/dev/projects/infinite/workspaces" }, agents: { claude: profile } } });
  const assertPolicy = (service: object, policy: HandoffPolicy) => TeamService.prototype.assertHandoffPolicy.call(service as never, policy);
  try {
    assert.doesNotThrow(() => assertPolicy(host(on), policyFor(off)), "a policy taken before the setting was turned on");
    assert.doesNotThrow(() => assertPolicy(host(off), policyFor(on)), "a policy taken before the setting was turned off");
    assert.throws(() => assertPolicy(host(on), policyFor({ checks: [{ command: "node", args: ["--test"] }] })), /Project authority changed/, "a changed check still refuses");
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("the owner's route answers the view, refuses other roles, and holds no directory, root or witness", async () => {
  const record = { ...emptyRecord(), running: { head: HEAD, checks: "digest", startedAt: "2026-11-21T10:00:00.000Z", directory: "PROJECT-2026-11-21-main-check-abcdef12", root: "/home/dev/workspaces", witness: { boot: "boot", processes: [] } as never, recording: true as const } };
  const team = { checks: [command], mainCheck: {} };
  const source = { mode: "github", repository: "example/project", baseBranch: "main" };
  const config = { teams: { workspaceDir: "/home/dev/workspaces" }, projects: [{ id: "project", team, source }, { id: "local", team }, { id: "unset", team: { checks: [command] }, source }] } as never;
  const app = express();
  // Stands in for the server's requireRole(["owner"]) gate, which the route is mounted behind.
  app.get("/api/projects/:id/main-check", (req, res, next) => (String(req.headers["x-role"]) === "owner" ? next() : void res.status(403).json({ error: "forbidden" })), mainCheckRoute(config, projectId => projectId === "project" ? viewOf(record, true) : undefined));
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const owner = await fetch(`${origin}/api/projects/project/main-check`, { headers: { "x-role": "owner" } });
    const body = await owner.text();
    assert.equal(owner.status, 200);
    assert.equal(JSON.parse(body).readable, true);
    assert.equal(JSON.parse(body).runnable, true);
    assert.equal(JSON.parse(body).running.head, HEAD);
    assert.doesNotMatch(body, /main-check-abcdef12|home\/dev|witness|"root"|directory/);
    const viewer = await fetch(`${origin}/api/projects/project/main-check`, { headers: { "x-role": "viewer" } });
    assert.equal(viewer.status, 403);
    const unknown = await fetch(`${origin}/api/projects/nope/main-check`, { headers: { "x-role": "owner" } });
    assert.equal(unknown.status, 404);
    const local = await (await fetch(`${origin}/api/projects/local/main-check`, { headers: { "x-role": "owner" } })).json();
    assert.deepEqual([local.readable, local.enabled, local.runnable, local.results, local.notice], [true, true, false, [], 0],
      "a project that does not follow GitHub answers the empty view and says the host never checks it");
    const unset = await (await fetch(`${origin}/api/projects/unset/main-check`, { headers: { "x-role": "owner" } })).json();
    assert.deepEqual([unset.enabled, unset.runnable], [false, true], "a project with no record and no setting answers the empty view, switched off");
  } finally { server.close(); }
});

type Ticket = { status: "ok" | "error"; details?: { error?: string }; message?: string };
type Sent = { to: string; title: string; body: string; collapseId: string; data: { url: string } };
type FixtureOptions = { events?: string[]; devices?: number; tickets?: (messages: Sent[]) => Ticket[] | Promise<never>; fuse?: boolean };
function notifierFixture(notices: MainCheckNotice[], options: FixtureOptions = {}) {
  const sent: Sent[][] = [];
  const accepted: unknown[] = [];
  const announced: string[][] = [];
  let asked = 0;
  const devices = Array.from({ length: options.devices ?? 1 }, (_, index) => ({ deviceId: `d${index}`, token: `ExponentPushToken[${index}]`, platform: "ios" as const, addedAt: "t" }));
  const sender = async (messages: Sent[]) => {
    sent.push(messages);
    if (options.tickets) return options.tickets(messages);
    return messages.map(() => ({ status: "ok" as const, id: "x" }));
  };
  const mainCheck = {
    notices: () => { asked += 1; return notices; },
    accepted: (projectId: string, notice: number, outcome: string) => { accepted.push([projectId, notice, outcome]); },
  };
  const trip = { tripId: "trip-1", scope: "host", label: "the whole host", cause: "limit", ownerClose: false, openedAt: "2026-11-21T10:00:00.000Z" };
  const fuse = options.fuse ? { interrupts: () => [trip], markAnnounced: (ids: string[]) => { announced.push(ids); } } : undefined;
  const notifier = new Notifier({ list: async () => [] } as never, { list: () => devices } as never, sender as never,
    { detail: "minimal", events: options.events ?? ["main-check", "autonomy-interrupt"], intervalMs: 100000 }, undefined, undefined, undefined, fuse as never, undefined, mainCheck as never);
  return { notifier, sent, accepted, announced, asked: () => asked };
}
const failedNotice = (): MainCheckNotice => ({ projectId: "project", label: "Example", notice: 1, outcome: "failed", summary: summary({}) });
const passedNotice = (): MainCheckNotice => ({ projectId: "project", label: "Example", notice: 2, outcome: "passed", summary: summary({ outcome: "passed", failed: undefined, expected: 3 }) });
const refusal = (): Ticket => ({ status: "error", details: { error: "InvalidCredentials" } });
const okFor = (wanted: (message: Sent) => boolean) => (messages: Sent[]): Ticket[] => messages.map(message => wanted(message) ? { status: "ok" } : refusal());

test("a failed main check sends the host's text, one message per device, and is accepted on an ok ticket", async () => {
  const fixture = notifierFixture([failedNotice()], { devices: 2 });
  await fixture.notifier.tick();
  const [messages] = fixture.sent;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].title, "Main is failing");
  assert.equal(messages[0].body, "Example: check 2 of 3 exited 1 at 54b05b8.");
  assert.equal(messages[0].collapseId, "main-check:project");
  assert.equal(messages[0].data.url, "/teams");
  assert.deepEqual(fixture.accepted, [["project", 1, "failed"]]);
});

test("a passed main check says all checks passed, with no text from command output", async () => {
  const fixture = notifierFixture([passedNotice()]);
  await fixture.notifier.tick();
  assert.equal(fixture.sent[0][0].title, "Main passes again");
  assert.equal(fixture.sent[0][0].body, "Example: all 3 checks passed at 54b05b8.");
  assert.deepEqual(fixture.accepted, [["project", 2, "passed"]]);
});

test("a notice that reached no device is not accepted, whether the push service refused it or the sender failed", async () => {
  const refusedTicket = notifierFixture([failedNotice()], { devices: 2, tickets: okFor(() => false) });
  await refusedTicket.notifier.tick();
  assert.equal(refusedTicket.sent.length, 1);
  assert.deepEqual(refusedTicket.accepted, []);

  const throwing = notifierFixture([failedNotice()], { tickets: () => Promise.reject(new Error("unreachable")) });
  await throwing.notifier.tick();
  assert.deepEqual(throwing.accepted, []);

  const oneOfTwo = notifierFixture([failedNotice()], { devices: 2, tickets: okFor(message => message.to === "ExponentPushToken[1]") });
  await oneOfTwo.notifier.tick();
  assert.deepEqual(oneOfTwo.accepted, [["project", 1, "failed"]], "one device that got the message is enough");
});

test("a main-check ticket and a fuse ticket are never taken for each other", async () => {
  const onlyMain = notifierFixture([failedNotice()], { devices: 2, fuse: true, tickets: okFor(message => message.collapseId === "main-check:project") });
  await onlyMain.notifier.tick();
  assert.deepEqual(onlyMain.sent[0].map(message => message.collapseId), ["main-check:project", "main-check:project", "interrupt:fuse:host", "interrupt:fuse:host"]);
  assert.deepEqual(onlyMain.accepted, [["project", 1, "failed"]]);
  assert.deepEqual(onlyMain.announced, []);

  const onlyFuse = notifierFixture([failedNotice()], { devices: 2, fuse: true, tickets: okFor(message => message.collapseId === "interrupt:fuse:host") });
  await onlyFuse.notifier.tick();
  assert.deepEqual(onlyFuse.accepted, []);
  assert.deepEqual(onlyFuse.announced, [["trip-1"]]);
});

test("with the event switched off no notice is taken; with no device a taken notice is neither sent nor accepted", async () => {
  const off = notifierFixture([failedNotice()], { events: ["needs-you"] });
  await off.notifier.tick();
  assert.equal(off.asked(), 0);
  assert.equal(off.sent.length, 0);

  const noDevice = notifierFixture([failedNotice()], { devices: 0 });
  await noDevice.notifier.tick();
  assert.equal(noDevice.asked(), 1);
  assert.equal(noDevice.sent.length, 0);
  assert.deepEqual(noDevice.accepted, []);
});
