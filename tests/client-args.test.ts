import test from "node:test";
import assert from "node:assert/strict";
import { clientCommandCandidate, handleClientCommand, legacyImportLines, legacyRefusedLines, outcomeCellLines, outcomeRollupLines, parseClientArgs } from "../packages/host/src/client.js";
import type { OutcomeRollup } from "../packages/host/src/outcome-rollup.js";
import type { LegacyLineOutcome } from "../packages/host/src/outcome-legacy.js";
import type { CellsResult } from "../packages/host/src/outcome-reads.js";
import { DECISION_LIMIT, handleRoutingClientCommand, requestedRouting, routingExplainLines, routingStatusLines } from "../packages/host/src/routing-cli.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { PROJECT_DECISION_LIMIT } from "../packages/host/src/routing-store.js";
import type { CandidateRecord, ExplainedDecision, RoutingExplain, RoutingPayload, RoutingStatus } from "../packages/host/src/routing-types.js";

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

test("refused lines are named on their own", () => {
  const outcome = (line: number, value: LegacyLineOutcome) => ({ line, outcome: value });
  assert.deepEqual(legacyRefusedLines([outcome(1, "imported"), outcome(2, "changed"), outcome(3, "repeated"), outcome(5, "conflict")]), ["Line 2: changed", "Line 5: conflict"]);
  assert.deepEqual(legacyRefusedLines([outcome(1, "imported"), outcome(2, "repeated")]), []);
});

const routingProfile = { profileId: "ops-light", rows: { production: 0, duel: 0 }, earlier: { mass: 0, rows: 0, appliedMass: 0 }, mean: 0.5, interval: [0.3, 0.7], rescue: 0.5, level: "none", costUsd: 0.4, greedy: true };
const routingRemoved = { profileId: "review-strong", removed: "contributor", rows: { production: 0, duel: 0 }, earlier: { mass: 0, rows: 0, appliedMass: 0 }, mean: 0, interval: [0, 0], rescue: 0, level: "none", costUsd: 2.2, greedy: false };
const routingStatusFixture = (overrides: Partial<RoutingStatus> = {}): RoutingStatus => ({
  projectId: "alpha", mode: "shadow", requested: "shadow", source: "saved", modeSource: "saved",
  knobs: { points: ["start"], cascade: false, successValueUsd: 2, maxExploreShare: 0.2, exploreWindow: 50, minSpareAttempts: 4, allowContributor: false, listWeight: 0.25, headroomWeight: 1 },
  defaults: ["successValueUsd", "listWeight"],
  covers: { start: true, reason: null },
  costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" },
  headroom: "not-modelled", interval: "normal-approx-90", chosenWeight: 0.5, limits: "not-applied",
  shadow: { windowDays: 30, decisions: 3, withCoordinator: 0, agreements: 0, greedyAgreements: 0, capped: false },
  explore: { exploratory: 1, of: 3, guards: "risk-only" },
  period: { decisions: 3, capped: false, firstAt: "2026-11-14T10:00:00.000Z", targetDays: 14, targetDecisions: 50 },
  cells: [
    { cell: { scope: "cell", area: "api\x07x", taskKind: null, featureVersion: 1, featureMap: "default" }, profiles: [routingProfile, routingRemoved] as never },
    { cell: { scope: "new-task" }, profiles: [routingProfile] as never },
  ],
  cellsCapped: false, unreadableCells: 0,
  ...overrides,
} as RoutingStatus);

