import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyBatchSchema,
  legacyLineHash,
  legacyLineSchema,
  legacyOutcomeId,
  legacyRow,
  parseLegacyFile,
  planLegacyBatch,
  type LegacyOutcome,
} from "../packages/host/src/outcome-legacy.js";
import type { LegacyLineState } from "../packages/host/src/outcome-store.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-13T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const RECORDED = "2026-10-01T00:00:00.000Z";
const ref = (id: string) => "r-" + id;
const ctx = { now: NOW, retentionDays: 730, ref };
const LINE_ID = "op-2026-10-01-ledger";

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LINE_ID,
    projectId: "alpha-team",
    profile: { provider: "claude", model: "model-one", effort: "high" },
    label: "Ship the import",
    result: "accepted",
    attempts: 1,
    totalTokens: 1000,
    elapsedMs: 60_000,
    recordedAt: RECORDED,
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}): LegacyOutcome {
  return legacyLineSchema(NOW_MS).parse(raw(overrides));
}

function fails(value: unknown, now = NOW_MS): boolean {
  return !legacyLineSchema(now).safeParse(value).success;
}

test("a line is validated strictly", () => {
  const schema = legacyLineSchema(NOW_MS);
  assert.equal(schema.safeParse(raw({ reviewerModel: "model-two", supersedes: "op-2026-09-01-old" })).success, true);
  assert.equal(fails(raw({ unexpected: 1 })), true);
  assert.equal(fails(raw({ label: "a".repeat(41) })), true);
  assert.equal(fails(raw({ attempts: 0 })), true);
  assert.equal(fails(raw({ recordedAt: new Date(NOW_MS + 1).toISOString() })), true);
  assert.equal(fails(raw({ supersedes: LINE_ID })), true);
  assert.equal(fails(raw({ id: "op 1" })), true);
  assert.equal(fails(raw({ projectId: "Alpha" })), true);
  assert.equal(fails(raw({ profile: { provider: "Claude", model: "model-one" } })), true);
  assert.equal(fails(raw({ profile: { provider: "claude", model: "model one" } })), true);

  const batch = legacyBatchSchema(NOW_MS);
  const lines = (count: number) => Array.from({ length: count }, () => raw());
  assert.equal(batch.safeParse({ dryRun: true, lines: lines(1) }).success, true);
  assert.equal(batch.safeParse({ dryRun: true, lines: lines(51) }).success, false);
  assert.equal(batch.safeParse({ dryRun: true, lines: [] }).success, false);
  assert.equal(batch.safeParse({ lines: lines(1) }).success, false);
});

test("the hash is of the canonical line", () => {
  const withOffset = line({ recordedAt: "2026-10-01T02:00:00+02:00" });
  const reordered = Object.fromEntries(Object.entries(line()).reverse()) as LegacyOutcome;
  assert.equal(legacyLineHash(reordered), legacyLineHash(withOffset));
  assert.notEqual(legacyLineHash(line({ attempts: 2 })), legacyLineHash(line()));
  // The hash does not rely on the caller: a line that was never parsed, with its time in another written form and an
  // absent key given as undefined, hashes like the parsed line.
  const parsed = line();
  const unparsed = { ...parsed, recordedAt: "2026-10-01T02:00:00+02:00", label: undefined } as LegacyOutcome;
  assert.equal(Date.parse(unparsed.recordedAt), Date.parse(parsed.recordedAt));
  const { label: _label, ...withoutLabel } = parsed;
  assert.equal(legacyLineHash(unparsed), legacyLineHash(withoutLabel as LegacyOutcome));
});

test("the file is checked before anything is sent", () => {
  const valid = JSON.stringify(raw());
  const huge = Array.from({ length: 20_001 }, () => valid).join("\n");
  assert.deepEqual(parseLegacyFile(huge, NOW_MS), { errors: [{ line: 20_001, reason: "file-too-long" }] });

  const text = [
    valid,
    "",
    "x".repeat(1025),
    "{not json",
    JSON.stringify(raw({ unexpected: 1 })),
    JSON.stringify(raw({ attempts: 2 })),
  ].join("\n");
  const result = parseLegacyFile(text, NOW_MS);
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map(error => [error.line, error.reason]), [
    [2, "blank-line"],
    [3, "line-too-long"],
    [4, "not-json"],
    [5, "invalid"],
    [6, "id-conflict"],
  ]);

  const same = parseLegacyFile([valid, valid].join("\n") + "\n", NOW_MS);
  assert.ok("lines" in same);
  assert.deepEqual(same.numbers, [1, 2]);

  const crlf = parseLegacyFile([valid, valid].join("\r\n") + "\r\n", NOW_MS);
  assert.ok("lines" in crlf);
  assert.deepEqual(crlf.numbers, [1, 2]);

  const many = parseLegacyFile(Array.from({ length: 25 }, () => "not json").join("\n"), NOW_MS);
  assert.ok("errors" in many);
  assert.equal(many.errors.length, 20);
});

