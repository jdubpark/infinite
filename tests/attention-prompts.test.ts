import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectPrompt, isIdleScreen } from "../packages/attention/src/prompts.js";
import { roleForLabel } from "../packages/attention/src/roles.js";

const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), "utf8").split("\n");

test("roles follow the label text", () => {
  assert.equal(roleForLabel("Yes"), "accept");
  assert.equal(roleForLabel("Yes, proceed"), "accept");
  assert.equal(roleForLabel("Yes, and don't ask again for rm commands"), "accept-always");
  assert.equal(roleForLabel("Yes, and switch to auto mode"), "accept-always");
  assert.equal(roleForLabel("No, and tell Claude what to do differently (esc)"), "reject-with-feedback");
  assert.equal(roleForLabel("No, continue without running it"), "reject");
  assert.equal(roleForLabel("Chat about this"), "other");
});

test("claude permission dialog inside a box", () => {
  const p = detectPrompt(screen("claude-permission"), "claude");
  assert.ok(p);
  assert.equal(p.kind, "permission");
  assert.equal(p.title, "Do you want to proceed?");
  assert.match(p.detail ?? "", /rm -rf build/);
  assert.equal(p.options.length, 3);
  assert.equal(p.options[1].label, "Yes, and don't ask again for rm commands in /home/dev/projects/infinite");
  assert.equal(p.highlighted, 0);
  assert.equal(p.acceptsText, true);
  assert.equal(p.multiSelect, false);
});

test("transcript lines above a boxed dialog are not part of its header", () => {
  const lines = ["⏺ I'll remove the stale build directory first.", "  Then rebuild from scratch.", ...screen("claude-permission")];
  const p = detectPrompt(lines, "claude");
  assert.ok(p);
  assert.equal(p.title, "Do you want to proceed?");
  assert.equal(p.detail, "Bash command\nrm -rf build\nRemove the stale build directory");
  assert.doesNotMatch(p.detail ?? "", /stale build directory first|rebuild/);
  // The fingerprint, and so the answer hash, is the same with or without the transcript above.
  assert.equal(p.fingerprint, detectPrompt(screen("claude-permission"), "claude")!.fingerprint);
});

test("codex command approval", () => {
  const p = detectPrompt(screen("codex-command"), "codex");
  assert.ok(p);
  assert.equal(p.kind, "permission");
  assert.equal(p.title, "Would you like to run the following command?");
  assert.match(p.detail ?? "", /npm test/);
  assert.equal(p.options.length, 4);
  assert.equal(p.options[3].role, "reject-with-feedback");
  assert.equal(p.highlighted, 0);
});

test("the lowest numbered block wins when two exist", () => {
  const lines = [...screen("demo-dialog"), "", "Options", "  1. Alpha", "❯ 2. Beta"];
  const p = detectPrompt(lines, "demo");
  assert.ok(p);
  assert.equal(p.options.map((o) => o.label).join("|"), "Alpha|Beta");
  assert.equal(p.highlighted, 1);
  assert.equal(p.kind, "menu");
});

test("yes/no line", () => {
  const p = detectPrompt(screen("yesno"), "grok");
  assert.ok(p);
  assert.equal(p.kind, "yes-no");
  assert.equal(p.title, "Continue? [y/N]");
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(p.acceptsText, true);
});

test("question with multi-select footer", () => {
  const lines = ["Which checks should run?", "❯ 1. Lint", "  2. Tests", "  3. Chat about this", "Enter to confirm, a to select all, n to select none"];
  const p = detectPrompt(lines, "claude");
  assert.ok(p);
  assert.equal(p.kind, "question");
  assert.equal(p.multiSelect, true);
});

test("fingerprint ignores position, not content", () => {
  const a = detectPrompt(screen("demo-dialog"), "demo")!;
  const b = detectPrompt(["", "", ...screen("demo-dialog")], "demo")!;
  const c = detectPrompt(screen("demo-dialog").map((l) => l.replace("3. No,", "3. Never,")), "demo")!;
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("fingerprint includes the dialog's detail, normalised", () => {
  const a = detectPrompt(screen("demo-dialog"), "demo")!;
  const other = detectPrompt(screen("demo-dialog").map((l) => l.replace("rm -rf build", "rm -rf /data")), "demo")!;
  const respaced = detectPrompt(screen("demo-dialog").map((l) => l.replace("  rm -rf build", "    rm   -rf  build ")), "demo")!;
  assert.notEqual(a.fingerprint, other.fingerprint);   // same title and options, different command
  assert.equal(a.fingerprint, respaced.fingerprint);
});

test("idle and non-idle screens", () => {
  assert.equal(isIdleScreen(screen("idle-claude"), "claude"), true);
  assert.equal(isIdleScreen(screen("claude-permission"), "claude"), false);
  assert.equal(isIdleScreen(["$ "], "grok"), true);
  assert.equal(isIdleScreen(["Running tests..."], "grok"), false);
  assert.equal(detectPrompt(screen("idle-claude"), "claude"), null);
});

test("a numbered list without a selection marker is not a prompt", () => {
  assert.equal(detectPrompt(["Plan:", "1. Install deps", "2. Run tests"], "claude"), null);
});

test("permission kind is decided by the title only", () => {
  const p = detectPrompt(["Notes about permission handling", "Pick one", "❯ 1. Alpha", "  2. Beta"], "demo");
  assert.ok(p);
  assert.equal(p.title, "Pick one");
  assert.equal(p.kind, "menu");
});

test("generic idle requires a prompt-shaped line", () => {
  assert.equal(isIdleScreen(["Downloading… 45%"], "grok"), false);
  assert.equal(isIdleScreen(["user@host:~$ "], "grok"), true);
  assert.equal(isIdleScreen(["$ "], "grok"), true);
  assert.equal(isIdleScreen(["> "], "grok"), true);
});

test("a composer with typed text is not idle", () => {
  assert.equal(isIdleScreen(["> a"], "claude"), false);
  assert.equal(isIdleScreen(["> "], "claude"), true);
});

test("an indented footer at the option column is not a continuation", () => {
  const p = detectPrompt(["Pick one", "❯ 1. Alpha", "  2. Beta", "  Tab to amend"], "demo");
  assert.ok(p);
  assert.deepEqual(p.options.map((o) => o.label), ["Alpha", "Beta"]);
});
