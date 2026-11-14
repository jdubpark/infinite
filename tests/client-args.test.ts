import test from "node:test";
import assert from "node:assert/strict";
import { clientCommandCandidate, handleClientCommand, legacyImportLines, outcomeCellLines, outcomeRollupLines, parseClientArgs } from "../packages/host/src/client.js";
import type { OutcomeRollup } from "../packages/host/src/outcome-rollup.js";
import type { LegacyLineOutcome } from "../packages/host/src/outcome-legacy.js";
import type { CellsResult } from "../packages/host/src/outcome-reads.js";

test("codex defaults to cloud execution; --laptop is the explicit opt-in", () => {
  const cloud = parseClientArgs(["codex", "--model", "m", "Inspect"]);
  assert.equal(cloud.command, "codex");
  assert.equal(cloud.options["--laptop"], undefined);
  assert.equal(cloud.options["--local-ui"], undefined);
  assert.deepEqual(cloud.args, ["--model", "m", "Inspect"]);
  const laptop = parseClientArgs(["--laptop", "codex", "Inspect"]);
  assert.equal(laptop.options["--laptop"], true);
  assert.equal(laptop.options["--local-ui"], true, "laptop execution still requires the Codex native interface");
});

test("--cloud stays accepted as a no-op and conflicts with --laptop", () => {
  const parsed = parseClientArgs(["--cloud", "codex"]);
  assert.equal(parsed.options["--cloud"], true);
  assert.equal(parsed.options["--laptop"], undefined);
  assert.throws(() => parseClientArgs(["--cloud", "--laptop", "codex"]), /either cloud execution or --laptop/);
});

test("--laptop is Codex-only and --include needs --laptop", () => {
  assert.throws(() => parseClientArgs(["--laptop", "claude"]), /--laptop starts a Codex session/);
  assert.throws(() => parseClientArgs(["--include", "../shared", "codex"]), /--include applies to --laptop/);
  assert.deepEqual(parseClientArgs(["--include", "../shared", "--laptop", "codex"]).includes, ["../shared"]);
});

test("non-provider commands keep positionals and later options", () => {
  const parsed = parseClientArgs(["resume", "5ba58d55", "--takeover"]);
  assert.equal(parsed.command, "resume");
  assert.deepEqual(parsed.args, ["5ba58d55"]);
  assert.equal(parsed.options["--takeover"], true);
});

test("server administration commands keep their own options even when a provider name appears", () => {
  const parsed = parseClientArgs(["new", "--provider", "codex", "--title", "Task"]);
  assert.equal(parsed.command, "new");
  assert.deepEqual(parsed.args, []);
});

test("a server option value named like a client command stays with the server parser", async () => {
  assert.equal(await handleClientCommand(["--config", "evidence", "serve"]), false);
  assert.equal(await handleClientCommand(["--state-dir", "evidence", "init"]), false);
  assert.equal(await handleClientCommand(["--config", "list", "serve"]), false);
  assert.equal(clientCommandCandidate(["--state-dir", "evidence", "init"]), undefined);
  assert.equal(clientCommandCandidate(["--config", "evidence", "serve"]), undefined);
});

test("client commands are still found after client options and before pass-through arguments", () => {
  assert.equal(clientCommandCandidate(["--json", "usage"]), "usage");
  assert.equal(clientCommandCandidate(["--client-config", "client.json", "usage"]), "usage");
  assert.equal(clientCommandCandidate(["--client-config", "usage", "list"]), "list", "a client option value is not the command");
  assert.equal(clientCommandCandidate(["evidence", "status", "--json"]), "evidence");
  assert.equal(clientCommandCandidate(["codex", "--model", "m", "list"]), "codex");
  assert.equal(clientCommandCandidate(["--include", "../shared", "--laptop", "codex", "Inspect"]), "codex");
});

