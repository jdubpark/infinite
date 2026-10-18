import test from "node:test";
import assert from "node:assert/strict";
import { blockedTeamCanResume, memberTimeLimitReason } from "../packages/host/src/teams.js";

const ready = {
  status: "blocked",
  reason: memberTimeLimitReason,
  pending: false,
  deliveryAttempt: false,
  deliveryReceipt: false,
  prepared: true,
  stopReason: undefined,
  linearStatus: "synced",
};

test("a one-hour member stop can resume, and uncertain blocks cannot", () => {
  assert.equal(blockedTeamCanResume(ready), true);
  assert.equal(blockedTeamCanResume({ ...ready, pending: true }), false);
  assert.equal(blockedTeamCanResume({ ...ready, deliveryAttempt: true }), false);
  assert.equal(blockedTeamCanResume({ ...ready, deliveryReceipt: true }), false);
  assert.equal(blockedTeamCanResume({ ...ready, prepared: false }), false);
  assert.equal(blockedTeamCanResume({ ...ready, stopReason: "deadline" }), false);
  assert.equal(blockedTeamCanResume({ ...ready, linearStatus: "blocked" }), false);
  assert.equal(blockedTeamCanResume({ ...ready, reason: "An agent exited without a valid structured report. Its task is unresolved." }), false);
  assert.equal(blockedTeamCanResume({ ...ready, status: "paused" }), false);
});