test("routing lines show unknown, never zero", () => {
  assert.deepEqual(routingStatusLines(routingStatusFixture()), [
    "alpha · routing shadow (saved)",
    "Value $2 per success (default) · list weight 0.25 (default) · contributor profiles not allowed",
    "Start: covered",
    "Shadow, last 30 days: 3 decisions; no decision had a coordinator pick",
    "Shadow period: 3 of 50 decisions since 2026-11-14T10:00:00.000Z; it ends after 14 days and 50 decisions, whichever is later.",
    "Would explore: 1 of 3, before the share, budget, and headroom guards.",
    "Costs are tier defaults: light $0.40, strong $2.20, rescue $1.50. Limit headroom is not modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.",
    "Cell api x · no kind · features v1 default",
    "  ops-light  mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 0 (0 rows) · level none · $0.40 · greedy",
    "  review-strong  removed: contributor",
    "New task (project level)",
    "  ops-light  mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 0 (0 rows) · level none · $0.40 · greedy",
  ]);
  const capped = routingStatusLines(routingStatusFixture({
    cells: [{ cell: { scope: "new-task" }, profiles: [{ ...routingProfile, earlier: { rows: 40, mass: 20, appliedMass: 10 } }] as never }],
  } as Partial<RoutingStatus>));
  assert.ok(capped.includes("  ops-light  mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 10 of 20 applied (40 rows) · level none · $0.40 · greedy"));
  const withCoordinator = routingStatusLines(routingStatusFixture({
    requested: "auto", shadow: { windowDays: 30, decisions: 3, withCoordinator: 3, agreements: 2, greedyAgreements: 1, capped: true },
    period: { decisions: 0, capped: false, firstAt: null, targetDays: 14, targetDecisions: 50 }, cellsCapped: true, unreadableCells: 2,
  } as Partial<RoutingStatus>));
  assert.equal(withCoordinator[0], "alpha · routing shadow (saved) · requested auto: auto starts after the shadow period");
  const uncovered = { covers: { start: false, reason: "no-eligible-profile" } } as Partial<RoutingStatus>;
  assert.equal(routingStatusLines(routingStatusFixture({ requested: "auto", ...uncovered }))[0], "alpha · routing shadow (saved) · requested auto");
  assert.equal(routingStatusLines(routingStatusFixture({ source: "autonomous-default", modeSource: "autonomous-default", ...uncovered }))[0], "alpha · routing shadow (autonomous default)");
  assert.equal(withCoordinator[3], "Shadow, last 30 days: 3 decisions; the router matched the coordinator in 2 of 3 (newest 500)");
  assert.equal(withCoordinator[4], "Shadow period: no decision yet.");
  const off = routingStatusLines(routingStatusFixture({ mode: "off", requested: null, source: null, knobs: null, defaults: [], covers: { start: false, reason: "off" }, cells: [] } as Partial<RoutingStatus>));
  assert.equal(off[0], "alpha · routing off");
  assert.equal(off[1], "Start: not covered (off)");
  assert.equal(routingStatusLines(routingStatusFixture({ cells: [] } as Partial<RoutingStatus>)).at(-1), "Costs are tier defaults: light $0.40, strong $2.20, rescue $1.50. Limit headroom is not modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.");
  assert.deepEqual(routingStatusLines(routingStatusFixture({ cells: [], unreadableCells: 2, cellsCapped: true } as Partial<RoutingStatus>)).slice(-2), ["Older cells are not shown.", "Cells with unreadable details: 2."]);
});

const explainDecision = (overrides: Partial<ExplainedDecision> = {}): ExplainedDecision => ({
  key: "k", runId: "11111111-1111-4111-8111-111111111111", revision: 1, point: "start", ordinal: 1, role: "implementer",
  kind: null, risk: "normal", featureVersion: 1, mode: "shadow", algorithmVersion: 1, rewardVersion: 1,
  policyDigest: "abcdef0123456789abcd", seed: "0123456789abcdef", basis: "sampled", chosenProfileId: "ops-light", chosenIdentity: "codex/gpt/high",
  greedyProfileId: "ops-light", coordinatorProfileId: null, explore: false, state: "recorded", memberId: null, decidedAt: "2026-11-14T10:00:00.000Z",
  payload: null, ...overrides,
});
const explainPayload = (candidates: CandidateRecord[]): RoutingPayload => ({
  projectId: "alpha", taskId: "t1", area: "api", featureMap: "default", coordinatorProfileId: null, knobs: ROUTING_DEFAULTS,
  costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5, current: [], candidates, elapsedMs: 3,
});
const explainAnswer = (decisions: ExplainedDecision[]): RoutingExplain => ({ runId: "11111111-1111-4111-8111-111111111111", taskId: "t1", decisions, capped: false });

