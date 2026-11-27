import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectGroup } from "../packages/host/src/project-group-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { IntakeRecord } from "../packages/host/src/intake-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import { createIntakeAudienceGuard, createIntakeMissionCreator, intakeRecordAudienceAllowed, slackAudienceIdentity } from "../packages/host/src/intake-audience.js";
import { IntakeService } from "../packages/host/src/intake.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import type { MissionService } from "../packages/host/src/missions.js";
import { SlackClient, SlackError } from "../packages/host/src/slack-client.js";
import { startSlackServer } from "./fixtures/slack-server.js";

const ROOT_COMMIT = "a".repeat(40);
const HEAD_COMMIT = "b".repeat(40);

const project = (repository: string | null = "Example/alpha") => ({
  id: "alpha", name: "Alpha", path: "/srv/work/alpha",
  ...(repository ? { source: { mode: "github" as const, repository, baseBranch: "main" } } : {}),
  team: { ...(repository ? { delivery: { mode: "pr" as const, repository, baseBranch: "main" } } : {}), checks: [] },
});

function setup(options: { pins?: { projectId: string; path: string; repository: string | null; rootCommit?: string }[]; repository?: string | null; hidden?: boolean; answerProjectId?: string; noRemote?: boolean; observedRemote?: string; multipleRoots?: boolean } = {}) {
  const repository = options.repository === undefined ? "Example/alpha" : options.repository;
  const gitCalls: string[] = [];
  const configuredProject = project(repository);
  const config = {
    intake: {
      mission: { groupId: "work", ...(options.answerProjectId ? { answerProjectId: options.answerProjectId } : {}) },
      slack: { teamId: "T00000000", ownerUserId: "U00000000",
        organizationScope: { workspaces: options.pins ?? [{ projectId: "alpha", path: "/srv/work/alpha", repository: "Example/alpha" }] } },
    },
    projects: [configuredProject],
  } as unknown as Config;
  const group: ProjectGroup = {
    id: "work", name: "Work", kind: "owner", hidden: options.hidden ?? false, implicit: false, revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    repos: [{ projectId: "alpha", name: "Alpha", path: "/srv/work/alpha", key: repository ? `remote:github.com/${repository.toLowerCase()}` : `root:${ROOT_COMMIT}`,
      checkouts: [{ projectId: "alpha", name: "Alpha", path: "/srv/work/alpha", primary: true, teamReady: true, identityFrom: "source" }] }],
  };
  const git = (_cwd: string, args: string[]) => {
    gitCalls.push(args.join(" "));
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/srv/work/alpha";
    if (args[0] === "rev-parse" && args[1] === "--verify") return repository ? HEAD_COMMIT : ROOT_COMMIT;
    if (args[0] === "remote" && args[1] === "-v") {
      const remote = options.observedRemote ?? (repository && !options.noRemote ? `git@github.com:${repository}.git` : undefined);
      return remote ? `origin ${remote} (fetch)\norigin ${remote} (push)` : "";
    }
    if (args[0] === "rev-list") return options.multipleRoots ? `${ROOT_COMMIT}\n${"c".repeat(40)}` : ROOT_COMMIT;
    return undefined;
  };
  const guard = createIntakeAudienceGuard({ config, groups: { get: () => group }, git, realpath: path => path,
    sourceAppliedHead: () => HEAD_COMMIT });
  return { guard, config, group, gitCalls };
}

test("opt-in Slack audience admits only the fully pinned default group and same-org checkouts", () => {
  const { guard } = setup();
  assert.equal(guard.workspacesAllowed(), true);
  assert.equal(guard.missionAllowed({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "work", objective: "Review alpha" }), true);
  assert.equal(guard.missionAllowed({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "foreign", objective: "Review alpha" }), false);
  assert.equal(guard.missionAllowed({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "work", checkouts: ["foreign"], objective: "Review alpha" }), false);
});

test("a configured Slack surface with no workspace scope fails closed", () => {
  const current = setup();
  const config = { ...current.config, intake: { ...current.config.intake!, slack: { ...current.config.intake!.slack!, organizationScope: undefined } } } as unknown as Config;
  const guard = createIntakeAudienceGuard({ config, groups: { get: () => current.group }, git: () => undefined, realpath: path => path });
  const request = { requestId: "11111111-1111-4111-8111-111111111111", groupId: "work", objective: "Review alpha" };

  assert.deepEqual([guard.workspacesAllowed(), guard.missionAllowed(request)], [false, false]);
});

