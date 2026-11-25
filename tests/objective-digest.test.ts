import test from "node:test";
import assert from "node:assert/strict";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Project } from "../packages/host/src/types.js";
import type { Assumption, Check, Criterion, ObjectiveRecord, Question } from "../packages/host/src/objective-types.js";
import { objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { checkLabel, objectivePromptFor, objectivePromptOf, objectivePromptsOn, objectiveRegisterOn, recordDigestFor, registerDigestFor } from "../packages/host/src/objective-digest.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { RECORD_DIGEST_BYTES, RECORD_LABEL_BYTES, RECORD_REGISTER_BYTES, recordDigestBytes, recordDigestSchema, registerDigestBytes } from "../packages/host/src/team-types.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const AT = "2026-11-15T10:00:00.000Z";
const judgement = { kind: "judgement", item: "owner-text" } as const;
const test1 = { command: "npm", args: ["test"] } as TeamCommand;
const criterion = (id: string, overrides: Record<string, unknown> = {}): Criterion => ({
  id, origin: "owner", statement: `Statement ${id}.`, check: judgement, producer: "evaluator", threshold: { kind: "pass" }, state: "active", ...overrides,
}) as Criterion;
const projectWith = (objective: unknown) => ({ team: { checks: [], establishChecks: true, objective } }) as unknown as Pick<Project, "team">;

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

const BASE_DIGEST_JSON = '{"version":1,"criteria":[{"id":"c0","statement":"","check":"judgement:owner-text","producer":"evaluator"},{"id":"c1","statement":"Tests pass.","check":"command:npm test","producer":"host"},{"id":"c2","statement":"The summary is clear.","check":"judgement:owner-text","producer":"evaluator"}]}';

test("the digest marks derived criteria and nothing else", () => {
  const owner = hostRecord();
  assert.equal(JSON.stringify(recordDigestFor(owner, [test1])), BASE_DIGEST_JSON, "a record without derived criteria gives the base digest byte for byte");

  const base = hostRecord();
  const criteria = base.criteria.map(item => (item.id === "c2" ? { ...item, origin: "derived" as const, derivedFrom: "ranked sources" } : item));
  const record = objectiveRecordSchema.parse({ ...base, criteria, digest: recordDigest({ ...base, criteria }) });
  const digest = recordDigestFor(record, [test1]);
  assert.deepEqual(digest.criteria.map(item => [item.id, "derived" in item]), [["c0", false], ["c1", false], ["c2", true]], "only the derived criterion is marked");
  assert.equal(digest.criteria[2]?.derived, true);
  assert.deepEqual(Object.keys(digest.criteria[2] ?? {}), ["id", "statement", "check", "producer", "derived"], "the marker follows producer");
  assert.ok(recordDigestSchema.safeParse(digest).success, "the marked digest parses with the digest schema");
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

const registerRecord = (assumptions: Assumption[], questions: Question[]): ObjectiveRecord => ({ ...hostRecord(), assumptions, questions });
const assumption = (id: string, origin: Assumption["origin"], status: Assumption["status"], criticality: Assumption["criticality"], statement: string): Assumption =>
  ({ id, statement, status, origin, criticality, refutedBy: "The owner refutes it.", test: { kind: "owner" }, evidence: [], proposals: [] });
const question = (id: string, state: Question["state"], text: string): Question => ({ id, text, assumptions: [], waits: false, state });

test("the register digest has its own budget and no member text", () => {
  const statuses = ["refuted", "unchecked", "assumed", "verified"] as const;
  const criticalities = ["outcome", "plan", "detail"] as const;
  const assumptions = Array.from({ length: 32 }, (_, index): Assumption => {
    const n = index + 1;
    const member = n % 5 === 0;
    return assumption(`a${n}`, member ? "member" : n % 2 === 0 ? "owner" : "intent-check", statuses[n % 4]!, criticalities[n % 3]!, member ? `MEMBER-TEXT a${n}` : `Assumption a${n} ${"x".repeat(300)}`);
  });
  const questions = Array.from({ length: 10 }, (_, index) => question(`q${index + 1}`, index === 9 ? "answered" : "open", `Question ${index + 1} ${"y".repeat(200)}`));
  const digest = registerDigestFor(registerRecord(assumptions, questions));

  const memberIds = new Set(assumptions.filter(item => item.origin === "member").map(item => item.id));
  assert.equal(digest.assumptions.some(item => memberIds.has(item.id)), false, "no member assumption enters the digest");
  assert.equal(JSON.stringify(digest).includes("MEMBER-TEXT"), false, "no member text reaches the digest");

  const rank = (item: Assumption) => statuses.indexOf(item.status) * 100 + criticalities.indexOf(item.criticality) * 10;
  const ordered = assumptions.filter(item => item.origin !== "member")
    .sort((a, b) => rank(a) - rank(b) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  assert.deepEqual(digest.assumptions.map(item => item.id), ordered.slice(0, digest.assumptions.length).map(item => item.id), "the kept assumptions are the first of the rule's order");

  assert.ok(registerDigestBytes(digest) <= RECORD_REGISTER_BYTES, "the register is within its own 6,144 bytes");
  const openQuestions = questions.filter(item => item.state === "open");
  const left = (ordered.length - digest.assumptions.length) + (openQuestions.length - digest.questions.length);
  assert.equal(digest.omitted, left, "omitted counts every assumption and open question left out, and no member");
  assert.ok(left > 0, "the fixture is large enough to cut");

  const small = registerDigestFor(registerRecord([assumption("a1", "owner", "verified", "detail", "Small.")], [question("q1", "open", "Why?")]));
  assert.deepEqual(small, { assumptions: [{ id: "a1", status: "verified", criticality: "detail", statement: "Small." }], questions: [{ id: "q1", text: "Why?" }] }, "a small record keeps everything with no omitted count");
  assert.deepEqual(registerDigestFor(registerRecord([], [])), { assumptions: [], questions: [] }, "an empty record gives an empty register with no omitted count");

  const filler = Array.from({ length: 11 }, (_, index) => assumption(`a${index + 1}`, "owner", "refuted", "outcome", "z".repeat(470)));
  const cut = registerDigestFor(registerRecord(
    [...filler, assumption("a12", "owner", "refuted", "outcome", "z".repeat(470)), assumption("a13", "owner", "unchecked", "outcome", "Small.")],
    [question("q1", "open", "Why?")],
  ));
  assert.deepEqual(cut.assumptions.map(item => item.id), filler.map(item => item.id));
  assert.equal(cut.omitted, 3);
});

test("the objective prompt shape follows the digest, the register, and the mode", () => {
  const digest = recordDigestFor(hostRecord(), [test1]);
  const withRegister = { ...digest, register: { assumptions: [], questions: [] } };
  assert.equal(objectivePromptOf({ goal: undefined, autonomy: undefined } as never), false, "no goal record gives false");
  assert.equal(objectivePromptOf({ goal: { record: digest }, autonomy: undefined } as never), true, "a record without a register gives true");
  assert.equal(objectivePromptOf({ goal: { record: withRegister }, autonomy: undefined } as never), "register", "an unpinned run with a register gives register");
  assert.equal(objectivePromptOf({ goal: { record: withRegister }, autonomy: "supervised" } as never), "register", "a supervised run gives register");
  assert.equal(objectivePromptOf({ goal: { record: withRegister }, autonomy: "autonomous" } as never), "register-autonomous", "an autonomous run gives register-autonomous");

  assert.equal(objectivePromptFor(undefined, "autonomous"), false, "an undefined project gives false");
  assert.equal(objectivePromptFor(projectWith({ prompts: "off", register: "on" }), "supervised"), false, "prompts off gives false");
  assert.equal(objectivePromptFor(projectWith({ prompts: "on" }), "autonomous"), true, "prompts on with the register off gives true");
  assert.equal(objectivePromptFor(projectWith({ prompts: "on", register: "on" }), "supervised"), "register", "both on, supervised, gives register");
  assert.equal(objectivePromptFor(projectWith({ prompts: "on", register: "on" }), "autonomous"), "register-autonomous", "both on, autonomous, gives register-autonomous");

  assert.equal(objectiveRegisterOn(undefined), false, "an undefined project has no register");
  assert.equal(objectiveRegisterOn(projectWith({ register: "off" })), false, "off is not on");
  assert.equal(objectiveRegisterOn(projectWith({ register: "on" })), true, "on is on");
});

test("the criteria shapes follow the goal's rows", () => {
  const digest = recordDigestFor(hostRecord(), [test1]);
  const withRegister = { ...digest, register: { assumptions: [], questions: [] } };
  const criteria = [{ criterion: "c1", status: "met", check: "command:npm test" }];
  assert.equal(objectivePromptOf({ goal: { record: digest, criteria }, autonomy: undefined } as never), "criteria", "rows without a register");
  assert.equal(objectivePromptOf({ goal: { record: withRegister, criteria }, autonomy: "supervised" } as never), "register-criteria", "rows with a register, supervised");
  assert.equal(objectivePromptOf({ goal: { record: withRegister, criteria }, autonomy: "autonomous" } as never), "register-autonomous-criteria", "rows with a register, autonomous");
  assert.equal(objectivePromptOf({ goal: { record: digest }, autonomy: undefined } as never), true, "no rows, today's value");
  assert.equal(objectivePromptOf({ goal: { record: withRegister }, autonomy: "autonomous" } as never), "register-autonomous", "no rows, today's register value");
  assert.equal(objectivePromptOf({ goal: { criteria }, autonomy: undefined } as never), false, "rows without a digest change nothing");
});