test("a line becomes a legacy row", () => {
  const REF = "f".repeat(64);
  const id = legacyOutcomeId(REF);
  const accepted = legacyRow(line(), REF);
  assert.deepEqual(accepted, {
    outcomeId: id,
    source: "legacy",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: id,
    revision: 0,
    memberId: "legacy",
    sessionId: null,
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: "(legacy)",
    provider: "claude",
    model: "model-one",
    effort: "high",
    profileEpoch: 0,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: "unknown",
    featureVersion: 0,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    acceptance: 1,
    firstPass: 1,
    held: null,
    startedAt: null,
    endedAt: RECORDED,
    frozenAt: RECORDED,
    holdUntil: null,
    runDeletedAt: RECORDED,
    payload: {
      projectId: "alpha-team",
      taskId: "unknown",
      area: "(unknown)",
      featureMap: "unknown",
      rounds: { run: 0, attributed: 0, unknown: 0 },
      limitEvents: 0,
      costCoverage: "none",
      wallMs: 60_000,
      legacy: { id: LINE_ID, label: "Ship the import", result: "accepted", attempts: 1, totalTokens: 1000 },
    },
  });

  const twice = legacyRow(line({ attempts: 2 }), REF);
  assert.equal(twice.firstPass, 0);

  const rejected = legacyRow(line({ result: "rejected" }), REF);
  assert.equal(rejected.disposition, "integrated");
  assert.equal(rejected.exclusion, null);
  assert.equal(rejected.integrated, null);
  assert.equal(rejected.accepted, 0);
  assert.equal(rejected.acceptance, 0);
  assert.equal(rejected.firstPass, 0);
  assert.equal(rejected.held, 0);

  const excluded = legacyRow(line({ result: "excluded" }), REF);
  assert.equal(excluded.disposition, "host-stop");
  assert.equal(excluded.exclusion, "host");
  assert.deepEqual(
    [excluded.integrated, excluded.accepted, excluded.acceptance, excluded.firstPass, excluded.held],
    [null, null, null, null, null],
  );

  assert.deepEqual(legacyRow(line({ reviewerModel: "model-one" }), REF).flags, ["same-model-review"]);
  assert.deepEqual(legacyRow(line({ result: "rejected", reviewerModel: "model-one" }), REF).flags, []);

  for (const [key, value] of Object.entries(accepted)) {
    if (key === "payload" || typeof value !== "string") continue;
    for (const secret of [LINE_ID, "Ship the import", "alpha-team"]) {
      assert.ok(!value.includes(secret), `plain column ${key} holds operator text`);
    }
  }
});

