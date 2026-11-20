import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  expandedTotal,
  readGrantSchema,
  readRequestSchema,
  readResultSchema,
  refusalText,
  stepKey,
  validateReadRequest,
  type ReadGrant,
  type ReadRequest,
  type ReadStep,
} from "../packages/host/src/read-request.js";

const evidence = [{ source: "packages/host/src/teams.ts:10", observation: "The check runs before launch." }];

function step(overrides: Partial<ReadStep> & { id: string }): ReadStep {
  return {
    title: `Read ${overrides.id}`,
    instructions: `Find the ${overrides.id} rules in the team code.`,
    agentProfileId: "reader-a",
    output: "findings",
    ...overrides,
  };
}

function request(phases: ReadStep[][], extra: Partial<ReadRequest> = {}): ReadRequest {
  return {
    kind: "read",
    summary: "Gather evidence before planning.",
    phases: phases.map((steps, index) => ({ id: `phase-${index + 1}`, steps })),
    ...extra,
  };
}

function grant(overrides: Partial<ReadGrant> = {}): ReadGrant {
  return {
    requester: "project-manager",
    poolOn: true,
    profiles: ["reader-a", "lister", "outside-reader"],
    routerCoversScout: false,
    limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 24, outside: true },
    allowanceLeft: 40,
    outsideProfiles: ["outside-reader"],
    lineage: { state: "new", uncleared: [] },
    requestsSent: 0,
    activeSteps: [],
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateReadRequest>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors.map(item => item.code);
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const HEAD = "a".repeat(40);
const HEAD_B = "b".repeat(64);

function listStep(id: string): ReadStep {
  return step({ id, output: "list", instructions: `List the ${id} items.` });
}

test("a minimal valid request passes the validator and reports its totals and keys", () => {
  const parsed = readRequestSchema.parse(request([[step({ id: "scan" })]]));
  const result = validateReadRequest(parsed, grant());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.total, 1);
  assert.deepEqual(result.phases, [1]);
  assert.equal(result.keys.scan, stepKey(parsed.phases[0].steps[0]));
});

test("unknown-profile fires for a profile outside the pool and for a missing profile without router scout coverage", () => {
  const unknown = validateReadRequest(request([[step({ id: "scan", agentProfileId: "nobody" })]]), grant());
  assert.deepEqual(codes(unknown), ["unknown-profile"]);
  const missing = validateReadRequest(request([[step({ id: "scan", agentProfileId: undefined })]]), grant());
  assert.deepEqual(codes(missing), ["unknown-profile"]);
  const covered = validateReadRequest(request([[step({ id: "scan", agentProfileId: undefined })]]), grant({ routerCoversScout: true }));
  assert.equal(covered.ok, true);
});

test("forward-reference fires for a missing target, a same-phase target and a target that is not a list", () => {
  const missing = validateReadRequest(request([[step({ id: "fan", forEach: { step: "ghost", maxItems: 2 } })]]), grant());
  assert.deepEqual(codes(missing), ["forward-reference"]);
  const samePhase = validateReadRequest(request([[listStep("items"), step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]]), grant());
  assert.deepEqual(codes(samePhase), ["forward-reference"]);
  const notList = validateReadRequest(request([[step({ id: "items" })], [step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]]), grant());
  assert.deepEqual(codes(notList), ["forward-reference"]);
  const valid = validateReadRequest(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]]), grant());
  assert.equal(valid.ok, true);
});

test("repeated-step fires for a shared id and for a shared key", () => {
  const sharedId = validateReadRequest(request([[step({ id: "scan" }), step({ id: "scan", instructions: "Other brief." })]]), grant());
  assert.deepEqual(codes(sharedId), ["repeated-step"]);
  const sharedKey = validateReadRequest(request([[step({ id: "a", instructions: "Find the shared rules." }), step({ id: "b", title: "Renamed", instructions: "Find  the shared rules." })]]), grant());
  assert.deepEqual(codes(sharedKey), ["repeated-step"]);
  assert.equal(validateReadRequest(request([[step({ id: "a" }), step({ id: "b", instructions: "Another brief." })]]), grant()).ok, true);
});

test("duplicate-running names the active step whose output the requester receives", () => {
  const parsed = request([[step({ id: "scan" })]]);
  const key = stepKey(parsed.phases[0].steps[0]);
  const result = validateReadRequest(parsed, grant({ activeSteps: [{ key, stepId: "earlier-scan" }] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "duplicate-running");
  assert.equal(result.errors[0].duplicateOf, "earlier-scan");
  assert.match(result.errors[0].message, /receives that step's output/);
});

test("over-ceiling fires for concurrency with and without list fan-out", () => {
  const plain = validateReadRequest(request([[step({ id: "scan" })]], { concurrency: 4 }), grant());
  assert.equal(plain.ok, false);
  if (!plain.ok) assert.equal(plain.errors[0].limit, "concurrency");
  const fanOut = validateReadRequest(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]], { concurrency: 7 }),
    grant({ limits: { concurrency: 3, listConcurrency: 6, requestAttempts: 24, outside: true } }));
  assert.equal(fanOut.ok, false);
  if (!fanOut.ok) assert.equal(fanOut.errors[0].limit, "concurrency");
  const fanOutOk = validateReadRequest(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]], { concurrency: 8 }), grant());
  assert.equal(fanOutOk.ok, true);
});

