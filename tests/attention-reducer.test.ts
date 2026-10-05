import test from "node:test";
import assert from "node:assert/strict";
import {
  initialAttention, applySignal, applyLifecycle, screenDecision, describeNow, mergeScreenIntoPrompt, mergeHookIntoPrompt, correlates, dropsPrompt,
} from "../packages/attention/src/attention.js";
import type { Prompt } from "../packages/attention/src/types.js";
import type { SignalEvent, SignalData } from "../packages/attention/src/types.js";
import { detectPrompt } from "../packages/attention/src/prompts.js";

let seq = 0;
const ev = (data: Omit<SignalData, "provider" | "source"> & Partial<SignalData>): SignalEvent => ({
  seq: ++seq, at: "2026-10-04T12:00:00.000Z", type: "signal",
  data: { source: "hook", provider: "claude", ...data } as SignalData,
});

test("starts working with a prompt, idle without", () => {
  assert.equal(initialAttention("t", true).state, "working");
  assert.equal(initialAttention("t", false).state, "idle");
});

test("hook signals drive the states", () => {
  let a = initialAttention("t", true);
  a = applySignal(a, ev({ kind: "hooks-ready", event: "UserPromptSubmit" }));
  assert.equal(a.hooks, "active");
  a = applySignal(a, ev({ kind: "tool-start", tool: "Bash", input: { command: "npm test" }, quiet: false }));
  assert.equal(a.state, "working");
  assert.equal(describeNow(a, "claude"), "Running npm test");
  const open = ev({ kind: "prompt-open", prompt: {
    id: 0, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook",
    tool: { name: "Bash", input: { command: "rm -rf build" } }, destructive: { pattern: "rm-recursive-force" },
  } });
  a = applySignal(a, open);
  assert.equal(a.state, "needs-you");
  assert.equal(a.prompt?.id, open.seq);
  assert.match(describeNow(a, "claude"), /rm -rf build/);
  a = applySignal(a, ev({ kind: "prompt-closed", promptId: open.seq, reason: "resolved" }));
  assert.equal(a.state, "working");
  assert.equal(a.prompt, undefined);
  a = applySignal(a, ev({ kind: "turn-end", message: "Added the retry wrapper. Tests pass.", backgroundTasks: 0 }));
  assert.equal(a.state, "turn-finished");
  assert.equal(describeNow(a, "claude"), "Added the retry wrapper.");
  a = applySignal(a, ev({ kind: "turn-start", prompt: "now add docs" }));
  assert.equal(a.state, "working");
});

test("exited is terminal; late hooks do not revive it", () => {
  let a = initialAttention("t", true);
  a = applyLifecycle(a, "exited", "t2");
  a = applySignal(a, ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "?", options: [], acceptsText: false, source: "hook" } }));
  assert.equal(a.state, "exited");
  a = applySignal(a, ev({ kind: "turn-end", backgroundTasks: 0 }));
  assert.equal(a.state, "exited");
});

test("screen decisions open, merge, and close prompts", () => {
  const lines = ["Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell Claude what to do differently"];
  const detected = detectPrompt(lines, "claude")!;
  let a = initialAttention("t", true);
  const d1 = screenDecision(a, detected, false, true, "t1");
  assert.ok(d1.open);
  assert.equal(d1.open.source, "screen");
  assert.equal(d1.open.options.length, 2);
  // A hook prompt without options gets merged, keeping its id.
  const hookOpen = ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook", tool: { name: "Bash", input: { command: "ls" } } } });
  a = applySignal(a, hookOpen);
  const d2 = screenDecision(a, detected, false, true, "t2");
  assert.equal(d2.open, undefined);
  assert.equal(d2.merge, detected);
  const merged = mergeScreenIntoPrompt(a.prompt!, detected, "abc");
  assert.equal(merged.id, hookOpen.seq);
  assert.equal(merged.options.length, 2);
  assert.equal(merged.hash, "abc");
  assert.equal(merged.tool?.name, "Bash");
  a = { ...a, prompt: merged };
  const d3 = screenDecision(a, null, false, true, "t3");
  assert.deepEqual(d3.close, { promptId: hookOpen.seq, reason: "vanished" });
});

