import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { MemberProposal } from "../packages/host/src/evidence/member-proposal.js";
import { applyProposals, PROPOSAL_LIMITS } from "../packages/host/src/objective-proposals.js";
import type { Proposal, ProposalContext, ProposalDrop } from "../packages/host/src/objective-proposals.js";
import { goalRecord, REGISTER_OPS, rebuildVersion } from "../packages/host/src/objective-record.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { cappedBytes, objectiveRecordSchema, recordDigest, OBJECTIVE_LIMITS } from "../packages/host/src/objective-types.js";
import type { Assumption, AssumptionTest, LogEntry, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const RUN_ID = "7a2d3b4f-9c5e-4d6f-8a71-8293a4b5c6d7";
const AT = "2026-11-17T09:00:00.000Z";
const LATER = "2026-11-17T10:00:00.000Z";

const LINT: TeamCommand = { command: "npm", args: ["run", "lint"] };
const CONFIGURED: TeamCommand[] = [LINT];
const LINT_TEST = { kind: "command", run: LINT, refutesOn: "fail" };
const OWNER_TEST: AssumptionTest = { kind: "owner" };
const CONTEXT: ProposalContext = { runId: RUN_ID, configured: CONFIGURED, at: LATER };
const NO_DROPS: Record<ProposalDrop, number> = { test: 0, command: 0, secret: 0, target: 0, attempt: 0, stances: 0, assumptions: 0, bytes: 0, log: 0, refused: 0 };

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

/** Version 1 of a goal's record: c0 only, one log entry. */
function v1(): ObjectiveRecord {
  const record = goalRecord(goalFixture(), AT, "created");
  if (typeof record === "string") throw new Error(`the fixture record is ${record}`);
  return record;
}

/** Version 1 with `assumptions` in place of none. The digest is recomputed, and the schema must accept the fixture. */
function recordWith(assumptions: Assumption[], log?: LogEntry[]): ObjectiveRecord {
  const base = v1();
  const body = { ...base, assumptions, ...(log ? { log } : {}) };
  return objectiveRecordSchema.parse({ ...body, digest: recordDigest(body) });
}

function assumption(id: string, overrides: Partial<Assumption> = {}): Assumption {
  return {
    id,
    statement: `Statement ${id}`,
    status: "unchecked",
    origin: "intent-check",
    criticality: "plan",
    refutedBy: `Refuted by ${id}`,
    test: OWNER_TEST,
    evidence: [],
    proposals: [],
    ...overrides,
  };
}

function propose(statement: string, test: unknown = LINT_TEST, criticality: "outcome" | "plan" | "detail" = "plan"): MemberProposal {
  return { propose: { statement, refutedBy: `Refuted by ${statement}`, test, criticality } };
}

function proposal(memberId: string, entryId: string, assumptionField: MemberProposal, overrides: Partial<Proposal> = {}): Proposal {
  return { entryId, memberId, revision: 1, authorRole: "scout", summary: `Summary ${entryId}`, assumption: assumptionField, ...overrides };
}

const digestOf = (value: unknown): string => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");

/** Entries of the proposal kind that `record` holds after `from` entries. */
function registerEntriesAfter(record: ObjectiveRecord, from: number): LogEntry[] {
  return record.log.slice(from).filter(entry => entry.op === REGISTER_OPS.proposed);
}

test("acceptance 5, proposal side: a contradicting finding attaches and changes no status", () => {
  const record = recordWith([assumption("a2", { criticality: "plan" })]);
  const before = record.assumptions[0]!;

  const result = applyProposals(record, [proposal("scout-1", "entry-1", { id: "a2", stance: "contradicts" })], CONTEXT);

  assert.ok(result.record, "a contradicting finding applies");
  const next = result.record;
  assert.equal(result.attached, 1);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.dropped, NO_DROPS);
  assert.equal(next.version, record.version + 1);

  const a2 = next.assumptions.find(item => item.id === "a2")!;
  assert.equal(a2.status, before.status);
  assert.deepEqual(a2.test, before.test);
  assert.equal(a2.criticality, before.criticality);
  assert.equal(a2.statement, before.statement);
  assert.deepEqual(a2.proposals, [{ entryId: "entry-1", stance: "contradicts", summary: "Summary entry-1", authorRole: "scout" }]);

  const entries = registerEntriesAfter(next, record.log.length);
  assert.equal(entries.length, 1, "one proposal.recorded entry");
  const [entry] = entries;
  assert.equal(entry!.actor, "member");
  assert.equal(entry!.authority, "claim");
  assert.equal(entry!.target, "scout-1");
  assert.equal(entry!.handle, RUN_ID);
  assert.equal(entry!.version, next.version);
  assert.deepEqual(entry!.after, {
    inline: { revision: 1, added: [], addedDigest: digestOf([]), attached: [{ id: "a2", entryId: "entry-1" }] },
  });
  assert.equal(entry!.before, undefined);

  assert.deepEqual(rebuildVersion(next, record.version), record, "rebuilding before the page undoes the stance");
});

