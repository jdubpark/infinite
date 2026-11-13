import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, validateIntakeConfig } from "../packages/host/src/config.js";
import { deterministicUuid, intakeConfigSchema, missionRequestId } from "../packages/host/src/intake-types.js";

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
