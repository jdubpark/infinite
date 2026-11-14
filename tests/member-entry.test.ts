import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { hostEntryId } from "../packages/host/src/evidence/host-entries.js";
import {
  entryToolsFor,
  memberEntryId,
  memberEntryPostSchema,
  postAllowed,
  refusalPath,
} from "../packages/host/src/evidence/member-entry.js";
import { findSecret } from "../packages/host/src/evidence/secret-scan.js";
import type { TeamRun } from "../packages/host/src/team-types.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000f1";
const BINDING = { runId: RUN_ID, memberId: "member-a", revision: 1 };
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENTRY_UUID = "00000000-0000-4000-8000-0000000000e1";

const contract = (overrides: Record<string, unknown> = {}) => ({
  kind: "contract",
  summary: "Settings shape",
  body: { interface: "GET /settings", change: "adds theme" },
  ...overrides,
});
const finding = (overrides: Record<string, unknown> = {}) => ({
  kind: "finding",
  summary: "Route order",
  body: { items: [{ source: "src/routes.ts", observation: "list is registered first" }] },
  ...overrides,
});
const blockerBody = {
  cause: { status: "observed", detail: "the route returns 500" },
  validationEvidence: [{ sourceRef: "log line 4", observation: "stack trace" }],
  proposedRecovery: "retry the route",
  prevention: "add a test",
};
const blocker = (overrides: Record<string, unknown> = {}) => ({
  kind: "blocker",
  summary: "Route fails",
  body: blockerBody,
  ...overrides,
});
const handoff = (taskId: string) => ({
  kind: "handoff",
  summary: "Route done",
  taskId,
  body: { done: ["route"], remaining: ["tests"] },
});

test("posts follow the kind schemas", () => {
  const ok = memberEntryPostSchema.parse(contract());
  assert.deepEqual(ok.body, { interface: "GET /settings", change: "adds theme", sources: [] });
  assert.deepEqual(ok.paths, []);

  const refused = [
    finding({ body: { items: Array.from({ length: 9 }, () => ({ source: "s", observation: "o" })) } }),
    { kind: "handoff", summary: "x", body: { done: ["a"], remaining: [] } },
    { ...handoff("a-task"), supersedes: ENTRY_UUID },
    contract({ summary: "a\nb" }),
    contract({ summary: "a".repeat(241) }),
    contract({ paths: Array.from({ length: 17 }, (_, i) => `src/p${i}`) }),
    contract({ paths: Array.from({ length: 4 }, (_, i) => `${i}${"a".repeat(299)}`) }),
    contract({ paths: ["../x"] }),
    contract({ body: { interface: "GET /settings", change: "adds theme", extra: "x" } }),
  ];
  for (const entry of refused) {
    assert.equal(memberEntryPostSchema.safeParse(entry).success, false, JSON.stringify(entry).slice(0, 80));
  }

  // The canonical body of exactly 12,288 bytes parses, and one byte more is refused.
  // The 2000 CJK characters are three bytes each, so the field limits alone cannot reach the cap in ASCII.
  const base = { interface: "界".repeat(2000), change: "a", sources: Array.from({ length: 8 }, () => "s".repeat(500)) };
  const size = (change: string) => Buffer.byteLength(canonicalJson({ ...base, change }), "utf8");
  const n = 12_288 - size("a") + 1;
  assert.ok(n >= 1 && n <= 4000, `padding ${n} must fit the change limit`);
  assert.equal(size("a".repeat(n)), 12_288);
  assert.equal(memberEntryPostSchema.safeParse(contract({ body: { ...base, change: "a".repeat(n) } })).success, true);
  assert.equal(memberEntryPostSchema.safeParse(contract({ body: { ...base, change: "a".repeat(n + 1) } })).success, false);
});

