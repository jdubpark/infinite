import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, reportName, validateIntakeConfig } from "../packages/host/src/config.js";
import { deterministicUuid, intakeConfigSchema, missionRequestId } from "../packages/host/src/intake-types.js";
import { MirroredProjects } from "../packages/host/src/mirrored-projects.js";
import { writeSealed } from "../packages/host/src/vault.js";

// The host package pins zod 4; the root zod 3 has no z.uuid(), so reuse the host's UUID schema.
const uuid = intakeConfigSchema.shape.linear.shape.teamIds.element;

const TEAM = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";

const root = mkdtempSync(join(tmpdir(), "inf-intake-"));
after(() => rmSync(root, { recursive: true, force: true }));

const privateFile = (name: string, mode = 0o600) => {
  const path = join(root, name);
  writeFileSync(path, "fixture-token\n");
  chmodSync(path, mode);
  return path;
};
mkdirSync(join(root, "state"));
writeFileSync(join(root, "key"), Buffer.alloc(32, 1), { mode: 0o600 });
const appTokenFile = privateFile("slack-app-token");
const botTokenFile = privateFile("slack-bot-token");
const worldReadable = privateFile("slack-world-readable", 0o644);
const insideStateDir = privateFile("state/slack-inside");
const emptyToken = join(root, "slack-empty-token");
writeFileSync(emptyToken, "\n");
chmodSync(emptyToken, 0o600);

const slack = {
  appTokenFile,
  botTokenFile,
  teamId: "T00000000",
  ownerUserId: "U00000000",
  linearAgentUserId: "U11111111",
};
const base = {
  linear: { teamIds: [TEAM], creatorId: OWNER, label: "infinite" },
  slack,
  mission: { groupId: "work" },
};
const baseHost = {
  port: 1,
  origin: "http://127.0.0.1",
  stateDir: join(root, "state"),
  runDir: join(root, "run"),
  keyFile: join(root, "key"),
  environment: "local",
  tokens: [{ id: "a", label: "a", role: "owner", hash: "a".repeat(64) }],
  projects: [{ id: "work-repo", name: "Work", path: join(root, "work-repo") }],
  linear: { apiKeyFile: privateFile("linear-key") },
};

let counter = 0;
/** Writes a config file with `intake` merged over the valid base intake block and `host` over the base host config. */
function parsed(intake: Record<string, unknown>, host: Record<string, unknown> = {}) {
  const file = join(root, `config-${++counter}.json`);
  writeFileSync(file, JSON.stringify({ ...baseHost, ...host, intake: { ...base, ...intake } }));
  return readConfig(file).config;
}
/** Same as `parsed`, then runs the intake validator on the parsed config. */
function validate(intake: Record<string, unknown>, host: Record<string, unknown> = {}) {
  const config = parsed(intake, host);
  validateIntakeConfig(config);
  return config;
}