test("routing explain lines show the decision, its payload, and an unreadable payload", () => {
  const payload = explainPayload([
    { profileId: "ops-light", identity: "codex/gpt/high", tier: "light", thetaMean: 0.5, thetaSd: 0.1, phiMean: 0.5, costUsd: 0.4, greedyUtility: 0.9, sample: 0.7, sampledUtility: 0.8 },
    { profileId: "review-strong", identity: "codex/gpt/max", tier: null, removed: "contributor" },
    { profileId: "third", identity: "opencode/x/y", tier: null },
  ]);
  assert.deepEqual(routingExplainLines(explainAnswer([explainDecision({ payload })])), [
    "Revision 1 · start 1 · shadow · recorded · basis sampled · decided 2026-11-14T10:00:00.000Z",
    "Chosen ops-light · greedy ops-light · coordinator none · explore no",
    "Policy abcdef012345 · seed 0123456789ab · algorithm 1 · reward 1",
    "  ops-light  mean 0.5 · deviation 0.1 · rescue 0.5 · cost $0.40 · greedy utility 0.9 · sample 0.7 · sampled utility 0.8",
    "  review-strong  removed: contributor",
    "  third  mean unknown · deviation unknown · rescue unknown · cost unknown · greedy utility unknown · sample unknown · sampled utility unknown",
  ]);
  assert.deepEqual(routingExplainLines(explainAnswer([explainDecision({ explore: true, coordinatorProfileId: "ops-light" })])), [
    "Revision 1 · start 1 · shadow · recorded · basis sampled · decided 2026-11-14T10:00:00.000Z",
    "Chosen ops-light · greedy ops-light · coordinator ops-light · explore yes",
    "Policy abcdef012345 · seed 0123456789ab · algorithm 1 · reward 1",
    "The decision's details are unreadable.",
  ]);
});

test("routing explain rounds its floats to three decimals, as status does", () => {
  const lines = routingExplainLines(explainAnswer([explainDecision({ payload: explainPayload([
    { profileId: "ops-light", identity: "codex/gpt/high", tier: "light", thetaMean: 0.123456, thetaSd: 0.0987654, phiMean: 0.55551, costUsd: 0.4, greedyUtility: 0.91234, sample: 0.7777, sampledUtility: 0.80001 },
  ]) })]));
  assert.equal(lines[3], "  ops-light  mean 0.123 · deviation 0.099 · rescue 0.556 · cost $0.40 · greedy utility 0.912 · sample 0.778 · sampled utility 0.8");
});

test("routing lines clean every host text they print: the reason, the removal, the level, and the explain fields", () => {
  const status = routingStatusLines(routingStatusFixture({
    covers: { start: false, reason: "no-lineup\x07" } as never,
    source: "saved",
    cells: [{ cell: { scope: "new-task" }, profiles: [
      { ...routingProfile, level: "cell\x9b" },
      { ...routingRemoved, profileId: "review\x1bstrong", removed: "contributor\x07" },
    ] as never }],
  } as Partial<RoutingStatus>));
  assert.equal(status[2], "Start: not covered (no-lineup )");
  assert.equal(status[status.length - 2], "  ops-light  mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 0 (0 rows) · level cell  · $0.40 · greedy");
  assert.equal(status[status.length - 1], "  review strong  removed: contributor ");
  const explain = routingExplainLines(explainAnswer([explainDecision({
    mode: "shadow\x1b", state: "recorded\x9b", basis: "sampled\x07",
    payload: explainPayload([{ profileId: "x", identity: "i", tier: null, removed: "limited\x07" }]),
  })]));
  assert.equal(explain[0], "Revision 1 · start 1 · shadow  · recorded  · basis sampled  · decided 2026-11-14T10:00:00.000Z");
  assert.equal(explain[3], "  x  removed: limited ");
  const period = routingStatusLines(routingStatusFixture({
    period: { ...routingStatusFixture().period, firstAt: "2026-11-14T10:00:00.000Z\x07" },
  } as Partial<RoutingStatus>)).find(line => line.startsWith("Shadow period:"));
  assert.ok(period?.includes("since 2026-11-14T10:00:00.000Z ;"), period);
  assert.ok(!period?.includes("\x07"), "the period's first decision time is cleaned");
});

