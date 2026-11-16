import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, connect, Socket, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { egressCredential } from "../packages/host/src/egress.js";
// @ts-ignore -- a dependency-free script without type declarations
import { EgressSummary, classifyAddress, createEgressProxy, parseAuthority } from "../scripts/egress-proxy.mjs";

const root = mkdtempSync(join(tmpdir(), "egress-proxy-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const key = randomBytes(32);
const SESSION = "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71";
const OTHER = "6f1d2c3b-1111-4222-8333-944455566677";

function basic(project: string, session: string, options: { key?: Buffer; expires?: number } = {}) {
  const { username, password } = egressCredential(options.key ?? key, project, session, options.expires ?? Math.floor(Date.now() / 1000) + 3600);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function listening(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A TCP echo server that counts the connections it accepted. */
async function echoServer() {
  const state = { connections: 0 };
  const server = createNetServer(socket => { state.connections += 1; socket.pipe(socket); socket.on("error", () => {}); });
  return { server, state, port: await listening(server) };
}

let fixtureCount = 0;
async function startProxy(policy: unknown, names: Record<string, string[]> = {}, limits: Record<string, number> = {}, overrides: Record<string, unknown> = {}) {
  const directory = join(root, `proxy-${++fixtureCount}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(directory, { mode: 0o700 });
  const policyFile = join(directory, "policy.json");
  const summaryFile = join(directory, "summary.json");
  writeFileSync(policyFile, typeof policy === "string" ? policy : JSON.stringify(policy), { mode: 0o644 });
  const records: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const proxy = createEgressProxy({
    key, policyFile, summaryFile, limits: { summaryIntervalMs: 60_000, ...limits },
    log: (record: Record<string, unknown>) => records.push(record),
    resolve: async (host: string) => {
      lookups.push(host);
      const addresses = names[host];
      if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    ...overrides,
  });
  await proxy.reload();
  const address = await proxy.listen({ host: "127.0.0.1", port: 0 });
  return { proxy, port: address.port as number, records, lookups, policyFile, summaryFile };
}

interface Reply { status: number; head: string; body: string; socket: Socket }
/** Sends raw bytes to the proxy and reads the response head; for a non-200 reply, the body until close. */
function send(port: number, raw: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    let head: string | undefined;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("no reply")); }, 5000);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (head !== undefined) return;
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      head = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 4);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
      if (status === 200 && /^CONNECT /.test(raw)) {
        clearTimeout(timer);
        socket.pause();
        socket.removeAllListeners("data");
        resolve({ status, head, body: buffer.toString("utf8"), socket });
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (head === undefined) { reject(new Error("closed without a reply")); return; }
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), head, body: buffer.toString("utf8"), socket });
    });
    socket.write(raw);
  });
}

const connectRequest = (target: string, authorization?: string, extra = "") =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n${extra}`;

function readExactly(socket: Socket, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error(`read ${JSON.stringify(data)}`)), 5000);
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length < length) return;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      resolve(data);
    };
    socket.on("data", onData);
    socket.resume();
  });
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("observe mode tunnels an unlisted host, forwards bytes sent with the CONNECT, and records would-deny", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const fixture = await startProxy({ mode: "observe", ports: [echo.port], allow: [], allowPrivate: [`echo.test:${echo.port}`] }, { "echo.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  const reply = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, authorization, "early"));
  assert.equal(reply.status, 200);
  const echoed = reply.body.length >= 5 ? reply.body : reply.body + await readExactly(reply.socket, 5 - reply.body.length);
  assert.equal(echoed, "early");
  reply.socket.write("ping");
  assert.equal(await readExactly(reply.socket, 4), "ping");
  reply.socket.end();
  await until(() => fixture.records.some(record => record.kind === "connect"), "the tunnel record");
  const record = fixture.records.find(item => item.kind === "connect")!;
  assert.deepEqual(
    { project: record.project, session: record.session, host: record.host, port: record.port, decision: record.decision, reason: record.reason, bytesUp: record.bytesUp, bytesDown: record.bytesDown, address: record.address },
    { project: "project-a", session: SESSION, host: "echo.test", port: echo.port, decision: "would-deny", reason: "not-listed", bytesUp: 9, bytesDown: 9, address: "127.0.0.1" },
  );
  assert.equal(typeof record.durationMs, "number");
  assert.deepEqual(fixture.lookups, ["echo.test"], "the name is resolved once");
  const logged = JSON.stringify(fixture.records);
  assert.ok(!logged.includes(authorization.slice(6)) && !logged.includes("v1."), "credentials never reach the records");
});

test("enforce refuses an unlisted host before resolving it, and tunnels a listed one", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const policy = { mode: "enforce", ports: [echo.port], allow: ["other.test", "*.svc.test"], allowPrivate: [`echo.test:${echo.port}`, `a.svc.test:${echo.port}`] };
  const fixture = await startProxy(policy, { "echo.test": ["127.0.0.1"], "a.svc.test": ["127.0.0.1"], "svc.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  const refused = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, authorization, "secret-bytes"));
  assert.equal(refused.status, 403);
  assert.match(refused.body, /echo\.test/);
  assert.equal(echo.state.connections, 0);
  assert.deepEqual(fixture.lookups, [], "enforce never resolves a name it refuses");
  assert.equal(fixture.records.at(-1)?.decision, "refused");
  assert.equal(fixture.records.at(-1)?.reason, "not-listed");
  // A wildcard covers subdomains only.
  assert.equal((await send(fixture.port, connectRequest(`svc.test:${echo.port}`, authorization))).status, 403);
  const wildcard = await send(fixture.port, connectRequest(`a.svc.test:${echo.port}`, authorization));
  assert.equal(wildcard.status, 200);
  wildcard.socket.destroy();

  writeFileSync(fixture.policyFile, JSON.stringify({ ...policy, allow: [], projects: { "project-a": { allow: ["echo.test"] } } }));
  assert.deepEqual(await fixture.proxy.reload(), { mode: "enforce", error: null });
  const listed = await send(fixture.port, connectRequest(`ECHO.Test.:${echo.port}`, authorization));
  assert.equal(listed.status, 200, "a project's own additions apply, after case and trailing-dot normalization");
  listed.socket.write("hi");
  assert.equal(await readExactly(listed.socket, 2), "hi");
  listed.socket.destroy();
  assert.equal((await send(fixture.port, connectRequest(`echo.test:${echo.port}`, basic("project-b", SESSION)))).status, 403, "another project's additions do not apply");
  await until(() => fixture.records.some(record => record.decision === "allowed" && record.host === "echo.test"), "the allowed record");
});

test("refuses loopback, private, shared, link-local, metadata, multicast, unspecified, and IPv6 forms in both modes", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const names = {
    "private.test": ["10.1.2.3"], "metadata.test": ["169.254.169.254"], "cgnat.test": ["100.100.1.1"], "loop.test": ["127.0.0.1"],
    "localhost": ["127.0.0.1"], "mapped.test": ["::ffff:127.0.0.1"], "ula.test": ["fd00:ec2::254"], "multicast.test": ["224.0.0.251"],
    "zero.test": ["0.0.0.0"], "linklocal6.test": ["fe80::1"], "mixed.test": ["2606:4700:4700::1111", "192.168.1.10"],
  };
  // Every destination is listed, so the refusals below come from the address check alone, in enforce mode too.
  const literals = ["127.0.0.1", "[::1]", "[::ffff:7f00:1]", "[64:ff9b::a9fe:a9fe]", "169.254.169.254", "[fe80::1]", "[::]"];
  for (const mode of ["observe", "enforce"]) {
    const fixture = await startProxy({ mode, ports: [443], allow: [...Object.keys(names), ...literals] }, names);
    const authorization = basic("project-a", SESSION);
    const targets = [
      ...Object.keys(names).map(name => `${name}:443`),
      "LocalHost.:443", "127.0.0.1:443", "[::1]:443", "2130706433:443", "0x7f.1:443", "0177.0.0.1:443", "127.1:443",
      "[::ffff:127.0.0.1]:443", "[::ffff:7f00:1]:443", "[64:ff9b::a9fe:a9fe]:443", "169.254.169.254:443", "[fe80::1]:443", "[::]:443",
    ];
    for (const target of targets) {
      const reply = await send(fixture.port, connectRequest(target, authorization));
      assert.equal(reply.status, 403, `${mode} ${target}`);
      assert.match(String(fixture.records.at(-1)?.reason), /^address-/, `${mode} ${target}`);
      assert.equal(fixture.records.at(-1)?.decision, "refused");
    }
    assert.equal(echo.state.connections, 0);
    // Each name was looked up exactly once, and an address literal never goes to the resolver.
    assert.deepEqual([...fixture.lookups].sort(), [...Object.keys(names), "localhost"].sort());
    await fixture.proxy.close();
  }
  assert.equal(classifyAddress("2606:4700:4700::1111"), undefined, "a global unicast address is allowed");
  for (const [address, expected] of [["169.254.169.254", "link-local"], ["100.64.0.1", "shared"], ["::ffff:10.0.0.1", "private"], ["2001:db8::1", "reserved"], ["2002:7f00:1::1", "reserved"], ["2001::1", "reserved"], ["ff02::1", "multicast"]])
    assert.equal(classifyAddress(address), expected, address);
});

test("refuses malformed targets and ports outside the policy", async t => {
  const fixture = await startProxy({ mode: "observe", allow: [] }, { "echo.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  for (const target of ["user@echo.test:443", "user:pass@echo.test:443", "echo.test", "echo.test:0443", "echo.test:70000", "echo.test:", "[::1", "::1:443", "[fe80::1%25eth0]:443", "example.1:443", "exa%6dple.test:443", "a..b:443", "echo.test:443/path", "-:443"]) {
    const reply = await send(fixture.port, connectRequest(target, authorization));
    assert.equal(reply.status, 400, target);
    // The proxy refuses what Node's HTTP parser accepts; the parser itself refuses the rest.
    assert.ok(["bad-target", "bad-request"].includes(String(fixture.records.at(-1)?.reason)), target);
    assert.equal(fixture.records.at(-1)?.host, null, "a target that does not parse is not logged");
  }
  const port = await send(fixture.port, connectRequest("echo.test:22", authorization));
  assert.equal(port.status, 403);
  assert.equal(fixture.records.at(-1)?.reason, "port");
  assert.deepEqual(fixture.lookups, []);
  assert.equal(parseAuthority("[2001:DB8:0:0::1]:443").host, "2001:db8::1");
});

test("answers missing, forged, expired, and malformed credentials with 407 and records them as unauthenticated", async t => {
  const fixture = await startProxy({ mode: "observe", allow: [] }, { "echo.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const now = Math.floor(Date.now() / 1000);
  const good = basic("project-a", SESSION);
  const decoded = Buffer.from(good.slice(6), "base64").toString();
  const cases = {
    missing: undefined,
    "another key": basic("project-a", SESSION, { key: randomBytes(32) }),
    expired: basic("project-a", SESSION, { expires: now - 1 }),
    "too far ahead": basic("project-a", SESSION, { expires: now + 400 * 86400 }),
    "session swapped": `Basic ${Buffer.from(decoded.replace(SESSION, OTHER)).toString("base64")}`,
    "project swapped": `Basic ${Buffer.from(decoded.replace("project-a.", "project-b.")).toString("base64")}`,
    bearer: `Bearer ${good.slice(6)}`,
    garbage: "Basic !!!!",
  };
  for (const [label, authorization] of Object.entries(cases)) {
    const reply = await send(fixture.port, connectRequest("echo.test:443", authorization));
    assert.equal(reply.status, 407, label);
    assert.match(reply.head, /Proxy-Authenticate: Basic realm="infinite-egress"/, label);
    const record = fixture.records.at(-1)!;
    assert.equal(record.decision, "unauthenticated", label);
    assert.equal(record.project, null, label);
  }
  assert.deepEqual(fixture.lookups, [], "no lookup happens before authentication");
  assert.ok(!JSON.stringify(fixture.records).includes("v1."), "no credential text is recorded");
});

test("plain HTTP is forwarded by checked address with the URI's Host, and neither the path nor the query reaches records or the summary", async t => {
  const seen: { url?: string; host?: string; proxyAuthorization?: string; dropped?: string | string[]; kept?: string | string[] }[] = [];
  const web = createHttpServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, proxyAuthorization: req.headers["proxy-authorization"], dropped: req.headers["x-drop"], kept: req.headers["constructor"] });
    res.end("hello");
  });
  const webPort = await listening(web);
  t.after(() => web.close());
  const fixture = await startProxy({ mode: "observe", ports: [webPort], allow: ["web.test"], allowPrivate: [`web.test:${webPort}`] }, { "web.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  const reply = await send(fixture.port, `GET http://web.test:${webPort}/private/path?token=SECRET123 HTTP/1.1\r\nHost: web.test:${webPort}\r\nProxy-Authorization: ${authorization}\r\nConnection: keep-alive, x-drop\r\nX-Drop: 1\r\nConstructor: kept\r\n\r\n`);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /hello/);
  assert.deepEqual(seen, [{ url: "/private/path?token=SECRET123", host: `web.test:${webPort}`, proxyAuthorization: undefined, dropped: undefined, kept: "kept" }]);
  const mismatch = await send(fixture.port, `GET http://web.test:${webPort}/ HTTP/1.1\r\nHost: other.test\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
  assert.equal(mismatch.status, 400);
  assert.equal(fixture.records.at(-1)?.reason, "host-mismatch");
  const https = await send(fixture.port, `GET https://web.test/ HTTP/1.1\r\nHost: web.test\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
  assert.equal(https.status, 400);
  assert.equal(seen.length, 1);
  await until(() => fixture.records.some(record => record.kind === "http" && record.decision === "allowed"), "the HTTP record");
  await fixture.proxy.flush();
  const summary = readFileSync(fixture.summaryFile, "utf8");
  for (const text of [JSON.stringify(fixture.records), summary]) {
    assert.ok(!/private\/path|SECRET123|token|x-drop/i.test(text), "no path, query, or header text is kept");
  }
  const parsed = JSON.parse(summary);
  assert.equal(parsed.mode, "observe");
  const today = Object.keys(parsed.days)[0];
  assert.deepEqual(parsed.days[today].projects["project-a"]["web.test"], { allowed: 1, refused: 1 });
});

test("a policy that fails to load keeps the last good one; with none, every destination is refused", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const fixture = await startProxy("{not json", { "echo.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  assert.equal(fixture.proxy.state().mode, null);
  const none = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, authorization));
  assert.equal(none.status, 403);
  assert.equal(fixture.records.at(-1)?.reason, "no-policy");

  writeFileSync(fixture.policyFile, JSON.stringify({ mode: "observe", ports: [echo.port], allow: [], allowPrivate: [`echo.test:${echo.port}`] }));
  assert.deepEqual(await fixture.proxy.reload(), { mode: "observe", error: null });
  for (const broken of ["{", JSON.stringify({ mode: "observe", allow: [], extra: true }), JSON.stringify({ mode: "block", allow: [] }), JSON.stringify({ mode: "enforce", allow: ["*.com"] }), JSON.stringify({ mode: "enforce", allow: [], ports: [0] })]) {
    writeFileSync(fixture.policyFile, broken);
    const result = await fixture.proxy.reload();
    assert.equal(result.mode, "observe", broken);
    assert.ok(result.error, broken);
  }
  const still = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, authorization));
  assert.equal(still.status, 200, "the last good observe policy still applies");
  still.socket.destroy();
  await fixture.proxy.flush();
  const summary = JSON.parse(readFileSync(fixture.summaryFile, "utf8"));
  assert.equal(summary.mode, "observe");
  assert.match(summary.policy.error, /^policy-/);
});

test("the summary keeps at most 2,000 host entries per day and 14 days", () => {
  const summary = new EgressSummary();
  for (let index = 0; index < 2100; index++) summary.add("2026-11-01", index % 2 ? "project-a" : "project-b", `host-${index}.example.test`, "would-deny");
  summary.add("2026-11-01", "project-a", "host-1.example.test", "allowed");
  const first = summary.toJSON()["2026-11-01"];
  const entries = Object.values(first.projects).reduce((sum: number, hosts) => sum + Object.keys(hosts as object).length, 0);
  assert.equal(entries, 2000);
  assert.deepEqual(first.dropped, { "would-deny": 100 });
  assert.deepEqual(first.projects["project-a"]["host-1.example.test"], { "would-deny": 1, allowed: 1 });
  for (let day = 2; day <= 20; day++) summary.add(`2026-11-${String(day).padStart(2, "0")}`, "project-a", "api.example.test", "allowed");
  const days = Object.keys(summary.toJSON());
  assert.equal(days.length, 14);
  assert.equal(days[0], "2026-11-07");
  summary.add("2026-11-01", "project-a", "late.example.test", "allowed");
  assert.equal(Object.keys(summary.toJSON())[0], "2026-11-07", "a day older than the retained window is not reopened");
  const restored = EgressSummary.from(summary.toJSON());
  assert.deepEqual(restored.toJSON(), summary.toJSON());
  assert.throws(() => EgressSummary.from({ "2026-11-01": { projects: { "project-a": { "/etc/passwd": { allowed: 1 } } }, dropped: {} } }));
});

test("oversized headers are refused and per-session tunnel limits hold", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const fixture = await startProxy({ mode: "observe", ports: [echo.port], allow: [], allowPrivate: [`echo.test:${echo.port}`] }, { "echo.test": ["127.0.0.1"] }, { maxTunnelsPerSession: 1 });
  t.after(() => fixture.proxy.close());
  const large = await send(fixture.port, `CONNECT echo.test:${echo.port} HTTP/1.1\r\nX-Fill: ${"a".repeat(12 * 1024)}\r\n\r\n`);
  assert.equal(large.status, 431);
  assert.equal(fixture.records.at(-1)?.reason, "header-too-large");
  const first = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, basic("project-a", SESSION)));
  assert.equal(first.status, 200);
  const second = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, basic("project-a", SESSION)));
  assert.equal(second.status, 429);
  const otherSession = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, basic("project-a", OTHER)));
  assert.equal(otherSession.status, 200);
  first.socket.destroy();
  otherSession.socket.destroy();
  await until(() => fixture.proxy.state().open === 0, "slots to be released");
  const again = await send(fixture.port, connectRequest(`echo.test:${echo.port}`, basic("project-a", SESSION)));
  assert.equal(again.status, 200);
  again.socket.destroy();
});

