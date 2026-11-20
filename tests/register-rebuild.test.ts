import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { MemberProposal } from "../packages/host/src/evidence/member-proposal.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { applyIntentReport } from "../packages/host/src/objective-intent.js";
import { applyOwnerOps } from "../packages/host/src/objective-ops.js";
import { applyProposals } from "../packages/host/src/objective-proposals.js";
import type { Proposal } from "../packages/host/src/objective-proposals.js";
import { applyReceipts } from "../packages/host/src/objective-register.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import { goalRecord, rebuildVersion } from "../packages/host/src/objective-record.js";
import { objectiveRecordSchema } from "../packages/host/src/objective-types.js";
import type { Assumption, Criterion, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { sealRecord } from "../packages/host/src/objective-write.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const HEAD = "1".repeat(40);
const AT = "2026-11-18T00:00:00.000Z";
const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const REQUEST = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c7";
const RUN = "run-1";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
const CONFIGURED = [RANK];
const SEEDS = 200;
const STEPS = 25;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function goalFixture(): ProductGoal {
  return {
    id: GOAL_ID,
    objective: "Find ranked sources for the research brief.",
    successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: ["no paid sources"],
    allowedPaths: ["research"],
    evidence: ["notes.md"],
    steering: [],
  } as unknown as ProductGoal;
}

/** Version 1 with three assumptions: a1 an artifact test, a2 a command test, a3 an owner test; and an owner-rated criterion c2. */
function baseRecord(): ObjectiveRecord {
  const created = goalRecord(goalFixture(), AT, "created");
  if (typeof created === "string") throw new Error(`the fixture record is ${created}`);
  const assumptions: Assumption[] = [
    {
      id: "a1", statement: "Enough entries", status: "assumed", origin: "intent-check", criticality: "plan", refutedBy: "Too few",
      test: { kind: "artifact", path: "research/entries.json", count: "/entries", threshold: { kind: "count", min: 2 } }, evidence: [], proposals: [],
    },
    {
      id: "a2", statement: "The check passes", status: "assumed", origin: "intent-check", criticality: "outcome", refutedBy: "It fails",
      test: { kind: "command", command: commandDigest(RANK), refutesOn: "fail" }, evidence: [], proposals: [],
    },
    {
      id: "a3", statement: "The owner confirms", status: "assumed", origin: "owner", criticality: "plan", refutedBy: "The owner refutes",
      test: { kind: "owner" }, evidence: [], proposals: [],
    },
  ];
  const criteria: Criterion[] = [{
    id: "c2", origin: "owner", statement: "Rated by the owner", check: { kind: "owner-rating", subject: "s1" }, producer: "owner",
    threshold: { kind: "score", min: 3, of: 5 }, state: "active",
  }];
  return sealRecord(created, { assumptions, criteria: [...created.criteria, ...criteria] }, []);
}

function receipt(id: string, kind: "artifact" | "command", outcome: "pass" | "fail"): ObjectiveReceipt {
  const detail = kind === "artifact"
    ? { kind: "artifact" as const, read: "read" as const, total: 1, qualifying: 1 }
    : { kind: "command" as const, observed: outcome === "pass" ? "passed" as const : "failed" as const };
  return { handle: `receipt:${RUN}:1:${id}`, kind, subject: "assumption", id, commit: HEAD, outcome, at: AT, detail };
}

/** The first top-level key whose canonical JSON differs. */
function firstDiffKey(left: unknown, right: unknown): string {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.find(key => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) ?? "none";
}

test("every version rebuilds after random register writes", () => {
  let writes = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const random = mulberry32(seed);
    let record = baseRecord();
    const snapshots = new Map<number, string>([[record.version, canonicalJson(record)]]);
    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      const at = new Date(Date.UTC(2026, 10, 18, 0, step)).toISOString();
      const entryId = `6f1c2a3e-8b4d-4c5e-9f60-${String(seed * 100 + step).padStart(12, "0")}`;
      let next: ObjectiveRecord | undefined;
      try {
        if (roll < 0.25) {
          // Receipts for a1 and a2, each with a random outcome.
          const receipts = [random() < 0.5 ? "a1" : "a2"].map(id => receipt(id, id === "a1" ? "artifact" : "command", random() < 0.5 ? "pass" : "fail"));
          next = applyReceipts(record, receipts, { runId: RUN, revision: 1, kind: "reviewed", at })?.record;
        } else if (roll < 0.5) {
          // A member proposal: a stance on an existing assumption, or a new test.
          const field: MemberProposal = random() < 0.4
            ? { id: "a1", stance: random() < 0.5 ? "supports" : "contradicts" }
            : { propose: { statement: `Proposed ${step} of ${seed}.`, refutedBy: "The check fails", test: { kind: "command", run: RANK, refutesOn: "fail" }, criticality: "plan" } } as MemberProposal;
          const proposal: Proposal = { entryId, memberId: "m1", revision: 1, authorRole: "reviewer", summary: `Finding ${step}.`, assumption: field };
          next = applyProposals(record, [proposal], { runId: RUN, configured: CONFIGURED, at }).record;
        } else if (roll < 0.75) {
          // Owner ops: the owner's status for a3, and a rating for c2.
          const ops = random() < 0.5
            ? [{ op: "assumption.set" as const, id: "a3", status: random() < 0.5 ? "verified" as const : "refuted" as const }]
            : [{ op: "rating.record" as const, subject: "s1", score: 1 + Math.floor(random() * 9) / 2 }];
          next = applyOwnerOps(record, { version: record.version, ops }, { configured: CONFIGURED, requestId: REQUEST, at, rating: { commit: HEAD, cycle: 1 } });
        } else {
          // An intent-check report with no items.
          next = applyIntentReport(record, { kind: "intent-check", summary: "Checked.", items: [] }, {
            runId: RUN, revision: 1, checkerMemberId: "m1", decisionId: REQUEST, mode: "autonomous", goal: true, configured: CONFIGURED, at,
          }).record;
        }
      } catch {
        // A refused write changes nothing; the next step starts from the same record.
        next = undefined;
      }
      if (next !== undefined) {
        writes += 1;
        // A JSON round trip between steps, as a restart would do.
        record = JSON.parse(JSON.stringify(next)) as ObjectiveRecord;
        snapshots.set(record.version, canonicalJson(record));
      }
    }

    for (const [version, snapshot] of snapshots) {
      let rebuilt: ObjectiveRecord;
      try {
        rebuilt = rebuildVersion(record, version);
      } catch (error) {
        assert.fail(`seed ${seed}, version ${version}: rebuild threw ${(error as Error).message}`);
      }
      assert.equal(objectiveRecordSchema.safeParse(rebuilt).success, true, `seed ${seed}, version ${version}: the rebuilt record does not parse`);
      assert.equal(canonicalJson(rebuilt) === snapshot, true,
        `seed ${seed}, version ${version}: the rebuilt record differs at key ${firstDiffKey(JSON.parse(snapshot), rebuilt)}`);
    }
  }
  // The check is vacuous unless the writes happened.
  assert.equal(writes > SEEDS, true, `only ${writes} writes ran across ${SEEDS} seeds`);
});
