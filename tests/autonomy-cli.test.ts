import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleClientCommand } from "../packages/host/src/client.js";
import { startHost } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fixedRequestId = "123e4567-e89b-42d3-a456-426614174000";

type Recorded = { method: string; url: string; body: unknown };

/** A fake host that serves one project view and records every request. A PUT echoes the change as saved. */
async function withFakeHost(view: Record<string, unknown>, run: (requests: Recorded[], configPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "infinite-autonomy-cli-"));
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8"); req.on("data", chunk => data += chunk);
    req.on("end", () => {
      const body = data ? JSON.parse(data) : undefined;
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/projects/example/team" && req.method === "GET") res.end(JSON.stringify(view));
      else if (req.url === "/api/projects/example/autonomy" && req.method === "PUT") {
        const change = body as { revision: number; mode: string };
        res.end(JSON.stringify({ ...view, autonomy: change.mode, autonomySource: "saved", revision: change.revision + 1 }));
      } else { res.statusCode = 404; res.end(JSON.stringify({ code: "not-found" })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configPath = join(dir, "client.json");
  writeFileSync(configPath, JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, token: "x".repeat(32) }), { mode: 0o600 });
  try { await run(requests, configPath); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}

async function quiet<T>(fn: () => Promise<T>) {
  const log = console.log, error = console.error, logs: string[] = [], errors: string[] = [];
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try { await fn(); return { logs, errors }; }
  finally { console.log = log; console.error = error; }
}

test("autonomy mode prints the current mode", async () => {
  const view = { id: "example", revision: 3, autonomy: "autonomous", autonomySource: "host-default" };
  await withFakeHost(view, async (requests, configPath) => {
    const result = await quiet(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example"]));
    assert.match(result.logs.join("\n"), /autonomous \(host default\)/);
    assert.match(result.logs.join("\n"), /revision 3/);
    assert.deepEqual(requests.map(request => request.method), ["GET"]);
    assert.deepEqual(requests.map(request => request.url), ["/api/projects/example/team"]);
  });
});

test("autonomy mode sends one change at the current revision", async () => {
  const view = { id: "example", revision: 3, autonomy: "autonomous", autonomySource: "host-default" };
  await withFakeHost(view, async (requests, configPath) => {
    const invoke = (args: string[]) => quiet(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example", ...args]));
    const result = await invoke(["supervised"]);
    assert.deepEqual(requests.map(request => `${request.method} ${request.url}`), ["GET /api/projects/example/team", "PUT /api/projects/example/autonomy"]);
    const change = requests[1]!.body as { requestId: string; revision: number; mode: string };
    assert.deepEqual(Object.keys(change).sort(), ["mode", "requestId", "revision"]);
    assert.match(change.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(change.revision, 3);
    assert.equal(change.mode, "supervised");
    assert.ok(result.errors.some(line => line.includes(change.requestId)));

    await invoke(["supervised", "--revision", "5", "--request-id", fixedRequestId]);
    assert.deepEqual(requests[3]!.body, { requestId: fixedRequestId, revision: 5, mode: "supervised" });
  });
});

test("autonomy mode sends nothing for a mode already saved", async () => {
  await withFakeHost({ id: "example", revision: 2, autonomy: "supervised", autonomySource: "saved" }, async (requests, configPath) => {
    await quiet(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example", "supervised"]));
    assert.deepEqual(requests.map(request => request.method), ["GET"]);
  });
  await withFakeHost({ id: "example", revision: 2, autonomy: "supervised", autonomySource: "host-default" }, async (requests, configPath) => {
    await quiet(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example", "supervised"]));
    assert.deepEqual(requests.map(request => request.method), ["GET", "PUT"]);
  });
});

// The client prints a refusal as "[Infinite] ..." and sets exit code 1 instead of throwing.
async function refused(run: () => Promise<unknown>) {
  const before = process.exitCode;
  const result = await quiet(run);
  const code = process.exitCode;
  process.exitCode = before;
  assert.equal(code, 1, "the refusal sets exit code 1");
  return result.errors.join("\n");
}

test("autonomy mode refuses bad input before a change", async () => {
  const enrolled = { id: "example", revision: 1, autonomy: "autonomous", autonomySource: "host-default" };
  await withFakeHost(enrolled, async (requests, configPath) => {
    const invoke = (args: string[]) => handleClientCommand(["--client-config", configPath, "autonomy", "mode", ...args]);
    assert.match(await refused(() => invoke(["example", "auto"])), /supervised or autonomous/);
    assert.match(await refused(() => invoke(["Bad_Id", "supervised"])), /Project ID/);
    assert.deepEqual(requests, [], "a bad mode or project ID sends no request");
  });
  await withFakeHost({ id: "example", revision: 0, autonomy: "supervised", autonomySource: "not-enrolled" }, async (requests, configPath) => {
    assert.match(await refused(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example", "autonomous"])), /is not enrolled/);
    assert.deepEqual(requests.map(request => request.method), ["GET"]);
  });
  await withFakeHost({ id: "example", revision: 1 }, async (requests, configPath) => {
    assert.match(await refused(() => handleClientCommand(["--client-config", configPath, "autonomy", "mode", "example", "autonomous"])), /does not support autonomy modes/);
    assert.deepEqual(requests.map(request => request.method), ["GET"]);
  });
});

test("repo init sets, keeps, and validates the mode", { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-autonomy-init-"));
  const repoPath = join(root, "sample"), plainPath = join(root, "plain");
  mkdirSync(repoPath); mkdirSync(plainPath);
  git(repoPath, "init", "--initial-branch=main");
  writeFileSync(join(repoPath, "tracked.txt"), "committed\n");
  git(repoPath, "add", "tracked.txt");
  git(repoPath, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const checks = JSON.stringify([{ command: "git", args: ["status", "--short"] }]);
  const host = await startHost({ config: {
    projects: [{ id: "sample", name: "Sample", path: repoPath, team: { checks: [{ command: "git", args: ["status", "--short"] }] } }],
    teams: { workspaceDir: join(root, "team-workspaces") },
  } });
  const clientFile = join(host.root, "autonomy-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
  const cli = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const invoke = (args: string[]) => execFileSync(cli[0]!, [...cli.slice(1), "repo", "init", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const first = JSON.parse(invoke([repoPath, "--project", "sample", "--check-json", checks, "--autonomy", "supervised"]));
    assert.equal(first.autonomy, "supervised");
    assert.equal(first.autonomySource, "saved");
    assert.equal(first.revision, 1);

    const kept = JSON.parse(invoke([repoPath, "--project", "sample", "--check-json", checks]));
    assert.equal(kept.autonomy, "supervised");
    assert.equal(kept.autonomySource, "saved");
    assert.equal(kept.revision, 2);

    assert.throws(() => invoke([repoPath, "--project", "sample", "--check-json", checks, "--autonomy", "auto"]));
    assert.equal((await host.fetchApi("/projects/sample/team")).body.revision, 2, "an invalid mode leaves the enrollment unchanged");

    assert.throws(() => invoke([plainPath, "--autonomy", "supervised"]), (error: { stderr?: string }) => /--autonomy/.test(String(error.stderr)));
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