test("entry ids are content identities", () => {
  const id = memberEntryId(BINDING, memberEntryPostSchema.parse(contract()));
  assert.match(id, UUID_V8);
  assert.equal(memberEntryId(BINDING, memberEntryPostSchema.parse(contract())), id);
  assert.notEqual(memberEntryId({ ...BINDING, revision: 2 }, memberEntryPostSchema.parse(contract())), id);
  assert.notEqual(memberEntryId(BINDING, memberEntryPostSchema.parse(contract({ summary: "Other" }))), id);
  assert.notEqual(memberEntryId({ ...BINDING, memberId: "member-b" }, memberEntryPostSchema.parse(contract())), id);

  const reordered = { body: { change: "adds theme", interface: "GET /settings" }, summary: "Settings shape", kind: "contract" };
  assert.equal(memberEntryId(BINDING, memberEntryPostSchema.parse(reordered)), id);

  assert.notEqual(id, hostEntryId(RUN_ID, "report", `report:${BINDING.memberId}`));
});

test("roles post only their kinds and their own task", () => {
  const table: Record<string, readonly string[]> = {
    "project-manager": ["contract", "blocker"],
    scout: ["finding", "blocker"],
    implementer: ["contract", "finding", "blocker", "handoff"],
    integrator: ["contract", "finding", "blocker", "handoff"],
    reviewer: ["finding", "blocker"],
  };
  const kinds = ["contract", "finding", "blocker", "handoff"] as const;
  const samples: Record<string, unknown> = {
    contract: contract(),
    finding: finding(),
    blocker: blocker(),
    handoff: handoff("a"),
  };
  for (const role of Object.keys(table)) {
    for (const kind of kinds) {
      const entry = memberEntryPostSchema.parse(samples[kind]);
      const expected = table[role].includes(kind) ? "ok" : "entry-kind-forbidden";
      assert.equal(postAllowed({ role: role as never, taskId: "a" }, entry), expected, `${role} ${kind}`);
    }
  }

  const ownTask = memberEntryPostSchema.parse(contract({ taskId: "b" }));
  assert.equal(postAllowed({ role: "implementer", taskId: "a" }, ownTask), "entry-task-forbidden");
  const integratorHandoff = memberEntryPostSchema.parse(handoff("a"));
  assert.equal(postAllowed({ role: "integrator" }, integratorHandoff), "entry-task-forbidden");

  const run = { blackboard: { tools: true } } as Pick<TeamRun, "blackboard">;
  for (const role of ["delivery", "permission-coordinator", "mission-coordinator"] as const) {
    assert.equal(entryToolsFor(run, role), false, role);
  }
  for (const role of ["project-manager", "scout", "implementer", "integrator", "reviewer"] as const) {
    assert.equal(entryToolsFor(run, role), true, role);
    assert.equal(entryToolsFor({}, role), false, `${role} without the switch`);
  }
});

test("the scan finds secrets and never returns them", () => {
  const port = 4780;
  const token = `h${randomBytes(24).toString("hex")}`;
  const own = { token, url: `http://127.0.0.1:${port}/hook` };
  const privateKey = "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----";
  const cases: [string, string][] = [
    [privateKey, "private-key"],
    ["gh" + "p_" + "a".repeat(36), "access-token"],
    ["AKIA" + "A".repeat(16), "access-token"],
    ["xox" + "b-" + "1".repeat(12), "access-token"],
    ["eyJ" + "x".repeat(9) + "." + "y".repeat(12) + "." + "z".repeat(12), "access-token"],
    [token, "hook-token"],
    ["http://127.0.0.1:" + port + "/hook", "hook-url"],
  ];
  for (const [value, cls] of cases) {
    const entry = {
      kind: "finding",
      summary: "ok",
      body: { items: [{ source: "s", observation: "fine" }, { source: "s", observation: value }] },
    };
    const found = findSecret(entry, own);
    assert.deepEqual(found, { path: "body.items.1.observation", cls }, cls);
    const text = JSON.stringify(found);
    assert.equal(text.includes(value), false, "a result must not echo the value");
    if (cls === "hook-token") assert.equal(text.includes(token), false);
  }

  const near = [
    "sk-" + "1".repeat(19),
    "AKIA" + "A".repeat(15),
    "3f2b7c1e-9a4d-4e8f-8b2a-6c5d4e3f2a1b",
  ];
  for (const value of near) {
    assert.equal(findSecret({ body: { items: [{ source: "s", observation: value }] } }, own), undefined, value);
  }
});

test("refusal paths hold no member text", () => {
  assert.equal(refusalPath(["entry", "body", "x-marker-key", 0]), "entry.body.?.0");
  assert.equal(refusalPath(["entry", "body", "items", 2, "source"]), "entry.body.items.2.source");
});
