import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("repository briefings run automatically after a turn end, reuse the snapshot, and do not backfill on restart", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-jevcode-"));
  const receipt = join(root, "calls.jsonl");
  const fixture = join(process.cwd(), "tests/fixtures/jevcode-brief.mjs");
  const commandArgs = [fixture, receipt];
  const host = await startHost({ config: { attention, repositoryBriefings: {
    command: process.execPath, args: commandArgs, model: "gpt-6-luna", automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000,
  } } });
  try {
    execFileSync("git", ["init", "-q"], { cwd: host.config.projects[0].path });
    execFileSync("git", ["-C", host.config.projects[0].path, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", host.config.projects[0].path, "config", "user.name", "Test"]);
    writeFileSync(join(host.config.projects[0].path, "README.md"), "fixture repository\n");
    execFileSync("git", ["-C", host.config.projects[0].path, "add", "README.md"]);
    execFileSync("git", ["-C", host.config.projects[0].path, "commit", "-qm", "fixture"]);

    assert.deepEqual((await host.fetchApi("/me")).body.capabilities.repositoryBriefings, { model: "gpt-6-luna", automatic: true });
    assert.deepEqual((await host.fetchApi("/me")).body.capabilities.summaries, { model: "gpt-6-luna" }, "repository briefings expose the summary capability without legacy summary configuration");
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Automatic brief", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);

    const status = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`, "viewer"), r => r.body.state === "ready" || r.body.state === "failed", 20000);
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "ready");
    assert.equal(status.body.summary.engine, "jevcode");
    assert.equal(status.body.summary.repository.base, execFileSync("git", ["-C", host.config.projects[0].path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.match(status.body.summary.text, /Fixture repository brief/);
    const firstReceipt = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(firstReceipt.length, 1, "the turn-end event must trigger generation without a manual summary request");
    assert.deepEqual(firstReceipt[0].input.split("\n").filter(Boolean).map((line: string) => JSON.parse(line).role), ["user", "assistant", "tool", "assistant"]);
    assert.ok(firstReceipt[0].args.includes("--activity-stdin"));
    assert.ok(firstReceipt[0].args.includes("--no-state"));

    const cached = await host.fetchApi(`/sessions/${id}/summary`, "viewer");
    assert.equal(cached.body.engine, "jevcode");
    assert.equal(cached.body.repository.fingerprint, status.body.summary.repository.fingerprint);
    assert.equal(readFileSync(receipt, "utf8").trim().split("\n").length, 1, `explicit reads reuse the generated transcript range ${status.body.summary.from}-${status.body.summary.to}`);
    assert.equal((await host.fetchApi(`/sessions/${id}/summary?status=1`, null)).status, 401);

    const empty = await host.fetchApi(`/sessions/${id}/summary?after=${status.body.summary.to}`, "viewer");
    assert.deepEqual(Object.keys(empty.body).sort(), ["at", "engine", "from", "messages", "model", "text", "to"]);
    assert.equal(empty.body.engine, "jevcode");
    assert.equal(empty.body.model, "gpt-6-luna");
    assert.equal(empty.body.text, "");
    assert.equal(empty.body.from, status.body.summary.to);
    assert.equal(empty.body.messages, 0);
    assert.ok(Number.isFinite(Date.parse(empty.body.at)));
    assert.equal(readFileSync(receipt, "utf8").trim().split("\n").length, 1, "an empty cursor range returns the summary contract without invoking the runner");

    await host.stopApi();
    await host.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(readFileSync(receipt, "utf8").trim().split("\n").length, 1, "startup only primes journal cursors; it does not backfill historical turns");
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed automatic repository brief is safe and does not retry the same checkpoint", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-jevcode-fail-"));
  const receipt = join(root, "calls.jsonl");
  const fixture = join(process.cwd(), "tests/fixtures/jevcode-brief.mjs");
  const host = await startHost({ config: { attention, repositoryBriefings: {
    command: process.execPath, args: [fixture, receipt, "fail"], model: "gpt-6-luna", automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000,
  } } });
  try {
    execFileSync("git", ["init", "-q"], { cwd: host.config.projects[0].path });
    execFileSync("git", ["-C", host.config.projects[0].path, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", host.config.projects[0].path, "config", "user.name", "Test"]);
    writeFileSync(join(host.config.projects[0].path, "README.md"), "fixture repository\n");
    execFileSync("git", ["-C", host.config.projects[0].path, "add", "README.md"]);
    execFileSync("git", ["-C", host.config.projects[0].path, "commit", "-qm", "fixture"]);
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Failed brief", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    const status = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`), r => r.body.state === "failed", 20000);
    assert.equal(status.body.error, "Repository brief could not be generated. Check the configured briefing wrapper.");
    const stop = await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    assert.equal(stop.status, 200);
    const exited = await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "exited", 15000);
    assert.equal(exited.body.status, "exited");
    // Observe the exit-triggered run itself so an earlier failed state cannot satisfy the wait.
    const exitAttempt = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`), r => r.body.state === "pending", 15000);
    assert.equal(exitAttempt.body.state, "pending");
    const settled = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`), r => r.body.state === "failed", 15000);
    assert.equal(settled.body.error, "Repository brief could not be generated. Check the configured briefing wrapper.");
    const settledCount = readFileSync(receipt, "utf8").trim().split("\n").length;
    assert.equal(settledCount, 2, "the initial failure and one exit checkpoint each run once");
    for (let poll = 0; poll < 4; poll++) {
      const [briefStatus, session] = await Promise.all([
        host.fetchApi(`/sessions/${id}/summary?status=1`),
        host.fetchApi(`/sessions/${id}`),
      ]);
      assert.equal(session.body.status, "exited");
      assert.equal(briefStatus.body.state, "failed");
      assert.equal(readFileSync(receipt, "utf8").trim().split("\n").length, settledCount, "a settled failed brief is not replayed on later polls");
      await new Promise(resolve => setTimeout(resolve, 125));
    }
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic brief uses the latest transcript after a delayed provider flush and labels its bounded activity", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-briefing-transcript-"));
  const transcript = join(root, "provider-session.jsonl");
  const receipt = join(root, "calls.jsonl");
  const releaseLateTranscript = join(root, "release-late-transcript");
  const agent = join(process.cwd(), "tests/fixtures/briefing-transcript-agent.mjs");
  const cli = join(process.cwd(), "tests/fixtures/jevcode-brief.mjs");
  const host = await startHost({ agents: { claude: { command: process.execPath, args: [agent, transcript, releaseLateTranscript] } }, config: { attention,
    repositoryBriefings: { command: process.execPath, args: [cli, receipt], model: "gpt-6-luna", automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
  } });
  try {
    const project = host.config.projects[0].path;
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["-C", project, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", project, "config", "user.name", "Test"]);
    writeFileSync(join(project, "README.md"), "fixture repository\n");
    execFileSync("git", ["-C", project, "add", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);

    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "claude", projectId: "rehearsal", title: "Long transcript", prompt: "Inspect the recent work." });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running" && r.body.capabilities?.transcript === 1, 20000);
    const queued = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`), r => r.body.state === "pending", 20000);
    assert.equal(queued.body.state, "pending", "the Stop hook has been observed before the late transcript append");
    writeFileSync(releaseLateTranscript, "release");
    const status = await waitFor(() => host.fetchApi(`/sessions/${id}/summary?status=1`), r => r.body.state === "ready" || r.body.state === "failed", 30000);
    assert.equal(status.body.state, "ready");
    assert.match(status.body.summary.text, /FINAL_TRANSCRIPT_MARKER/);
    assert.equal(status.body.summary.repository.activity.included, 200);
    assert.ok(status.body.summary.repository.activity.observed > 200);
    assert.equal(status.body.summary.repository.activity.truncated, true);
    assert.ok(status.body.summary.repository.coverage.some((line: string) => /Session activity: 200 of \d+ recorded messages included; activity outside the bounded message or page limits omitted/.test(line)), "the public coverage identifies the bounded activity window");

    const calls = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 1, "the provider transcript should produce one automatic checkpoint");
    assert.ok(calls[0].args.includes("--activity-stdin"));
    const activity = calls[0].input.split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
    assert.equal(activity.length, 200, "only the bounded latest activity window is sent");
    assert.ok(activity.some((message: { text: string }) => message.text.includes("FINAL_TRANSCRIPT_MARKER")), "the delayed final transcript append must be in the collected snapshot");
    assert.ok(status.body.summary.repository.evidence.some((item: { source: string; text: string }) => item.source === "activity:1" && item.text.includes("FINAL_TRANSCRIPT_MARKER")), "the cited activity evidence survives into the public summary");
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
