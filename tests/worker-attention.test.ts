import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialAttention } from "@infinite/attention";
import { publicAttention, withDefaultAttention } from "../packages/host/src/manager.js";
import { socketPath } from "../packages/host/src/ipc.js";
import type { QueueDecision } from "../packages/host/src/decision-queue.js";
import { claimControl, startHost, waitFor, type Host } from "./helpers.js";
import { fixture } from "./team-fixture.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };
const hookAgentScript = fileURLToPath(new URL("./fixtures/hook-agent.mjs", import.meta.url));

async function stepGate() {
  const released = new Set<string>();
  const arrived = new Set<string>();
  const responses = new Map<string, ServerResponse[]>();
  const waiters = new Map<string, Set<{ resolve: () => void; reject: (error: Error) => void }>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer((req, res) => {
    const key = (req.url ?? "/").replace(/^\/+/, "");
    arrived.add(key);
    for (const waiter of waiters.get(key) ?? []) waiter.resolve();
    waiters.delete(key);
    if (released.has(key) || closed) {
      res.setHeader("connection", "close");
      res.end(closed ? "closed" : "ok");
      return;
    }
    const pending = responses.get(key) ?? [];
    pending.push(res);
    responses.set(key, pending);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as { port: number };
  const release = (key: string) => {
    released.add(key);
    for (const res of responses.get(key) ?? []) {
      res.setHeader("connection", "close");
      res.end("ok");
    }
    responses.delete(key);
  };
  const reached = async (key: string, abortWith?: Promise<unknown>, timeoutMs = 20000) => {
    if (arrived.has(key)) return;
    if (closed) throw new Error(`Fixture gate closed before arrival: ${key}`);
    let cleanup = () => {};
    const arrivedPromise = new Promise<void>((resolveWait, rejectWait) => {
      const entry = {
        resolve: () => {
          cleanup();
          resolveWait();
        },
        reject: (error: Error) => {
          cleanup();
          rejectWait(error);
        },
      };
      const set = waiters.get(key) ?? new Set();
      set.add(entry);
      waiters.set(key, set);
      const timer = setTimeout(() => {
        entry.reject(new Error(`Timed out waiting for fixture gate: ${key}`));
      }, timeoutMs);
      cleanup = () => {
        clearTimeout(timer);
        set.delete(entry);
        if (set.size === 0) waiters.delete(key);
      };
    });
    try {
      if (!abortWith) {
        await arrivedPromise;
        return;
      }
      await Promise.race([
        arrivedPromise,
        abortWith.then(
          (value) => { throw new Error(`Gate ${key} was not reached before operation settled: ${JSON.stringify(value)}`); },
          (error) => { throw error; },
        ),
      ]);
    } finally {
      cleanup();
    }
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    for (const set of [...waiters.values()]) {
      for (const waiter of [...set]) waiter.reject(new Error("Fixture gate closed"));
    }
    waiters.clear();
    for (const list of responses.values()) {
      for (const res of list) {
        res.setHeader("connection", "close");
        res.end("closed");
      }
    }
    responses.clear();
    server.closeAllConnections();
    closing = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    return closing;
  };
  return { url: `http://127.0.0.1:${port}`, release, reached, close };
}

test("decision queue returns a session prompt and team decision with answerable paths", { timeout: 90000 }, async () => {
  const f = await fixture("question", undefined, {
    attention,
    agents: { claude: { command: process.execPath, args: [resolve("tests/fixtures/hook-agent.mjs")] } },
  });
  try {
    const teamCreated = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(teamCreated.status), JSON.stringify(teamCreated.body));
    const team = await waitFor(() => f.get(teamCreated.body.id), run => run.decisions.length === 1 && run.status === "needs-input", 30000);

    const sessionId = randomUUID();
    const sessionCreated = await f.host.fetchApi("/sessions", "owner", {
      requestId: sessionId, provider: "claude", projectId: "rehearsal", title: "Queue prompt", prompt: "merge",
    });
    assert.equal(sessionCreated.status, 201, JSON.stringify(sessionCreated.body));
    const session = await waitFor(() => f.host.fetchApi(`/sessions/${sessionId}`), response => response.body.attention?.state === "needs-you" && response.body.attention.prompt?.hash, 20000);

    const response = await f.host.fetchApi("/decision-queue");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const decisions = response.body.decisions as QueueDecision[];
    const sessionItem = decisions.find((item): item is Extract<QueueDecision, { kind: "session" }> => item.kind === "session");
    const teamItem = decisions.find((item): item is Extract<QueueDecision, { kind: "team" }> => item.kind === "team");
    assert.ok(sessionItem);
    assert.ok(teamItem);
    assert.equal(sessionItem.origin.id, sessionId);
    assert.equal(sessionItem.answerPath, `/api/sessions/${sessionId}/answer`);
    assert.equal(teamItem.origin.id, team.id);
    assert.equal(teamItem.answerPath, `/api/teams/${team.id}/decisions/${teamItem.decision.id}/answer`);

    const route = (path: string) => path.replace(/^\/api/, "");
    const sessionAnswer = await f.host.fetchApi(route(sessionItem.answerPath), "owner", {
      requestId: randomUUID(), promptId: sessionItem.prompt.id, option: 0,
    });
    assert.equal(sessionAnswer.status, 200, JSON.stringify(sessionAnswer.body));
    const teamAnswer = await f.host.fetchApi(route(teamItem.answerPath), "owner", {
      requestId: randomUUID(), revision: teamItem.revision, text: "Compact",
    });
    assert.equal(teamAnswer.status, 200, JSON.stringify(teamAnswer.body));
  } finally { await f.close(); }
});

type SignalRow = { seq: number; data: { kind: string; promptId?: number; source: string; type?: string; title?: string; detail?: string } };
const signalsOf = async (host: Host, id: string) =>
  (await host.fetchApi(`/sessions/${id}/events?types=signal`)).body.events as SignalRow[];
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
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 20000);
    const prompt = detail.body.attention.prompt;
    assert.equal(prompt.kind, "permission");
    assert.equal(prompt.source, "hook");
    assert.equal(prompt.options.length, 3);
    assert.equal(prompt.tool.name, "Bash");
    assert.deepEqual(prompt.destructive, { pattern: "rm-recursive-force" });
    assert.match(prompt.detail, /rm -rf build/);
    assert.equal(detail.body.attention.hooks, "active");
    assert.match(detail.body.attention.now, /rm -rf build/);

    const list = await host.fetchApi("/sessions");
    const row = list.body.sessions.find((s: { id: string }) => s.id === id);
    assert.equal(row.attention.state, "needs-you");
    assert.deepEqual(row.attention.prompt.tool.input, {});

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
    assert.equal("digest" in answer.body, false);
    const again = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId, promptId: prompt.id, option: 1 });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, answer.body);

    const finished = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention.state === "turn-finished", 20000);
    assert.match(finished.body.attention.lastMessage, /Removed the build directory/);

    const events = await host.fetchApi(`/sessions/${id}/events?types=signal`);
    const kinds = events.body.events.map((e: { data: { kind: string } }) => e.data.kind);
    for (const k of ["hooks-ready", "turn-start", "tool-start", "prompt-open", "answer", "prompt-closed", "tool-end", "turn-end"]) assert.ok(kinds.includes(k), k);
    const answered = events.body.events.find((e: { data: { kind: string } }) => e.data.kind === "answer").data;
    assert.equal(answered.option.label, "Yes, and don't ask again for rm commands");
    assert.equal(answered.result, "closed");
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
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you", 20000);
    assert.equal(detail.body.attention.prompt.kind, "yes-no");
    assert.equal(detail.body.attention.prompt.source, "screen");
    assert.equal(detail.body.attention.hooks, "none");
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
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 20000);
    const prompt = detail.body.attention.prompt;
    assert.equal(prompt.source, "screen");
    assert.equal(prompt.acceptsText, true);

    const outOfRange = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, option: 3 });
    assert.equal(outOfRange.status, 409);
    assert.equal(outOfRange.body.error, "invalid-option");
    assert.equal(outOfRange.body.attention.prompt.id, prompt.id);
    const textWithYes = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, option: 0, text: "Use a dry run first" });
    assert.equal(textWithYes.status, 409);
    assert.equal(textWithYes.body.error, "text-not-accepted");

    const feedback = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: prompt.id, text: "Keep the build directory" });
    assert.equal(feedback.status, 200);
    assert.equal(feedback.body.result, "closed");
    const after = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("You: Keep the build directory"), 15000);
    assert.match(after.body.screen, /Selected: No, and tell Claude what to do differently/);

    const intents = (await host.fetchApi(`/sessions/${id}/events?types=input-intent`)).body.events;
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0].data.keys, ["down", "down", "enter"]);
    assert.equal(intents[0].data.text, "Keep the build directory");
  } finally {
    await host.stop();
  }
});

