import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";

test("owner-authorized delivery waits for exact-head checks and review, survives API restart, and records one merge claim", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-hold", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const delivering = await waitFor(() => f.get(created.body.id), run => run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 40000);
    assert.equal(delivering.review?.verdict, "approved");
    assert.ok(delivering.checks.length && delivering.checks.every(check => check.status === "passed"));
    const actor = delivering.members.find(member => member.role === "delivery")!;
    assert.equal(actor.baseCommit, delivering.headCommit);
    assert.equal(actor.modelProfile?.tier, "strong");
    assert.notEqual(actor.memberId, delivering.members.find(member => member.role === "reviewer")?.memberId);
    await f.host.stopApi(); await f.host.start();
    assert.equal((await f.get(delivering.id)).status, "delivering");
    writeFileSync(join(f.receipts, "delivery-release"), "continue");
    const merged = await f.settled(delivering.id);
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.equal(merged.deliveryReceipt?.headCommit, merged.headCommit);
    assert.equal(merged.deliveryReceipt?.pullRequestUrl, "https://github.com/example/app/pull/1");
    assert.equal(merged.members.filter(member => member.role === "delivery").length, 1);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    await f.host.stopApi(); await f.host.start();
    assert.deepEqual((await f.get(merged.id)).deliveryReceipt, merged.deliveryReceipt);
    const steer = await f.host.fetchApi(`/teams/${merged.id}/steer`, "controller", { requestId: randomUUID(), revision: merged.revision, text: "Try delivery again" });
    assert.equal(steer.status, 409);
    assert.equal(steer.body.code, "delivery-reconciliation-required");
  } finally { await f.close(); }
});

test("delivery rejects foreign targets, stale heads, changed files, and invalid merged baselines", { timeout: 120000 }, async () => {
  for (const [scenario, reason] of [["delivery-foreign", /configured repository/], ["delivery-stale", /reviewed commit/], ["delivery-dirty", /read-only agent/], ["delivery-baseline-changed", /beyond the reviewed tree/], ["delivery-baseline-tree", /must identify a commit/]] as const) {
    const f = await fixture(scenario, limitLineup);
    try {
      const created = await f.host.fetchApi("/teams", "owner", f.create());
      const blocked = await f.settled(created.body.id);
      assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
      assert.match(blocked.reason ?? "", reason);
      if (scenario.startsWith("delivery-baseline-")) assert.ok(blocked.deliveryReceipt, "A merge claim survives blocked baseline reconciliation");
      else assert.equal(blocked.deliveryReceipt, undefined);
    } finally { await f.close(); }
  }
});

test("delivery repairs repeat checks and independent review before a new delivery attempt", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-repair", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const merged = await f.settled(created.body.id);
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.equal(merged.round, 1);
    const actors = merged.members.filter(member => member.role === "delivery");
    assert.equal(actors.length, 2);
    assert.notEqual(actors[0].baseCommit, actors[1].baseCommit);
    assert.equal(merged.members.filter(member => member.role === "reviewer").length, 2);
    assert.equal(merged.deliveryReceipt?.headCommit, actors[1].baseCommit);
    assert.equal(merged.checks.filter(check => check.status === "passed").length, 2);
  } finally { await f.close(); }
});

test("an exited delivery without a receipt is not merged or replayed by steering", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-unreported", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    await waitFor(() => f.get(created.body.id), run => run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 40000);
    writeFileSync(join(f.receipts, "delivery-release"), "exit without receipt");
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason ?? "", /without a valid structured report/);
    assert.equal(blocked.deliveryReceipt, undefined);
    await f.host.stopApi(); await f.host.start();
    const retry = await f.host.fetchApi(`/teams/${blocked.id}/steer`, "owner", { requestId: randomUUID(), revision: blocked.revision, text: "Retry" });
    assert.equal(retry.status, 409);
    const receipts = readdirSync(f.receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")));
    assert.equal(receipts.filter(receipt => receipt.role === "delivery").length, 1);
  } finally { await f.close(); }
});

test("failed checks never launch delivery and a weak lineup cannot opt into merge", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-failed-check", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.members.some(member => member.role === "delivery"), false);
  } finally { await f.close(); }
  const weak = await fixture("delivery-stale");
  try {
    const refused = await weak.host.fetchApi("/teams", "owner", weak.create());
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "delivery-lineup-required");
  } finally { await weak.close(); }
});