test("clients that disconnect at once cannot pile up name lookups outside the session and global limits", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  // The reviewer's case: lookups that do not settle on their own, and clients that leave as soon as they have asked.
  const waiting: (() => void)[] = [];
  const calls: string[] = [];
  const resolve = (host: string) => {
    calls.push(host);
    const answer = [{ address: "127.0.0.1", family: 4 }];
    if (host === "fast.test") return Promise.resolve(answer);
    return new Promise(done => waiting.push(() => done(answer)));
  };
  const fixture = await startProxy({ mode: "observe", ports: [echo.port], allow: [], allowPrivate: [`fast.test:${echo.port}`] }, {},
    { maxLookups: 6, maxLookupsPerSession: 3, maxTunnelsPerSession: 8, dnsTimeoutMs: 50 }, { resolve });
  t.after(() => fixture.proxy.close());
  const records = (session: string) => fixture.records.filter(record => record.session === session);
  const askAndLeave = (session: string, count: number, prefix: string) => {
    for (let index = 0; index < count; index++) {
      const socket = connect(fixture.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(connectRequest(`${prefix}-${index}.test:${echo.port}`, basic("project-a", session)), () => socket.destroy());
    }
  };

  askAndLeave(SESSION, 40, "slow");
  await until(() => records(SESSION).length === 40, "every request from the first session to be decided");
  assert.equal(calls.length, 3, "one session starts at most its own lookup limit");
  assert.deepEqual(fixture.proxy.state(), { mode: "observe", policyError: null, open: 3, sessions: 1, lookups: 3 }, "timed-out lookups still hold their slots");
  assert.equal(records(SESSION).filter(record => record.reason === "dns-timeout").length, 3);
  assert.ok(records(SESSION).every(record => ["dns-timeout", "dns-busy", "too-many-connections"].includes(record.reason as string)));

  // Another session is not starved: its lookups have their own allowance.
  const other = await send(fixture.port, connectRequest(`fast.test:${echo.port}`, basic("project-a", OTHER)));
  assert.equal(other.status, 200);
  other.socket.destroy();
  askAndLeave(OTHER, 10, "other");
  await until(() => records(OTHER).length === 11, "every request from the second session to be decided");
  assert.equal(fixture.proxy.state().lookups, 6);
  // The global limit holds for a third session, but a name already being looked up is shared, not looked up again.
  const third = "7a2b3c4d-2222-4333-8444-955566677788";
  const busy = await send(fixture.port, connectRequest(`new.test:${echo.port}`, basic("project-a", third)));
  assert.equal(busy.status, 503);
  assert.equal(fixture.records.at(-1)?.reason, "dns-busy");
  const joined = await send(fixture.port, connectRequest(`slow-0.test:${echo.port}`, basic("project-a", third)));
  assert.equal(joined.status, 504);
  assert.equal(calls.length, 7, "the shared name was not looked up again");

  for (const settle of waiting.splice(0)) settle();
  await until(() => { const state = fixture.proxy.state(); return state.open === 0 && state.sessions === 0 && state.lookups === 0; }, "all slots and lookups to be released");
});

