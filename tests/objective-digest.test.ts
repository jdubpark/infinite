import test from "node:test";
import assert from "node:assert/strict";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Project } from "../packages/host/src/types.js";
import type { Check, Criterion, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { checkLabel, objectivePromptsOn, recordDigestFor } from "../packages/host/src/objective-digest.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { RECORD_DIGEST_BYTES, RECORD_LABEL_BYTES, recordDigestBytes, recordDigestSchema } from "../packages/host/src/team-types.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const AT = "2026-11-15T10:00:00.000Z";
const judgement = { kind: "judgement", item: "owner-text" } as const;
const test1 = { command: "npm", args: ["test"] } as TeamCommand;
/** A criterion whose producer fits its check: a judgement is the evaluator's, as objectiveRecordSchema requires. */
const criterion = (id: string, overrides: Record<string, unknown> = {}): Criterion => ({
  id, origin: "owner", statement: `Statement ${id}.`, check: judgement, producer: "evaluator", threshold: { kind: "pass" }, state: "active", ...overrides,
}) as Criterion;
const projectWith = (objective: unknown) => ({ team: { checks: [], establishChecks: true, objective } }) as unknown as Pick<Project, "team">;

/** The record the host writes for a goal, with criteria appended and c0 moved last, so the digest must put c0 first. */
function hostRecord(): ObjectiveRecord {
  const goal = {
    id: GOAL_ID, objective: "Find ranked sources for the research brief.", successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: [], allowedPaths: ["research"], evidence: [], steering: [],
  } as unknown as ProductGoal;
  const built = goalRecord(goal, AT, "created");
  if (built === "source-invalid") throw new Error("the fixture goal must build a record");
  const c0 = built.criteria[0] as Criterion;
  const criteria = [
    criterion("c1", { statement: "Tests pass.", check: { kind: "command", command: commandDigest(test1) }, producer: "host" }),
    criterion("c2", { statement: "The summary is clear." }),
    criterion("c3", { statement: "Retired.", state: "retired" }),
    c0,
  ];
  return objectiveRecordSchema.parse({ ...built, criteria, digest: recordDigest({ ...built, criteria }) });
}

test("the digest lists active criteria with c0 first and empty", () => {
  const record = hostRecord();
  assert.deepEqual(record.criteria.map(item => item.id), ["c1", "c2", "c3", "c0"], "the record puts c0 last");
  const digest = recordDigestFor(record, [test1]);
  assert.deepEqual(digest.criteria.map(item => item.id), ["c0", "c1", "c2"], "the digest puts c0 first and drops the retired criterion");
  assert.deepEqual(digest.criteria.map(item => item.producer), ["evaluator", "host", "evaluator"]);
  assert.deepEqual(digest.criteria[0], { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" });
  assert.equal(digest.criteria[1]?.check, "command:npm test");
  assert.equal(digest.criteria[1]?.statement, "Tests pass.");
  assert.equal(digest.version, record.version);
  assert.ok(recordDigestSchema.safeParse(digest).success, "the digest parses with the digest schema");
  assert.equal(recordDigestBytes(digest), Buffer.byteLength(JSON.stringify(digest)));
});

test("labels are bounded and plain", () => {
  const withNewline = { command: "npm", args: ["run", "a\nb", "c\td"] } as TeamCommand;
  assert.equal(checkLabel({ kind: "command", command: commandDigest(withNewline) }, [withNewline]), "command:npm run a b c d", "control characters become spaces");
  const unconfigured = { kind: "command", command: commandDigest(test1) } as const;
  assert.equal(checkLabel(unconfigured, []), `command:${commandDigest(test1).slice(0, 12)} (not configured)`, "an unconfigured command shows 12 hex digits");
  assert.equal(checkLabel({ kind: "receipt", receipt: "checks-passed" }, []), "receipt:checks-passed");
  assert.equal(checkLabel({ kind: "artifact", path: "docs/x.md" }, []), "artifact:docs/x.md");
  assert.equal(checkLabel({ kind: "citations", path: "docs/x.md", entries: "/entries", perEntry: 1 }, []), "citations:docs/x.md");
  assert.equal(checkLabel({ kind: "citation-form", path: "docs/x.md", entries: "/entries", perEntry: 1 }, []), "citation-form:docs/x.md");
  assert.equal(checkLabel({ kind: "judgement", item: "owner-text" }, []), "judgement:owner-text");
  assert.equal(checkLabel({ kind: "owner-rating", subject: "tone" }, []), "owner-rating:tone");

  const c1Path = checkLabel({ kind: "artifact", path: "docs/a\u0085b\u009bc.md" }, []);
  assert.equal(c1Path, "artifact:docs/a b c.md", "C1 controls become spaces");
  const separators = checkLabel({ kind: "citations", path: "docs/a\u2028b\u2029c.md", entries: "/entries", perEntry: 1 }, []);
  assert.equal(separators, "citations:docs/a b c.md", "line and paragraph separators become spaces");

  const exact = { command: "x".repeat(112), args: [] } as TeamCommand;
  const exactLabel = checkLabel({ kind: "command", command: commandDigest(exact) }, [exact]);
  assert.equal(Buffer.byteLength(exactLabel), RECORD_LABEL_BYTES, "a label of exactly 120 bytes is kept");
  assert.ok(!exactLabel.endsWith("..."));

  const over = { command: "x".repeat(113), args: [] } as TeamCommand;
  const overLabel = checkLabel({ kind: "command", command: commandDigest(over) }, [over]);
  assert.equal(overLabel, `command:${"x".repeat(109)}...`, "a label of 121 bytes ends with three dots inside 120 bytes");
  assert.equal(Buffer.byteLength(overLabel), RECORD_LABEL_BYTES);

  const wide = { command: "é".repeat(150), args: [] } as TeamCommand;
  const wideLabel = checkLabel({ kind: "command", command: commandDigest(wide) }, [wide]);
  assert.equal(wideLabel, `command:${"é".repeat(54)}...`, "the cut keeps each two-byte character whole");
  assert.ok(Buffer.byteLength(wideLabel) <= RECORD_LABEL_BYTES);

  const threeByte = { command: "ab" + "€".repeat(100), args: [] } as TeamCommand;
  const threeByteLabel = checkLabel({ kind: "command", command: commandDigest(threeByte) }, [threeByte]);
  assert.equal(threeByteLabel, `command:ab${"€".repeat(35)}...`, "the cut keeps each three-byte character whole");
  assert.equal(Buffer.byteLength(threeByteLabel), 118);
});

test("the digest schema refuses what the rule refuses", () => {
  const entry = (id: string, statement = `Statement ${id}.`) => ({ id, statement, check: "judgement:owner-text", producer: "owner" as const });
  const ok = { version: 2, criteria: [entry("c0", ""), entry("c1")] };
  assert.ok(recordDigestSchema.safeParse(ok).success, "the baseline digest parses");
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: [entry("c1"), entry("c0", "")] }).success, "c0 not first fails");
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: [entry("c0", "text")] }).success, "c0 with text fails");
  const nine = [entry("c0", ""), ...Array.from({ length: 8 }, (_, index) => entry(`c${index + 1}`))];
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: nine }).success, "nine criteria fail");
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: [entry("c0", ""), { ...entry("c1"), check: "x".repeat(121) }] }).success, "a 121-byte label fails");
  assert.ok(recordDigestSchema.safeParse({ version: 2, criteria: [entry("c0", ""), { ...entry("c1"), check: "x".repeat(120) }] }).success, "a 120-byte label parses");
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: [entry("c0", ""), entry("c1", "x".repeat(1001))] }).success, "a 1,001-byte statement fails");
  assert.ok(!recordDigestSchema.safeParse({ version: 2, criteria: [entry("c0", ""), entry("c1", "")] }).success, "an empty statement fails");

  // Six 1,000-byte statements and one more, sized so the digest is exactly the cap, then one byte over.
  const padded = (pad: number) => ({ version: 2, criteria: [entry("c0", ""), ...Array.from({ length: 5 }, (_, index) => entry(`c${index + 1}`, "x".repeat(1000))), entry("c6", "y".repeat(pad))] });
  let atCap = 0;
  for (let pad = 1; pad <= 1000 && !atCap; pad += 1) if (Buffer.byteLength(JSON.stringify(padded(pad))) === RECORD_DIGEST_BYTES) atCap = pad;
  assert.ok(atCap > 0, "a digest of exactly 6,144 bytes exists");
  assert.equal(recordDigestBytes(padded(atCap) as never), RECORD_DIGEST_BYTES);
  assert.ok(recordDigestSchema.safeParse(padded(atCap)).success, "a digest of exactly 6,144 bytes parses");
  assert.equal(recordDigestBytes(padded(atCap + 1) as never), RECORD_DIGEST_BYTES + 1);
  assert.ok(!recordDigestSchema.safeParse(padded(atCap + 1)).success, "a digest one byte over the cap fails");
});

test("the switch reads only on", () => {
  assert.equal(objectivePromptsOn(undefined), false, "an undefined project is off");
  assert.equal(objectivePromptsOn({ team: undefined }), false, "a project without a team is off");
  assert.equal(objectivePromptsOn(projectWith(undefined)), false, "a team without the key is off");
  assert.equal(objectivePromptsOn(projectWith({ prompts: "off" })), false, "off is off");
  assert.equal(objectivePromptsOn(projectWith({ prompts: "on" })), true, "on is on");
});