test("hook prompts merge only into their own dialog, and never while it is being answered", { timeout: 60000 }, async (t) => {
  const gate = await stepGate();
  t.after(() => gate.close());
  const agent = { command: process.execPath, args: [hookAgentScript, "--gate", gate.url] };
  const host = await startHost({ agents: { demo: agent }, config: { attention } });
  try {
    const modes = ["mismatch", "hook-first", "two-hooks", "answer-race", "merge", "denied"];
    const ids: Record<string, string> = Object.fromEntries(modes.map((m) => [m, randomUUID()]));
    await Promise.all(modes.map((m) => host.fetchApi("/sessions", "owner", { requestId: ids[m], provider: "demo", projectId: "rehearsal", title: m, prompt: m })));
    const signals = async (mode: string) =>
      ((await host.fetchApi(`/sessions/${ids[mode]}/events?types=signal`)).body.events as { data: { kind: string; type?: string; reason?: string; message?: string; source: string } }[])
        .map(({ data: d }) => `${d.kind}${d.type ? `/${d.type}` : ""}${d.reason ? `/${d.reason}` : ""}${d.message ? `[${d.message}]` : ""}(${d.source})`);
    const attentionOf = async (mode: string) => (await host.fetchApi(`/sessions/${ids[mode]}`)).body.attention;

    await waitFor(() => attentionOf("mismatch"), (a) => a.state === "needs-you" && a.prompt?.source === "screen" && Boolean(a.prompt?.hash), 20000);
    gate.release("mismatch-screen");
    await waitFor(() => signals("mismatch"), (s) => s.includes("notice/prompt-mismatch[git push --force origin main](hook)"), 20000);
    const kept = (await attentionOf("mismatch")).prompt;
    assert.equal(kept.source, "screen");
    assert.equal(kept.tool, undefined);
    assert.deepEqual(kept.destructive, { pattern: "rm-recursive-force" });

    const replaced = await waitFor(() => attentionOf("hook-first"), (a) => a.prompt?.hash, 20000);
    assert.equal(replaced.prompt.source, "screen");
    assert.match(replaced.prompt.detail, /rm -rf build/);
    assert.doesNotMatch(replaced.prompt.detail, /git push/);
    assert.ok((await signals("hook-first")).includes("prompt-closed/superseded(screen)"));

    const second = await waitFor(() => attentionOf("two-hooks"), (a) => a.prompt?.detail === "git push --force origin main", 20000);
    assert.equal(second.prompt.source, "hook");
    const twoHooks = await signals("two-hooks");
    assert.deepEqual(twoHooks.filter((s) => s.startsWith("prompt-")), ["prompt-open(hook)", "prompt-closed/superseded(hook)", "prompt-open(hook)"]);

    const open = await waitFor(() => attentionOf("answer-race"), (a) => a.state === "needs-you" && a.prompt?.hash, 20000);
    const answer = await host.fetchApi(`/sessions/${ids["answer-race"]}/answer`, "controller", { requestId: randomUUID(), promptId: open.prompt.id, option: 1 });
    assert.equal(answer.body.result, "closed");
    const race = await signals("answer-race");
    assert.ok(race.includes("notice/prompt-mismatch[rm -rf build](hook)"), race.join(" "));
    assert.ok(!race.some((s) => s.includes("superseded")), race.join(" "));
    assert.ok(race.includes("prompt-closed/answered-here(host)"), race.join(" "));

    const merged = await waitFor(() => attentionOf("merge"), (a) => a.prompt?.hash, 20000);
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

    const denied = await waitFor(() => signals("denied"), (s) => s.includes("notice/permission_denied[Denied by policy](hook)"), 20000);
    assert.deepEqual(denied.filter((s) => s.startsWith("prompt-")), ["prompt-open(hook)", "prompt-closed/resolved(hook)"]);
    const afterDenied = await attentionOf("denied");
    assert.equal(afterDenied.state, "working");
    assert.equal(afterDenied.prompt, undefined);
  } finally {
    await gate.close();
    await host.stop();
  }
});

