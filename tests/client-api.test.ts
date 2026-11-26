import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createClientApi, HttpError, type ClientApi } from "../packages/host/src/client-api.js";
import { askForBrief } from "../packages/host/src/team-cli.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("ClientApi.json applies the default 15s timeout when omitted and never clamps a caller timeout override", async t => {
  await withServer((req, res) => {
    if (req.url === "/api/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "not-found" }));
  }, async origin => {
    const api = createClientApi({ origin, token: "fixture-token" });
    const spy = t.mock.method(AbortSignal, "timeout");

    assert.deepEqual(await api.json("/ok"), { ok: true });
    assert.deepEqual(spy.mock.calls.map(call => call.arguments), [[15_000]]);

    spy.mock.resetCalls();
    const cancel = new AbortController();
    assert.deepEqual(await api.json("/ok", undefined, cancel.signal), { ok: true });
    assert.deepEqual(spy.mock.calls.map(call => call.arguments), [[15_000]]);

    spy.mock.resetCalls();
    assert.deepEqual(await api.json("/ok", undefined, undefined, undefined, undefined, 180000), { ok: true });
    assert.deepEqual(spy.mock.calls.map(call => call.arguments), [[180000]]);

    spy.mock.resetCalls();
    assert.deepEqual(await api.json("/ok", undefined, cancel.signal, undefined, undefined, 180000), { ok: true });
    assert.deepEqual(spy.mock.calls.map(call => call.arguments), [[180000]]);
  });
});

test("ClientApi.json enforces per-call timeoutMs, honors caller AbortSignal, and parses non-OK JSON errors", async t => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  await withServer((req, res) => {
    if (req.url === "/api/slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      }, 250);
      timers.add(timer);
      return;
    }
    if (req.url === "/api/conflict") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "stale-enrollment-revision" }));
      return;
    }
    if (req.url === "/api/plain-error") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("raw internal failure detail");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async origin => {
    const api = createClientApi({ origin, token: "fixture-token" });
    try {
      await assert.rejects(
        api.json("/slow", undefined, undefined, undefined, undefined, 40),
        (error: unknown) => error instanceof Error && error.name === "TimeoutError",
      );

      assert.deepEqual(await api.json("/slow", undefined, undefined, undefined, undefined, 2000), { ok: true });

      const cancel = new AbortController();
      const abortTimer = setTimeout(() => cancel.abort(new Error("caller-cancelled")), 40);
      try {
        await assert.rejects(
          api.json("/slow", undefined, cancel.signal, undefined, undefined, 5000),
          (error: unknown) => error instanceof Error && error.message === "caller-cancelled",
        );
      } finally {
        clearTimeout(abortTimer);
      }

      const spy = t.mock.method(AbortSignal, "timeout");
      await assert.rejects(
        api.json("/ok", undefined, cancel.signal, undefined, undefined, 180000),
        (error: unknown) => error instanceof Error && error.message === "caller-cancelled",
      );
      assert.equal(spy.mock.calls.length, 0);

      await assert.rejects(
        api.json("/conflict", undefined, undefined, undefined, undefined, 5000),
        (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "stale-enrollment-revision" && /repository enrollment changed/.test(error.message),
      );

      await assert.rejects(
        api.json("/plain-error", undefined, undefined, undefined, undefined, 5000),
        (error: unknown) => error instanceof HttpError && error.status === 500 && error.code === undefined && !/raw internal failure detail/.test(error.message),
      );

      for (const invalid of [0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(api.json("/ok", undefined, undefined, undefined, undefined, invalid), RangeError);
      }
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });
});

test("askForBrief uses Api.json with a 180s timeout override and handles non-OK JSON errors and aborts cleanly", async t => {
  let mode: "ready" | "error" | "slow" = "ready";
  let requestCount = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const team = {
    id: "team-1",
    status: "planning",
    title: "Brief timeout check",
    projectId: "workspace",
    workspace: "/work/integration",
    branch: "infinite/team-1",
    revision: 1,
    members: [{ memberId: "pm", sessionId: "session-1", role: "project-manager", revision: 1, title: "Plan", status: "running" }],
  };
  const emptyRows = [{ sessionId: "session-1", status: { state: "empty" } }];

  await withServer((req, res) => {
    if (req.url === "/api/sessions/session-1/summary?after=0") {
      requestCount += 1;
      if (mode === "ready") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "Refreshed brief summary" }));
        return;
      }
      if (mode === "error") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "briefing-unavailable" }));
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: "Late summary" }));
        }
      }, 250);
      timers.add(timer);
      return;
    }
    res.writeHead(404);
    res.end();
  }, async origin => {
    const real = createClientApi({ origin, token: "fixture-token" });
    const guardedApi: ClientApi = {
      request: async () => { throw new Error("askForBrief must use api.json rather than api.request"); },
      json: real.json,
    };
    const shown: string[] = [];
    const spy = t.mock.method(AbortSignal, "timeout");
    try {
      const updated = await askForBrief(guardedApi, team, emptyRows, new AbortController().signal, text => shown.push(text), "12:00:00");
      assert.equal(requestCount, 1);
      assert.equal(updated.length, 1);
      assert.equal(updated[0]!.status.state, "ready");
      assert.equal(updated[0]!.status.summary?.text, "Refreshed brief summary");
      assert.deepEqual(spy.mock.calls.map(call => call.arguments), [[180000]]);
      assert.match(shown[0] ?? "", /Refreshing the Brief/);

      mode = "error";
      const failed = await askForBrief(guardedApi, team, emptyRows, new AbortController().signal, () => {}, "12:00:01");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.status.state, "failed");
      assert.match(failed[0]!.status.error ?? "", /Host returned HTTP 503 \(briefing-unavailable\)/);

      mode = "slow";
      const cancel = new AbortController();
      const abortTimer = setTimeout(() => cancel.abort(new Error("user-quit")), 40);
      try {
        await assert.rejects(
          askForBrief(guardedApi, team, emptyRows, cancel.signal, () => {}, "12:00:02"),
          (error: unknown) => error instanceof Error && error.message === "user-quit",
        );
      } finally {
        clearTimeout(abortTimer);
      }
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });
});