test("over-ceiling fires for the request limit, the allowance and a scout lead's reservation", () => {
  const five = Array.from({ length: 5 }, (_, index) => step({ id: `s${index}`, instructions: `Brief ${index}.` }));
  const requestLimit = validateReadRequest(request([five], {}), grant({ limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 4, outside: true } }));
  assert.equal(requestLimit.ok, false);
  if (!requestLimit.ok) assert.equal(requestLimit.errors[0].limit, "request");

  const allowance = validateReadRequest(request([five]), grant({ allowanceLeft: 4 }));
  assert.equal(allowance.ok, false);
  if (!allowance.ok) assert.equal(allowance.errors[0].limit, "allowance");

  const reservation = validateReadRequest(request([five]), grant({ requester: "scout-lead", reservation: 2 }));
  assert.equal(reservation.ok, false);
  if (!reservation.ok) assert.equal(reservation.errors.at(-1)?.limit, "reservation");
});

test("outside-off fires when outside is off, the profile is not outside-capable, or no lineage is left", () => {
  const sourced = step({ id: "web", source: { refs: ["https://example.com/spec"] }, agentProfileId: "outside-reader" });
  const off = validateReadRequest(request([[sourced]]), grant({ limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 24, outside: false } }));
  assert.deepEqual(codes(off), ["outside-off"]);
  const wrongProfile = validateReadRequest(request([[step({ id: "web", source: { refs: ["evidence:1"] } })]]), grant());
  assert.deepEqual(codes(wrongProfile), ["outside-off"]);
  assert.equal(validateReadRequest(request([[sourced]]), grant()).ok, true);
});

test("not-granted covers the pool, requester kind, scout and project manager round limits, and lead or verify on a non-manager", () => {
  const plain = request([[step({ id: "scan" })]]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ poolOn: false }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "reader" }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "quarantined-reader" }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "scout-lead", requestsSent: 1, reservation: 2 }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requestsSent: 3 }))), ["not-granted"]);
  const leadStep = validateReadRequest(request([[step({ id: "scan", lead: { maxAttempts: 2 } })]]), grant({ requester: "scout-lead", reservation: 10 }));
  assert.equal(leadStep.ok, false);
  if (!leadStep.ok) assert.equal(leadStep.errors[0].path, "phases[0].steps[0].lead");
  const verifyStep = validateReadRequest(request([[step({ id: "scan", verify: true })]]), grant({ requester: "scout-lead", reservation: 10 }));
  assert.equal(verifyStep.ok, false);
  if (!verifyStep.ok) assert.equal(verifyStep.errors[0].path, "phases[0].steps[0].verify");
});

test("a request with three different faults returns all three errors", () => {
  const bad = request([[
    step({ id: "scan", agentProfileId: "nobody" }),
    step({ id: "fan", forEach: { step: "items", maxItems: 2 } }),
    step({ id: "scan", instructions: "A different brief." }),
  ]]);
  const result = validateReadRequest(bad, grant());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors.map(item => item.code).sort(), ["forward-reference", "repeated-step", "unknown-profile"]);
});

test("stepKey ignores whitespace, case and path order, and ignores profile, id, title and effort", () => {
  const base = step({ id: "scan", instructions: "Find the rules in the team code.", paths: ["packages/host/src/a.ts", "packages/host/src/b.ts"], output: "locations" });
  const key = stepKey(base);
  assert.equal(stepKey({ ...base, instructions: "  FIND   the\nrules  in the team code.  " }), stepKey({ ...base, instructions: "find the rules in the team code." }));
  assert.equal(stepKey({ ...base, paths: ["packages/host/src/b.ts", "packages/host/src/a.ts"] }), key);
  assert.equal(stepKey({ ...base, agentProfileId: "lister" }), key);
  assert.equal(stepKey({ ...base, id: "other", title: "Renamed", effort: "large" }), key);
  assert.notEqual(stepKey({ ...base, instructions: "Find the other rules." }), key);
  assert.notEqual(stepKey({ ...base, output: "findings" }), key);
  assert.notEqual(stepKey({ ...base, forEach: { step: "items", maxItems: 2 } }), key);
  assert.notEqual(stepKey({ ...base, source: { refs: ["https://example.com/spec"] } }), key);
  assert.notEqual(stepKey({ ...base, source: { refs: ["https://example.com/other"] } }), key);
  assert.notEqual(stepKey({ ...base, paths: ["packages/host/src/a.ts"] }), key);
  assert.notEqual(stepKey({ ...base, paths: ["packages/host/src/c.ts", "packages/host/src/b.ts"] }), key);
});

