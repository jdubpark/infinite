import test from "node:test";
import assert from "node:assert/strict";
import {
  CellQueryRefused,
  buildCells,
  checkCellQuery,
  cellKey,
  median,
  levelCount,
  rowMinutes,
  rowTime,
  spread,
  wilsonInterval,
  type Cell,
  type CellQuery,
  type CostLookup,
} from "../packages/host/src/outcome-cells.js";
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

/** A counted implementer attempt that stalled: every level is no. */
function stalled(overrides: Partial<Omit<OutcomeRow, "payload">> & { payload?: Partial<OutcomePayload> } = {}): OutcomeRow {
  return row({ disposition: "stalled", integrated: 0, accepted: 0, firstPass: 0, held: 0, ...overrides });
}

function query(overrides: Partial<CellQuery> = {}): CellQuery {
  return { use: "display", sources: ["production"], by: [], role: "implementer", ...overrides };
}

function only(cells: Cell[]): Cell {
  assert.equal(cells.length, 1);
  return cells[0]!;
}

test("statistics give exact numbers", () => {
  const [low, high] = wilsonInterval(7, 10)!;
  assert.equal(Number(low.toFixed(4)), 0.3968);
  assert.equal(Number(high.toFixed(4)), 0.8922);
  assert.equal(wilsonInterval(0, 0), null);

  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2, 4]), 2.5);

  assert.equal(spread([]), null);
  assert.deepEqual(spread([5]), { n: 1, median: 5, iqr: [5, 5] });
  assert.deepEqual(spread([4, 1, 3, 2]), { n: 4, median: 2.5, iqr: [1.75, 3.25] });
  assert.deepEqual(spread([5, 1, 4, 2, 3]), { n: 5, median: 3, iqr: [2, 4] });

  const counted = levelCount([1, 1, 0, null]);
  assert.equal(counted.yes, 2);
  assert.equal(counted.no, 1);
  assert.equal(counted.unknown, 1);
  assert.equal(counted.rate, 2 / 3);
  assert.deepEqual(counted.interval, wilsonInterval(2, 3));

  const onlyUnknown = levelCount([null]);
  assert.equal(onlyUnknown.rate, null);
  assert.equal(onlyUnknown.interval, null);
});

test("a query is refused in a fixed order", () => {
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error instanceof CellQueryRefused ? error.code : error;
    }
    return "no refusal";
  };
  assert.equal(
    refusal(() => checkCellQuery(query({ use: "decision", sources: ["production", "legacy"], by: ["profile"] }))),
    "legacy-in-decision",
  );
  assert.equal(
    refusal(() => checkCellQuery(query({ use: "decision", sources: ["production"], by: ["area"] }))),
    "decision-without-profile",
  );
  assert.equal(refusal(() => checkCellQuery(query({ sources: [] }))), "no-sources");
  // The source check comes first, so an empty source list in a decision with no profile reports no-sources.
  assert.equal(refusal(() => checkCellQuery(query({ use: "decision", sources: [], by: [] }))), "no-sources");
  assert.equal(refusal(() => checkCellQuery(query({ sources: ["legacy"], by: [] }))), "no refusal");
});

test("display counts every row once", () => {
  const rows = [
    row({ disposition: "open" }),
    row({ disposition: "limit" }),
    row({ disposition: "owner-stop" }),
    row({ disposition: "host-stop" }),
    stalled(),
    row({ integrated: 1, accepted: 1, firstPass: 1, held: null }),
    row({ integrated: 1, accepted: null, firstPass: null, held: null }),
    stalled({ flags: ["backfilled"] }),
  ];
  const cell = only(buildCells(rows, query({ by: ["profile"] })));
  assert.equal(cell.attempts, 4);
  assert.equal(cell.open, 1);
  assert.deepEqual(cell.excluded, { limit: 1, owner: 1, host: 1, duel: 0 });
  assert.deepEqual(cell.withheld, { backfilled: 0, gap: 0, unfrozen: 0 });
  assert.deepEqual(
    { yes: cell.levels.integrated.yes, no: cell.levels.integrated.no, unknown: cell.levels.integrated.unknown, rate: cell.levels.integrated.rate },
    { yes: 2, no: 2, unknown: 0, rate: 0.5 },
  );
  assert.deepEqual(
    [cell.levels.accepted.yes, cell.levels.accepted.no, cell.levels.accepted.unknown],
    [1, 2, 1],
  );
  assert.deepEqual(
    [cell.levels.firstPass.yes, cell.levels.firstPass.no, cell.levels.firstPass.unknown],
    [1, 2, 1],
  );
  assert.deepEqual(
    [cell.levels.held.yes, cell.levels.held.no, cell.levels.held.unknown],
    [0, 2, 2],
  );
  assert.equal(cell.flagged.backfilled, 1);
  assert.equal(cell.enough, false);
});

