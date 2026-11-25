import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { pinRouting, type TeamRouting } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { PROFILE_MESSAGES } from "../packages/host/src/routing-rules.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { registerRouting, taskDecisions } from "../packages/host/src/routing-store.js";
import { recordDigestSchema, type TeamAssignment, type TeamLineup, type TeamRun } from "../packages/host/src/team-types.js";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { recordDigestFor, registerDigestFor } from "../packages/host/src/objective-digest.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { sealRecord } from "../packages/host/src/objective-write.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup, mixedLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;

const PERIOD_END = "2026-11-16T00:00:00.000Z";

const contributorHop: TeamLineup = {
  ...structuredClone(limitLineup),
  implementers: [{ ...structuredClone(limitLineup.implementers[0]!), limitFallback: "contrib-light" }, structuredClone(limitLineup.implementers[1]!)],
  fallbacks: [
    { id: "contrib-light", label: "Contributor fallback", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "medium", tier: "light", dataUse: "contributor", limitFallback: "deepseek-light" },
    structuredClone(limitLineup.fallbacks![0]!),
  ],
};

const spark = { id: "spark-escalation", label: "Spark escalation", provider: "opencode" as const, model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light" as const, dataUse: "contributor" as const };

function openStore(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
}

function rowsOf(store: EvidenceStore, runId: string, taskId: string) {
  return store.read(db => taskDecisions(db, runId, taskId)).rows;
}

function allEvents(store: EvidenceStore, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events({ runId, after, limit: 500 });
    events.push(...page.events);
    if (!page.more) return events;
    after = page.cursor;
  }
}

function eventsOfKind(store: EvidenceStore, runId: string, kind: string): RunEvent[] {
  return allEvents(store, runId).filter(event => event.kind === kind);
}

type Internal = {
  record(id: string): { run: TeamRun; pending?: unknown };
  step(stored: unknown): Promise<void>;
  consume(stored: unknown, member: unknown): void;
  switchLimitedMember(stored: unknown, member: unknown, limit: unknown): Promise<void>;
};
const internal = (teams: TeamService) => teams as unknown as Internal;
const limitsOf = (teams: TeamService) => (teams as unknown as { limits: { observe(limit: object): void } }).limits;

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function pin(f: Fixture, saved: TeamRouting | undefined) {
  if (saved === undefined) return;
  f.run.routing = pinRouting(saved, "autonomous", f.run.lineup, PERIOD_END);
  assert.equal(f.run.routing?.mode, "auto", "the auto pin did not apply");
}

function openTeam(f: Fixture, store: EvidenceStore) {
  const outbox = new EventOutbox(store);
  registerRouting(store, outbox);
  const teams = f.openTeam({ events: outbox });
  teams.useRouter(new RoutingRecorder({ store }));
  return teams;
}

function implementer(f: Fixture, memberId: string, cwd: string, profile: TeamLineup["implementers"][number], provider: "claude" | "codex" | "opencode") {
  return { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, provider, modelProfile: profile,
    status: "running" as const, prompt: "Write a.txt" };
}

async function runningTask(f: Fixture, memberId: string) {
  const cwd = await prepareMemberWorkspace(f.run.workspace, memberId, f.run.baseCommit, f.config.teams?.commandPrefix);
  f.run.headCommit = f.run.baseCommit;
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
  return cwd;
}

test("an auto run's limit switch skips a contributor fallback", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(contributorHop);
    pin(f, { mode: "auto" });
    const memberId = randomUUID(), cwd = await runningTask(f, memberId);
    const member = implementer(f, memberId, cwd, f.run.lineup.implementers[0]!, "claude");
    f.run.members = [member];
    f.state.status = "exited";
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const limit = { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "claude", source: "protocol",
      message: "Usage exhausted", at: new Date().toISOString(), seq: 0 };
    await scheduler.switchLimitedMember(stored, member, limit);
    await waitFor(() => stored.pending === undefined, "the limit switch completes");
    await teams.idle();
    const [switched] = eventsOfKind(store, f.run.id, "task.limit-switched");
    assert.ok(switched, "task.limit-switched is stored");
    assert.deepEqual(switched.data, { v: 1, role: "implementer", fromProfileId: "haiku", toProfileId: "deepseek-light" });
  } finally { store.close(); f.close(); }
});