test("a member proposes at most four assumptions per attempt", () => {
  const record = recordWith([]);
  const names = ["one", "two", "three", "four", "five", "six"];
  const page = names.map(name => proposal("scout-1", `entry-${name}`, propose(`Plan statement ${name}`)));

  const first = applyProposals(record, page, CONTEXT);
  assert.ok(first.record, "the first four apply");
  assert.deepEqual(first.added, ["a1", "a2", "a3", "a4"]);
  assert.equal(first.dropped.attempt, 2, "the fifth and sixth drop under attempt");
  const members = first.record.assumptions.filter(item => item.origin === "member");
  assert.equal(members.length, 4);
  assert.ok(members.every(item => item.status === "unchecked"));
  assert.deepEqual(members[0]!.proposals, [{ entryId: "entry-one", stance: "supports", summary: "Summary entry-one", authorRole: "scout" }],
    "the proposing entry supports the assumption it created");
  assert.deepEqual(rebuildVersion(first.record, record.version), record, "rebuilding undoes the four additions");

  const second = applyProposals(first.record, [proposal("scout-1", "entry-seven", propose("Plan statement seven"))], CONTEXT);
  assert.equal(second.record, undefined, "a second page from the same member adds none");
  assert.equal(second.dropped.attempt, 1);

  const other = applyProposals(first.record, [proposal("scout-2", "entry-eight", propose("Other member statement"))], CONTEXT);
  assert.deepEqual(other.added, ["a5"], "another member adds its own four");
  assert.equal(other.dropped.attempt, 0);
  assert.deepEqual(rebuildVersion(other.record!, first.record.version), first.record, "rebuilding one version back undoes the other member's entry");
});

test("proposals apply once", () => {
  const record = recordWith([assumption("a2")]);
  const page = [
    proposal("scout-1", "entry-1", propose("Plan statement one")),
    proposal("scout-1", "entry-1", propose("Plan statement one")),
    proposal("scout-1", "entry-2", { id: "a2", stance: "supports" }),
  ];

  const first = applyProposals(record, page, CONTEXT);
  assert.ok(first.record, "the page applies once");
  assert.deepEqual(first.dropped, NO_DROPS, "a repeated entry is skipped and not counted");

  const again = applyProposals(first.record, page, CONTEXT);
  assert.equal(again.record, undefined, "the same page applied again returns no record");
  assert.deepEqual(again.added, []);
  assert.equal(again.attached, 0);
  assert.deepEqual(again.dropped, NO_DROPS, "and counts no drop");
});

