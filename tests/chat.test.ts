import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claimControl, startHost, waitFor } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

/** The journal events of one type. The events route's `types` filter does not list every type, so this filters the page. */
async function journalEvents(host: Awaited<ReturnType<typeof startHost>>, id: string, type: string): Promise<any[]> {
  const page = await host.fetchApi(`/sessions/${id}/events?limit=200`);
  return page.body.events.filter((event: any) => event.type === type);
}

/** Waits for the one coverage record a session journals after its exit record and its final drain. */
async function coverageEvent(host: Awaited<ReturnType<typeof startHost>>, id: string): Promise<any> {
  const events = await waitFor(() => journalEvents(host, id, "usage-coverage"), (found) => found.length === 1, 15000);
  return events[0];
}

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

test("a rehearsal turn journals its usage, and its exit journals the coverage of the session", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Usage", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    assert.equal(answer.body.result, "closed");
    await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.some((m: any) => m.role === "assistant" && /Removed the build directory/.test(m.text)), 15000);
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
    const coverage = await coverageEvent(host, id);
    const usage = await journalEvents(host, id, "usage");
    assert.ok(usage.some((e: any) => e.data.provider === "claude" && e.data.modelId === "rehearsal-model" && e.data.tokens.input === 120 && e.data.tokens.output === 30));
    // The last hook is Stop, a turn end, and the final drain reached the end of the file. Nothing
    // else makes the session partial, so the coverage is complete.
    assert.equal(coverage.data.coverage, "complete");
    assert.equal(coverage.data.reason, undefined);
    assert.equal(coverage.data.provider, "demo");
    assert.equal(coverage.data.finalDrain, "complete");
    // The usage ledger folds the journal: the session reads as measured and complete, with the journal's token sums.
    const sum = (field: "input" | "output") => usage.reduce((total: number, event: any) => total + event.data.tokens[field], 0);
    const listed = await waitFor(() => host.fetchApi("/sessions"), (r) => {
      const row = r.body.sessions.find((session: any) => session.id === id);
      return row?.usage?.measured === true && row.usage.coverage === "complete";
    }, 20000);
    const ledger = listed.body.sessions.find((session: any) => session.id === id).usage;
    assert.equal(ledger.tokens.input, sum("input"));
    assert.equal(ledger.tokens.output, sum("output"));
    // A rehearsal record is a Claude record: it is recorded and not priced, so nothing is spent.
    assert.equal((await host.fetchApi("/usage")).body.month.spent.usd, 0);
  } finally {
    await host.stop();
  }
});

test("a rehearsal subagent's usage is journaled from its own transcript", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Subagent usage", prompt: "hook dialog subagent" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    assert.equal(answer.body.result, "closed");
    await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.some((m: any) => m.role === "assistant" && /Removed the build directory/.test(m.text)), 15000);
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
    const coverage = await coverageEvent(host, id);
    const usage = await journalEvents(host, id, "usage");
    // The subagent row lives in its own file. Its usage is journaled as secondary, and its text never reaches chat.
    assert.ok(usage.some((e: any) => e.data.secondary === true && e.data.modelId === "rehearsal-sub-model" && e.data.tokens.input === 200 && e.data.tokens.output === 50));
    assert.ok(usage.some((e: any) => e.data.secondary !== true && e.data.modelId === "rehearsal-model"));
    const messages = await host.fetchApi(`/sessions/${id}/messages`);
    assert.equal(messages.body.messages.some((m: any) => /Checked the build layout\./.test(m.text ?? "")), false, "subagent text never reaches chat");
    assert.equal(coverage.data.coverage, "complete");
    assert.equal(coverage.data.reason, undefined);
    assert.equal(coverage.data.finalDrain, "complete");
  } finally {
    await host.stop();
  }
});

test("a rehearsal without hooks journals no usage and coverage none for hooks-off", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Plain usage", prompt: "Initial request" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "running", 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
    assert.equal((await journalEvents(host, id, "usage")).length, 0);
    const coverage = await coverageEvent(host, id);
    assert.deepEqual([coverage.data.coverage, coverage.data.reason], ["none", "hooks-off"]);
    assert.equal("finalDrain" in coverage.data, false, "no transcript was open, so no drain was owed");
  } finally {
    await host.stop();
  }
});

test("a rehearsal stopped mid-turn journals the row written after its last hook", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Late row", prompt: "hook dialog late-row" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
    const coverage = await coverageEvent(host, id);
    const usage = await journalEvents(host, id, "usage");
    const late = usage.find((e: any) => String(e.data.messageId).endsWith("-late"));
    assert.ok(late, "the row written after the last hook reaches usage");
    assert.equal(late.data.tokens.input, 120);
    assert.equal(late.data.tokens.output, 30);
    assert.deepEqual([coverage.data.coverage, coverage.data.reason, coverage.data.finalDrain], ["partial", "stopped-mid-turn", "complete"]);
    // The exit record, then every usage record, then the coverage record.
    const events = (await host.fetchApi(`/sessions/${id}/events?limit=200`)).body.events;
    const exitedSeq = events.find((e: any) => e.type === "lifecycle" && e.data.status === "exited").seq;
    assert.ok(usage.every((e: any) => e.seq < coverage.seq), "every usage record precedes the coverage record");
    assert.ok(exitedSeq < coverage.seq, "the exit record precedes the coverage record");
    assert.ok(late.seq > exitedSeq, "the late row is read by the final drain, after the exit record");
    const messages = await host.fetchApi(`/sessions/${id}/messages`);
    assert.ok(messages.body.messages.some((m: any) => m.text === "Stopped before the reply was finished."));
  } finally {
    await host.stop();
  }
});

