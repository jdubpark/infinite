import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { pinRouting, type TeamRouting } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { PROFILE_MESSAGES } from "../packages/host/src/routing-rules.js";
import { registerRouting } from "../packages/host/src/routing-store.js";
import { type TeamLineup, type TeamRun } from "../packages/host/src/team-types.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup, mixedLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;

/** The period end the pin reads. Any value before the test's clock works: the pin only needs the end to exist. */
const PERIOD_END = "2026-11-16T00:00:00.000Z";

/** A limit-fallback lineup whose first hop is a contributor profile, so rule 1 must skip it. */
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

/** Every stored event of one run, read page by page. */
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

/** The run's routing: an `auto` pin with the autonomous policy, or none. Asserts the pin, so a silent failure cannot pass. */
function pin(f: Fixture, saved: TeamRouting | undefined) {
  if (saved === undefined) return;
  f.run.routing = pinRouting(saved, "autonomous", f.run.lineup, PERIOD_END);
  assert.equal(f.run.routing?.mode, "auto", "the auto pin did not apply");
}

/** The team service with the routing recorder attached. The caller writes the team record first. */
function openTeam(f: Fixture, store: EvidenceStore) {
  const outbox = new EventOutbox(store);
  registerRouting(store, outbox);
  const teams = f.openTeam({ events: outbox });
  teams.useRouter(new RoutingRecorder({ store }));
  return teams;
}

/** A member copy of the run's first member, shaped as a running implementer on `profile`. */
function implementer(f: Fixture, memberId: string, cwd: string, profile: TeamLineup["implementers"][number], provider: "claude" | "codex" | "opencode") {
  return { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, provider, modelProfile: profile,
    status: "running" as const, prompt: "Write a.txt" };
}

/** Writes a.txt in a member clone, and makes task a the member's running task. */
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

/** A pending task a with agentProfileId haiku and no member, so `step` prepares its first implementer. */
function pendingTask(f: Fixture) {
  // A project team with no setup: the launch reads `team.setup`, which the fixture project lacks.
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

/** A running implementer on astra-xhigh whose report escalates to `profileId`. */
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