test("composer text over an open dialog is refused unless a terminal surface forces it", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Guard", prompt: "dialog hook" });
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 20000);
    const promptId = open.body.attention.prompt.id;

    for (const submit of [true, false]) {
      const refused = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "prompt-open");
      assert.equal(refused.body.attention.prompt.id, promptId);
    }
    assert.equal((await host.fetchApi(`/sessions/${id}/events?types=input-intent,input-result`)).body.events.length, 0);
    const still = (await host.fetchApi(`/sessions/${id}`)).body;
    assert.equal(still.attention.state, "needs-you");
    assert.equal(still.attention.prompt.id, promptId);
    assert.match(still.screen, /❯ 1\. Yes/);
    assert.doesNotMatch(still.screen, /Selected:/);

    const forced = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit: true, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.state, "delivered");
    assert.deepEqual(Object.keys(forced.body).sort(), ["requestId", "seq", "state"]);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("Selected: Yes"), 15000);
    const intents = (await host.fetchApi(`/sessions/${id}/events?types=input-intent`)).body.events;
    assert.equal(intents.length, 1);
    assert.equal(intents[0].data.force, true);
  } finally {
    await host.stop();
  }
});

test("input control gates answers and text before the dialog guards, and refusals journal nothing", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Leased", prompt: "dialog hook" });
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 20000);
    const promptId = open.body.attention.prompt.id;
    const inputEvents = async () => (await host.fetchApi(`/sessions/${id}/events?types=input-intent,input-result`)).body.events as { seq: number; type: string; data: Record<string, unknown> }[];

    const laptop = await claimControl(host, id, "owner");
    const busy = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId, option: 1 }, { "X-Infinite-Client": randomUUID() });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "control-busy");
    assert.equal(typeof busy.body.error, "string");
    assert.equal((await inputEvents()).length, 0);
    assert.equal((await signalsOf(host, id)).filter((e) => e.data.kind === "answer").length, 0);
    const unleased = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit: true }, { "X-Infinite-Client": randomUUID() });
    assert.equal(unleased.status, 409);
    assert.equal(unleased.body.code, "control-busy");
    assert.notEqual(unleased.body.error, "prompt-open");
    assert.equal((await inputEvents()).length, 0);

    const phone = await claimControl(host, id, "controller", { takeover: true });
    assert.notEqual(phone.lease.id, laptop.lease.id);
    const lost = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId, option: 1 }, laptop.headers);
    assert.equal(lost.status, 409);
    assert.equal(lost.body.code, "control-lost");
    assert.equal((await inputEvents()).length, 0);

    const guarded = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "no, stop", submit: true }, phone.headers);
    assert.equal(guarded.status, 409);
    assert.equal(guarded.body.error, "prompt-open");
    assert.equal(guarded.body.attention.prompt.id, promptId);
    assert.equal((await inputEvents()).length, 0);

    const requestId = randomUUID();
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId, promptId, option: 1 }, phone.headers);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.state, "delivered");
    assert.equal(answer.body.result, "closed");
    const events = await inputEvents();
    const intent = events.find((e) => e.type === "input-intent");
    const result = events.find((e) => e.type === "input-result");
    assert.equal(events.length, 2);
    assert.equal(intent?.data.op, "answer");
    assert.equal(intent?.data.requestId, requestId);
    assert.equal(result?.data.requestId, requestId);
    assert.equal(result?.data.result, "closed");
    const answered = (await signalsOf(host, id)).filter((e) => e.data.kind === "answer");
    assert.equal(answered.length, 1);
    assert.ok(intent!.seq < answered[0].seq && answered[0].seq < result!.seq);
    assertClosedOnce(await signalsOf(host, id));
  } finally {
    await host.stop();
  }
});

