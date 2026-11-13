import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRemoteClient } from "@infinite/remote";
import { startHost } from "./helpers.js";

test("usage routes reject invalid timezone and day count and balance refresh is owner-only", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    assert.equal((await host.fetchApi("/usage/daily?tz=Not/AZone")).status, 400);
    assert.equal((await host.fetchApi("/usage/projects?tz=Not/AZone")).status, 400);
    assert.equal((await host.fetchApi("/usage/projects/missing?tz=Not/AZone")).status, 400);
    assert.equal((await host.fetchApi("/usage/daily?days=0")).status, 400);
    assert.equal((await host.fetchApi("/usage/balances/refresh", "viewer", {})).status, 403);
    const owner = await host.fetchApi("/usage/balances/refresh", "owner", {});
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body, { accounts: [] });
  } finally { await host.stop(); }
});

test("subscription plan updates are owner-only, validated, and reset to config", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { usage: { prices: {}, budgets: {}, accounts: {
    claude: { kind: "subscription", match: ["anthropic/*"], planUsd: 20 },
    codex: { kind: "subscription", match: ["openai/*"], planUsd: 30 },
    gemini: { kind: "subscription", match: ["google/*"] },
    deepseek: { kind: "metered", match: ["deepseek/*"] },
  } } } });
  try {
    const path = "/usage/accounts/claude/plan";
    const putPlan = (endpoint: string, role: "owner" | "controller" | "viewer", body: unknown) => host.fetchApi(endpoint, role, body, {}, "PUT");
    assert.equal((await putPlan(path, "viewer", { planUsd: 12 })).status, 403);
    assert.equal((await putPlan(path, "controller", { planUsd: 12 })).status, 403);
    assert.equal((await putPlan("/usage/accounts/missing/plan", "owner", { planUsd: 12 })).status, 404);
    assert.equal((await putPlan("/usage/accounts/deepseek/plan", "owner", { planUsd: 12 })).status, 400);
    for (const body of [{}, { planUsd: "12" }, { planUsd: -0.01 }, { planUsd: 1.234 }, { planUsd: 100_001 }, { planUsd: 12, extra: true }])
      assert.equal((await putPlan(path, "owner", body)).status, 400, JSON.stringify(body));
    for (const rawBody of ['{"planUsd":NaN}', '{"planUsd":1e999}']) {
      const invalid = await fetch(`${host.origin}/api${path}`, { method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/json" }, body: rawBody });
      assert.equal(invalid.status, 400, rawBody);
    }

    const updated = await putPlan(path, "owner", { planUsd: 12.34 });
    assert.equal(updated.status, 200);
    assert.deepEqual(Object.keys(updated.body).sort(), ["accounts"]);
    const accounts = updated.body.accounts as { id: string; planUsd?: number; planSource?: string }[];
    assert.deepEqual(accounts.find(account => account.id === "claude"), { id: "claude", kind: "subscription", planUsd: 12.34, planSource: "owner", balance: null });
    assert.equal(accounts.find(account => account.id === "codex")?.planSource, "config");
    assert.equal(accounts.find(account => account.id === "gemini")?.planSource, undefined);
    assert.equal((await host.fetchApi("/usage")).body.month.plansUsd, 42.34);

    const noDefault = await putPlan("/usage/accounts/gemini/plan", "owner", { planUsd: 7.5 });
    assert.equal(noDefault.status, 200);
    assert.deepEqual(noDefault.body.accounts.find((account: { id: string }) => account.id === "gemini"), { id: "gemini", kind: "subscription", planUsd: 7.5, planSource: "owner", balance: null });
    assert.equal((await host.fetchApi("/usage")).body.month.plansUsd, 49.84);

    for (const planUsd of [0, 100_000])
      assert.equal((await putPlan(path, "owner", { planUsd })).status, 200, `accepts ${planUsd}`);

    const reset = await putPlan(path, "owner", { planUsd: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.accounts.find((account: { id: string }) => account.id === "claude").planUsd, 20);
    assert.equal(reset.body.accounts.find((account: { id: string }) => account.id === "claude").planSource, "config");
    assert.equal((await host.fetchApi("/usage")).body.month.plansUsd, 57.5);
    const resetNoDefault = await putPlan("/usage/accounts/gemini/plan", "owner", { planUsd: null });
    const gemini = resetNoDefault.body.accounts.find((account: { id: string }) => account.id === "gemini");
    assert.equal(gemini.planUsd, undefined);
    assert.equal(gemini.planSource, undefined);
    assert.equal((await host.fetchApi("/usage")).body.month.plansUsd, 50);
  } finally { await host.stop(); }
});

test("the encrypted channel carries the phone cost screen and owner plan edits", { timeout: 60000 }, async () => {
  const host = await startHost({ config: {
    machine: { id: randomUUID(), label: "Test machine" }, remote: { enabled: true },
    usage: { prices: {}, budgets: {}, accounts: { claude: { kind: "subscription", match: [], planUsd: 20 } } },
  } });
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  try {
    for (const path of ["/usage", "/usage/daily?days=7&tz=UTC", "/usage/models", "/usage/projects?tz=UTC"]) await owner.request(path);
    await owner.request("/usage/balances/refresh", { method: "POST", body: {} });
    const result = await owner.request<{ accounts: { id: string; planUsd?: number; planSource?: string }[] }>("/usage/accounts/claude/plan", { method: "PUT", body: { planUsd: 9.99 } });
    assert.equal(result.accounts.find(account => account.id === "claude")?.planUsd, 9.99);
    assert.equal(result.accounts.find(account => account.id === "claude")?.planSource, "owner");
    await assert.rejects(owner.request("/usage/accounts/cl%61ude/plan", { method: "PUT", body: { planUsd: 1 } }), "encoded route segments stay refused");
  } finally { owner.close(); await host.stop(); }
});

/** Runs `infinite evidence ...` against the host as its owner and returns stdout. */
function evidenceCli(host: { origin: string; tokens: { owner: string } }, root: string) {
  const clientFile = join(root, "client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal" }), { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const exec = promisify(execFile);
  return async (...args: string[]) => (await exec(process.execPath, [...cli, "evidence", ...args])).stdout;
}

test("the status route and command report the store", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-cli-"));
  try {
    const status = await host.fetchApi("/evidence/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "ready");
    assert.equal(status.body.modules.store, "ready");
    assert.equal(status.body.events, 0);
    assert.ok(status.body.fileBytes > 0);
    assert.equal((await host.fetchApi("/evidence/status", "viewer")).status, 200, "the route follows the role rule of GET /api/usage");
    assert.equal((await host.fetchApi("/evidence/status", null)).status, 401);

    const evidence = evidenceCli(host, root);
    const json = JSON.parse(await evidence("status", "--json"));
    assert.equal(json.state, "ready");
    assert.equal(json.modules.store, "ready");
    const text = await evidence("status");
    assert.match(text, /^Evidence store: ready$/m);
    assert.match(text, /^Module store: ready$/m);
    assert.match(text, /^Events: 0$/m);
    assert.match(text, /^File: \d+ bytes, WAL: \d+ bytes$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await host.stop();
  }
});

test("usage routes answer 503 and change nothing while the ledger is unavailable", { timeout: 90000 }, async () => {
  const host = await startHost({ config: { usage: { prices: {}, budgets: {}, accounts: {
    claude: { kind: "subscription", match: ["anthropic/*"], planUsd: 20 },
  } } } });
  try {
    await host.stopApi();
    const location = join(host.config.stateDir, "evidence");
    rmSync(location, { recursive: true, force: true });
    writeFileSync(location, "not a directory");
    const plan = join(host.config.stateDir, "usage-plans.sealed");
    const before = existsSync(plan) ? readFileSync(plan) : undefined;
    await host.start();
    assert.equal((await host.fetchApi("/usage/models")).status, 503);
    const put = await host.fetchApi("/usage/accounts/claude/plan", "owner", { planUsd: 12 }, {}, "PUT");
    assert.equal(put.status, 503);
    assert.deepEqual(put.body, { error: "The usage ledger is unavailable" });
    assert.deepEqual(existsSync(plan) ? readFileSync(plan) : undefined, before, "a refused plan override writes nothing");
    const refresh = await host.fetchApi("/usage/balances/refresh", "owner", {});
    assert.equal(refresh.status, 503);
    assert.deepEqual(refresh.body, { error: "The usage ledger is unavailable" });
  } finally { await host.stop(); }
});

test("a host with an unusable evidence location still serves and reports the store unavailable", { timeout: 90000 }, async () => {
  const host = await startHost();
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-cli-"));
  try {
    await host.stopApi();
    const location = join(host.config.stateDir, "evidence");
    rmSync(location, { recursive: true, force: true });
    writeFileSync(location, "not a directory");
    await host.start();
    const usage = await host.fetchApi("/usage");
    assert.equal(usage.status, 503);
    assert.deepEqual(usage.body, { error: "The usage ledger is unavailable" });
    assert.equal((await host.fetchApi("/sessions")).status, 200);
    const status = await host.fetchApi("/evidence/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "unavailable");
    assert.equal(status.body.reason, "open-failed");
    assert.equal(status.body.modules.store, "unavailable");
    assert.equal(status.body.events, 0);
    const text = await evidenceCli(host, root)("status");
    assert.match(text, /^Evidence store: unavailable$/m);
    assert.match(text, /^Reason: open-failed$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await host.stop();
  }
});