test("expandedTotal counts forEach as maxItems, lead as 1 plus maxAttempts, and sums each phase", () => {
  const parsed = request([
    [listStep("items"), step({ id: "lead", lead: { maxAttempts: 4 } })],
    [step({ id: "fan", forEach: { step: "items", maxItems: 8 } }), step({ id: "plain" })],
  ]);
  assert.deepEqual(expandedTotal(parsed), { total: 1 + 5 + 8 + 1, phases: [6, 9] });
});

test("schema bounds reject five phases, seven steps, maxItems 17, maxAttempts 13, nine source refs and a non-https ref", () => {
  const minimal = request([[step({ id: "scan" })]]);
  assert.equal(readRequestSchema.safeParse(minimal).success, true);
  const fivePhases = request(Array.from({ length: 5 }, (_, index) => [step({ id: `s${index}` })]));
  assert.equal(readRequestSchema.safeParse(fivePhases).success, false);
  const sevenSteps = request([Array.from({ length: 7 }, (_, index) => step({ id: `s${index}`, instructions: `Brief ${index}.` }))]);
  assert.equal(readRequestSchema.safeParse(sevenSteps).success, false);
  const bigFan = request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 17 } })]]);
  assert.equal(readRequestSchema.safeParse(bigFan).success, false);
  const longLead = request([[step({ id: "scan", lead: { maxAttempts: 13 } })]]);
  assert.equal(readRequestSchema.safeParse(longLead).success, false);
  const nineRefs = request([[step({ id: "web", source: { refs: Array.from({ length: 9 }, (_, index) => `evidence:${index + 1}`) } })]]);
  assert.equal(readRequestSchema.safeParse(nineRefs).success, false);
  const plainHttp = request([[step({ id: "web", source: { refs: ["http://example.com/spec"] } })]]);
  assert.equal(readRequestSchema.safeParse(plainHttp).success, false);
});

test("each output accepts its minimal result and rejects fields that belong to another output", () => {
  const findings = { kind: "read-result", output: "findings", partial: false, summary: "Found it.", evidence };
  const list = { kind: "read-result", output: "list", partial: false, summary: "Listed.", items: [{ key: "a", title: "A", source: "x.ts" }] };
  const verdict = { kind: "read-result", output: "verdict", partial: false, verdict: "met", criterion: "Tests cover the validator.", evidence };
  const locations = { kind: "read-result", output: "locations", partial: false, summary: "Located.", items: [{ path: "packages/host/src/read-request.ts", symbols: ["stepKey"], role: "validator" }] };
  for (const valid of [findings, list, verdict, locations]) {
    assert.equal(readResultSchema.safeParse(valid).success, true, `${valid.output} minimal result`);
  }
  assert.equal(readResultSchema.safeParse({ ...findings, items: [] }).success, false);
  assert.equal(readResultSchema.safeParse({ ...list, evidence }).success, false);
  assert.equal(readResultSchema.safeParse({ ...verdict, summary: "Extra." }).success, false);
  assert.equal(readResultSchema.safeParse({ ...locations, verdict: "met" }).success, false);
});

test("notes enforce their list caps and the 240-byte text limit", () => {
  const base = { kind: "read-result", output: "findings", partial: true, summary: "Partial.", evidence };
  assert.equal(readResultSchema.safeParse({ ...base, notes: { decisions: [{ what: "Use the validator.", why: "It returns every error." }], open: ["Who owns the pool?"] } }).success, true);
  assert.equal(readResultSchema.safeParse({ ...base, notes: { open: ["x".repeat(241)] } }).success, false);
  assert.equal(readResultSchema.safeParse({ ...base, notes: { open: ["a", "b", "c", "d", "e"] } }).success, false);
});

test("the read grant schema accepts a project manager grant", () => {
  assert.equal(readGrantSchema.safeParse(grant({ reservation: 5, lineage: { state: "extends", uncleared: [{ runId: RUN_ID, head: HEAD }] } })).success, true);
});