test("idle screens become turn-finished only after a turn-end", () => {
  let a = initialAttention("t", true);
  assert.equal(screenDecision(a, null, true, false, "t1").idle, "idle");
  a = applySignal(a, ev({ kind: "turn-end", backgroundTasks: 0 }));
  a = applySignal(a, ev({ kind: "turn-start" }));
  assert.equal(screenDecision(a, null, true, false, "t2").idle, "turn-finished");
  a = applySignal(a, ev({ kind: "turn-end", backgroundTasks: 0 }));
  // Without hooks, new output after a finished turn is the only sign of new work.
  assert.equal(screenDecision({ ...a, hooks: "none" }, null, false, true, "t3").working, true);
});

test("with hooks active, output after a turn-end does not reopen the turn", () => {
  let a = initialAttention("t", true);
  a = applySignal(a, ev({ kind: "turn-end", message: "Done for now.", backgroundTasks: 0 }));
  assert.equal(a.hooks, "active");
  assert.equal(a.state, "turn-finished");
  // A redraw or late output alone keeps the finished turn.
  assert.deepEqual(screenDecision(a, null, false, true, "t2"), {});
  // Only a turn or tool hook starts work again.
  assert.equal(applySignal(a, ev({ kind: "tool-start", tool: "Bash", input: { command: "ls" }, quiet: false })).state, "working");
  assert.equal(applySignal(a, ev({ kind: "turn-start" })).state, "working");
  // An idle session still wakes up on output.
  assert.equal(screenDecision({ ...a, state: "idle" }, null, false, true, "t3").working, true);
});

test("a turn-end without a message clears the previous turn's message", () => {
  let a = initialAttention("t", true);
  a = applySignal(a, ev({ kind: "turn-end", message: "Added retries.", backgroundTasks: 0 }));
  assert.equal(describeNow(a, "claude"), "Added retries.");
  a = applySignal(a, ev({ kind: "turn-end", backgroundTasks: 0 }));
  assert.equal(a.lastMessage, undefined);
  assert.equal(describeNow(a, "claude"), "Finished a turn");
});

const hookOnly = (): Prompt => ({ id: 0, kind: "permission", title: "?", options: [], acceptsText: false, source: "hook" });
const onScreen = (): Prompt => ({ id: 0, kind: "permission", title: "Do you want to proceed?", options: [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "No", role: "reject" }], acceptsText: false, source: "screen", hash: "h" });

test("turn and tool hooks keep a prompt the screen shows and clear a hook-only one", () => {
  for (const signal of [
    { kind: "turn-start" as const },
    { kind: "tool-start" as const, tool: "Bash", input: { command: "rm -rf build" }, quiet: false },
  ]) {
    const open = ev({ kind: "prompt-open", prompt: onScreen() });
    const kept = applySignal(applySignal(initialAttention("t", true), open), ev(signal));
    assert.equal(kept.state, "needs-you", signal.kind);
    assert.equal(kept.prompt?.id, open.seq, signal.kind);
    const cleared = applySignal(applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: hookOnly() })), ev(signal));
    assert.equal(cleared.state, "working", signal.kind);
    assert.equal(cleared.prompt, undefined, signal.kind);
  }
  // The tool still becomes what the agent is doing.
  const withTool = applySignal(applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: onScreen() })), ev({ kind: "tool-start", tool: "Bash", input: { command: "rm -rf build" }, quiet: false }));
  assert.equal(withTool.lastTool?.summary, "rm -rf build");
  // A turn-end closes either kind.
  const ended = applySignal(applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: onScreen() })), ev({ kind: "turn-end", backgroundTasks: 0 }));
  assert.equal(ended.prompt, undefined);
});

test("dropsPrompt names exactly the signals that would drop the open prompt", () => {
  const screenOpen = applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: onScreen() }));
  const hookOpen = applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: hookOnly() }));
  const turnEnd = { kind: "turn-end" as const, backgroundTasks: 0 };
  const turnStart = { kind: "turn-start" as const };
  const toolStart = { kind: "tool-start" as const, tool: "Bash", input: {}, quiet: false };
  assert.equal(dropsPrompt(screenOpen, turnEnd), true);
  assert.equal(dropsPrompt(hookOpen, turnEnd), true);
  assert.equal(dropsPrompt(screenOpen, turnStart), false);
  assert.equal(dropsPrompt(screenOpen, toolStart), false);
  assert.equal(dropsPrompt(hookOpen, turnStart), true);
  assert.equal(dropsPrompt(hookOpen, toolStart), true);
  assert.equal(dropsPrompt(hookOpen, { kind: "prompt-closed", promptId: hookOpen.prompt!.id, reason: "resolved" }), false);
  assert.equal(dropsPrompt(hookOpen, { kind: "notice", type: "x" }), false);
  assert.equal(dropsPrompt(initialAttention("t", true), turnEnd), false);
  // Every signal dropsPrompt names really drops the prompt.
  for (const [att, signal] of [[screenOpen, turnEnd], [hookOpen, turnStart], [hookOpen, toolStart]] as const)
    assert.equal(applySignal(att, ev(signal)).prompt, undefined);
});

