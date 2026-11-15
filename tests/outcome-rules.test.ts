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
  rowExclusion,
  scanGap,
  stopDisposition,
  type LinkState,
  type RowState,
} from "../packages/host/src/outcome-rules.js";

function row(overrides: Partial<RowState> & Pick<RowState, "disposition">): RowState {
  return { role: "implementer", accepted: null, links: [], ...overrides };
}

function fourLevels(state: RowState): (0 | 1 | null)[] {
  const result = levels(state);
  return [result.integrated, result.accepted, result.firstPass, result.held];
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

test("an owner exclusion removes every level", () => {
  const excluded = { excluded: true, negative: false, landing: "covered" as const };
  const owned = row({ disposition: "integrated", accepted: 1, links: ["clear"], signals: excluded });
  assert.deepEqual(fourLevels(owned), [null, null, null, null]);
  assert.equal(rowExclusion("integrated", owned.signals), "owner");

  const kept = row({ disposition: "integrated", accepted: 1, links: ["clear"], signals: { ...excluded, excluded: false } });
  assert.deepEqual(fourLevels(kept), [1, 1, 1, 1]);
  assert.equal(rowExclusion("integrated", kept.signals), undefined);

  const limited = row({ disposition: "limit", signals: { excluded: true, negative: false } });
  assert.equal(rowExclusion("limit", limited.signals), "limit");
  assert.deepEqual(fourLevels(limited), [null, null, null, null]);
});

test("held follows the window", () => {
  const accepted = { accepted: 1 as const, links: ["clear" as const] };
  const at = (landing: "covered" | "open" | "gap") => row({ disposition: "integrated", ...accepted, signals: { excluded: false, negative: false, landing } });
  assert.equal(fourLevels(at("covered"))[3], 1);
  assert.equal(scanGap(at("covered")), false);
  assert.equal(fourLevels(at("open"))[3], null);
  assert.equal(scanGap(at("open")), false);
  assert.equal(fourLevels(at("gap"))[3], null);
  assert.equal(scanGap(at("gap")), true);

  const noLanding = row({ disposition: "integrated", ...accepted, signals: { excluded: false, negative: false } });
  assert.equal(fourLevels(noLanding)[3], null);
  assert.equal(scanGap(noLanding), false);

  const unaccepted = row({ disposition: "integrated", signals: { excluded: false, negative: false, landing: "covered" } });
  assert.equal(fourLevels(unaccepted)[3], null);
});

test("a negative signal makes held no", () => {
  const negative = { excluded: false, negative: true };
  const reverted = row({ disposition: "integrated", accepted: 1, signals: { ...negative, landing: "covered" } });
  assert.equal(fourLevels(reverted)[3], 0);
  assert.equal(scanGap(row({ disposition: "integrated", accepted: 1, signals: { ...negative, landing: "gap" } })), false);

  const unaccepted = row({ disposition: "integrated", links: ["clear"], signals: negative });
  assert.equal(fourLevels(unaccepted)[3], 0);
  assert.equal(levels(unaccepted).firstPass, levels(row({ disposition: "integrated", links: ["clear"] })).firstPass);

  const rejected = row({ disposition: "integrated", accepted: 0, signals: { excluded: false, negative: false, landing: "covered" } });
  assert.equal(fourLevels(rejected)[3], 0);
});

test("rows without signals keep today's levels", () => {
  const stalledWithSignals = row({ disposition: "stalled", signals: { excluded: false, negative: true, landing: "covered" } });
  assert.deepEqual(fourLevels(stalledWithSignals), [0, 0, 0, 0]);
  const integrated = row({ disposition: "integrated", accepted: 1, links: ["clear"] });
  assert.deepEqual(fourLevels(integrated), [1, 1, 1, null]);
  assert.equal(scanGap(integrated), false);
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
  const importsOf = (file: string) => {
    const source = readFileSync(new URL(`../packages/host/src/${file}`, import.meta.url), "utf8");
    return [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]);
  };
  const promptSpecifiers = importsOf("team-prompts.ts");
  assert.ok(promptSpecifiers.length > 0);
  const promptForbidden = ["outcome-", "configuration-store", "config-identity", "evidence/", "scorecard"];
  for (const specifier of promptSpecifiers)
    for (const name of promptForbidden) assert.ok(!specifier.includes(name), `team-prompts imports ${specifier}`);

  const mcpSpecifiers = importsOf("team-mcp.ts");
  assert.ok(mcpSpecifiers.length > 0);
  for (const specifier of mcpSpecifiers)
    for (const name of ["outcome-", "scorecard"]) assert.ok(!specifier.includes(name), `team-mcp imports ${specifier}`);
});