test("refusalText names every error with its path, message and fix, and says the refusal is not a denial", () => {
  const text = refusalText([
    { code: "unknown-profile", path: "phases[0].steps[0].agentProfileId", message: "Profile nobody is not in this run's pool.", fix: "Name a listed profile." },
    { code: "repeated-step", path: "phases[0].steps[1].id", message: "Step id scan is already used.", fix: "Give each step its own id." },
  ]);
  assert.match(text, /phases\[0\]\.steps\[0\]\.agentProfileId: Profile nobody is not in this run's pool\. Fix: Name a listed profile\./);
  assert.match(text, /phases\[0\]\.steps\[1\]\.id: Step id scan is already used\. Fix: Give each step its own id\./);
  assert.match(text, /not recorded/);
  assert.match(text, /This is not a denial/);
});

test("a forEach step with a lead costs maxItems times its attempts, in the total and the phase totals", () => {
  const parsed = request([
    [listStep("items")],
    [step({ id: "fan", forEach: { step: "items", maxItems: 4 }, lead: { maxAttempts: 10 } })],
  ]);
  assert.deepEqual(expandedTotal(parsed), { total: 45, phases: [1, 44] });
  const refused = validateReadRequest(parsed, grant());
  assert.deepEqual(codes(refused), ["over-ceiling", "over-ceiling"]);
  if (!refused.ok) assert.deepEqual(refused.errors.map(item => item.limit), ["request", "allowance"]);
  const atCeiling = request([
    [listStep("items")],
    [step({ id: "fan", forEach: { step: "items", maxItems: 3 }, lead: { maxAttempts: 12 } })],
  ]);
  const passing = validateReadRequest(atCeiling, grant({ limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 40, outside: true }, allowanceLeft: 40 }));
  assert.equal(passing.ok, true);
  if (passing.ok) assert.deepEqual({ total: passing.total, phases: passing.phases }, { total: 40, phases: [1, 39] });
});

test("a step with both source and lead is refused at its lead path", () => {
  const bad = validateReadRequest(request([[step({ id: "web", source: { refs: ["https://example.com/spec"] }, agentProfileId: "outside-reader", lead: { maxAttempts: 2 } })]]), grant());
  assert.deepEqual(codes(bad), ["not-granted"]);
  if (!bad.ok) {
    assert.equal(bad.errors[0].path, "phases[0].steps[0].lead");
    assert.match(bad.errors[0].message, /outside-content step cannot be a lead/);
  }
});

test("an invalid grant is refused with one not-granted error at path grant", () => {
  const plain = request([[step({ id: "scan" })]]);
  const invalid: unknown[] = [
    { ...grant(), allowanceLeft: undefined },
    { ...grant(), requestsSent: -1 },
    { ...grant(), extra: true },
  ];
  for (const candidate of invalid) {
    const result = validateReadRequest(plain, candidate);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "not-granted");
    assert.equal(result.errors[0].path, "grant");
  }
});

test("lineage: an absent state refuses, capped refuses and names each head, extends and new pass", () => {
  const plain = request([[step({ id: "web", source: { refs: ["https://example.com/spec"] }, agentProfileId: "outside-reader" })]]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ lineage: undefined }))), ["outside-off"]);
  const capped = validateReadRequest(plain, grant({ lineage: { state: "capped", uncleared: [{ runId: RUN_ID, head: HEAD }, { runId: RUN_B, head: HEAD_B }] } }));
  assert.deepEqual(codes(capped), ["outside-off"]);
  if (!capped.ok) {
    assert.match(capped.errors[0].message, new RegExp(`run ${RUN_ID} head ${HEAD}`));
    assert.match(capped.errors[0].message, new RegExp(`run ${RUN_B} head ${HEAD_B}`));
  }
  assert.equal(validateReadRequest(plain, grant({ lineage: { state: "extends", uncleared: [] } })).ok, true);
  assert.equal(validateReadRequest(plain, grant({ lineage: { state: "new", uncleared: [] } })).ok, true);
});

test("step ids that name Object prototype members are keyed as own properties", () => {
  const result = validateReadRequest(request([[step({ id: "constructor" })]]), grant());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.hasOwn(result.keys, "constructor"), true);
  const repeated = validateReadRequest(request([[step({ id: "constructor" }), step({ id: "constructor", instructions: "Other brief." })]]), grant());
  assert.deepEqual(codes(repeated), ["repeated-step"]);
});

test("a forEach that is in the same phase and not a list reports both faults at the same path", () => {
  const result = validateReadRequest(request([[step({ id: "items" }), step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]]), grant());
  assert.equal(result.ok, false);
  if (result.ok) return;
  const forward = result.errors.filter(item => item.code === "forward-reference");
  assert.equal(forward.length, 2);
  assert.deepEqual(forward.map(item => item.path), ["phases[0].steps[1].forEach.step", "phases[0].steps[1].forEach.step"]);
});

test("source refs are a set for the key: order does not change it, different sets do, and the caller's arrays stay as sent", () => {
  const forward = step({ id: "web", agentProfileId: "outside-reader", paths: ["packages/host/src/a.ts", "packages/host/src/b.ts"], source: { refs: ["evidence:1", "evidence:2"] } });
  const reversed = () => step({ id: "web", agentProfileId: "outside-reader", paths: ["packages/host/src/b.ts", "packages/host/src/a.ts"], source: { refs: ["evidence:2", "evidence:1"] } });
  const keyed = reversed();
  assert.equal(stepKey(keyed), stepKey(forward));
  assert.deepEqual(keyed.source?.refs, ["evidence:2", "evidence:1"]);
  assert.deepEqual(keyed.paths, ["packages/host/src/b.ts", "packages/host/src/a.ts"]);
  const validated = reversed();
  assert.equal(validateReadRequest(request([[validated]]), grant()).ok, true);
  assert.deepEqual(validated.source?.refs, ["evidence:2", "evidence:1"]);
  assert.deepEqual(validated.paths, ["packages/host/src/b.ts", "packages/host/src/a.ts"]);
  assert.notEqual(stepKey(step({ id: "web", source: { refs: ["evidence:3"] } })), stepKey(step({ id: "web", source: { refs: ["evidence:4"] } })));
});