test("an auto run's limit switch skips a contributor fallback (control: no pin)", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(contributorHop);
    const memberId = randomUUID(), cwd = await runningTask(f, memberId);
    const member = implementer(f, memberId, cwd, f.run.lineup.implementers[0]!, "claude");
    f.run.members = [member];
    f.state.status = "exited";
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const limit = { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "claude", source: "protocol",
      message: "Usage exhausted", at: new Date().toISOString(), seq: 0 };
    await scheduler.switchLimitedMember(stored, member, limit);
    await waitFor(() => stored.pending === undefined, "the limit switch completes");
    await teams.idle();
    const [switched] = eventsOfKind(store, f.run.id, "task.limit-switched");
    assert.ok(switched, "task.limit-switched is stored");
    assert.equal((switched.data as { toProfileId?: string }).toProfileId, "contrib-light");
  } finally { store.close(); f.close(); }
});

function pendingTask(f: Fixture) {
  f.config.projects[0]!.team = { checks: [] };
  f.run.lineup = structuredClone(contributorHop);
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], agentProfileId: "haiku", status: "pending" }];
}

test("an auto run's launch on a limited provider skips a contributor fallback", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    pendingTask(f);
    pin(f, { mode: "auto" });
    f.writeTeam();
    const teams = openTeam(f, store);
    limitsOf(teams).observe({ provider: "claude", detectedAt: new Date().toISOString(), sessionId: randomUUID(), confidence: "corroborated" });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => scheduler.record(f.run.id).run.members.some(item => item.role === "implementer"), "the implementer is prepared", 60000);
    await teams.idle();
    const stored = scheduler.record(f.run.id).run;
    const member = stored.members.find(item => item.role === "implementer");
    assert.ok(member, "the implementer is prepared");
    assert.equal(member.modelProfile?.id, "deepseek-light");
    assert.ok(stored.events.some(event => event.text.startsWith("Claude implementer launched on DeepSeek Flash: ")), "the launch line names DeepSeek Flash");
  } finally { store.close(); f.close(); }
});

test("an auto run's launch on a limited provider skips a contributor fallback (control: no pin)", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    pendingTask(f);
    f.writeTeam();
    const teams = openTeam(f, store);
    limitsOf(teams).observe({ provider: "claude", detectedAt: new Date().toISOString(), sessionId: randomUUID(), confidence: "corroborated" });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => scheduler.record(f.run.id).run.members.some(item => item.role === "implementer"), "the implementer is prepared", 60000);
    await teams.idle();
    const member = scheduler.record(f.run.id).run.members.find(item => item.role === "implementer");
    assert.ok(member, "the implementer is prepared");
    assert.equal(member.modelProfile?.id, "contrib-light");
  } finally { store.close(); f.close(); }
});

function escalatingScene(f: Fixture, profileId: string) {
  f.run.lineup = { ...structuredClone(mixedLineup), escalations: [spark] };
  const memberId = randomUUID();
  const member = { ...implementer(f, memberId, "", mixedLineup.implementers[1]!, "codex"), status: "reported" as const,
    report: { kind: "escalate" as const, reason: "Needs the stronger model", agentProfileId: profileId } };
  f.run.members = [member];
  return member;
}

test("an auto run refuses an escalation to a contributor profile", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    const member = escalatingScene(f, spark.id);
    pin(f, { mode: "auto" });
    const memberId = randomUUID();
    member.memberId = memberId;
    member.cwd = await runningTask(f, memberId);
    f.run.members = [member];
    f.state.status = "exited";
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    assert.throws(() => scheduler.consume(stored, member), (error: unknown) =>
      error instanceof TeamError && error.status === 409 && error.code === "invalid-escalation");
    assert.equal(eventsOfKind(store, f.run.id, "task.escalated").length, 0, "no escalation is stored");
  } finally { store.close(); f.close(); }
});

test("an auto run refuses an escalation to a contributor profile (control: allowContributor)", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    const member = escalatingScene(f, spark.id);
    pin(f, { mode: "auto", allowContributor: true });
    const memberId = randomUUID();
    member.memberId = memberId;
    member.cwd = await runningTask(f, memberId);
    f.run.members = [member];
    f.state.status = "exited";
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the escalation completes");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "task.escalated");
    assert.ok(event, "task.escalated is stored");
    assert.equal((event.data as { toProfileId?: string }).toProfileId, spark.id);
  } finally { store.close(); f.close(); }
});