test("an answer accepted just before its lease expires does not revive the lease", { timeout: 60000 }, async (t) => {
  const gate = await stepGate();
  t.after(() => gate.close());
  const host = await startHost({ agents: { demo: { command: process.execPath, args: [hookAgentScript, "--gate", gate.url] } }, config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Expiring", prompt: "expiring-lease" });
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 20000);
    const phone = await claimControl(host, id, "controller");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, phone.lease.expiresAt - Date.now() - 750)));
    const pending = host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId: randomUUID(), promptId: open.body.attention.prompt.id, option: 0 }, phone.headers);
    await gate.reached("close-dialog", pending);
    const remaining = phone.lease.expiresAt - Date.now();
    if (remaining >= 0) await new Promise((resolve) => setTimeout(resolve, remaining + 50));
    gate.release("close-dialog");
    const answer = await pending;
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.result, "closed");
    assert.ok(Date.now() > phone.lease.expiresAt, "the answer finished after the lease deadline");
    assert.equal((await host.fetchApi(`/sessions/${id}`)).body.control, null);
    const stale = await host.fetchApi(`/sessions/${id}/input`, "controller", { requestId: randomUUID(), text: "after expiry", submit: true }, phone.headers);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "control-lost");
  } finally {
    await gate.close();
    await host.stop();
  }
});