test("the plan imports, repeats, and refuses by id", () => {
  const A = line();
  const empty = planLegacyBatch([A], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(empty.outcomes, ["imported"]);
  assert.equal(empty.effects.length, 1);
  assert.equal(empty.effects[0]?.kind, "insert");
  assert.equal(empty.effects[0]?.ref, ref(LINE_ID));
  assert.equal(empty.removed, 0);
  assert.equal(empty.newLines, 1);

  const same: LegacyLineState = { state: "imported", lineHash: legacyLineHash(A), recordedAt: RECORDED };
  const repeated = planLegacyBatch([A], { lines: new Map([[ref(LINE_ID), same]]), rows: new Map() }, ctx);
  assert.deepEqual(repeated.outcomes, ["repeated"]);
  assert.deepEqual(repeated.effects, []);

  const other: LegacyLineState = { ...same, lineHash: "0".repeat(64) };
  const changed = planLegacyBatch([A], { lines: new Map([[ref(LINE_ID), other]]), rows: new Map() }, ctx);
  assert.deepEqual(changed.outcomes, ["changed"]);
  assert.deepEqual(changed.effects, []);

  const collision = new Map([[legacyOutcomeId(ref(LINE_ID)), "production"]]);
  const conflict = planLegacyBatch([A], { lines: new Map(), rows: collision }, ctx);
  assert.deepEqual(conflict.outcomes, ["conflict"]);
  assert.deepEqual(conflict.effects, []);
});

test("a superseded line is dropped in either order", () => {
  const A = line({ id: "op-2026-10-01-a" });
  const B = line({ id: "op-2026-10-01-b", supersedes: "op-2026-10-01-a", attempts: 2 });
  const kinds = (effects: ReturnType<typeof planLegacyBatch>["effects"]) =>
    effects.map(effect => [effect.kind, effect.ref]);

  const forward = planLegacyBatch([A, B], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(forward.outcomes, ["imported", "imported"]);
  assert.deepEqual(kinds(forward.effects), [["insert", ref(A.id)], ["supersede", ref(A.id)], ["insert", ref(B.id)]]);
  const supersede = forward.effects[1];
  assert.ok(supersede?.kind === "supersede" && supersede.removeRow === true);
  assert.equal(forward.removed, 1);

  const backward = planLegacyBatch([B, A], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(backward.outcomes, ["imported", "superseded"]);
  const mark = backward.effects[0];
  assert.ok(mark?.kind === "supersede" && mark.removeRow === false);
  assert.deepEqual(mark?.state, { state: "superseded", lineHash: null, recordedAt: B.recordedAt });
  // When A arrives, its mark takes A's own hash and time. A is never inserted.
  assert.deepEqual(kinds(backward.effects), [["supersede", ref(A.id)], ["insert", ref(B.id)], ["supersede", ref(A.id)]]);
  const completed = backward.effects[2];
  assert.ok(completed?.kind === "supersede" && completed.removeRow === false);
  assert.equal(backward.removed, 0);

  // Both orders leave the same line states and the same rows.
  const end = (plan: ReturnType<typeof planLegacyBatch>) => {
    const states = new Map<string, LegacyLineState>();
    const rows = new Set<string>();
    for (const effect of plan.effects) {
      states.set(effect.ref, effect.state);
      if (effect.kind === "insert") rows.add(effect.row.outcomeId);
      else if (effect.removeRow) rows.delete(legacyOutcomeId(effect.ref));
    }
    return { states: [...states].sort(([a], [b]) => a.localeCompare(b)), rows: [...rows].sort() };
  };
  assert.deepEqual(end(backward), end(forward));
  assert.deepEqual(end(forward).states, [
    [ref(A.id), { state: "superseded", lineHash: legacyLineHash(A), recordedAt: A.recordedAt }],
    [ref(B.id), { state: "imported", lineHash: legacyLineHash(B), recordedAt: B.recordedAt }],
  ]);
  assert.deepEqual(end(forward).rows, [legacyOutcomeId(ref(B.id))]);

  const knownA: LegacyLineState = { state: "imported", lineHash: legacyLineHash(A), recordedAt: A.recordedAt };
  const later = planLegacyBatch([B], { lines: new Map([[ref(A.id), knownA]]), rows: new Map([[legacyOutcomeId(ref(A.id)), "legacy"]]) }, ctx);
  assert.deepEqual(later.outcomes, ["imported"]);
  const dropped = later.effects[0];
  assert.ok(dropped?.kind === "supersede" && dropped.removeRow === true);
  assert.equal(later.removed, 1);

  // A stored mark with no hash is completed by its line, across batches too. A completed mark is left alone.
  const knownSuperseded: LegacyLineState = { state: "superseded", lineHash: null, recordedAt: B.recordedAt };
  const again = planLegacyBatch([A], { lines: new Map([[ref(A.id), knownSuperseded]]), rows: new Map() }, ctx);
  assert.deepEqual(again.outcomes, ["superseded"]);
  assert.deepEqual(again.effects, [{
    kind: "supersede", ref: ref(A.id), removeRow: false,
    state: { state: "superseded", lineHash: legacyLineHash(A), recordedAt: A.recordedAt },
  }]);
  assert.equal(again.newLines, 0);
  const complete: LegacyLineState = { state: "superseded", lineHash: legacyLineHash(A), recordedAt: A.recordedAt };
  const settled = planLegacyBatch([A], { lines: new Map([[ref(A.id), complete]]), rows: new Map() }, ctx);
  assert.deepEqual([settled.outcomes, settled.effects], [["superseded"], []]);
});

test("a cycle resolves to the first line", () => {
  const A = line({ id: "op-2026-10-01-a", supersedes: "op-2026-10-01-b" });
  const B = line({ id: "op-2026-10-01-b", supersedes: "op-2026-10-01-a" });
  const plan = planLegacyBatch([A, B], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(plan.outcomes, ["imported", "superseded"]);
});

test("expired lines have no effect", () => {
  const S = line({ id: "op-2026-09-01-old" });
  const X = line({
    id: "op-2026-09-01-new",
    supersedes: S.id,
    recordedAt: new Date(NOW_MS - 731 * DAY_MS).toISOString(),
  });
  const known: LegacyLineState = { state: "imported", lineHash: legacyLineHash(S), recordedAt: S.recordedAt };
  const plan = planLegacyBatch([X], {
    lines: new Map([[ref(S.id), known]]),
    rows: new Map([[legacyOutcomeId(ref(S.id)), "legacy"]]),
  }, ctx);
  assert.deepEqual(plan.outcomes, ["expired"]);
  assert.deepEqual(plan.effects, []);
  assert.equal(plan.removed, 0);
  assert.equal(plan.newLines, 0);
});

test("the same id twice in one batch", () => {
  const A = line();
  const identical = planLegacyBatch([A, A], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(identical.outcomes, ["imported", "repeated"]);
  assert.equal(identical.effects.length, 1);

  const changed = planLegacyBatch([A, line({ attempts: 2 })], { lines: new Map(), rows: new Map() }, ctx);
  assert.deepEqual(changed.outcomes, ["imported", "changed"]);
  assert.equal(changed.effects.length, 1);
});
