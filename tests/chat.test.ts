import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claimControl, startHost, waitFor } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

test("chat is the provider's own conversation record, delivered over the hook relay", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Chat", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    // Before any reply, the user's prompt and the tool call are already in the chat.
    const early = await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.source === "transcript" && r.body.messages.length >= 3, 10000);
    assert.deepEqual(early.body.messages.map((m: any) => [m.role, m.toolName ?? m.text]), [
      ["user", "hook dialog"], ["assistant", "I will remove the stale build directory."], ["tool", "Bash"],
    ]);
    assert.ok(!early.body.messages.some((m: any) => m.id === "initial"), "the transcript already holds the first prompt");
    const control = await claimControl(host, id, "owner");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    assert.equal(answer.body.result, "closed");
    const finished = await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.some((m: any) => m.role === "assistant" && /Removed the build directory/.test(m.text)), 15000);
    const last = finished.body.messages.at(-1);
    assert.equal(last.role, "assistant");
    assert.match(last.id, /^message:demo-/);
    // Paging from the cursor returns only what arrived later; a follow-up reaches chat the same way.
    const sent = await host.fetchApi(`/sessions/${id}/input`, "owner", { requestId: randomUUID(), text: "Thanks, now stop", submit: true }, control.headers);
    assert.equal(sent.body.state, "delivered");
    const next = await waitFor(() => host.fetchApi(`/sessions/${id}/messages?after=${finished.body.cursor}`), (r) => r.body.messages.length >= 2, 15000);
    assert.deepEqual(next.body.messages.map((m: any) => [m.role, m.text]).slice(0, 2), [["user", "Thanks, now stop"], ["assistant", `Message received by process ${(await host.fetchApi(`/sessions/${id}`)).body.pid}.`]]);
    assert.ok(!next.body.messages.some((m: any) => m.id.startsWith("input:")), "no synthesized duplicates once the transcript exists");
    assert.ok(next.body.messages.every((m: any) => Number.isInteger(m.seq) && m.seq > Number(finished.body.cursor)), "each message carries its journal position");
    const events = await host.fetchApi(`/sessions/${id}/events?types=message`);
    assert.ok(events.body.events.every((e: any) => e.type === "message" && typeof e.data.text === "string"));
    assert.equal((await host.fetchApi(`/sessions/${id}`)).body.capabilities.transcript, 1);
  } finally {
    await host.stop();
  }
});

test("without a transcript the chat still shows delivered prompts and never fabricates replies", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Plain", prompt: "Initial request" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "running", 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/input`, "owner", { requestId: randomUUID(), text: "A plain follow-up", submit: true }, control.headers);
    const chat = await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.length >= 2, 10000);
    assert.equal(chat.body.source, "recording");
    assert.deepEqual(chat.body.messages.map((m: any) => [m.role, m.text]), [["user", "Initial request"], ["user", "A plain follow-up"]]);
  } finally {
    await host.stop();
  }
});