test("a repeated source ref or path does not change a step's key, so duplicate work is still caught", () => {
  const once = step({ id: "web", agentProfileId: "outside-reader", source: { refs: ["evidence:1"] } });
  const twice = step({ id: "web", agentProfileId: "outside-reader", source: { refs: ["evidence:1", "evidence:1"] } });
  assert.equal(stepKey(twice), stepKey(once));
  const running = validateReadRequest(request([[twice]]), grant({ activeSteps: [{ key: stepKey(once), stepId: "earlier-web" }] }));
  assert.deepEqual(codes(running), ["duplicate-running"]);
  const repeated = validateReadRequest(request([[once, { ...twice, id: "web-again" }]]), grant());
  assert.deepEqual(codes(repeated), ["repeated-step"]);
  assert.equal(stepKey(step({ id: "web", source: { refs: ["evidence:2", "evidence:1", "evidence:2"] } })), stepKey(step({ id: "web", source: { refs: ["evidence:1", "evidence:2"] } })));
  assert.notEqual(stepKey(step({ id: "web", source: { refs: ["evidence:1", "evidence:2"] } })), stepKey(step({ id: "web", source: { refs: ["evidence:1"] } })));
  const path = "packages/host/src/a.ts";
  assert.equal(stepKey(step({ id: "scan", paths: [path, path] })), stepKey(step({ id: "scan", paths: [path] })));
});

function limits(result: ReturnType<typeof validateReadRequest>): string[] {
  return result.ok ? [] : result.errors.map(item => `${item.code}:${item.limit}:${item.path}`);
}

test("a scout lead's request and its own second attempt are charged to its reservation alone", () => {
  const lead = (reservation: number | undefined, allowanceLeft: number) => grant({ requester: "scout-lead", reservation, allowanceLeft });
  const one = request([[step({ id: "a" })]]);
  const two = request([[step({ id: "a" }), step({ id: "b" })]]);
  const funded = validateReadRequest(one, lead(2, 0));
  assert.equal(funded.ok, true);
  if (funded.ok) assert.equal(funded.total, 1);
  assert.deepEqual(limits(validateReadRequest(one, lead(1, 0))), ["over-ceiling:reservation:phases"]);
  const short = validateReadRequest(two, lead(2, 40));
  assert.deepEqual(limits(short), ["over-ceiling:reservation:phases"]);
  if (!short.ok) assert.match(short.errors[0].message, /second attempt/);
  assert.deepEqual(limits(validateReadRequest(one, lead(undefined, 40))), ["over-ceiling:reservation:phases"]);
  const exact = validateReadRequest(two, lead(3, 0));
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.total, 2);
  assert.equal(validateReadRequest(two, grant({ allowanceLeft: 2 })).ok, true);
  assert.deepEqual(limits(validateReadRequest(two, grant({ allowanceLeft: 1 }))), ["over-ceiling:allowance:phases"]);
});

test("a scout lead may reach requestAttempts when its reservation covers it, and one more step is over the request ceiling", () => {
  const steps = (count: number) => Array.from({ length: count }, (_, index) => step({ id: `s${index}` }));
  const lead = grant({ requester: "scout-lead", reservation: 6, limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 4, outside: true } });
  const atCeiling = validateReadRequest(request([steps(4)]), lead);
  assert.equal(atCeiling.ok, true);
  if (atCeiling.ok) assert.equal(atCeiling.total, 4);
  assert.deepEqual(limits(validateReadRequest(request([steps(5)]), lead)), ["over-ceiling:request:phases"]);
});

test("a project manager's third request in a revision passes and its fourth is refused", () => {
  const plain = request([[step({ id: "scan" })]]);
  assert.equal(validateReadRequest(plain, grant({ requestsSent: 2 })).ok, true);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requestsSent: 3 }))), ["not-granted"]);
});

test("a run with the pool off points the member to an explore report", () => {
  const result = validateReadRequest(request([[step({ id: "scan" })]]), grant({ poolOn: false }));
  assert.deepEqual(codes(result), ["not-granted"]);
  if (result.ok) return;
  assert.equal(result.errors[0].message, "The read pool is not available for this run.");
  assert.equal(result.errors[0].fix, "Send an explore report instead; it runs as before.");
  assert.match(refusalText(result.errors), /explore/);
  assert.doesNotMatch(refusalText(result.errors), /owner/);
});

function parseIssues(value: unknown, readGrant: unknown = grant()): string[] {
  let result: ReturnType<typeof validateReadRequest> | undefined;
  assert.doesNotThrow(() => { result = validateReadRequest(value, readGrant); });
  assert.ok(result);
  return result.ok ? [] : result.errors.map(item => `${item.code}:${item.path}`);
}