test("the newest-decisions cap is the store's limit", () => {
  assert.equal(DECISION_LIMIT, PROJECT_DECISION_LIMIT);
});

test("routing lines: the other branch of each line, and clean on every id", () => {
  const knobs = routingStatusFixture().knobs!;
  const lines = routingStatusLines(routingStatusFixture({
    source: "autonomous-default", modeSource: "autonomous-default", defaults: ["allowContributor"], knobs: { ...knobs, allowContributor: true },
    shadow: { windowDays: 30, decisions: 500, withCoordinator: 0, agreements: 0, greedyAgreements: 0, capped: true },
    cells: [{ cell: { scope: "cell", area: "api", taskKind: "feature", featureVersion: 2, featureMap: "0123456789abcdef".repeat(4) },
      profiles: [{ ...routingProfile, profileId: "ops\x1blight\x9b", greedy: false }, routingProfile] as never }],
  } as Partial<RoutingStatus>));
  assert.equal(lines[0], "alpha · routing shadow (autonomous default) · auto starts after the shadow period");
  assert.equal(lines[1], "Value $2 per success · list weight 0.25 · contributor profiles allowed (default)");
  assert.equal(lines[3], "Shadow, last 30 days: 500 decisions; no decision had a coordinator pick (newest 500)");
  assert.deepEqual(lines.slice(7), [
    "Cell api · feature · features v2 0123456789ab",
    "  ops light   mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 0 (0 rows) · level none · $0.40",
    "  ops-light  mean 0.5 [0.3, 0.7] · rescue 0.5 · rows production 0, duel 0 · earlier mass 0 (0 rows) · level none · $0.40 · greedy",
  ]);
});

test("routing explain lines: the shape the host answers, a sampler fallback, and clean on the chosen and candidate ids", () => {
  const run = "11111111-1111-4111-8111-111111111111";
  const explain: RoutingExplain = { runId: run, taskId: "t1", capped: false, decisions: [{
    key: "a".repeat(64), runId: run, revision: 2, point: "start", ordinal: 1, role: "implementer", kind: "feature", risk: "normal", featureVersion: 1,
    mode: "shadow", algorithmVersion: 1, rewardVersion: 1, policyDigest: "d".repeat(64), seed: "e".repeat(64), basis: "sampled",
    chosenProfileId: "ops\x07light", chosenIdentity: "b".repeat(64), greedyProfileId: "ops\x07light", coordinatorProfileId: null, explore: false,
    state: "recorded", memberId: null, decidedAt: "2026-11-14T10:00:00.000Z",
    payload: { projectId: "alpha", taskId: "t1", area: "api", featureMap: "default", coordinatorProfileId: null, knobs: ROUTING_DEFAULTS,
      costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5, current: [], elapsedMs: 3,
      candidates: [{ profileId: "ops\x9blight", identity: "b".repeat(64), tier: "light", costUsd: 0.4, thetaMean: 0.5, thetaSd: 0.1, phiMean: 0.5,
        greedyUtility: 0.9, sample: 0.7, sampledUtility: 0.8, samplerFallback: true }] },
  }] };
  const lines = routingExplainLines(explain);
  assert.equal(lines[0], "Revision 2 · start 1 · shadow · recorded · basis sampled · decided 2026-11-14T10:00:00.000Z");
  assert.equal(lines[1], "Chosen ops light · greedy ops light · coordinator none · explore no");
  assert.equal(lines[3], "  ops light  mean 0.5 · deviation 0.1 · rescue 0.5 · cost $0.40 · greedy utility 0.9 · sample 0.7 · sampled utility 0.8 · sampler fallback");
});

