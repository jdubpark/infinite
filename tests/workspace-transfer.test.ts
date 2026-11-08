import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceTransferPool, transferWorkspaceBlobs, WORKSPACE_TRANSFER_CONCURRENCY } from "../packages/host/src/workspace-transfer.js";

test("workspace transfer pool bounds active uploads and drains admitted work", async () => {
  const pool = createWorkspaceTransferPool();
  const items = Array.from({ length: 8 }, (_, index) => String(index));
  let active = 0, maxActive = 0;
  for (let wave = 0; wave < 2; wave++) {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const uploads = items.map(item => pool.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(item);
      try { await gate; } finally { active -= 1; }
    }));
    try {
      const deadline = Date.now() + 3000;
      while (started.length < WORKSPACE_TRANSFER_CONCURRENCY && Date.now() < deadline) await delay(5);
      assert.equal(started.length, WORKSPACE_TRANSFER_CONCURRENCY, "only four uploads run before a slot opens");
      let drained = false;
      const draining = pool.drain().then(() => { drained = true; });
      await delay(20);
      assert.equal(drained, false, "drain waits for in-flight uploads");
      release();
      await draining;
      await Promise.all(uploads);
      assert.equal(started.length, items.length, "queued uploads resume as slots become available");
      assert.ok(maxActive <= WORKSPACE_TRANSFER_CONCURRENCY, "active uploads never exceed the bound");
    } finally { release(); }
  }
  assert.equal(maxActive, WORKSPACE_TRANSFER_CONCURRENCY, "a later transfer wave can reuse every released slot");
});

test("a failed workspace transfer stops new work and waits for active requests", async () => {
  const hashes = Array.from({ length: 8 }, (_, index) => String(index));
  const started: string[] = [];
  const failure = new Error("transfer failed");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const running = transferWorkspaceBlobs(hashes, async hash => {
    started.push(hash);
    if (hash === "0") throw failure;
    await gate;
  }).catch(error => { settled = true; throw error; });

  try {
    const deadline = Date.now() + 3000;
    while (started.length < WORKSPACE_TRANSFER_CONCURRENCY && Date.now() < deadline) await delay(5);
    assert.equal(started.length, WORKSPACE_TRANSFER_CONCURRENCY, "the initial window starts concurrently");
    await delay(20);
    assert.equal(settled, false, "the failing window waits for its other active requests");
    release();
    await assert.rejects(running, error => error === failure);
    assert.equal(started.length, WORKSPACE_TRANSFER_CONCURRENCY, "no later request starts after the first failure");
  } finally { release(); }
});

test("parent cancellation stops scheduling and drains active workspace transfers", async () => {
  const hashes = Array.from({ length: 8 }, (_, index) => String(index));
  const started: string[] = [];
  const abort = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const running = transferWorkspaceBlobs(hashes, async hash => { started.push(hash); await gate; }, abort.signal)
    .finally(() => { settled = true; });

  try {
    const deadline = Date.now() + 3000;
    while (started.length < WORKSPACE_TRANSFER_CONCURRENCY && Date.now() < deadline) await delay(5);
    assert.equal(started.length, WORKSPACE_TRANSFER_CONCURRENCY, "the initial window starts concurrently");
    abort.abort(new Error("parent cancelled"));
    await delay(20);
    assert.equal(settled, false, "cancellation waits for active requests that cannot be interrupted");
    release();
    await assert.rejects(running, /parent cancelled/);
    assert.equal(started.length, WORKSPACE_TRANSFER_CONCURRENCY, "no later request starts after cancellation");
  } finally { release(); }
});
