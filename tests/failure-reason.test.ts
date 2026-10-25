import assert from "node:assert/strict";
import test from "node:test";
import { failureReason } from "../packages/host/src/failure-reason.js";

test("failureReason redacts long tokens, shortens paths, appends stderr and clips", () => {
  const reason = failureReason(new Error("exit 1"), "warning\nENOENT /very/long/path/" + "x".repeat(90) + "/dist/cli.js token=" + "A".repeat(40) + "\n");
  assert.match(reason, /^exit 1 · ENOENT .*dist\/cli\.js token=\[redacted\]$/);
  assert.ok(reason.length <= 400);
  assert.equal(failureReason("plain"), "plain");
  assert.equal(failureReason(new Error("y ".repeat(500))).length, 400);
});