test("bytes sent with the CONNECT count toward the limit on what a client may send before the tunnel opens", async t => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  // Each lookup waits, so the tunnel cannot open while the client sends.
  const waiting: (() => void)[] = [];
  const resolve = () => new Promise(done => waiting.push(() => done([{ address: "127.0.0.1", family: 4 }])));
  const allowPrivate = [`over.test:${echo.port}`, `within.test:${echo.port}`];
  const fixture = await startProxy({ mode: "observe", ports: [echo.port], allow: [], allowPrivate }, {}, {}, { resolve });
  t.after(() => { for (const settle of waiting.splice(0)) settle(); return fixture.proxy.close(); });
  const limit = 64 * 1024;
  const open = (host: string, extra: number) => {
    const socket = connect(fixture.port, "127.0.0.1");
    socket.on("error", () => {});
    socket.resume();
    // One write: the first read carries the head and the start of these bytes, and the rest follow it.
    socket.write(connectRequest(`${host}:${echo.port}`, basic("project-a", SESSION), "x".repeat(extra)));
    return socket;
  };

  const over = open("over.test", limit + 1);
  await until(() => over.destroyed, "the proxy to drop a client that sent more than the limit");
  for (const settle of waiting.splice(0)) settle();
  await until(() => fixture.proxy.state().open === 0, "its slot to be released");
  assert.equal(fixture.records.at(-1)?.reason, "client-closed");
  assert.equal(echo.state.connections, 0);

  // Exactly the limit is kept and reaches the destination once the tunnel opens.
  const within = open("within.test", limit);
  let echoed = 0;
  within.on("data", chunk => { echoed += chunk.length; });
  await until(() => waiting.length === 1, "the second lookup to start");
  await new Promise(done => setTimeout(done, 100));
  assert.equal(within.destroyed, false);
  for (const settle of waiting.splice(0)) settle();
  const reply = "HTTP/1.1 200 Connection established\r\n\r\n".length;
  await until(() => echoed === reply + limit, "every early byte to come back through the tunnel");
  within.destroy();
});

