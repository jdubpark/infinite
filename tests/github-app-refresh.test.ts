import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

const script = resolve("scripts/github-app-refresh.mjs");
const stubSource = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { createVerify } from "node:crypto";
const exactEndpoint = "https://api.github.com/app/installations/";
if (process.env.TEST_SCENARIO === "write-mode-fails") {
  const { open } = await import("node:fs/promises");
  const probe = await open(process.env.TEST_REQUEST_LOG, "a");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalChmod = prototype.chmod;
  prototype.chmod = function(mode) {
    if (mode === 0o640) throw new Error("injected filesystem preparation failure");
    return originalChmod.call(this, mode);
  };
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = JSON.parse(init.body);
  const auth = String(init.headers?.authorization ?? "");
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const parts = jwt.split(".");
  let claims = {};
  let jwtValid = false;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const verifier = createVerify("RSA-SHA256");
    verifier.update(parts.slice(0, 2).join("."));
    verifier.end();
    jwtValid = verifier.verify(readFileSync(process.env.TEST_PUBLIC_KEY), Buffer.from(parts[2], "base64url"));
  } catch {}
  const request = { url, method: init.method, redirect: init.redirect, body, jwtValid, claims };
  appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify(request) + "\n", { mode: 0o600 });
  if (!url.startsWith(exactEndpoint)) throw new Error("unexpected endpoint");
  const installationId = Number(url.slice(exactEndpoint.length).split("/")[0]);
  const repositoryId = body.repository_ids[0];
  const configured = JSON.parse(readFileSync(process.env.TEST_CONFIG, "utf8")).repositories.find(item => item.repositoryId === repositoryId);
  const scenario = process.env.TEST_SCENARIO ?? "success";
  if (scenario === "http-error" || (scenario === "one-installation-fails" && installationId === 101)) {
    return new Response("sensitive-body-marker", { status: 401 });
  }
  const permissions = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" };
  const repositories = [{ id: repositoryId, full_name: configured.repository.split("/").map(part => part[0].toUpperCase() + part.slice(1)).join("/") }];
  const expiresAt = new Date(Date.now() + 45 * 60_000).toISOString();
  if (scenario === "wrong-scope") repositories[0].id += 1;
  if (scenario === "wrong-permissions") permissions.contents = "read";
  if (scenario === "control-token") return new Response(JSON.stringify({ token: "opaque_test_token_value_42\u0000", expires_at: expiresAt, permissions, repositories }), { status: 201 });
  if (scenario === "bad-expiry") return new Response(JSON.stringify({ token: "opaque_test_token_value_42", expires_at: new Date(Date.now() + 80 * 60_000).toISOString(), permissions, repositories }), { status: 201 });
  if (scenario === "oversized") return new Response("x".repeat(70 * 1024), { status: 201 });
  return new Response(JSON.stringify({ token: "opaque_test_token_value_42", expires_at: expiresAt, permissions, repositories }), { status: 201, headers: { "content-type": "application/json" } });
};
`;

function fixture(repositories = [{ repository: "example/app", repositoryId: 17, installationId: 101 }]) {
  const root = realpathSync(mkdtempSync(join(homedir(), ".github-app-refresh-")));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyFile = join(root, "app-key.pem");
  const publicKeyFile = join(root, "app-public.pem");
  const tokenDirectory = join(root, "tokens");
  const configFile = join(root, "refresh.json");
  const stubFile = join(root, "github-boundary.mjs");
  const requestLog = join(root, "requests.jsonl");
  writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  writeFileSync(stubFile, stubSource, { mode: 0o600 });
  const config = {
    appId: "12345",
    privateKeyFile,
    tokenDirectory,
    tokenGroupId: typeof process.getgid === "function" ? process.getgid() : 0,
    repositories,
  };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const run = (scenario = "success", configPath = configFile) => spawnSync(process.execPath, ["--import", stubFile, script, "--config", configPath], {
    encoding: "utf8",
    env: { ...process.env, TEST_CONFIG: configPath, TEST_PUBLIC_KEY: publicKeyFile, TEST_REQUEST_LOG: requestLog, TEST_SCENARIO: scenario },
    timeout: 30_000,
  });
  const tokenFile = (repository) => join(tokenDirectory, `${createDigest(repository)}.json`);
  const requests = () => exists(requestLog) ? readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { root, config, configFile, privateKeyFile, tokenDirectory, requestLog, run, tokenFile, requests, close: () => rmSync(root, { recursive: true, force: true }) };
}

function createDigest(repository: string) {
  return createHash("sha256").update(repository.toLowerCase()).digest("hex");
}

function exists(path: string) {
  try { statSync(path); return true; } catch { return false; }
}

test("mints one-repository token with bounded permissions and reuses a fresh bound cache", { timeout: 30_000 }, () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /example\/app: refreshed/);
    assert.doesNotMatch(first.stdout + first.stderr, /opaque_test_token_value_42|Bearer |sensitive-body-marker/);
    const token = JSON.parse(readFileSync(f.tokenFile("example/app"), "utf8"));
    assert.equal(token.repository, "example/app");
    assert.equal(token.repositoryId, 17);
    assert.equal(token.installationId, 101);
    assert.equal(token.token, "opaque_test_token_value_42");
    assert.equal(statSync(f.tokenFile("example/app")).mode & 0o777, 0o640);
    assert.equal(statSync(f.tokenFile("example/app")).gid, f.config.tokenGroupId);
    assert.equal(statSync(f.tokenDirectory).mode & 0o777, 0o750);
    const calls = f.requests();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.github.com/app/installations/101/access_tokens");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].redirect, "error");
    assert.deepEqual(calls[0].body, {
      repository_ids: [17],
      permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" },
    });
    assert.equal(calls[0].jwtValid, true);
    assert.equal(calls[0].claims.iss, "12345");
    assert.equal(calls[0].claims.exp - calls[0].claims.iat, 600);
    assert.ok(calls[0].claims.iat <= Math.floor(Date.now() / 1000) - 59);

    const second = f.run("http-error");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /example\/app: cached/);
    assert.equal(f.requests().length, 1);

    writeFileSync(f.tokenFile("example/app"), JSON.stringify({ ...token, expiresAt: new Date(Date.now() + 14 * 60_000).toISOString() }), { mode: 0o640 });
    const third = f.run();
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /example\/app: refreshed/);
    assert.equal(f.requests().length, 2);

    writeFileSync(f.tokenFile("example/app"), JSON.stringify({ ...token, expiresAt: new Date(Date.now() + 90 * 60_000).toISOString() }), { mode: 0o640 });
    const fourth = f.run();
    assert.equal(fourth.status, 0, fourth.stderr);
    assert.match(fourth.stdout, /example\/app: refreshed/);
    assert.equal(f.requests().length, 3);
  } finally { f.close(); }
});

test("rejects GitHub responses outside the configured repository, permission, or expiry contract", { timeout: 60_000 }, () => {
  for (const scenario of ["wrong-scope", "wrong-permissions", "bad-expiry", "oversized", "http-error", "control-token"]) {
    const f = fixture();
    try {
      const result = f.run(scenario);
      assert.notEqual(result.status, 0, `${scenario} unexpectedly succeeded`);
      assert.equal(exists(f.tokenFile("example/app")), false, `${scenario} wrote a token`);
      assert.doesNotMatch(result.stdout + result.stderr, /sensitive-body-marker|opaque_test_token_value_42|Bearer /);
      assert.equal(f.requests().length, 1);
    } finally { f.close(); }
  }
});

test("continues other configured repositories after one installation fails", { timeout: 30_000 }, () => {
  const f = fixture([
    { repository: "example/first", repositoryId: 17, installationId: 101 },
    { repository: "example/second", repositoryId: 23, installationId: 202 },
  ]);
  try {
    const result = f.run("one-installation-fails");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example\/first: failed \(provider-http-401\)/);
    assert.match(result.stdout, /example\/second: refreshed/);
    assert.equal(exists(f.tokenFile("example/first")), false);
    assert.equal(JSON.parse(readFileSync(f.tokenFile("example/second"), "utf8")).repositoryId, 23);
    assert.equal(f.requests().length, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-body-marker|opaque_test_token_value_42|Bearer /);
  } finally { f.close(); }
});

test("rejects unsafe cache symlinks and group-readable key or config before contacting GitHub", () => {
  const f = fixture();
  try {
    mkdirSync(f.tokenDirectory, { mode: 0o750 });
    const outside = join(f.root, "outside.json");
    writeFileSync(outside, "private marker", { mode: 0o600 });
    symlinkSync(outside, f.tokenFile("example/app"));
    const cache = f.run();
    assert.notEqual(cache.status, 0);
    assert.match(cache.stderr, /cache-not-regular-file/);
    assert.equal(f.requests().length, 0);
  } finally { f.close(); }

  const g = fixture();
  try {
    chmodFile(g.privateKeyFile, 0o644);
    const key = g.run();
    assert.notEqual(key.status, 0);
    assert.match(key.stderr, /private-key-permissions/);
    assert.equal(g.requests().length, 0);
  } finally { g.close(); }

  const h = fixture();
  try {
    chmodFile(h.configFile, 0o640);
    const config = h.run();
    assert.notEqual(config.status, 0);
    assert.match(config.stderr, /config-permissions/);
    assert.equal(h.requests().length, 0);
  } finally { h.close(); }
});

test("rejects noncanonical or duplicate repository bindings before contacting GitHub", () => {
  const cases = [
    { repositories: [{ repository: "Example/app", repositoryId: 17, installationId: 101 }], reason: /repository-name/ },
    { repositories: [
      { repository: "example/app", repositoryId: 17, installationId: 101 },
      { repository: "example/other", repositoryId: 17, installationId: 202 },
    ], reason: /duplicate-repository/ },
  ];
  for (const scenario of cases) {
    const f = fixture();
    try {
      f.config.repositories = scenario.repositories;
      writeFileSync(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario.reason);
      assert.equal(f.requests().length, 0);
    } finally { f.close(); }
  }
});

test("rejects group-writable ancestor directories before contacting GitHub", () => {
  const f = fixture();
  try {
    const unsafe = join(f.root, "unsafe");
    mkdirSync(unsafe, { mode: 0o770 });
    chmodSync(unsafe, 0o770);
    const configPath = join(unsafe, "refresh.json");
    writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
    const result = f.run("success", configPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config-parent-permissions/);
    assert.equal(f.requests().length, 0);
  } finally { f.close(); }
});

test("root refresh rejects agent-owned issuer and config files", { skip: typeof process.getuid !== "function" || process.getuid() !== 0 }, () => {
  for (const file of ["privateKeyFile", "configFile"] as const) {
    const f = fixture();
    try {
      chownSync(f[file], 65534, f.config.tokenGroupId);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, file === "privateKeyFile" ? /private-key-owner/ : /config-owner/);
      assert.equal(f.requests().length, 0);
    } finally { f.close(); }
  }
});

test("keeps the previous usable token if new cache preparation fails", () => {
  const f = fixture();
  try {
    mkdirSync(f.tokenDirectory, { mode: 0o750 });
    const previous = {
      schemaVersion: 1,
      repository: "example/app",
      repositoryId: 17,
      installationId: 101,
      token: "previous_test_token_value",
      expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
      permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" },
    };
    writeFileSync(f.tokenFile("example/app"), `${JSON.stringify(previous)}\n`, { mode: 0o640 });
    chmodSync(f.tokenFile("example/app"), 0o640);
    const result = f.run("write-mode-fails");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cache-write-failed/);
    assert.deepEqual(JSON.parse(readFileSync(f.tokenFile("example/app"), "utf8")), previous);
    assert.equal(statSync(f.tokenFile("example/app")).mode & 0o777, 0o640);
    assert.equal(f.requests().length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /previous_test_token_value|opaque_test_token_value_42|Bearer /);
  } finally { f.close(); }
});

function chmodFile(path: string, mode: number) {
  chmodSync(path, mode);
}
