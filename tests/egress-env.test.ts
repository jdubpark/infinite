import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { egressConfigSchema, egressDoctorLine, installHostEgress, workerEgressEnvironment } from "../packages/host/src/egress.js";
import { teamCommandEnvironment } from "../packages/host/src/team-workspace.js";
// @ts-ignore -- a dependency-free script without type declarations
import { verifyProxyAuthorization } from "../scripts/egress-proxy.mjs";

const root = mkdtempSync(join(tmpdir(), "egress-env-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const key = randomBytes(32);
const keyPath = join(root, "egress.key");
writeFileSync(keyPath, key, { mode: 0o640 });
const egress = { proxyUrl: "http://127.0.0.1:3128", keyPath };
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy"];

/** The identity the proxy would accept for a proxy URL's user information. */
function identityOf(proxyUrl: string) {
  const url = new URL(proxyUrl);
  const header = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  return { origin: `${url.protocol}//${url.host}`, verdict: verifyProxyAuthorization(header, key) };
}

test("without the egress block, sessions and host commands get exactly the environment they had", () => {
  const before = teamCommandEnvironment();
  const inherited: NodeJS.ProcessEnv = { INFINITE_EGRESS_PROXY_URL: egress.proxyUrl, INFINITE_EGRESS_KEY_FILE: keyPath, PATH: "/usr/bin" };
  installHostEgress({ autonomy: { defaultMode: "supervised" } }, inherited);
  assert.deepEqual(inherited, { PATH: "/usr/bin" }, "stale settings from a parent process are cleared");
  assert.deepEqual(workerEgressEnvironment("project-a", "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", inherited), { status: "off", env: {} });
  assert.deepEqual(teamCommandEnvironment(), before);
  for (const name of PROXY_NAMES) assert.equal(before[name], undefined);
});

test("with the egress block, each session gets its own credential in the proxy URL and loopback stays direct", () => {
  const inherited: NodeJS.ProcessEnv = {};
  installHostEgress({ autonomy: { boundary: { egress } } }, inherited);
  try {
    assert.deepEqual(inherited, { INFINITE_EGRESS_PROXY_URL: egress.proxyUrl, INFINITE_EGRESS_KEY_FILE: keyPath }, "workers inherit the address and key path, never the key");
    const first = workerEgressEnvironment("project-a", "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", inherited);
    const second = workerEgressEnvironment("project-a", "6f1d2c3b-1111-4222-8333-944455566677", inherited);
    assert.equal(first.status, "on");
    assert.deepEqual(Object.keys(first.env).sort(), [...PROXY_NAMES].sort());
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) assert.equal(first.env[name], first.env.HTTPS_PROXY);
    for (const name of ["NO_PROXY", "no_proxy"]) assert.deepEqual(first.env[name].split(",").sort(), ["127.0.0.1", "::1", "localhost"]);
    const { origin, verdict } = identityOf(first.env.HTTPS_PROXY);
    assert.equal(origin, "http://127.0.0.1:3128");
    assert.deepEqual(verdict, { ok: true, project: "project-a", session: "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71" });
    assert.deepEqual(identityOf(second.env.HTTPS_PROXY).verdict, { ok: true, project: "project-a", session: "6f1d2c3b-1111-4222-8333-944455566677" });
    assert.notEqual(first.env.HTTPS_PROXY, second.env.HTTPS_PROXY);
    const values = JSON.stringify(first.env);
    for (const encoding of ["hex", "base64", "base64url"] as const) assert.ok(!values.includes(key.toString(encoding)), `the key never appears (${encoding})`);
    assert.deepEqual(identityOf(workerEgressEnvironment(undefined, "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", inherited).env.HTTPS_PROXY).verdict.project, "_none");

    const team = teamCommandEnvironment();
    assert.equal(team.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.deepEqual(identityOf(team.HTTPS_PROXY!).verdict, { ok: true, project: "_host", session: "host" });
    assert.equal(team.NO_PROXY, first.env.NO_PROXY);
  } finally {
    installHostEgress({}, inherited);
  }
});

test("without a readable key, sessions and host commands still get the proxy, with no credential, so nothing goes direct", async () => {
  const unreadable = join(root, "open.key");
  writeFileSync(unreadable, key, { mode: 0o644 });
  const uncredentialed = Object.fromEntries(PROXY_NAMES.map(name => [name, name.toLowerCase() === "no_proxy" ? "localhost,127.0.0.1,::1" : "http://127.0.0.1:3128"]));
  for (const keyFile of [unreadable, join(root, "missing.key"), "relative.key", ""])
    assert.deepEqual(workerEgressEnvironment("project-a", "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", { INFINITE_EGRESS_PROXY_URL: egress.proxyUrl, INFINITE_EGRESS_KEY_FILE: keyFile }), { status: "no-key", env: uncredentialed }, keyFile);
  assert.deepEqual(workerEgressEnvironment("project-a", "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", { INFINITE_EGRESS_PROXY_URL: egress.proxyUrl }), { status: "no-key", env: uncredentialed });
  for (const proxyUrl of [undefined, "", "http://proxy.example.test:3128"])
    assert.deepEqual(workerEgressEnvironment("project-a", "0b6a3c52-6c1e-4b0e-9a55-3f1f2d0c9e71", { INFINITE_EGRESS_PROXY_URL: proxyUrl, INFINITE_EGRESS_KEY_FILE: keyPath }).status, "invalid", String(proxyUrl));
  // The host-identity path: a team Git command run as the host account, which the firewall rule does not match.
  const inherited: NodeJS.ProcessEnv = {};
  const warn = console.warn;
  console.warn = () => {};
  installHostEgress({ autonomy: { boundary: { egress: { ...egress, keyPath: unreadable } } } }, inherited);
  try {
    const team = teamCommandEnvironment();
    for (const name of PROXY_NAMES) assert.equal(team[name], uncredentialed[name], name);
  } finally {
    installHostEgress({}, inherited);
    console.warn = warn;
  }
  const line = await egressDoctorLine({ proxyUrl: "http://127.0.0.1:9", keyPath: unreadable });
  assert.match(line, /key UNREADABLE \(permissions\): .*refused with 407/);
});

test("the egress block accepts only a bare loopback HTTP proxy address", () => {
  for (const proxyUrl of ["http://127.0.0.1:3128", "http://[::1]:3128", "http://127.0.0.1:3128/"]) assert.ok(egressConfigSchema.safeParse({ proxyUrl, keyPath }).success, proxyUrl);
  for (const proxyUrl of ["http://proxy.example.test:3128", "https://127.0.0.1:3128", "http://user:secret@127.0.0.1:3128", "http://127.0.0.1", "http://127.0.0.1:3128/path", "http://localhost:3128", "http://127.1:3128"])
    assert.equal(egressConfigSchema.safeParse({ proxyUrl, keyPath }).success, false, proxyUrl);
  assert.equal(egressConfigSchema.safeParse({ ...egress, keyPath: "relative.key" }).success, false);
  assert.equal(egressConfigSchema.safeParse({ ...egress, extra: true }).success, false);
});