test("a dialog drawn before its hooks opens one prompt; rejecting it clears the running tool", { timeout: 60000 }, async (t) => {
  const gate = await stepGate();
  t.after(() => gate.close());
  const host = await startHost({ agents: { demo: { command: process.execPath, args: [hookAgentScript, "--gate", gate.url] } }, config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Screen first", prompt: "dialog-first" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.source === "screen" && Boolean(r.body.attention.prompt?.hash), 20000);
    gate.release("dialog-first-screen");
    const open = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool && r.body.attention.lastTool, 20000);
    const prompt = open.body.attention.prompt;
    assert.equal(prompt.title, "Do you want to proceed?");
    assert.equal(open.body.attention.lastTool.summary, "rm -rf build");
    const before = await signalsOf(host, id);
    const opens = before.filter((e) => e.data.kind === "prompt-open");
    assert.equal(opens.length, 1, JSON.stringify(before.map((e) => e.data)));
    assert.equal(opens[0].data.source, "screen");
    assert.equal(prompt.id, opens[0].seq);
    for (const kind of ["turn-start", "tool-start"]) {
      const at = before.find((e) => e.data.kind === kind);
      assert.ok(at && at.seq > opens[0].seq, `${kind} arrives after the screen's prompt-open`);
    }

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
    await gate.close();
    await host.stop();
  }
});

test("a worker without attention reports a default instead of breaking the list", () => {
  const now = "2026-10-05T00:00:00.000Z";
  const running = withDefaultAttention({ status: "running", seq: 4, screen: "" }, now);
  assert.equal(running.attention.state, "unavailable");
  assert.equal(running.attention.now, "");
  assert.equal(running.seq, 4);
  assert.equal(publicAttention(running.attention).state, "unavailable");
  assert.equal(withDefaultAttention({ status: "starting", seq: 0, screen: "" }, now).attention.state, "unavailable");
  for (const status of ["exited", "unavailable", "recording-error"] as const)
    assert.equal(withDefaultAttention({ status, seq: 0, screen: "" }, now).attention.state, status);
  const present = { status: "running" as const, seq: 1, screen: "", attention: { ...running.attention, state: "working" as const } };
  assert.equal(withDefaultAttention(present, now), present);
});