test("the routing command refuses bad usage before any request, and maps or passes the other host errors", async () => {
  const usage = "Usage: infinite routing status PROJECT [--json] | infinite routing explain RUN_ID TASK_ID [--json] | infinite routing pause-explore PROJECT [--json] | infinite routing resume-explore PROJECT [--json]";
  const run = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  const fake = (routes: Record<string, unknown>) => ({
    json: async (path: string) => { calls.push(path); const value = routes[path]; if (value instanceof Error) throw value; return value; },
  }) as unknown as Parameters<typeof handleRoutingClientCommand>[2];
  for (const args of [[], ["status"], ["status", "alpha", "beta"], ["explain", run], ["explain", run, "t1", "t2"], ["show", "alpha"]]) {
    await assert.rejects(handleRoutingClientCommand(args, {}, fake({})), { message: usage }, args.join(" "));
  }
  assert.deepEqual(calls, []);
  const withFlag = { teams: { routing: 1 } };
  const hostError = (status: number, code?: string) => Object.assign(new Error(`Host returned HTTP ${status}.`), { status, code });
  await assert.rejects(handleRoutingClientCommand(["explain", "not-a-uuid", "t1"], {}, fake({ "/me": withFlag, "/teams/not-a-uuid/routing/t1": hostError(400, "invalid-routing-request") })),
    { message: "The host refused the routing request as invalid." });
  const other = hostError(500);
  await assert.rejects(handleRoutingClientCommand(["status", "a/b"], {}, fake({ "/me": withFlag, "/routing/projects/a%2Fb": other })), error => error === other);
});

test("routing options parse", () => {
  const parsed = parseClientArgs(["repo", "init", "--routing", "shadow", "--routing-value", "quality", "--routing-contributor", "deny"]);
  assert.equal(parsed.options["--routing"], "shadow");
  assert.equal(parsed.options["--routing-value"], "quality");
  assert.equal(parsed.options["--routing-contributor"], "deny");
  assert.equal(clientCommandCandidate(["--json", "routing"]), "routing");
});

test("the routing command checks the host flag and prints the fixed sentences for host errors", async () => {
  const hostError = (status: number, code: string) => Object.assign(new Error(`Host returned HTTP ${status} (${code}).`), { status, code });
  const run = "11111111-1111-4111-8111-111111111111";
  const fake = (routes: Record<string, unknown>, calls: string[] = []) => ({
    json: async (path: string) => {
      calls.push(path);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    },
  }) as unknown as Parameters<typeof handleRoutingClientCommand>[2];
  const withFlag = { teams: { routing: 1 }, projects: [] };
  const logged: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
  try {
    const calls: string[] = [];
    await assert.rejects(handleRoutingClientCommand(["status", "alpha"], {}, fake({ "/me": { teams: {} } }, calls)), { message: "This host does not record routing decisions. Upgrade the host first." });
    assert.deepEqual(calls, ["/me"]);
    await assert.rejects(handleRoutingClientCommand(["status", "alpha"], {}, fake({ "/me": withFlag, "/routing/projects/alpha": hostError(404, "unknown-project") })), { message: "No project has this ID." });
    await assert.rejects(handleRoutingClientCommand(["status", "alpha"], {}, fake({ "/me": withFlag, "/routing/projects/alpha": hostError(503, "evidence-unavailable") })), { message: "The evidence store is unavailable." });
    await assert.rejects(handleRoutingClientCommand(["explain", run, "t1"], {}, fake({ "/me": withFlag, [`/teams/${run}/routing/t1`]: hostError(404, "routing-decision-not-found") })), { message: "No routing decision exists for this run and task." });
    await handleRoutingClientCommand(["status", "alpha"], { "--json": true }, fake({ "/me": withFlag, "/routing/projects/alpha": routingStatusFixture({ cells: [] } as Partial<RoutingStatus>) }));
    assert.equal(logged.at(-1), JSON.stringify(routingStatusFixture({ cells: [] } as Partial<RoutingStatus>), null, 2));
    logged.length = 0;
    await handleRoutingClientCommand(["status", "alpha"], {}, fake({ "/me": withFlag, "/routing/projects/alpha": routingStatusFixture() }));
    assert.equal(logged[0], "alpha · routing shadow (saved)");
  } finally {
    console.log = log;
  }
});

