import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvalIdentity, evalCanaries, launcherEvalIdentity, repositoryUrl, stopEvalIdentity } from "../packages/host/src/eval-identity.js";
import type { EvalMemberConfig } from "../packages/host/src/eval-config.js";
import type { RuntimeProcess } from "../packages/host/src/team-retirement.js";
import type { Config } from "../packages/host/src/types.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/eval-command.mjs", import.meta.url));
const TRIAL = "22222222-3333-4444-8555-666666666666";
const UID = process.getuid?.() ?? 0;
const SKIP = UID === 0 ? "the canary and ownership checks need a non-root user" : false;
const sandboxes: string[] = [];

type Sandbox = { base: string; root: string; home: string; template: string; tmp: string; record: string };
type CallRecord = { argv: string[]; cwd: string };

function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "eval-identity-"));
  sandboxes.push(base);
  const sb = { base, root: join(base, "root"), home: join(base, "home"), template: join(base, "template"), tmp: join(base, "tmp"), record: join(base, "record.log") };
  for (const dir of [sb.root, sb.home, sb.template, sb.tmp]) mkdirSync(dir, { mode: 0o700 });
  chmodSync(sb.root, 0o711);
  return sb;
}

test.after(() => {
  for (const dir of sandboxes) {
    spawnSync("chmod", ["-R", "u+rwX", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function member(sb: Sandbox, extra: string[] = []): EvalMemberConfig {
  return {
    prefix: {
      command: process.execPath,
      args: [FIXTURE, "--root", sb.root, "--uid", String(UID), "--home", sb.home, "--template", sb.template, "--tmp", sb.tmp, "--record", sb.record, ...extra],
    },
    root: sb.root,
    agents: {},
  };
}

function identityFor(sb: Sandbox, extra: string[] = [], hostUid = UID + 1): EvalIdentity {
  return launcherEvalIdentity(() => member(sb, extra), { hostUid, graceMs: 30_000 });
}

function records(sb: Sandbox): CallRecord[] {
  return readFileSync(sb.record, "utf8").trim().split("\n").map(line => JSON.parse(line) as CallRecord);
}

test("the eval probe names every unsafe state", { skip: SKIP }, async () => {
  const sb = sandbox();
  const sealed = join(sb.base, "sealed");
  writeFileSync(sealed, "x");
  chmodSync(sealed, 0o000);
  const exposed = join(sb.base, "exposed");
  writeFileSync(exposed, "x");
  const failing = join(sb.base, "fail.mjs");
  writeFileSync(failing, "process.exit(1);\n");

  assert.equal((await launcherEvalIdentity(() => undefined).probe({ canaries: [] })).state, "not-configured");

  const failingIdentity = launcherEvalIdentity(() => ({ ...member(sb), prefix: { command: process.execPath, args: [failing] } }), { hostUid: UID + 1 });
  assert.equal((await failingIdentity.probe({ canaries: [] })).state, "unavailable");

  chmodSync(sb.root, 0o700);
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "misconfigured");
  chmodSync(sb.root, 0o711);
  assert.equal((await identityFor(sb, ["--ancestors-writable"]).probe({ canaries: [] })).state, "misconfigured");
  assert.equal((await identityFor(sb, [], UID).probe({ canaries: [] })).state, "misconfigured");
  assert.equal((await identityFor(sb).probe({ canaries: [], graderUid: UID })).state, "misconfigured");

  assert.equal((await identityFor(sb).probe({ canaries: [exposed] })).state, "exposed");
  assert.equal((await identityFor(sb).probe({ canaries: [sealed] })).state, "ready");

  assert.equal((await identityFor(sb, ["--metadata", "open"]).probe({ canaries: [] })).state, "network-open");

  mkdirSync(join(sb.root, "trials", TRIAL), { recursive: true });
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "busy");
  rmSync(join(sb.root, "trials"), { recursive: true, force: true });
  writeFileSync(join(sb.home, "planted"), "x");
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "busy");
  rmSync(join(sb.home, "planted"));
  writeFileSync(join(sb.tmp, "planted"), "x");
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "busy");
  rmSync(join(sb.tmp, "planted"));
  mkdirSync(join(sb.root, "other"));
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "busy");
  rmSync(join(sb.root, "other"), { recursive: true });

  const ready = await identityFor(sb).probe({ canaries: [sealed] });
  assert.equal(ready.state, "ready");
  assert.equal(ready.fetch, "skipped");
  const open = await identityFor(sb, ["--fetch", "open"]).probe({
    canaries: [sealed], fetchUrl: "https://example.invalid/repo.git", proxyUrl: "http://u:p@127.0.0.1:9/",
  });
  assert.equal(open.state, "ready");
  assert.equal(open.fetch, "open");
  const recorded = readFileSync(sb.record, "utf8");
  assert.ok(recorded.includes('"probe"'));
  assert.equal(recorded.includes("u:p@127.0.0.1"), false);
});

