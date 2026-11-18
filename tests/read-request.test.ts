import test from "node:test";
import assert from "node:assert/strict";
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
    lineagesLeft: 3,
    requestsSent: 0,
    activeSteps: [],
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateReadRequest>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors.map(item => item.code);
}

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
  const fanOut = validateReadRequest(request([[listStep("items")], [step({ id: "fan", forEach: { step: "items", maxItems: 2 } })]], { concurrency: 9 }), grant());
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
  const noLineage = validateReadRequest(request([[sourced]]), grant({ lineagesLeft: 0 }));
  assert.deepEqual(codes(noLineage), ["outside-off"]);
  assert.equal(validateReadRequest(request([[sourced]]), grant()).ok, true);
});

test("not-granted covers the pool, requester kind, scout and project manager round limits, and lead or verify on a non-manager", () => {
  const plain = request([[step({ id: "scan" })]]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ poolOn: false }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "reader" }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "quarantined-reader" }))), ["not-granted"]);
  assert.deepEqual(codes(validateReadRequest(plain, grant({ requester: "scout-lead", requestsSent: 1, reservation: 1 }))), ["not-granted"]);
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
  assert.equal(readGrantSchema.safeParse(grant({ reservation: 5, lineagesLeft: 2 })).success, true);
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
