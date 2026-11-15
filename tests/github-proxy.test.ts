import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { mintGithubGrant } from "../packages/host/src/github-grants.js";
import { agentTokenAccess, createGithubProxy, getfaclProbe, inspectReceivePack, validateProxyConfig } from "../scripts/github-proxy.mjs";

const TOKEN = "ghs_fixtureInstallationToken0123456789";
const root = mkdtempSync(join(tmpdir(), "github-proxy-test-"));
const key = randomBytes(32);
const tokenDirectory = join(root, "tokens");
mkdirSync(tokenDirectory, { mode: 0o700 });
writeFileSync(join(tokenDirectory, `${createHash("sha256").update("example/product").digest("hex")}.json`), JSON.stringify({
  schemaVersion: 1, repository: "example/product", repositoryId: 11, installationId: 22, token: TOKEN,
  expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
  permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" },
}), { mode: 0o600 });

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
const seen: Seen[] = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/x-git-result", "set-cookie": "session=upstream-secret", "x-github-request-id": "ABC:123" });
    res.end(req.method === "GET" ? "advertisement" : "result");
  });
});
const logs: Record<string, unknown>[] = [];
let proxy: http.Server;
let port = 0;
const responses: string[] = [];

test.before(async () => {
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config = validateProxyConfig({
    listen: { host: "127.0.0.1", port: 0 }, grantKeyFile: join(root, "grant.key"), tokenDirectory, githubCli: join(root, "gh"),
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  proxy = createGithubProxy({ config, key, log: (record: Record<string, unknown>) => logs.push(record) });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  port = (proxy.address() as { port: number }).port;
});
test.after(async () => {
  // Nothing the proxy sent or logged may carry the installation token or a grant.
  const everything = `${responses.join("\n")}\n${JSON.stringify(logs)}`;
  assert.equal(everything.includes(TOKEN), false);
  assert.equal(everything.includes("v2."), false);
  await new Promise(done => proxy.close(done));
  await new Promise(done => upstream.close(done));
  rmSync(root, { recursive: true, force: true });
});

const grant = (claims: { ops: ("fetch" | "push" | "pr" | "merge")[]; refs?: string[]; repo?: string }) =>
  mintGithubGrant(key, { sub: "test", sid: "session-1", project: "product-web", repo: claims.repo ?? "example/product", ops: claims.ops, ...(claims.refs ? { refs: claims.refs } : {}) });
const basic = (value: string) => `Basic ${Buffer.from(`x:${value}`).toString("base64")}`;
const fetchGrant = grant({ ops: ["fetch"] });
const pushGrant = grant({ ops: ["fetch", "push"], refs: ["refs/heads/infinite/team-1"] });
const branchesGrant = grant({ ops: ["fetch", "push"], refs: ["refs/heads/*"] });

async function send(options: { method?: string; path: string; auth?: string; headers?: Record<string, string>; body?: Buffer; pieces?: number }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: {
      ...(options.auth ? { authorization: options.auth } : {}), ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        responses.push(JSON.stringify(res.headers), body);
        done({ status: res.statusCode!, headers: res.headers, body });
      });
    });
    req.on("error", fail);
    void (async () => {
      const body = options.body ?? Buffer.alloc(0);
      if (!options.pieces) return req.end(body);
      // Split the command list across separate writes so the proxy must reassemble it.
      for (let offset = 0; offset < body.length; offset += options.pieces) {
        req.write(body.subarray(offset, offset + options.pieces));
        await new Promise(next => setTimeout(next, 2));
      }
      req.end();
    })();
  });
}

