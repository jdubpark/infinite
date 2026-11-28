import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { evaluateAutonomousQuestion } from "../packages/host/src/autonomous-questions.js";
import { buildDailyDigest } from "../packages/host/src/daily-digest.js";
import { Notifier } from "../packages/host/src/notifier.js";
import { PushStore } from "../packages/host/src/push.js";
import { TeamConsumer, type ConsumerHost } from "../packages/host/src/team-consumer.js";
import { decisionAnswerLabel, type TeamMember, type TeamRun, type TeamView } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import { smallRun } from "./fixtures/team-prompt-run.js";

function consumerHarness() {
  const events: string[] = [];
  const prepared: { role: string; feedback?: string }[] = [];
  let saved = 0;
  const host = {
    records: new Map(),
    config: { projects: [] } as unknown as ConsumerHost["config"],
    closed: false,
    save: () => { saved++; },
    event: (_stored: unknown, text: string) => { events.push(text); },
    enqueue: async () => undefined,
    operation: () => undefined,
    assertRunPath: () => undefined,
    assertBudget: () => undefined,
    block: () => undefined,
    options: undefined,
    diag: { warnUnexpected: () => undefined, warnEnrichSkip: () => undefined },
    router: undefined,
    replays: { consume: () => false },
    intentChecks: { consume: () => undefined, hold: () => false },
    verdicts: { consume: () => undefined, holdNoChange: () => false },
    startInProject: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    consumePermissionCoordinator: () => undefined,
    prefixFor: () => undefined,
    applyProjectManagerCapacity: () => undefined,
    emit: () => undefined,
    emitWith: () => undefined,
    routerInput: () => ({} as ReturnType<ConsumerHost["routerInput"]>),
    newMember: () => ({} as TeamMember),
    linkReplacement: () => undefined,
    prepareMember: (_stored: unknown, role: TeamMember["role"], _task?: unknown, feedback?: string) => {
      prepared.push({ role, feedback });
    },
    assertDelivery: () => undefined,
    queueDeliveryRetryAfterEvidence: () => undefined,
    memberProfile: () => undefined,
    captureApproved: () => undefined,
    captureIntegrated: () => undefined,
    retentionState: () => ({ status: "planning", statusAt: "", integratedAt: {}, removalErrors: {} }),
    retentionNow: () => "",
    flushOutbox: () => false,
    replaceCheck: async () => undefined,
    noteLeftover: async () => undefined,
  } as unknown as ConsumerHost;
  return { consumer: new TeamConsumer(host), events, prepared, savedCount: () => saved };
}

function pmMember(run: TeamRun, report: TeamMember["report"]): TeamMember {
  return {
    runId: run.id,
    memberId: randomUUID(),
    revision: run.revision,
    role: "project-manager",
    sessionId: randomUUID(),
    title: "project-manager: test",
    status: "reported",
    cwd: run.workspace,
    baseCommit: run.baseCommit,
    prompt: "plan",
    cursor: 0,
    stopRequestId: randomUUID(),
    report,
  };
}

test("evaluateAutonomousQuestion enforces autonomous continuation and interrupt rules", () => {
  const recommendation = { answers: ["Use JSON"], reason: "Matches existing endpoints" };
  assert.deepEqual(
    evaluateAutonomousQuestion({ autonomy: "autonomous", answerMode: "single", recommendation }),
    { action: "continue", answer: "Use JSON", reason: "Matches existing endpoints" },
  );
  assert.deepEqual(
    evaluateAutonomousQuestion({ autonomy: "supervised", answerMode: "single", recommendation }),
    { action: "wait" },
  );
  assert.deepEqual(
    evaluateAutonomousQuestion({ autonomy: "autonomous", answerMode: "approval", recommendation }),
    { action: "wait" },
  );
  for (const interrupt of ["definition", "authority", "irreversible"] as const) {
    assert.deepEqual(
      evaluateAutonomousQuestion({ autonomy: "autonomous", answerMode: "single", interrupt, recommendation }),
      { action: "wait" },
    );
  }
  assert.deepEqual(
    evaluateAutonomousQuestion({ autonomy: "autonomous", answerMode: "single", recommendation, hasChildDecision: true }),
    { action: "wait" },
  );
  assert.deepEqual(
    evaluateAutonomousQuestion({ autonomy: "autonomous", answerMode: "single" }),
    { action: "wait" },
  );
});