test("a new turn forgets the previous message; a rejection forgets the rejected tool", () => {
  let a = initialAttention("t", true);
  a = applySignal(a, ev({ kind: "turn-end", message: "Added retries.", backgroundTasks: 0 }));
  a = applySignal(a, ev({ kind: "turn-start", prompt: "now docs" }));
  assert.equal(a.lastMessage, undefined);
  const running = applySignal(a, ev({ kind: "tool-start", tool: "Bash", input: { command: "rm -rf build" }, quiet: false }));
  assert.equal(describeNow(running, "claude"), "Running rm -rf build");
  const answer = (label: string) => ev({ kind: "answer", promptId: 1, requestId: "r", option: { index: 0, label }, text: false, result: "closed", source: "host" });
  const closed = (label: string) => ev({ kind: "prompt-closed", promptId: 99, reason: "answered-here", label, source: "host" });
  for (const label of ["No", "No, and tell Claude what to do differently (esc)"]) {
    assert.equal(applySignal(running, answer(label)).lastTool, undefined, label);
    assert.equal(applySignal(running, closed(label)).lastTool, undefined, label);
    assert.equal(describeNow(applySignal(running, answer(label)), "claude"), "Thinking");
  }
  // Approving keeps the tool: it is about to run.
  assert.equal(applySignal(running, answer("Yes")).lastTool?.tool, "Bash");
  assert.equal(applySignal(running, closed("Yes, and don't ask again for rm commands")).lastTool?.tool, "Bash");
});

test("a tool-start clears a stale prompt so idle detection works", () => {
  let a = initialAttention("t", true);
  a = applySignal(a, ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "?", options: [], acceptsText: false, source: "hook" } }));
  assert.equal(a.state, "needs-you");
  a = applySignal(a, ev({ kind: "tool-start", tool: "Bash", input: { command: "ls" }, quiet: false }));
  assert.equal(a.state, "working");
  assert.equal(a.prompt, undefined);
  assert.equal(screenDecision(a, null, true, false, "t").idle, "idle");
});

const rmDialog = () => detectPrompt([
  "Bash command",
  "  rm -rf build",
  "  Remove the stale build directory",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
], "claude")!;

test("correlates requires every hook detail line in the dialog block", () => {
  const block = rmDialog();
  assert.equal(correlates({ title: "Permission needed", detail: "rm -rf build" }, block), true);
  // A fragment of a word or line is not the same line.
  assert.equal(correlates({ title: "Permission needed", detail: "w" }, block), false);
  assert.equal(correlates({ title: "Permission needed", detail: "rm -rf" }, block), false);
  // A shared prefix is not the same command.
  const cd = "cd /Users/someone/projects/infinite/packages/host &&";
  assert.equal(correlates({ title: "Permission needed", detail: `${cd} ls` }, { title: "Do you want to proceed?", detail: `Bash command\n${cd} git push --force origin main` }), false);
  // Case matters; whitespace layout does not.
  assert.equal(correlates({ title: "Permission needed", detail: "RM -RF build" }, block), false);
  assert.equal(correlates({ title: "Permission needed", detail: "rm   -rf\tbuild " }, block), true);
});

test("correlates compares multi-line commands line by line", () => {
  const heredoc = "cat <<'EOF' > notes.txt\nhello world\nEOF";
  const block = { title: "Do you want to proceed?", detail: "Bash command\n  cat <<'EOF' > notes.txt\n  hello world\n  EOF\nWrite notes" };
  assert.equal(correlates({ title: "Permission needed", detail: heredoc }, block), true);
  assert.equal(correlates({ title: "Permission needed", detail: "cat <<'EOF' > notes.txt\ngoodbye world\nEOF" }, block), false);
});

