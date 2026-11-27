import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TeamError } from "../packages/host/src/teams.js";
import { scriptedMissionHarness } from "./mission-harness.js";

test("extending a mission rechecks authorization inside the mutation queue", { timeout: 60000 }, async () => {
  const h = scriptedMissionHarness();
  try {
    const created = await h.create();
    const before = h.get(created.id);
    const denied = new TeamError(403, "intake-audience-denied", "The Slack audience changed.");
    await assert.rejects(h.missions.extend(created.id,
      { requestId: randomUUID(), revision: before.revision, minutes: 10 }, () => { throw denied; }), error => error === denied);
    const after = h.get(created.id);
    assert.equal(after.revision, before.revision);
    assert.equal(after.deadlineAt, before.deadlineAt);
  } finally { h.close(); }
});
