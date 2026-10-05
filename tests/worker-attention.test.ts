import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicAttention, withDefaultAttention } from "../packages/host/src/manager.js";
import { startHost, waitFor, type Host } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

type SignalRow = { seq: number; data: { kind: string; promptId?: number; source: string; type?: string; title?: string; detail?: string } };
const signalsOf = async (host: Host, id: string) =>
  (await host.fetchApi(`/sessions/${id}/events?types=signal`)).body.events as SignalRow[];
/** Every prompt-open is closed exactly once in the journal, after it opened; answers never repeat. */
function assertClosedOnce(signals: SignalRow[]) {
  for (const open of signals.filter((e) => e.data.kind === "prompt-open")) {
    const closes = signals.filter((e) => e.data.kind === "prompt-closed" && e.data.promptId === open.seq);
    assert.equal(closes.length, 1, `prompt ${open.seq} closed ${closes.length} times: ${JSON.stringify(signals.map((e) => e.data))}`);
    assert.ok(closes[0].seq > open.seq);
    assert.ok(signals.filter((e) => e.data.kind === "answer" && e.data.promptId === open.seq).length <= 1);
  }
}

test("dialog session: screen + hook prompt merge, answer closes it, stale answer is refused", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Dialog", prompt: "dialog hook" });
    assert.equal(created.status, 201);
    // Wait for both halves: the screen's hash and the hook's tool, whichever arrived first.
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 15000);
    const prompt = detail.body.attention.prompt;
    assert.equal(prompt.kind, "permission");
    assert.equal(prompt.source, "hook");                 // hook opened it
    assert.equal(prompt.options.length, 3);              // screen supplied the options
    assert.equal(prompt.tool.name, "Bash");              // hook supplied the tool
    assert.deepEqual(prompt.destructive, { pattern: "rm-recursive-force" });
    assert.match(prompt.detail, /rm -rf build/);          // the dialog's own detail, which shows the command
    assert.equal(detail.body.attention.hooks, "active");
    assert.match(detail.body.attention.now, /rm -rf build/);

    const list = await host.fetchApi("/sessions");
    const row = list.body.sessions.find((s: { id: string }) => s.id === id);
    assert.equal(row.attention.state, "needs-you");
    assert.deepEqual(row.attention.prompt.tool.input, {});   // list rows omit tool input

    const viewer = await host.fetchApi(`/sessions/${id}/answer`, "viewer", { requestId: randomUUID(), promptId: prompt.id, option: 0 });
    assert.equal(viewer.status, 403);

    const stale = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id - 1, option: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "prompt-changed");

    const requestId = randomUUID();
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId, promptId: prompt.id, option: 1 });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.state, "delivered");
    assert.equal(answer.body.result, "closed");
    assert.equal("digest" in answer.body, false);        // the request digest stays in the worker
    const again = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId, promptId: prompt.id, option: 1 });
    assert.equal(again.status, 200);                     // idempotent replay
    assert.deepEqual(again.body, answer.body);

    const finished = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention.state === "turn-finished", 10000);
    assert.match(finished.body.attention.lastMessage, /Removed the build directory/);

    const events = await host.fetchApi(`/sessions/${id}/events?types=signal`);
    const kinds = events.body.events.map((e: { data: { kind: string } }) => e.data.kind);
    for (const k of ["hooks-ready", "turn-start", "tool-start", "prompt-open", "answer", "prompt-closed", "tool-end", "turn-end"]) assert.ok(kinds.includes(k), k);
    const answered = events.body.events.find((e: { data: { kind: string } }) => e.data.kind === "answer").data;
    assert.equal(answered.option.label, "Yes, and don't ask again for rm commands");
    assert.equal(answered.result, "closed");
    // One dialog, one prompt-open, closed exactly once whatever order the hooks and screen took.
    assert.equal(kinds.filter((k: string) => k === "prompt-open").length, 1);
    assertClosedOnce(events.body.events);
  } finally {
    await host.stop();
  }
});