test("bad proposals are dropped and counted, never echoed", () => {
  const privateKey = "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----";
  const token = "gh" + "p_" + "a".repeat(36);
  const proxy = "v1." + "1700000000" + "." + "A".repeat(43);
  const base = recordWith([assumption("a2"), ...Array.from({ length: 8 }, (_, index) => assumption(`a${index + 3}`))]);

  const unconfigured = applyProposals(base, [proposal("scout-1", "entry-command", propose("Unconfigured", { kind: "command", run: { command: "make", args: ["lint"] }, refutesOn: "fail" }))], CONTEXT);
  assert.equal(unconfigured.dropped.command, 1);

  const shape = applyProposals(base, [proposal("scout-1", "entry-shape", propose("Bad shape", { kind: "unknown-kind" }))], CONTEXT);
  assert.equal(shape.dropped.test, 1);

  // Every secret shape in every place: statement, summary, and test. Each drops as secret and is never echoed.
  const shapes = [privateKey, token, proxy];
  const places = ["statement", "summary", "test"] as const;
  for (const shape of shapes) {
    for (const place of places) {
      const cleanTest = { kind: "owner", note: "clean" };
      const item = place === "statement"
        ? proposal("scout-1", `entry-secret-${place}`, propose(shape))
        : place === "summary"
          ? proposal("scout-1", `entry-secret-${place}`, propose("Clean statement"), { summary: shape })
          : proposal("scout-1", `entry-secret-${place}`, propose("Clean test", { ...cleanTest, note: shape }));
      const result = applyProposals(base, [item], CONTEXT);
      assert.equal(result.dropped.secret, 1, `a secret in the ${place} drops as secret`);
      assert.equal(result.record, undefined, `a secret in the ${place} changes no record`);
      assert.equal(JSON.stringify(result).includes(shape), false, `a secret in the ${place} is never echoed`);
    }
  }

  const missing = applyProposals(base, [proposal("scout-1", "entry-target", { id: "a99", stance: "supports" })], CONTEXT);
  assert.equal(missing.dropped.target, 1);

  const crowded = recordWith([
    assumption("a2", { proposals: Array.from({ length: OBJECTIVE_LIMITS.proposalsPerAssumption }, (_, index) => ({ entryId: `old-${index}`, stance: "supports" as const, summary: "Old", authorRole: "scout" })) }),
  ]);
  const ninth = applyProposals(crowded, [proposal("scout-1", "entry-ninth", { id: "a2", stance: "contradicts" })], CONTEXT);
  assert.equal(ninth.dropped.stances, 1);

  const full = recordWith(Array.from({ length: OBJECTIVE_LIMITS.assumptions }, (_, index) => assumption(`a${index + 1}`)));
  const thirtyThird = applyProposals(full, [proposal("scout-1", "entry-full", propose("Thirty third"))], CONTEXT);
  assert.equal(thirtyThird.dropped.assumptions, 1);

  // Capped bytes: add filler assumptions while one more would stay within the schema's own cap, then propose one that overflows.
  const filler = (index: number) => assumption(`a${index}`, { statement: "x".repeat(500), refutedBy: "y".repeat(500) });
  const fillers: Assumption[] = [];
  const sized = (list: Assumption[]) => cappedBytes({ ...base, assumptions: list } as ObjectiveRecord);
  while (sized([...fillers, filler(fillers.length + 1)]) <= PROPOSAL_LIMITS.cappedBytes) fillers.push(filler(fillers.length + 1));
  const heavy = recordWith(fillers);
  const overflow = applyProposals(heavy, [proposal("scout-1", "entry-bytes", propose("z".repeat(500)))], CONTEXT);
  assert.equal(overflow.dropped.bytes, 1);

  // Stances count against the same share: top the record up to within one stance of it, then attach one with a full summary.
  const small = (index: number) => assumption(`a${index}`, { statement: "x".repeat(100), refutedBy: "y" });
  const topped = [...fillers];
  while (sized([...topped, small(topped.length + 1)]) <= PROPOSAL_LIMITS.cappedBytes) topped.push(small(topped.length + 1));
  const stanceOver = applyProposals(recordWith(topped), [proposal("scout-1", "entry-stance-bytes", { id: "a1", stance: "contradicts" }, { summary: "s".repeat(240) })], CONTEXT);
  assert.equal(stanceOver.dropped.bytes, 1, "a stance past the capped-bytes share drops as bytes");
  assert.equal(stanceOver.record, undefined);

  // Members hold at most 16 of the 32 assumptions, so one intent check's 16 items still fit.
  const memberHeld = recordWith(Array.from({ length: 16 }, (_, index) => assumption(`a${index + 1}`, { origin: "member" })));
  const seventeenth = applyProposals(memberHeld, [proposal("scout-1", "entry-share", propose("Seventeenth member assumption"))], CONTEXT);
  assert.equal(seventeenth.dropped.assumptions, 1, "a seventeenth member assumption drops as assumptions");

  const logFull = recordWith([assumption("a2")], [
    ...v1().log,
    ...Array.from({ length: PROPOSAL_LIMITS.log.entries - 1 }, (_, index) => ({
      seq: index + 2, at: AT, version: 1, actor: "intent-check" as const, authority: "claim" as const,
      op: "intent-check.skipped", target: RUN_ID,
    })),
  ]);
  assert.equal(logFull.log.length, PROPOSAL_LIMITS.log.entries);
  const logged = applyProposals(logFull, [proposal("scout-1", "entry-log", propose("Log full")), proposal("scout-1", "entry-log-2", { id: "a2", stance: "supports" })], CONTEXT);
  assert.equal(logged.dropped.log, 2, "a log at 300 entries drops every proposal of the page under log");
  assert.equal(logged.record, undefined);

  const refusedContext = applyProposals(base, [proposal("scout-1", "entry-refused", propose("Refused"))], { ...CONTEXT, at: "not-a-time" });
  assert.equal(refusedContext.dropped.refused, 1, "a result the schema refuses counts under refused");
  assert.equal(refusedContext.record, undefined);

  const foreign = applyProposals(base, [proposal("scout-1", "entry-own", propose("Own plan")), proposal("scout-2", "entry-foreign", propose("Foreign plan"))], CONTEXT);
  assert.equal(foreign.dropped.refused, 1, "another member's proposal in the page drops as refused");
  assert.equal(foreign.added.length, 1);
  assert.ok(!foreign.record?.assumptions.some(item => item.statement === "Foreign plan"), "another member's proposal applied");

  const mixed = applyProposals(base, [proposal("scout-1", "entry-secret-mixed", propose(privateKey)), proposal("scout-1", "entry-target-2", { id: "a99", stance: "supports" })], CONTEXT);
  assert.equal(mixed.record, undefined, "a record that only drops is unchanged");
  assert.deepEqual(mixed.added, []);
});