test("public attention marks only complete Codex command dialogs as delegable", () => {
  const prompt = {
    id: 1,
    kind: "permission" as const,
    title: "Would you like to run the following command?",
    detail: "• Running npm run check\nEnvironment: local\nReason: May I run the requested full npm run check outside the sandbox? Its tsx test runner needs a local IPC socket\nthat the sandbox blocks.\n$ npm run check",
    options: [
      { index: 0, label: "Yes, proceed (y)", role: "accept" as const },
      { index: 1, label: "Yes, and don't ask again for commands that start with … (p)", role: "accept-always" as const },
      { index: 2, label: "No, and tell Codex what to do differently (esc)", role: "reject-with-feedback" as const },
    ],
    acceptsText: false,
    pinned: true,
    source: "screen" as const,
    hash: "command-dialog-hash",
  };
  const attention = initialAttention("2026-10-19T00:00:00.000Z", false);
  const delegated = publicAttention({ ...attention, state: "needs-you", source: "screen", prompt });
  assert.equal(delegated.prompt?.delegable, true);

  const nonDelegable = publicAttention({ ...attention, state: "needs-you", source: "screen", prompt: { ...prompt, hash: undefined } });
  assert.equal(nonDelegable.prompt?.delegable, undefined);
  assert.equal(publicAttention({ ...attention, state: "needs-you", source: "screen", prompt: { ...prompt, pinned: false } }).prompt?.delegable, undefined);
});

test("a plain session says what it is doing; one unreadable status never hides the other sessions", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const live = randomUUID();
    const broken = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: live, provider: "demo", projectId: "rehearsal", title: "Live", prompt: "plain work" });
    await host.fetchApi("/sessions", "owner", { requestId: broken, provider: "demo", projectId: "rehearsal", title: "Broken", prompt: "" });
    const thinking = await waitFor(() => host.fetchApi(`/sessions/${live}`), (r) => r.body.attention?.now === "Thinking", 15000);
    assert.equal(thinking.body.attention.state, "working");

    await host.fetchApi(`/sessions/${broken}/stop`, "owner", { requestId: randomUUID() });
    await waitFor(async () => existsSync(socketPath(host.config, broken)), (exists) => !exists, 15000);
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

type LimitRow = { seq: number; at: string; data: { kind: string; confidence?: string; source: string; resetsAt?: string } };
const limitsOf = async (host: Host, id: string) => (await signalsOf(host, id)).filter((e) => e.data.kind === "provider-limit") as unknown as LimitRow[];
const limitHost = (script: string, provider: "claude" | "codex", extraArgs: string[] = []) =>
  startHost({ agents: { [provider]: { command: process.execPath, args: [fileURLToPath(new URL(`./fixtures/${script}`, import.meta.url)), ...extraArgs] } }, config: { attention: { ...attention, limitConfirmMs: 2000 } } });
const startLimitSession = (host: Host, provider: string, prompt: string) => {
  const id = randomUUID();
  return host.fetchApi("/sessions", "owner", { requestId: id, provider, projectId: "rehearsal", title: prompt, prompt }).then((r) => {
    assert.equal(r.status, 201);
    return id;
  });
};
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Claude rate-limit evidence is source-order independent and successful turns do not reopen the episode", { timeout: 90000 }, async (t) => {
  const gate = await stepGate();
  t.after(() => gate.close());
  const host = await limitHost("hook-agent.mjs", "claude", ["--gate", gate.url]);
  try {
    const hookFirstId = await startLimitSession(host, "claude", "rate-limit");
    const hookFirstRows = await waitFor(() => limitsOf(host, hookFirstId), (r) => r.some((e) => e.data.confidence === "corroborated"), 20000);
    assert.equal(hookFirstRows[0].data.confidence, "single-source");
    assert.equal(hookFirstRows[0].data.source, "hook");
    assert.equal(hookFirstRows[1].data.confidence, "corroborated");
    assert.equal(hookFirstRows[1].data.source, "screen");
    assert.equal(hookFirstRows.length, 2);
    const hookFirstDetail = await host.fetchApi(`/sessions/${hookFirstId}`);
    assert.equal(hookFirstDetail.body.attention.limit.confidence, "corroborated");

    const hookOnlyId = await startLimitSession(host, "claude", "rate-limit-blip");
    await waitFor(() => limitsOf(host, hookOnlyId), (r) => r.length >= 1, 20000);
    await sleepMs(3500);
    const hookOnlyRows = await limitsOf(host, hookOnlyId);
    assert.equal(hookOnlyRows.length, 1);
    assert.equal(hookOnlyRows[0].data.confidence, "single-source");

    const screenFirstId = await startLimitSession(host, "claude", "rate-limit-notice-first");
    await waitFor(() => limitsOf(host, screenFirstId), (r) => r.length >= 1, 20000);
    gate.release("notice-first-screen");
    const screenFirstRows = await waitFor(() => limitsOf(host, screenFirstId), (r) => r.some((e) => e.data.confidence === "corroborated"), 20000);
    await gate.reached("notice-first-done");
    gate.release("notice-first-done");
    await sleepMs(1500);
    const screenFirstAfter = await limitsOf(host, screenFirstId);
    assert.deepEqual(screenFirstAfter.map((e) => [e.data.confidence, e.data.source]), [["single-source", "screen"], ["corroborated", "hook"]]);
    assert.equal(screenFirstRows.length, 2);
    assert.equal(screenFirstAfter[1].data.resetsAt?.slice(11, 16), "15:45", "The corroborating hook keeps the reset time the notice stated");
    assert.equal((await host.fetchApi(`/sessions/${screenFirstId}`)).body.attention.limit.resetsAt?.slice(11, 16), "15:45");

    const successfulTurnId = await startLimitSession(host, "claude", "rate-limit-then-stop");
    await waitFor(() => limitsOf(host, successfulTurnId), (r) => r.some((e) => e.data.confidence === "corroborated"), 20000);
    gate.release("then-stop-corroborated");
    await waitFor(() => host.fetchApi(`/sessions/${successfulTurnId}`), (r) => r.body.attention.state === "turn-finished" && r.body.attention.limit === undefined, 20000);
    await sleepMs(3500);
    const successfulTurnRows = await limitsOf(host, successfulTurnId);
    assert.deepEqual(successfulTurnRows.map((e) => e.data.confidence), ["single-source", "corroborated"]);
    assert.equal((await host.fetchApi(`/sessions/${successfulTurnId}`)).body.attention.limit, undefined);
  } finally {
    await gate.close();
    await host.stop();
  }
});

