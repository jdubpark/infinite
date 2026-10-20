import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "./helpers.js";

/** A small fake Responses API that records requests and can return model failures. */
async function fakeModel() {
  const requests: { auth: string; body: any }[] = [];
  let status = 200;
  let responseBody: any = { output: [{ type: "message", content: [{ type: "output_text", text: "Build the dictation route." }] }] };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization ?? "", body: JSON.parse(raw) });
      if (req.url !== "/v1/responses" || status !== 200) {
        res.writeHead(status || 404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "nope" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    fail: (code: number) => { status = code; },
    incomplete: () => { responseBody = { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "partial text" }] }] }; },
    close: () => server.close(),
  };
}

test("dictation cleanup is available only when configured and cleans text for owners and controllers", async () => {
  const model = await fakeModel();
  const root = mkdtempSync(join(tmpdir(), "infinite-dictation-"));
  const keyFile = join(root, "openai.key");
  writeFileSync(keyFile, "sk-test-key\n", { mode: 0o600 });
  const configured = await startHost({ config: { dictation: { model: "gpt-6-luna", apiKeyFile: keyFile, baseUrl: model.url } } });
  const unconfigured = await startHost();
  try {
    assert.deepEqual((await configured.fetchApi("/me")).body.capabilities.dictation, { model: "gpt-6-luna" });
    assert.equal("dictation" in (await unconfigured.fetchApi("/me")).body.capabilities, false);

    for (const role of ["owner", "controller"] as const) {
      const result = await configured.fetchApi("/dictation/cleanup", role, { text: "  Build the dictation route  " });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { model: "gpt-6-luna", text: "Build the dictation route." });
    }
    assert.equal(model.requests.length, 2);
    for (const request of model.requests) {
      assert.equal(request.auth, "Bearer sk-test-key");
      assert.equal(request.body.model, "gpt-6-luna");
      assert.equal(request.body.store, false);
      assert.equal(request.body.input, "Build the dictation route");
      assert.equal(typeof request.body.instructions, "string");
      assert.ok(request.body.instructions.length > 0);
      assert.ok(request.body.max_output_tokens > 0);
    }
  } finally {
    await configured.stop(); await unconfigured.stop(); model.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("dictation cleanup enforces roles, configuration, body limits, and complete model output", async () => {
  const model = await fakeModel();
  const root = mkdtempSync(join(tmpdir(), "infinite-dictation-errors-"));
  const keyFile = join(root, "openai.key");
  writeFileSync(keyFile, "sk-test-key\n", { mode: 0o600 });
  const configured = await startHost({ config: { dictation: { model: "gpt-6-luna", apiKeyFile: keyFile, baseUrl: model.url } } });
  const unconfigured = await startHost();
  try {
    assert.equal((await configured.fetchApi("/dictation/cleanup", "viewer", { text: "hello" })).status, 403);

    const unavailable = await unconfigured.fetchApi("/dictation/cleanup", "owner", { text: "hello" });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "dictation-unavailable");

    assert.equal((await configured.fetchApi("/dictation/cleanup", "owner", { text: "  " })).status, 400);
    assert.equal((await configured.fetchApi("/dictation/cleanup", "owner", { text: "x".repeat(32001) })).status, 400);
    assert.equal((await configured.fetchApi("/dictation/cleanup", "owner", { text: "hello", extra: true })).status, 400);

    model.fail(500);
    const failed = await configured.fetchApi("/dictation/cleanup", "owner", { text: "hello" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, "dictation-failed");
    assert.equal("text" in failed.body, false);

    model.fail(200);
    model.incomplete();
    const incomplete = await configured.fetchApi("/dictation/cleanup", "owner", { text: "hello" });
    assert.equal(incomplete.status, 502);
    assert.equal(incomplete.body.code, "dictation-failed");
    assert.equal("text" in incomplete.body, false);
  } finally {
    await configured.stop(); await unconfigured.stop(); model.close(); rmSync(root, { recursive: true, force: true });
  }
});