test("TeamConsumer continues autonomous PM questions on proposed default and waits on interrupts or supervised", () => {
  const autoRun = smallRun({ autonomy: "autonomous", status: "planning" });
  const autoStored = { run: autoRun } as Parameters<TeamConsumer["consume"]>[0];
  const autoMember = pmMember(autoRun, {
    kind: "question",
    question: "Which serialization format should the endpoint use?",
    options: ["JSON", "YAML"],
    answerMode: "single",
    recommendation: { answers: ["JSON"], reason: "All sibling endpoints return JSON" },
  });
  const h1 = consumerHarness();
  h1.consumer.consume(autoStored, autoMember);
  assert.equal(autoRun.status, "planning");
  assert.equal(autoRun.decisions.length, 1);
  assert.equal(autoRun.decisions[0]!.answeredBy, "coordinator");
  assert.equal(autoRun.decisions[0]!.defaultContinued, true);
  assert.equal(decisionAnswerLabel(autoRun.decisions[0]!), "Autonomous default");
  assert.equal(autoRun.decisions[0]!.answer, "JSON");
  assert.equal(autoRun.decisions[0]!.recommendation?.outcome, "matched");
  assert.equal(h1.prepared.length, 1);
  assert.equal(h1.prepared[0]!.role, "project-manager");
  assert.match(h1.prepared[0]!.feedback ?? "", /JSON/);
  assert.match(h1.prepared[0]!.feedback ?? "", /All sibling endpoints return JSON/);
  assert.ok(h1.events.some(event => /Autonomous mode: recorded proposed default answer/.test(event)));

  const intRun = smallRun({ autonomy: "autonomous", status: "planning" });
  const intStored = { run: intRun } as Parameters<TeamConsumer["consume"]>[0];
  const intMember = pmMember(intRun, {
    kind: "question",
    question: "Should deprecated endpoints remain supported?",
    options: ["Keep", "Remove"],
    answerMode: "single",
    interrupt: "definition",
    recommendation: { answers: ["Keep"], reason: "Avoid breaking callers" },
  });
  const h2 = consumerHarness();
  h2.consumer.consume(intStored, intMember);
  assert.equal(intRun.status, "needs-input");
  assert.equal(intMember.status, "waiting");
  assert.equal(intRun.decisions[0]!.answer, undefined);
  assert.equal(intRun.decisions[0]!.interrupt, "definition");
  assert.equal(h2.prepared.length, 0);

  const supRun = smallRun({ autonomy: "supervised", status: "planning" });
  const supStored = { run: supRun } as Parameters<TeamConsumer["consume"]>[0];
  const supMember = pmMember(supRun, {
    kind: "question",
    question: "Which serialization format?",
    options: ["JSON", "YAML"],
    answerMode: "single",
    recommendation: { answers: ["JSON"], reason: "Matches siblings" },
  });
  const h3 = consumerHarness();
  h3.consumer.consume(supStored, supMember);
  assert.equal(supRun.status, "needs-input");
  assert.equal(supMember.status, "waiting");
  assert.equal(supRun.decisions[0]!.answer, undefined);
  assert.equal(h3.prepared.length, 0);

  const delRun = smallRun({ autonomy: "autonomous", status: "delivering" });
  const delStored = { run: delRun } as Parameters<TeamConsumer["consume"]>[0];
  const delMember: TeamMember = {
    ...pmMember(delRun, {
      kind: "question",
      question: "Target release branch?",
      options: ["main", "release"],
      answerMode: "single",
      recommendation: { answers: ["main"], reason: "Default branch" },
    }),
    role: "delivery",
    title: "delivery: test",
  };
  const h4 = consumerHarness();
  h4.consumer.consume(delStored, delMember);
  assert.equal(delRun.status, "needs-input");
  assert.equal(delMember.status, "waiting");
  assert.equal(delRun.decisions[0]!.answer, undefined);
  assert.equal(h4.prepared.length, 0);
});