test("a pending upstream connection is cancelled when its client goes away", async t => {
  const attempts: Socket[] = [];
  const fixture = await startProxy({ mode: "observe", ports: [443], allow: [], allowPrivate: ["hang.test:443"] }, { "hang.test": ["192.0.2.10"] },
    { connectTimeoutMs: 60_000 }, { connect: () => { const socket = new Socket(); attempts.push(socket); return socket; } });
  t.after(() => fixture.proxy.close());
  const client = connect(fixture.port, "127.0.0.1");
  client.on("error", () => {});
  client.write(connectRequest("hang.test:443", basic("project-a", SESSION)));
  await until(() => attempts.length === 1, "the upstream attempt");
  assert.equal(fixture.proxy.state().open, 1);
  client.destroy();
  await until(() => attempts[0].destroyed, "the attempt to be cancelled, long before its timeout");
  await until(() => fixture.proxy.state().open === 0, "the slot to be released");
  await until(() => fixture.records.some(record => record.reason === "client-closed"), "the record");

  // The same for plain HTTP, and for a CONNECT client that only half-closes.
  for (const [index, raw] of [
    `GET http://hang.test:443/ HTTP/1.1\r\nHost: hang.test:443\r\nProxy-Authorization: ${basic("project-a", SESSION)}\r\n\r\n`,
    connectRequest("hang.test:443", basic("project-a", SESSION)),
  ].entries()) {
    const next = connect(fixture.port, "127.0.0.1");
    next.on("error", () => {});
    next.write(raw);
    await until(() => attempts.length === index + 2, "the next upstream attempt");
    if (index === 0) next.destroy();
    else next.end();
    await until(() => attempts[index + 1].destroyed, "the next attempt to be cancelled");
    await until(() => fixture.proxy.state().open === 0, "the slot to be released again");
    next.destroy();
  }
});