const pkt = (text: string) => Buffer.concat([Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")), Buffer.from(text)]);
const oid = (digit: string) => digit.repeat(40);
function pushBody(lines: string[], options: { afterFlush?: Buffer; capabilities?: string } = {}) {
  const commands = lines.map((line, index) => pkt(index === 0 ? `${line}\0${options.capabilities ?? "report-status side-band-64k agent=git/2.47.0"}\n` : `${line}\n`));
  return Buffer.concat([...commands, Buffer.from("0000"), options.afterFlush ?? Buffer.concat([Buffer.from("PACK\0\0\0\x02\0\0\0\0", "latin1"), randomBytes(64)])]);
}
const receivePack = { "content-type": "application/x-git-receive-pack-request" };

test("a fetch grant reaches GitHub with the installation token and gets no credential-bearing headers back", async () => {
  const before = seen.length;
  const anonymous = await send({ path: "/example/product.git/info/refs?service=git-upload-pack" });
  assert.equal(anonymous.status, 401);
  assert.match(String(anonymous.headers["www-authenticate"]), /^Basic /);
  assert.equal(seen.length, before);

  const advert = await send({ path: "/example/product.git/info/refs?service=git-upload-pack", auth: basic(fetchGrant), headers: { "git-protocol": "version=2" } });
  assert.equal(advert.status, 200);
  assert.equal(advert.body, "advertisement");
  assert.equal(advert.headers["set-cookie"], undefined);
  const forwarded = seen.at(-1)!;
  assert.equal(forwarded.url, "/example/product.git/info/refs?service=git-upload-pack");
  assert.equal(forwarded.headers.authorization, `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
  assert.equal(forwarded.headers["git-protocol"], "version=2");

  const body = Buffer.from("0011command=fetch0000");
  const rpc = await send({ method: "POST", path: "/example/product/git-upload-pack", auth: basic(fetchGrant), headers: { "content-type": "application/x-git-upload-pack-request" }, body });
  assert.equal(rpc.status, 200);
  assert.equal(seen.at(-1)!.url, "/example/product.git/git-upload-pack");
  assert.deepEqual(seen.at(-1)!.body, body);

  const pushAdvert = await send({ path: "/example/product.git/info/refs?service=git-receive-pack", auth: basic(fetchGrant) });
  assert.equal(pushAdvert.status, 403);
});

test("a push to the granted branch is forwarded byte for byte, also when the command list arrives in pieces", async () => {
  for (const pieces of [undefined, 7]) {
    const body = pushBody([`${oid("0")} ${oid("a")} refs/heads/infinite/team-1`]);
    const before = seen.length;
    const result = await send({ method: "POST", path: "/example/product.git/git-receive-pack", auth: basic(pushGrant), headers: receivePack, body, pieces });
    assert.equal(result.status, 200, result.body);
    assert.equal(seen.length, before + 1);
    assert.deepEqual(seen.at(-1)!.body, body);
  }
  assert.deepEqual(logs.at(-1)!.refs, ["refs/heads/infinite/team-1"]);
  // Every authenticated record names the grant's project, so two projects on one repository stay apart.
  assert.deepEqual([logs.at(-1)!.project, logs.at(-1)!.sid, logs.at(-1)!.repo], ["product-web", "session-1", "example/product"]);
});

test("pushes outside the grant are refused before any request reaches GitHub", async () => {
  const before = seen.length;
  const refused = async (auth: string, body: Buffer, reason: string) => {
    const result = await send({ method: "POST", path: "/example/product.git/git-receive-pack", auth: basic(auth), headers: receivePack, body });
    // A policy refusal is a receive-pack report that rejects each ref; a malformed request is a plain 403.
    if (result.status === 200) assert.equal(result.headers["content-type"], "application/x-git-receive-pack-result");
    else assert.equal(result.status, 403);
    assert.match(result.body, new RegExp(reason));
    return result.body;
  };
  assert.match(await refused(pushGrant, pushBody([`${oid("1")} ${oid("2")} refs/heads/main`]), "ref-not-granted"), /ng refs\/heads\/main /);
  await refused(pushGrant, pushBody([`${oid("0")} ${oid("a")} refs/heads/infinite/team-1`, `${oid("1")} ${oid("2")} refs/heads/main`]), "ref-not-granted");
  await refused(branchesGrant, pushBody([`${oid("1")} ${oid("0")} refs/heads/feature`]), "delete-refused");
  await refused(branchesGrant, pushBody([`${oid("0")} ${oid("1")} refs/tags/v1`]), "ref-not-branch");
  await refused(branchesGrant, pushBody([`${oid("0")} ${oid("1")} refs/heads/a\x01b`]), "command-invalid");
  await refused(branchesGrant, pushBody(Array.from({ length: 65 }, (_, index) => `${oid("0")} ${oid("1")} refs/heads/b${index}`)), "command-list-too-large");
  // After the flush only the pack may follow; a second command list is not passed through.
  await refused(branchesGrant, pushBody([`${oid("0")} ${oid("1")} refs/heads/feature`], { afterFlush: Buffer.concat([pkt(`${oid("1")} ${oid("0")} refs/heads/main\n`), Buffer.from("0000")]) }), "pack-expected");
  await refused(branchesGrant, pushBody([`${oid("0")} ${oid("1")} refs/heads/feature`], { capabilities: "report-status push-cert=1" }), "capability-refused");
  assert.equal(seen.length, before);
});

test("a gzip push body is inspected after decompression and forwarded compressed", async () => {
  const allowed = gzipSync(pushBody([`${oid("0")} ${oid("a")} refs/heads/infinite/team-1`]));
  const result = await send({ method: "POST", path: "/example/product.git/git-receive-pack", auth: basic(pushGrant), headers: { ...receivePack, "content-encoding": "gzip" }, body: allowed });
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(seen.at(-1)!.body, allowed);
  assert.equal(seen.at(-1)!.headers["content-encoding"], "gzip");

  const before = seen.length;
  const denied = gzipSync(pushBody([`${oid("0")} ${oid("a")} refs/heads/main`]));
  const refused = await send({ method: "POST", path: "/example/product.git/git-receive-pack", auth: basic(pushGrant), headers: { ...receivePack, "content-encoding": "gzip" }, body: denied, pieces: 5 });
  assert.match(refused.body, /ng refs\/heads\/main Infinite GitHub proxy: ref-not-granted/);
  assert.equal(seen.length, before);

  // A short command list before a large pack, gzipped, through HTTP: allowed and forwarded unchanged.
  const large = gzipSync(pushBody([`${oid("0")} ${oid("a")} refs/heads/infinite/team-1`], { afterFlush: Buffer.concat([Buffer.from("PACK\0\0\0\x02\0\0\0\0", "latin1"), randomBytes(1024 * 1024)]) }));
  const sent = await send({ method: "POST", path: "/example/product.git/git-receive-pack", auth: basic(pushGrant), headers: { ...receivePack, "content-encoding": "gzip" }, body: large });
  assert.equal(sent.status, 200, sent.body);
  assert.deepEqual(seen.at(-1)!.body, large);
});

/** A request stand-in that already holds every chunk, so it delivers them as fast as the inspector lets it. */
function bufferedRequest(body: Buffer, chunkSize: number) {
  const req = new PassThrough();
  for (let offset = 0; offset < body.length; offset += chunkSize) req.write(body.subarray(offset, offset + chunkSize));
  req.end();
  return req;
}
async function rest(req: PassThrough) {
  // The inspector leaves an accepted request paused; forwarding resumes it through pipe(), this helper by hand.
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk));
  const ended = new Promise(done => req.once("end", done));
  req.resume();
  await ended;
  return chunks;
}

test("a gzip body is decoded chunk by chunk, so a short command list before a large pack passes in 64 KiB pieces", async () => {
  // The review's case: before the fix, all 1 MiB arrived before zlib caught up and the raw bound refused the push.
  const pack = Buffer.concat([Buffer.from("PACK\0\0\0\x02\0\0\0\0", "latin1"), randomBytes(1024 * 1024)]);
  const plain = pushBody([`${oid("0")} ${oid("a")} refs/heads/infinite/team-1`], { afterFlush: pack });
  const gzipped = gzipSync(plain);
  for (const [body, gzip] of [[plain, false], [gzipped, true]] as const) {
    const req = bufferedRequest(body, 64 * 1024);
    const inspected = await inspectReceivePack(req, gzip);
    assert.deepEqual(inspected.commands.map((command: { ref: string }) => command.ref), ["refs/heads/infinite/team-1"]);
    // Only what the verdict needed was read, and those bytes plus the rest are the original body.
    assert.ok(Buffer.concat(inspected.raw).length <= 2 * 64 * 1024, `read ${Buffer.concat(inspected.raw).length} bytes`);
    assert.deepEqual(Buffer.concat([...inspected.raw, ...(await rest(req))]), body);
  }
});

test("the decoded prefix of a gzip body is bounded, so a small upload cannot expand without limit", async () => {
  const commands = Array.from({ length: 40 }, (_, index) => `${oid("0")} ${oid("1")} refs/heads/infinite/b${index}`);
  const body = gzipSync(pushBody(commands));
  assert.ok(body.length < 1024);
  await assert.rejects(inspectReceivePack(bufferedRequest(body, 64), true, { maxDecodedBytes: 1024 }), /command-list-too-large/);
  assert.equal((await inspectReceivePack(bufferedRequest(body, 64), true)).commands.length, 40);
  // A gzip bomb (32 MiB of zeros in a few KiB) is refused at its first bytes, without decoding the rest.
  await assert.rejects(inspectReceivePack(bufferedRequest(gzipSync(Buffer.alloc(32 * 1024 * 1024, "0")), 64 * 1024), true), /command-list-empty|command-list-too-large/);
});

test("a client that leaves after sending its whole request ends the upstream request, and its place in the limit is held until then", async () => {
  // An upstream that answers the head of a fetch and then keeps the response open.
  const held: { closed: boolean; finish: () => void }[] = [];
  const slow = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (held.length > 0) { res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" }); res.end("result"); return; }
      const entry = { closed: false, finish: () => res.end() };
      res.once("close", () => { entry.closed = true; });
      held.push(entry);
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.write("0008NAK\n");
    });
  });
  await new Promise<void>(done => slow.listen(0, "127.0.0.1", done));
  const config = validateProxyConfig({
    listen: { host: "127.0.0.1", port: 0 }, grantKeyFile: join(root, "grant.key"), tokenDirectory, githubCli: join(root, "gh"),
    upstream: `http://127.0.0.1:${(slow.address() as { port: number }).port}`,
  });
  const narrow = createGithubProxy({ config, key, log: (record: Record<string, unknown>) => logs.push(record), maxConcurrent: 1 });
  await new Promise<void>(done => narrow.listen(0, "127.0.0.1", done));
  const narrowPort = (narrow.address() as { port: number }).port;
  const fetchOnce = () => new Promise<{ status: number; req: http.ClientRequest; res: http.IncomingMessage }>((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port: narrowPort, method: "POST", path: "/example/product/git-upload-pack", agent: false,
      headers: { authorization: basic(fetchGrant), "content-type": "application/x-git-upload-pack-request" } }, res => { res.on("error", () => {}); done({ status: res.statusCode!, req, res }); });
    req.on("error", fail);
    req.end(Buffer.from("0011command=fetch0000"));
  });
  const waitFor = async (check: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(done => setTimeout(done, 10));
    assert.ok(check(), label);
  };
  try {
    // The request is complete and the response has begun when the client leaves.
    const first = await fetchOnce();
    assert.equal(first.status, 200);
    assert.equal(held.length, 1);
    first.res.resume();
    const busy = await fetchOnce();
    assert.equal(busy.status, 503, "the open request holds the only place");
    busy.res.resume();
    first.req.destroy();
    await waitFor(() => held[0]!.closed, "the proxy closed its upstream request when the client left");
    // The place is free again once the upstream request has closed.
    let next = await fetchOnce();
    for (let attempt = 0; attempt < 100 && next.status === 503; attempt++) { next.res.resume(); await new Promise(done => setTimeout(done, 10)); next = await fetchOnce(); }
    assert.equal(next.status, 200);
    next.res.resume();
  } finally {
    for (const entry of held) if (!entry.closed) entry.finish();
    await new Promise(done => narrow.close(done));
    await new Promise(done => slow.close(done));
  }
});

