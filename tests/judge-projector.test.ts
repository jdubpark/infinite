import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { outcomeModule, readSummary } from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";

const RUN = "00000000-0000-4000-8000-000000000001";
const MEMBER = "member-judge";
const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;
let counter = 0;

function ev(kind: string, time: string, data: Record<string, unknown>, memberId?: string): OutboxEvent {
  counter += 1;
  return { key: runEventKey(kind, RUN, [counter]), runId: RUN, revision: 1, at: time, kind, ...(memberId === undefined ? {} : { memberId }), data: { v: 1, ...data } };
}

/** The events of one judge-shaped run: created, one judge started, its report, and its stop. */
const judgeEvents = (purpose: "duel" | "replay"): OutboxEvent[] => [
  ev("run.created", at(0), { projectId: "example", purpose, trialId: RUN }),
  ev("member.started", at(1), { role: "judge", purpose, sessionId: "session-judge", startedAt: at(1), baseCommit: "b".repeat(40), provider: "claude", profileId: "judge-profile", model: "m-1" }, MEMBER),
  ev("member.reported", at(2), { role: "judge", reportKind: "judgement" }, MEMBER),
  ev("member.stopped", at(3), { role: "judge", reason: "reported", reported: true }, MEMBER),
];

function project(events: OutboxEvent[]) {
  const root = mkdtempSync(join(tmpdir(), "infinite-judge-projector-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => at(59) }));
    const outbox = new EventOutbox(store);
    outbox.registerProjector(configurationProjector());
    outbox.registerProjector(outcomeProjector(store));
    const result = outbox.flush(events);
    assert.equal(result.stored, true);
    assert.equal(result.refused, 0);
    return store.read(db => ({
      source: readSummary(db, RUN)?.source,
      summaries: db.all("SELECT run_id FROM run_summaries").length,
      outcomes: db.all("SELECT outcome_id FROM outcomes").length,
      results: db.all("SELECT result_id FROM member_results").length,
    }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a judge run writes only its summary", () => {
  assert.deepEqual(project(judgeEvents("duel")), { source: "duel", summaries: 1, outcomes: 0, results: 0 });
});

test("a trial run is projected as before", () => {
  assert.deepEqual(project(judgeEvents("replay")), { source: "replay", summaries: 1, outcomes: 0, results: 1 });
});
