import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearService } from "../packages/host/src/linear.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { unseal } from "../packages/host/src/vault.js";
import { startLinearServer } from "./fixtures/linear-server.js";
import { waitFor } from "./helpers.js";

const add = "InfiniteLinearIssueAddLabel", remove = "InfiniteLinearIssueRemoveLabel";
const blockedText = "The run is blocked and its workspace is preserved.";

async function setup() {
  const linear = await startLinearServer(), root = mkdtempSync(join(tmpdir(), "linear-label-intent-"));
  const apiKeyFile = join(root, "linear-key");
  writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
  const config = { stateDir: join(root, "state"), linear: { apiKeyFile, endpoint: linear.endpoint },
    projects: [{ id: "label-run", name: "Label run", path: root, linear: { teamId: linear.teamId } }] } as unknown as Config;
  const key = randomBytes(32), run = { id: randomUUID(), projectId: "label-run", title: "Export status", objective: "Keep status current.",
    status: "implementing", revision: 1, members: [], checks: [], steering: [], decisions: [] } as unknown as TeamRun;
  const services = new Set<LinearService>();
  const service = () => { const value = new LinearService(config, key); services.add(value); return value; };
  let current = service();
  current.updateTeam(run, true);
  current.start();
  await waitFor(async () => current.getTeam(run.id)?.status, status => status === "synced", 15000);
  const issueId = current.getTeam(run.id)!.issue!.id;
  const labels = () => [...(linear.issueLabels.get(issueId) ?? [])].map(id => linear.labels.get(id)!.name);
  const labelOps = () => linear.calls.filter(call => call.operation === add || call.operation === remove).map(call => call.operation);
  const savedLabel = () => unseal<{ label?: string; labelFailures?: number; labelRetryAt?: number; labelProviderRetryAt?: number }>(key, `linear:team:${run.id}`,
    readFileSync(join(config.stateDir, "linear", `team-${run.id}.sealed`), "utf8"));
  const update = (status: "blocked" | "planning") => {
    run.status = status; run.revision++;
    run.reason = status === "blocked" ? blockedText : undefined;
    current.updateTeam(run, true, status === "blocked");
  };
  const restart = () => { current.close(); current = service(); current.start(); };
  return {
    linear, config, key, run, current: () => current, update, labels, labelOps, savedLabel, restart,
    async close() { for (const value of services) value.close(); await linear.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a late remove acknowledgement preserves a renewed Blocked intent", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    ctx.update("blocked");
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 15000);
    ctx.current().updateTeam(ctx.run, true, true);
    ctx.current().updateTeam(ctx.run, true, true);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(ctx.labelOps(), [add], "Repeated blocked updates do not duplicate a confirmed add");

    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("planning");
    const request = await held.applied;
    assert.equal(request.operation, remove);
    assert.deepEqual(ctx.labels(), [], "The remove is committed before its response is released");
    ctx.update("blocked");
    held.acknowledge();
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 7000);
    assert.deepEqual(ctx.labelOps(), [add, remove, add]);
  } finally { held?.acknowledge(); await ctx.close(); }
});

test("a late add acknowledgement preserves a newer remove intent", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("blocked");
    const request = await held.applied;
    assert.equal(request.operation, add);
    assert.deepEqual(ctx.labels(), ["Blocked"]);
    ctx.update("planning");
    held.acknowledge();
    await waitFor(async () => !ctx.labels().includes("Blocked"), value => value, 7000);
    assert.deepEqual(ctx.labelOps(), [add, remove]);
  } finally { held?.acknowledge(); await ctx.close(); }
});

test("a failed stale add does not back off a newer remove", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("blocked");
    const request = await held.applied;
    assert.equal(request.operation, add);
    ctx.update("planning");
    held.fail();
    await waitFor(async () => !ctx.labels().includes("Blocked"), value => value, 7000);
    assert.deepEqual(ctx.labelOps(), [add, remove]);
  } finally { held?.acknowledge(); await ctx.close(); }
});

test("an ABA return to add is not backed off by an old generic error", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("blocked");
    const request = await held.applied;
    assert.equal(request.operation, add);
    ctx.update("planning");
    ctx.update("blocked");
    held.fail();
    await waitFor(async () => ctx.labelOps(), operations => operations.length === 2, 7000);
    assert.deepEqual(ctx.labelOps(), [add, add]);
    assert.deepEqual(ctx.labels(), ["Blocked"]);
  } finally { held?.acknowledge(); await ctx.close(); }
});

test("a stale label rate limit survives intent flips and restart", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelRateLimit> | undefined;
  try {
    ctx.linear.rateLimitLabelChanges(true);
    held = ctx.linear.holdNextLabelRateLimit();
    ctx.update("blocked");
    const request = await held.requested;
    assert.equal(request.operation, add);
    ctx.update("planning");
    held.release();
    await waitFor(async () => ctx.savedLabel(), state => (state.labelProviderRetryAt ?? 0) > Date.now(), 7000);
    ctx.linear.rateLimitLabelChanges(false);

    ctx.update("blocked");
    ctx.update("planning");
    ctx.update("blocked");
    const saved = ctx.savedLabel();
    assert.equal(saved.label, "add");
    assert.equal(saved.labelFailures, 0, "A stale provider delay stays separate from intent failure counts");
    assert.equal(saved.labelRetryAt, 0, "Intent changes clear only the current-intent retry window");
    assert.ok((saved.labelProviderRetryAt ?? 0) > Date.now() + 110_000, "The provider Retry-After remains active across intent changes");

    ctx.restart();
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.deepEqual(ctx.labelOps(), [add], "The sealed provider cooldown prevents a retry after restart");
    assert.deepEqual(ctx.labels(), [], "No add was sent while the provider cooldown remained active");
    assert.ok((ctx.savedLabel().labelProviderRetryAt ?? 0) > Date.now());
  } finally { held?.release(); await ctx.close(); }
});

test("a failed stale remove does not back off a renewed Blocked intent", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    ctx.update("blocked");
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 15000);
    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("planning");
    const request = await held.applied;
    assert.equal(request.operation, remove);
    assert.deepEqual(ctx.labels(), []);
    ctx.update("blocked");
    held.fail();
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 7000);
    assert.deepEqual(ctx.labelOps(), [add, remove, add]);
  } finally { held?.acknowledge(); await ctx.close(); }
});

test("the latest pending label intent resumes from sealed state after restart", { timeout: 30000 }, async () => {
  const ctx = await setup();
  let held: ReturnType<typeof ctx.linear.holdNextLabelChangeAcknowledgement> | undefined;
  try {
    ctx.update("blocked");
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 15000);
    held = ctx.linear.holdNextLabelChangeAcknowledgement();
    ctx.update("planning");
    const request = await held.applied;
    assert.equal(request.operation, remove);
    ctx.update("blocked");
    ctx.restart();
    await waitFor(async () => ctx.labels().includes("Blocked"), Boolean, 7000);
    held.acknowledge();
    assert.deepEqual(ctx.labelOps(), [add, remove, add]);
  } finally { held?.acknowledge(); await ctx.close(); }
});