test("sync and pull commands parse their options", () => {
  const start = parseClientArgs(["sync", "--project", "example"]);
  assert.equal(start.command, "sync"); assert.equal(start.options["--project"], "example");
  const stop = parseClientArgs(["sync", "--stop"]);
  assert.equal(stop.options["--stop"], true);
  const apply = parseClientArgs(["sync", "--apply", "--force"]);
  assert.equal(apply.options["--apply"], true); assert.equal(apply.options["--force"], true);
  const pull = parseClientArgs(["pull", "example", "--output", "/tmp/x"]);
  assert.deepEqual(pull.args, ["example"]); assert.equal(pull.options["--output"], "/tmp/x");
  assert.throws(() => parseClientArgs(["--include", "../lib", "sync"]), /--include applies to --laptop/);
  assert.throws(() => parseClientArgs(["sync", "--include", "../lib"]), /--include applies to --laptop/, "a trailing --include is refused too");
  assert.throws(() => parseClientArgs(["sync", "--laptop"]), /--laptop starts a Codex session/);
});

test("sync accepts one action and no arguments; pull takes at most one project", () => {
  assert.throws(() => parseClientArgs(["sync", "--force"]), /--force applies to infinite sync --apply/);
  assert.throws(() => parseClientArgs(["sync", "--stop", "--status"]), /Choose one of --stop, --status, or --apply/);
  assert.throws(() => parseClientArgs(["sync", "--apply", "--stop"]), /Choose one of --stop, --status, or --apply/);
  assert.throws(() => parseClientArgs(["sync", "example"]), /infinite sync takes no arguments/);
  assert.throws(() => parseClientArgs(["pull", "a", "b"]), /infinite pull takes at most one project ID/);
  assert.deepEqual(parseClientArgs(["pull"]).args, []);
});

test("team review logs are a view flag and do not replace json", () => {
  const parsed = parseClientArgs(["team", "watch", "team-1", "--logs"]);
  assert.equal(parsed.command, "team");
  assert.deepEqual(parsed.args, ["watch", "team-1"]);
  assert.equal(parsed.options["--logs"], true);
  assert.throws(() => parseClientArgs(["team", "status", "team-1", "--logs", "--json"]), /either --logs or --json/);
  assert.throws(() => parseClientArgs(["list", "--logs"]), /--logs applies to infinite team/);
});

test("cell lines show unknown beside every rate", () => {
  const level = (yes: number, no: number, unknown: number, rate: number | null, interval: [number, number] | null) => ({ yes, no, unknown, rate, interval });
  const none = level(0, 0, 0, null, null);
  const cell = (key: Record<string, string>, levels: Partial<Record<"integrated" | "accepted" | "firstPass" | "held", ReturnType<typeof level>>>) => ({
    key, sources: ["production"], from: null, to: null, attempts: 4, open: 0,
    excluded: { limit: 0, owner: 0, host: 0, duel: 0 }, withheld: { backfilled: 0, gap: 0, unfrozen: 0 },
    flagged: { backfilled: 0, gap: 0, "empty-result": 0, "same-model-review": 0 },
    levels: { integrated: none, accepted: none, firstPass: none, held: none, ...levels },
    tokens: null, spentUsd: null, listUsd: null, minutes: null, ownerRating: null, enough: false,
  });
  const result = (cells: unknown[], unreadable = 0) => ({ cells, unreadable }) as unknown as CellsResult;

  const [line] = outcomeCellLines(result([cell({ profile: "light" }, { accepted: level(1, 0, 3, 1, [0.21, 1]) })]));
  assert.ok(line!.includes("1 yes, 0 no, 3 unknown"), line);
  assert.ok(line!.includes("fewer than 10 counted attempts"), line);

  const [unknownRate] = outcomeCellLines(result([cell({ profile: "light" }, {})]));
  assert.ok(unknownRate!.includes("rate unknown"), unknownRate);
  assert.ok(!unknownRate!.includes("0%"), "a null rate never prints as 0%");

  const [controlled] = outcomeCellLines(result([cell({ profile: "li\u0007ght" }, {})]));
  assert.ok(controlled!.includes("profile=li ght"), controlled);

  assert.deepEqual(outcomeCellLines(result([])), ["No outcome rows match."]);

  const parsed = parseClientArgs(["usage", "outcomes", "--by", "profile", "--sources", "production,duel", "--days", "7"]);
  assert.equal(parsed.options["--by"], "profile");
  assert.equal(parsed.options["--sources"], "production,duel");
  assert.equal(parsed.options["--days"], "7");
});