test("the token cache is reported proxy-only only when mode bits deny the agent and no extended ACL can grant it", async () => {
  // `nobody` exists on Linux and macOS and is neither the owner nor in the group of these fixtures.
  const cacheRoot = mkdtempSync(join(tmpdir(), "github-proxy-acl-"));
  try {
    const directory = join(cacheRoot, "tokens");
    mkdirSync(directory);
    const file = join(directory, `${"a".repeat(64)}.json`);
    writeFileSync(file, "{}");
    const config = validateProxyConfig({ listen: { host: "127.0.0.1", port: 0 }, grantKeyFile: "/x/grant.key", tokenDirectory: directory, githubCli: "/x/gh", agentUser: "nobody" });
    const probed: string[][] = [];
    const probe = (answer: boolean | undefined) => async (paths: string[]) => { probed.push(paths); return answer; };

    chmodSync(directory, 0o755);
    chmodSync(file, 0o644);
    assert.equal(await agentTokenAccess(config, probe(false)), "agent-readable");
    assert.equal(probed.length, 0);

    chmodSync(directory, 0o700);
    chmodSync(file, 0o600);
    assert.equal(await agentTokenAccess(config, probe(false)), "proxy-only");
    assert.deepEqual(probed.at(-1), [directory, file]);
    // An ACL entry on the directory or a file, or a probe that cannot answer, leaves the verdict unknown.
    assert.equal(await agentTokenAccess(config, probe(true)), "unknown");
    assert.equal(await agentTokenAccess(config, probe(undefined)), "unknown");
    assert.equal(await agentTokenAccess(config, getfaclProbe(join(cacheRoot, "missing-getfacl"))), "unknown");

    // The real probe reads getfacl's answer: output means an extended ACL, silence means none, failure means unknown.
    const fake = (name: string, script: string) => { const path = join(cacheRoot, name); writeFileSync(path, `#!/bin/sh\n${script}\n`); chmodSync(path, 0o755); return path; };
    assert.equal(await getfaclProbe(fake("acl.sh", 'printf "# file: %s\\nuser:nobody:r--\\n" "$4"'))([file]), true);
    assert.equal(await getfaclProbe(fake("none.sh", 'test "$1" = --skip-base && exit 0; echo unexpected'))([file]), false);
    assert.equal(await getfaclProbe(fake("fail.sh", "exit 1"))([file]), undefined);

    // /health and doctor get the same verdict.
    const health = createGithubProxy({ config, key, log: () => {}, extendedAcl: probe(true) });
    await new Promise<void>(done => health.listen(0, "127.0.0.1", done));
    try {
      const response = await fetch(`http://127.0.0.1:${(health.address() as { port: number }).port}/health`);
      assert.deepEqual(await response.json(), { ok: true, grantKey: "loaded", tokenCache: "unknown" });
    } finally { await new Promise(done => health.close(done)); }
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});

test("other repositories, encoded or dotted paths, foreign hosts, and uncovered repositories are refused", async () => {
  const before = seen.length;
  assert.equal((await send({ path: "/example/other.git/info/refs?service=git-upload-pack", auth: basic(fetchGrant) })).status, 403);
  assert.equal((await send({ path: "/example/product.git/../other.git/info/refs?service=git-upload-pack", auth: basic(fetchGrant) })).status, 404);
  assert.equal((await send({ path: "/example%2Fproduct.git/info/refs?service=git-upload-pack", auth: basic(fetchGrant) })).status, 404);
  assert.equal((await send({ path: "/example/product.git/info/refs?service=git-upload-pack&x=1", auth: basic(fetchGrant) })).status, 404);
  assert.equal((await send({ path: "/example/product.git/info/refs?service=git-upload-pack", auth: basic(fetchGrant), headers: { host: "github.com" } })).status, 403);
  const uncovered = grant({ ops: ["fetch"], repo: "example/uncached" });
  const result = await send({ path: "/example/uncached.git/info/refs?service=git-upload-pack", auth: basic(uncovered) });
  assert.equal(result.status, 403);
  assert.match(result.body, /repository-not-covered/);
  assert.equal(seen.length, before);
});
