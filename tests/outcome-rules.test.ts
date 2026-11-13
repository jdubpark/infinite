import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLOCK_DISPOSITIONS,
  exclusionOf,
  freezeAccepted,
  levels,
  linkAfterPaths,
  replaces,
  reportDisposition,
  roundCounts,
  stopDisposition,
  type LinkState,
  type RowState,
} from "../packages/host/src/outcome-rules.js";

function row(overrides: Partial<RowState> & Pick<RowState, "disposition">): RowState {
  return { role: "implementer", accepted: null, links: [], ...overrides };
}

test("dispositions follow the spec table", () => {
  assert.equal(stopDisposition("stall"), "stalled");
  assert.equal(stopDisposition("limit"), "limit");
  assert.equal(stopDisposition("no-report"), "no-report");
  assert.equal(stopDisposition("owner"), "owner-stop");
  assert.equal(stopDisposition("host"), "host-stop");
  assert.equal(exclusionOf("limit"), "limit");
  assert.equal(exclusionOf("owner-stop"), "owner");
  assert.equal(exclusionOf("host-stop"), "host");
  assert.equal(exclusionOf("stalled"), undefined);
  assert.equal(BLOCK_DISPOSITIONS["task-scope-violation"], "out-of-scope");
  assert.equal(BLOCK_DISPOSITIONS["integration-conflict"], "host-stop");
  assert.equal(BLOCK_DISPOSITIONS["repair-limit"], undefined);
  assert.equal(reportDisposition("result"), undefined);
  assert.equal(reportDisposition("question"), "question");
  assert.equal(reportDisposition("blocked"), "blocked");
});

test("a later fact replaces an earlier one only by precedence", () => {
  assert.equal(replaces("open", "stalled"), true);
  assert.equal(replaces("stalled", "owner-stop"), false);
  assert.equal(replaces("host-stop", "out-of-scope"), true);
  assert.equal(replaces("owner-stop", "out-of-scope"), false);
  assert.equal(replaces("host-stop", "integrated"), true);
  assert.equal(replaces("integrated", "host-stop"), false);
  // A halt stops a member before every journal page is read, so a report can follow the stop it preceded.
  assert.equal(replaces("host-stop", "question"), true);
  assert.equal(replaces("owner-stop", "blocked"), true);
  assert.equal(replaces("stalled", "question"), false);
  assert.equal(replaces("limit", "blocked"), false);
  assert.equal(replaces("question", "host-stop"), false);
});

test("levels by row state", () => {
  const as = (state: RowState) => {
    const result = levels(state);
    return [result.integrated, result.accepted, result.firstPass, result.held];
  };
  assert.deepEqual(as(row({ disposition: "open" })), [null, null, null, null]);
  assert.deepEqual(as(row({ disposition: "owner-stop" })), [null, null, null, null]);
  assert.deepEqual(as(row({ role: "scout", disposition: "completed" })), [null, null, null, null]);
  assert.deepEqual(as(row({ disposition: "stalled" })), [0, 0, 0, 0]);
  assert.deepEqual(as(row({ disposition: "integrated" })), [1, null, null, null]);
  assert.deepEqual(
    as(row({ disposition: "integrated", accepted: 1, links: ["clear", "clear"] })),
    [1, 1, 1, null],
  );
  assert.deepEqual(as(row({ disposition: "integrated", accepted: 1, links: ["pending"] })), [1, 1, null, null]);
  assert.deepEqual(as(row({ disposition: "integrated", links: ["attributed"] })), [1, null, 0, null]);
  assert.deepEqual(as(row({ disposition: "integrated", accepted: 0 })), [1, 0, 0, 0]);
});

test("a freeze decides acceptance from the last covering review", () => {
  assert.equal(freezeAccepted(null, "changes-requested", "ready-for-review"), 0);
  assert.equal(freezeAccepted(null, "changes-requested", "cancelled"), null);
  assert.equal(freezeAccepted(null, undefined, "ready-for-review"), null);
  assert.equal(freezeAccepted(1, "changes-requested", "ready-for-review"), 1);
});

test("a round link follows the changed paths", () => {
  assert.equal(linkAfterPaths(["packages/host/src"], ["packages/host/src/a.ts"]), "attributed");
  assert.equal(linkAfterPaths(["packages/host/src"], ["apps/web/b.ts"]), "clear");
  assert.equal(linkAfterPaths(["packages/host/src"], []), "clear");
  assert.equal(linkAfterPaths(["packages/host/src"], "omitted"), "unknown");
  assert.equal(linkAfterPaths(undefined, ["packages/host/src/a.ts"]), "unknown");
  assert.equal(linkAfterPaths(["."], ["apps/web/b.ts"]), "attributed");
  assert.equal(linkAfterPaths(["src"], ["src2/a.ts"]), "clear");
});

test("round counts", () => {
  const links: LinkState[] = ["pending", "attributed", "clear", "unknown"];
  assert.deepEqual(roundCounts(links), { run: 4, attributed: 1, unknown: 2 });
});

test("team prompts never import the ledger", () => {
  const source = readFileSync(new URL("../packages/host/src/team-prompts.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  const forbidden = ["outcome-", "configuration-store", "config-identity", "evidence/"];
  for (const specifier of specifiers)
    for (const name of forbidden) assert.ok(!specifier.includes(name), `team-prompts imports ${specifier}`);
});
