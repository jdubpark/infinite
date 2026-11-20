import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, connect, type Server } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as egress from "../packages/host/src/egress.js";
// @ts-ignore -- a dependency-free script without type declarations
import { createEgressProxy } from "../scripts/egress-proxy.mjs";

const root = mkdtempSync(join(tmpdir(), "egress-eval-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const key = randomBytes(32);
const keyPath = join(root, "egress.key");
writeFileSync(keyPath, key, { mode: 0o600 });
const SESSION = "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71";
const SETUP_SECONDS = 900;
const HOSTS = ["api.example", "registry.example", "packages.example"];

async function echoServer() {
  const server = createNetServer(socket => { socket.pipe(socket); socket.on("error", () => {}); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

let fixtureCount = 0;
async function startProxy(policy: unknown) {
  const directory = join(root, `proxy-${++fixtureCount}`);
  mkdirSync(directory, { mode: 0o700 });
  const policyFile = join(directory, "policy.json");
  writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o644 });
  const records: Record<string, unknown>[] = [];
  const summaryFile = join(directory, "summary.json");
  const proxy = createEgressProxy({
    key, policyFile, summaryFile, limits: { summaryIntervalMs: 60_000 },
    log: (record: Record<string, unknown>) => records.push(record),
    resolve: async (host: string) => {
      if (!HOSTS.includes(host)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const loaded = await proxy.reload();
  const address = await proxy.listen({ host: "127.0.0.1", port: 0 });
  return { proxy, loaded, port: address.port as number, records, summaryFile };
}

/** The status of a CONNECT through the proxy, with the Proxy-Authorization header given. */
function connectStatus(port: number, target: string, authorization: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let head = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply for ${target}`)); }, 5000);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!head.includes("\r\n\r\n")) reject(new Error(`closed without a reply for ${target}`));
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
  });
}

/** The Basic header a proxy URL's user information stands for. */
function authorizationOf(proxyUrl: string | undefined): string {
  const url = new URL(proxyUrl ?? "http://missing.invalid");
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}

/** The project label of a proxy URL's credential: the part of the user name before the session. */
const projectOf = (proxyUrl: string | undefined) => decodeURIComponent(new URL(proxyUrl ?? "http://missing.invalid").username).split(".")[0];

function workerEnv(port: number, projectId: string, purpose?: string, nowMs?: number) {
  return egress.workerEgressEnvironment(projectId, SESSION, {
    INFINITE_EGRESS_PROXY_URL: `http://127.0.0.1:${port}`, INFINITE_EGRESS_KEY_FILE: keyPath,
  } as NodeJS.ProcessEnv, nowMs, purpose as never);
}

test("an eval session leaves the network only for its own list", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const allowPrivate = HOSTS.map(host => `${host}:${echo.port}`);
  const fixture = await startProxy({
    mode: "enforce", ports: [echo.port], allow: ["registry.example"], allowPrivate,
    projects: { _eval: { allow: ["api.example"] }, "_eval-setup": { allow: ["packages.example"] } },
  });
  t.after(() => fixture.proxy.close());
  t.after(() => egress.installHostEgress({}, {} as NodeJS.ProcessEnv));
  egress.installHostEgress({ autonomy: { boundary: { egress: { proxyUrl: `http://127.0.0.1:${fixture.port}`, keyPath } } } } as never, {} as NodeJS.ProcessEnv);
  assert.deepEqual(fixture.loaded, { mode: "enforce", error: null }, "the policy with the eval lists loads");

  // A replay session's credential is the eval identity, and reaches only its own list.
  const replay = workerEnv(fixture.port, "project-a", "replay");
  assert.equal(replay.status, "on");
  assert.equal(projectOf(replay.env.HTTPS_PROXY), "_eval", "a replay session mints the _eval identity");
  const replayAuth = authorizationOf(replay.env.HTTPS_PROXY);
  assert.equal(await connectStatus(fixture.port, `api.example:${echo.port}`, replayAuth), 200);
  assert.equal(await connectStatus(fixture.port, `registry.example:${echo.port}`, replayAuth), 403, "the host-wide allow list never applies to _eval");
  assert.equal(await connectStatus(fixture.port, `packages.example:${echo.port}`, replayAuth), 403);

  // The setup identity reaches only the package registries, and only for its lifetime.
  const setup = egress.evalProxyUrl("_eval-setup", SESSION, SETUP_SECONDS);
  assert.equal(projectOf(setup), "_eval-setup");
  const setupAuth = authorizationOf(setup);
  assert.equal(await connectStatus(fixture.port, `packages.example:${echo.port}`, setupAuth), 200);
  assert.equal(await connectStatus(fixture.port, `registry.example:${echo.port}`, setupAuth), 403);
  assert.equal(await connectStatus(fixture.port, `api.example:${echo.port}`, setupAuth), 403);
  const expired = egress.evalProxyUrl("_eval-setup", SESSION, SETUP_SECONDS, Date.now() - (SETUP_SECONDS + 1) * 1000);
  assert.equal(await connectStatus(fixture.port, `packages.example:${echo.port}`, authorizationOf(expired)), 407, "a setup credential past its 900 seconds is refused");

  // A work session keeps its project and its project's list, which here is the host-wide allow list.
  const work = workerEnv(fixture.port, "project-a", "work");
  assert.equal(projectOf(work.env.HTTPS_PROXY), "project-a", "a work session keeps its project");
  assert.equal(await connectStatus(fixture.port, `registry.example:${echo.port}`, authorizationOf(work.env.HTTPS_PROXY)), 200);

  // Without projects._eval, an eval credential reaches nothing, not even the host-wide list.
  const bare = await startProxy({ mode: "enforce", ports: [echo.port], allow: ["registry.example"], allowPrivate });
  t.after(() => bare.proxy.close());
  const bareReplay = workerEnv(bare.port, "project-a", "replay");
  assert.equal(await connectStatus(bare.port, `registry.example:${echo.port}`, authorizationOf(bareReplay.env.HTTPS_PROXY)), 403);
  assert.equal(await connectStatus(bare.port, `api.example:${echo.port}`, authorizationOf(bareReplay.env.HTTPS_PROXY)), 403);
});

test("a summary that holds eval traffic survives a reload", async t => {
  const fixture = await startProxy({ mode: "observe", ports: [443], allow: [], allowPrivate: [] });
  t.after(() => fixture.proxy.close());
  const day = new Date().toISOString().slice(0, 10);
  const projects = {
    "project-a": { "web.test": { allowed: 1 } },
    _eval: { "api.example": { allowed: 2 } },
    "_eval-setup": { "packages.example": { "would-deny": 1 } },
  };
  writeFileSync(fixture.summaryFile, JSON.stringify({
    schema: 1, updatedAt: new Date().toISOString(), mode: "observe", policy: { loadedAt: null, error: null },
    days: { [day]: { projects, dropped: {} } },
  }), { mode: 0o644 });
  await fixture.proxy.loadSummary();
  await fixture.proxy.flush();
  assert.ok(!fixture.records.some(record => record.event === "summary" && record.status === "reset"), "loading does not reset the summary");
  const written = JSON.parse(readFileSync(fixture.summaryFile, "utf8"));
  assert.deepEqual(written.days[day].projects, projects, "all three projects' counts are kept");
  const view = egress.egressView({ autonomy: { boundary: { egress: { summaryPath: fixture.summaryFile } } } } as never);
  assert.equal(view.summary, "available", "the host's egress view refuses a summary with eval projects");
  assert.deepEqual(view.projects.map(item => item.project).sort(), ["_eval", "_eval-setup", "project-a"]);
});

test("without the boundary no eval credential is minted", () => {
  egress.installHostEgress({}, {} as NodeJS.ProcessEnv);
  assert.equal(egress.evalProxyUrl("_eval", SESSION, 60), undefined);
});
