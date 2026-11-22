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
  const config = { projects: [{ id: "project", team: { checks: [command], mainCheck: {} } }] } as never;
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
    assert.doesNotMatch(body, /main-check-abcdef12|home\/dev|witness|"root"|directory/);
    const viewer = await fetch(`${origin}/api/projects/project/main-check`, { headers: { "x-role": "viewer" } });
    assert.equal(viewer.status, 403);
    const unknown = await fetch(`${origin}/api/projects/nope/main-check`, { headers: { "x-role": "owner" } });
    assert.equal(unknown.status, 404);
    const empty = await fetch(`${origin}/api/projects/project/main-check`, { headers: { "x-role": "owner" } });
    assert.equal(empty.status, 200, "a project with no record yet answers the empty view");
  } finally { server.close(); }
});

type Ticket = { status: "ok" | "error"; details?: { error?: string }; message?: string };
function notifierFixture(notices: MainCheckNotice[] | (() => never), options: { events?: string[]; devices?: number; tickets?: (count: number) => Ticket[] | Promise<never> } = {}) {
  const sent: { to: string; title: string; body: string; collapseId: string; data: { url: string } }[][] = [];
  const accepted: unknown[] = [];
  const refused: unknown[] = [];
  let asked = 0;
  const devices = Array.from({ length: options.devices ?? 1 }, (_, index) => ({ deviceId: `d${index}`, token: `ExponentPushToken[${index}]`, platform: "ios" as const, addedAt: "t" }));
  const sender = async (messages: typeof sent[number]) => {
    sent.push(messages);
    if (options.tickets) return options.tickets(messages.length) as never;
    return messages.map(() => ({ status: "ok" as const, id: "x" }));
  };
  const mainCheck = {
    notices: () => { asked += 1; if (typeof notices === "function") return notices(); return notices; },
    accepted: (projectId: string, notice: number, outcome: string) => { accepted.push([projectId, notice, outcome]); },
    refused: (projectId: string, notice: number) => { refused.push([projectId, notice]); },
  };
  const notifier = new Notifier({ list: async () => [] } as never, { list: () => devices } as never, sender as never,
    { detail: "minimal", events: options.events ?? ["main-check"], intervalMs: 100000 }, undefined, undefined, undefined, undefined, undefined, mainCheck as never);
  return { notifier, sent, accepted, refused, asked: () => asked };
}
const failedNotice = (): MainCheckNotice => ({ projectId: "project", label: "Example", notice: 1, outcome: "failed", summary: summary({}) });
const passedNotice = (): MainCheckNotice => ({ projectId: "project", label: "Example", notice: 2, outcome: "passed", summary: summary({ outcome: "passed", failed: undefined, expected: 3 }) });

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
  assert.deepEqual(fixture.refused, []);
});

test("a passed main check says all checks passed, with no text from command output", async () => {
  const fixture = notifierFixture([passedNotice()]);
  await fixture.notifier.tick();
  assert.equal(fixture.sent[0][0].title, "Main passes again");
  assert.equal(fixture.sent[0][0].body, "Example: all 3 checks passed at 54b05b8.");
});

test("a refused ticket, a throwing sender and a notice without a summary are refused, and the last one is never sent", async () => {
  const refusedTicket = notifierFixture([failedNotice()], { tickets: count => Array.from({ length: count }, () => ({ status: "error" as const, details: { error: "InvalidCredentials" } })) });
  await refusedTicket.notifier.tick();
  assert.deepEqual(refusedTicket.refused, [["project", 1]]);
  assert.deepEqual(refusedTicket.accepted, []);

  const throwing = notifierFixture([failedNotice()], { tickets: () => Promise.reject(new Error("unreachable")) });
  await throwing.notifier.tick();
  assert.deepEqual(throwing.refused, [["project", 1]]);

  const bare = notifierFixture([{ projectId: "project", label: "Example", notice: 3, outcome: "failed" }]);
  await bare.notifier.tick();
  assert.deepEqual(bare.refused, [["project", 3]]);
  assert.equal(bare.sent.length, 0, "nothing is sent for a notice without a summary");
});

test("no device or the event switched off means notices are never asked for", async () => {
  const noDevice = notifierFixture([failedNotice()], { devices: 0 });
  await noDevice.notifier.tick();
  assert.equal(noDevice.asked(), 0);

  const off = notifierFixture([failedNotice()], { events: ["needs-you"] });
  await off.notifier.tick();
  assert.equal(off.asked(), 0);
  assert.equal(off.sent.length, 0);
});
