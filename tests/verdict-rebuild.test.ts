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
import { composeVerdict, verdictRecord } from "../packages/host/src/verdict-compose.js";
import type { AssessedState, VerdictReport } from "../packages/host/src/verdict-types.js";
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
const STEPS = 30;

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
  }, {
    id: "c3", origin: "owner", statement: "The ranking check passes", check: { kind: "command", command: commandDigest(RANK) }, producer: "host",
    threshold: { kind: "pass" }, state: "active",
  }];
  return sealRecord(created, { assumptions, criteria: [...created.criteria, ...criteria] }, []);
}

function receipt(id: string, kind: "artifact" | "command", outcome: "pass" | "fail"): ObjectiveReceipt {
  const detail = kind === "artifact"
    ? { kind: "artifact" as const, read: "read" as const, total: 1, qualifying: 1 }
    : { kind: "command" as const, observed: outcome === "pass" ? "passed" as const : "failed" as const };
  return { handle: `receipt:${RUN}:1:${id}`, kind, subject: "assumption", id, commit: HEAD, outcome, at: AT, detail };
}

function firstDiffKey(left: unknown, right: unknown): string {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.find(key => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) ?? "none";
}


const STATES: AssessedState[] = ["met", "not-met", "inconclusive"];
const PATHS = ["research/entries.json", "research/notes.md"];

function criterionReceipt(outcome: "pass" | "fail" | "unknown"): ObjectiveReceipt {
  return {
    handle: `receipt:${RUN}:1:c3`, kind: "command", subject: "criterion", id: "c3", commit: HEAD, outcome, at: AT,
    detail: { kind: "command", observed: outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "absent", round: 1 },
  };
}

function verdictWrite(record: ObjectiveRecord, random: () => number, id: string, at: string): ObjectiveRecord | undefined {
  const withReport = random() < 0.8;
  const report: VerdictReport | undefined = withReport
    ? {
      kind: "verdict", result: "met",
      criteria: ["c0", "c3", "c2", "c9"].filter(() => random() < 0.8).map(criterion => ({
        id: criterion, state: STATES[Math.floor(random() * 3)]!, evidence: random() < 0.7 ? [`file:${PATHS[Math.floor(random() * 2)]!}`] : [],
      })),
    }
    : undefined;
  const receipts = random() < 0.7 ? [criterionReceipt((["pass", "fail", "unknown"] as const)[Math.floor(random() * 3)]!)] : undefined;
  const composed = composeVerdict({
    record, head: HEAD, kind: random() < 0.8 ? "reviewed" : "no-change", configured: CONFIGURED,
    ...(receipts === undefined ? {} : { receipts }),
    facts: { checksPassed: random() < 0.5, reviewApproved: true }, changedPaths: { paths: [PATHS[0]!], truncated: false },
    ...(report === undefined || report.criteria.length === 0 ? { reason: "evaluator-unavailable" as const } : { report }),
  });
  const next = verdictRecord(record, composed, { verdictId: id, kind: "reviewed", revision: 1, head: HEAD, at });
  return next === "log-full" ? undefined : next;
}

test("every version rebuilds after random verdict writes", () => {
  let verdicts = 0;
  let writes = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const random = mulberry32(seed);
    let record = baseRecord();
    const snapshots = new Map<number, string>([[record.version, canonicalJson(record)]]);
    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      const at = new Date(Date.UTC(2026, 10, 21, 0, step)).toISOString();
      const serial = String(seed * 100 + step).padStart(12, "0");
      const entryId = `6f1c2a3e-8b4d-4c5e-9f60-${serial}`;
      let next: ObjectiveRecord | undefined;
      try {
        if (roll < 0.3) {
          next = verdictWrite(record, random, entryId, at);
          if (next !== undefined) verdicts += 1;
        } else if (roll < 0.45) {
          const receipts = [random() < 0.5 ? "a1" : "a2"].map(id => receipt(id, id === "a1" ? "artifact" : "command", random() < 0.5 ? "pass" : "fail"));
          next = applyReceipts(record, receipts, { runId: RUN, revision: 1, kind: "reviewed", at })?.record;
        } else if (roll < 0.6) {
          const field: MemberProposal = random() < 0.4
            ? { id: "a1", stance: random() < 0.5 ? "supports" : "contradicts" }
            : { propose: { statement: `Proposed ${step} of ${seed}.`, refutedBy: "The check fails", test: { kind: "command", run: RANK, refutesOn: "fail" }, criticality: "plan" } } as MemberProposal;
          const proposal: Proposal = { entryId, memberId: "m1", revision: 1, authorRole: "reviewer", summary: `Finding ${step}.`, assumption: field };
          next = applyProposals(record, [proposal], { runId: RUN, configured: CONFIGURED, at }).record;
        } else if (roll < 0.8) {
          const ops = random() < 0.5
            ? [{ op: "assumption.set" as const, id: "a3", status: random() < 0.5 ? "verified" as const : "refuted" as const }]
            : [{ op: "rating.record" as const, subject: "s1", score: 1 + Math.floor(random() * 9) / 2 }];
          next = applyOwnerOps(record, { version: record.version, ops }, { configured: CONFIGURED, requestId: REQUEST, at, rating: { commit: HEAD, cycle: 1 } });
        } else {
          next = applyIntentReport(record, { kind: "intent-check", summary: "Checked.", items: [] }, {
            runId: RUN, revision: 1, checkerMemberId: "m1", decisionId: REQUEST, mode: "autonomous", goal: true, configured: CONFIGURED, at,
          }).record;
        }
      } catch {
        next = undefined;
      }
      if (next !== undefined) {
        writes += 1;
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
      assert.equal(rebuilt.version, version, `seed ${seed}, version ${version}: the rebuilt version`);
      assert.equal(rebuilt.criteria.length, (JSON.parse(snapshot) as ObjectiveRecord).criteria.length, `seed ${seed}, version ${version}: the criteria count`);
      assert.equal(objectiveRecordSchema.safeParse(rebuilt).success, true, `seed ${seed}, version ${version}: the rebuilt record does not parse`);
      assert.equal(canonicalJson(rebuilt) === snapshot, true,
        `seed ${seed}, version ${version}: the rebuilt record differs at key ${firstDiffKey(JSON.parse(snapshot), rebuilt)}`);
    }
  }
  assert.equal(verdicts > SEEDS, true, `only ${verdicts} verdict writes ran across ${SEEDS} seeds`);
  assert.equal(writes > verdicts, true, `only ${writes} writes ran`);
});
