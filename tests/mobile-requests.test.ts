import test from "node:test";
import assert from "node:assert/strict";
import { runRequests } from "../apps/mobile/src/store/requests";

test("dismissing a settled run receipt removes its cache entry but keeps pending requests", () => {
  const settledKey = "test-machine/test-run-settled";
  runRequests.begin(settledKey, { requestId: "settled-request", revision: 1, path: "/run", label: "Steer", fields: {} });
  runRequests.complete(settledKey, "settled-request", { id: "result" }, "Steer recorded.");
  runRequests.clearMessage(settledKey);
  assert.deepEqual(runRequests.read(settledKey), { message: "" });

  const pendingKey = "test-machine/test-run-pending";
  const pending = { requestId: "pending-request", revision: 2, path: "/run", label: "Answer", fields: {} };
  runRequests.begin(pendingKey, pending);
  runRequests.fail(pendingKey, pending.requestId, "Delivery is unconfirmed.");
  runRequests.clearMessage(pendingKey);
  assert.equal(runRequests.read(pendingKey).pending?.requestId, pending.requestId);
  assert.equal(runRequests.read(pendingKey).message, "");
  runRequests.clear(pendingKey);
});