test("screen-only yes/no prompt and idle detection without hooks", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "YesNo", prompt: "yesno" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you", 15000);
    assert.equal(detail.body.attention.prompt.kind, "yes-no");
    assert.equal(detail.body.attention.prompt.source, "screen");
    assert.equal(detail.body.attention.hooks, "none");
    // A dialog without a "No, and tell …" option takes no free text.
    const textOnly = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, text: "yes please" });
    assert.equal(textOnly.status, 409);
    assert.equal(textOnly.body.error, "text-not-accepted");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 });
    assert.equal(answer.body.result, "closed");
    assert.equal("digest" in answer.body, false);
    const idle = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention.state === "idle", 30000);
    assert.equal(idle.body.attention.now, "Waiting for your direction");
  } finally {
    await host.stop();
  }
});

test("feedback text follows the reject option once the dialog closes; mismatched answers are refused", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Feedback", prompt: "dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const prompt = detail.body.attention.prompt;
    assert.equal(prompt.source, "screen");
    assert.equal(prompt.acceptsText, true);

    const outOfRange = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, option: 3 });
    assert.equal(outOfRange.status, 409);
    assert.equal(outOfRange.body.error, "invalid-option");
    assert.equal(outOfRange.body.attention.prompt.id, prompt.id);   // still open, nothing pressed
    const textWithYes = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, option: 0, text: "Use a dry run first" });
    assert.equal(textWithYes.status, 409);
    assert.equal(textWithYes.body.error, "text-not-accepted");

    const feedback = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, text: "Keep the build directory" });
    assert.equal(feedback.status, 200);
    assert.equal(feedback.body.result, "closed");
    const after = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("You: Keep the build directory"), 5000);
    assert.match(after.body.screen, /Selected: No, and tell Claude what to do differently/);

    // Refusals journal nothing; the delivered answer records its key sequence and the text.
    const intents = (await host.fetchApi(`/sessions/${id}/events?types=input-intent`)).body.events;
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0].data.keys, ["down", "down", "enter"]);
    assert.equal(intents[0].data.text, "Keep the build directory");
  } finally {
    await host.stop();
  }
});

