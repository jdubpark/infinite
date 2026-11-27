import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { permissionWriteFence, type PermissionFence } from "../packages/host/src/permission-write-fence.js";

async function app(settle: () => Promise<PermissionFence>) {
  const server = express();
  server.use(express.json());
  server.use("/api", permissionWriteFence(settle));
  server.delete("/api/project-groups/:id", (_req, res) => res.json({ removed: true }));
  server.post("/api/halt", (_req, res) => res.json({ engaged: true }));
  server.post("/api/list", (_req, res) => res.json(["a"]));
  server.post("/api/fails", () => { throw new Error("bad body"); });
  server.get("/api/permissions/log", (_req, res) => res.json({ read: true }));
  server.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: "bad" }));
  const listening = server.listen(0, "127.0.0.1");
  await new Promise(resolve => listening.once("listening", resolve));
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  return { base, close: () => new Promise(resolve => listening.close(resolve)) };
}

test("every write, a DELETE or an owner halt included, is acknowledged only after the permission fence settles", async () => {
  let release!: (fence: PermissionFence) => void;
  let calls = 0;
  const h = await app(() => { calls += 1; return new Promise(resolve => { release = resolve; }); });
  try {
    for (const [method, path, expected] of [["DELETE", "/api/project-groups/g1", { removed: true }], ["POST", "/api/halt", { engaged: true }]] as const) {
      let replied = false;
      const reply = fetch(`${h.base}${path}`, { method }).then(async response => { replied = true; return response.json(); });
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(replied, false, `${method} ${path} waits for the fence`);
      release({});
      assert.deepEqual(await reply, expected);
    }
    const uncertain = fetch(`${h.base}/api/halt`, { method: "POST" }).then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 50));
    release({ deliveryFence: "uncertain" });
    assert.deepEqual(await uncertain, { engaged: true, deliveryFence: "uncertain" });
    const list = fetch(`${h.base}/api/list`, { method: "POST" }).then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 50));
    release({ deliveryFence: "uncertain" });
    assert.deepEqual(await list, ["a"]);
    const failed = fetch(`${h.base}/api/fails`, { method: "POST" });
    await new Promise(resolve => setTimeout(resolve, 50));
    release({});
    assert.equal((await failed).status, 400);
    const before = calls;
    assert.deepEqual(await (await fetch(`${h.base}/api/permissions/log`)).json(), { read: true });
    assert.equal(calls, before);
  } finally { await h.close(); }
});

test("a fence that throws is reported as uncertain", async () => {
  const h = await app(() => Promise.reject(new Error("no fence")));
  try { assert.deepEqual(await (await fetch(`${h.base}/api/halt`, { method: "POST" })).json(), { engaged: true, deliveryFence: "uncertain" }); }
  finally { await h.close(); }
});
