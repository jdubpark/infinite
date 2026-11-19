import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { TeamPermissionDecision, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { permissionAuthorityHash, permissionEvidenceHash } from "../packages/host/src/team-permissions.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Saved = { run: TeamRun; receipts: Record<string, string>; unfencedAnswers?: string[] };

/**
 * Starts `act` on a run with a coordinator's permission answer in flight, then stops the host while the action's
 * invalidation waits for the worker to fence that answer: the first service is abandoned at that call, which never
 * returns, and a second service opens over what the first one saved. Only fences asked after the restart are counted.
 */
async function stopDuringFence(f: Fixture, act: (teams: TeamService) => Promise<TeamView>) {
  const target = f.run.members[0];
  const prompt: Prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
    title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
    options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No (esc)", role: "reject" }] };
  f.run.permissions = { mode: "coordinator", scope: "Approve one-time runs of accepted checks.", maxDecisions: 3 };
  f.writeTeam();
  let restarted = false, stopped!: () => void;
  const fences: string[] = [], reached = new Promise<void>(resolve => { stopped = resolve; });
  Object.assign(f.manager, { invalidateTeamPermission: async (_sessionId: string, decisionId: string) => {
    if (!restarted) { stopped(); return new Promise<never>(() => {}); }
    fences.push(decisionId); return "invalidated";
  } });
  const first = f.openTeam();
  const live = (first as unknown as { record(id: string): Saved }).record(f.run.id);
  const inFlight: TeamPermissionDecision = { id: randomUUID(), revision: 1, targetMemberId: target.memberId, targetSessionId: target.sessionId,
    targetCwd: target.cwd, policyHash: createHash("sha256").update(JSON.stringify(f.run.permissions)).digest("hex"), promptId: prompt.id,
    promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt), prompt, option: 0, authorityHash: permissionAuthorityHash(f.run.permissions, []),
    expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), answerRequestId: randomUUID(), coordinatorMemberId: randomUUID(), status: "answering" };
  // Dispatch marks an answer in flight in the same save; a stored "answering" is marked uncertain on restore, so it is set in memory.
  live.run.permissionDecisions = [inFlight]; live.unfencedAnswers = [inFlight.id];
  void act(first);
  await reached;
  restarted = true;
  const saved = f.readRecord<Saved>("team", f.run.id);
  assert.equal(saved.run.permissionDecisions?.[0]?.status, "uncertain", "the host stopped after the invalidation saved its mark");
  return { teams: f.openTeam(), fences, inFlight, saved };
}

test("a host stop while a steer fences an in-flight answer leaves the request open, so its replay applies the steer once", async () => {
  const f = schedulerFixture();
  try {
    const request = { requestId: randomUUID(), revision: 1, text: "Keep the change inside the API package." };
    const { teams, fences, inFlight } = await stopDuringFence(f, teams => teams.steer(f.run.id, request));

    const replayed = await teams.steer(f.run.id, request);
    assert.equal(replayed.revision, 2, "the replay applied the steer the stopped host never saved");
    assert.deepEqual(replayed.steering.map(item => item.text), [request.text]);
    const saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.revision, 2);
    assert.ok(saved.receipts[request.requestId], "the receipt is saved with the steer");

    // The request took effect: a further replay succeeds without re-checking its revision and steers nothing more.
    const again = await teams.steer(f.run.id, request);
    assert.equal(again.revision, 2);
    assert.deepEqual(again.steering.map(item => item.text), [request.text]);

    assert.deepEqual(fences, [], "the replay does not fence the answer the stopped host already marked uncertain");
    assert.equal(again.permissionDecisions?.find(decision => decision.id === inFlight.id)?.status, "uncertain");
    assert.deepEqual(saved.unfencedAnswers, [inFlight.id], "the unconfirmed fence stays open for the scheduler's re-fence");
  } finally { f.close(); }
});

test("a host stop while revoking delegated permissions leaves the request open, so its replay records the revocation once", async () => {
  const f = schedulerFixture();
  try {
    const request = { requestId: randomUUID(), revision: 1 };
    const revoked = "Delegated permission decisions were revoked by the owner.";
    const { teams, fences, saved: stopped } = await stopDuringFence(f, teams => teams.revokePermissions(f.run.id, request));
    assert.ok(stopped.run.permissionsRevokedAt, "delegation is revoked before the fence, so no new delegated answer starts during it");

    const replayed = await teams.revokePermissions(f.run.id, request);
    assert.equal(replayed.events.filter(event => event.text === revoked).length, 1, "the replay recorded the revocation the stopped host never saved");
    assert.equal(replayed.permissionsRevokedAt, stopped.run.permissionsRevokedAt, "the replay keeps the first revocation time");
    assert.ok(f.readRecord<Saved>("team", f.run.id).receipts[request.requestId], "the receipt is saved with the revocation");

    const again = await teams.revokePermissions(f.run.id, request);
    assert.equal(again.events.filter(event => event.text === revoked).length, 1);
    assert.deepEqual(fences, [], "the replay does not fence the answer the stopped host already marked uncertain");
  } finally { f.close(); }
});
