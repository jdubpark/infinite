import assert from "node:assert/strict";
import test from "node:test";
import { wilsonInterval } from "../packages/host/src/scorecard.js";
import { scorecardFromRows } from "../packages/host/src/scorecard.js";
import type { CostLookup, SessionCost } from "../packages/host/src/outcome-cells.js";
import type { OutcomePayload, OutcomeRow } from "../packages/host/src/outcome-store.js";
import { exclusionOf, type Disposition, type Flag, type Level } from "../packages/host/src/outcome-rules.js";

const FROZEN = "2026-11-01T00:00:00.000Z";

/** One outcome row. Every required field is filled; the overrides win. The exclusion follows the disposition. */
function row(
  overrides: Partial<Omit<OutcomeRow, "payload">> & { payload?: Partial<OutcomePayload> } = {},
): OutcomeRow {
  const { payload: payloadOverrides, ...rest } = overrides;
  const disposition: Disposition = rest.disposition ?? "integrated";
  const payload: OutcomePayload = {
    projectId: "p",
    taskId: "t",
    area: "a",
    featureMap: "default",
    rounds: { run: 0, attributed: 0, unknown: 0 },
    limitEvents: 0,
    costCoverage: "none",
    ...payloadOverrides,
  };
  return {
    outcomeId: "o",
    source: "production",
    projectRef: "pref",
    taskRef: "tref",
    areaRef: "aref",
    runId: "r",
    revision: 1,
    memberId: "m",
    sessionId: null,
    attemptIndex: 0,
    inherited: false,
    role: "implementer",
    profileId: "light",
    provider: "claude",
    model: "model-a",
    effort: null,
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: "low",
    featureVersion: 1,
    disposition,
    exclusion: exclusionOf(disposition) ?? null,
    flags: [] as Flag[],
    integrated: null as Level,
    accepted: null as Level,
    firstPass: null as Level,
    held: null as Level,
    startedAt: null,
    endedAt: null,
    frozenAt: FROZEN,
    holdUntil: null,
    runDeletedAt: null,
    ...rest,
    payload,
  };
}

let sequence = 0;

/** An implementer attempt that integrated: integrated yes. Each call gets its own session and member. */
function integratedRow(overrides: Partial<Omit<OutcomeRow, "payload">> & { payload?: Partial<OutcomePayload> } = {}): OutcomeRow {
  sequence += 1;
  return row({
    sessionId: `session-${sequence}`,
    memberId: `member-${sequence}`,
    disposition: "integrated",
    integrated: 1,
    accepted: 1,
    firstPass: 1,
    held: 0,
    frozenAt: FROZEN,
    ...overrides,
  });
}

/** An implementer attempt that stalled: integrated no, and counted. */
function stalledRow(overrides: Partial<Omit<OutcomeRow, "payload">> & { payload?: Partial<OutcomePayload> } = {}): OutcomeRow {
  sequence += 1;
  return row({
    sessionId: `session-${sequence}`,
    memberId: `member-${sequence}`,
    disposition: "stalled",
    integrated: 0,
    accepted: 0,
    firstPass: 0,
    held: 0,
    ...overrides,
  });
}

const label = () => undefined;

function scorecardOf(rows: OutcomeRow[], options: { cost?: CostLookup; minAttempts?: number; role?: string } = {}) {
  return scorecardFromRows(rows, { role: options.role ?? "implementer", label, ...options });
}

test("Wilson interval and tiny samples retain interval without suggestion", () => {
  assert.deepEqual(wilsonInterval(8, 10)?.map(value => Number(value.toFixed(2))), [0.49, 0.94]);
  const cost: CostLookup = () => ({ usd: 1, tokens: 100, complete: true });
  const card = scorecardOf(
    [
      integratedRow({ profileId: "cheap", provider: "opencode" }),
      integratedRow({ profileId: "costly", provider: "opencode" }),
    ],
    { cost },
  );
  const cheap = card.rows.find(entry => entry.profileId === "cheap")!;
  assert.equal(cheap.enough, false);
  assert.ok(cheap.rateInterval);
  assert.deepEqual(card.suggestions, []);
});