test("the intake block applies its defaults", () => {
  const intake = parsed({ linear: { teamIds: [TEAM], creatorId: OWNER, label: "infinite" }, mission: { groupId: "work" }, requireSlackThread: false }).intake!;
  assert.deepEqual([intake.maxActive, intake.mission.maxSubtasks, intake.mission.maxMinutes, intake.linear.commentsMirrorToSlack], [3, 8, 240, false]);
});
test("intake needs the host Linear credential", () => assert.throws(() => validate({}, { linear: undefined }), /Intake requires a host Linear credential/));
test("a required Slack thread needs the Slack block and Linear's agent ID", () => {
  assert.throws(() => validate({ slack: undefined, requireSlackThread: true }), /requireSlackThread needs intake\.slack/);
  assert.throws(() => validate({ slack: { ...slack, linearAgentUserId: undefined } }), /linearAgentUserId/);
});
test("not admitting Linear issues needs direct requests, which need no Linear agent ID", () => {
  const linear = { ...base.linear, admitIssues: false };
  assert.throws(() => validate({ linear }), /admitIssues/);
  assert.doesNotThrow(() => validate({ linear, slack: { ...slack, directRequests: true, linearAgentUserId: undefined } }));
  assert.equal(parsed({}).intake!.linear.admitIssues, true);
  assert.equal(parsed({}).intake!.slack!.directRequests, false);
});
test("answering questions needs direct requests, and classifying needs both answering and the jev block", () => {
  const direct = { ...slack, directRequests: true };
  const jev = { apiKeyFile: privateFile("jev-key") };
  assert.throws(() => validate({ slack: { ...slack, answerQuestions: true } }), /answerQuestions needs intake\.slack\.directRequests/);
  assert.throws(() => validate({ slack: { ...direct, classify: true } }), /classify needs intake\.slack\.answerQuestions/);
  assert.throws(() => validate({ slack: { ...direct, answerQuestions: true, classify: true } }), /classify needs the jev block/);
  assert.doesNotThrow(() => validate({ slack: { ...direct, answerQuestions: true } }));
  assert.doesNotThrow(() => validate({ slack: { ...direct, answerQuestions: true, classify: true } }, { jev }));
  const defaults = parsed({}).intake!.slack!;
  assert.deepEqual([defaults.answerQuestions, defaults.classify], [false, false]);
});
test("request channels are optional, bounded unique Slack channel IDs and require direct requests when enabled", () => {
  assert.deepEqual(parsed({}).intake!.slack!.requestChannelIds, undefined);
  assert.deepEqual(parsed({ slack: { ...slack, requestChannelIds: [] } }).intake!.slack!.requestChannelIds, []);
  assert.doesNotThrow(() => validate({ slack: { ...slack, directRequests: true, requestChannelIds: ["C123", "G456"] } }));
  assert.throws(() => validate({ slack: { ...slack, requestChannelIds: ["C123"] } }), /requestChannelIds needs intake\.slack\.directRequests/);
  assert.throws(() => parsed({ slack: { ...slack, requestChannelIds: ["C123", "C123"] } }));
  assert.throws(() => parsed({ slack: { ...slack, requestChannelIds: ["U123"] } }));
  const tooManyChannels = Array.from({ length: 21 }, (_, index) => `C${String(index).padStart(3, "0")}`);
  assert.throws(() => parsed({ slack: { ...slack, requestChannelIds: tooManyChannels } }));
});
test("linear.reportName defaults to Infinite, accepts a plain name, and rejects Markdown, link text, newlines, and long values", () => {
  assert.equal(reportName(parsed({})), "Infinite");
  assert.equal(Object.hasOwn(parsed({}).linear!, "reportName"), false, "display defaults leave persisted configuration digests unchanged");
  assert.equal(reportName(parsed({}, { linear: { apiKeyFile: privateFile("linear-key"), reportName: "Northwind" } })), "Northwind");
  assert.equal(reportName(parsed({}, { linear: { apiKeyFile: privateFile("linear-key"), reportName: "Northwind East - 2" } })), "Northwind East - 2");
  for (const reportName of ["[x](y)", "North\nwind", "", "a".repeat(41), "North _wind_", "1. Northwind", "_Northwind", "9Lives", "www.example.com", "Northwind Co."])
    assert.throws(() => parsed({}, { linear: { apiKeyFile: privateFile("linear-key"), reportName } }), undefined, JSON.stringify(reportName));
});
test("jev.sessionReadings defaults to true and accepts false", () => {
  const apiKeyFile = privateFile("jev-key");
  assert.equal(parsed({}, { jev: { apiKeyFile } }).jev!.sessionReadings, true);
  assert.equal(parsed({}, { jev: { apiKeyFile, sessionReadings: false } }).jev!.sessionReadings, false);
});
test("intake refuses a configuration without the owner's creator ID when a thread is required", () =>
  assert.throws(() => validate({ linear: { ...base.linear, creatorId: undefined }, requireSlackThread: true }), /creatorId/));
test("intake refuses a configuration without the owner's creator ID when no thread is required", () =>
  assert.throws(() => validate({ linear: { ...base.linear, creatorId: undefined }, requireSlackThread: false }), /creatorId/));
test("binding by mention excludes a required thread", () => assert.throws(() => validate({ slack: { ...slack, bindByMention: true } }), /bindByMention/));
test("Slack token files are private and outside runtime state", () => {
  assert.throws(() => validate({ slack: { ...slack, botTokenFile: worldReadable } }), /private 0600 file/);
  assert.throws(() => validate({ slack: { ...slack, appTokenFile: insideStateDir } }), /private 0600 file/);
});
test("an empty Slack token file is refused", () => {
  assert.throws(() => validate({ slack: { ...slack, botTokenFile: emptyToken } }), /nonempty private 0600 file/);
  assert.throws(() => validate({ slack: { ...slack, appTokenFile: emptyToken } }), /nonempty private 0600 file/);
});
test("mirroring comments to Slack needs the Slack block", () => {
  assert.throws(() => validate({ slack: undefined, requireSlackThread: false, linear: { ...base.linear, commentsMirrorToSlack: true } }), /commentsMirrorToSlack needs intake\.slack/);
  assert.doesNotThrow(() => validate({ linear: { ...base.linear, commentsMirrorToSlack: true } }));
});
test("Linear's agent is a user ID, never a bot ID", () => {
  assert.throws(() => parsed({ slack: { ...slack, linearAgentUserId: "B00000000" } }));
  assert.doesNotThrow(() => parsed({ slack: { ...slack, linearAgentUserId: "W11111111" } }));
});
test("a loopback Slack endpoint is local-only", () => {
  assert.throws(() => validate({ slack: { ...slack, endpoint: "http://127.0.0.1:9/api" } }, { environment: "cloud" }), /official HTTPS endpoint/);
  assert.doesNotThrow(() => validate({ slack: { ...slack, endpoint: "http://127.0.0.1:9/api" } }, { environment: "local" }));
  for (const endpoint of ["http://user:secret@127.0.0.1:9/api", "http://127.0.0.1:9/api?team=other", "http://127.0.0.1:9/api#fragment"])
    assert.throws(() => validate({ slack: { ...slack, endpoint } }, { environment: "local" }), /official HTTPS endpoint/, endpoint);
});
test("the answer repository is a configured project", () => assert.throws(() => validate({ mission: { groupId: "work", answerProjectId: "missing" } }), /answerProjectId/));
test("hostLoad accepts the spec default and rejects a zero load ceiling", () => {
  assert.deepEqual(parsed({}, { hostLoad: { minAvailableMemoryGiB: 8, maxLoadPerCpu: 1.5 } }).hostLoad, { minAvailableMemoryGiB: 8, maxLoadPerCpu: 1.5 });
  assert.throws(() => parsed({}, { hostLoad: { minAvailableMemoryGiB: 8, maxLoadPerCpu: 0 } }));
});
test("deterministicUuid is stable, namespaced, and a valid UUID", () => {
  assert.equal(missionRequestId(ISSUE), missionRequestId(ISSUE));
  assert.notEqual(deterministicUuid("a", ISSUE), deterministicUuid("b", ISSUE));
  assert.doesNotThrow(() => uuid.parse(missionRequestId(ISSUE)));
});

