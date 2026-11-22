import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import {
  VERDICTS_MODULE,
  registerVerdicts,
  sweepExpiredVerdicts,
  verdictEventDataSchema,
  type VerdictEventData,
} from "../packages/host/src/verdict-store.js";

const DAY_MS = 86_400_000;
const PROJECT = "example-project";
const NOW = "2026-11-21T12:00:00.000Z";

type Fixture = { root: string; store: EvidenceStore; outbox: EventOutbox; close: () => void };

/** Registers the ledger the way the server does. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-verdicts-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  const outbox = new EventOutbox(store);
  registerVerdicts(store, outbox);
  return {
    root,
    store,
    outbox,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdictId: randomUUID(),
    projectId: PROJECT,
    goalId: randomUUID(),
    cycle: 2,
    kind: "reviewed",
    recordVersion: 5,
    rubricVersion: 1,
    profileId: "profile-a",
    provider: "claude",
    model: "model-one",
    family: "family-a",
    sharedFamily: false,
    alsoReviewed: true,
    result: "not-met",
    evaluatorResult: "met",
    reason: "evaluator-unavailable",
    met: 2,
    notMet: 1,
    inconclusive: 1,
    pendingOwner: 0,
    ...overrides,
  };
}

/** A stored event. The host stamps `v: 1` on the data of every run event it emits. */
function event(key: string, eventData: Record<string, unknown>, at: string = NOW, runId = "run-1"): OutboxEvent {
  return { key, runId, revision: 3, at, kind: "verdict.recorded", data: { v: 1, ...eventData } };
}

type Row = Record<string, unknown>;

function rows(f: Fixture): Row[] {
  return f.store.read(db => db.all<Row>("SELECT * FROM objective_verdicts ORDER BY verdict_id"));
}

test("a verdict event projects one row", () => {
  const f = fixture();
  try {
    const good = data();
    const flushed = f.outbox.flush([event("verdict-1", good)]);
    assert.equal(flushed.stored, true);
    const found = rows(f);
    assert.equal(found.length, 1);
    const row = found[0]!;
    assert.equal(row.verdict_id, good.verdictId);
    assert.equal(row.run_id, "run-1");
    assert.equal(row.cycle, 2);
    assert.equal(row.revision, 3);
    assert.equal(row.kind, "reviewed");
    assert.equal(row.record_version, 5);
    assert.equal(row.rubric_version, 1);
    assert.equal(row.profile_id, "profile-a");
    assert.equal(row.provider, "claude");
    assert.equal(row.model, "model-one");
    assert.equal(row.family, "family-a");
    assert.equal(row.shared_family, 0);
    assert.equal(row.also_reviewed, 1);
    assert.equal(row.result, "not-met");
    assert.equal(row.evaluator_result, "met");
    assert.equal(row.reason, "evaluator-unavailable");
    assert.equal(row.met, 2);
    assert.equal(row.not_met, 1);
    assert.equal(row.inconclusive, 1);
    assert.equal(row.pending_owner, 0);
    assert.equal(row.at, NOW);
    assert.equal(row.run_deleted_at, null);
    const goalRef = f.store.read(db => db.index("goal", good.goalId as string));
    const projectRef = f.store.read(db => db.index("project", PROJECT));
    assert.equal(Buffer.from(row.goal_ref as Uint8Array).toString(), goalRef);
    assert.equal(Buffer.from(row.project_ref as Uint8Array).toString(), projectRef);

    f.outbox.flush([event("verdict-1-again", good, "2026-11-21T13:00:00.000Z")]);
    const again = rows(f);
    assert.equal(again.length, 1);
    assert.equal(again[0]!.at, NOW);

    const bad = data({ result: "maybe" });
    f.outbox.flush([event("verdict-bad", bad)]);
    const noProject = data();
    delete noProject.projectId;
    f.outbox.flush([event("verdict-no-project", noProject)]);
    const badProject = data({ projectId: "Not An Id" });
    f.outbox.flush([event("verdict-bad-project", badProject)]);
    // Data without the host's version, of a later version, or with a key the schema does not name writes nothing.
    const unversioned = data(), newer = data(), noted = data({ note: "free text" });
    f.outbox.flush([{ ...event("verdict-unversioned", unversioned), data: unversioned }]);
    f.outbox.flush([event("verdict-newer", { ...newer, v: 2 })]);
    f.outbox.flush([event("verdict-noted", noted)]);
    const later = data();
    f.outbox.flush([event("verdict-2", later)]);
    const ids = rows(f).map(item => item.verdict_id);
    assert.equal(ids.length, 2);
    assert.equal(ids.includes(bad.verdictId), false);
    assert.equal(ids.includes(noProject.verdictId), false);
    assert.equal(ids.includes(badProject.verdictId), false);
    for (const refused of [unversioned, newer, noted]) assert.equal(ids.includes(refused.verdictId), false);
    assert.equal(ids.includes(later.verdictId), true);
  } finally {
    f.close();
  }
});

