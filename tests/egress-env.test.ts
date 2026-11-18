import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EGRESS_NO_PROXY, egressConfigSchema, egressDoctorLine, installHostEgress, workerEgressEnvironment } from "../packages/host/src/egress.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { reviewerEnvironment } from "../packages/host/src/permission-reviewer.js";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import { runRepositoryContext } from "../packages/host/src/understanding-runtime.js";
import type { Config } from "../packages/host/src/types.js";
import { teamCommandEnvironment } from "../packages/host/src/team-workspace.js";
// @ts-ignore -- a dependency-free script without type declarations
import { verifyProxyAuthorization } from "../scripts/egress-proxy.mjs";

const root = mkdtempSync(join(tmpdir(), "egress-env-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const key = randomBytes(32);
const keyPath = join(root, "egress.key");
writeFileSync(keyPath, key, { mode: 0o640 });
const egress = { proxyUrl: "http://127.0.0.1:3128", keyPath };
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"];

/** A one-commit Git checkout under `parent`. */
function gitCheckout(parent: string): string {
  const checkout = join(parent, "checkout");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  return checkout;
}

/** Inherited proxy state a child must never see, set for the duration of `body`. */
async function withStaleProxy(body: () => Promise<void>): Promise<void> {
  const previous = new Map(PROXY_NAMES.map(name => [name, process.env[name]]));
  try {
    for (const name of PROXY_NAMES) process.env[name] = name === "NODE_USE_ENV_PROXY" ? "0" : "http://stale.invalid";
    await body();
  } finally {
    installHostEgress({}, {});
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Whether a child saw each proxy variable, and the flag's value. */
const observedScript = (mode: string) => `const fs = require("node:fs");
const names = ${JSON.stringify(PROXY_NAMES)};
fs.appendFileSync(process.argv[1], JSON.stringify({ mode: ${JSON.stringify(mode)} === "argv" ? (process.argv.includes("context") ? "context" : "brief") : ${JSON.stringify(mode)}, environment: Object.fromEntries(names.map(name => [name, name === "NODE_USE_ENV_PROXY" ? (process.env[name] ?? null) : Boolean(process.env[name])])) }) + "\\n");`;

function assertProxyEnvironment(observed: Record<string, boolean | string | null>, configured: boolean, what: string) {
  if (configured) {
    for (const name of PROXY_NAMES) assert.ok(observed[name], `${name} reaches ${what}`);
    assert.equal(observed.NODE_USE_ENV_PROXY, "1");
  } else {
    assert.deepEqual(observed, Object.fromEntries(PROXY_NAMES.map(name => [name, name === "NODE_USE_ENV_PROXY" ? null : false])), `${what} gets no proxy state without the egress block`);
  }
}

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
    assert.equal(first.env.NODE_USE_ENV_PROXY, "1");
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
    assert.equal(team.NODE_USE_ENV_PROXY, "1");
  } finally {
    installHostEgress({}, inherited);
  }
});

test("without a readable key, sessions and host commands still get the proxy, with no credential, so nothing goes direct", async () => {
  const unreadable = join(root, "open.key");
  writeFileSync(unreadable, key, { mode: 0o644 });
  const uncredentialed = Object.fromEntries(PROXY_NAMES.map(name => [name, name === "NODE_USE_ENV_PROXY" ? "1" : name.toLowerCase() === "no_proxy" ? EGRESS_NO_PROXY : "http://127.0.0.1:3128"]));
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

test("repository briefing children get configured egress and discard inherited proxy state when disabled", async () => {
  const directory = mkdtempSync(join(root, "briefing-env-"));
  const receipt = join(directory, "environment.json");
  const previous = new Map(PROXY_NAMES.map(name => [name, process.env[name]]));
  const script = `const fs = require("node:fs");
const names = ${JSON.stringify(PROXY_NAMES)};
const environment = Object.fromEntries(names.map(name => [name, name === "NODE_USE_ENV_PROXY" ? (process.env[name] ?? null) : Boolean(process.env[name])]));
fs.writeFileSync(process.argv[1], JSON.stringify(environment));
process.stdout.write(JSON.stringify({ decision: { action: "disabled", reason: "probe", judge: null, worthwhile: null, scope: null }, repo: null, brief: null }));`;
  const manager = {
    state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
    events: () => ({ events: [{ seq: 1, type: "message", at: "2026-11-17T00:00:00.000Z", data: { id: "probe", role: "user", text: "inspect" } }], cursor: 1, more: false }),
  };
  // A checkout of its own: the briefing resolves the session's Git root, and the suite also runs from an export without .git.
  const checkout = gitCheckout(directory);
  const session = { id: "briefing-probe", projectId: "egress-test", cwd: checkout };
  const project = { id: "egress-test", name: "Egress test", path: checkout };

  try {
    for (const name of PROXY_NAMES) process.env[name] = name === "NODE_USE_ENV_PROXY" ? "0" : "http://stale.invalid";
    for (const configured of [false, true]) {
      installHostEgress(configured ? { autonomy: { boundary: { egress } } } : {}, {});
      const briefings = new RepositoryBriefings({ command: process.execPath, args: ["-e", script, receipt], automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 10000 }, manager as never, [project as never]);
      try {
        await assert.rejects(briefings.summarize(session as never, "0"));
      } finally {
        await briefings.close();
      }

      const observed = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, boolean | string | null>;
      if (configured) {
        for (const name of PROXY_NAMES) assert.ok(observed[name], `${name} is passed to a configured briefing`);
        assert.equal(observed.NODE_USE_ENV_PROXY, "1");
      } else {
        assert.deepEqual(observed, Object.fromEntries(PROXY_NAMES.map(name => [name, name === "NODE_USE_ENV_PROXY" ? null : false])));
      }
    }
  } finally {
    installHostEgress({}, {});
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("System tab brief and context children get configured egress and discard inherited proxy state when disabled", async () => {
  const directory = mkdtempSync(join(root, "understanding-env-"));
  const checkout = gitCheckout(directory);
  const receipt = join(directory, "environment.jsonl");
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const context = { version: 1, repo: checkout, generatedAt: "2026-11-18T00:00:00.000Z", head, base: null, files: {}, components: [], edges: [], limitations: [] };
  const config = { projects: [], repositoryBriefings: { command: process.execPath, args: ["-e", observedScript("argv"), receipt], automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 10000 } } as Config;
  const options = () => ({ signal: new AbortController().signal, timeoutMs: 10000, maxBytes: 1024 * 1024 });
  const bin = join(directory, "bin"), ghReceipt = join(directory, "gh.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$HTTPS_PROXY" >> '${ghReceipt}'\nexit 1\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;

  await withStaleProxy(async () => {
    for (const configured of [false, true]) {
      rmSync(receipt, { force: true });
      installHostEgress(configured ? { autonomy: { boundary: { egress } } } : {}, {});
      // The script prints nothing, so both calls fail after the child has recorded what it saw.
      await assert.rejects(runRepositoryContext(config, checkout, options()));
      await assert.rejects(createUnderstandingAdapter(config).brief!({ workspaceId: "workspace", root: checkout, repositoryId: "repo", context, base: null, components: [] } as never, options()));
      const lines = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line) as { mode: string; environment: Record<string, boolean | string | null> });
      assert.deepEqual(lines.map(line => line.mode), ["context", "brief"]);
      for (const line of lines) assertProxyEnvironment(line.environment, configured, `a System tab ${line.mode} child`);

      // The System tab's gh reads run as the host account and keep the host's own environment.
      rmSync(ghReceipt, { force: true });
      const github = { ...config, projects: [{ id: "repo", name: "Repository", path: checkout, source: { mode: "github", repository: "example/repo" } }] } as Config;
      const delivery = await createUnderstandingAdapter(github).delivery!({ workspaceId: "workspace", root: checkout, repositoryId: "repo", head }, options());
      assert.equal(delivery.state, "unavailable");
      assert.deepEqual([...new Set(readFileSync(ghReceipt, "utf8").trim().split("\n"))], ["http://stale.invalid"], "gh keeps the inherited proxy state");
    }
  }).finally(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
});

test("permission reviewer processes get configured egress with the host identity and nothing else of the host's", async () => {
  await withStaleProxy(async () => {
    installHostEgress({}, {});
    const plain = reviewerEnvironment({ PATH: "/usr/bin", HOME: "/home/dev", INFINITE_TEST_SECRET: "do-not-pass", HTTPS_PROXY: "http://stale.invalid" });
    assert.deepEqual(plain, { PATH: "/usr/bin", HOME: "/home/dev" });

    installHostEgress({ autonomy: { boundary: { egress } } }, {});
    const routed = reviewerEnvironment({ PATH: "/usr/bin", INFINITE_TEST_SECRET: "do-not-pass" });
    assert.equal(routed.INFINITE_TEST_SECRET, undefined);
    assert.equal(routed.PATH, "/usr/bin");
    assert.equal(routed.NODE_USE_ENV_PROXY, "1");
    assert.equal(routed.NO_PROXY, EGRESS_NO_PROXY);
    const identity = identityOf(routed.HTTPS_PROXY!);
    assert.equal(identity.origin, "http://127.0.0.1:3128");
    assert.deepEqual(identity.verdict, { ok: true, project: "_host", session: "host" });
  });
});

test("the egress block accepts only a bare loopback HTTP proxy address", () => {
  for (const proxyUrl of ["http://127.0.0.1:3128", "http://[::1]:3128", "http://127.0.0.1:3128/"]) assert.ok(egressConfigSchema.safeParse({ proxyUrl, keyPath }).success, proxyUrl);
  for (const proxyUrl of ["http://proxy.example.test:3128", "https://127.0.0.1:3128", "http://user:secret@127.0.0.1:3128", "http://127.0.0.1", "http://127.0.0.1:3128/path", "http://localhost:3128", "http://127.1:3128"])
    assert.equal(egressConfigSchema.safeParse({ proxyUrl, keyPath }).success, false, proxyUrl);
  assert.equal(egressConfigSchema.safeParse({ ...egress, keyPath: "relative.key" }).success, false);
  assert.equal(egressConfigSchema.safeParse({ ...egress, extra: true }).success, false);
});