test("an address that never answers does not hold the connection: the other family starts after a short delay", async t => {
  // A host whose IPv6 route drops packets: the resolver lists IPv6 first, and a SYN to it neither connects nor fails.
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const target = `dual.test:${echo.port}`;
  const attempts: { host: string; socket: Socket }[] = [];
  const fixture = await startProxy({ mode: "observe", ports: [echo.port], allow: [], allowPrivate: [target] },
    { "dual.test": ["2001:db8::1", "2001:db8::2", "127.0.0.1"] }, { connectTimeoutMs: 60_000 },
    { connect: (options: { host: string; port: number }) => {
      const socket = options.host.includes(":") ? new Socket() : connect(options.port, options.host);
      attempts.push({ host: options.host, socket });
      return socket;
    } });
  t.after(() => fixture.proxy.close());
  const started = Date.now();
  const reply = await send(fixture.port, connectRequest(target, basic("project-a", SESSION)));
  assert.equal(reply.status, 200);
  assert.ok(Date.now() - started < 5_000, "the tunnel opened long before the connect timeout");
  // Families alternate, so the IPv4 address is the second attempt rather than the last.
  assert.deepEqual(attempts.map(attempt => attempt.host), ["2001:db8::1", "127.0.0.1"]);
  await until(() => attempts[0].socket.destroyed, "the losing attempt to be destroyed");
  reply.socket.write("ping");
  assert.equal(await readExactly(reply.socket, 4), "ping");
  reply.socket.destroy();
  await until(() => fixture.records.some(record => record.address === "127.0.0.1" && record.decision === "would-deny"), "the record of the address used");
});