test("an auto run refuses a scout outside the scout pool", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    pin(f, { mode: "auto" });
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const member = stored.run.members[0]!;
    member.report = { kind: "explore", summary: "One scout", tasks: [{ id: "s1", title: "Survey", instructions: "Read the module", agentProfileId: "spark-high" }] } as typeof member.report;
    assert.throws(() => scheduler.consume(stored, member), (error: unknown) =>
      error instanceof TeamError && error.status === 409 && error.code === "invalid-agent-profile" && error.message === PROFILE_MESSAGES.scoutPool);
  } finally { store.close(); f.close(); }
});

test("an auto run accepts a scout in the scout pool (control)", { timeout: 60000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    pin(f, { mode: "auto" });
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const member = stored.run.members[0]!;
    member.report = { kind: "explore", summary: "One scout", tasks: [{ id: "s1", title: "Survey", instructions: "Read the module", agentProfileId: "astra-xhigh" }] } as typeof member.report;
    assert.doesNotThrow(() => scheduler.consume(stored, member));
    await waitFor(() => stored.pending === undefined, "the report's operation completes");
    await teams.idle();
  } finally { store.close(); f.close(); }
});

test("an auto member's configuration names the policy digest", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    f.run.status = "implementing";
    f.run.parallelism = 2;
    const memberId = randomUUID();
    f.run.members = [{ ...f.run.members[0]!, memberId, sessionId: randomUUID(), role: "implementer", title: "Implementer: a", taskId: "a",
      provider: "opencode", modelProfile: mixedLineup.implementers[0]!, status: "queued", cursor: 0, prompt: "Write a.txt" }];
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    pin(f, { mode: "auto" });
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.configured").length === 1, "member.configured is stored", 60000);
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "member.configured");
    assert.equal((event!.data as { routing?: string }).routing, f.run.routing!.digest);
  } finally { store.close(); f.close(); }
});

test("an auto member's configuration names the policy digest (control: no pin)", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    f.run.status = "implementing";
    f.run.parallelism = 2;
    const memberId = randomUUID();
    f.run.members = [{ ...f.run.members[0]!, memberId, sessionId: randomUUID(), role: "implementer", title: "Implementer: a", taskId: "a",
      provider: "opencode", modelProfile: mixedLineup.implementers[0]!, status: "queued", cursor: 0, prompt: "Write a.txt" }];
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.configured").length === 1, "member.configured is stored", 60000);
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "member.configured");
    assert.equal((event!.data as { routing?: string }).routing, "off");
  } finally { store.close(); f.close(); }
});

test("a register run's member configuration names the register prompt version", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    const goal = { id: randomUUID(), objective: "Find ranked sources.", successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["."], evidence: [], steering: [] };
    const created = goalRecord(goal as unknown as ProductGoal, new Date().toISOString(), "created");
    if (typeof created === "string") throw new Error(`the fixture record is ${created}`);
    const record = sealRecord(created, { assumptions: [{ id: "a1", statement: "Sources exist.", status: "assumed", origin: "intent-check", criticality: "plan",
      refutedBy: "No sources", test: { kind: "owner" }, evidence: [], proposals: [] }] }, []);
    f.run.goal = { id: goal.id, revision: 1, cycle: 1, successCriteria: goal.successCriteria, nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [],
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), maxMembers: 4,
      record: recordDigestSchema.parse({ ...recordDigestFor(record, []), register: registerDigestFor(record) }) };
    f.run.autonomy = "supervised";
    f.run.lineup = structuredClone(mixedLineup);
    f.run.status = "implementing";
    const memberId = randomUUID();
    f.run.members = [{ ...f.run.members[0]!, memberId, sessionId: randomUUID(), role: "implementer", title: "Implementer: a", taskId: "a",
      provider: "opencode", modelProfile: mixedLineup.implementers[0]!, status: "queued", cursor: 0, prompt: "Write a.txt" }];
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    f.writeTeam();
    const teams = openTeam(f, store);
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.configured").length === 1, "member.configured is stored", 60000);
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "member.configured");
    const publishHeads = (f.config.teams as { publishHeads?: boolean } | undefined)?.publishHeads !== false;
    const profile = mixedLineup.implementers[0]!;
    const registerVersion = promptVersion("implementer", "opencode", profile, publishHeads, false, "register");
    assert.notEqual(registerVersion, promptVersion("implementer", "opencode", profile, publishHeads, false, true), "the register shape has its own prompt version");
    assert.equal((event!.data as { promptVersion?: string }).promptVersion, registerVersion);
  } finally { store.close(); f.close(); }
});