test("rows hold no text", () => {
  const f = fixture();
  try {
    f.outbox.flush([event("verdict-1", data())]);
    const columns = f.store.read(db => db.all<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info('objective_verdicts')"));
    const [row] = rows(f);
    assert.ok(row !== undefined);
    const idPattern = /^[a-z0-9][a-z0-9._:/-]*$/;
    const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const enums: Record<string, string[]> = {
      kind: ["reviewed", "no-change"],
      result: ["met", "not-met", "inconclusive"],
      evaluator_result: ["met", "not-met", "inconclusive"],
      reason: ["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"],
      provider: ["claude", "codex", "opencode"],
    };
    assert.ok(columns.length >= 20);
    for (const column of columns) {
      assert.ok(["INTEGER", "BLOB", "TEXT"].includes(column.type), `${column.name} has type ${column.type}`);
      const value = row[column.name];
      if (column.type !== "TEXT" || value === null) continue;
      assert.equal(typeof value, "string");
      const text = value as string;
      const allowed = enums[column.name];
      if (allowed !== undefined) assert.ok(allowed.includes(text), `${column.name} holds an enumeration value`);
      else if (column.name === "at" || column.name === "run_deleted_at") assert.match(text, isoTime);
      else if (column.name === "verdict_id") assert.match(text, /^[0-9a-f-]{36}$/);
      else assert.match(text, idPattern, `${column.name} holds an id`);
    }
    for (const key of ["note", "summary"]) {
      const refused = verdictEventDataSchema.safeParse({ ...data(), [key]: "free text" });
      assert.equal(refused.success, false, `${key} is refused`);
    }
    assert.equal(verdictEventDataSchema.safeParse(data()).success, true);
    const typed: VerdictEventData = verdictEventDataSchema.parse(data());
    assert.equal(typed.kind, "reviewed");
  } finally {
    f.close();
  }
});

test("rows outlive their run and expire after 730 days", () => {
  const f = fixture();
  try {
    const events: OutboxEvent[] = [];
    const old = new Date(Date.parse(NOW) - 731 * DAY_MS).toISOString();
    const recent = new Date(Date.parse(NOW) - 729 * DAY_MS).toISOString();
    for (let index = 0; index < 101; index += 1) events.push(event(`old-${index}`, data(), old, "run-old"));
    events.push(event("recent", data(), recent, "run-recent"));
    assert.equal(f.outbox.flush(events).stored, true);
    assert.equal(rows(f).length, 102);

    assert.equal(f.store.deleteRun("run-old"), true);
    const stamped = rows(f).filter(row => row.run_id === "run-old");
    assert.equal(stamped.length, 101);
    assert.ok(stamped.every(row => typeof row.run_deleted_at === "string"));
    assert.equal(rows(f).filter(row => row.run_id === "run-recent")[0]!.run_deleted_at, null);

    assert.equal(sweepExpiredVerdicts(f.store, NOW), 100);
    assert.equal(rows(f).length, 2);
    assert.equal(sweepExpiredVerdicts(f.store, NOW), 1);
    const left = rows(f);
    assert.equal(left.length, 1);
    assert.equal(left[0]!.run_id, "run-recent");
    assert.equal(sweepExpiredVerdicts(f.store, NOW), 0);
    assert.equal(f.store.status().modules[VERDICTS_MODULE], "ready");
  } finally {
    f.close();
  }
});
