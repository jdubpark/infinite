import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BalanceService } from "../packages/host/src/balances.js";
import type { UsageConfig } from "../packages/host/src/config.js";

const account = (apiKeyFile: string): UsageConfig["accounts"] => ({ deepseek: { kind: "metered", match: ["deepseek/*"], balance: { source: "deepseek", apiKeyFile } } });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

test("DeepSeek balance prefers USD and marks cached value stale after failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-balance-")), file = join(dir, "key"); writeFileSync(file, "private-test-key\n");
  let now = Date.parse("2026-10-19T12:00:00Z"), calls = 0;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => { calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-test-key"); return calls === 1 ? response({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "20" }, { currency: "USD", total_balance: "12.5" }] }) : response({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "  " }] }); }) as typeof fetch;
  const service = new BalanceService(account(file), fetcher, () => now);
  try {
    await service.refresh();
    assert.deepEqual(service.get("deepseek"), { amount: 12.5, currency: "USD", asOf: "2026-10-19T12:00:00.000Z", stale: false });
    now += 60_001; await service.refresh(true);
    assert.deepEqual(service.get("deepseek"), { amount: 12.5, currency: "USD", asOf: "2026-10-19T12:00:00.000Z", stale: true });
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("malformed, timed out, unauthorized, and unconfigured balances fail closed without key disclosure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-balance-")), file = join(dir, "key"); writeFileSync(file, "private-test-key");
  try {
    for (const fetcher of [
      (async () => response({}, false)) as typeof fetch,
      (async () => response({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "NaN" }] })) as typeof fetch,
      (async () => { throw new Error("timeout private-test-key"); }) as typeof fetch,
    ]) {
      const service = new BalanceService(account(file), fetcher);
      await service.refresh(true);
      assert.equal(service.get("deepseek"), null);
      service.close();
    }
    const noBalance = new BalanceService({ other: { kind: "metered", match: ["meta/*"] } }, fetch);
    await noBalance.refresh(true); assert.equal(noBalance.get("other"), null); noBalance.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