test("Notifier quietAutonomous suppresses routine autonomous lifecycle pushes while keeping interrupts and supervised runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-c18-push-"));
  try {
    const store = new PushStore(dir, randomBytes(32));
    store.add("owner", "ExponentPushToken[a]", "ios");
    const sent: { title: string; body: string }[][] = [];
    const sender = async (messages: { title: string; body: string }[]) => {
      sent.push(messages);
      return messages.map(() => ({ status: "ok" as const, id: "ok" }));
    };
    const teams: { id: string; title: string; status: string; autonomy?: "autonomous" | "supervised" }[] = [
      { id: "t-base", title: "Existing", status: "planning", autonomy: "autonomous" },
    ];
    const goals: { id: string; title: string; status: string; autonomy?: "autonomous" | "supervised" }[] = [
      { id: "g-base", title: "Existing Goal", status: "running", autonomy: "autonomous" },
    ];
    const events = ["team-started", "team-finished", "team-stuck", "team-cancelled", "goal-started", "goal-finished", "goal-stuck", "goal-cancelled"];
    const notifier = new Notifier(
      { list: async () => [] } as never,
      store,
      sender,
      { detail: "minimal", events, intervalMs: 100000, quietAutonomous: true },
      { statuses: () => teams },
      { statuses: () => goals },
    );
    await notifier.tick();

    teams.push({ id: "t-auto", title: "Auto Team", status: "planning", autonomy: "autonomous" });
    goals.push({ id: "g-auto", title: "Auto Goal", status: "running", autonomy: "autonomous" });
    await notifier.tick();
    assert.equal(sent.length, 0);

    teams[1]!.status = "ready-for-review";
    goals[1]!.status = "ready-for-review";
    await notifier.tick();
    assert.equal(sent.length, 0);

    teams[0]!.status = "blocked";
    goals[0]!.status = "blocked";
    await notifier.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.map(m => m.title), ["Team needs you", "Goal needs you"]);

    teams.push({ id: "t-sup", title: "Supervised Team", status: "planning", autonomy: "supervised" });
    await notifier.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]![0]!.title, "Team started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDailyDigest labels all four DigestItemKind classes, enforces windowHours, and omits raw scores or usage", () => {
  const nowMs = Date.parse("2026-11-28T12:00:00.000Z");
  const within = (hoursAgo: number) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();

  const team = {
    ...smallRun({
      id: "team-1",
      projectId: "proj-a",
      title: "Harden auth",
      status: "ready-for-review",
      updatedAt: within(1),
      headCommit: "abcdef1234567890abcdef1234567890abcdef12",
      steering: [{ text: "Keep existing token header", revision: 1, at: within(2) }],
      decisions: [
        { id: "d-default", memberId: "m-1", revision: 1, question: "Default timeout?", options: ["5s", "10s"], createdAt: within(3), answer: "5s", answeredAt: within(3), answeredBy: "coordinator", defaultContinued: true },
        { id: "d-old", memberId: "m-2", revision: 1, question: "Old question outside window", options: [], createdAt: within(48), answer: "Legacy", answeredAt: within(48), answeredBy: "owner" },
      ],
      pullRequest: { revision: 1, headCommit: "abcdef1234567890abcdef1234567890abcdef12", pullRequestUrl: "https://github.com/example/repo/pull/42", summary: "Opened PR for auth hardening", reportedAt: within(1.5) },
    }),
    lastActivityAt: within(1), members: [],
    usage: { total: { input: 99999, output: 8888, costUsd: 12.34, messages: 5 } },
    providerLimits: [], workers: { limit: 1, max: 4, running: 0, ready: 0 }, resumable: false, continuable: false,
  } as unknown as TeamView;

  const goal = {
    id: "goal-1", projectId: "proj-a", title: "Reliability objective", status: "ready-for-review", createdAt: within(10), updatedAt: within(2),
    cycles: [{
      teamId: "team-1", cycle: 1, goalRevision: 1, status: "ready-for-review", startedAt: within(6), finishedAt: within(4), memberCount: 2,
      assessment: { verdictId: randomUUID(), revision: 1, head: "a".repeat(40), kind: "reviewed", result: "met", counts: { met: 2, notMet: 0, inconclusive: 0, pendingOwner: 0 }, criteria: [], at: within(4), progress: 97 },
    }],
    steering: [], events: [],
    outcomes: [{ result: "achieved", summary: "Owner confirmed production fix", evidence: "Logs clean", at: within(0.5), revision: 1 }],
  } as unknown as ProductGoal;

  const mission = {
    id: "mission-1", groupId: "grp-1", groupName: "Platform", repoProjectIds: ["proj-a"], title: "Cross-repo check",
    decisions: [{ id: "md-1", question: "Enable strict mode?", options: ["Yes", "No"], createdAt: within(5), answer: "Yes", answeredAt: within(5), answeredBy: "owner" }],
    steering: [],
  } as unknown as Mission;

  const digest = buildDailyDigest({
    now: nowMs,
    windowHours: 24,
    teams: [team],
    goals: [goal],
    missions: [mission],
    fuse: {
      authoritative: true,
      host: { state: "open", trip: { tripId: "trip-1", cause: "launch-rate", window: "hour", openedAt: within(0.2), ownerClose: false }, hour: { launches: 10, limit: 10 } },
      projects: [],
    },
  });

  assert.equal(digest.windowHours, 24);
  assert.equal(digest.counts["host-receipt"], 2);
  assert.equal(digest.counts["agent-claim"], 2);
  assert.equal(digest.counts["evaluator-assessment"], 1);
  assert.equal(digest.counts["owner-decision"], 3);
  assert.equal(digest.items.length, 8);
  assert.ok(!JSON.stringify(digest).includes("Old question outside window"));
  assert.ok(!JSON.stringify(digest).includes("99999"));
  assert.ok(!JSON.stringify(digest).includes("12.34"));
  assert.ok(!JSON.stringify(digest).includes("progress"));

  const narrow = buildDailyDigest({ now: nowMs, windowHours: 1, teams: [team], goals: [goal], missions: [mission] });
  assert.equal(narrow.windowHours, 1);
  assert.equal(narrow.items.length, 2);
  assert.equal(buildDailyDigest({ now: nowMs, windowHours: 500, teams: [], goals: [], missions: [] }).windowHours, 168);
});