const autoPeriod = { decisions: 50, capped: false, firstAt: "2026-11-01T10:00:00.000Z", endsAt: "2026-11-15T10:00:00.000Z", endedAt: "2026-11-15T10:00:00.000Z", stored: true, targetDays: 14 as const, targetDecisions: 50 as const };

test("routing auto lines show the period, the pause, and the share", () => {
  const lines = routingStatusLines(routingStatusFixture({
    mode: "auto", requested: "auto", period: autoPeriod,
    explore: { exploratory: 1, of: 5, guards: "applied", pausedAt: null },
    share: { exploratory: 1, of: 5, window: 50, limit: 0.2 },
    auto: { windowDays: 30, pending: 2, applied: 3, released: 1, capped: true },
  } as Partial<RoutingStatus>));
  assert.equal(lines[0], "alpha · routing auto (saved)");
  assert.equal(lines[4], "Shadow period: ended 2026-11-15T10:00:00.000Z.");
  assert.equal(lines[5], "Explored: 1 of 5 auto start decisions in the last 30 days.");
  assert.equal(lines[6], "Exploration share: 1 of the last 5 pending or applied starts; the limit is 0.2 of 50.");
  assert.equal(lines[7], "Auto starts, last 30 days: 2 pending, 3 applied, 1 released. (newest 500)");
  assert.equal(lines[9], "The router's applied choices count at full weight.");
  const uncapped = routingStatusLines(routingStatusFixture({
    mode: "auto", requested: "auto", period: autoPeriod, share: { exploratory: 0, of: 0, window: 50, limit: 0.2 },
    explore: { exploratory: 0, of: 0, guards: "applied", pausedAt: null }, auto: { windowDays: 30, pending: 0, applied: 0, released: 0, capped: false },
  } as Partial<RoutingStatus>));
  assert.ok(uncapped.includes("Exploration share: no auto start decision yet."), uncapped.join("\n"));
  assert.ok(uncapped.includes("Auto starts, last 30 days: 0 pending, 0 applied, 0 released."), uncapped.join("\n"));
});

test("a pause prints its line in both modes, and the autonomous default names itself", () => {
  const paused = "2026-11-16T09:00:00.000Z";
  const shadowPaused = routingStatusLines(routingStatusFixture({ explore: { exploratory: 1, of: 3, guards: "risk-only", pausedAt: paused } } as Partial<RoutingStatus>));
  assert.ok(shadowPaused.includes(`Exploration paused since ${paused}.`), shadowPaused.join("\n"));
  const autoPaused = routingStatusLines(routingStatusFixture({
    mode: "auto", requested: "auto", period: autoPeriod, share: { exploratory: 0, of: 0, window: 50, limit: 0.2 },
    explore: { exploratory: 0, of: 0, guards: "applied", pausedAt: paused }, auto: { windowDays: 30, pending: 0, applied: 0, released: 0, capped: false },
  } as Partial<RoutingStatus>));
  assert.ok(autoPaused.includes(`Exploration paused since ${paused}.`), autoPaused.join("\n"));

  const endedDefault = routingStatusLines(routingStatusFixture({ source: "autonomous-default", modeSource: "autonomous-default", period: { ...autoPeriod, stored: false } } as Partial<RoutingStatus>));
  assert.equal(endedDefault[0], "alpha · routing shadow (autonomous default) · auto starts after the shadow period");
  assert.equal(endedDefault[4], "Shadow period: ended 2026-11-15T10:00:00.000Z.", "the autonomous default never says --routing auto is needed");
  const endedSaved = routingStatusLines(routingStatusFixture({ period: autoPeriod } as Partial<RoutingStatus>));
  assert.equal(endedSaved[4], "Shadow period: ended 2026-11-15T10:00:00.000Z. Auto routing needs --routing auto.");
  const savedNoMode = routingStatusLines(routingStatusFixture({ source: "saved", modeSource: "autonomous-default", period: autoPeriod } as Partial<RoutingStatus>));
  assert.equal(savedNoMode[0], "alpha · routing shadow (autonomous default) · auto starts after the shadow period");
  assert.equal(savedNoMode[4], "Shadow period: ended 2026-11-15T10:00:00.000Z.", "a saved policy without a mode never asks for --routing auto");
  const autoNoMode = routingStatusLines(routingStatusFixture({
    mode: "auto", requested: "shadow", source: "saved", modeSource: "autonomous-default", period: autoPeriod,
    share: { exploratory: 0, of: 0, window: 50, limit: 0.2 }, explore: { exploratory: 0, of: 0, guards: "applied", pausedAt: null },
    auto: { windowDays: 30, pending: 0, applied: 0, released: 0, capped: false },
  } as Partial<RoutingStatus>));
  assert.equal(autoNoMode[0], "alpha · routing auto (autonomous default)");
});

