import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvalIdentity, launcherEvalIdentity, stopEvalIdentity } from "../packages/host/src/eval-identity.js";
import type { EvalMemberConfig } from "../packages/host/src/eval-config.js";
import type { RuntimeProcess } from "../packages/host/src/team-retirement.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/eval-command.mjs", import.meta.url));
const TRIAL = "22222222-3333-4444-8555-666666666666";
const UID = process.getuid?.() ?? 0;
// The fixture runs as this user, so root could read every canary; the probe's root rules need a non-root user too.
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

/** The fixture as the member's launcher prefix, with the fixture's flags before the operation. */
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

/** The host runs as another uid by default, so the fixture's account is not the host's. */
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

  // No eval.member: not-configured.
  assert.equal((await launcherEvalIdentity(() => undefined).probe({ canaries: [] })).state, "not-configured");

  // A launcher that exits 1: unavailable.
  const failingIdentity = launcherEvalIdentity(() => ({ ...member(sb), prefix: { command: process.execPath, args: [failing] } }), { hostUid: UID + 1 });
  assert.equal((await failingIdentity.probe({ canaries: [] })).state, "unavailable");

  // Misconfigured: a root mode other than 711, a writable ancestor, the host's uid, and the grader's uid.
  chmodSync(sb.root, 0o700);
  assert.equal((await identityFor(sb).probe({ canaries: [] })).state, "misconfigured");
  chmodSync(sb.root, 0o711);
  assert.equal((await identityFor(sb, ["--ancestors-writable"]).probe({ canaries: [] })).state, "misconfigured");
  assert.equal((await identityFor(sb, [], UID).probe({ canaries: [] })).state, "misconfigured");
  assert.equal((await identityFor(sb).probe({ canaries: [], graderUid: UID })).state, "misconfigured");

  // Exposed: a canary the account can read. A canary with mode 0000 is not readable, so it passes.
  assert.equal((await identityFor(sb).probe({ canaries: [exposed] })).state, "exposed");
  assert.equal((await identityFor(sb).probe({ canaries: [sealed] })).state, "ready");

  // Network open: the metadata endpoint answers.
  assert.equal((await identityFor(sb, ["--metadata", "open"]).probe({ canaries: [] })).state, "network-open");

  // Busy: an entry in trials, a planted file in the home, a file in the temporary directory, or an entry of the root other than trials.
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

  // Ready, with fetch skipped; with a fetch the probe reports open, and the proxy URL is never in the record.
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

  // The process survives all three rounds: alive, after three stops.
  assert.equal(await stopEvalIdentity(identity, UID, async () => [row]), "alive");
  assert.equal(records(sb).filter(entry => entry.argv[0] === "stop").length, 3);

  // The process is gone after the second inventory: stopped.
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
