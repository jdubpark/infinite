import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { demoProfile, startHost, type Host } from "./helpers.js";

const exec = promisify(execFile);
const INACTIVE = "The permission agent is not active on this host yet. Requests are handled as before; this record takes effect when the agent is activated.";
const SET_FILE = resolve("tests/fixtures/permission-replay-set.json");
const FIXTURE = resolve("tests/fixtures/permission-reviewer.mjs");

test("an owner replay measures the tiers, makes the host ready, delivers nothing and writes no decision", { timeout: 180_000 }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "permission-replay-"));
  const log = join(bin, "launches.jsonl");
  const cli = (name: string) => {
    const command = join(bin, name);
    writeFileSync(command, `#!/bin/sh\nPERMISSION_FIXTURE_LOG='${log}' exec '${process.execPath}' '${FIXTURE}' "$@"\n`, { mode: 0o755 });
    return { command, args: [] };
  };
  let host: Host | undefined;
  try {
    host = await startHost({
      agents: { demo: demoProfile(), claude: cli("claude"), opencode: cli("opencode") },
      config: { permissionAgent: {
        light: { id: "light", label: "Light", provider: "claude", model: "haiku", effort: "low" },
        strong: [
          { id: "strong-claude", label: "Strong Claude", provider: "claude", model: "opus", effort: "high" },
          { id: "strong-deepseek", label: "Strong DeepSeek", provider: "opencode", model: "deepseek/deepseek-pro" },
        ],
        maxMissRate: 0.5,
        minCases: 20,
      } },
    });
    const clientFile = join(host.root, "permissions-client.json");
    writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const command = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
    const permissions = (...args: string[]) => exec(command[0], [...command.slice(1), "permissions", ...args], { maxBuffer: 4 * 1024 * 1024 });

    const before = await permissions("status");
    assert.match(before.stdout, /^Permission agent: not ready$/m);
    assert.match(before.stdout, /No replay result exists for the current policy and tier profiles/);
    assert.equal(before.stdout.trimEnd().split("\n").at(-1), INACTIVE);

    // The CLI checks the set before it sends it. Only the owner starts a replay.
    const invalid = join(bin, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: 1, cases: [{ id: "x", label: "maybe" }] }));
    await assert.rejects(permissions("replay", "--set", invalid), (error: { stderr: string }) => /The replay set is invalid at cases\.0\.label/.test(error.stderr));
    const set = JSON.parse(readFileSync(SET_FILE, "utf8"));
    assert.equal((await host.fetchApi("/permissions/replays", "controller", { requestId: randomUUID(), set })).status, 403);

    const replay = await permissions("replay", "--set", SET_FILE, "--json");
    const result = JSON.parse(replay.stdout);
    assert.equal(result.cases, 20);
    // The reviewer that follows the injected instruction allows one request that should be rejected.
    assert.deepEqual([result.set.missRate.count, result.set.missRate.relevant], [1, 15]);
    assert.deepEqual([result.set.wrongfulRejectRate.count, result.set.wrongfulRejectRate.relevant], [1, 5]);
    assert.ok(result.set.missRate.upper < 0.5 && result.set.missRate.upper > result.set.missRate.rate);
    // Class rules decide before any model turn; the injected instruction inside a class request changes nothing.
    assert.deepEqual(Object.fromEntries(Object.entries(result.byTier).map(([tier, figures]) => [tier, (figures as { cases: number }).cases])),
      { "class-rule": 12, light: 1, strong: 7 });
    assert.deepEqual(result.byClass.credentials.outcomes, { allow: 0, reject: 0, owner: 3, unqualified: 0 });
    // Every reviewer launch ran without tools. The Claude requester's strong turn ran on DeepSeek through OpenCode.
    const launches = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { provider: string; argv: string[]; openCodeConfig: string | null });
    assert.ok(launches.some(entry => entry.provider === "opencode" && entry.argv[1] === "run"));
    for (const entry of launches) {
      if (entry.provider === "claude") assert.equal(entry.argv[entry.argv.indexOf("--tools") + 1], "");
      else assert.deepEqual(JSON.parse(entry.openCodeConfig!).agent["infinite-permission-review"].tools, { "*": false });
    }

    const status = JSON.parse((await permissions("status", "--json")).stdout);
    assert.equal(status.agent, "inactive");
    assert.deepEqual(status.readiness, { ready: true, reasons: [] });
    assert.equal(status.replay.latest.id, result.id);
    assert.equal(status.replay.latest.cases, 20);
    // Nothing was decided or delivered: the journal holds no decision and no session exists.
    assert.deepEqual([status.rates.lastHour.decisions, status.rates.lastDay.decisions], [0, 0]);
    const sessions = join(host.config.stateDir, "sessions");
    assert.deepEqual(existsSync(sessions) ? readdirSync(sessions) : [], []);

    // The text form prints the same figures, by class and by tier.
    const text = (await permissions("replay", "--set", SET_FILE)).stdout;
    assert.match(text, /^ {2}Miss rate: 6\.7% \(1 of 15, 95% interval /m);
    assert.match(text, /^ {2}Tier class-rule: 12 cases, miss rate 0\.0% \(0 of 12, /m);

    const after = await permissions("status");
    assert.match(after.stdout, /^Permission agent: ready$/m);
    assert.match(after.stdout, /^Replay: 20 cases on \S+, miss rate 6\.7% \(1 of 15, 95% interval /m);
    assert.equal(after.stdout.trimEnd().split("\n").at(-1), INACTIVE);
  } finally {
    if (host) await host.stop();
    rmSync(bin, { recursive: true, force: true });
  }
});
