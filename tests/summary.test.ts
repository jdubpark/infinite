import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responseText, transcriptText } from "../packages/host/src/summary.js";
import { claimControl, startHost, waitFor } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

/** A stand-in for the OpenAI Responses API that records what it was asked. */
async function fakeModel() {
  const requests: { auth: string; body: any }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization ?? "", body: JSON.parse(raw) });
      if (req.url !== "/v1/responses" || status !== 200) { res.writeHead(status || 404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "nope" } })); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "The agent says it removed the build directory. It was not waiting on anything." }] }],
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, fail: (code: number) => { status = code; }, close: () => server.close() };
}

test("transcript text and response parsing", () => {
  const text = transcriptText([
    { id: "1", role: "user", text: "Fix it", ts: "t" }, { id: "2", role: "tool", toolName: "Bash", text: "npm test\nsecond line", ts: "t" }, { id: "3", role: "assistant", text: "Done.", ts: "t" },
  ]);
  assert.equal(text, "Person: Fix it\n\nAgent ran Bash: npm test\n\nAgent: Done.");
  assert.equal(responseText({ output: [{ type: "message", content: [{ type: "output_text", text: " A " }, { type: "output_text", text: "B" }] }] }), "A B");
  assert.equal(responseText({ output: "junk" }), "");
});

test("a summary covers the chat after a cursor, names its model, and is cached per range", { timeout: 60000 }, async () => {
  const model = await fakeModel();
  const root = mkdtempSync(join(tmpdir(), "infinite-summary-"));
  const keyFile = join(root, "openai.key");
  writeFileSync(keyFile, "sk-test-key\n", { mode: 0o600 });
  const host = await startHost({ config: { attention, summaries: { model: "gpt-6-luna", apiKeyFile: keyFile, baseUrl: model.url } } });
  try {
    assert.deepEqual((await host.fetchApi("/me")).body.capabilities.summaries, { model: "gpt-6-luna" });
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Digest", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    const chat = await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.some((m: any) => /Removed the build directory/.test(m.text)), 15000);

    const summary = await host.fetchApi(`/sessions/${id}/summary`, "viewer");
    assert.equal(summary.status, 200);
    assert.equal(summary.body.model, "gpt-6-luna");
    assert.match(summary.body.text, /^The agent says it removed/);
    assert.equal(summary.body.from, "0");
    assert.equal(summary.body.to, chat.body.cursor);
    assert.equal(summary.body.messages, chat.body.messages.length);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].auth, "Bearer sk-test-key");
    assert.equal(model.requests[0].body.model, "gpt-6-luna");
    assert.match(model.requests[0].body.instructions, /attribute it to the agent/);
    assert.match(model.requests[0].body.input, /Person: hook dialog[\s\S]*Agent ran Bash: rm -rf build[\s\S]*Agent: Removed the build directory/);
    assert.equal(model.requests[0].body.store, false);

    // The same range is served from cache; a later cursor asks the model again, for less.
    assert.equal((await host.fetchApi(`/sessions/${id}/summary`)).body.at, summary.body.at);
    assert.equal(model.requests.length, 1);
    const empty = await host.fetchApi(`/sessions/${id}/summary?after=${chat.body.cursor}`);
    assert.equal(empty.body.text, "");
    assert.equal(empty.body.messages, 0);
    assert.equal(model.requests.length, 1, "nothing new needs no model call");
    // Cursors are journal positions: a page starting after the first message leaves it out.
    const firstMessage = (await host.fetchApi(`/sessions/${id}/events?types=message&limit=200`)).body.events[0];
    const firstPage = { body: { cursor: String(firstMessage.seq) } };
    const later = await host.fetchApi(`/sessions/${id}/summary?after=${firstPage.body.cursor}`);
    assert.equal(model.requests.length, 2);
    assert.ok(!model.requests[1].body.input.includes("Person: hook dialog"));
    assert.ok(model.requests[1].body.input.includes("Agent: Removed the build directory"));
    assert.equal(later.body.from, firstPage.body.cursor);

    model.fail(429);
    const refused = await host.fetchApi(`/sessions/${id}/summary?after=1`);
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, "summary-failed");
    assert.match(refused.body.error, /refused the request \(429\)/);
  } finally {
    await host.stop(); model.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a host without a summary model says so", async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Plain", prompt: "" });
    const summary = await host.fetchApi(`/sessions/${id}/summary`);
    assert.equal(summary.status, 503);
    assert.equal(summary.body.code, "summaries-unavailable");
    assert.equal("summaries" in (await host.fetchApi("/me")).body.capabilities, false);
  } finally { await host.stop(); }
});