test("counted attempts leave open and excluded rows out", () => {
  const card = scorecardOf([
    integratedRow({ profileId: "light" }),
    integratedRow({ profileId: "light" }),
    stalledRow({ profileId: "light" }),
    row({ profileId: "light", disposition: "owner-stop" }),
    row({ profileId: "light", disposition: "limit" }),
    row({ profileId: "light", disposition: "open" }),
  ]);
  assert.equal(card.rows.length, 1);
  const light = card.rows[0]!;
  assert.equal(light.attempts, 3);
  assert.equal(light.integrated, 2);
  assert.equal(light.rate, 2 / 3);
  assert.deepEqual(light.rateInterval, wilsonInterval(2, 3));
  assert.deepEqual(light.excluded, { limit: 1, owner: 1, host: 0, duel: 0 });
  assert.deepEqual(card.sources, ["production"]);
});

test("metered medians use complete costs of integrated rows", () => {
  const sessions = new Map<string, SessionCost>([
    ["s1", { usd: 0.002, tokens: 1504, complete: true }],
    ["s2", { usd: 0.9, tokens: 9000, complete: false }],
    ["s4", { usd: 0.5, tokens: 700, complete: true }],
    ["c1", { usd: 0.1, tokens: 500, complete: true }],
  ]);
  const card = scorecardOf(
    [
      integratedRow({ profileId: "metered", provider: "opencode", sessionId: "s1" }),
      integratedRow({ profileId: "metered", provider: "opencode", sessionId: "s2" }),
      integratedRow({ profileId: "metered", provider: "opencode", sessionId: "s3" }),
      stalledRow({ profileId: "metered", provider: "opencode", sessionId: "s4" }),
      integratedRow({ profileId: "subscription", provider: "codex", sessionId: "c1" }),
    ],
    { cost: id => sessions.get(id) },
  );
  const metered = card.rows.find(entry => entry.profileId === "metered")!;
  assert.equal(metered.metered, true);
  assert.equal(metered.medianUsd, 0.002);
  assert.equal(metered.medianTokens, 1504);
  assert.equal(metered.usdPerMTok, 0.002 / 1504 * 1_000_000);
  const subscription = card.rows.find(entry => entry.profileId === "subscription")!;
  assert.equal(subscription.metered, false);
  assert.equal(subscription.medianUsd, null);
  assert.equal(subscription.medianTokens, null);
});

test("rounds, rubric, ratings, and minutes come from integrated rows", () => {
  const rubric = (correctness: number) => ({ version: 1 as const, correctness, cleanliness: 4, extensibility: 4, docs: 4, reviewerProfileId: "reviewer" });
  const first = integratedRow({
    profileId: "rated",
    startedAt: "2026-11-01T00:00:00.000Z",
    endedAt: "2026-11-01T00:30:00.000Z",
    payload: { rounds: { run: 0, attributed: 0, unknown: 0 }, rubric: rubric(4), ownerRating: { score: 5, at: FROZEN } },
  });
  const second = integratedRow({
    profileId: "rated",
    startedAt: "2026-11-02T00:00:00.000Z",
    endedAt: "2026-11-02T00:10:00.000Z",
    payload: { rounds: { run: 2, attributed: 0, unknown: 0 }, rubric: rubric(2), ownerRating: { score: 3, at: FROZEN } },
  });
  const stalled = stalledRow({ profileId: "rated", payload: { rounds: { run: 5, attributed: 0, unknown: 0 } } });
  const card = scorecardOf([first, second, stalled]);
  const rated = card.rows[0]!;
  assert.equal(rated.meanReviewRounds, 1);
  assert.equal(rated.rubric?.correctness, 3);
  assert.equal(rated.rubric?.n, 2);
  assert.deepEqual(rated.owner, { mean: 4, n: 2 });
  assert.equal(rated.medianMinutes, 20);

  const withoutEnd = integratedRow({ profileId: "rated", startedAt: "2026-11-03T00:00:00.000Z", endedAt: null });
  const withMissingEnd = scorecardOf([first, second, stalled, withoutEnd]).rows[0]!;
  assert.equal(withMissingEnd.medianMinutes, 20, "An integrated row with no end time is left out of minutes only");
  assert.equal(withMissingEnd.integrated, 3);
});

