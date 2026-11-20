import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import type { PermissionAgentServices } from "../packages/host/src/permission-agent-types.js";
import type { TeamPermissionDecision, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { permissionAuthorityHash, permissionEvidenceHash } from "../packages/host/src/team-permissions.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Saved = { run: TeamRun; receipts: Record<string, string>; pending?: { kind: string } };
const revokedEvent = "Delegated permission decisions were revoked by the owner.";
const count = (view: TeamView, text: string) => view.events.filter(event => event.text.startsWith(text)).length;

/**
 * Stops the host right after its `stopAt`-th record write once armed. The Blackboard mirror runs after each sealed
 * write lands; from then on the record cannot be written, as if the process died before its next write.
 */
function hostStop(f: Fixture, stopAt: number) {
  let armed = false, writes = 0, restore: (() => void) | undefined;
  const entries = { retryable: () => false, mirror: () => {
    if (armed && ++writes === stopAt) restore = f.blockRecordWrites("team", f.run.id);
    return true;
  } };
  return { entries: entries as unknown as Blackboard, arm: () => { armed = true; }, stopped: () => restore !== undefined, restart: () => restore?.() };
}

/** Runs `act` once per record write it makes, stopping the host after that write, and checks a retry on a restarted host. */
async function eachStop(setup: (f: Fixture) => void, act: (f: Fixture, teams: TeamService) => Promise<TeamView>, retry: (f: Fixture, teams: TeamService, stopAt: number) => Promise<void>) {
  for (let stopAt = 1; ; stopAt++) {
    assert.ok(stopAt <= 10, "the action makes a bounded number of record writes");
    const f = schedulerFixture();
    try {
      setup(f);
      const stop = hostStop(f, stopAt), first = f.openTeam({ entries: stop.entries });
      stop.arm();
      await act(f, first).catch(() => undefined);
      if (!stop.stopped()) { assert.ok(stopAt > 1, "the action writes its record"); return; }
      stop.restart();
      await retry(f, f.openTeam(), stopAt);
    } finally { f.close(); }
  }
}

/** A run whose coordinator approved one permission answer; the owner has one question open. */
function delegatedRun(f: Fixture) {
  const target = f.run.members[0], at = new Date().toISOString();
  const prompt: Prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
    title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
    options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No (esc)", role: "reject" }] };
  f.state.attention.state = "needs-you"; f.state.attention.prompt = prompt;
  f.run.permissions = { mode: "coordinator", scope: "Approve one-time runs of accepted checks.", maxDecisions: 3 };
  f.run.lineup = limitLineup;
  f.run.decisions = [{ id: randomUUID(), memberId: target.memberId, revision: 1, question: "Which file first?", options: ["a", "b"], createdAt: at }];
  f.run.permissionDecisions = [{ id: randomUUID(), revision: 1, targetMemberId: target.memberId, targetSessionId: target.sessionId, targetCwd: target.cwd,
    policyHash: createHash("sha256").update(JSON.stringify(f.run.permissions)).digest("hex"), promptId: prompt.id, promptHash: prompt.hash!,
    evidenceHash: permissionEvidenceHash(prompt), prompt, option: 0, authorityHash: permissionAuthorityHash(f.run.permissions, []),
    expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), answerRequestId: randomUUID(), coordinatorMemberId: randomUUID(), status: "approved" }];
  f.writeTeam();
}

/**
 * Starts the host's own delivery of the approved answer, which saves its pending result operation and marks the
 * decision answering, then starts `act` and stops the host while the action's invalidation waits for the worker to
 * fence that answer. The first service is abandoned at that call, which never returns; a second one opens over what
 * the first saved. Only fences asked after the restart are counted.
 */
async function stopInFence(f: Fixture, act: (teams: TeamService) => Promise<TeamView>) {
  let restarted = false, dispatched!: () => void, stopped!: () => void;
  const answering = new Promise<void>(resolve => { dispatched = resolve; }), fencing = new Promise<void>(resolve => { stopped = resolve; });
  const fences: string[] = [];
  Object.assign(f.manager, {
    answerTeamPermission: () => { dispatched(); return new Promise<never>(() => {}); },
    invalidateTeamPermission: async (_sessionId: string, decisionId: string) => {
      if (!restarted) { stopped(); return new Promise<never>(() => {}); }
      fences.push(decisionId); return "invalidated";
    },
  });
  const first = f.openTeam();
  type Deliver = { deliverApprovedDecision(stored: Saved, decision: TeamPermissionDecision): Promise<void> };
  const host = first as unknown as Deliver & { record(id: string): Saved; permissions?: Deliver };
  // The delivery lives on the service until the teams.ts split (INF-330) moves it into the permission cluster.
  const delivery = host.permissions ?? host;
  const stored = host.record(f.run.id);
  await delivery.deliverApprovedDecision(stored, stored.run.permissionDecisions![0]!);
  await answering;
  void act(first);
  await fencing;
  restarted = true;
  const saved = f.readRecord<Saved>("team", f.run.id);
  assert.equal(saved.pending?.kind, "result", "the delivery is saved as a pending operation");
  assert.equal(saved.run.permissionDecisions?.[0]?.status, "uncertain", "the host stopped after the invalidation saved its mark");
  return { teams: f.openTeam(), fences, saved };
}