test("a parse issue is over-ceiling only for the table's list, without a limit property; other too-big lists are malformed", () => {
  const ceiling: [ReadRequest, string][] = [
    [request(Array.from({ length: 5 }, (_, index) => [step({ id: `s${index}` })])), "phases"],
    [request([Array.from({ length: 7 }, (_, index) => step({ id: `s${index}` }))]), "phases[0].steps"],
    [request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 17 } })]]), "phases[1].steps[0].forEach.maxItems"],
    [request([[step({ id: "scan", lead: { maxAttempts: 13 } })]]), "phases[0].steps[0].lead.maxAttempts"],
    [request([[step({ id: "scan" })]], { concurrency: 9 }), "concurrency"],
  ];
  for (const [value, path] of ceiling) {
    const result = validateReadRequest(value, grant());
    assert.deepEqual(result.ok ? [] : result.errors.map(item => `${item.code}:${item.path}`), [`over-ceiling:${path}`], path);
    if (!result.ok) assert.equal("limit" in result.errors[0], false, path);
  }
  const bigFan = validateReadRequest(ceiling[2][0], grant());
  if (!bigFan.ok) assert.equal(bigFan.errors[0].fix, "Set `maxItems` to 16 or less.");
  const nineRefs = step({ id: "web", agentProfileId: "outside-reader", source: { refs: Array.from({ length: 9 }, (_, index) => `evidence:${index + 1}`) } });
  assert.deepEqual(parseIssues(request([[nineRefs]])), ["malformed:phases[0].steps[0].source.refs"]);
  const seventeenPaths = step({ id: "scan", paths: Array.from({ length: 17 }, (_, index) => `packages/host/src/f${index}.ts`) });
  assert.deepEqual(parseIssues(request([[seventeenPaths]])), ["malformed:phases[0].steps[0].paths"]);
  assert.deepEqual(limits(validateReadRequest(request([[step({ id: "scan" })]], { concurrency: 8 }), grant())), ["over-ceiling:concurrency:concurrency"]);
});

test("a value of the wrong type at a ceiling path is one malformed error, never over-ceiling", () => {
  const valid = request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 4 } })]]);
  const fan = valid.phases[1].steps[0];
  const wrong: [unknown, string][] = [
    [{ ...valid, phases: "secret" }, "phases"],
    [{ ...valid, phases: [{ id: "phase-1", steps: "1234567" }] }, "phases[0].steps"],
    [{ ...valid, concurrency: "999999999" }, "concurrency"],
    [{ ...valid, phases: [valid.phases[0], { id: "phase-2", steps: [{ ...fan, forEach: { step: "items", maxItems: "seventeen-or-more" } }] }] }, "phases[1].steps[0].forEach.maxItems"],
    [request([[{ ...step({ id: "scan" }), lead: { maxAttempts: Array.from({ length: 13 }, () => 1) } } as unknown as ReadStep]]), "phases[0].steps[0].lead.maxAttempts"],
  ];
  for (const [value, path] of wrong) assert.deepEqual(parseIssues(value), [`malformed:${path}`], path);
});

test("the worst malformed request inside the schema's list limits is refused in full, without throwing, within stated bounds", () => {
  // Every field of 4 phases of 6 steps fails, with 16 paths of three issues each and 8 refs.
  // Measured with zod 4.6.7 on a 617,732-byte request: 1,692 errors and 217,297 bytes of refusal text.
  const badStep = (index: number) => ({
    id: `BAD-${index}`, title: "t".repeat(101), instructions: "i".repeat(4001), agentProfileId: "BAD", output: "nothing", effort: "huge",
    forEach: { step: "BAD", maxItems: 17, extra: true }, lead: { maxAttempts: 13, extra: true }, verify: false, extra: true,
    paths: Array.from({ length: 16 }, () => `/${"*".repeat(300)}`),
    source: { refs: Array.from({ length: 8 }, () => `x${"y".repeat(2048)}`), extra: true },
  });
  const worst = {
    kind: "write", summary: "s".repeat(2001), concurrency: 0, extra: true,
    phases: Array.from({ length: 4 }, (_, phase) => ({ id: "BAD", extra: true, steps: Array.from({ length: 6 }, (_, index) => badStep(phase * 6 + index)) })),
  };
  let result: ReturnType<typeof validateReadRequest> | undefined;
  assert.doesNotThrow(() => { result = validateReadRequest(worst, grant()); });
  assert.ok(result && !result.ok);
  assert.ok(result.errors.length >= 1600 && result.errors.length <= 1800, `${result.errors.length} errors`);
  const bytes = Buffer.byteLength(refusalText(result.errors), "utf8");
  assert.ok(bytes <= 240_000, `${bytes} bytes`);
});