test("requested routing accepts auto and keeps the step-1 checks", () => {
  assert.deepEqual(requestedRouting({ "--routing": "auto" }), { mode: "auto" });
  assert.deepEqual(requestedRouting({ "--routing": "shadow" }), { mode: "shadow" });
  assert.deepEqual(requestedRouting({ "--routing": "off" }), { mode: "off" });
  assert.throws(() => requestedRouting({ "--routing": "on" }), { message: "--routing must be off, shadow, or auto." });
  assert.equal(requestedRouting({}), undefined);
  assert.deepEqual(requestedRouting({ "--routing-value": "cost" }), { successValueUsd: 0.5 });
  assert.deepEqual(requestedRouting({ "--routing-value": "12.5" }), { successValueUsd: 12.5 });
  assert.throws(() => requestedRouting({ "--routing-value": "101" }), { message: "--routing-value must be cost, balanced, quality, or a dollar value from 0 to 100." });
  assert.deepEqual(requestedRouting({ "--routing-contributor": "allow" }), { allowContributor: true });
  assert.throws(() => requestedRouting({ "--routing-contributor": "maybe" }), { message: "--routing-contributor must be allow or deny." });
});

test("the routing command pauses and resumes exploration", async () => {
  const usage = "Usage: infinite routing status PROJECT [--json] | infinite routing explain RUN_ID TASK_ID [--json] | infinite routing pause-explore PROJECT [--json] | infinite routing resume-explore PROJECT [--json]";
  const paused = "2026-11-16T09:00:00.000Z";
  const posted: [string, unknown][] = [];
  const fake = (me: Record<string, unknown>, answers: Record<string, unknown> = {}) => ({
    json: async (path: string, body?: unknown) => {
      if (path === "/me") return me;
      posted.push([path, body]);
      return answers[path];
    },
  }) as unknown as Parameters<typeof handleRoutingClientCommand>[2];
  const withAuto = { teams: { routing: 1, routingAuto: 1 } };
  const logged: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
  try {
    await handleRoutingClientCommand(["pause-explore", "rehearsal"], {}, fake(withAuto, { "/routing/projects/rehearsal/explore/pause": { projectId: "rehearsal", explorePausedAt: paused } }));
    assert.deepEqual(posted, [["/routing/projects/rehearsal/explore/pause", {}]]);
    assert.equal(logged.at(-1), `Exploration paused for rehearsal since ${paused}.`);

    await handleRoutingClientCommand(["resume-explore", "rehearsal"], {}, fake(withAuto, { "/routing/projects/rehearsal/explore/resume": { projectId: "rehearsal", explorePausedAt: null } }));
    assert.equal(posted.at(-1)![0], "/routing/projects/rehearsal/explore/resume");
    assert.equal(logged.at(-1), "Exploration resumed for rehearsal.");

    const answer = { projectId: "rehearsal", explorePausedAt: paused };
    await handleRoutingClientCommand(["pause-explore", "rehearsal"], { "--json": true }, fake(withAuto, { "/routing/projects/rehearsal/explore/pause": answer }));
    assert.equal(logged.at(-1), JSON.stringify(answer, null, 2));

    posted.length = 0;
    await assert.rejects(handleRoutingClientCommand(["pause-explore", "rehearsal"], {}, fake({ teams: { routing: 1 } })), { message: "This host does not support exploration pauses. Upgrade the host first." });
    await assert.rejects(handleRoutingClientCommand(["resume-explore", "rehearsal"], {}, fake({ teams: { routing: 1 } })), { message: "This host does not support exploration pauses. Upgrade the host first." });
    assert.deepEqual(posted, [], "no pause or resume is posted to a host without the flag");

    for (const args of [["pause-explore"], ["resume-explore"], ["pause-explore", "a", "b"]]) {
      await assert.rejects(handleRoutingClientCommand(args, {}, fake(withAuto)), { message: usage }, args.join(" "));
    }
    assert.deepEqual(posted, []);
  } finally {
    console.log = log;
  }
});