test("MCP is disabled by default and supports intake without a Slack producer", () => {
  assert.equal(parsed({}).mcp, undefined);
  const mcp = { port: 2, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: "b".repeat(64), projectIds: ["work-repo"] }] };
  assert.deepEqual(parsed({ slack: undefined, requireSlackThread: false, linear: { ...base.linear, admitIssues: false } }, { mcp }).mcp, mcp);
  for (const patch of [
    { port: 1 },
    { origin: "https://connector.example/mcp" },
    { origin: "http://connector.example" },
    { connectors: [{ ...mcp.connectors[0], projectIds: ["missing"] }] },
    { connectors: [{ ...mcp.connectors[0], tokenHash: "a".repeat(64) }] },
    { connectors: [mcp.connectors[0], mcp.connectors[0]] },
    { unexpected: true },
  ]) assert.throws(() => parsed({}, { mcp: { ...mcp, ...patch } }));
  assert.throws(() => parsed({}, { mcp, linear: undefined }), /Linear/);
  const file = join(root, `config-${++counter}.json`);
  writeFileSync(file, JSON.stringify({ ...baseHost, mcp }));
  assert.throws(() => readConfig(file), /MCP requires/);
});

test("MCP grants accept persisted mirrors without serializing runtime projects or writing files", () => {
  const fixture = join(root, "mcp-mirrors");
  mkdirSync(fixture);
  const file = join(fixture, "config.json");
  const raw = { ...baseHost, stateDir: join(fixture, "state"), runDir: join(fixture, "run"), sync: { homeDir: join(fixture, "home") }, intake: base };
  writeFileSync(file, JSON.stringify(raw));
  const { config, key } = readConfig(file);
  const mirrors = new MirroredProjects(config, key);
  const project = mirrors.resolve("Projects/sample");
  const mcp = { port: 2, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: "b".repeat(64), projectIds: [project.id] }] };
  const writeConfig = (patch = {}) => writeFileSync(file, JSON.stringify({ ...raw, mcp, ...patch }));
  writeConfig();
  const snapshot = () => readdirSync(fixture, { recursive: true }).map(String).sort().map(path => {
    const absolute = join(fixture, path), info = statSync(absolute);
    return { path, mode: info.mode, mtimeMs: info.mtimeMs, bytes: info.isFile() ? readFileSync(absolute).toString("hex") : undefined };
  });
  const before = snapshot();
  const loaded = readConfig(file).config;
  assert.deepEqual(loaded.projects, raw.projects, "CLI config edits must not persist vault-owned projects");
  assert.deepEqual(loaded.mcp, mcp);
  assert.deepEqual(snapshot(), before, "validation must not change the config, vault, or project tree");

  writeConfig({ mcp: { ...mcp, connectors: [{ ...mcp.connectors[0], projectIds: ["missing"] }] } });
  assert.throws(() => readConfig(file), /MCP grants must name configured projects/);
  writeConfig();
  mirrors.forget(project.id);
  assert.throws(() => readConfig(file), /MCP grants must name configured projects/);

  const vault = join(raw.stateDir, "mirrored-projects.sealed");
  writeSealed(vault, key, "mirrored-projects", { version: 2, entries: [{ id: project.id, path: "../escape" }] });
  assert.throws(() => readConfig(file), /Choose a project below the home directory/);
  writeFileSync(vault, "invalid sealed data");
  assert.throws(() => readConfig(file), SyntaxError);
  writeSealed(vault, Buffer.alloc(32, 2), "mirrored-projects", { version: 2, entries: [{ id: project.id, path: "Projects/sample" }] });
  assert.throws(() => readConfig(file), /authenticate/);
  writeSealed(vault, key, "mirrored-projects", { version: 2, entries: [{ id: project.id, path: "Projects/sample" }] });
  writeConfig({ deployment: { mode: "tenant-development", tenantId: TEAM }, enableDemo: true });
  assert.throws(() => readConfig(file), /MCP grants must name configured projects/, "multi-tenant hosts do not hydrate mirrors");
});