test("a source reference may hold 2,048 characters; a longer one is one malformed error at its own path that names the bound", () => {
  const url = (length: number) => `https://example.com/${"a".repeat(length - 20)}`;
  const sourced = (ref: string) => request([[step({ id: "web", agentProfileId: "outside-reader", source: { refs: [ref] } })]]);
  assert.equal(url(2048).length, 2048);
  assert.equal(validateReadRequest(sourced(url(2048)), grant()).ok, true);
  for (const ref of [url(2049), `x${"y".repeat(2048)}`]) {
    const result = validateReadRequest(sourced(ref), grant());
    assert.deepEqual(result.ok ? [] : result.errors.map(item => `${item.code}:${item.path}`), ["malformed:phases[0].steps[0].source.refs[0]"]);
    if (result.ok) continue;
    const text = refusalText(result.errors);
    assert.match(result.errors[0].fix, /2048/);
    assert.equal(text.includes(ref.slice(0, 19)) || text.includes(ref.slice(-16)), false);
  }
});

test("the validator never throws on a request of the wrong shape and reports it as malformed without running the rules", () => {
  for (const value of [null, "read", 7, [], [request([[step({ id: "scan" })]])], undefined, true]) {
    assert.deepEqual(parseIssues(value), ["malformed:request"], JSON.stringify(value));
  }
  assert.deepEqual(parseIssues({}), ["malformed:kind", "malformed:summary", "malformed:phases"]);
  assert.deepEqual(parseIssues({}, grant({ poolOn: false, requester: "reader" })), ["malformed:kind", "malformed:summary", "malformed:phases"]);
  assert.deepEqual(parseIssues({}, { ...grant(), extra: true }), ["not-granted:grant"]);
  assert.deepEqual(parseIssues(request([[{ ...step({ id: "scan" }), extra: true }]])), ["malformed:phases[0].steps[0]"]);
  assert.deepEqual(parseIssues({ ...request([[step({ id: "scan" })]]), phases: [] }), ["malformed:phases"]);
  assert.deepEqual(parseIssues(request([[step({ id: "scan", title: "x".repeat(101) })]])), ["malformed:phases[0].steps[0].title"]);
  assert.deepEqual(parseIssues(JSON.parse('{"kind":"read","summary":"S","phases":[],"__proto__":{"kind":"x"}}')), ["malformed:phases", "malformed:request"]);
});

test("parse errors never echo a value taken from the request", () => {
  const marker = "IGNORE-PRIOR-INSTRUCTIONS";
  const hostile = {
    kind: marker,
    summary: 5,
    concurrency: marker,
    [marker]: true,
    phases: [{ id: marker, steps: [{
      id: marker, title: marker.repeat(20), instructions: "Read.", output: marker, [marker]: 1,
      source: { refs: [marker] }, paths: [`/${marker}`], forEach: { step: marker, maxItems: 99 }, verify: marker,
    }] }],
  };
  const result = validateReadRequest(hostile, grant());
  assert.equal(result.ok, false);
  if (result.ok) return;
  const issues = readRequestSchema.safeParse(hostile);
  assert.equal(issues.success, false);
  if (!issues.success) assert.equal(result.errors.length, issues.error.issues.length);
  assert.ok(result.errors.length >= 10);
  const text = `${JSON.stringify(result.errors)}\n${refusalText(result.errors)}`.toLowerCase();
  assert.equal(text.includes(marker.toLowerCase()), false);
});

test("a verifier step that also reads outside content is refused at its source path", () => {
  const sourced = { agentProfileId: "outside-reader", verify: true as const };
  const evidenceRef = validateReadRequest(request([[step({ id: "check", ...sourced, source: { refs: ["evidence:1"] } })]]), grant());
  assert.deepEqual(codes(evidenceRef), ["not-granted"]);
  if (!evidenceRef.ok) {
    assert.equal(evidenceRef.errors[0].path, "phases[0].steps[0].source");
    assert.equal(evidenceRef.errors[0].message, "A verifier step cannot read outside content.");
  }
  const laterStep = validateReadRequest(request([[step({ id: "scan" })], [step({ id: "plain" }), step({ id: "check", ...sourced, source: { refs: ["https://example.com/spec"] } })]]), grant());
  assert.deepEqual(codes(laterStep), ["not-granted"]);
  if (!laterStep.ok) assert.equal(laterStep.errors[0].path, "phases[1].steps[1].source");
  assert.equal(validateReadRequest(request([[step({ id: "check", verify: true })]]), grant()).ok, true);
  assert.equal(validateReadRequest(request([[step({ id: "web", agentProfileId: "outside-reader", source: { refs: ["evidence:1"] } })]]), grant()).ok, true);
});