test("a drain post while the provider runs changes nothing", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Early drain", prompt: "hook dialog drain-early" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, id, "owner");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    assert.equal(answer.body.result, "closed");
    await waitFor(() => host.fetchApi(`/sessions/${id}/messages`), (r) => r.body.messages.some((m: any) => m.role === "assistant" && /Removed the build directory/.test(m.text)), 15000);
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
    const coverage = await coverageEvent(host, id);
    assert.deepEqual([coverage.data.coverage, coverage.data.reason, coverage.data.finalDrain], ["complete", undefined, "complete"]);
  } finally {
    await host.stop();
  }
});

test("a sudo profile drains through the wrapper beside it, and skips without one", { timeout: 120000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "inf-drain-"));
  try {
    const log = join(folder, "sudo.log");
    const tsx = import.meta.resolve("tsx");
    const wrapper = (name: string, body: string) => {
      const path = join(folder, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      chmodSync(path, 0o700);
    };
    // A stand-in for sudo: it logs its arguments, drops them through `--`, and runs the rest.
    wrapper("sudo", `echo "$*" >> '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`);
    wrapper("demo", `exec '${process.execPath}' --import '${tsx}' '${resolve("packages/host/src/demo.ts")}' "$@"`);
    wrapper("transcript-drain", `exec '${process.execPath}' --import '${tsx}' '${resolve("packages/host/src/hook-relay.ts")}' drain`);
    const profile = { command: join(folder, "sudo"), args: ["-n", "-u", "test-agent", "--", join(folder, "demo")] };
    const host = await startHost({ config: { attention }, agents: { demo: profile } });
    try {
      const first = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: first, provider: "demo", projectId: "rehearsal", title: "Drain", prompt: "hook dialog late-row" });
      await waitFor(() => host.fetchApi(`/sessions/${first}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
      const firstControl = await claimControl(host, first, "owner");
      await host.fetchApi(`/sessions/${first}/stop`, "owner", { requestId: randomUUID() }, firstControl.headers);
      await waitFor(() => host.fetchApi(`/sessions/${first}`), (r) => r.body.status === "exited", 15000);
      const firstCoverage = await coverageEvent(host, first);
      assert.ok((await journalEvents(host, first, "usage")).some((e: any) => String(e.data.messageId).endsWith("-late")));
      assert.deepEqual([firstCoverage.data.coverage, firstCoverage.data.reason, firstCoverage.data.finalDrain], ["partial", "stopped-mid-turn", "complete"]);
      const drainLine = `-n -u test-agent -- ${join(folder, "transcript-drain")}`;
      const drainLines = () => readFileSync(log, "utf8").split("\n").filter(line => line.includes("transcript-drain")).length;
      assert.ok(readFileSync(log, "utf8").split("\n").includes(drainLine));

      // Without the wrapper the drain cannot run: the late row stays unread and the coverage says so.
      rmSync(join(folder, "transcript-drain"), { force: true });
      const before = drainLines();
      const second = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: second, provider: "demo", projectId: "rehearsal", title: "No drain", prompt: "hook dialog late-row" });
      await waitFor(() => host.fetchApi(`/sessions/${second}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
      const secondControl = await claimControl(host, second, "owner");
      await host.fetchApi(`/sessions/${second}/stop`, "owner", { requestId: randomUUID() }, secondControl.headers);
      await waitFor(() => host.fetchApi(`/sessions/${second}`), (r) => r.body.status === "exited", 15000);
      const secondCoverage = await coverageEvent(host, second);
      assert.equal((await journalEvents(host, second, "usage")).some((e: any) => String(e.data.messageId).endsWith("-late")), false);
      assert.deepEqual([secondCoverage.data.coverage, secondCoverage.data.reason, secondCoverage.data.finalDrain], ["partial", "drain-skipped", "skipped"]);
      assert.equal(drainLines(), before, "no drain line is logged without the wrapper");
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Writes the stand-ins a sudo profile needs. The sudo stand-in logs its arguments and runs what follows `--`; with
 * `refuseDrain` it exits 1 for the drain wrapper, as sudo does when its policy does not list the command.
 */
function sudoStandIns(folder: string, drainBody: string, refuseDrain: boolean) {
  const tsx = import.meta.resolve("tsx");
  const script = (name: string, body: string) => {
    const path = join(folder, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    chmodSync(path, 0o700);
  };
  const refusal = refuseDrain ? `case "$*" in *transcript-drain*) exit 1 ;; esac\n` : "";
  script("sudo", `echo "$*" >> '${join(folder, "sudo.log")}'\n${refusal}while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`);
  script("demo", `exec '${process.execPath}' --import '${tsx}' '${resolve("packages/host/src/demo.ts")}' "$@"`);
  script("transcript-drain", drainBody);
  return { command: join(folder, "sudo"), args: ["-n", "-u", "test-agent", "--", join(folder, "demo")] };
}

test("a drain that hangs is stopped at its limit and the session still closes", { timeout: 60000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "inf-drain-"));
  try {
    const pidFile = join(folder, "drain.pid");
    // The stand-ins exec, so the sleeping drain's parent is the worker that started it.
    const profile = sudoStandIns(folder, `echo "$$ $PPID" > '${pidFile}'\nexec sleep 60`, false);
    const host = await startHost({ config: { attention }, agents: { demo: profile } });
    try {
      const id = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Hang", prompt: "hook dialog late-row" });
      await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
      const control = await claimControl(host, id, "owner");
      await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
      await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.status === "exited", 15000);
      const coverage = await coverageEvent(host, id);
      assert.deepEqual([coverage.data.coverage, coverage.data.reason, coverage.data.finalDrain], ["partial", "drain-skipped", "skipped"]);
      assert.equal((await journalEvents(host, id, "usage")).some((e: any) => String(e.data.messageId).endsWith("-late")), false, "the hung drain read no late row");
      const events = (await host.fetchApi(`/sessions/${id}/events?limit=200`)).body.events;
      const exited = events.find((e: any) => e.type === "lifecycle" && e.data.status === "exited");
      assert.ok(coverage.seq > exited.seq, "the coverage record follows the exit record");
      const waited = Date.parse(coverage.at) - Date.parse(exited.at);
      assert.ok(waited >= 9000 && waited < 14000, `the drain ran to its 10 second limit, not ${waited} ms`);
      const [pid, workerPid] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
      assert.equal(Number.isSafeInteger(workerPid) && workerPid > 1, true, "the drain recorded the worker that started it");
      const gone = (target: number, limit: number) => waitFor(async () => { try { process.kill(target, 0); return true; } catch { return false; } }, (running) => !running, limit);
      assert.equal(await gone(pid, 2000), false, "the sleeping drain process is gone");
      // The worker process itself ends within its exit timer once the coverage record is written.
      assert.equal(await gone(workerPid, 5000), false, "the worker process ended after the drain window");
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a sudo policy that refuses the wrapper skips the drain at once", { timeout: 120000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "inf-drain-"));
  try {
    const profile = sudoStandIns(folder, "exit 0", true);
    const host = await startHost({ config: { attention }, agents: { demo: profile } });
    try {
      // Stopped mid-turn: the refused drain leaves the late row unread, and the coverage record says so without waiting.
      const midTurn = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: midTurn, provider: "demo", projectId: "rehearsal", title: "Refused", prompt: "hook dialog late-row" });
      await waitFor(() => host.fetchApi(`/sessions/${midTurn}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
      const midControl = await claimControl(host, midTurn, "owner");
      await host.fetchApi(`/sessions/${midTurn}/stop`, "owner", { requestId: randomUUID() }, midControl.headers);
      await waitFor(() => host.fetchApi(`/sessions/${midTurn}`), (r) => r.body.status === "exited", 15000);
      const midCoverage = await coverageEvent(host, midTurn);
      assert.deepEqual([midCoverage.data.coverage, midCoverage.data.reason, midCoverage.data.finalDrain], ["partial", "drain-skipped", "skipped"]);
      assert.equal((await journalEvents(host, midTurn, "usage")).some((e: any) => String(e.data.messageId).endsWith("-late")), false);
      const events = (await host.fetchApi(`/sessions/${midTurn}/events?limit=200`)).body.events;
      const exited = events.find((e: any) => e.type === "lifecycle" && e.data.status === "exited");
      const waited = Date.parse(midCoverage.at) - Date.parse(exited.at);
      assert.ok(waited >= 0 && waited < 3000, `a refused drain does not wait for the limit (${waited} ms)`);

      // A clean turn boundary under the same refusal: nothing was owed beyond the last hook, so the session stays complete.
      const clean = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: clean, provider: "demo", projectId: "rehearsal", title: "Clean", prompt: "hook dialog" });
      const detail = await waitFor(() => host.fetchApi(`/sessions/${clean}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
      const control = await claimControl(host, clean, "owner");
      const answer = await host.fetchApi(`/sessions/${clean}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
      assert.equal(answer.body.result, "closed");
      await waitFor(() => host.fetchApi(`/sessions/${clean}/messages`), (r) => r.body.messages.some((m: any) => m.role === "assistant" && /Removed the build directory/.test(m.text)), 15000);
      await host.fetchApi(`/sessions/${clean}/stop`, "owner", { requestId: randomUUID() }, control.headers);
      await waitFor(() => host.fetchApi(`/sessions/${clean}`), (r) => r.body.status === "exited", 15000);
      const cleanCoverage = await coverageEvent(host, clean);
      assert.deepEqual([cleanCoverage.data.coverage, cleanCoverage.data.reason, cleanCoverage.data.finalDrain], ["complete", undefined, "skipped"]);
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