test("one row per profile id, newest epoch only", () => {
  const oldEpoch = [1, 2, 3].map(() => integratedRow({ profileId: "fast", profileEpoch: 1, endedAt: "2026-11-01T00:00:00.000Z" }));
  const newEpoch = [1, 2].map(() => integratedRow({ profileId: "fast", profileEpoch: 2, endedAt: "2026-11-10T00:00:00.000Z" }));
  const card = scorecardOf([...oldEpoch, ...newEpoch]);
  assert.equal(card.rows.length, 1);
  assert.equal(card.rows[0]!.attempts, 2);

  const modelA = [1, 2].map(() => integratedRow({ profileId: "fast", model: "model-a", endedAt: "2026-11-01T00:00:00.000Z" }));
  const modelB = [integratedRow({ profileId: "fast", model: "model-b", endedAt: "2026-11-05T00:00:00.000Z" })];
  const switched = scorecardOf([...modelA, ...modelB]);
  assert.equal(switched.rows.length, 1);
  assert.equal(switched.rows[0]!.attempts, 1, "The model that ran later is the only one counted");
});

test("profiles with nothing counted are left out", () => {
  const card = scorecardOf([
    row({ profileId: "idle", disposition: "open" }),
    row({ profileId: "idle", disposition: "open" }),
    row({ profileId: "gone", disposition: "owner-stop" }),
    row({ profileId: "gone", disposition: "host-stop" }),
    integratedRow({ profileId: "default" }),
    integratedRow({ profileId: "unknown" }),
  ]);
  assert.deepEqual(card.rows, []);
});

test("a scout's rate is its completed share", () => {
  const completed = () => row({ role: "scout", profileId: "scout", disposition: "completed" });
  const card = scorecardOf([completed(), completed(), completed(), row({ role: "scout", profileId: "scout", disposition: "stalled" })], { role: "scout" });
  assert.equal(card.rows.length, 1);
  assert.equal(card.rows[0]!.integrated, 3);
  assert.equal(card.rows[0]!.attempts, 4);
  assert.equal(card.rows[0]!.rate, 0.75);
});

test("other sources and roles are dropped", () => {
  const base = [integratedRow({ profileId: "light" })];
  const withExtras = [
    ...base,
    row({ profileId: "light", source: "duel", disposition: "integrated", integrated: 1 }),
    row({ profileId: "light", role: "scout", disposition: "completed" }),
  ];
  assert.deepEqual(scorecardOf(withExtras).rows, scorecardOf(base).rows);
  assert.deepEqual(scorecardOf(base, { role: "reviewer" }).rows, []);
});

test("labels come from the lookup", () => {
  const card = scorecardFromRows([integratedRow({ profileId: "light" }), integratedRow({ profileId: "other" })], {
    role: "implementer",
    label: id => (id === "light" ? "Light" : undefined),
  });
  assert.deepEqual(card.rows.map(entry => entry.label), ["Light", "other"]);
});

test("suggestions keep today's rule", () => {
  const cheap = Array.from({ length: 10 }, () => integratedRow({ profileId: "cheap", provider: "opencode" }));
  const costly = [
    ...Array.from({ length: 9 }, () => integratedRow({ profileId: "costly", provider: "opencode" })),
    stalledRow({ profileId: "costly", provider: "opencode" }),
  ];
  const cost: CostLookup = id => {
    const usd = id.startsWith("session") && costly.some(entry => entry.sessionId === id) ? 0.8 : 0.2;
    return { usd, tokens: 1000, complete: true };
  };
  const card = scorecardOf([...cheap, ...costly], { cost });
  assert.equal(card.suggestions.length, 1);
  assert.match(card.suggestions[0]!.text, /cheap integrated 10\/10 implementer tasks/);
  assert.equal(card.suggestions[0]!.comparedTo, "costly");
  assert.deepEqual(card.suggestions[0]!.n, [10, 10]);
});

test("enough needs ten counted attempts", () => {
  const nine = scorecardOf(Array.from({ length: 9 }, () => integratedRow({ profileId: "light" })));
  assert.equal(nine.minAttempts, 10);
  assert.equal(nine.rows[0]!.enough, false);
  const ten = scorecardOf(Array.from({ length: 10 }, () => integratedRow({ profileId: "light" })));
  assert.equal(ten.rows[0]!.enough, true);
});