test("whichever record write a steer stops after, a retry of the same request applies the steer exactly once", async () => {
  const request = { requestId: randomUUID(), revision: 1, text: "Keep the change inside the API package." };
  await eachStop(f => f.writeTeam(), (f, teams) => teams.steer(f.run.id, request), async (f, teams, stopAt) => {
    const replayed = await teams.steer(f.run.id, request);
    assert.equal(replayed.revision, 2, `a stop after write ${stopAt} must not answer the retry without the steer`);
    assert.deepEqual(replayed.steering.map(item => item.text), [request.text]);
    assert.ok(f.readRecord<Saved>("team", f.run.id).receipts[request.requestId], "the receipt is saved with the steer");
    // The request took effect: a further retry succeeds without re-checking its revision and steers nothing more.
    const again = await teams.steer(f.run.id, request);
    assert.equal(again.revision, 2);
    assert.deepEqual(again.steering.map(item => item.text), [request.text]);
  });
});

test("whichever record write an agent-only revocation stops after, a retry of the same request records it exactly once", async () => {
  const agent = { delivery: {}, pipeline: { serves: () => ({ served: true }), taskEnded: () => {} } } as unknown as PermissionAgentServices;
  const request = { requestId: randomUUID(), revision: 1 };
  await eachStop(f => { assert.equal(f.run.permissions, undefined, "the permission agent alone serves this run"); f.writeTeam(); }, (f, teams) => {
    teams.usePermissionAgent(agent);
    return teams.revokePermissions(f.run.id, request);
  }, async (f, teams, stopAt) => {
    teams.usePermissionAgent(agent);
    const replayed = await teams.revokePermissions(f.run.id, request);
    assert.equal(count(replayed, revokedEvent), 1, `a stop after write ${stopAt} must not refuse or skip the retried revocation`);
    assert.ok(replayed.permissionsRevokedAt);
    assert.ok(f.readRecord<Saved>("team", f.run.id).receipts[request.requestId], "the receipt is saved with the revocation");
    assert.equal(count(await teams.revokePermissions(f.run.id, request), revokedEvent), 1);
  });
});

test("a host stop while a revocation fences an answer in delivery leaves the request open, so its retry records the revocation once", async () => {
  const f = schedulerFixture();
  try {
    delegatedRun(f);
    const request = { requestId: randomUUID(), revision: 1 };
    const { teams, fences, saved } = await stopInFence(f, teams => teams.revokePermissions(f.run.id, request));
    assert.ok(saved.run.permissionsRevokedAt, "delegation is revoked before the fence, so no new delegated answer starts during it");

    const replayed = await teams.revokePermissions(f.run.id, request);
    assert.equal(count(replayed, revokedEvent), 1, "the retry recorded the revocation the stopped host never saved");
    assert.equal(replayed.permissionsRevokedAt, saved.run.permissionsRevokedAt, "the retry keeps the first revocation time");
    assert.ok(f.readRecord<Saved>("team", f.run.id).receipts[request.requestId], "the receipt is saved with the revocation");
    assert.equal(count(await teams.revokePermissions(f.run.id, request), revokedEvent), 1);
    assert.deepEqual(fences, [], "the retry does not fence again the answer the stopped host already marked uncertain");
  } finally { f.close(); }
});

test("a host stop while an owner answer fences an answer in delivery keeps the owner's answer", async () => {
  const f = schedulerFixture();
  try {
    delegatedRun(f);
    const question = f.run.decisions[0]!, request = { requestId: randomUUID(), revision: 1, text: "a" };
    const { teams } = await stopInFence(f, teams => teams.answer(f.run.id, question.id, request));

    // The restart blocks the run on its retained delivery operation, so only a recorded answer can still be acknowledged.
    const retried = await teams.answer(f.run.id, question.id, request);
    assert.equal(retried.decisions.find(item => item.id === question.id)?.answer, request.text);
    assert.equal(count(retried, "A user decision was recorded."), 1);
  } finally { f.close(); }
});