const sonnet = { id: "sonnet-escalation", label: "Sonnet escalation", provider: "claude" as const, model: "claude-sonnet-5-5", effort: "high", tier: "strong" as const };
const opus = { id: "opus-escalation", label: "Opus escalation", provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh", tier: "strong" as const };
const ESCALATION_LINE = "Host routing could not choose an escalation profile for task a; it is assigned Sonnet escalation.";
const SCOUT_LINE = "Host routing could not choose a profile for scout s1; it is assigned Astra implementer.";

function coveredLineup(): TeamLineup {
  return { ...structuredClone(mixedLineup), escalations: [structuredClone(sonnet), structuredClone(opus)] };
}

const covered = (): TeamRouting => ({ mode: "auto", points: ["start", "escalation", "scout"] });

function openServedTeam(f: Fixture, store: EvidenceStore) {
  const outbox = new EventOutbox(store);
  store.register(configurationModule());
  outbox.registerProjector(configurationProjector());
  store.register(outcomeModule());
  registerRouting(store, outbox);
  outbox.registerProjector(outcomeProjector(store));
  const teams = f.openTeam({ events: outbox });
  teams.useRouter(new RoutingRecorder({ store }));
  return teams;
}

async function escalating(f: Fixture, agentProfileId?: string) {
  f.run.lineup = coveredLineup();
  const projectManager = f.run.members[0]!;
  const memberId = randomUUID(), cwd = await runningTask(f, memberId);
  const member = { ...implementer(f, memberId, cwd, f.run.lineup.implementers[1]!, "codex"), status: "reported" as const,
    report: { kind: "escalate" as const, reason: "Needs the stronger model", ...(agentProfileId === undefined ? {} : { agentProfileId }) } };
  f.run.members = [projectManager, member];
  f.state.status = "exited";
  return { member, cwd, projectManager };
}

function exploring(f: Fixture, agentProfileId?: string) {
  const projectManager = f.run.members[0]!;
  projectManager.report = { kind: "explore", summary: "One scout", tasks: [{ id: "s1", title: "Survey", instructions: "Read the module",
    ...(agentProfileId === undefined ? {} : { agentProfileId }) }] } as typeof projectManager.report;
  f.run.tasks = [];
  f.run.headCommit = f.run.baseCommit;
  f.config.projects[0]!.team = { checks: [] };
  f.state.status = "exited";
  return projectManager;
}

async function scoutStarted(teams: TeamService, scheduler: Internal, id: string): Promise<TeamRun> {
  await scheduler.step(scheduler.record(id));
  await waitFor(() => scheduler.record(id).pending === undefined, "the explore operation completes", 60000);
  await teams.idle();
  await scheduler.step(scheduler.record(id));
  await waitFor(() => scheduler.record(id).run.members.some(item => item.role === "scout"), "the scout is prepared", 60000);
  await teams.idle();
  return scheduler.record(id).run;
}

const replacementOf = (run: TeamRun, memberId: string) => run.members.find(item => item.role === "implementer" && item.memberId !== memberId);

test("a covered escalation without a profile starts the router's choice, decided before the scope check", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    const { member } = await escalating(f);
    pin(f, covered());
    f.writeTeam();
    const teams = openServedTeam(f, store);
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    scheduler.consume(stored, member);
    const [row] = rowsOf(store, f.run.id, "a");
    assert.equal(row?.point, "escalation");
    assert.equal(row?.state, "pending");
    assert.equal(row?.chosenProfileId, "sonnet-escalation");
    await waitFor(() => stored.pending === undefined, "the escalation completes");
    await teams.idle();
    const run = scheduler.record(f.run.id).run;
    assert.equal(run.tasks.find(task => task.id === "a")?.escalation?.toProfileId, "sonnet-escalation");
    assert.equal((eventsOfKind(store, f.run.id, "task.escalated")[0]?.data as { toProfileId?: string } | undefined)?.toProfileId, "sonnet-escalation");
    assert.equal(replacementOf(run, member.memberId)?.modelProfile?.id, "sonnet-escalation");
    assert.equal(replacementOf(run, member.memberId)?.hostProfiles, undefined, "the replacement's only candidate is its own profile");
    assert.ok(run.events.some(event => event.text.includes("escalated to Sonnet escalation; ")), "the escalation line names Sonnet escalation");
  } finally { store.close(); f.close(); }

  for (const [label, named] of [["own", "astra-xhigh"], ["outside", "spark-escalation"], ["second", undefined]] as const) {
    const g = schedulerFixture(), gstore = openStore(g);
    try {
      const { member } = await escalating(g, named);
      if (label === "own") g.run.lineup!.escalations!.push(structuredClone(member.modelProfile));
      if (label === "second") g.run.tasks[0]!.escalation = { toProfileId: "sonnet-escalation", reason: "Needs the stronger model", memberId: randomUUID(), at: new Date().toISOString() };
      pin(g, covered());
      g.writeTeam();
      const teams = openServedTeam(g, gstore);
      const scheduler = internal(teams);
      assert.throws(() => scheduler.consume(scheduler.record(g.run.id), member), (error: unknown) =>
        error instanceof TeamError && error.status === 409 && error.code === "invalid-escalation", label);
      assert.equal(rowsOf(gstore, g.run.id, "a").length, 0, `the ${label} escalation wrote a row`);
    } finally { gstore.close(); g.close(); }
  }

  const h = schedulerFixture(), hstore = openStore(h);
  try {
    const { member, cwd } = await escalating(h);
    pin(h, covered());
    h.writeTeam();
    writeFileSync(join(cwd, "outside.txt"), "not in the task's paths\n");
    const teams = openServedTeam(h, hstore);
    const scheduler = internal(teams);
    const stored = scheduler.record(h.run.id);
    scheduler.consume(stored, member);
    await waitFor(() => scheduler.record(h.run.id).halt === "block", "the scope failure halts the run");
    await teams.idle();
    const run = scheduler.record(h.run.id).run;
    assert.match(run.reason ?? "", /outside its assigned paths/);
    assert.equal(run.tasks.find(task => task.id === "a")?.escalation, undefined, "task a escalated");
    assert.equal(replacementOf(run, member.memberId), undefined, "a replacement member exists");
    assert.equal(rowsOf(hstore, h.run.id, "a")[0]?.state, "pending");
  } finally { hstore.close(); h.close(); }
});