test("hook prompts merge only into their own dialog, and never while it is being answered", { timeout: 60000 }, async () => {
  const agent = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/hook-agent.mjs", import.meta.url))] };
  const host = await startHost({ agents: { demo: agent }, config: { attention } });
  try {
    const modes = ["mismatch", "hook-first", "two-hooks", "answer-race", "merge", "denied"];
    const ids: Record<string, string> = Object.fromEntries(modes.map((m) => [m, randomUUID()]));
    await Promise.all(modes.map((m) => host.fetchApi("/sessions", "owner", { requestId: ids[m], provider: "demo", projectId: "rehearsal", title: m, prompt: m })));
    const signals = async (mode: string) =>
      ((await host.fetchApi(`/sessions/${ids[mode]}/events?types=signal`)).body.events as { data: { kind: string; type?: string; reason?: string; message?: string; source: string } }[])
        .map(({ data: d }) => `${d.kind}${d.type ? `/${d.type}` : ""}${d.reason ? `/${d.reason}` : ""}${d.message ? `[${d.message}]` : ""}(${d.source})`);
    const attentionOf = async (mode: string) => (await host.fetchApi(`/sessions/${ids[mode]}`)).body.attention;

    // Another command's hook while the rm dialog is on screen: nothing is borrowed, the mismatch is noted.
    await waitFor(() => signals("mismatch"), (s) => s.includes("notice/prompt-mismatch[git push --force origin main](hook)"), 10000);
    const kept = (await attentionOf("mismatch")).prompt;
    assert.equal(kept.source, "screen");
    assert.equal(kept.tool, undefined);
    assert.deepEqual(kept.destructive, { pattern: "rm-recursive-force" });

    // A hook prompt waiting for its block is superseded by an unrelated block, which opens from the screen.
    const replaced = await waitFor(() => attentionOf("hook-first"), (a) => a.prompt?.hash, 10000);
    assert.equal(replaced.prompt.source, "screen");
    assert.match(replaced.prompt.detail, /rm -rf build/);
    assert.doesNotMatch(replaced.prompt.detail, /git push/);
    assert.ok((await signals("hook-first")).includes("prompt-closed/superseded(screen)"));

    // A second hook-only prompt replaces the first.
    const second = await waitFor(() => attentionOf("two-hooks"), (a) => a.prompt?.detail === "git push --force origin main", 10000);
    assert.equal(second.prompt.source, "hook");
    const twoHooks = await signals("two-hooks");
    assert.deepEqual(twoHooks.filter((s) => s.startsWith("prompt-")), ["prompt-open(hook)", "prompt-closed/superseded(hook)", "prompt-open(hook)"]);

    // A hook that matches the dialog but arrives mid-answer is only noted; the answer completes.
    const open = await waitFor(() => attentionOf("answer-race"), (a) => a.state === "needs-you" && a.prompt?.hash, 10000);
    const answer = await host.fetchApi(`/sessions/${ids["answer-race"]}/answer`, "controller", { requestId: randomUUID(), promptId: open.prompt.id, option: 1 });
    assert.equal(answer.body.result, "closed");
    const race = await signals("answer-race");
    assert.ok(race.includes("notice/prompt-mismatch[rm -rf build](hook)"), race.join(" "));
    assert.ok(!race.some((s) => s.includes("superseded")), race.join(" "));
    assert.ok(race.includes("prompt-closed/answered-here(host)"), race.join(" "));

    // A hook-first prompt takes the block's title and detail, and the journal says so for the timeline.
    const merged = await waitFor(() => attentionOf("merge"), (a) => a.prompt?.hash, 10000);
    assert.equal(merged.prompt.title, "Do you want to proceed?");
    assert.equal(merged.prompt.source, "hook");
    const mergeSignals = await signalsOf(host, ids.merge);
    const mergeOpen = mergeSignals.find((e) => e.data.kind === "prompt-open")!;
    assert.equal(mergeOpen.data.source, "hook");
    const notice = mergeSignals.find((e) => e.data.type === "prompt-merged");
    assert.ok(notice, JSON.stringify(mergeSignals));
    assert.equal(notice.data.promptId, mergeOpen.seq);
    assert.equal(notice.data.title, "Do you want to proceed?");
    assert.match(notice.data.detail ?? "", /rm -rf build/);

    // PermissionDenied closes the hook-only prompt it refused.
    const denied = await waitFor(() => signals("denied"), (s) => s.includes("notice/permission_denied[Denied by policy](hook)"), 10000);
    assert.deepEqual(denied.filter((s) => s.startsWith("prompt-")), ["prompt-open(hook)", "prompt-closed/resolved(hook)"]);
    const afterDenied = await attentionOf("denied");
    assert.equal(afterDenied.state, "working");
    assert.equal(afterDenied.prompt, undefined);
  } finally {
    await host.stop();
  }
});

test("composer text over an open dialog is refused unless a terminal surface forces it", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Guard", prompt: "dialog hook" });
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 15000);
    const promptId = open.body.attention.prompt.id;

    for (const submit of [true, false]) {
      const refused = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "prompt-open");
      assert.equal(refused.body.attention.prompt.id, promptId);
    }
    // Nothing was journaled or typed: the dialog is still open on its first option.
    assert.equal((await host.fetchApi(`/sessions/${id}/events?types=input-intent,input-result`)).body.events.length, 0);
    const still = (await host.fetchApi(`/sessions/${id}`)).body;
    assert.equal(still.attention.state, "needs-you");
    assert.equal(still.attention.prompt.id, promptId);
    assert.match(still.screen, /❯ 1\. Yes/);
    assert.doesNotMatch(still.screen, /Selected:/);

    // The terminal route forces it; Enter then picks the highlighted option, as a keyboard would.
    const forced = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit: true, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.state, "delivered");
    assert.deepEqual(Object.keys(forced.body).sort(), ["requestId", "seq", "state"]);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("Selected: Yes"), 5000);
    const intents = (await host.fetchApi(`/sessions/${id}/events?types=input-intent`)).body.events;
    assert.equal(intents.length, 1);
    assert.equal(intents[0].data.force, true);
  } finally {
    await host.stop();
  }
});