test("a sealed intake record is usable only for its exact Slack audience and mission identity", () => {
  const current = setup();
  const audienceId = slackAudienceIdentity(current.config)!;
  const record = {
    issueId: "11111111-1111-4111-8111-111111111111", identifier: "TEST-1", url: "https://example.invalid/issue",
    title: "Review alpha", description: "Review alpha", issueCreatedAt: "2026-01-01T00:00:00.000Z",
    issueUpdatedAt: "2026-01-01T00:00:00.000Z", state: "started", rule: "owner request", missionId: "mission-1",
    slackAudienceId: audienceId, comments: {}, messages: [], questions: [], inbound: [], createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as IntakeRecord;
  const mission = { id: "mission-1", groupId: "work", repoProjectIds: ["alpha"] } as Mission;
  assert.equal(current.guard.recordAllowed(record, mission), true);
  assert.equal(current.guard.recordAllowed(record, { ...mission, groupId: "foreign" }), false,
    "A valid digest cannot authorize a mission that belongs to another group");

  current.config.intake!.mission.groupId = "another-group";
  assert.equal(current.guard.recordAllowed(record, mission), false,
    "Reconfiguring the approved group invalidates the sealed record without changing its audit copy");
  assert.equal(record.slackAudienceId, audienceId);
});

test("intake list snapshots live workspace verification once per call and disposes it afterward", () => {
  const current = setup();
  const root = mkdtempSync(join(tmpdir(), "intake-audience-list-"));
  current.config.stateDir = root;
  const store = new IntakeStore(current.config, randomBytes(32));
  const now = new Date().toISOString(), audienceId = slackAudienceIdentity(current.config)!;
  for (let index = 0; index < 12; index++) store.create({ issueId: randomUUID(), identifier: `TEST-${index}`, url: "https://example.invalid/issue",
    title: "Review alpha", description: "Review alpha", issueCreatedAt: now, issueUpdatedAt: now, state: "queued", slackAudienceId: audienceId,
    comments: {}, messages: [], questions: [], inbound: [], createdAt: now, updatedAt: now });
  const service = new IntakeService(current.config, store, { peek: () => undefined } as unknown as MissionService, {} as any,
    { audience: current.guard });
  try {
    assert.equal(current.guard.workspacesAllowed(), true);
    const readsPerScan = current.gitCalls.length;
    assert.ok(readsPerScan > 0);
    current.gitCalls.length = 0;
    assert.equal(service.list().length, 12);
    assert.equal(current.gitCalls.length, readsPerScan, "A list scans each pinned checkout once, regardless of record count");
    current.gitCalls.length = 0;
    assert.equal(service.list().length, 12);
    assert.equal(current.gitCalls.length, readsPerScan, "The next list call rechecks live Git identity instead of reusing a stale result");
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an intake replay is checked against the current workspace before looking up a prior mission", async () => {
  const { guard, config, group } = setup();
  let replayChecks = 0;
  const missions = {
    replayCreate: () => { replayChecks += 1; return { id: "old-mission" }; },
    create: () => { throw new Error("a replay must not create a mission"); },
  } as any;
  const creator = createIntakeMissionCreator({ config, missions, groups: { get: () => group }, audience: guard, assertNoHandoff: () => {} });
  await assert.rejects(creator({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "foreign", objective: "Review alpha" },
    { kind: "intake", issueId: "22222222-2222-4222-8222-222222222222", identifier: "TEST-1", url: "https://example.invalid/issue", rule: "owner request" }),
  (error: unknown) => error instanceof Error && error.message.includes("outside the configured Slack workspace"));
  assert.equal(replayChecks, 0, "An out-of-audience replay never reaches mission lookup");
});

test("removing Slack keeps old Slack-linked records inert while no-Slack intake records remain usable", () => {
  const current = setup();
  const record = {
    issueId: "11111111-1111-4111-8111-111111111111", identifier: "TEST-1", url: "https://example.invalid/issue",
    title: "Review alpha", description: "Review alpha", issueCreatedAt: "2026-01-01T00:00:00.000Z",
    issueUpdatedAt: "2026-01-01T00:00:00.000Z", state: "started", rule: "owner request", missionId: "mission-1",
    slackAudienceId: slackAudienceIdentity(current.config), thread: { channelId: "C0000000000", threadTs: "1.000001" },
    comments: {}, messages: [], questions: [], inbound: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as IntakeRecord;
  const linearOnly = { ...record, slackAudienceId: undefined, thread: undefined, direct: undefined } as IntakeRecord;
  const noSlack = { intake: { mission: { groupId: "work" } } } as unknown as Config;

  assert.equal(intakeRecordAudienceAllowed(noSlack, record), false, "Removing Slack never reclassifies its sealed records as Linear-only");
  assert.equal(intakeRecordAudienceAllowed(noSlack, linearOnly), true, "A record admitted without Slack remains usable independently");
});

test("a scoped connector mission is not constrained by the Slack intake group", async () => {
  const { guard, config, group } = setup();
  let created = false;
  const missions = {
    replayCreate: () => undefined,
    create: (request: { groupId: string }, _original: unknown, _origin: unknown, authorize?: () => void) => {
      authorize?.();
      created = request.groupId === "connector-group";
      return Promise.resolve({ id: "connector-mission" });
    },
  } as any;
  const connectorGroup = { ...group, id: "connector-group" };
  const creator = createIntakeMissionCreator({ config, missions, groups: { get: id => id === "connector-group" ? connectorGroup : group },
    audience: guard, assertNoHandoff: () => {} });
  await creator({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "connector-group", objective: "Review alpha" },
    { kind: "intake", issueId: "22222222-2222-4222-8222-222222222222", identifier: "TEST-1", url: "https://example.invalid/issue", rule: "connector grant",
      source: { connectorId: "connector", requestId: "request" } as any });
  assert.equal(created, true, "The connector's own scoped grant chooses its group independently of Slack intake");
});

test("audience is denied after repository identity or canonical checkout changes", () => {
  const changedRepo = setup();
  (changedRepo.config.projects[0] as any).source.repository = "Example/beta";
  assert.equal(changedRepo.guard.missionAllowed({ requestId: "11111111-1111-4111-8111-111111111111", groupId: "work", objective: "Review alpha" }), false);

  const changedCheckout = setup();
  const guard = createIntakeAudienceGuard({ config: changedCheckout.config, groups: { get: () => changedCheckout.group }, realpath: () => "/srv/work/replaced" });
  assert.equal(guard.workspacesAllowed(), false);
});

test("a live foreign Git remote defeats a still-cached same-repository catalog key", () => {
  assert.equal(setup({ observedRemote: "git@github.com:Foreign/alpha.git" }).guard.workspacesAllowed(), false);
  assert.equal(setup({ multipleRoots: true, repository: null,
    pins: [{ projectId: "alpha", path: "/srv/work/alpha", repository: null, rootCommit: ROOT_COMMIT }] }).guard.workspacesAllowed(), false);
});

test("empty, hidden, incomplete, and unbound local workspace audiences fail closed", () => {
  assert.equal(setup({ pins: [] }).guard.workspacesAllowed(), false);
  assert.equal(setup({ hidden: true }).guard.workspacesAllowed(), false);
  assert.equal(setup({ answerProjectId: "foreign" }).guard.workspacesAllowed(), false);
  assert.equal(setup({ repository: null, pins: [{ projectId: "alpha", path: "/srv/work/alpha", repository: null, rootCommit: ROOT_COMMIT }] }).guard.workspacesAllowed(), true);
  assert.equal(setup({ repository: null, pins: [{ projectId: "alpha", path: "/srv/work/alpha", repository: null }] }).guard.workspacesAllowed(), false);
});

test("remote-free GitHub checkouts must match the source service applied head", () => {
  const current = setup({ noRemote: true });
  const config = current.config;
  const group = current.group;
  assert.equal(current.guard.workspacesAllowed(), true);
  const changedHead = createIntakeAudienceGuard({ config, groups: { get: () => group }, realpath: path => path,
    git: (_cwd, args) => args[0] === "rev-parse" && args[1] === "--show-toplevel" ? "/srv/work/alpha"
      : args[0] === "rev-parse" && args[1] === "--verify" ? "c".repeat(40)
        : args[0] === "remote" && args[1] === "-v" ? "" : undefined,
    sourceAppliedHead: () => HEAD_COMMIT });
  assert.equal(changedHead.workspacesAllowed(), false);
});

test("a repository drift denies the composed Slack send before any actor reply is posted", async t => {
  const { guard, config } = setup();
  const slack = await startSlackServer();
  t.after(() => slack.close());
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
    timeoutMs: 2000, teamId: slack.teamId, organizationScope: config.intake!.slack!.organizationScope, workspaceAllowed: guard.workspacesAllowed });
  const thread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
  await client.post(thread, "same-org reply", "audience:valid");
  assert.equal(slack.posts(thread).length, 1);
  (config.projects[0] as any).source.repository = "Example/beta";
  await assert.rejects(client.post(thread, "foreign reply", "audience:denied"),
    (error: SlackError) => error.code === "organization_scope_denied");
  assert.equal(slack.posts(thread).length, 1);
});

test("the serialized mission authorization admits the pinned repository and denies a later drift", async () => {
  const { guard, config, group } = setup();
  const creates: string[] = [];
  const missions = {
    replayCreate: () => undefined,
    create: (_request: unknown, _original: unknown, _origin: unknown, authorize?: () => void) => {
      authorize?.();
      creates.push("created");
      return Promise.resolve({ id: "mission" });
    },
  } as any;
  const creator = createIntakeMissionCreator({ config, missions, groups: { get: () => group }, audience: guard, assertNoHandoff: () => {} });
  const request = { requestId: "11111111-1111-4111-8111-111111111111", groupId: "work", objective: "Review alpha" };
  const origin = { kind: "intake" as const, issueId: "issue", identifier: "ISS-1", url: "https://linear.example.invalid/ISS-1", rule: "owner request" };
  assert.deepEqual(await creator(request, origin), { id: "mission" });
  (config.projects[0] as any).source.repository = "Example/beta";
  await assert.rejects(creator({ ...request, requestId: "22222222-2222-4222-8222-222222222222" }, origin),
    (error: { code?: string }) => error.code === "intake-audience-denied");
  assert.deepEqual(creates, ["created"]);
});