test("a covered scout without a profile starts on the router's choice", { timeout: 180000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    f.run.lineup = coveredLineup();
    pin(f, covered());
    exploring(f);
    f.writeTeam();
    const teams = openServedTeam(f, store);
    const scheduler = internal(teams);
    const run = await scoutStarted(teams, scheduler, f.run.id);
    const accepted = eventsOfKind(store, f.run.id, "discovery.accepted")[0];
    const scouts = (accepted?.data as { scouts?: { taskId: string; profileId?: string }[] } | undefined)?.scouts ?? [];
    assert.equal(scouts.length, 1, "discovery.accepted is not stored");
    assert.equal(scouts[0]?.profileId, undefined, "discovery.accepted names a profile for a host-chosen scout");
    const scout = run.members.find(item => item.role === "scout")!;
    assert.equal(scout.modelProfile?.id, "astra-xhigh");
    assert.deepEqual(run.discovery?.tasks[0]?.routing, { profileId: "astra-xhigh", by: "router" });
    assert.ok(!scout.prompt?.includes('"routing":') && !scout.prompt?.includes("agentProfileId"), "the scout's prompt carries a routing value");
    assert.equal(rowsOf(store, f.run.id, "s1")[0]?.point, "scout");
    const factory = teams as unknown as { newMember(run: TeamRun, role: string, cwd: string, baseCommit: string): { hostProfiles?: boolean } };
    assert.equal(factory.newMember(run, "project-manager", "", run.baseCommit).hostProfiles, true, "the project manager's member does not carry hostProfiles");
    assert.ok(!run.events.some(event => event.text.includes("could not choose")), "a router pick wrote a fallback line");
  } finally { store.close(); f.close(); }
});

