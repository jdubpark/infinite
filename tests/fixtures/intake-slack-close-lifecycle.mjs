import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeSlackSurface } from "../../packages/host/src/intake-slack.ts";
import { IntakeStore } from "../../packages/host/src/intake-store.ts";
import { slackAudienceFixture, testIntakeAudience } from "./slack-server.ts";

let releaseScope;
let markScopeStarted;
const scopeStarted = new Promise(resolve => { markScopeStarted = resolve; });
const scopeResult = new Promise(resolve => { releaseScope = resolve; });
const root = mkdtempSync(join(tmpdir(), "intake-close-"));
const thread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
const issueId = randomUUID();
const groupId = "fixture", teamId = "T00000000", ownerUserId = "U00000000";
const enrollment = slackAudienceFixture(groupId, teamId, ownerUserId);
const config = { stateDir: root, projects: enrollment.projects, intake: {
  mission: { groupId }, slack: { teamId, ownerUserId, organizationScope: enrollment.scope },
} };
const store = new IntakeStore(config, randomBytes(32));
const timestamp = new Date().toISOString();
store.create({
  issueId, identifier: "TEST-1", url: "https://linear.example.invalid/issue/TEST-1", title: "Export fails",
  description: "The export fails.", issueCreatedAt: timestamp, issueUpdatedAt: timestamp,
  comments: {}, messages: [{ key: "ack", kind: "ack", text: "Received.", createdAt: timestamp, status: "pending", attempts: 0 }],
  questions: [], inbound: [], createdAt: timestamp, updatedAt: timestamp,
  state: "queued", thread, slackAudienceId: enrollment.identity,
});
const missions = { onChange: () => () => {} };
const client = {
  authTest: async () => ({ teamId, userId: "U00000001" }),
  connect: () => ({ close() {}, connected: () => true }),
  organizationChannelAllowed: () => { markScopeStarted(); return scopeResult; },
};
const surface = new IntakeSlackSurface(config, store, missions, {}, client, { audience: testIntakeAudience(config) });
let closed = false;

try {
  await surface.start();
  await scopeStarted;
  surface.close();
  closed = true;
  releaseScope(false);
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write("SCOPE_RELEASED\n");
} finally {
  if (!closed) surface.close();
  rmSync(root, { recursive: true, force: true });
}
