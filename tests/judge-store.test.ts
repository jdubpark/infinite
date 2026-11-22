import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import {
  ACTIVE_CALIBRATION_SQL, CALIBRATION_JUDGEMENTS_SQL, IN_FORCE_SQL, JUDGE_MODULE, LIVE_JUDGEMENTS_SQL,
  activeCalibration, calibrationInForce, calibrationJudgements, calibrationViews, clearJudgementSession, dropJudgement,
  finishCalibration, finishJudgement, insertCalibration, insertJudgement, judgeCalibrationsModule, liveJudgements,
  readCalibration, startJudgement, sweepJudge, type CalibrationEnd, type NewCalibration,
} from "../packages/host/src/judge-store.js";

const T0 = "2026-11-22T00:00:00.000Z";
const KEY = "judge-key-1";
const PROFILE_ID = "zz-judge-profile";
const PROMPT = "prompt-v1";

type Fixture = { store: EvidenceStore; close: () => void };

function ready(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-judge-store-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(judgeCalibrationsModule(store, () => T0));
  assert.equal(store.status().modules[JUDGE_MODULE], "ready");
  return { store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function calibration(id: string, patch: Partial<NewCalibration> = {}): NewCalibration {
  return {
    calibrationId: id, requestId: `request-${id}`, judgeKey: KEY, profileEpoch: 3, promptVersion: PROMPT, pairsPlanned: 30,
    judgeMinutes: 10, createdAt: T0, expiresAt: "2026-12-22T00:00:00.000Z",
    payload: {
      profileId: PROFILE_ID, request: { requestId: `request-${id}`, judgeProfileId: PROFILE_ID },
      pairs: [{ projectId: "zz-project", taskId: "zz-task-1", resolvedTrialId: "zz-trial-r", unresolvedTrialId: "zz-trial-u" }],
      perProject: [{ projectId: "zz-project", pairs: 1 }],
    },
    ...patch,
  };
}

function end(patch: Partial<CalibrationEnd> = {}): CalibrationEnd {
  return { status: "completed", reason: null, state: "ok", counted: 30, correct: 24, agree: 27, accuracy: 0.8, lowerBound: 0.63, swapAgreement: 0.9, ...patch };
}

function complete(f: Fixture, id: string, at: string, patch: Partial<CalibrationEnd> = {}, row: Partial<NewCalibration> = {}): void {
  f.store.write(tx => { insertCalibration(tx, calibration(id, row)); });
  assert.equal(f.store.write(tx => finishCalibration(tx, id, end(patch), at)), true);
}

const inForce = (f: Fixture, now: string, epoch = 3, promptVersion = PROMPT) =>
  f.store.read(db => calibrationInForce(db, { judgeKey: KEY, epoch, promptVersion, now }));

test("a request ID inserts once", () => {
  const f = ready();
  try {
    assert.equal(f.store.write(tx => insertCalibration(tx, calibration("c1"))), "inserted");
    assert.equal(f.store.write(tx => insertCalibration(tx, calibration("c2", { requestId: "request-c1" }))), "exists");
    const count = f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM judge_calibrations")?.n);
    assert.equal(count, 1);
  } finally {
    f.close();
  }
});

test("the payload is sealed", () => {
  const f = ready();
  try {
    f.store.write(tx => { insertCalibration(tx, calibration("c1")); });
    const raw = f.store.read(db => db.get<{ payload: string }>("SELECT payload FROM judge_calibrations")?.payload ?? "");
    for (const secret of ["zz-task-1", "zz-trial-r", "zz-trial-u", PROFILE_ID, "zz-project"]) {
      assert.equal(raw.includes(secret), false, `the raw payload holds ${secret}`);
    }
    const row = f.store.read(db => readCalibration(db, "c1"));
    assert.equal(row?.payload.profileId, PROFILE_ID);
    assert.equal(row?.payload.pairs[0]?.taskId, "zz-task-1");
  } finally {
    f.close();
  }
});

test("a completed ok calibration is in force for 60 days", () => {
  const f = ready();
  try {
    complete(f, "c1", T0);
    assert.equal(f.store.read(db => readCalibration(db, "c1"))?.validUntil, "2027-01-21T00:00:00.000Z");
    assert.equal(inForce(f, "2027-01-20T23:59:59.999Z")?.calibrationId, "c1");
    assert.equal(inForce(f, "2027-01-21T00:00:00.000Z"), undefined);
    const found = inForce(f, T0);
    assert.equal(found?.accuracy, 0.8);
    assert.equal(found?.lowerBound, 0.63);
  } finally {
    f.close();
  }
});

test("a new epoch leaves no calibration in force", () => {
  const f = ready();
  try {
    complete(f, "c1", T0);
    assert.equal(inForce(f, T0, 4), undefined);
  } finally {
    f.close();
  }
});

test("a new prompt version leaves no calibration in force", () => {
  const f = ready();
  try {
    complete(f, "c1", T0);
    assert.equal(inForce(f, T0, 3, "prompt-v2"), undefined);
  } finally {
    f.close();
  }
});

test("a not-ok calibration is never in force", () => {
  const f = ready();
  try {
    complete(f, "c1", T0, { state: "not-ok", accuracy: 0.4, lowerBound: 0.2 });
    assert.equal(inForce(f, T0), undefined);
  } finally {
    f.close();
  }
});

test("a cancelled calibration is never in force and has no validity", () => {
  const f = ready();
  try {
    complete(f, "c1", T0, { status: "cancelled", reason: "identity-changed", state: null, counted: 0, correct: 0, agree: 0, accuracy: null, lowerBound: null, swapAgreement: null });
    const row = f.store.read(db => readCalibration(db, "c1"));
    assert.equal(row?.status, "cancelled");
    assert.equal(row?.validUntil, null);
    assert.equal(inForce(f, T0), undefined);
    assert.equal(f.store.write(tx => finishCalibration(tx, "c1", end(), T0)), false, "a finished calibration finishes once");
  } finally {
    f.close();
  }
});

test("the newest ok row wins", () => {
  const f = ready();
  try {
    complete(f, "old", "2026-11-22T00:00:00.000Z", { accuracy: 0.7 });
    complete(f, "new", "2026-11-23T00:00:00.000Z", { accuracy: 0.9 });
    assert.equal(inForce(f, "2026-11-24T00:00:00.000Z")?.calibrationId, "new");
    assert.equal(inForce(f, "2026-11-24T00:00:00.000Z")?.accuracy, 0.9);
  } finally {
    f.close();
  }
});

test("an empty store answers empty", () => {
  const f = ready();
  try {
    assert.deepEqual(f.store.read(db => calibrationViews(db, T0, () => undefined)), []);
    assert.equal(f.store.read(db => activeCalibration(db)), undefined);
    assert.deepEqual(f.store.read(db => liveJudgements(db)), []);
    assert.deepEqual(f.store.read(db => calibrationJudgements(db, "none")), []);
  } finally {
    f.close();
  }
});

test("the active calibration is the running one", () => {
  const f = ready();
  try {
    f.store.write(tx => { insertCalibration(tx, calibration("c1")); });
    assert.equal(f.store.read(db => activeCalibration(db))?.calibrationId, "c1");
    f.store.write(tx => finishCalibration(tx, "c1", end({ status: "expired", reason: "expired", state: null }), T0));
    assert.equal(f.store.read(db => activeCalibration(db)), undefined);
  } finally {
    f.close();
  }
});

test("a view carries no task, trial, or model text and marks the one in force", () => {
  const f = ready();
  try {
    complete(f, "c1", T0);
    const views = f.store.read(db => calibrationViews(db, T0, key => key === KEY ? { epoch: 3, promptVersion: PROMPT } : undefined));
    assert.equal(views.length, 1);
    const view = views[0]!;
    assert.equal(view.profileId, PROFILE_ID);
    assert.equal(view.inForce, true);
    assert.equal(view.pairs.counted, 30);
    assert.equal(view.pairs.correct, 24);
    assert.deepEqual(view.pairs.perProject, [{ projectId: "zz-project", pairs: 1 }]);
    const text = JSON.stringify(view);
    for (const secret of ["zz-task-1", "zz-trial-r", "zz-trial-u"]) assert.equal(text.includes(secret), false, secret);
    const stale = f.store.read(db => calibrationViews(db, T0, () => ({ epoch: 4, promptVersion: PROMPT })));
    assert.equal(stale[0]?.inForce, false);
    const gone = f.store.read(db => calibrationViews(db, T0, () => undefined));
    assert.equal(gone[0]?.inForce, false);
  } finally {
    f.close();
  }
});

test("views list the newest first and at most 20", () => {
  const f = ready();
  try {
    for (let i = 0; i < 22; i++) {
      const at = new Date(Date.parse(T0) + i * 60_000).toISOString();
      f.store.write(tx => { insertCalibration(tx, calibration(`c${String(i).padStart(2, "0")}`, { createdAt: at })); });
    }
    const views = f.store.read(db => calibrationViews(db, T0, () => undefined));
    assert.equal(views.length, 20);
    assert.equal(views[0]?.calibrationId, "c21");
    assert.equal(views[19]?.calibrationId, "c02");
  } finally {
    f.close();
  }
});

test("a judgement moves from preparing to live to final, once", () => {
  const f = ready();
  try {
    f.store.write(tx => { insertCalibration(tx, calibration("c1")); });
    const row = { judgementId: "j1", calibrationId: "c1", projectId: "zz-project", pairIndex: 0, ordering: 0 as const, attempt: 0, resolvedIsA: true };
    assert.equal(f.store.write(tx => insertJudgement(tx, row, T0)), "inserted");
    assert.equal(f.store.write(tx => insertJudgement(tx, { ...row, judgementId: "j1b" }, T0)), "exists", "the slot key is unique");
    assert.deepEqual(f.store.read(db => liveJudgements(db)).map(r => [r.judgementId, r.state]), [["j1", "preparing"]]);
    assert.equal(f.store.write(tx => startJudgement(tx, "j1", "session-1")), true);
    assert.equal(f.store.write(tx => startJudgement(tx, "j1", "session-1")), false);
    assert.deepEqual(f.store.read(db => liveJudgements(db)).map(r => [r.state, r.sessionId]), [["live", "session-1"]]);
    const scores = { correctness: 4, cleanliness: 3, extensibility: 3, docs: 2 };
    const judgement = { preferred: "A" as const, rubric: { a: scores, b: scores } };
    const later = "2026-11-22T00:05:00.000Z";
    assert.equal(f.store.write(tx => finishJudgement(tx, "j1", { ending: "judged", judgement, sessionId: "session-1", cost: { tokens: 100, usd: 0.5, complete: true } }, later)), true);
    assert.equal(f.store.write(tx => finishJudgement(tx, "j1", { ending: "timeout", sessionId: null }, later)), false);
    assert.deepEqual(f.store.read(db => liveJudgements(db)), []);
    const rows = f.store.read(db => calibrationJudgements(db, "c1"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, "final");
    assert.equal(rows[0]?.ending, "judged");
    assert.equal(rows[0]?.preferred, "A");
    assert.equal(rows[0]?.resolvedIsA, true);
    assert.equal(rows[0]?.rubric?.a.correctness, 4);
    assert.equal(rows[0]?.tokens, 100);
    assert.equal(rows[0]?.cost, "complete");
    const raw = f.store.read(db => db.get<{ rubric: string }>("SELECT rubric FROM judge_judgements")?.rubric ?? "");
    assert.equal(raw.includes("correctness"), false, "the rubric column is sealed");
    const view = f.store.read(db => calibrationViews(db, T0, () => undefined))[0];
    assert.deepEqual(view?.cost, { tokens: 100, spentUsd: 0.5 });
  } finally {
    f.close();
  }
});

test("a dropped judgement stays as a row and is not live", () => {
  const f = ready();
  try {
    f.store.write(tx => { insertCalibration(tx, calibration("c1")); });
    f.store.write(tx => { insertJudgement(tx, { judgementId: "j1", calibrationId: "c1", projectId: "zz-project", pairIndex: 2, ordering: 1, attempt: 0, resolvedIsA: false }, T0); });
    assert.equal(f.store.write(tx => dropJudgement(tx, "j1", "patch-missing", T0)), true);
    assert.equal(f.store.write(tx => dropJudgement(tx, "j1", "patch-missing", T0)), false);
    assert.deepEqual(f.store.read(db => liveJudgements(db)), []);
    const rows = f.store.read(db => calibrationJudgements(db, "c1"));
    assert.deepEqual(rows.map(r => [r.state, r.dropReason, r.pairIndex, r.ordering]), [["dropped", "patch-missing", 2, 1]]);
  } finally {
    f.close();
  }
});

test("a cost recorded after the finish joins the calibration total once", () => {
  const f = ready();
  try {
    f.store.write(tx => { insertCalibration(tx, calibration("c1")); });
    f.store.write(tx => { insertJudgement(tx, { judgementId: "j1", calibrationId: "c1", projectId: "zz-project", pairIndex: 0, ordering: 0, attempt: 0, resolvedIsA: true }, T0); });
    f.store.write(tx => startJudgement(tx, "j1", "session-1"));
    f.store.write(tx => finishJudgement(tx, "j1", { ending: "timeout", sessionId: "session-1" }, T0));
    assert.equal(f.store.read(db => calibrationJudgements(db, "c1"))[0]?.sessionId, "session-1");
    f.store.write(tx => clearJudgementSession(tx, "j1", { tokens: 40, usd: 0.25, complete: false }));
    f.store.write(tx => clearJudgementSession(tx, "j1", { tokens: 40, usd: 0.25, complete: false }));
    const row = f.store.read(db => calibrationJudgements(db, "c1"))[0];
    assert.equal(row?.sessionId, null);
    assert.equal(row?.cost, "partial");
    assert.deepEqual(f.store.read(db => calibrationViews(db, T0, () => undefined))[0]?.cost, { tokens: 40, spentUsd: 0.25 });
  } finally {
    f.close();
  }
});

test("the sweep removes rows after 365 days", () => {
  const f = ready();
  try {
    const day = 86_400_000;
    const now = "2027-11-22T00:00:00.000Z";
    const at = (days: number) => new Date(Date.parse(now) - days * day).toISOString();
    f.store.write(tx => { insertCalibration(tx, calibration("old", { createdAt: at(366) })); });
    f.store.write(tx => { insertCalibration(tx, calibration("new", { createdAt: at(364) })); });
    f.store.write(tx => { insertJudgement(tx, { judgementId: "j-old", calibrationId: "old", projectId: "zz-project", pairIndex: 0, ordering: 0, attempt: 0, resolvedIsA: true }, at(366)); });
    f.store.write(tx => { insertJudgement(tx, { judgementId: "j-new", calibrationId: "new", projectId: "zz-project", pairIndex: 0, ordering: 0, attempt: 0, resolvedIsA: true }, at(364)); });
    f.store.write(tx => sweepJudge(tx, now));
    assert.equal(f.store.read(db => readCalibration(db, "old")), undefined);
    assert.equal(f.store.read(db => readCalibration(db, "new"))?.calibrationId, "new");
    assert.equal(f.store.read(db => db.all("SELECT 1 FROM judge_judgements WHERE judgement_id = 'j-old'")).length, 0);
    assert.equal(f.store.read(db => db.all("SELECT 1 FROM judge_judgements WHERE judgement_id = 'j-new'")).length, 1);
  } finally {
    f.close();
  }
});

test("the hot statements read through an index", () => {
  const f = ready();
  try {
    const plans: [string, (string | number)[]][] = [
      [IN_FORCE_SQL, [KEY, 3, PROMPT, T0]],
      [ACTIVE_CALIBRATION_SQL, []],
      [LIVE_JUDGEMENTS_SQL, []],
      [CALIBRATION_JUDGEMENTS_SQL, ["c1"]],
    ];
    for (const [sql, params] of plans) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map(row => row.detail);
      assert.equal(details.some(detail => /USING (COVERING )?INDEX|USING (INTEGER )?PRIMARY KEY/.test(detail)), true, `${sql.slice(0, 40)} uses an index: ${details.join(" | ")}`);
    }
  } finally {
    f.close();
  }
});