test("signal options parse", () => {
  const linked = parseClientArgs(["usage", "outcomes", "link-fix", "--run", "R", "--member", "M", "--issue", "ABC-7", "--commit", "c".repeat(40), "--at", "2026-11-13T10:00:00Z", "--request-id", "Q"]);
  assert.deepEqual(linked.args, ["outcomes", "link-fix"]);
  assert.equal(linked.options["--member"], "M");
  assert.equal(linked.options["--issue"], "ABC-7");
  assert.equal(linked.options["--commit"], "c".repeat(40));
  assert.equal(linked.options["--at"], "2026-11-13T10:00:00Z");
  assert.equal(linked.options["--request-id"], "Q");
  const excluded = parseClientArgs(["usage", "outcomes", "exclude", "--run", "R", "--member", "M", "--reason", "trial", "--withdraw", "S"]);
  assert.equal(excluded.options["--reason"], "trial");
  assert.equal(excluded.options["--withdraw"], "S");
});

const rollupRuns = (over: Record<string, unknown> = {}) => ({
  total: 0, withSummary: 0, withCounts: 0, deleted: 0, status: {}, blockCodes: {}, counts: null, rounds: null,
  flagged: { backfilled: 0, gap: 0 }, ...over,
});
const rollupOf = (over: Record<string, unknown> = {}) => ({
  target: { kind: "goal", id: "G1" }, known: true, assessment: null, runs: rollupRuns(), attempts: {},
  implementer: [], scout: [], members: 0,
  cost: { sessions: 0, complete: 0, noSession: 0, tokens: null, spentUsd: null },
  unreadable: { summaries: 0, rows: 0, members: 0 }, unindexed: 0, ...over,
}) as unknown as OutcomeRollup;
const cellOf = (key: Record<string, string>, levels: Record<string, unknown> = {}) => {
  const none = { yes: 0, no: 0, unknown: 0, rate: null, interval: null };
  return {
    key, sources: ["production"], from: null, to: null, attempts: 1, open: 0,
    excluded: { limit: 0, owner: 0, host: 0, duel: 0 }, withheld: { backfilled: 0, gap: 0, unfrozen: 0 },
    flagged: { backfilled: 0, gap: 0, "empty-result": 0, "same-model-review": 0, "scan-gap": 0 },
    levels: { integrated: none, accepted: none, firstPass: none, held: none, ...levels },
    tokens: null, spentUsd: null, listUsd: null, minutes: null, ownerRating: null, enough: false,
  };
};

test("roll-up and import options parse", () => {
  const parsed = parseClientArgs(["usage", "outcomes", "--goal", "G1", "--mission", "M1", "--file", "legacy.jsonl", "--dry-run"]);
  assert.equal(parsed.options["--goal"], "G1");
  assert.equal(parsed.options["--mission"], "M1");
  assert.equal(parsed.options["--file"], "legacy.jsonl");
  assert.equal(parsed.options["--dry-run"], true);
  assert.equal(clientCommandCandidate(["--dry-run", "usage"]), "usage");
});

test("roll-up lines show unknown, never zero", () => {
  const unsettled = outcomeRollupLines(rollupOf({ runs: rollupRuns({ total: 1, withSummary: 1, status: { unsettled: 1 } }) }));
  assert.ok(unsettled.some(line => line.includes("No run has settled, so its counts are unknown.")), unsettled.join("\n"));
  assert.ok(!unsettled.some(line => line.startsWith("Rounds:")), "a null rounds never prints a Rounds line");

  const noCost = outcomeRollupLines(rollupOf());
  assert.ok(noCost.some(line => line.includes("Cost: tokens unknown over 0 of 0 sessions")), noCost.join("\n"));
  assert.ok(!noCost.some(line => line.includes("tokens 0")), "a null token sum never prints as 0");

  const noAssessment = outcomeRollupLines(rollupOf());
  assert.ok(noAssessment[0]!.includes("no assessment"), noAssessment[0]);

  const notHeld = outcomeRollupLines(rollupOf({ known: false }));
  assert.ok(notHeld[0]!.includes("not held by the host"), notHeld[0]);

  const unreadable = outcomeRollupLines(rollupOf({ unreadable: { summaries: 0, rows: 2, members: 0 } }));
  assert.ok(unreadable.some(line => line.includes("2 rows")), unreadable.join("\n"));

  const unindexed = outcomeRollupLines(rollupOf({ unindexed: 3 }));
  assert.ok(unindexed.some(line => line.includes("index: 3")), unindexed.join("\n"));

  const controlled = outcomeRollupLines(rollupOf({ implementer: [cellOf({ profile: "li\u0007ght" })] }));
  assert.ok(controlled.some(line => line.includes("profile=li ght")), controlled.join("\n"));

  const mission = outcomeRollupLines(rollupOf({ target: { kind: "mission", id: "M1" } }));
  assert.equal(mission[0], "Mission M1");
  assert.ok(!mission.some(line => line.includes("assessment")), mission.join("\n"));
});