test("the read grant holds the design's setting ranges, and a grant outside them is refused as invalid", () => {
  const plain = request([[step({ id: "scan" })]]);
  const limits = { concurrency: 3, listConcurrency: 8, requestAttempts: 24, outside: true };
  const invalidGrant = (result: ReturnType<typeof validateReadRequest>, label: string) => {
    assert.deepEqual(result.ok ? [] : result.errors.map(item => `${item.code}:${item.path}`), ["not-granted:grant"], label);
  };
  const fan = request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 4 }, lead: { maxAttempts: 10 } })]]);
  invalidGrant(validateReadRequest(fan, grant({ limits: { ...limits, requestAttempts: 100 }, allowanceLeft: 1000 })), "reviewer reproduction");
  const atMax = grant({ limits: { concurrency: 5, listConcurrency: 8, requestAttempts: 40, outside: true }, allowanceLeft: 200, reservation: 12 });
  assert.equal(validateReadRequest(plain, atMax).ok, true);
  assert.equal(readGrantSchema.safeParse(grant({ allowanceLeft: 0, reservation: 0 })).success, true);
  const outOfRange: Partial<ReadGrant>[] = [
    { limits: { ...limits, concurrency: 6 } },
    { limits: { ...limits, concurrency: 0 } },
    { limits: { ...limits, listConcurrency: 9 } },
    { limits: { ...limits, listConcurrency: 0 } },
    { limits: { ...limits, requestAttempts: 41 } },
    { limits: { ...limits, requestAttempts: 0 } },
    { allowanceLeft: 201 },
    { reservation: 13 },
  ];
  for (const overrides of outOfRange) invalidGrant(validateReadRequest(plain, grant(overrides)), JSON.stringify(overrides));
});

test("notes cap each text at 240 bytes, counting multi-byte characters by their UTF-8 length", () => {
  const base = { kind: "read-result", output: "findings", partial: true, summary: "Partial.", evidence };
  const withOpen = (text: string) => readResultSchema.safeParse({ ...base, notes: { open: [text] } }).success;
  assert.equal(withOpen("\u20ac".repeat(80)), true);
  assert.equal(withOpen("\u20ac".repeat(81)), false);
  assert.equal(withOpen("\u00e9".repeat(240)), false);
  assert.equal(withOpen("\u00e9".repeat(120)), true);
});

test("over-ceiling errors carry the path of the field they name", () => {
  const five = Array.from({ length: 5 }, (_, index) => step({ id: `s${index}`, instructions: `Brief ${index}.` }));
  const concurrency = validateReadRequest(request([[step({ id: "scan" })]], { concurrency: 4 }), grant());
  const requestLimit = validateReadRequest(request([five]), grant({ limits: { concurrency: 3, listConcurrency: 8, requestAttempts: 4, outside: true } }));
  const allowance = validateReadRequest(request([five]), grant({ allowanceLeft: 4 }));
  const reservation = validateReadRequest(request([five]), grant({ requester: "scout-lead", reservation: 2 }));
  const paths = (result: ReturnType<typeof validateReadRequest>) => (result.ok ? [] : result.errors.map(item => `${item.limit}:${item.path}`));
  assert.deepEqual(paths(concurrency), ["concurrency:concurrency"]);
  assert.deepEqual(paths(requestLimit), ["request:phases"]);
  assert.deepEqual(paths(allowance), ["allowance:phases"]);
  assert.deepEqual(paths(reservation), ["reservation:phases"]);
});

test("schema lower bounds and caps: phases, maxItems, maxAttempts, refs and result item counts", () => {
  const parse = (value: unknown) => readRequestSchema.safeParse(value).success;
  assert.equal(parse({ ...request([[step({ id: "scan" })]]), phases: [] }), false);
  assert.equal(parse(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 0 } })]])), false);
  assert.equal(parse(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 16 } })]])), true);
  assert.equal(parse(request([[step({ id: "scan", lead: { maxAttempts: 0 } })]])), false);
  assert.equal(parse(request([[step({ id: "scan", lead: { maxAttempts: 12 } })]])), true);
  assert.equal(parse(request([[step({ id: "web", source: { refs: Array.from({ length: 8 }, (_, index) => `evidence:${index + 1}`) } })]])), true);

  const items = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, title: "T", source: "s.ts" }));
  const locations = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `packages/host/src/f${index}.ts`, symbols: [], role: "r" }));
  const listResult = (count: number) => ({ kind: "read-result", output: "list", partial: false, summary: "S", items: items(count) });
  const locationResult = (count: number) => ({ kind: "read-result", output: "locations", partial: false, summary: "S", items: locations(count) });
  assert.equal(readResultSchema.safeParse(listResult(0)).success, false);
  assert.equal(readResultSchema.safeParse(listResult(32)).success, true);
  assert.equal(readResultSchema.safeParse(listResult(33)).success, false);
  assert.equal(readResultSchema.safeParse(locationResult(24)).success, true);
  assert.equal(readResultSchema.safeParse(locationResult(25)).success, false);

  const base = { kind: "read-result", output: "findings", partial: false, summary: "S", evidence };
  assert.equal(readResultSchema.safeParse({ ...base, notes: { open: ["a", "b", "c", "d"] } }).success, true);
  assert.equal(readResultSchema.safeParse({ ...base, notes: { open: ["a", "b", "c", "d", "e"] } }).success, false);
});