test("correlates uses a title only when it names the dialog", () => {
  const block = rmDialog();
  // Placeholder titles and an empty prompt prove nothing.
  assert.equal(correlates({ title: "Permission needed" }, block), false);
  assert.equal(correlates({ title: "Approval needed" }, block), false);
  assert.equal(correlates({ title: "" }, block), false);
  assert.equal(correlates({}, block), false);
  // An AskUserQuestion hook carries the question the dialog shows.
  const question = detectPrompt(["Which DB?", "❯ 1. Postgres", "  2. SQLite", "  3. Other"], "claude")!;
  assert.equal(correlates({ title: "Which DB?" }, question), true);
  assert.equal(correlates({ title: "Which cache?" }, question), false);
});

test("correlates accepts a line the dialog cut short with an ellipsis after at least 32 characters", () => {
  const push = "git push --force-with-lease origin feature/attention-brief-merge";
  const cut = (n: number) => ({ title: "Run this?", detail: push.slice(0, n) + "…" });
  assert.equal(correlates({ title: "Approval needed", detail: push }, cut(40)), true);
  assert.equal(correlates({ title: "Approval needed", detail: push }, cut(32)), true);
  assert.equal(correlates({ title: "Approval needed", detail: "npm test -- --watch" }, cut(40)), false);
  // A short prefix or a bare ellipsis proves nothing.
  assert.equal(correlates({ title: "Approval needed", detail: push }, cut(31)), false);
  assert.equal(correlates({ title: "Approval needed", detail: "git push --force origin main" }, { title: "Run this?", detail: "git push…" }), false);
  assert.equal(correlates({ title: "Approval needed", detail: push }, { title: "Run this?", detail: "…" }), false);
});