test("roll-up lines for a settled goal", () => {
  const implementer = cellOf({ profile: "light" }, { integrated: { yes: 1, no: 1, unknown: 0, rate: 0.5, interval: [0.1, 0.9] } });
  const [cellLine] = outcomeCellLines({ cells: [implementer as never], unreadable: 0 });
  const rollup = rollupOf({
    target: { kind: "goal", id: "G1" },
    assessment: { result: "achieved", at: "2026-11-13T10:00:00Z", revision: 2 },
    runs: rollupRuns({
      // The blocked run has a status and no counts, so only one run is settled: the one whose counts are summed.
      total: 2, withSummary: 2, withCounts: 1, deleted: 0, status: { merged: 1, blocked: 1 }, blockCodes: { "delivery-recovery": 1 },
      counts: { tasks: 2, integrated: 1, members: 3, round: 1, checks: 2, recoveries: 1, decisionsByOwner: 0, decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0 },
      rounds: { total: 3, attributed: 2, unattributed: 1, unknown: 0 },
    }),
    attempts: { integrated: 2, stalled: 1 },
    implementer: [implementer],
    members: 3,
    cost: { sessions: 4, complete: 2, noSession: 1, tokens: 1400, spentUsd: 0.5 },
  });
  assert.deepEqual(outcomeRollupLines(rollup), [
    "Goal G1 · assessment achieved at 2026-11-13T10:00:00Z",
    "Runs 2 · with a summary 2 · settled 1 · deleted 0 · status blocked 1, merged 1 · blocked by delivery-recovery 1",
    "Counts: tasks 2, integrated 1, members 3, round 1, checks 2, recoveries 1, decisionsByOwner 0, decisionsByCoordinator 0, steering 0, permissionEscalations 0, continuations 0",
    "Rounds: total 3, attributed 2, unattributed 1, unknown 0",
    "Attempts: integrated 2, stalled 1",
    "Implementers:",
    cellLine!,
    "Members without a task: 3",
    "Cost: tokens 1400 over 2 of 4 sessions · spent $0.50 · 1 without a session",
  ]);
});

test("import lines name refused lines and count the rest", () => {
  const outcome = (line: number, value: LegacyLineOutcome) => ({ line, outcome: value });
  assert.deepEqual(legacyImportLines({
    dryRun: false,
    lines: [outcome(1, "imported"), outcome(2, "changed"), outcome(3, "repeated"), outcome(5, "conflict"), outcome(6, "superseded"), outcome(7, "expired")],
    removed: 1, batches: 1,
  }), ["Line 2: changed", "Line 5: conflict", "Imported 1, repeated 1, superseded 1, expired 1, refused 2, removed 1."]);

  const oneBatch = legacyImportLines({ dryRun: true, lines: [outcome(1, "imported")], removed: 0, batches: 1 });
  assert.equal(oneBatch.length, 1);
  assert.ok(oneBatch[0]!.startsWith("Dry run, nothing was written: Imported"), oneBatch[0]);
  assert.ok(!oneBatch[0]!.includes("on its own"), oneBatch[0]);

  const twoBatches = legacyImportLines({ dryRun: true, lines: [outcome(1, "imported")], removed: 0, batches: 2 });
  assert.ok(twoBatches.at(-1)!.endsWith("A dry run checks each batch of 50 lines on its own."), twoBatches.at(-1));
});
