import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DRAIN_WRAPPER, drainLaunch, runFinalDrain } from "../packages/host/src/final-drain.js";
import { sudoShape } from "../packages/host/src/sudo-profile.js";
import type { AgentProfile } from "../packages/host/src/types.js";

const relay = "/opt/infinite/packages/host/dist/hook-relay.js";
const wrapper = resolve("deploy/ubuntu/transcript-drain.sh");
const sudoers = resolve("deploy/ubuntu/infinite.sudoers");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return condition();
};

test("a sudo profile shape is read once for the launch and the drain", () => {
  assert.deepEqual(sudoShape(["-n", "-H", "-u", "agent", "-g", "staff", "--", "/usr/local/libexec/infinite/claude", "--model", "m"]), {
    ok: true,
    options: ["-n", "-H", "-u", "agent", "-g", "staff"],
    executable: "/usr/local/libexec/infinite/claude",
    providerArgs: ["--model", "m"],
  });
  assert.deepEqual(sudoShape(["--non-interactive", "--set-home", "--user", "agent", "--group", "staff", "--", "/x/claude"]).ok, true);
  assert.deepEqual(sudoShape(["-E", "-u", "agent", "--", "/x/claude"]), { ok: false, problem: "wrapper" });
  assert.deepEqual(sudoShape(["-n", "/x/claude"]), { ok: false, problem: "wrapper" });
  assert.deepEqual(sudoShape(["-u", "--", "/x/claude"]), { ok: false, problem: "wrapper" });
  assert.deepEqual(sudoShape(["-n", "--"]), { ok: false, problem: "executable" });
  assert.deepEqual(sudoShape(["--", "-H", "/x/claude"]), { ok: false, problem: "executable" });
});

test("a same-account profile drains with the relay itself", () => {
  assert.deepEqual(drainLaunch({ command: "claude", args: [] }, relay), { command: process.execPath, args: [relay, "drain"] });
  const launch = drainLaunch({ command: "claude", args: [] }, "/opt/infinite/packages/host/src/hook-relay.ts");
  assert.ok(launch);
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[0], "--import");
  assert.deepEqual(launch.args.slice(-2), ["/opt/infinite/packages/host/src/hook-relay.ts", "drain"]);
});

test("a sudo profile drains through the wrapper beside its provider", () => {
  const folder = mkdtempSync(join(tmpdir(), "infinite-drain-"));
  try {
    writeFileSync(join(folder, "claude"), "");
    writeFileSync(join(folder, DRAIN_WRAPPER), "");
    const provider = join(folder, "claude");
    const profile = (args: string[]): AgentProfile => ({ command: "/usr/bin/sudo", args });
    assert.deepEqual(drainLaunch(profile(["-H", "-u", "agent", "--", provider, "--model", "m"]), relay), {
      command: "/usr/bin/sudo",
      args: ["-n", "-H", "-u", "agent", "--", join(folder, DRAIN_WRAPPER)],
    });
    const explicit = drainLaunch(profile(["-n", "-H", "-u", "agent", "--", provider]), relay);
    assert.deepEqual(explicit?.args, ["-n", "-H", "-u", "agent", "--", join(folder, DRAIN_WRAPPER)]);
    assert.equal(explicit?.args.filter(arg => arg === "-n").length, 1, "-n appears once");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a missing wrapper or an unknown sudo shape skips the drain", () => {
  const folder = mkdtempSync(join(tmpdir(), "infinite-drain-skip-"));
  const folderWithDirectory = mkdtempSync(join(tmpdir(), "infinite-drain-dir-"));
  try {
    const provider = join(folder, "claude");
    writeFileSync(provider, "");
    assert.equal(drainLaunch({ command: "/usr/bin/sudo", args: ["-H", "--", provider] }, relay), undefined, "no wrapper file");
    mkdirSync(join(folderWithDirectory, DRAIN_WRAPPER));
    writeFileSync(join(folderWithDirectory, "claude"), "");
    assert.equal(drainLaunch({ command: "/usr/bin/sudo", args: ["-H", "--", join(folderWithDirectory, "claude")] }, relay), undefined, "a folder is not a wrapper");
    writeFileSync(join(folder, DRAIN_WRAPPER), "");
    assert.equal(drainLaunch({ command: "/usr/bin/sudo", args: ["-E", "-u", "agent", "--", provider] }, relay), undefined, "-E before --");
    assert.equal(drainLaunch({ command: "/usr/bin/sudo", args: ["-H", provider] }, relay), undefined, "no --");
    assert.equal(drainLaunch({ command: "/usr/bin/sudo", args: ["-H", "--", "claude"] }, relay), undefined, "a relative executable");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(folderWithDirectory, { recursive: true, force: true });
  }
});

test("a drain that outlives the limit is stopped", async () => {
  const folder = mkdtempSync(join(tmpdir(), "infinite-drain-hang-"));
  try {
    const pidFile = join(folder, "pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const started = Date.now();
    await runFinalDrain({ command: process.execPath, args: ["-e", script] }, {}, 300);
    assert.ok(Date.now() - started < 2000, "the drain resolves at its limit");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid), 2000), "the drain process is stopped");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a drain resolves when its process exits or cannot start", async () => {
  const started = Date.now();
  await runFinalDrain({ command: process.execPath, args: ["-e", "process.exit(3)"] }, {}, 10_000);
  assert.ok(Date.now() - started < 3000, "an exit resolves at once");
  await runFinalDrain({ command: "/nonexistent/infinite-missing-drain", args: [] }, {}, 10_000);
});

test("the drain wrapper takes no arguments", () => {
  const body = readFileSync(wrapper, "utf8").trimEnd().split("\n");
  assert.equal(body.at(-1), "exec /usr/local/bin/node /opt/infinite/packages/host/dist/hook-relay.js drain");
  const refused = spawnSync("/bin/sh", [wrapper, "extra"], { encoding: "utf8" });
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /no arguments/);
});

test("sudoers allows the drain wrapper only without arguments", () => {
  const text = readFileSync(sudoers, "utf8");
  assert.ok(text.includes('infinite-host ALL=(infinite-agent) NOPASSWD: /usr/local/libexec/infinite/transcript-drain ""\n'));
  assert.equal(/transcript-drain[^\n]*\*/.test(text), false);
});