test("an implementer with another escalation candidate launches with hostProfiles, which lets the worker take an unnamed escalation", { timeout: 120000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    pendingTask(f);
    f.run.lineup = coveredLineup();
    f.run.tasks[0]!.agentProfileId = "astra-xhigh";
    pin(f, covered());
    f.writeTeam();
    const teams = openServedTeam(f, store);
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => scheduler.record(f.run.id).run.members.some(item => item.role === "implementer"), "the implementer is prepared", 60000);
    await teams.idle();
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    const member = scheduler.record(f.run.id).run.members.find(item => item.role === "implementer")!;
    assert.equal(member.modelProfile?.id, "astra-xhigh");
    assert.ok(f.launches.some(launch => launch.requestId === member.sessionId), "the implementer did not launch");
    const team = f.manager.meta(member.sessionId).session.team as TeamAssignment;
    assert.equal(team.hostProfiles, true, "the launched assignment lacks hostProfiles, so the worker refuses an unnamed escalation");
  } finally { store.close(); f.close(); }
});

test("a revoked run's unnamed escalation and scout take the fallback without a run line", { timeout: 300000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  try {
    const { member } = await escalating(f);
    pin(f, covered());
    f.writeTeam();
    const teams = openServedTeam(f, store);
    await teams.revokeRouting(f.run.id, { requestId: randomUUID(), revision: f.run.revision });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    assert.ok(stored.run.events.some(event => event.text.endsWith(" Escalations and scouts use the profile their member names, else the first that passes the fixed rules.")),
      "the revoke line of a run that covers escalations omits them");
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the escalation completes");
    await teams.idle();
    const run = scheduler.record(f.run.id).run;
    assert.equal(replacementOf(run, member.memberId)?.modelProfile?.id, "sonnet-escalation");
    assert.equal(rowsOf(store, f.run.id, "a").length, 0, "task a has a row after revoke");
    assert.ok(!run.events.some(event => event.text.includes("could not choose")), "a revoked escalation wrote a fallback line");
  } finally { store.close(); f.close(); }

  const g = schedulerFixture(), gstore = openStore(g);
  try {
    g.run.lineup = coveredLineup();
    pin(g, covered());
    exploring(g);
    g.writeTeam();
    const teams = openServedTeam(g, gstore);
    await teams.revokeRouting(g.run.id, { requestId: randomUUID(), revision: g.run.revision });
    const scheduler = internal(teams);
    const run = await scoutStarted(teams, scheduler, g.run.id);
    const scout = run.members.find(item => item.role === "scout")!;
    assert.equal(scout.modelProfile?.id, "astra-xhigh");
    assert.equal(run.discovery?.tasks[0]?.routing?.by, "fallback");
    assert.equal(rowsOf(gstore, g.run.id, "s1").length, 0, "scout s1 has a row after revoke");
    assert.ok(!run.events.some(event => event.text.includes("could not choose")), "a revoked scout wrote a fallback line");
  } finally { gstore.close(); g.close(); }
});

test("with the store closed an escalation and a scout start on the fallback, and the run continues", { timeout: 300000 }, async () => {
  const f = schedulerFixture(), store = openStore(f);
  const { member } = await escalating(f);
  pin(f, covered());
  f.writeTeam();
  const teams = openServedTeam(f, store);
  const scheduler = internal(teams);
  const stored = scheduler.record(f.run.id);
  store.close();
  scheduler.consume(stored, member);
  await waitFor(() => stored.pending === undefined, "the escalation completes");
  await teams.idle();
  const run = scheduler.record(f.run.id).run;
  assert.equal(run.events.filter(event => event.text === ESCALATION_LINE).length, 1, "the escalation line is not once");
  assert.equal(replacementOf(run, member.memberId)?.modelProfile?.id, "sonnet-escalation");
  assert.notEqual(run.status, "blocked", "the escalation blocked the run");
  f.close();

  const g = schedulerFixture(), gstore = openStore(g);
  g.run.lineup = coveredLineup();
  pin(g, covered());
  exploring(g);
  g.writeTeam();
  const gteams = openServedTeam(g, gstore);
  gstore.close();
  const scoutRun = await scoutStarted(gteams, internal(gteams), g.run.id);
  assert.equal(scoutRun.members.find(item => item.role === "scout")?.modelProfile?.id, "astra-xhigh");
  assert.equal(scoutRun.events.filter(event => event.text === SCOUT_LINE).length, 1, "the scout line is not once");
  assert.notEqual(scoutRun.status, "blocked", "the scout blocked the run");
  g.close();
});

