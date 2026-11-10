import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClientCommand, parseClientArgs } from "../packages/host/src/client.js";
import type { Routine } from "../packages/host/src/routine-types.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const routine = {
  id: "routine-1", revision: 1, status: "scheduled",
  goal: { projectId: "sample", title: "Refresh docs", objective: "Improve docs", successCriteria: "Docs are clear", allowedPaths: ["docs"], nonGoals: [], evidence: [], maxRuns: 2, maxMinutes: 30, maxTotalMinutes: 45, maxMembers: 8, parallelism: 2 },
  intervalMinutes: 60, maxOccurrences: 4, startsAt: "2026-12-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", nextRunAt: "2026-12-01T00:00:00.000Z", occurrences: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
} as Routine;

async function withHost(run: (origin: string, requests: { method: string; url: string; body: unknown }[], configPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "infinite-routine-cli-"));
  const requests: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8"); req.on("data", chunk => data += chunk);
    req.on("end", () => {
      const body = data ? JSON.parse(data) : undefined;
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/routines" && req.method === "POST") res.end(JSON.stringify(routine));
      else if (req.url === "/api/routines" && req.method === "GET") res.end(JSON.stringify({ routines: [routine] }));
      else if (req.url === "/api/routines/routine-1" && req.method === "GET") res.end(JSON.stringify({ ...routine, status: "running", goal: { ...routine.goal, title: "Refresh\u001b[31mdocs" } }));
      else if (req.url === "/api/routines/routine-1/pause" && req.method === "POST") res.end(JSON.stringify({ ...routine, status: "paused", revision: 2 }));
      else { res.statusCode = 404; res.end(JSON.stringify({ code: "not-found" })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configDir = join(dir, "config"); mkdirSync(configDir);
  const configPath = join(configDir, "client.json");
  writeFileSync(configPath, JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, token: "x".repeat(32) }), { mode: 0o600 });
  try { await run(`http://127.0.0.1:${address.port}`, requests, configPath); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}

async function quiet<T>(fn: () => Promise<T>) {
  const log = console.log, error = console.error, logs: string[] = [], errors: string[] = [];
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try { await fn(); return { logs, errors }; }
  finally { console.log = log; console.error = error; }
}

test("routine CLI sends the stable create identity and keeps human output actionable", async () => {
  const args = ["routine", "create", "--file", "routine.json", "--request-id", requestId, "--json"];
  assert.deepEqual(parseClientArgs(args).args, ["create"]);
  await withHost(async (_origin, requests, configPath) => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-routine-file-"));
    try {
      const file = join(dir, "routine.json");
      writeFileSync(file, JSON.stringify({ goal: routine.goal, intervalMinutes: 60, maxOccurrences: 4, startsAt: routine.startsAt, expiresAt: routine.expiresAt }));
      const result = await quiet(() => handleClientCommand(["--client-config", configPath, "routine", "create", "--file", file, "--request-id", requestId, "--json"]));
      assert.ok(result.logs.some(line => line.includes('"id": "routine-1"')));
      assert.match(result.errors.join("\n"), new RegExp(requestId));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, "POST");
      assert.equal(requests[0]!.url, "/api/routines");
      assert.equal((requests[0]!.body as { requestId: string }).requestId, requestId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("routine list, status, and pause call their routes and sanitize terminal text", async () => {
  await withHost(async (_origin, requests, configPath) => {
    const dir = mkdtempSync(join(tmpdir(), "infinite-routine-commands-"));
    try {
      const invoke = (args: string[]) => quiet(() => handleClientCommand(["--client-config", configPath, ...args]));
      await invoke(["routine", "list"]);
      const status = await invoke(["routine", "status", "routine-1"]);
      assert.match(status.logs.join("\n"), /2 goal cycles · 45 min per occurrence · up to 8 members/);
      assert.match(status.logs.join("\n"), /revision 1/);
      assert.match(status.logs.join("\n"), /Next due/);
      assert.doesNotMatch(status.logs.join("\n"), /\u001b/);
      const paused = await invoke(["routine", "pause", "routine-1", "--revision", "1"]);
      assert.deepEqual(requests.map(request => request.url), ["/api/routines", "/api/routines/routine-1", "/api/routines/routine-1/pause"]);
      const action = requests[2]!.body as { requestId: string; revision: number };
      assert.match(action.requestId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(action, { requestId: action.requestId, revision: 1 });
      assert.ok(paused.errors.some(line => line.includes(action.requestId)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("routine creation rejects missing retry identity and unknown policy fields before network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-routine-invalid-"));
  try {
    const file = join(dir, "routine.json");
    writeFileSync(file, JSON.stringify({ goal: routine.goal, intervalMinutes: 60, maxOccurrences: 4, startsAt: routine.startsAt, expiresAt: routine.expiresAt, surprise: true }));
    const api = { json: async () => { throw new Error("network must not be called"); } };
    await assert.rejects(import("../packages/host/src/routine-cli.js").then(({ handleRoutineClientCommand }) => handleRoutineClientCommand(["create"], { "--file": file }, api)), /stable request ID/);
    await assert.rejects(import("../packages/host/src/routine-cli.js").then(({ handleRoutineClientCommand }) => handleRoutineClientCommand(["create"], { "--file": file, "--request-id": requestId }, api)), /Unrecognized key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
