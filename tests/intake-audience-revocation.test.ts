import test from "node:test";
import assert from "node:assert/strict";
import { direct, setup } from "./fixtures/intake-test-context.js";

test("records from a previous Slack audience stay sealed and disappear from runtime intake views", async () => {
  const ctx = await setup({ requireSlackThread: false });
  try {
    const request = direct(ctx);
    assert.equal(ctx.intake.requestFromSlack(request), "accepted");
    const [sealed] = ctx.store.list();
    assert.ok(sealed?.slackAudienceId);
    assert.equal(ctx.intake.list().length, 1);

    ctx.config.intake!.mission.groupId = "another-audience";
    assert.deepEqual(ctx.intake.list(), []);
    assert.equal(ctx.store.get(sealed!.issueId)!.slackAudienceId, sealed!.slackAudienceId,
      "The sealed record remains available for audit without a runtime audience assignment");
  } finally { await ctx.close(); }
});

test("removing Slack keeps queued Slack requests out of Linear intake processing", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false });
  try {
    const request = direct(ctx);
    assert.equal(ctx.intake.requestFromSlack(request), "accepted");
    const [sealed] = ctx.store.list();
    assert.ok(sealed?.slackAudienceId);

    ctx.intake.close();
    ctx.config.intake!.slack = undefined;
    const linearOnly = ctx.service();
    await linearOnly.poll();
    assert.equal(ctx.linearServer.allIssues().length, 0, "A removed Slack installation cannot file an old Slack request");
    assert.equal(ctx.missions.list().length, 0);
    assert.equal(ctx.store.get(sealed!.issueId)!.slackAudienceId, sealed!.slackAudienceId);
    linearOnly.close();
  } finally { await ctx.close(); }
});
