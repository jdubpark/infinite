import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost } from "./helpers.js";

test("new sessions record cloud execution and /me reports the cloud default", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const me = await host.fetchApi("/me");
    assert.equal(me.body.execution.default, "cloud");
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Cloud", prompt: "" });
    assert.equal(created.status, 201);
    assert.equal(created.body.executionLocation, "cloud");
    assert.equal(created.body.machineId, me.body.machine.id);
    const row = (await host.fetchApi("/sessions")).body.sessions.find((s: { id: string }) => s.id === id);
    assert.equal(row.executionLocation, "cloud");
    const detail = await host.fetchApi(`/sessions/${id}`);
    assert.equal(detail.body.executionLocation, "cloud");
  } finally { await host.stop(); }
});