test("the order of members' pages does not change the result", () => {
  const base = recordWith(Array.from({ length: OBJECTIVE_LIMITS.assumptions - 2 }, (_, index) => assumption(`a${index + 1}`)));
  const pages = [
    [proposal("scout-1", "entry-alpha", propose("Alpha plan"))],
    [proposal("scout-2", "entry-beta", propose("Beta plan"))],
    [proposal("reviewer-3", "entry-gamma", { id: "a1", stance: "supports" }), proposal("reviewer-3", "entry-delta", { id: "a2", stance: "contradicts" })],
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

  const signatures = orders.map(order => {
    let record = base;
    const added: string[][] = [];
    const dropped: Record<ProposalDrop, number>[] = [];
    for (const index of order) {
      const result = applyProposals(record, pages[index]!, CONTEXT);
      if (result.record) record = result.record;
      added.push(result.added);
      dropped.push(result.dropped);
    }
    const shape = record.assumptions.map(item => [item.proposals.map(stance => stance.entryId).sort(), item.statement, item.status, item.origin]);
    return canonicalJson({ shape: shape.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))), addedCount: added.flat().length, dropped });
  });

  for (const signature of signatures) assert.equal(signature, signatures[0], "every order gives the same result");
});

test("a page's stances chunk into entries of at most 16 that rebuild", () => {
  const record = recordWith([assumption("a1"), assumption("a2"), assumption("a3")]);
  const stances = Array.from({ length: 17 }, (_, index) => {
    const target = index < 6 ? "a1" : index < 12 ? "a2" : "a3";
    return proposal("reviewer-1", `entry-${index}`, { id: target, stance: "supports" });
  });

  const result = applyProposals(record, stances, CONTEXT);
  assert.ok(result.record, "the page applies");
  assert.equal(result.attached, 17);
  const entries = registerEntriesAfter(result.record, record.log.length);
  assert.equal(entries.length, 2, "17 attachments need two entries at one version");
  for (const entry of entries) {
    assert.equal(entry.version, result.record.version);
    assert.ok(canonicalJson(entry.after).length <= 2048, "each entry stays inline");
  }
  const attachedTotal = entries.reduce((total, entry) => total + ((entry.after as { inline: { attached: unknown[] } }).inline.attached.length), 0);
  assert.equal(attachedTotal, 17);
  assert.deepEqual(rebuildVersion(result.record, record.version), record, "rebuilding undoes every chunk");
});

test("a stance on an assumption added in the same page drops as target", () => {
  const record = recordWith([]);
  // The first proposal of an empty record receives the id a1, which the second proposal then names.
  const page = [
    proposal("scout-1", "entry-new", propose("Plan statement added here")),
    proposal("scout-1", "entry-stance", { id: "a1", stance: "supports" }),
  ];

  const result = applyProposals(record, page, CONTEXT);
  assert.ok(result.record, "the addition applies");
  assert.deepEqual(result.added, ["a1"]);
  assert.equal(result.attached, 0);
  assert.equal(result.dropped.target, 1, "the stance on the same-page addition drops as target");
  assert.equal(result.record.assumptions.length, 1);
  assert.equal(result.record.assumptions[0]!.proposals.length, 1, "only the creating proposal is attached");
  assert.deepEqual(rebuildVersion(result.record, record.version), record, "rebuilding undoes the page exactly");
});
