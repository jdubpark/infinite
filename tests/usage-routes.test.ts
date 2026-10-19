import test from "node:test";
import assert from "node:assert/strict";
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