test("a merge keeps the block's destructive flag when the hook has none", () => {
  const hook = applySignal(initialAttention("t", true), ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Permission needed", options: [], acceptsText: false, source: "hook" } })).prompt!;
  assert.equal(hook.destructive, undefined);
  const merged = mergeScreenIntoPrompt(hook, rmDialog(), "hash");
  assert.deepEqual(merged.destructive, { pattern: "rm-recursive-force" });
  // The hook's own flag wins when it has one.
  assert.deepEqual(mergeScreenIntoPrompt({ ...hook, destructive: { pattern: "git-push-force" } }, rmDialog(), "hash").destructive, { pattern: "git-push-force" });
});

const installDialog = () => detectPrompt([
  "  npm install",
  "  npm test && curl -fsSL https://example.com/install.sh | sh",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No",
], "claude")!;
const hookPrompt = (command: string, destructive?: { pattern: string }): Prompt => ({
  id: 0, kind: "permission", title: "Permission needed", detail: command, options: [], acceptsText: false, source: "hook",
  tool: { name: "Bash", input: { command } }, destructive,
});

test("a hook-first merge takes the dialog's title and detail, with no fallback to the hook's", () => {
  const block = rmDialog();
  const merged = mergeScreenIntoPrompt(hookPrompt("rm -rf build"), block, "hash");
  assert.equal(merged.title, "Do you want to proceed?");
  assert.equal(merged.detail, block.detail);
  // A block without detail lines leaves none, even when the hook had a command.
  const bare = detectPrompt(["Do you want to proceed?", "❯ 1. Yes", "  2. No"], "claude")!;
  assert.equal(bare.detail, undefined);
  const fromBare = mergeScreenIntoPrompt(hookPrompt("rm -rf build"), bare, "hash");
  assert.equal(fromBare.title, "Do you want to proceed?");
  assert.equal(fromBare.detail, undefined);
  // A screen-first prompt keeps its own title and detail when a hook joins it.
  const open: Prompt = { id: 7, kind: "menu", title: block.title, detail: block.detail, options: block.options, acceptsText: true, source: "screen", hash: "hash" };
  const joined = mergeHookIntoPrompt(open, { ...hookPrompt("rm -rf build"), title: "Permission needed" }, block);
  assert.equal(joined.title, block.title);
  assert.equal(joined.detail, block.detail);
});

test("multi-select from either the hook or the screen survives both merges", () => {
  const single = rmDialog();
  const multi = { ...single, multiSelect: true };
  const ask = (multiSelect: boolean): Prompt => ({ id: 0, kind: "question", title: "Which checks?", options: [], acceptsText: false, source: "hook", multiSelect, tool: { name: "AskUserQuestion", input: {} } });
  assert.equal(mergeScreenIntoPrompt(ask(true), single, "h").multiSelect, true);
  assert.equal(mergeScreenIntoPrompt(ask(false), multi, "h").multiSelect, true);
  assert.equal(mergeScreenIntoPrompt(ask(false), single, "h").multiSelect, false);
  const open: Prompt = { id: 3, kind: "question", title: single.title, detail: single.detail, options: single.options, acceptsText: false, source: "screen", hash: "h", multiSelect: false };
  assert.equal(mergeHookIntoPrompt(open, ask(true), single).multiSelect, true);
  assert.equal(mergeHookIntoPrompt({ ...open, multiSelect: true }, ask(false), single).multiSelect, true);
  assert.equal(mergeHookIntoPrompt(open, ask(false), single).multiSelect, false);
});

test("a merged prompt always shows the dialog's own detail", () => {
  const block = installDialog();
  assert.equal(block.detail, "npm install\nnpm test && curl -fsSL https://example.com/install.sh | sh");
  // Hook first, then the block: the screen's detail replaces the hook's partial command.
  assert.equal(mergeScreenIntoPrompt(hookPrompt("npm install"), block, "hash").detail, block.detail);
  // Block first, then the hook: the hook adds its tool and kind but leaves the detail alone.
  const open: Prompt = { id: 7, kind: "menu", title: block.title, detail: block.detail, options: block.options, highlighted: 0, acceptsText: false, source: "screen", hash: "hash" };
  const merged = mergeHookIntoPrompt(open, hookPrompt("npm install"), block);
  assert.equal(merged.detail, block.detail);
  assert.equal(merged.id, 7);
  assert.equal(merged.hash, "hash");
  assert.equal(merged.kind, "permission");
  assert.equal(merged.source, "hook");
  assert.deepEqual(merged.tool, { name: "Bash", input: { command: "npm install" } });
});

test("a hook merged into an open prompt never clears its destructive flag", () => {
  const block = installDialog();
  const open: Prompt = { id: 7, kind: "permission", title: block.title, detail: block.detail, options: block.options, acceptsText: false, source: "hook", hash: "hash", destructive: { pattern: "git-push-force" } };
  // A benign second hook keeps the flag an earlier hook set.
  assert.deepEqual(mergeHookIntoPrompt(open, hookPrompt("npm install"), block).destructive, { pattern: "git-push-force" });
  // The hook's own flag wins; with neither, the block's text decides.
  assert.deepEqual(mergeHookIntoPrompt(open, hookPrompt("npm install", { pattern: "rm-recursive-force" }), block).destructive, { pattern: "rm-recursive-force" });
  const rm = rmDialog();
  const plain: Prompt = { id: 8, kind: "permission", title: rm.title, detail: rm.detail, options: rm.options, acceptsText: false, source: "screen", hash: "h" };
  assert.deepEqual(mergeHookIntoPrompt(plain, hookPrompt("rm -rf build"), rm).destructive, { pattern: "rm-recursive-force" });
});

test("the now line names the hook's command when the dialog shows it", () => {
  const needsYou = (prompt: Prompt) => ({ ...initialAttention("t", true), state: "needs-you" as const, prompt });
  const detail = "Process 42 stays alive when clients disconnect.\nBash command\nrm -rf build\nRemove the stale build directory";
  const screenOnly: Prompt = { id: 1, kind: "permission", title: "Do you want to proceed?", detail, options: [], acceptsText: false, source: "screen", hash: "h" };
  // Without a hook the first detail line is all there is.
  assert.equal(describeNow(needsYou(screenOnly), "claude"), "Do you want to proceed? Process 42 stays alive when clients disconnect.");
  // With a hook, the detail line equal to its command is the one named.
  const withTool = { ...screenOnly, tool: { name: "Bash", input: { command: "rm -rf build" } } };
  assert.equal(describeNow(needsYou(withTool), "claude"), "Do you want to proceed? rm -rf build");
  // A command the dialog does not show is never named; the screen's first line stands.
  const elsewhere = { ...screenOnly, tool: { name: "Bash", input: { command: "git push --force" } } };
  assert.equal(describeNow(needsYou(elsewhere), "claude"), "Do you want to proceed? Process 42 stays alive when clients disconnect.");
});