test("a surviving eval process blocks trials", { skip: SKIP }, async () => {
  const sb = sandbox();
  const identity = identityFor(sb);
  const row: RuntimeProcess = { pid: 4242, parent: 1, group: 4242, ruid: UID, euid: UID, born: "2026-11-18T00:00:00Z", state: "S" };

  assert.equal(await stopEvalIdentity(identity, UID, async () => [row]), "alive");
  assert.equal(records(sb).filter(entry => entry.argv[0] === "stop").length, 3);

  let calls = 0;
  assert.equal(await stopEvalIdentity(identity, UID, async () => (++calls < 2 ? [row] : [])), "stopped");
});

test("replay commands run only through exec and setup", { skip: SKIP }, async () => {
  const sb = sandbox();
  const work = join(sb.root, "trials", TRIAL, "work");
  mkdirSync(work, { recursive: true, mode: 0o711 });
  assert.equal(spawnSync("git", ["init", "--quiet", work]).status, 0);
  const outside = join(sb.base, "outside");
  mkdirSync(outside);
  const identity = identityFor(sb);

  const exec = await teamCommand({ command: "git", args: ["status"] }, work, undefined, 60_000, identity.teamPrefix());
  assert.equal(exec.exitCode, 0, exec.output);
  const setup = await teamCommand({ command: process.execPath, args: ["-e", "process.exit(0)"] }, work, undefined, 60_000, identity.setupPrefix());
  assert.equal(setup.exitCode, 0, setup.output);
  const refused = await teamCommand({ command: "git", args: ["status"] }, outside, undefined, 60_000, identity.teamPrefix());
  assert.equal(refused.exitCode, 64, refused.output);

  const [first, second, third] = records(sb);
  assert.deepEqual(first.argv, ["exec", "--", "git", "status"]);
  assert.equal(first.cwd, realpathSync(work));
  assert.deepEqual(second.argv.slice(0, 2), ["setup", "--"]);
  assert.deepEqual(third.argv, ["exec", "--", "git", "status"]);
  assert.equal(third.cwd, realpathSync(outside));
});

type Script = { exit?: number; out?: string; delayOp?: string; delayMs?: number };
const SCRIPT = `import fs from "node:fs";
const [cfgPath, op, ...rest] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
let stdin = null;
if (op === "receive" || rest.includes("--fetch")) { try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; } }
fs.appendFileSync(cfgPath + ".log", JSON.stringify({ argv: [op, ...rest], stdin }) + "\\n");
if (cfg.delayOp === op) await new Promise(resolve => setTimeout(resolve, cfg.delayMs));
if (cfg.out) process.stdout.write(cfg.out);
process.exit(cfg.exit ?? 0);
`;

function scripted(script: Script, uid = 4242): { sb: Sandbox; identity: EvalIdentity; calls: () => { argv: string[]; stdin: string | null }[]; probe: (over?: Record<string, unknown>) => Script } {
  const sb = sandbox();
  const launcher = join(sb.base, "scripted.mjs");
  const cfg = join(sb.base, "scripted.json");
  writeFileSync(launcher, SCRIPT);
  writeFileSync(cfg, JSON.stringify(script));
  const identity = launcherEvalIdentity(() => ({ prefix: { command: process.execPath, args: [launcher, cfg] }, root: sb.root, agents: {} }), { hostUid: 1, graceMs: 30_000 });
  const calls = () => readFileSync(`${cfg}.log`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; stdin: string | null });
  const probe = (over: Record<string, unknown> = {}): Script => ({
    out: `${JSON.stringify({
      version: 1, uid, root: sb.root, rootMode: "711", rootOwner: uid, readable: [false], metadata: "closed",
      freeBytes: 10_737_418_240, freeInodes: 200_000, ancestorsWritable: false, tools: true, trials: 0, leftovers: 0, fetch: "skipped", ...over,
    })}\n`,
  });
  return { sb, identity, calls, probe };
}

function rewrite(sb: Sandbox, script: Script): void {
  writeFileSync(join(sb.base, "scripted.json"), JSON.stringify(script));
}

test("the eval probe judges the launcher's answer", async () => {
  const t = scripted({});
  const check = async (script: Script, canaries: string[] = []) => { rewrite(t.sb, script); return t.identity.probe({ canaries }); };

  const ready = await check(t.probe());
  assert.equal(ready.state, "ready");
  assert.equal(ready.storage, true);
  assert.equal((await check(t.probe({ freeBytes: 1 }))).storage, false);
  assert.equal((await check(t.probe({ freeInodes: 1 }))).storage, false);

  assert.equal((await check(t.probe({ uid: 0, rootOwner: 0 }))).state, "misconfigured");
  assert.equal((await check(t.probe({ root: `${t.sb.root}-other` }))).state, "misconfigured");
  assert.equal((await check(t.probe({ rootOwner: 4243 }))).state, "misconfigured");
  assert.equal((await check(t.probe({ tools: false }))).state, "misconfigured");

  assert.equal((await check({ ...t.probe(), exit: 64 })).state, "misconfigured");
  assert.equal((await check({ ...t.probe(), exit: 2 })).state, "unavailable");
  assert.equal((await check({ out: "x".repeat(5_000) })).state, "unavailable");
  assert.equal((await check({ out: "not json\n" })).state, "unavailable");
});