test("version-1 and shadow pins keep step 2's escalation and scout paths", { timeout: 400000 }, async () => {
  const v1 = schedulerFixture(), v1store = openStore(v1);
  try {
    const { member } = await escalating(v1, "sonnet-escalation");
    pin(v1, covered());
    v1.run.routing = { ...v1.run.routing!, algorithmVersion: 1 };
    v1.writeTeam();
    const teams = openServedTeam(v1, v1store);
    const scheduler = internal(teams);
    const stored = scheduler.record(v1.run.id);
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the named escalation completes");
    await teams.idle();
    const run = scheduler.record(v1.run.id).run;
    assert.equal(replacementOf(run, member.memberId)?.modelProfile?.id, "sonnet-escalation");
    assert.equal(run.members.some(item => item.hostProfiles === true), false, "a version-1 run marks a member hostProfiles");
    assert.equal(rowsOf(v1store, v1.run.id, "a").length, 0, "a version-1 run wrote an escalation row");
  } finally { v1store.close(); v1.close(); }

  const unnamed = schedulerFixture(), unnamedStore = openStore(unnamed);
  try {
    const { member } = await escalating(unnamed);
    pin(unnamed, covered());
    unnamed.run.routing = { ...unnamed.run.routing!, algorithmVersion: 1 };
    unnamed.writeTeam();
    const scheduler = internal(openServedTeam(unnamed, unnamedStore));
    assert.throws(() => scheduler.consume(scheduler.record(unnamed.run.id), member), (error: unknown) =>
      error instanceof TeamError && error.status === 409 && error.code === "invalid-escalation");
  } finally { unnamedStore.close(); unnamed.close(); }

  const scouts = schedulerFixture(), scoutsStore = openStore(scouts);
  try {
    scouts.run.lineup = coveredLineup();
    pin(scouts, covered());
    scouts.run.routing = { ...scouts.run.routing!, algorithmVersion: 1 };
    const projectManager = exploring(scouts);
    scouts.writeTeam();
    const scheduler = internal(openServedTeam(scouts, scoutsStore));
    const stored = scheduler.record(scouts.run.id);
    assert.throws(() => scheduler.consume(stored, stored.run.members.find(item => item.memberId === projectManager.memberId)!), (error: unknown) =>
      error instanceof TeamError && error.status === 409 && error.code === "invalid-agent-profile" && error.message === PROFILE_MESSAGES.scoutPool);
  } finally { scoutsStore.close(); scouts.close(); }

  const shadow = schedulerFixture(), shadowStore = openStore(shadow);
  try {
    const { member } = await escalating(shadow, "sonnet-escalation");
    shadow.run.routing = pinRouting({ mode: "shadow", points: ["start", "escalation", "scout"] }, "autonomous", shadow.run.lineup, PERIOD_END);
    assert.equal(shadow.run.routing?.mode, "shadow", "the shadow pin did not apply");
    shadow.writeTeam();
    const teams = openServedTeam(shadow, shadowStore);
    const scheduler = internal(teams);
    const stored = scheduler.record(shadow.run.id);
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the named escalation completes");
    await teams.idle();
    const run = scheduler.record(shadow.run.id).run;
    assert.equal(replacementOf(run, member.memberId)?.modelProfile?.id, "sonnet-escalation");
    const [escalationRow] = rowsOf(shadowStore, shadow.run.id, "a");
    assert.equal(escalationRow?.point, "escalation");
    assert.equal(escalationRow?.state, "recorded");
  } finally { shadowStore.close(); shadow.close(); }

  const shadowScout = schedulerFixture(), shadowScoutStore = openStore(shadowScout);
  try {
    shadowScout.run.lineup = coveredLineup();
    shadowScout.run.routing = pinRouting({ mode: "shadow", points: ["start", "escalation", "scout"] }, "autonomous", shadowScout.run.lineup, PERIOD_END);
    exploring(shadowScout, "astra-xhigh");
    shadowScout.writeTeam();
    const teams = openServedTeam(shadowScout, shadowScoutStore);
    const scheduler = internal(teams);
    const run = await scoutStarted(teams, scheduler, shadowScout.run.id);
    const scoutRow = rowsOf(shadowScoutStore, shadowScout.run.id, "s1")[0];
    assert.equal(scoutRow?.point, "scout");
    assert.equal(scoutRow?.state, "recorded");
    assert.equal(run.members.find(item => item.role === "scout")?.modelProfile?.id, "astra-xhigh");
  } finally { shadowScoutStore.close(); shadowScout.close(); }
});