test("a decision withholds what it cannot use", () => {
  const rows = [
    row({ disposition: "open" }),
    row({ disposition: "limit" }),
    row({ disposition: "owner-stop" }),
    row({ disposition: "host-stop" }),
    stalled(),
    row({ integrated: 1, accepted: 1, firstPass: 1, held: null }),
    row({ integrated: 1, accepted: null, firstPass: null, held: null, frozenAt: null }),
    stalled({ flags: ["backfilled"] }),
  ];
  const cell = only(buildCells(rows, query({ use: "decision", by: ["profile"] })));
  assert.equal(cell.attempts, 2);
  assert.deepEqual(cell.withheld, { backfilled: 1, gap: 0, unfrozen: 1 });
  assert.deepEqual(
    [cell.levels.accepted.yes, cell.levels.accepted.no, cell.levels.accepted.unknown],
    [1, 1, 0],
  );

  const gapCell = only(
    buildCells([row({ integrated: 1, accepted: 1, flags: ["gap"] })], query({ use: "decision", by: ["profile"] })),
  );
  assert.equal(gapCell.attempts, 0);
  assert.equal(gapCell.withheld.gap, 1);

  const openCell = only(
    buildCells([row({ disposition: "open", flags: ["backfilled"] })], query({ use: "decision", by: ["profile"] })),
  );
  assert.equal(openCell.open, 0);
  assert.equal(openCell.withheld.backfilled, 1);

  const reviewed = row({ integrated: 1, accepted: 1, firstPass: 1, held: 1, flags: ["same-model-review"] });
  const decisionCell = only(buildCells([reviewed], query({ use: "decision", by: ["profile"] })));
  assert.equal(decisionCell.levels.integrated.yes, 1);
  assert.equal(decisionCell.levels.accepted.unknown, 1);
  assert.equal(decisionCell.levels.firstPass.unknown, 1);
  assert.equal(decisionCell.levels.held.unknown, 1);
  assert.equal(decisionCell.flagged["same-model-review"], 1);
  const displayCell = only(buildCells([reviewed], query({ by: ["profile"] })));
  assert.equal(displayCell.levels.accepted.yes, 1);

  const unfrozenStalled = only(buildCells([stalled({ frozenAt: null })], query({ use: "decision", by: ["profile"] })));
  assert.equal(unfrozenStalled.attempts, 1);
  assert.deepEqual(unfrozenStalled.withheld, { backfilled: 0, gap: 0, unfrozen: 0 });
});

test("keys never merge epochs, identities, or maps", () => {
  const epochs = buildCells(
    [row({ profileEpoch: 1 }), row({ profileEpoch: 2 })],
    query({ by: ["profile"] }),
  );
  assert.deepEqual(epochs.map(cell => cell.key.epoch).sort(), ["1", "2"]);

  const identities = buildCells(
    [row({ profileId: "default", provider: "claude" }), row({ profileId: "default", provider: "codex" })],
    query({ by: ["profile"] }),
  );
  assert.equal(identities.length, 2);

  const maps = buildCells(
    [
      row({ payload: { projectId: "x", featureMap: "default" } }),
      row({ payload: { projectId: "x", featureMap: "abc" } }),
    ],
    query({ by: ["area"] }),
  );
  assert.equal(maps.length, 2);
  for (const cell of maps) {
    assert.ok("area" in cell.key);
    assert.ok("featureMap" in cell.key);
    assert.ok("featureVersion" in cell.key);
  }

  const kind = only(buildCells([row({ kind: null })], query({ by: ["kind"] })));
  assert.equal(kind.key.kind, "none");
  assert.equal(kind.key.featureVersion, "1");
  assert.equal("featureMap" in kind.key, false);

  const pooled = only(buildCells([row({ profileId: "a" }), row({ profileId: "b" })], query({ by: [] })));
  assert.deepEqual(pooled.key, {});
  assert.equal(pooled.attempts, 2);

  assert.equal(cellKey(row({ effort: null }), ["profile"]).effort, "none");
});

test("sources stay apart where C6 says", () => {
  const shared = only(
    buildCells(
      [row({ source: "production" }), row({ source: "duel" })],
      query({ sources: ["production", "duel"], by: ["profile"] }),
    ),
  );
  assert.deepEqual(shared.sources, ["duel", "production"]);

  const apart = buildCells(
    [row({ source: "legacy" }), row({ source: "replay" })],
    query({ sources: ["legacy", "replay"], by: [] }),
  );
  assert.equal(apart.length, 2);
  assert.deepEqual(apart.map(cell => cell.key.source).sort(), ["legacy", "replay"]);

  const production = only(
    buildCells([row({ source: "production" }), row({ source: "duel" })], query({ sources: ["production"], by: [] })),
  );
  assert.equal(production.attempts, 1);

  assert.equal(buildCells([row({ role: "scout", disposition: "completed" })], query({ by: [] })).length, 0);
});

