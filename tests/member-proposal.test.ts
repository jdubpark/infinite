import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { memberEntryEnvelopeSchema, memberEntryId, memberEntryPostSchema, refusalPath } from "../packages/host/src/evidence/member-entry.js";

const { z } = createRequire(new URL("../packages/host/package.json", import.meta.url))("zod") as typeof import("zod");

const RUN_ID = "00000000-0000-4000-8000-0000000000f1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000e2";
const BINDING = { runId: RUN_ID, memberId: "member-a", revision: 1 };

const TEST = { kind: "artifact", path: "research/entries.json", count: "/entries", threshold: { kind: "count", min: 40 } };
const proposal = (overrides: Record<string, unknown> = {}) => ({
  statement: "The research file holds at least forty entries",
  refutedBy: "The file holds fewer than forty entries",
  test: TEST,
  criticality: "plan",
  ...overrides,
});
const finding = (assumption?: unknown) => ({
  kind: "finding",
  summary: "Route order",
  body: {
    items: [{ source: "src/routes.ts", observation: "list is registered first" }],
    ...(assumption === undefined ? {} : { assumption }),
  },
});
const contract = (assumption: unknown) => ({
  kind: "contract",
  summary: "Settings shape",
  body: { interface: "GET /settings", change: "adds theme", assumption },
});

test("a finding may name one assumption", () => {
  assert.equal(memberEntryPostSchema.safeParse(finding({ id: "a2", stance: "contradicts" })).success, true);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal() })).success, true);

  assert.equal(memberEntryPostSchema.safeParse(contract({ id: "a2", stance: "supports" })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ id: "a2", stance: "contradicts", propose: proposal() })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ statement: "x".repeat(501) }) })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ statement: "x".repeat(500) }) })).success, true);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ test: "x".repeat(1023) }) })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ test: "x".repeat(1022) }) })).success, true);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ criticality: "major" }) })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ id: "a2", stance: "neutral" })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ id: "Not An Id", stance: "supports" })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ id: "a2", stance: "supports", extra: 1 })).success, false);
  assert.equal(memberEntryPostSchema.safeParse(finding({ propose: proposal({ extra: 1 }) })).success, false);

  const envelope = memberEntryEnvelopeSchema.safeParse({
    op: "post", ...BINDING, requestId: REQUEST_ID,
    entry: finding({ propose: proposal({ statement: "x".repeat(501) }) }),
  });
  assert.equal(envelope.success, false);
  const issue = envelope.error?.issues[0];
  assert.ok(issue);
  assert.equal(refusalPath(issue.path), "entry.body.assumption.propose.statement");

  const base = memberEntryPostSchema.parse(finding());
  assert.equal(memberEntryId(BINDING, base), "ebd89533-7f2c-8d54-921f-1642b9aa4053");

  const toolSchema = z.toJSONSchema(z.object({ entry: memberEntryPostSchema }).strict(), { target: "draft-7", io: "input" });
  assert.match(JSON.stringify(toolSchema), /"assumption"/);
});