test("explain prints the guards of an auto decision", () => {
  const guards = { pausedAt: "2026-11-16T09:00:00.000Z", spareAttempts: 3, share: { exploratory: 1, of: 4 } };
  const lines = routingExplainLines(explainAnswer([explainDecision({
    mode: "auto", state: "applied", payload: { ...explainPayload([]), guards },
  })]));
  assert.equal(lines[0], "Revision 1 · start 1 · auto · applied · basis sampled · decided 2026-11-14T10:00:00.000Z");
  assert.equal(lines[3], "Guards: pause since 2026-11-16T09:00:00.000Z · spare attempts 3 · share 1 of 4");
  const unpaused = routingExplainLines(explainAnswer([explainDecision({
    mode: "auto", state: "pending", payload: { ...explainPayload([]), guards: { ...guards, pausedAt: null } },
  })]));
  assert.equal(unpaused[3], "Guards: pause none · spare attempts 3 · share 1 of 4");
});

test("usage interrupted options parse", () => {
  const parsed = parseClientArgs(["usage", "interrupted", "--project", "proj-a", "--days", "14", "--json"]);
  assert.equal(parsed.command, "usage");
  assert.deepEqual(parsed.args, ["interrupted"]);
  assert.equal(parsed.options["--project"], "proj-a");
  assert.equal(parsed.options["--days"], "14");
  assert.equal(parsed.options["--json"], true);
});

test("routing status and explain lines reflect observed costs, modelled headroom, and candidate pressure", () => {
  const observed = routingStatusLines(routingStatusFixture({
    costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "observed" },
    headroom: "modelled",
    cells: [],
  } as Partial<RoutingStatus>));
  assert.equal(observed.at(-1), "Costs are observed list USD (rescue default $1.50). Limit headroom is modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.");

  const mixed = routingStatusLines(routingStatusFixture({
    costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "mixed" },
    headroom: "modelled",
    cells: [],
  } as Partial<RoutingStatus>));
  assert.equal(mixed.at(-1), "Costs use observed list USD where available; tier defaults: light $0.40, strong $2.20, rescue $1.50. Limit headroom is modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.");

  const withPressure = routingExplainLines(explainAnswer([explainDecision({
    payload: explainPayload([
      { profileId: "ops-light", identity: "codex/gpt/high", tier: "light", thetaMean: 0.5, thetaSd: 0.1, phiMean: 0.5, costUsd: 0.4, pressure: 0.625, greedyUtility: 0.2, sample: 0.7, sampledUtility: 0.3 },
      { profileId: "ops-calm", identity: "claude/sonnet/high", tier: "light", thetaMean: 0.5, thetaSd: 0.1, phiMean: 0.5, costUsd: 0.4, pressure: 0, greedyUtility: 0.9, sample: 0.7, sampledUtility: 0.8 },
    ]),
  })]));
  assert.equal(withPressure[3], "  ops-light  mean 0.5 · deviation 0.1 · rescue 0.5 · cost $0.40 · pressure 0.625 · greedy utility 0.2 · sample 0.7 · sampled utility 0.3");
  assert.equal(withPressure[4], "  ops-calm  mean 0.5 · deviation 0.1 · rescue 0.5 · cost $0.40 · greedy utility 0.9 · sample 0.7 · sampled utility 0.8");
});