test("the eval probe sends the proxy URL on stdin, and a blank line without one", async () => {
  const t = scripted({});
  rewrite(t.sb, t.probe());
  await t.identity.probe({ canaries: [], fetchUrl: "https://example.invalid/repo.git", proxyUrl: "http://127.0.0.1:9/" });
  await t.identity.probe({ canaries: [], fetchUrl: "https://example.invalid/repo.git" });
  const [withProxy, without] = t.calls();
  assert.equal(withProxy.stdin, "http://127.0.0.1:9/\n");
  assert.equal(without.stdin, "\n");
});

test("receive, prepare, and check map the launcher's exit codes and refuse bad input before calling it", async () => {
  const t = scripted({});
  const hash = "a".repeat(40);
  const run = async (exit: number) => rewrite(t.sb, { exit });
  const input = () => Readable.from([Buffer.from("data")]);

  await run(0);
  assert.equal(await t.identity.receive(TRIAL, input(), 100), "stored");
  await run(3);
  assert.equal(await t.identity.receive(TRIAL, input(), 100), "too-large");
  await run(5);
  assert.equal(await t.identity.receive(TRIAL, input(), 100), "failed");
  assert.equal(await t.identity.prepare(TRIAL), "failed");
  assert.equal(await t.identity.check(TRIAL, [hash]), "failed");
  await run(1);
  assert.equal(await t.identity.check(TRIAL, [hash]), "leaked");
  await run(0);
  assert.equal(await t.identity.check(TRIAL, [hash]), "clean");
  assert.equal(await t.identity.prepare(TRIAL), "ready");

  const before = t.calls().length;
  assert.equal(await t.identity.receive("not-a-trial", input(), 100), "failed");
  assert.equal(await t.identity.receive(TRIAL, input(), 0), "failed");
  assert.equal(await t.identity.prepare("not-a-trial"), "failed");
  assert.equal(await t.identity.check("not-a-trial", [hash]), "failed");
  assert.equal(await t.identity.check(TRIAL, Array.from({ length: 201 }, () => hash)), "failed");
  assert.equal(await t.identity.check(TRIAL, ["nothex"]), "failed");
  assert.equal(t.calls().length, before);
  assert.equal(await t.identity.check(TRIAL, Array.from({ length: 200 }, () => hash)), "clean");
});

test("clean and scrub succeed only on exit 0", async () => {
  const t = scripted({});
  assert.equal(await t.identity.clean(), true);
  assert.equal(await t.identity.scrub(), true);
  rewrite(t.sb, { exit: 1 });
  assert.equal(await t.identity.clean(), false);
  assert.equal(await t.identity.scrub(), false);
  assert.equal(await t.identity.stop(), false);
});

test("stop reaches the launcher while another call holds the channel", async () => {
  const t = scripted({});
  rewrite(t.sb, { ...t.probe(), delayOp: "probe", delayMs: 1_500 });
  const slow = t.identity.probe({ canaries: [] });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await t.identity.stop(), true);
  assert.equal((await slow).state, "ready");
});

test("a zombie of the eval account does not keep it alive", async () => {
  const t = scripted({});
  const row = (state: string, ruid: number): RuntimeProcess => ({ pid: 4242, parent: 1, group: 4242, ruid, euid: ruid, born: "2026-11-18T00:00:00Z", state });
  assert.equal(await stopEvalIdentity(t.identity, 4242, async () => [row("Z", 4242)]), "stopped");
  assert.equal(await stopEvalIdentity(t.identity, 4242, async () => [row("S", 4243)]), "stopped");
  assert.equal(t.calls().filter(entry => entry.argv[0] === "stop").length, 2);
  assert.equal(await stopEvalIdentity(t.identity, 4242, async () => { throw new Error("no ps"); }), "failed");
  rewrite(t.sb, { exit: 1 });
  assert.equal(await stopEvalIdentity(t.identity, 4242, async () => []), "failed");
});

test("evalCanaries lists the key, the projects, and the state; repositoryUrl prefers an override", () => {
  const config = {
    stateDir: "/srv/state", keyFile: "/srv/key", runDir: "/srv/run", projects: [{ id: "p1", path: "/srv/p1" }, { id: "p2", path: "/srv/p2", source: { mode: "github" } }],
  } as unknown as Config;
  const paths = evalCanaries(config, { mirrorPath: id => `/srv/mirror/${id}` });
  for (const expected of ["/srv/key", "/srv/state", "/srv/run", "/srv/p1", "/srv/p2", "/srv/mirror/p2"]) assert.ok(paths.includes(expected), expected);
  assert.equal(paths.includes("/srv/mirror/p1"), false);

  assert.equal(repositoryUrl({}, "p1", "org/repo"), "https://github.com/org/repo.git");
  assert.equal(repositoryUrl({ source: { remoteOverrides: { p1: "file:///x" } } } as unknown as Pick<Config, "source">, "p1", "org/repo"), "file:///x");
});
