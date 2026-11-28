import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { teamModelLaunch } from "../packages/host/src/launch.js";
import { readOpenCodeVersion } from "../packages/host/src/opencode-version.js";
import { nestedToolsFromRunLine, toolFromRunLine, usageFromRunLine } from "../packages/host/src/opencode-usage.js";
import { createCliTurnLauncher, openCodeAgentsDenyEverything, openCodeParser, openCodeReviewerArgs, openCodeReviewerConfig, reviewerEnvironment, type PermissionTurn } from "../packages/host/src/permission-reviewer.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import { startHost } from "./helpers.js";

const FIXTURE = resolve("tests/fixtures/permission-reviewer.mjs");

function fakeOpenCode(dir: string, version: string, log = join(dir, "argv.jsonl")) {
  mkdirSync(dir, { recursive: true });
  const command = join(dir, "opencode");
  writeFileSync(command, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' '${log}' "$@"\n`);
  chmodSync(command, 0o755);
  return { command, log };
}

const recorded = (log: string): string[][] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("the installed OpenCode major version picks the member launch form, and an unreadable version keeps version 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-versions-"));
  try {
    const scout: TeamModelProfile = { id: "scout", label: "Scout", provider: "opencode", model: "example/scout", variant: "high" };
    const operatorArgs = ["--agent", "reviewer", "--pure", "--format", "json"];
    const launchAndRecord = async (command: string, log: string) => {
      const read = await readOpenCodeVersion({ command, prefix: [] });
      const launch = teamModelLaunch({ command, args: operatorArgs }, scout, read.major);
      execFileSync(launch.command, [...launch.args, "--", "do the work"]);
      return { read, argv: recorded(log).at(-1) };
    };

    const first = fakeOpenCode(join(dir, "one"), "1.19.6");
    const one = await launchAndRecord(first.command, first.log);
    assert.deepEqual([one.read.major, one.read.known], [1, true]);
    assert.deepEqual(one.argv, ["run", "--agent", "reviewer", "--pure", "--format", "json", "--model", "example/scout", "--variant", "high", "--", "do the work"]);

    const second = fakeOpenCode(join(dir, "two"), "2.3.2");
    const two = await launchAndRecord(second.command, second.log);
    assert.deepEqual([two.read.major, two.read.known], [2, true]);
    assert.deepEqual(two.argv, ["run", "--standalone", "--agent", "reviewer", "--format", "json", "--model", "example/scout#high", "--", "do the work"]);

    const garbled = fakeOpenCode(join(dir, "three"), "not a version");
    const unknown = await launchAndRecord(garbled.command, garbled.log);
    assert.deepEqual([unknown.read.major, unknown.read.known], [1, false]);
    assert.match(unknown.read.note ?? "", /not recognised/);
    assert.deepEqual(unknown.argv, one.argv);

    const missing = await readOpenCodeVersion({ command: join(dir, "absent", "opencode"), prefix: [] });
    assert.deepEqual([missing.major, missing.known], [1, false]);
    assert.equal((await readOpenCodeVersion(undefined)).major, 1);

    const future = fakeOpenCode(join(dir, "four"), "3.0.0");
    const ahead = await readOpenCodeVersion({ command: future.command, prefix: [] });
    assert.deepEqual([ahead.major, ahead.known], [1, false]);

    const flaky = fakeOpenCode(join(dir, "six"), "2.3.2");
    const marker = join(dir, "six", "down");
    writeFileSync(marker, "");
    writeFileSync(flaky.command, `#!/bin/sh\nif [ -f '${marker}' ]; then exit 1; fi\necho 2.3.2\n`);
    assert.equal((await readOpenCodeVersion({ command: flaky.command, prefix: [] })).known, false);
    unlinkSync(marker);
    assert.equal((await readOpenCodeVersion({ command: flaky.command, prefix: [] })).major, 2, "an unreadable version is retried at the next launch");

    const upgraded = fakeOpenCode(join(dir, "five"), "1.19.6");
    assert.equal((await readOpenCodeVersion({ command: upgraded.command, prefix: [] })).major, 1);
    fakeOpenCode(join(dir, "five"), "2.3.2 ");
    assert.equal((await readOpenCodeVersion({ command: upgraded.command, prefix: [] })).major, 2, "an upgrade while the host runs is seen without a restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version 2 member launch drops the version 1 plugin switch in every spelling and leaves the sudo wrapper in place", () => {
  const scout: TeamModelProfile = { id: "scout", label: "Scout", provider: "opencode", model: "example/scout" };
  const wrapper = ["-n", "-H", "-u", "infinite-agent", "--", "/usr/local/libexec/infinite/opencode"];
  const launch = teamModelLaunch({ command: "/usr/bin/sudo", args: [...wrapper, "--pure=true", "--print-logs", "--pure"] }, scout, 2);
  assert.deepEqual(launch.args, [...wrapper, "run", "--standalone", "--print-logs", "--format", "json", "--model", "example/scout"]);
});

const strong = (extra: Partial<TeamModelProfile> = {}): TeamModelProfile => ({ id: "strong-deepseek", label: "Strong DeepSeek", provider: "opencode", model: "deepseek/deepseek-pro", ...extra }) as TeamModelProfile;

test("an OpenCode 2 reviewer turn is refused before any run or debug process starts", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-reviewer-"));
  const log = join(dir, "launches.jsonl");
  try {
    const command = join(dir, "opencode");
    writeFileSync(command, `#!/bin/sh\nPERMISSION_FIXTURE_VERSION=2.3.2 PERMISSION_FIXTURE_LOG='${log}' exec '${process.execPath}' '${FIXTURE}' "$@"\n`, { mode: 0o755 });
    const launcher = createCliTurnLauncher({ agents: { opencode: { command, args: [] } }, env: reviewerEnvironment({ ...process.env }), workRoot: dir });
    const turn: PermissionTurn = { purpose: "review", tier: "strong", profile: strong({ variant: "high" }), timeoutMs: 20_000, system: "You review.", schema: {}, prompt: "Decide." };
    assert.deepEqual(await launcher.run(turn), { ok: false, failure: "unsupported" });
    assert.throws(() => readFileSync(log), "the fake opencode was never invoked for run or debug");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the version 2 reviewer builders deny every permission and the execute tool", () => {
  const config = JSON.parse(openCodeReviewerConfig("You review.", 2));
  const agent = config.agents["infinite-permission-review"];
  assert.equal(agent.system, "You review.");
  assert.ok(agent.permissions.every((rule: { resource: string; effect: string }) => rule.resource === "*" && rule.effect === "deny"));
  assert.ok(agent.permissions.some((rule: { action: string }) => rule.action === "execute"));
  assert.deepEqual(openCodeReviewerArgs({ profile: strong({ variant: "high" }), prompt: "p" }, 2).slice(0, 2), ["run", "--standalone"]);
});

test("the version 2 reviewer check accepts only an agent whose last matching rule denies every tool and execute", () => {
  const deny = JSON.parse(openCodeReviewerConfig("s", 2)).agents["infinite-permission-review"].permissions;
  const listing = (permissions: unknown, id = "infinite-permission-review") => `log line\n${JSON.stringify([{ id: "build", permissions: [] }, { id, permissions }], null, 2)}\n`;
  assert.equal(openCodeAgentsDenyEverything(listing(deny)), true);
  assert.equal(openCodeAgentsDenyEverything(listing([{ action: "*", resource: "*", effect: "allow" }, ...deny])), true);
  assert.equal(openCodeAgentsDenyEverything(listing([...deny, { action: "read", resource: "*", effect: "allow" }])), false);
  assert.equal(openCodeAgentsDenyEverything(listing([...deny, { action: "*", resource: "*", effect: "ask" }])), false);
  assert.equal(openCodeAgentsDenyEverything(listing([...deny, { action: "execute", resource: "src/*", effect: "allow" }])), false);
  assert.equal(openCodeAgentsDenyEverything(listing([{ action: "*", resource: "*", effect: "deny" }])), false, "execute must be denied by name too");
  assert.equal(openCodeAgentsDenyEverything(listing([...deny, { action: "web*", resource: "*", effect: "allow" }])), false, "a wildcard allow after the deny");
  assert.equal(openCodeAgentsDenyEverything(listing([...deny, { action: "web*", resource: "*", effect: "deny" }])), true);
  assert.equal(openCodeAgentsDenyEverything(`[warn] noisy\n${listing(deny)}`), true, "a log line starting with a bracket does not hide the listing");
  assert.equal(openCodeAgentsDenyEverything(listing(deny, "other")), false);
  assert.equal(openCodeAgentsDenyEverything("not json"), false);
});

const sessionID = "ses_01HXYZ";
const stepFinish = { type: "step_finish", timestamp: 1_790_000_000_000, sessionID, part: { id: "prt_01", sessionID, messageID: "msg_01", type: "step-finish", reason: "stop", snapshot: "snap_1", cost: 0.004, tokens: { input: 900, output: 80, reasoning: 20, cache: { read: 300, write: 10 } } } };
const textLine = { type: "text", timestamp: 1_790_000_000_001, sessionID, part: { id: "prt_02", sessionID, messageID: "msg_01", type: "text", text: "{\"verdict\":\"refer\",\"note\":\"n\"}", time: { start: 1, end: 2 } } };
const toolLine = (status: string, calls?: unknown[]) => ({ type: "tool_use", timestamp: 3, sessionID, part: { partID: "prt_03", sessionID, messageID: "msg_01", type: "tool", id: "call_abc", tool: "execute", state: status === "error"
  ? { status, input: { code: "x" }, error: "boom", metadata: calls ? { metadata: { toolCalls: calls }, content: [] } : {}, time: { start: 1, end: 2 } }
  : { status, input: { code: "x" }, output: "done", title: "execute", metadata: calls ? { metadata: { toolCalls: calls }, content: [] } : { metadata: {}, content: [] }, time: { start: 1, end: 2 } } } });

test("OpenCode 2 run lines give usage, the call id, and the calls nested inside an execute call", () => {
  const usage = usageFromRunLine(stepFinish, "deepseek/deepseek-pro", new Date(0));
  assert.deepEqual(usage?.tokens, { input: 900, output: 80, reasoning: 20, cacheRead: 300, cacheWrite: 10 });
  assert.equal(usage?.reportedCost, 0.004);
  assert.deepEqual([usage?.messageId, usage?.partId], ["msg_01", "prt_01"]);

  assert.deepEqual(toolFromRunLine(toolLine("completed")), { tool: "execute", toolUseId: "call_abc", ok: true });
  assert.deepEqual(toolFromRunLine(toolLine("error")), { tool: "execute", toolUseId: "call_abc", ok: false });

  const calls = [{ tool: "read", status: "completed", input: { path: "a" } }, { tool: "bash", status: "error" }, { tool: "grep", status: "running" }, { status: "completed" }];
  assert.deepEqual(nestedToolsFromRunLine(toolLine("completed", calls)), [
    { tool: "read", toolUseId: "call_abc#0", ok: true }, { tool: "bash", toolUseId: "call_abc#1", ok: false },
  ]);
  assert.deepEqual(nestedToolsFromRunLine(toolLine("error", calls)).map(call => call.tool), ["read", "bash"]);
  assert.deepEqual(nestedToolsFromRunLine(toolLine("completed")), []);
  assert.deepEqual(nestedToolsFromRunLine({ ...toolLine("completed", calls), part: { ...toolLine("completed", calls).part, tool: "bash" } }), []);
  assert.deepEqual(nestedToolsFromRunLine(textLine), []);
  const bare = toolLine("completed");
  assert.deepEqual(nestedToolsFromRunLine({ ...bare, part: { ...bare.part, state: { ...bare.part.state, metadata: { toolCalls: calls } } } }), [], "tool calls directly under state.metadata are not the shape version 2 emits");
});

test("the reviewer parser reads OpenCode 2 usage and still stops on any tool call", () => {
  const parser = openCodeParser("deepseek/deepseek-pro");
  for (const line of [{ type: "step_start", sessionID, part: { type: "step-start" } }, textLine, stepFinish]) assert.equal(parser.line(JSON.stringify(line)), "continue");
  assert.deepEqual(parser.result(), { ok: true, output: { verdict: "refer", note: "n" } });
  assert.deepEqual(parser.usage()?.tokens, { input: 900, output: 80, reasoning: 20, cacheRead: 300, cacheWrite: 10 });
  assert.equal(parser.line(JSON.stringify(toolLine("completed", []))), "stop");
  assert.deepEqual(parser.result(), { ok: false, failure: "tool-used" });
  const failing = openCodeParser("a/b");
  assert.equal(failing.line(JSON.stringify({ type: "error", timestamp: 1, sessionID, error: { type: "provider.no-route", message: "Model unavailable: a/b" } })), "stop");
  assert.deepEqual(failing.result(), { ok: false, failure: "provider-error" });
});

test("a native OpenCode session is refused when OpenCode 2 is installed", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-native-"));
  try {
    const fake = fakeOpenCode(dir, "2.3.2");
    const host = await startHost({ agents: { opencode: { command: fake.command, args: [] } } });
    try {
      const response = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "opencode", title: "Native", projectId: "rehearsal", localUi: true, nativeArgs: [] });
      assert.notEqual(response.status, 201);
      assert.match(JSON.stringify(response.body), /OpenCode 1/);
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