test("a failed address moves on at once, and every address failing ends the attempt", async t => {
  const attempts: string[] = [];
  const refuse = (host: string) => {
    const socket = new Socket();
    attempts.push(host);
    setImmediate(() => socket.destroy(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    return socket;
  };
  const fixture = await startProxy({ mode: "observe", ports: [443], allow: [], allowPrivate: ["down.test:443"] },
    { "down.test": ["2001:db8::1", "192.0.2.10", "192.0.2.11"] }, { connectTimeoutMs: 60_000, attemptDelayMs: 60_000 },
    { connect: (options: { host: string }) => refuse(options.host) });
  t.after(() => fixture.proxy.close());
  // The stagger delay is a minute, so only a failure can start the next attempt in time.
  const started = Date.now();
  const reply = await send(fixture.port, connectRequest("down.test:443", basic("project-a", SESSION)));
  assert.equal(reply.status, 502);
  assert.ok(Date.now() - started < 2_000, "each failure started the next attempt without waiting for the stagger delay");
  assert.deepEqual(attempts, ["2001:db8::1", "192.0.2.10", "192.0.2.11"]);
  await until(() => fixture.records.some(record => record.reason === "connect-failed"), "the record");
  await until(() => fixture.proxy.state().open === 0, "the slot to be released");
});

test("a name with many silent addresses keeps at most four upstream attempts open and still tries every address", async t => {
  const names = Array.from({ length: 10 }, (_, i) => `2001:db8::${i + 1}`);
  const attempts: Socket[] = [];
  let mostOpen = 0;
  const fixture = await startProxy({ mode: "observe", ports: [443], allow: [], allowPrivate: ["silent.test:443"] },
    { "silent.test": names }, { connectTimeoutMs: 2_000, attemptDelayMs: 10 },
    { connect: () => {
      const socket = new Socket();
      attempts.push(socket);
      mostOpen = Math.max(mostOpen, attempts.filter(attempt => !attempt.destroyed).length);
      return socket;
    } });
  t.after(() => fixture.proxy.close());
  const reply = await send(fixture.port, connectRequest("silent.test:443", basic("project-a", SESSION)));
  assert.equal(reply.status, 504);
  assert.equal(attempts.length, names.length);
  assert.equal(mostOpen, 4);
  await until(() => attempts.every(attempt => attempt.destroyed), "every attempt to be destroyed");
  await until(() => fixture.proxy.state().open === 0, "the slot to be released");
});

test("plain HTTP sets the forwarded body's framing for every method and refuses ambiguous framing", async t => {
  const seen: { method?: string; te?: string; cl?: string; body: string }[] = [];
  let upstreamErrors = 0;
  const web = createHttpServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, te: req.headers["transfer-encoding"], cl: req.headers["content-length"], body });
      res.end("ok");
    });
  });
  web.on("clientError", (_error, socket) => { upstreamErrors += 1; socket.destroy(); });
  const webPort = await listening(web);
  t.after(() => web.close());
  const fixture = await startProxy({ mode: "observe", ports: [webPort], allow: ["web.test"], allowPrivate: [`web.test:${webPort}`] }, { "web.test": ["127.0.0.1"] });
  t.after(() => fixture.proxy.close());
  const authorization = basic("project-a", SESSION);
  const request = (method: string, framing: string, body: string) =>
    send(fixture.port, `${method} http://web.test:${webPort}/items HTTP/1.1\r\nHost: web.test:${webPort}\r\nProxy-Authorization: ${authorization}\r\n${framing}\r\n${body}`);
  const json = JSON.stringify({ ids: [1, 2, 3] });
  const chunked = `${json.length.toString(16)}\r\n${json}\r\n0\r\n\r\n`;

  // The reviewer's case: Node does not chunk a DELETE body by itself, so the proxy must say how it is framed.
  assert.equal((await request("DELETE", "Transfer-Encoding: chunked\r\nContent-Type: application/json\r\n", chunked)).status, 200);
  assert.equal((await request("POST", `Content-Length: ${json.length}\r\n`, json)).status, 200);
  assert.equal((await request("POST", "", "")).status, 200);
  assert.equal((await request("GET", "", "")).status, 200);
  assert.deepEqual(seen, [
    { method: "DELETE", te: "chunked", cl: undefined, body: json },
    { method: "POST", te: undefined, cl: String(json.length), body: json },
    { method: "POST", te: undefined, cl: "0", body: "" },
    { method: "GET", te: undefined, cl: undefined, body: "" },
  ]);

  const refusals: [string, string, string, number][] = [
    ["a length and a coding", "Content-Length: 5\r\nTransfer-Encoding: chunked\r\n", "0\r\n\r\n", 400],
    ["two equal lengths", "Content-Length: 5\r\nContent-Length: 5\r\n", "hello", 400],
    ["two different lengths", "Content-Length: 5\r\nContent-Length: 6\r\n", "hello!", 400],
    ["a list of lengths", "Content-Length: 5, 5\r\n", "hello", 400],
    ["a coding the proxy cannot reproduce", "Transfer-Encoding: gzip, chunked\r\n", "0\r\n\r\n", 501],
    // Node's own parser refuses this one before the proxy sees it.
    ["two coding headers", "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n", "0\r\n\r\n", 400],
  ];
  for (const [label, framing, body, status] of refusals) assert.equal((await request("DELETE", framing, body)).status, status, label);
  assert.equal(seen.length, 4, "no refused request reached the upstream");
  assert.equal(upstreamErrors, 0, "the upstream never saw stray body bytes");
});