test("cost spreads use complete costs only", () => {
  const costs: CostLookup = sessionId => {
    if (sessionId === "s1") return { usd: 0.5, tokens: 1000, complete: true };
    if (sessionId === "s2") return { usd: 0.2, tokens: 400, complete: false };
    return undefined;
  };
  const rows = (provider: string) => [
    row({ provider, sessionId: "s1" }),
    row({ provider, sessionId: "s2" }),
    row({ provider, sessionId: "s3" }),
    row({ provider, sessionId: null }),
  ];

  const metered = only(buildCells(rows("opencode"), query({ by: [] }), costs));
  assert.deepEqual(metered.tokens, { n: 1, median: 1000, iqr: [1000, 1000] });
  assert.deepEqual(metered.spentUsd, { n: 1, median: 0.5, iqr: [0.5, 0.5] });
  assert.equal(metered.listUsd, null);

  const unmetered = only(buildCells(rows("codex"), query({ by: [] }), costs));
  assert.equal(unmetered.tokens?.n, 1);
  assert.equal(unmetered.spentUsd, null);
  assert.equal(unmetered.listUsd, null);

  const noLookup = only(buildCells(rows("opencode"), query({ by: [] })));
  assert.equal(noLookup.tokens, null);
  assert.equal(noLookup.spentUsd, null);
  assert.equal(noLookup.listUsd, null);
});

test("minutes, ratings, and times", () => {
  assert.equal(
    rowMinutes(row({ startedAt: "2026-11-13T10:00:00.000Z", endedAt: "2026-11-13T10:30:00.000Z" })),
    30,
  );
  assert.equal(
    rowMinutes(row({ startedAt: "2026-11-13T10:30:00.000Z", endedAt: "2026-11-13T10:00:00.000Z" })),
    0,
  );
  assert.equal(rowMinutes(row({ startedAt: "2026-11-13T10:00:00.000Z", endedAt: null })), undefined);

  const rated = buildCells(
    [
      row({ payload: { ownerRating: { score: 4, at: FROZEN } } }),
      row({ payload: { ownerRating: { score: 2, at: FROZEN } } }),
    ],
    query({ by: [] }),
  );
  assert.deepEqual(only(rated).ownerRating, { mean: 3, n: 2 });
  assert.equal(only(buildCells([row()], query({ by: [] }))).ownerRating, null);

  const timed = only(
    buildCells(
      [
        row({ startedAt: "2026-11-13T10:00:00.000Z", endedAt: "2026-11-13T10:30:00.000Z" }),
        row({ startedAt: "2026-11-13T09:00:00.000Z", endedAt: null }),
        row({ startedAt: "2026-11-13T11:00:00.000Z", endedAt: "2026-11-13T11:45:00.000Z" }),
      ],
      query({ by: [] }),
    ),
  );
  assert.equal(timed.from, "2026-11-13T09:00:00.000Z");
  assert.equal(timed.to, "2026-11-13T11:45:00.000Z");
  assert.deepEqual(timed.minutes, { n: 2, median: 37.5, iqr: [33.75, 41.25] });

  const untimed = only(buildCells([row()], query({ by: [] })));
  assert.equal(untimed.from, null);
  assert.equal(untimed.to, null);
  assert.equal(rowTime(row({ startedAt: null, endedAt: null })), null);
});

test("scouts report completion", () => {
  const scout = (disposition: Disposition) => row({ role: "scout", disposition, integrated: null, accepted: null, firstPass: null, held: null });
  const cell = only(
    buildCells(
      [scout("completed"), scout("completed"), scout("completed"), scout("stalled"), scout("open")],
      query({ role: "scout", by: [] }),
    ),
  );
  assert.equal(cell.attempts, 4);
  assert.equal(cell.open, 1);
  assert.deepEqual(cell.completed, { yes: 3, no: 1, unknown: 0, rate: 0.75, interval: wilsonInterval(3, 4) });
  for (const level of [cell.levels.integrated, cell.levels.accepted, cell.levels.firstPass, cell.levels.held]) {
    assert.deepEqual(level, { yes: 0, no: 0, unknown: 0, rate: null, interval: null });
  }
});

test("an unknown flag is ignored", () => {
  // A later slice adds flags, and a newer host can write rows that an older one reads after a rollback.
  const cell = only(buildCells([row({ flags: ["gap", "scan-gap"] as unknown as Flag[] })], query({ by: [] })));
  assert.equal(cell.flagged.gap, 1);
  assert.deepEqual(Object.keys(cell.flagged).sort(), ["backfilled", "empty-result", "gap", "same-model-review"]);
  for (const value of Object.values(cell.flagged)) assert.ok(Number.isFinite(value), JSON.stringify(cell.flagged));
});

test("enough needs ten counted rows", () => {
  const open = (count: number) => Array.from({ length: count }, () => row({ disposition: "open" }));
  const counted = (count: number) => Array.from({ length: count }, () => row());
  const nine = only(buildCells([...counted(9), ...open(5)], query({ by: [] })));
  assert.equal(nine.attempts, 9);
  assert.equal(nine.enough, false);
  const ten = only(buildCells([...counted(10), ...open(5)], query({ by: [] })));
  assert.equal(ten.enough, true);
});