test("a dialog drawn before its hooks opens one prompt; rejecting it clears the running tool", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Screen first", prompt: "dialog-first hook" });
    // All three hooks (UserPromptSubmit, PreToolUse, PermissionRequest) land after the block.
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool && r.body.attention.lastTool, 15000);
    const prompt = open.body.attention.prompt;
    assert.equal(prompt.title, "Do you want to proceed?");
    assert.equal(open.body.attention.lastTool.summary, "rm -rf build");
    const before = await signalsOf(host, id);
    const opens = before.filter((e) => e.data.kind === "prompt-open");
    assert.equal(opens.length, 1, JSON.stringify(before.map((e) => e.data)));
    assert.equal(opens[0].data.source, "screen");          // the screen saw it first
    assert.equal(prompt.id, opens[0].seq);
    for (const kind of ["turn-start", "tool-start"]) {
      const at = before.find((e) => e.data.kind === kind);
      assert.ok(at && at.seq > opens[0].seq, `${kind} arrives after the screen's prompt-open`);
    }

    // "No, and tell Claude what to do differently" with feedback.
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, text: "Keep the build directory" });
    assert.equal(answer.body.result, "closed");
    const after = (await host.fetchApi(`/sessions/${id}`)).body.attention;
    assert.equal(after.prompt, undefined);
    assert.equal(after.lastTool, undefined);
    assert.doesNotMatch(after.now, /Running/);

    const signals = await signalsOf(host, id);
    assert.equal(signals.filter((e) => e.data.kind === "prompt-open").length, 1);
    assertClosedOnce(signals);
  } finally {
    await host.stop();
  }
});

test("a worker without attention reports a default instead of breaking the list", () => {
  const now = "2026-10-05T00:00:00.000Z";
  const running = withDefaultAttention({ status: "running", seq: 4, screen: "" }, now);
  assert.equal(running.attention.state, "idle");
  assert.equal(running.seq, 4);
  assert.equal(publicAttention(running.attention).state, "idle");
  for (const status of ["exited", "unavailable", "recording-error"] as const)
    assert.equal(withDefaultAttention({ status, seq: 0, screen: "" }, now).attention.state, status);
  const present = { status: "running" as const, seq: 1, screen: "", attention: { ...running.attention, state: "working" as const } };
  assert.equal(withDefaultAttention(present, now), present);
});

test("a plain session says what it is doing; one unreadable status never hides the other sessions", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const live = randomUUID();
    const broken = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: live, provider: "demo", projectId: "rehearsal", title: "Live", prompt: "plain work" });
    await host.fetchApi("/sessions", "owner", { requestId: broken, provider: "demo", projectId: "rehearsal", title: "Broken", prompt: "" });
    // A session started with a request is working; its line names no tool yet.
    const thinking = await waitFor(() => host.fetchApi(`/sessions/${live}`), (r) => r.body.attention?.now === "Thinking", 3000);
    assert.equal(thinking.body.attention.state, "working");

    // Stop one session, wait for its worker to leave, then damage its saved status.
    await host.fetchApi(`/sessions/${broken}/stop`, "owner", { requestId: randomUUID() });
    await waitFor(async () => existsSync(join(host.config.runDir, `${broken}.sock`)), (exists) => !exists, 10000);
    writeFileSync(join(host.config.stateDir, "sessions", broken, "status.sealed"), "not a sealed status");
    const list = await host.fetchApi("/sessions");
    assert.equal(list.status, 200);
    const rows = Object.fromEntries(list.body.sessions.map((s: { id: string }) => [s.id, s]));
    assert.equal(rows[live].status, "running");
    assert.equal(rows[live].attention.now, "Thinking");
    assert.equal(rows[broken].status, "unavailable");
    assert.equal(rows[broken].attention.state, "unavailable");
  } finally {
    await host.stop();
  }
});