test("a Codex status row is corroborated only after it persists, once per episode", { timeout: 90000 }, async (t) => {
  const gate = await stepGate();
  t.after(() => gate.close());
  const host = await limitHost("codex-limit-agent.mjs", "codex", ["--gate", gate.url]);
  try {
    const id = await startLimitSession(host, "codex", "limit");
    const outputText = async () =>
      ((await host.fetchApi(`/sessions/${id}/events?types=output`)).body.events as { data: { text?: string } }[])
        .map((e) => String(e.data.text ?? ""))
        .join("");
    const rows = await waitFor(() => limitsOf(host, id), (r) => r.length >= 2, 20000);
    assert.deepEqual(rows.map((e) => [e.data.confidence, e.data.source]), [["single-source", "screen"], ["corroborated", "screen"]]);
    assert.ok(Date.parse(rows[1].at) - Date.parse(rows[0].at) >= 1900, `${rows[0].at} -> ${rows[1].at}`);
    gate.release("progress");
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("Unrelated progress line."), 15000);
    await sleepMs(2500);
    assert.equal((await limitsOf(host, id)).length, 2);
    gate.release("osc");
    await waitFor(() => signalsOf(host, id), (r) => r.some((e) => e.data.kind === "turn-end" && e.data.source === "osc"), 15000);
    await sleepMs(2000);
    assert.equal((await limitsOf(host, id)).length, 2, "No new single-source follows the OSC turn end");
    assert.equal((await host.fetchApi(`/sessions/${id}`)).body.attention.limit?.confidence, "corroborated");
    gate.release("clear");
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.screen.includes("clear-0") && !r.body.screen.includes("usage limited"), 15000);
    for (const marker of ["clear-1", "clear-2", "clear-3"]) {
      gate.release(marker);
      await waitFor(outputText, (text) => text.includes(marker), 15000);
      await host.fetchApi(`/sessions/${id}`);
    }
    gate.release("reopen");
    const all = await waitFor(() => limitsOf(host, id), (r) => r.length >= 4, 25000);
    assert.deepEqual(all.slice(2).map((e) => e.data.confidence), ["single-source", "corroborated"]);
    assert.ok(Date.parse(all[3].at) - Date.parse(all[2].at) >= 1900);
    await sleepMs(2500);
    assert.equal((await limitsOf(host, id)).length, 4);
  } finally {
    await gate.close();
    await host.stop();
  }
});
