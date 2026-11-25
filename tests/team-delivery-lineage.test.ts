import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, git, limitLineup } from "./team-fixture.js";
import type { TeamLineup, TeamMember } from "../packages/host/src/team-types.js";
import { deliveryInternals, deliveryRecord } from "./fixtures/team-delivery-record.js";

const sameFamilyDeliveryLineup: TeamLineup = {
  ...structuredClone(limitLineup),
  reviewer: { id: "claude-reviewer", label: "Claude reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

test("automatic merge stays ready for review when an exact-head reviewer shares a contributor family", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-fast", sameFamilyDeliveryLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const ready = await f.settled(created.body.id);
    assert.equal(ready.status, "ready-for-review", JSON.stringify(ready));
    assert.equal(ready.reason, "reviewer-family-required");
    assert.equal(ready.review?.verdict, "approved");
    assert.equal(ready.checks.some(check => check.status === "passed" && check.headCommit === ready.headCommit), true);
    assert.equal(ready.members.some(member => member.role === "delivery"), false);
    assert.equal(existsSync(join(f.receipts, "delivery-started.json")), false);
  } finally { await f.close(); }
});

test("a restored queued merge delivery with missing provenance is settled before launch", { timeout: 30000 }, async () => {
  const h = await deliveryRecord("merge", undefined, undefined, { reviewLineage: true });
  try {
    h.run.lineup = structuredClone(limitLineup);
    h.run.status = "delivering";
    h.member.status = "queued";
    h.member.startedAt = undefined;
    h.stored.deliveryAttempt = undefined;
    h.stored.deliveryReviewLineage = undefined;
    deliveryInternals(h.teams).save(h.stored);
    h.teams.close(); await h.teams.idle();

    h.teams = await h.f.openTeamService({ start: false });
    const internals = deliveryInternals(h.teams);
    h.stored = internals.records.get(h.id)!;
    h.run = h.stored.run;
    h.member = h.run.members.find(member => member.memberId === h.member.memberId)!;
    await internals.step(h.stored);

    assert.equal(h.run.status, "ready-for-review");
    assert.equal(h.run.reason, "reviewer-family-required");
    assert.equal(h.member.status, "stopped");
    assert.equal(h.stored.deliveryAttempt, undefined);
    assert.equal(existsSync(join(h.f.receipts, "delivery-started.json")), false);
  } finally { await h.f.close(); }
});

test("PM recovery carries retained partial writer families into the next revision lineage", { timeout: 90000 }, async () => {
  const h = await deliveryRecord("merge", undefined, undefined, { reviewLineage: true });
  try {
    const memberId = randomUUID();
    const cwd = join(h.stored.root, h.id, "members", memberId);
    const profile = structuredClone(h.run.lineup!.integrator);
    git(h.run.workspace, "clone", "--no-hardlinks", h.run.workspace, cwd);
    git(cwd, "remote", "remove", "origin");
    const at = new Date().toISOString();
    const partial: TeamMember = { runId: h.id, memberId, revision: h.run.revision, role: "integrator", provider: profile.provider, modelProfile: profile,
      sessionId: randomUUID(), title: "integrator: partial recovery work", status: "stopped", cwd, baseCommit: h.headCommit, prompt: "", cursor: 0,
      stopRequestId: randomUUID(), startedAt: at, report: { kind: "blocked", summary: "Retain this unintegrated partial workspace." } };
    for (const member of h.run.members) member.status = "stopped";
    h.run.members.push(partial);
    h.run.status = "planning";
    h.stored.deliveryAttempt = undefined;
    h.run.recovery = { attempts: 0, status: "stopping", source: { code: "integration-conflict", memberId,
      revision: h.run.revision, reportKind: "blocked", reason: partial.report!.summary, at } };

    assert.equal(await deliveryInternals(h.teams).recovery.startAutomaticRecovery(h.stored, true), true);
    assert.equal(h.run.revision, 2);
    assert.deepEqual(h.stored.deliveryReviewLineage, { headCommit: h.headCommit, families: ["claude", "gpt"], unknown: false },
      "the current integrated Claude author and potentially copied GPT partial writer both remain covered");
  } finally { await h.f.close(); }
});
