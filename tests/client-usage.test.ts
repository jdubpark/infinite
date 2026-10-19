import test from "node:test";
import assert from "node:assert/strict";
import { usageBars } from "../packages/host/src/client.js";

test("usage bars scale to eight Unicode levels", () => {
  assert.equal(usageBars([0, 1, 2, 4]), "▁▂▄█");
  assert.equal(usageBars([0, 0]), "▁▁");
});
