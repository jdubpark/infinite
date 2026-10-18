import test from "node:test";
import assert from "node:assert/strict";
import { startHookServer, HookPayloadError } from "../packages/host/src/hooks.js";

test("hook server accepts authenticated JSON and rejects the rest", async () => {
  const received: { route: string; body: unknown }[] = [];
  let errors = 0;
  const server = await startHookServer({ token: "secret", onPayload: (route, body) => received.push({ route, body }), onError: () => errors++ });
  try {
    const post = (path: string, body: string, auth?: string) =>
      fetch(`${server.url}${path}`, { method: "POST", body, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) } });
    let r = await post("/claude", JSON.stringify({ hook_event_name: "Stop" }), "Bearer secret");
    assert.equal(r.status, 204);
    r = await post("/codex", JSON.stringify({ hook_event_name: "Stop" }), "Bearer wrong");
    assert.equal(r.status, 401);
    r = await post("/claude", "not json", "Bearer secret");
    assert.equal(r.status, 400);
    r = await post("/claude", JSON.stringify([{ hook_event_name: "Stop" }]), "Bearer secret");
    assert.equal(r.status, 400);
    r = await post("/elsewhere", "{}", "Bearer secret");
    assert.equal(r.status, 404);
    r = await post("/claude", JSON.stringify({ big: "x".repeat(300 * 1024) }), "Bearer secret");
    assert.equal(r.status, 413);
    assert.deepEqual(received, [{ route: "claude", body: { hook_event_name: "Stop" } }]);
    assert.equal(errors, 4);
  } finally {
    server.close();
  }
});

test("report acceptance is refused when validation or durable recording fails", async () => {
  let failure: "validation" | "storage" = "validation";
  const server = await startHookServer({
    token: "scoped-report-capability",
    onPayload: () => {
      if (failure === "validation") throw new HookPayloadError(409);
      throw new Error("Simulated journal write failure");
    },
    onError: () => {},
  });
  const post = () => fetch(`${server.url}/team-report`, {
    method: "POST", headers: { Authorization: "Bearer scoped-report-capability", "Content-Type": "application/json" }, body: "{}",
  });
  try {
    assert.equal((await post()).status, 409, "A rejected report must not receive an acceptance receipt");
    failure = "storage";
    assert.equal((await post()).status, 500, "A failed journal append must not receive an acceptance receipt");
  } finally { server.close(); }
});
