# Mobile Attention Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the phone app into an attention-first Brief (inbox, decision card, timeline, composer) fed by host-derived signals from Claude Code and Codex hooks plus terminal-screen heuristics, with push notifications when a session needs the person.

**Architecture:** A new dependency-free workspace package `packages/attention` holds the pure logic (types, destructive classifier, prompt detection, attention reducer, hook payload mapping, moment derivation) and is shared by the host and the phone. The worker gains a loopback hook listener, screen detection, an attention state and an `answer` operation; the API exposes signals, attention, answer and push registration; a Notifier in the API process sends Expo pushes on state transitions. The phone is split into screens and components that render attention and signals.

**Tech Stack:** TypeScript 5.9 (host, Node 22, ESM, `node:test` via `tsx`), Express 5, zod 4, `@xterm/headless` 5.5, Expo SDK 57 / React Native 0.86 / expo-router 57, `expo-notifications` 57, `expo-secure-store`.

**Spec:** `docs/superpowers/specs/2026-10-04-mobile-attention-brief-design.md`

## Global Constraints

- No model calls on the host; all classification is rule-based (spec §1 Non-goals).
- No signal ever answers a prompt; only `POST /answer` keystrokes or laptop input do (spec §1, §6).
- Hook handlers reply `204` with an empty body at once and never return a decision (spec §3.1).
- Truncation: 4,000 chars per input string, 2,000 for `Write.content`, `Edit.old_string`, `Edit.new_string`; `tool-start` data ≤ 16 KiB; `turn-end.message` ≤ 4,000; `now` ≤ 140 (spec §4.3, §5.1).
- Journal format unchanged; the only addition is `Event.type = "signal"` (spec §4).
- Push bodies default to `minimal` with no command, file or message text (spec §8.1).
- Phone: light theme, `DESIGN.md` tokens, touch targets ≥ 48 dp, amber for `needs-you`, error red for destructive marks only (spec §9.4).
- The word "done" never appears in a `turn-finished` UI string (spec §9.3).
- Commit messages carry no `Claude-Session:` trailer (repository convention).
- Run `npm run check` (typecheck, tests, build) before declaring a host task complete; run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile` before declaring a phone task complete.

## Review Focus

1. **Two numbered blocks on one screen** (a stale menu in scrollback above a live dialog): detection must pick the lowest block. Test added to Task 2.
2. **Option labels wrapped onto a continuation line** at 120 columns: the continuation must join its option, not break the block. Test added to Task 2.
3. **Hook payloads after exit** (Claude's `SessionEnd`, a late `Stop`): no transition out of `exited`, no `needs-you` on a dead session. Test added to Task 3.
4. **Dialog redrawn one row lower while streaming**: the answer check compares prompt text, not position, so the same dialog still matches; a changed option set does not. Test added to Task 2 (fingerprint) and exercised end to end by the stale-prompt 409 in Task 8.
5. **`DeviceNotRegistered` ticket and duplicate registrations**: the token is removed once and never registered twice. Test added to Task 10.

---

### Task 0: Baseline commit

The repository has no commits. Every later task commits, so the current tree needs a baseline. `.gitignore` already excludes `credentials.txt`, `.local/`, `dist/`, `node_modules/`, `.expo/`, `android/`.

**Files:** none created.

- [ ] **Step 1: Confirm no secrets are staged**

Run from the repository root: `git add -A --dry-run | grep -i -E "credentials|\.local/|devices\.json|vault\.key|google-services" ; echo "exit $?"`
Expected: no lines printed, then `exit 1`.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: baseline of the Infinite prototype before the attention Brief work"
```

---

### Task 1: `packages/attention` scaffold and destructive classifier

**Files:**
- Create: `packages/attention/package.json`, `packages/attention/tsconfig.json`, `packages/attention/src/index.ts`, `packages/attention/src/types.ts`, `packages/attention/src/destructive.ts`
- Modify: `package.json` (root scripts), `tsconfig.base.json` (none), `packages/host/package.json` (dependency)
- Test: `tests/attention-destructive.test.ts`

**Interfaces:**
- Produces: `matchDestructive(command: string): string | null`; all shared types in `types.ts` (copied below, used verbatim by Tasks 2–17).

- [ ] **Step 1: Create the package**

`packages/attention/package.json`:

```json
{
  "name": "@infinite/attention",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

`packages/attention/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts"]
}
```

`packages/attention/src/types.ts`:

```ts
export type Provider = "claude" | "codex" | "grok" | "opencode" | "demo";
export type SignalSource = "hook" | "osc" | "screen" | "host";
export type PromptSource = "hook" | "osc" | "screen";
export type PromptKind = "permission" | "question" | "elicitation" | "yes-no" | "menu";
export type OptionRole = "accept" | "accept-always" | "reject" | "reject-with-feedback" | "other";

export interface PromptOption {
  index: number;
  label: string;
  role: OptionRole;
}
export interface Prompt {
  id: number;
  kind: PromptKind;
  title: string;
  detail?: string;
  options: PromptOption[];
  highlighted?: number;
  acceptsText: boolean;
  multiSelect?: boolean;
  destructive?: { pattern: string };
  tool?: { name: string; input: Record<string, unknown> };
  source: PromptSource;
  hash?: string;
}

export type PromptClosedReason = "answered-here" | "resolved" | "vanished" | "superseded";
export type AnswerResult = "closed" | "still-open" | "changed" | "refused";

export type Signal =
  | { kind: "hooks-ready"; event: string }
  | { kind: "turn-start"; prompt?: string }
  | { kind: "turn-end"; message?: string; backgroundTasks: number; stopHookActive?: boolean; failed?: boolean }
  | { kind: "tool-start"; tool: string; toolUseId?: string; input: Record<string, unknown>; quiet: boolean; destructive?: { pattern: string } }
  | { kind: "tool-end"; tool: string; toolUseId?: string; ok: boolean; durationMs?: number; summary?: string; files?: string[]; error?: string }
  | { kind: "prompt-open"; prompt: Prompt }
  | { kind: "prompt-closed"; promptId: number; reason: PromptClosedReason; label?: string }
  | { kind: "answer"; promptId: number; requestId: string; option?: { index: number; label: string }; text: boolean; result: AnswerResult }
  | { kind: "notice"; type: string; message?: string; title?: string }
  | { kind: "error"; message: string; where: "provider" | "hooks" | "host" };
export type SignalKind = Signal["kind"];

export type SignalData = Signal & {
  source: SignalSource;
  provider: Provider;
  agent?: { id: string; type: string };
};

export interface SignalEvent {
  seq: number;
  at: string;
  type: "signal";
  data: SignalData;
}

export type AttentionState =
  | "working" | "needs-you" | "turn-finished" | "idle"
  | "exited" | "unavailable" | "recording-error";

export interface Attention {
  state: AttentionState;
  since: string;
  source: "hook" | "osc" | "screen" | "lifecycle";
  now: string;
  prompt?: Prompt;
  lastMessage?: string;
  lastTool?: { tool: string; summary: string; at: string };
  lastActivityAt: string;
  hooks: "active" | "none";
  hookErrors: number;
  /** Internal: a turn-end has been seen in this session. */
  sawTurnEnd: boolean;
}

export const LOUD_TOOLS = new Set([
  "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit",
  "AskUserQuestion", "Agent", "Workflow", "ExitPlanMode", "apply_patch",
]);
export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code", codex: "Codex", grok: "Grok Build", opencode: "OpenCode", demo: "Rehearsal",
};
```

`packages/attention/src/index.ts`:

```ts
export * from "./types.js";
export * from "./destructive.js";
```

- [ ] **Step 2: Wire the workspace**

Root `package.json` scripts become:

```json
"build": "npm run build -w @infinite/attention && npm run build -w @infinite/host && npm run build -w @infinite/web",
"test": "npm run build -w @infinite/attention && tsx --test --test-concurrency=1 tests/*.test.ts",
```

Add to `packages/host/package.json` dependencies: `"@infinite/attention": "0.1.0"`.

Run: `npm install` (links the workspace). Expected: `node_modules/@infinite/attention` is a symlink.

- [ ] **Step 3: Write the failing test**

`tests/attention-destructive.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { matchDestructive } from "../packages/attention/src/destructive.js";

test("destructive commands are named by pattern", () => {
  assert.equal(matchDestructive("rm -rf node_modules"), "rm-recursive-force");
  assert.equal(matchDestructive("rm -fr ./build"), "rm-recursive-force");
  assert.equal(matchDestructive("rm --recursive --force dist"), "rm-recursive-force-long");
  assert.equal(matchDestructive("git push --force origin main"), "git-push-force");
  assert.equal(matchDestructive("git push -f"), "git-push-force");
  assert.equal(matchDestructive("git push --force-with-lease"), "git-push-force");
  assert.equal(matchDestructive("git reset --hard HEAD~1"), "git-reset-hard");
  assert.equal(matchDestructive("psql -c 'DROP TABLE users'"), "sql-drop-table");
  assert.equal(matchDestructive("TRUNCATE sessions"), "sql-truncate");
  assert.equal(matchDestructive("DELETE FROM users WHERE 1=1"), "sql-delete-from");
  assert.equal(matchDestructive("npm run db:reset"), "db-reset");
  assert.equal(matchDestructive("npx knex migrate:down"), "migration-down");
  assert.equal(matchDestructive("git clean -fd"), "git-clean-force");
  assert.equal(matchDestructive("git checkout -- ."), "git-checkout-discard");
  assert.equal(matchDestructive("git branch -D feature"), "git-branch-delete");
  assert.equal(matchDestructive("chmod -R 777 /srv"), "chmod-world-writable");
  assert.equal(matchDestructive("kubectl delete deployment api"), "kubectl-delete");
  assert.equal(matchDestructive("terraform destroy -auto-approve"), "terraform-destroy");
  assert.equal(matchDestructive("docker system prune -af"), "docker-prune");
});

test("ordinary commands are not destructive", () => {
  for (const command of [
    "rm -r --dry-run tmp", "rm file.txt", "git push origin main", "git reset --soft HEAD~1",
    "npm test", "ls -la", "git status", "echo DROP TABLE", "select * from users",
  ])
    assert.equal(matchDestructive(command), null, command);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx tsx --test tests/attention-destructive.test.ts`
Expected: FAIL, "Cannot find module … destructive.js".

- [ ] **Step 5: Implement**

`packages/attention/src/destructive.ts`:

```ts
// Pattern list adapted from jevcode (packages/contracts/src/security.ts) with additions.
export interface DestructivePattern {
  name: string;
  pattern: RegExp;
}
export const destructivePatterns: readonly DestructivePattern[] = [
  { name: "rm-recursive-force", pattern: /\brm\b\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r)\b/i },
  { name: "rm-recursive-force-long", pattern: /\brm\b\s+(?=.*--recursive)(?=.*--force)/i },
  { name: "git-push-force", pattern: /\bgit\s+push\b[^\n]*(^|\s)(--force(-with-lease)?|-f)(\s|$|=)/ },
  { name: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/ },
  { name: "git-clean-force", pattern: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*f/ },
  { name: "git-checkout-discard", pattern: /\bgit\s+checkout\s+--\s+\./ },
  { name: "git-branch-delete", pattern: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/ },
  { name: "sql-drop-table", pattern: /\bDROP\s+TABLE\b/i },
  { name: "sql-truncate", pattern: /\bTRUNCATE(\s+TABLE)?\s+\w/i },
  { name: "sql-delete-from", pattern: /\bDELETE\s+FROM\b/i },
  { name: "db-reset", pattern: /\bdb:reset\b/i },
  { name: "migration-down", pattern: /\b(migrat(?:e|ion)s?\s+(down|rollback)|migrate:down|migration:down|db:migrate:down)\b/i },
  { name: "chmod-world-writable", pattern: /\bchmod\s+(-R\s+)?0?777\b/ },
  { name: "kubectl-delete", pattern: /\bkubectl\s+delete\b/ },
  { name: "terraform-destroy", pattern: /\bterraform\s+destroy\b/ },
  { name: "docker-prune", pattern: /\bdocker\s+(system|volume|image|container)\s+prune\b/ },
];

export function matchDestructive(command: string): string | null {
  // Strip a leading `echo …` so quoted examples are not flagged.
  if (/^\s*echo\b/.test(command)) return null;
  for (const entry of destructivePatterns) if (entry.pattern.test(command)) return entry.name;
  return null;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test tests/attention-destructive.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Build and typecheck the package**

Run: `npm run build -w @infinite/attention && npm run typecheck`
Expected: `packages/attention/dist/index.js` exists; typecheck passes for all workspaces.

- [ ] **Step 8: Commit**

```bash
git add packages/attention package.json package-lock.json packages/host/package.json tests/attention-destructive.test.ts
git commit -m "feat(attention): shared package with signal types and destructive classifier"
```

---

### Task 2: Prompt detection and option roles

**Files:**
- Create: `packages/attention/src/roles.ts`, `packages/attention/src/prompts.ts`, `tests/fixtures/screens/claude-permission.txt`, `tests/fixtures/screens/codex-command.txt`, `tests/fixtures/screens/demo-dialog.txt`, `tests/fixtures/screens/yesno.txt`, `tests/fixtures/screens/idle-claude.txt`
- Modify: `packages/attention/src/index.ts`
- Test: `tests/attention-prompts.test.ts`

**Interfaces:**
- Produces: `roleForLabel(label: string): OptionRole`; `detectPrompt(lines: string[], provider: Provider): DetectedPrompt | null`; `isIdleScreen(lines: string[], provider: Provider): boolean`; `cleanLine(line: string): string`.
- `DetectedPrompt = { kind, title, detail?, options, highlighted?, acceptsText, multiSelect, fingerprint, blockStart, blockEnd }` where `fingerprint` is the plain text the worker hashes (Task 7).

- [ ] **Step 1: Write fixtures**

`tests/fixtures/screens/claude-permission.txt` (synthetic, in Claude Code's layout; replaced by a real capture in Task 19):

```
╭──────────────────────────────────────────────────────────────────╮
│ Bash command                                                     │
│                                                                  │
│   rm -rf build                                                   │
│   Remove the stale build directory                               │
│                                                                  │
│ Do you want to proceed?                                          │
│ ❯ 1. Yes                                                         │
│   2. Yes, and don't ask again for rm commands in                 │
│      /home/dev/projects/infinite                                 │
│   3. No, and tell Claude what to do differently (esc)            │
╰──────────────────────────────────────────────────────────────────╯
```

`tests/fixtures/screens/codex-command.txt` (synthetic; replaced in Task 20):

```
Would you like to run the following command?

  npm test

› 1. Yes, proceed
  2. Yes, and don't ask again for this command in this session
  3. No, continue without running it
  4. No, and tell Codex what to do differently
```

`tests/fixtures/screens/demo-dialog.txt`:

```
Infinite · local continuity rehearsal
[2026-10-04T12:00:00.000Z] Checkpoint 1 · process still running

Bash command
  rm -rf build

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for rm commands
  3. No, and tell Claude what to do differently
```

`tests/fixtures/screens/yesno.txt`:

```
Installing 3 packages
Continue? [y/N]
```

`tests/fixtures/screens/idle-claude.txt`:

```
⏺ I added the retry wrapper and the tests pass.

╭──────────────────────────────────────────────────────────────────╮
│ >                                                                │
╰──────────────────────────────────────────────────────────────────╯
  ? for shortcuts
```

- [ ] **Step 2: Write the failing test**

`tests/attention-prompts.test.ts`:

```ts
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

test("idle and non-idle screens", () => {
  assert.equal(isIdleScreen(screen("idle-claude"), "claude"), true);
  assert.equal(isIdleScreen(screen("claude-permission"), "claude"), false);
  assert.equal(isIdleScreen(["$ "], "grok"), true);
  assert.equal(isIdleScreen(["Running tests..."], "grok"), false);
  assert.equal(detectPrompt(screen("idle-claude"), "claude"), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test tests/attention-prompts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement roles**

`packages/attention/src/roles.ts`:

```ts
import type { OptionRole } from "./types.js";

export function roleForLabel(label: string): OptionRole {
  const text = label.trim();
  if (/^Yes, and (don'?t ask again|allow|switch|grant)/i.test(text)) return "accept-always";
  if (/^Yes\b/i.test(text)) return "accept";
  if (/^No, and tell/i.test(text)) return "reject-with-feedback";
  if (/^No\b/i.test(text)) return "reject";
  return "other";
}
```

- [ ] **Step 5: Implement detection**

`packages/attention/src/prompts.ts`:

```ts
import type { PromptKind, PromptOption, Provider } from "./types.js";
import { roleForLabel } from "./roles.js";

export interface DetectedPrompt {
  kind: PromptKind;
  title: string;
  detail?: string;
  options: PromptOption[];
  highlighted?: number;
  acceptsText: boolean;
  multiSelect: boolean;
  fingerprint: string;
  blockStart: number;
  blockEnd: number;
}

const OPTION = /^([❯›>]\s*)?(\d{1,2})\.\s+(.+?)$/;
const RULE = /^[\s─━═│┃┌┐└┘├┤╭╮╰╯\-_=*·]*$/;
const PERMISSION = /do you want to (proceed|make this edit|create|run)|would you like to (run|make)|approve network access|needs your approval|permission/i;
const QUESTION_OPTION = /^(chat about this|other|skip|type something)/i;
const MULTI = /a to select all|n to select none/i;
const YES_NO = /(\[(y\/N|Y\/n|y\/n)\]|\((y\/n|yes\/no)\))\s*:?\s*$/i;

/** Strip box-drawing borders and surrounding whitespace. */
export function cleanLine(line: string): string {
  return line.replace(/^[\s│┃]+|[\s│┃]+$/g, "");
}

export function detectPrompt(lines: string[], provider: Provider): DetectedPrompt | null {
  const clean = lines.map(cleanLine);
  const block = lastOptionBlock(clean, lines);
  if (block) {
    const { start, end, options, highlighted } = block;
    const above: string[] = [];
    for (let i = start - 1; i >= 0 && above.length < 6; i--) {
      if (clean[i] === "" || RULE.test(clean[i])) continue;
      above.unshift(clean[i]);
    }
    const titleIndex = findLastIndex(above, (l) => l.endsWith("?"));
    const title = titleIndex >= 0 ? above[titleIndex] : above.at(-1) ?? "";
    const detailLines = above.filter((_, i) => i !== titleIndex && above[i] !== title);
    const detail = detailLines.length ? detailLines.join("\n").slice(0, 2000) : undefined;
    const footer = clean.slice(end + 1, end + 3).join(" ");
    const multiSelect = MULTI.test(footer);
    let kind: PromptKind = "menu";
    if (PERMISSION.test(title) || PERMISSION.test(detail ?? "")) kind = "permission";
    else if (options.some((o) => QUESTION_OPTION.test(o.label))) kind = "question";
    const acceptsText = options.some((o) => o.role === "reject-with-feedback");
    return {
      kind, title, detail, options, highlighted, acceptsText, multiSelect,
      fingerprint: [title, ...options.map((o) => o.label)].join("\n"),
      blockStart: start, blockEnd: end,
    };
  }
  const lastIndex = findLastIndex(clean, (l) => l !== "");
  if (lastIndex >= 0 && YES_NO.test(clean[lastIndex])) {
    const title = clean[lastIndex];
    return {
      kind: "yes-no", title, options: [
        { index: 0, label: "Yes", role: "accept" },
        { index: 1, label: "No", role: "reject" },
      ],
      acceptsText: true, multiSelect: false, fingerprint: title,
      blockStart: lastIndex, blockEnd: lastIndex,
    };
  }
  void provider;
  return null;
}

/**
 * Find the lowest block of consecutively numbered options. A wrapped option label continues on
 * the next line when that raw line is indented past the option number column, is not itself an
 * option, a question, or a key hint.
 */
function lastOptionBlock(clean: string[], raw: string[]) {
  const indented = raw.map((line) => /^[\s│┃]*\s{3,}\S/.test(line));
  const KEY_HINT = /^(Enter to|Esc to|Press )/i;
  let best: { start: number; end: number; options: PromptOption[]; highlighted?: number } | null = null;
  let i = 0;
  while (i < clean.length) {
    const m = OPTION.exec(clean[i]);
    if (!m || Number(m[2]) !== 1) { i++; continue; }
    const options: PromptOption[] = [];
    let highlighted: number | undefined;
    let j = i;
    let expected = 1;
    while (j < clean.length) {
      const om = OPTION.exec(clean[j]);
      if (om && Number(om[2]) === expected) {
        if (om[1]) highlighted = options.length;
        options.push({ index: options.length, label: om[3].trim(), role: "other" });
        expected++;
        j++;
      } else if (options.length && clean[j] !== "" && !om && indented[j] && !clean[j].endsWith("?") && !MULTI.test(clean[j]) && !KEY_HINT.test(clean[j])) {
        options[options.length - 1].label += " " + clean[j].trim();
        j++;
      } else break;
    }
    if (options.length >= 2) {
      for (const o of options) o.role = roleForLabel(o.label);
      best = { start: i, end: j - 1, options, highlighted };
    }
    i = Math.max(j, i + 1);
  }
  return best;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}

export function isIdleScreen(lines: string[], provider: Provider): boolean {
  const clean = lines.map(cleanLine);
  const lastIndex = findLastIndex(clean, (l) => l !== "" && !RULE.test(l) && !/^\?\s*for shortcuts/i.test(l));
  if (lastIndex < 0) return false;
  const last = clean[lastIndex];
  if (provider === "claude" || provider === "codex") return /^[>›❯]\s*$/.test(last) || /^[>›]\s\S*$/.test(last) && last.length < 4;
  return /[$%>]\s*$/.test(last);
}
```

In the `claude-permission` fixture, the wrapped path line `│      /home/dev/projects/infinite │` has six spaces after the border, so `indented` is true and it joins option 2; option 3 starts with a number and stays separate.

- [ ] **Step 6: Export and run the tests**

Add to `packages/attention/src/index.ts`: `export * from "./roles.js"; export * from "./prompts.js";`

Run: `npx tsx --test tests/attention-prompts.test.ts`
Expected: PASS, 8 tests. If the continuation test (`claude-permission` option 2) fails, adjust the `indented` helper until the wrapped path joins option 2 and option 3 stays separate.

- [ ] **Step 7: Commit**

```bash
git add packages/attention/src tests/attention-prompts.test.ts tests/fixtures
git commit -m "feat(attention): prompt detection from screen text with option roles"
```

---

### Task 3: Attention reducer

**Files:**
- Create: `packages/attention/src/attention.ts`
- Modify: `packages/attention/src/index.ts`
- Test: `tests/attention-reducer.test.ts`

**Interfaces:**
- Produces:
  - `initialAttention(at: string, hasInitialPrompt: boolean): Attention`
  - `applySignal(att: Attention, event: SignalEvent): Attention`
  - `applyLifecycle(att: Attention, status: "exited" | "unavailable" | "recording-error", at: string): Attention`
  - `screenDecision(att: Attention, detected: DetectedPrompt | null, idle: boolean, outputSinceLastCheck: boolean, at: string): ScreenDecision`
  - `mergeScreenIntoPrompt(prompt: Prompt, detected: DetectedPrompt, hash: string): Prompt`
  - `describeNow(att: Attention, provider: Provider): string`
  - `ScreenDecision = { open?: Omit<Prompt, "id" | "hash"> & { fingerprint: string }; close?: { promptId: number; reason: "vanished" }; idle?: "turn-finished" | "idle"; merge?: DetectedPrompt; working?: boolean }`

- [ ] **Step 1: Write the failing test**

`tests/attention-reducer.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialAttention, applySignal, applyLifecycle, screenDecision, describeNow, mergeScreenIntoPrompt,
} from "../packages/attention/src/attention.js";
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
  assert.equal(screenDecision(a, null, false, true, "t3").working, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/attention-reducer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/attention/src/attention.ts`:

```ts
import type { Attention, Prompt, Provider, SignalEvent } from "./types.js";
import { LOUD_TOOLS, PROVIDER_NAMES } from "./types.js";
import type { DetectedPrompt } from "./prompts.js";

const TERMINAL = new Set(["exited", "unavailable", "recording-error"]);

export interface ScreenDecision {
  open?: Omit<Prompt, "id" | "hash"> & { fingerprint: string };
  close?: { promptId: number; reason: "vanished" };
  merge?: DetectedPrompt;
  idle?: "turn-finished" | "idle";
  working?: boolean;
}

export function initialAttention(at: string, hasInitialPrompt: boolean): Attention {
  return {
    state: hasInitialPrompt ? "working" : "idle",
    since: at, source: "lifecycle", now: hasInitialPrompt ? "Starting" : "Waiting for your direction",
    lastActivityAt: at, hooks: "none", hookErrors: 0, sawTurnEnd: false,
  };
}

function enter(att: Attention, state: Attention["state"], source: Attention["source"], at: string): Attention {
  return att.state === state ? { ...att, lastActivityAt: at } : { ...att, state, since: at, source, lastActivityAt: at };
}

export function applyLifecycle(att: Attention, status: "exited" | "unavailable" | "recording-error", at: string): Attention {
  return { ...enter(att, status, "lifecycle", at), prompt: undefined, now: "" };
}

export function applySignal(att: Attention, event: SignalEvent): Attention {
  if (TERMINAL.has(att.state)) return att;
  const { data } = event;
  const at = event.at;
  let next: Attention = { ...att, lastActivityAt: at };
  if (data.source === "hook" && next.hooks === "none") next.hooks = "active";
  switch (data.kind) {
    case "hooks-ready": next.hooks = "active"; break;
    case "turn-start": next = { ...enter(next, "working", data.source === "host" ? "lifecycle" : data.source, at), prompt: undefined, lastTool: undefined }; break;
    case "tool-start":
      if (!data.quiet) next.lastTool = { tool: data.tool, summary: toolSummary(data.tool, data.input), at };
      next = enter(next, "working", data.source === "host" ? "lifecycle" : data.source, at);
      break;
    case "tool-end":
      if (next.lastTool && next.lastTool.tool === data.tool) next.lastTool = undefined;
      break;
    case "prompt-open":
      next = { ...enter(next, "needs-you", data.prompt.source, at), prompt: { ...data.prompt, id: event.seq } };
      break;
    case "prompt-closed":
      if (next.prompt?.id === data.promptId) next = { ...enter(next, "working", data.source === "host" ? "lifecycle" : data.source, at), prompt: undefined };
      break;
    case "turn-end":
      next = { ...enter(next, "turn-finished", data.source === "host" ? "lifecycle" : data.source, at), prompt: undefined, lastTool: undefined, sawTurnEnd: true };
      if (data.message) next.lastMessage = data.message;
      break;
    case "error":
      if (data.where === "hooks") next.hookErrors += 1;
      break;
    default: break;
  }
  return next;
}

export function screenDecision(att: Attention, detected: DetectedPrompt | null, idle: boolean, outputSinceLastCheck: boolean, at: string): ScreenDecision {
  void at;
  if (TERMINAL.has(att.state)) return {};
  if (detected) {
    if (att.prompt) {
      if (att.prompt.hash === undefined || att.prompt.options.length === 0) return { merge: detected };
      return {};
    }
    return {
      open: {
        kind: detected.kind, title: detected.title, detail: detected.detail, options: detected.options,
        highlighted: detected.highlighted, acceptsText: detected.acceptsText, multiSelect: detected.multiSelect,
        source: "screen", fingerprint: detected.fingerprint,
      },
    };
  }
  if (att.prompt && att.prompt.hash !== undefined) return { close: { promptId: att.prompt.id, reason: "vanished" } };
  if (idle && !att.prompt) return { idle: att.sawTurnEnd ? "turn-finished" : "idle" };
  if (outputSinceLastCheck && (att.state === "idle" || att.state === "turn-finished")) return { working: true };
  return {};
}

export function mergeScreenIntoPrompt(prompt: Prompt, detected: DetectedPrompt, hash: string): Prompt {
  return {
    ...prompt,
    kind: prompt.kind === "menu" ? detected.kind : prompt.kind,
    title: prompt.title || detected.title,
    detail: prompt.detail ?? detected.detail,
    options: detected.options,
    highlighted: detected.highlighted,
    acceptsText: detected.acceptsText,
    multiSelect: detected.multiSelect,
    hash,
  };
}

export function toolSummary(tool: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool === "Bash" || tool === "PowerShell" || tool === "apply_patch") return str(input.command).split("\n")[0].slice(0, 120);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") return basename(str(input.file_path) || str(input.notebook_path));
  if (tool === "AskUserQuestion") return "Asking you a question";
  if (tool === "Agent") return `Subagent ${str(input.subagent_type) || ""}`.trim();
  return tool;
}

function basename(path: string) { return path.split("/").filter(Boolean).at(-1) ?? path; }

export function describeNow(att: Attention, provider: Provider): string {
  const name = PROVIDER_NAMES[provider];
  let text: string;
  switch (att.state) {
    case "needs-you": {
      const p = att.prompt;
      const head = p?.detail?.split("\n").find((l) => l.trim() !== "")?.trim();
      text = p ? (head ? `${p.title} ${head}` : p.title) : `${name} needs you`;
      break;
    }
    case "working": {
      const t = att.lastTool;
      text = !t ? "Thinking" : LOUD_TOOLS.has(t.tool) && (t.tool === "Bash" || t.tool === "PowerShell" || t.tool === "apply_patch") ? `Running ${t.summary}` : /Edit|Write/.test(t.tool) ? `Editing ${t.summary}` : t.summary;
      break;
    }
    case "turn-finished": text = firstSentence(att.lastMessage) || "Finished a turn"; break;
    case "idle": text = "Waiting for your direction"; break;
    case "exited": text = "Process exited"; break;
    case "unavailable": text = "Host cannot reach this session"; break;
    case "recording-error": text = "Recording failed; process suspended"; break;
  }
  return text.length > 140 ? text.slice(0, 139) + "…" : text;
}

function firstSentence(text?: string) {
  if (!text) return "";
  const line = text.trim().split("\n").find((l) => l.trim() !== "") ?? "";
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return (m ? m[1] : line).trim();
}
```

- [ ] **Step 4: Export and run the test**

Add `export * from "./attention.js";` to `packages/attention/src/index.ts`.

Run: `npx tsx --test tests/attention-reducer.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/attention/src tests/attention-reducer.test.ts
git commit -m "feat(attention): attention reducer, screen decisions and now-line text"
```

---

### Task 4: Hook payload mapping (Claude Code, Codex) and moments

**Files:**
- Create: `packages/attention/src/claude.ts`, `packages/attention/src/codex.ts`, `packages/attention/src/truncate.ts`, `packages/attention/src/moments.ts`
- Modify: `packages/attention/src/index.ts`
- Test: `tests/attention-hooks.test.ts`, `tests/attention-moments.test.ts`

**Interfaces:**
- Produces:
  - `mapClaudeHook(body: unknown): Signal[]` (pure; the worker adds `source`/`provider`/`agent`)
  - `claudeAgent(body: unknown): { id: string; type: string } | undefined`
  - `mapCodexHook(body: unknown): Signal[]`, `mapCodexNotify(body: unknown): Signal[]`, `mapCodexOsc(text: string): Signal[]`
  - `truncateInput(input: Record<string, unknown>): Record<string, unknown>`, `cut(text: string, max: number): string`
  - `deriveMoments(events: SignalEvent[]): Moment[]` newest first, `Moment` type below.

- [ ] **Step 1: Write the failing hook-mapping test**

`tests/attention-hooks.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mapClaudeHook, claudeAgent } from "../packages/attention/src/claude.js";
import { mapCodexHook, mapCodexNotify, mapCodexOsc } from "../packages/attention/src/codex.js";
import { cut, truncateInput } from "../packages/attention/src/truncate.js";

const base = { session_id: "s", transcript_path: "/t", cwd: "/w", permission_mode: "default" };

test("claude PreToolUse becomes tool-start with destructive flag and quiet marking", () => {
  const [bash] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1" });
  assert.equal(bash.kind, "tool-start");
  if (bash.kind !== "tool-start") throw new Error();
  assert.equal(bash.quiet, false);
  assert.equal(bash.toolUseId, "t1");
  assert.deepEqual(bash.destructive, { pattern: "rm-recursive-force" });
  const [read] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/w/a.ts" } });
  assert.equal(read.kind === "tool-start" && read.quiet, true);
  const [ask] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] } });
  assert.equal(ask.kind, "tool-start");
  const open = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] } })[1];
  assert.equal(open.kind, "prompt-open");
  if (open.kind !== "prompt-open") throw new Error();
  assert.equal(open.prompt.kind, "question");
  assert.equal(open.prompt.title, "Which DB?");
  assert.equal(open.prompt.options.length, 0); // options come from the screen
  assert.equal(open.prompt.multiSelect, false);
});

test("claude PermissionRequest, PostToolUse, Stop, Notification", () => {
  const [perm] = mapClaudeHook({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push --force" }, permission_suggestions: [] });
  assert.equal(perm.kind, "prompt-open");
  if (perm.kind !== "prompt-open") throw new Error();
  assert.equal(perm.prompt.kind, "permission");
  assert.equal(perm.prompt.detail, "git push --force");
  assert.deepEqual(perm.prompt.destructive, { pattern: "git-push-force" });
  assert.equal(perm.prompt.source, "hook");
  const [end] = mapClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", exitCode: 0, bashEditDiff: { changedFiles: ["/w/a.ts"] } }, tool_use_id: "t2", duration_ms: 1200 });
  assert.equal(end.kind, "tool-end");
  if (end.kind !== "tool-end") throw new Error();
  assert.equal(end.ok, true);
  assert.equal(end.durationMs, 1200);
  assert.deepEqual(end.files, ["/w/a.ts"]);
  const [fail] = mapClaudeHook({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, error: "exit 1" });
  assert.equal(fail.kind === "tool-end" && fail.ok, false);
  const [stop] = mapClaudeHook({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "x".repeat(5000), background_tasks: [{ id: "a" }] });
  assert.equal(stop.kind, "turn-end");
  if (stop.kind !== "turn-end") throw new Error();
  assert.equal(stop.message?.length, 4000 + " … [+1000 chars]".length);
  assert.equal(stop.backgroundTasks, 1);
  const [notice, prompt] = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
  assert.equal(notice.kind, "notice");
  assert.equal(prompt.kind, "prompt-open");
  const [idle] = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt", message: "" });
  assert.equal(idle.kind, "notice");
  assert.equal(mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt" }).length, 1);
  const [turn] = mapClaudeHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "add docs" });
  assert.equal(turn.kind === "turn-start" && turn.prompt, "add docs");
  assert.deepEqual(claudeAgent({ ...base, agent_id: "a1", agent_type: "Explore" }), { id: "a1", type: "Explore" });
  assert.equal(mapClaudeHook({ nonsense: true }).length, 0);
});

test("codex hooks, notify and osc", () => {
  const [perm] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist" }, tool_use_id: "c1" });
  assert.equal(perm.kind, "prompt-open");
  if (perm.kind !== "prompt-open") throw new Error();
  assert.deepEqual(perm.prompt.destructive, { pattern: "rm-recursive-force" });
  const [stop] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "Stop", last_assistant_message: "Renamed." });
  assert.equal(stop.kind === "turn-end" && stop.message, "Renamed.");
  const [notify] = mapCodexNotify({ type: "agent-turn-complete", "thread-id": "t", "turn-id": "1", cwd: "/w", "input-messages": ["x"], "last-assistant-message": "Rename complete" });
  assert.equal(notify.kind === "turn-end" && notify.message, "Rename complete");
  const osc = mapCodexOsc("Codex: approval requested");
  assert.equal(osc[0].kind, "notice");
  assert.equal(osc[1]?.kind, "prompt-open");
  assert.equal(mapCodexOsc("Codex: turn complete")[0].kind, "notice");
});

test("truncation rules", () => {
  assert.equal(cut("abc", 2), "ab … [+1 chars]");
  const out = truncateInput({ command: "x".repeat(5000), content: "y".repeat(3000), nested: { deep: "z".repeat(5000) }, n: 1 });
  assert.equal((out.command as string).length, 4000 + " … [+1000 chars]".length);
  assert.equal((out.content as string).length, 2000 + " … [+1000 chars]".length);
  assert.equal(((out.nested as Record<string, unknown>).deep as string).length, 4000 + " … [+1000 chars]".length);
  assert.equal(out.n, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/attention-hooks.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement truncation**

`packages/attention/src/truncate.ts`:

```ts
const SHORT_FIELDS = new Set(["content", "old_string", "new_string"]);

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} … [+${text.length - max} chars]`;
}

export function truncateInput(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = cut(value, SHORT_FIELDS.has(key) ? 2000 : 4000);
    else if (Array.isArray(value)) out[key] = value.slice(0, 50).map((v) => (typeof v === "string" ? cut(v, 4000) : typeof v === "object" && v && depth < 3 ? truncateInput(v as Record<string, unknown>, depth + 1) : v));
    else if (value && typeof value === "object" && depth < 3) out[key] = truncateInput(value as Record<string, unknown>, depth + 1);
    else out[key] = value;
  }
  let serialized = JSON.stringify(out);
  if (serialized.length > 16 * 1024) {
    // Drop the largest string fields until the record fits.
    const entries = Object.entries(out).filter(([, v]) => typeof v === "string").sort((a, b) => (b[1] as string).length - (a[1] as string).length);
    for (const [key] of entries) {
      out[key] = cut(out[key] as string, 500);
      serialized = JSON.stringify(out);
      if (serialized.length <= 16 * 1024) break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement Claude mapping**

`packages/attention/src/claude.ts`:

```ts
import type { Prompt, Signal } from "./types.js";
import { LOUD_TOOLS } from "./types.js";
import { matchDestructive } from "./destructive.js";
import { cut, truncateInput } from "./truncate.js";

type Body = Record<string, unknown>;
const str = (v: unknown, max = 4000) => (typeof v === "string" ? cut(v, max) : undefined);
const obj = (v: unknown): Body => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {});

export function claudeAgent(body: unknown): { id: string; type: string } | undefined {
  const b = obj(body);
  return typeof b.agent_id === "string" ? { id: b.agent_id, type: typeof b.agent_type === "string" ? b.agent_type : "" } : undefined;
}

function isQuiet(tool: string) {
  return !LOUD_TOOLS.has(tool);
}

function commandOf(tool: string, input: Body): string | undefined {
  if (tool === "Bash" || tool === "PowerShell") return str(input.command, 2000);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return str(input.file_path, 500);
  if (tool === "NotebookEdit") return str(input.notebook_path, 500);
  return undefined;
}

function hookPrompt(kind: Prompt["kind"], title: string, tool: string | undefined, input: Body, detail?: string): Omit<Prompt, "id"> {
  const command = tool === "Bash" || tool === "PowerShell" ? str(input.command, 2000) : undefined;
  return {
    kind, title, detail: detail ?? commandOf(tool ?? "", input), options: [], acceptsText: false, source: "hook",
    tool: tool ? { name: tool, input: truncateInput(input) } : undefined,
    destructive: command && matchDestructive(command) ? { pattern: matchDestructive(command)! } : undefined,
  };
}

export function mapClaudeHook(body: unknown): Signal[] {
  const b = obj(body);
  const event = b.hook_event_name;
  if (typeof event !== "string") return [];
  const tool = typeof b.tool_name === "string" ? b.tool_name : undefined;
  const input = obj(b.tool_input);
  const toolUseId = str(b.tool_use_id, 100);
  switch (event) {
    case "UserPromptSubmit": return [{ kind: "turn-start", prompt: str(b.prompt, 500) }];
    case "PreToolUse": {
      if (!tool) return [];
      const command = commandOf(tool, input);
      const out: Signal[] = [{
        kind: "tool-start", tool, toolUseId, input: truncateInput(input), quiet: isQuiet(tool),
        destructive: (tool === "Bash" || tool === "PowerShell") && command && matchDestructive(command) ? { pattern: matchDestructive(command)! } : undefined,
      }];
      if (tool === "AskUserQuestion") {
        const questions = Array.isArray(input.questions) ? (input.questions as Body[]) : [];
        const first = questions[0] ?? {};
        out.push({ kind: "prompt-open", prompt: { ...hookPrompt("question", str(first.question, 500) ?? "Question", tool, input), multiSelect: first.multiSelect === true, acceptsText: false } as Prompt });
      }
      return out;
    }
    case "PostToolUse": {
      if (!tool) return [];
      const response = obj(b.tool_response);
      const diff = obj(response.bashEditDiff);
      const files = Array.isArray(diff.changedFiles) ? (diff.changedFiles as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 50) : undefined;
      const exit = typeof response.exitCode === "number" ? response.exitCode : undefined;
      return [{
        kind: "tool-end", tool, toolUseId, ok: exit === undefined ? true : exit === 0,
        durationMs: typeof b.duration_ms === "number" ? b.duration_ms : undefined,
        summary: exit !== undefined ? `exit ${exit}` : typeof response.type === "string" ? response.type : undefined,
        files,
      }];
    }
    case "PostToolUseFailure": return tool ? [{ kind: "tool-end", tool, toolUseId, ok: false, error: str(b.error, 1000) ?? "failed" }] : [];
    case "PermissionRequest": return [{ kind: "prompt-open", prompt: hookPrompt("permission", "Permission needed", tool, input) as Prompt }];
    case "PermissionDenied": return [{ kind: "notice", type: "permission_denied", message: str(b.reason, 500) }];
    case "Elicitation": return [{ kind: "prompt-open", prompt: hookPrompt("elicitation", str(b.message, 500) ?? "Input requested", undefined, {}, str(b.mcp_server_name, 100)) as Prompt }];
    case "Notification": {
      const type = str(b.notification_type, 60) ?? "unknown";
      const out: Signal[] = [{ kind: "notice", type, message: str(b.message, 500), title: str(b.title, 100) }];
      if (type === "permission_prompt") out.push({ kind: "prompt-open", prompt: hookPrompt("permission", str(b.message, 200) ?? "Permission needed", undefined, {}) as Prompt });
      if (type === "elicitation_dialog" || type === "elicitation_url_dialog") out.push({ kind: "prompt-open", prompt: hookPrompt("elicitation", str(b.message, 200) ?? "Input requested", undefined, {}) as Prompt });
      return out;
    }
    case "Stop": {
      const tasks = Array.isArray(b.background_tasks) ? b.background_tasks.length : 0;
      return [{ kind: "turn-end", message: str(b.last_assistant_message, 4000), backgroundTasks: tasks, stopHookActive: b.stop_hook_active === true }];
    }
    case "StopFailure": return [
      { kind: "error", message: str(b.error, 1000) ?? "The provider reported a failure", where: "provider" },
      { kind: "turn-end", backgroundTasks: 0, failed: true },
    ];
    case "SessionEnd": return [{ kind: "notice", type: "session_end", message: str(b.reason, 100) }];
    default: return [];
  }
}
```

- [ ] **Step 5: Implement Codex mapping**

`packages/attention/src/codex.ts`:

```ts
import type { Prompt, Signal } from "./types.js";
import { LOUD_TOOLS } from "./types.js";
import { matchDestructive } from "./destructive.js";
import { cut, truncateInput } from "./truncate.js";

type Body = Record<string, unknown>;
const str = (v: unknown, max = 4000) => (typeof v === "string" ? cut(v, max) : undefined);
const obj = (v: unknown): Body => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {});

function prompt(kind: Prompt["kind"], title: string, tool: string | undefined, input: Body): Prompt {
  const command = str(input.command, 2000);
  const pattern = command ? matchDestructive(command) : null;
  return {
    id: 0, kind, title, detail: command, options: [], acceptsText: false, source: "hook",
    tool: tool ? { name: tool, input: truncateInput(input) } : undefined,
    destructive: pattern ? { pattern } : undefined,
  };
}

export function mapCodexHook(body: unknown): Signal[] {
  const b = obj(body);
  const event = b.hook_event_name;
  if (typeof event !== "string") return [];
  const tool = typeof b.tool_name === "string" ? b.tool_name : undefined;
  const input = obj(b.tool_input);
  const toolUseId = str(b.tool_use_id, 100);
  switch (event) {
    case "SessionStart": return [{ kind: "notice", type: "session_start", message: str(b.source, 50) }];
    case "UserPromptSubmit": return [{ kind: "turn-start", prompt: str(b.prompt, 500) }];
    case "PreToolUse": {
      if (!tool) return [];
      const command = str(input.command, 2000);
      const pattern = command ? matchDestructive(command) : null;
      return [{ kind: "tool-start", tool, toolUseId, input: truncateInput(input), quiet: !LOUD_TOOLS.has(tool) && tool !== "Bash", destructive: pattern ? { pattern } : undefined }];
    }
    case "PostToolUse": {
      if (!tool) return [];
      const response = obj(b.tool_response);
      const exit = typeof response.exit_code === "number" ? response.exit_code : typeof response.exitCode === "number" ? response.exitCode : undefined;
      return [{ kind: "tool-end", tool, toolUseId, ok: exit === undefined ? true : exit === 0, summary: exit !== undefined ? `exit ${exit}` : undefined }];
    }
    case "PermissionRequest": return [{ kind: "prompt-open", prompt: prompt("permission", "Approval needed", tool, input) }];
    case "Stop": return [{ kind: "turn-end", message: str(b.last_assistant_message, 4000), backgroundTasks: 0, stopHookActive: b.stop_hook_active === true }];
    case "Interrupt": return [{ kind: "notice", type: "interrupt" }];
    case "SessionEnd": return [{ kind: "notice", type: "session_end" }];
    default: return [];
  }
}

export function mapCodexNotify(body: unknown): Signal[] {
  const b = obj(body);
  if (b.type !== "agent-turn-complete") return [];
  return [{ kind: "turn-end", message: str(b["last-assistant-message"], 4000), backgroundTasks: 0 }];
}

/** OSC 9 notification text emitted by the Codex TUI. The exact wording is captured in Task 20. */
export function mapCodexOsc(text: string): Signal[] {
  const t = text.trim();
  const out: Signal[] = [{ kind: "notice", type: "osc", message: cut(t, 500) }];
  if (/approval/i.test(t)) out.push({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Approval needed", options: [], acceptsText: false, source: "osc" } });
  else if (/question|input/i.test(t)) out.push({ kind: "prompt-open", prompt: { id: 0, kind: "question", title: cut(t, 200), options: [], acceptsText: false, source: "osc" } });
  else if (/turn complete|complete/i.test(t)) out.push({ kind: "turn-end", backgroundTasks: 0 });
  return out;
}
```

- [ ] **Step 6: Run the hook test**

Run: `npx tsx --test tests/attention-hooks.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write the failing moments test**

`tests/attention-moments.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { deriveMoments } from "../packages/attention/src/moments.js";
import type { SignalEvent, SignalData } from "../packages/attention/src/types.js";

let seq = 0;
const ev = (data: Partial<SignalData> & { kind: SignalData["kind"] }, at = "2026-10-04T12:00:00.000Z"): SignalEvent =>
  ({ seq: ++seq, at, type: "signal", data: { source: "hook", provider: "claude", ...data } as SignalData });

test("pairs tools, collapses quiet tools and edits, shows decisions and turns", () => {
  const events: SignalEvent[] = [
    ev({ kind: "turn-start", prompt: "add retries" }),
    ev({ kind: "tool-start", tool: "Read", input: { file_path: "/w/a.ts" }, quiet: true }),
    ev({ kind: "tool-end", tool: "Read", ok: true }),
    ev({ kind: "tool-start", tool: "Grep", input: {}, quiet: true }),
    ev({ kind: "tool-start", tool: "Bash", toolUseId: "t1", input: { command: "rm -rf build" }, quiet: false, destructive: { pattern: "rm-recursive-force" } }),
    ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Do you want to proceed?", detail: "rm -rf build", options: [{ index: 0, label: "Yes", role: "accept" }], acceptsText: false, source: "hook" } }),
    ev({ kind: "answer", promptId: 6, requestId: "r", option: { index: 0, label: "Yes" }, text: false, result: "closed", source: "host" }),
    ev({ kind: "prompt-closed", promptId: 6, reason: "answered-here", label: "Yes", source: "host" }),
    ev({ kind: "tool-end", tool: "Bash", toolUseId: "t1", ok: true, durationMs: 300, summary: "exit 0" }),
    ev({ kind: "tool-start", tool: "Edit", toolUseId: "t2", input: { file_path: "/w/src/app.ts", old_string: "a", new_string: "b" }, quiet: false }),
    ev({ kind: "tool-end", tool: "Edit", toolUseId: "t2", ok: true }),
    ev({ kind: "tool-start", tool: "Edit", toolUseId: "t3", input: { file_path: "/w/src/app.ts", old_string: "c", new_string: "d" }, quiet: false }),
    ev({ kind: "tool-end", tool: "Edit", toolUseId: "t3", ok: true }),
    ev({ kind: "turn-end", message: "Added retries.", backgroundTasks: 0 }),
  ];
  const moments = deriveMoments(events);
  const kinds = moments.map((m) => `${m.kind}:${m.title}`);
  assert.deepEqual(kinds, [
    "turn:Added retries.",
    "edit:app.ts",
    "command:rm -rf build",
    "decision:Do you want to proceed?",
    "quiet:Read 1 file, searched 1 time",
    "turn:add retries",
  ]);
  const edit = moments.find((m) => m.kind === "edit")!;
  assert.equal(edit.count, 2);
  const command = moments.find((m) => m.kind === "command")!;
  assert.equal(command.status, "ok");
  assert.equal(command.destructive, "rm-recursive-force");
  assert.match(command.detail ?? "", /exit 0/);
  const decision = moments.find((m) => m.kind === "decision")!;
  assert.equal(decision.detail, "Yes · answered from this device");
});

test("a running command without an end is marked running", () => {
  const moments = deriveMoments([ev({ kind: "tool-start", tool: "Bash", toolUseId: "x", input: { command: "npm test" }, quiet: false })]);
  assert.equal(moments[0].status, "running");
});
```

- [ ] **Step 8: Implement moments**

`packages/attention/src/moments.ts`:

```ts
import type { SignalEvent, SignalSource } from "./types.js";

export interface Moment {
  id: string;
  at: string;
  kind: "command" | "edit" | "quiet" | "decision" | "turn" | "notice";
  title: string;
  detail?: string;
  destructive?: string;
  status?: "running" | "ok" | "failed";
  count?: number;
  source: SignalSource;
  expanded: { label: string; text: string }[];
}

const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Oldest-in, newest-first out. */
export function deriveMoments(events: SignalEvent[]): Moment[] {
  const out: Moment[] = [];
  const openTools = new Map<string, Moment>();
  const openByName = new Map<string, Moment>();
  let quiet: { reads: number; searches: number; other: number; moment?: Moment } = { reads: 0, searches: 0, other: 0 };
  let lastEdit: Moment | undefined;
  const prompts = new Map<number, Moment>();

  const flushQuiet = () => { quiet = { reads: 0, searches: 0, other: 0 }; };
  const quietTitle = () => {
    const parts: string[] = [];
    if (quiet.reads) parts.push(`Read ${quiet.reads} file${quiet.reads === 1 ? "" : "s"}`);
    if (quiet.searches) parts.push(`searched ${quiet.searches} time${quiet.searches === 1 ? "" : "s"}`);
    if (quiet.other) parts.push(`${quiet.other} other tool call${quiet.other === 1 ? "" : "s"}`);
    return parts.join(", ");
  };

  for (const e of events) {
    const d = e.data;
    const id = String(e.seq);
    switch (d.kind) {
      case "turn-start":
        flushQuiet(); lastEdit = undefined;
        out.push({ id, at: e.at, kind: "turn", title: d.prompt ?? "New turn", source: d.source, expanded: d.prompt ? [{ label: "Request", text: d.prompt }] : [] });
        break;
      case "turn-end":
        flushQuiet(); lastEdit = undefined;
        out.push({ id, at: e.at, kind: "turn", title: d.failed ? "Turn failed" : d.message?.split("\n").find((l) => l.trim())?.trim() ?? "Finished a turn", source: d.source, status: d.failed ? "failed" : undefined, expanded: d.message ? [{ label: "Message", text: d.message }] : [] });
        break;
      case "tool-start": {
        if (d.quiet) {
          if (d.tool === "Read") quiet.reads++; else if (d.tool === "Grep" || d.tool === "Glob" || d.tool === "WebSearch") quiet.searches++; else quiet.other++;
          if (!quiet.moment) { quiet.moment = { id, at: e.at, kind: "quiet", title: "", source: d.source, expanded: [] }; out.push(quiet.moment); }
          quiet.moment.title = quietTitle();
          break;
        }
        const isEdit = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(d.tool);
        const path = s(d.input.file_path) || s(d.input.notebook_path);
        if (isEdit && lastEdit && lastEdit.detail === path) {
          lastEdit.count = (lastEdit.count ?? 1) + 1;
          lastEdit.expanded.push(editExpansion(d.tool, d.input));
          openTools.set(d.toolUseId ?? id, lastEdit);
          break;
        }
        const m: Moment = isEdit
          ? { id, at: e.at, kind: "edit", title: basename(path) || d.tool, detail: path, status: "running", count: 1, source: d.source, expanded: [editExpansion(d.tool, d.input)] }
          : { id, at: e.at, kind: "command", title: d.tool === "Bash" || d.tool === "PowerShell" ? s(d.input.command).split("\n")[0].slice(0, 200) : d.tool === "AskUserQuestion" ? "Asked a question" : d.tool, destructive: d.destructive?.pattern, status: "running", source: d.source, expanded: [{ label: "Input", text: JSON.stringify(d.input, null, 2) }] };
        if (isEdit) lastEdit = m;
        out.push(m);
        openTools.set(d.toolUseId ?? id, m);
        openByName.set(d.tool, m);
        break;
      }
      case "tool-end": {
        const m = (d.toolUseId && openTools.get(d.toolUseId)) || openByName.get(d.tool);
        if (!m) break;
        m.status = d.ok ? "ok" : "failed";
        const bits = [d.summary, d.durationMs !== undefined ? `${(d.durationMs / 1000).toFixed(1)}s` : undefined, d.error].filter(Boolean);
        if (m.kind === "command" && bits.length) m.detail = bits.join(" · ");
        if (d.files?.length) m.expanded.push({ label: "Changed files", text: d.files.join("\n") });
        if (d.error) m.expanded.push({ label: "Error", text: d.error });
        if (d.toolUseId) openTools.delete(d.toolUseId);
        openByName.delete(d.tool);
        break;
      }
      case "prompt-open": {
        const m: Moment = { id, at: e.at, kind: "decision", title: d.prompt.title, detail: "Waiting", destructive: d.prompt.destructive?.pattern, source: d.source, expanded: d.prompt.detail ? [{ label: "Detail", text: d.prompt.detail }] : [] };
        prompts.set(e.seq, m);
        out.push(m);
        break;
      }
      case "answer": {
        const m = prompts.get(d.promptId);
        if (m) m.detail = `${d.option?.label ?? (d.text ? "Replied with text" : "Answered")} · answered from this device${d.result === "closed" ? "" : ` (${d.result})`}`;
        break;
      }
      case "prompt-closed": {
        const m = prompts.get(d.promptId);
        if (m && (m.detail === "Waiting" || !m.detail)) m.detail = d.reason === "vanished" ? `${d.label ?? "Answered"} elsewhere` : d.reason === "superseded" ? "Replaced by another prompt" : d.label ?? "Resolved";
        break;
      }
      case "error":
        out.push({ id, at: e.at, kind: "notice", title: d.message.split("\n")[0].slice(0, 200), status: "failed", source: d.source, expanded: [{ label: "Error", text: d.message }] });
        break;
      case "notice":
        if (d.type === "session_end" || d.type === "auth_success" || d.type === "permission_denied")
          out.push({ id, at: e.at, kind: "notice", title: d.title ?? d.type.replace(/_/g, " "), detail: d.message, source: d.source, expanded: [] });
        break;
      default: break;
    }
  }
  return out.reverse();
}

function editExpansion(tool: string, input: Record<string, unknown>) {
  if (tool === "Edit") return { label: "Edit", text: `- ${s(input.old_string)}\n+ ${s(input.new_string)}` };
  if (tool === "Write") return { label: "Write", text: `wrote ${s(input.content).length} chars` };
  return { label: tool, text: JSON.stringify(input, null, 2) };
}
```

- [ ] **Step 9: Export, run all attention tests**

Add to `packages/attention/src/index.ts`: `export * from "./truncate.js"; export * from "./claude.js"; export * from "./codex.js"; export * from "./moments.js";`

Run: `npx tsx --test tests/attention-*.test.ts && npm run build -w @infinite/attention`
Expected: all PASS; build clean.

- [ ] **Step 10: Commit**

```bash
git add packages/attention/src tests/attention-hooks.test.ts tests/attention-moments.test.ts
git commit -m "feat(attention): hook payload mapping for Claude Code and Codex, moment derivation"
```

---

### Task 5: Journal `signal` type and the events `types` filter

**Files:**
- Modify: `packages/host/src/types.ts`, `packages/host/src/vault.ts:123-160`, `packages/host/src/manager.ts` (`events`), `packages/host/src/server.ts` (events route)
- Test: `tests/vault.test.ts` (extend)

**Interfaces:**
- Produces: `Event.type` includes `"signal"`; `readEvents(directory, key, sessionId, after, limit, types?: Set<string>)`; `Manager.events(id, after, limit, types?)`; `GET /api/sessions/:id/events?types=signal,lifecycle`.
- `WorkerRequest` gains `{ op: "answer"; requestId: string; promptId: number; option?: number; text?: string }`; `WorkerState` gains `attention: Attention`.

- [ ] **Step 1: Write the failing test**

Append to `tests/vault.test.ts`:

```ts
import { Journal, readEvents } from "../packages/host/src/vault.js";

test("readEvents filters by type while advancing the cursor past skipped records", () => {
  const dir = mkdtempSync("/tmp/inf-vault-");
  const key = randomBytes(32);
  const journal = new Journal(join(dir, "events"), key, "s1");
  journal.append("output", { text: "a" });
  journal.append("signal", { kind: "turn-start", source: "hook", provider: "demo" });
  journal.append("output", { text: "b" });
  journal.append("lifecycle", { status: "exited" });
  const page = readEvents(join(dir, "events"), key, "s1", 0, 10, new Set(["signal", "lifecycle"]));
  assert.deepEqual(page.events.map((e) => e.seq), [2, 4]);
  assert.equal(page.cursor, 4);
  assert.equal(page.more, false);
  const first = readEvents(join(dir, "events"), key, "s1", 0, 1, new Set(["signal", "lifecycle"]));
  assert.deepEqual(first.events.map((e) => e.seq), [2]);
  assert.equal(first.cursor, 2);
  assert.equal(first.more, true);
  const rest = readEvents(join(dir, "events"), key, "s1", first.cursor, 10, new Set(["signal", "lifecycle"]));
  assert.deepEqual(rest.events.map((e) => e.seq), [4]);
  rmSync(dir, { recursive: true, force: true });
});
```

(Add `mkdtempSync`, `rmSync`, `join`, `randomBytes` imports if the file does not already import them.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/vault.test.ts`
Expected: FAIL: the `signal` type is rejected by TypeScript at `journal.append`, or the filter argument is ignored and seq 1 appears.

- [ ] **Step 3: Implement**

`packages/host/src/types.ts`: change the `Event` interface and add to `WorkerRequest`/`WorkerState`:

```ts
import type { Attention } from "@infinite/attention";

export interface Event {
  seq: number;
  at: string;
  type: "output" | "lifecycle" | "input-intent" | "input-result" | "signal";
  data: Record<string, unknown>;
}
export interface WorkerState {
  status: Status;
  pid?: number;
  exitCode?: number;
  seq: number;
  screen: string;
  attention: Attention;
}
export type WorkerRequest =
  | { op: "state"; screen?: boolean }
  | { op: "input"; requestId: string; text: string; submit: boolean }
  | { op: "raw"; requestId: string; text: string }
  | { op: "key"; requestId: string; key: "interrupt" | "enter" | "escape" | "up" | "down" | "tab" }
  | { op: "answer"; requestId: string; promptId: number; option?: number; text?: string }
  | { op: "resize"; cols: number; rows: number }
  | { op: "stop"; requestId: string };
```

`packages/host/src/vault.ts` `readEvents`: add the `types?: Set<string>` parameter; track `scanned` as the last seq decrypted; skip non-matching events after decrypting; return `cursor: scanned` in both exits. Replace the function body with:

```ts
export function readEvents(
  directory: string, key: Buffer, sessionId: string, after = 0, limit = 200, types?: Set<string>,
): { events: Event[]; cursor: number; more: boolean } {
  const events: Event[] = [];
  let segment = Math.floor(after / SEGMENT_SIZE);
  let totalBytes = 0;
  let scanned = after;
  for (;;) {
    const file = join(directory, `${String(segment).padStart(10, "0")}.journal`);
    if (!existsSync(file)) break;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const seq = segment * SEGMENT_SIZE + i + 1;
      if (seq <= after) continue;
      if (events.length >= limit || totalBytes >= 512 * 1024)
        return { events, cursor: scanned, more: true };
      const event = unseal<Event>(key, `${sessionId}:${seq}`, lines[i]);
      if (event.seq !== seq) throw new Error("Journal sequence mismatch");
      scanned = seq;
      totalBytes += lines[i].length;
      if (types && !types.has(event.type)) continue;
      events.push(event);
    }
    if (lines.length < SEGMENT_SIZE) break;
    segment++;
  }
  return { events, cursor: scanned, more: false };
}
```

`packages/host/src/manager.ts`: `events(id, after, limit, types?: Set<string>)` passes `types` through.

`packages/host/src/server.ts` events route: parse `types`:

```ts
const types = typeof req.query.types === "string"
  ? new Set(z.array(z.enum(["output", "lifecycle", "input-intent", "input-result", "signal"])).min(1).max(5).parse(req.query.types.split(",")))
  : undefined;
res.json(manager.events(id.parse(req.params.id), after, limit, types));
```

`worker.ts` will not compile until Task 8 adds `attention` to its state; to keep this task green, add `attention: initialAttention(new Date().toISOString(), Boolean(session.initialPrompt))` to the worker's initial `state` object now, importing `initialAttention` from `@infinite/attention`, and spread `attention` into the `status.sealed` write (it already spreads `state`). `manager.ts` `state()` fallback objects must also carry `attention`: use `initialAttention(new Date().toISOString(), false)` with `state: "unavailable"` applied through `applyLifecycle`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm run typecheck && npx tsx --test tests/vault.test.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src tests/vault.test.ts
git commit -m "feat(host): signal journal type, typed events filter, attention in worker state"
```

---

### Task 6: Hook listener, launch injection and the Codex relay

**Files:**
- Create: `packages/host/src/hooks.ts`, `packages/host/src/launch.ts`, `packages/host/src/hook-relay.ts`
- Test: `tests/host-hooks.test.ts`, `tests/host-launch.test.ts`

**Interfaces:**
- Produces:
  - `startHookServer(opts: { token: string; onPayload: (route: "claude" | "codex" | "codex-notify", body: unknown) => void; onError: () => void }): Promise<{ port: number; url: string; close: () => void }>`
  - `buildLaunch(provider: Provider, profile: AgentProfile, prompt: string, hooks: { url: string; token: string } | null, relayPath: string, enabled: { claude: boolean; codex: boolean }): AgentProfile`
  - `hook-relay.js <route>`: reads stdin JSON (or `argv[3]` for `codex-notify`) and POSTs it to `$INFINITE_HOOK_URL/<route>` with `Authorization: Bearer $INFINITE_HOOK_TOKEN`; exits 0 within 2 s.

- [ ] **Step 1: Write the failing hook-server test**

`tests/host-hooks.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { startHookServer } from "../packages/host/src/hooks.js";

test("hook server accepts authenticated JSON and rejects the rest", async () => {
  const received: { route: string; body: unknown }[] = [];
  let errors = 0;
  const server = await startHookServer({ token: "secret", onPayload: (route, body) => received.push({ route, body }), onError: () => errors++ });
  const post = (path: string, body: string, auth?: string) =>
    fetch(`${server.url}${path}`, { method: "POST", body, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) } });
  let r = await post("/claude", JSON.stringify({ hook_event_name: "Stop" }), "Bearer secret");
  assert.equal(r.status, 204);
  r = await post("/codex", JSON.stringify({ hook_event_name: "Stop" }), "Bearer wrong");
  assert.equal(r.status, 401);
  r = await post("/claude", "not json", "Bearer secret");
  assert.equal(r.status, 400);
  r = await post("/elsewhere", "{}", "Bearer secret");
  assert.equal(r.status, 404);
  r = await post("/claude", JSON.stringify({ big: "x".repeat(300 * 1024) }), "Bearer secret");
  assert.equal(r.status, 413);
  assert.deepEqual(received, [{ route: "claude", body: { hook_event_name: "Stop" } }]);
  assert.equal(errors, 3);
  server.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/host-hooks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the hook server**

`packages/host/src/hooks.ts`:

```ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export type HookRoute = "claude" | "codex" | "codex-notify";
const ROUTES = new Set<string>(["claude", "codex", "codex-notify"]);

export function startHookServer(opts: {
  token: string;
  onPayload: (route: HookRoute, body: unknown) => void;
  onError: () => void;
}): Promise<{ port: number; url: string; close: () => void }> {
  const expected = Buffer.from(opts.token);
  const server = createServer((req, res) => {
    const route = (req.url ?? "").replace(/^\/hook\//, "").replace(/^\//, "");
    if (req.method !== "POST" || !ROUTES.has(route)) { res.writeHead(404).end(); return; }
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) { opts.onError(); res.writeHead(401).end(); return; }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024 && !tooBig) { tooBig = true; opts.onError(); res.writeHead(413).end(); req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        res.writeHead(204).end();
        opts.onPayload(route as HookRoute, parsed);
      } catch {
        opts.onError();
        res.writeHead(400).end();
      }
    });
    req.on("error", () => {});
  });
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, url: `http://127.0.0.1:${port}/hook`, close: () => server.close() });
    });
  });
}
```

- [ ] **Step 4: Run the hook-server test**

Run: `npx tsx --test tests/host-hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing launch test**

`tests/host-launch.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunch } from "../packages/host/src/launch.js";

const hooks = { url: "http://127.0.0.1:4321/hook", token: "tok" };
const relay = "/opt/infinite/packages/host/dist/hook-relay.js";
const enabled = { claude: true, codex: true };

test("claude gets --settings with http hooks before the prompt", () => {
  const launch = buildLaunch("claude", { command: "claude", args: ["--model", "opus"] }, "do it", hooks, relay, enabled);
  assert.equal(launch.command, "claude");
  assert.equal(launch.args[0], "--model");
  const i = launch.args.indexOf("--settings");
  assert.ok(i > 0);
  const settings = JSON.parse(launch.args[i + 1]);
  const events = Object.keys(settings.hooks).sort();
  assert.deepEqual(events, ["Elicitation", "Notification", "PermissionDenied", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "Stop", "StopFailure", "UserPromptSubmit"]);
  const handler = settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(handler.type, "http");
  assert.equal(handler.url, "http://127.0.0.1:4321/hook/claude");
  assert.equal(handler.headers.Authorization, "Bearer $INFINITE_HOOK_TOKEN");
  assert.deepEqual(handler.allowedEnvVars, ["INFINITE_HOOK_TOKEN"]);
  assert.equal(handler.timeout, 5);
  assert.equal(launch.args.at(-1), "do it");
});

test("codex gets -c hook overrides, notify, osc notifications and trust bypass", () => {
  const launch = buildLaunch("codex", { command: "codex", args: [] }, "do it", hooks, relay, enabled);
  const joined = launch.args.join(" ");
  assert.match(joined, /--dangerously-bypass-hook-trust/);
  assert.match(joined, /-c hooks\.PermissionRequest=\[\{hooks=\[\{type="command",command="node \/opt\/infinite\/packages\/host\/dist\/hook-relay\.js codex"\}\]\}\]/);
  assert.match(joined, /-c notify=\["node","\/opt\/infinite\/packages\/host\/dist\/hook-relay\.js","codex-notify"\]/);
  assert.match(joined, /-c tui\.notifications=\["agent-turn-complete","approval-requested","async-question"\]/);
  assert.match(joined, /-c tui\.notification_method="osc9"/);
  assert.match(joined, /-c tui\.notification_condition="always"/);
  assert.equal(launch.args.at(-1), "do it");
});

test("disabled hooks or no hook server leave the profile untouched", () => {
  assert.deepEqual(buildLaunch("claude", { command: "claude", args: [] }, "p", null, relay, enabled).args, ["p"]);
  assert.deepEqual(buildLaunch("codex", { command: "codex", args: [] }, "", hooks, relay, { claude: true, codex: false }).args, []);
  assert.deepEqual(buildLaunch("opencode", { command: "opencode", args: [] }, "p", hooks, relay, enabled).args, ["--prompt", "p"]);
  assert.deepEqual(buildLaunch("grok", { command: "grok", args: ["-x"] }, "", hooks, relay, enabled).args, ["-x"]);
});
```

- [ ] **Step 6: Implement launch injection**

`packages/host/src/launch.ts`:

```ts
import type { AgentProfile, Provider } from "./types.js";

const CLAUDE_EVENTS = [
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "PermissionDenied", "Notification", "Elicitation", "Stop", "StopFailure", "SessionEnd",
];
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt"];

export function buildLaunch(
  provider: Provider, profile: AgentProfile, prompt: string,
  hooks: { url: string; token: string } | null, relayPath: string,
  enabled: { claude: boolean; codex: boolean },
): AgentProfile {
  const args = [...profile.args];
  if (hooks && provider === "claude" && enabled.claude) {
    const handler = {
      type: "http", url: `${hooks.url}/claude`,
      headers: { Authorization: "Bearer $INFINITE_HOOK_TOKEN" },
      allowedEnvVars: ["INFINITE_HOOK_TOKEN"], timeout: 5,
    };
    const settings = { hooks: Object.fromEntries(CLAUDE_EVENTS.map((e) => [e, [{ hooks: [handler] }]])) };
    args.push("--settings", JSON.stringify(settings));
  }
  if (hooks && provider === "codex" && enabled.codex) {
    const command = `node ${relayPath} codex`;
    for (const event of CODEX_EVENTS)
      args.push("-c", `hooks.${event}=[{hooks=[{type="command",command="${command}"}]}]`);
    args.push("--dangerously-bypass-hook-trust");
    args.push("-c", `notify=["node","${relayPath}","codex-notify"]`);
    args.push("-c", `tui.notifications=["agent-turn-complete","approval-requested","async-question"]`);
    args.push("-c", `tui.notification_method="osc9"`);
    args.push("-c", `tui.notification_condition="always"`);
  }
  if (prompt) args.push(...(provider === "opencode" ? ["--prompt", prompt] : [prompt]));
  return { command: profile.command, args };
}
```

Then in `packages/host/src/manager.ts` `createOnce`, replace the `launch` construction and the `if (prompt) launch.args.push(...)` block with `const launch = buildLaunch(request.provider, profile, prompt, null, relayPath(), hooksEnabled)` where hooks are `null` here because the worker, not the manager, owns the listener. The worker calls `buildLaunch` again with the real `hooks` (Task 8). So: the manager passes the **unmodified** profile and the composed `prompt` to the worker in `Bootstrap` (add `prompt: string` and `attention: { hooks: { claude: boolean; codex: boolean }; idleAfterMs: number }` fields to `Bootstrap`), and the worker builds the final argv. Delete the manager's prompt-appending code. `relayPath()` is `fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./hook-relay.ts" : "./hook-relay.js", import.meta.url))`; in the `.ts` case the relay command becomes `node --import tsx <path>`; implement that by passing `relayCommand: string[]` instead of `relayPath` if simpler, keeping the test's expected string for the `.js` case.

- [ ] **Step 7: Implement the relay**

`packages/host/src/hook-relay.ts`:

```ts
// Codex command hook → POST to the worker's loopback hook listener. Never prints, always exits 0.
const route = process.argv[2] ?? "codex";
const url = process.env.INFINITE_HOOK_URL;
const token = process.env.INFINITE_HOOK_TOKEN;
const deadline = setTimeout(() => process.exit(0), 2000);
async function main() {
  if (!url || !token) return;
  let body = process.argv[3];
  if (!body) {
    body = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 256 * 1024) return; }
  }
  await fetch(`${url}/${route}`, {
    method: "POST", body,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
}
main().finally(() => { clearTimeout(deadline); process.exit(0); });
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm run typecheck && npx tsx --test tests/host-hooks.test.ts tests/host-launch.test.ts`
Expected: PASS, 4 tests; typecheck clean (the `Bootstrap` change compiles once `manager.ts` and `worker.ts` both use the new fields; Task 8 finishes the worker side, so for now the worker reads `config.prompt` and passes `null` hooks to `buildLaunch`).

- [ ] **Step 9: Commit**

```bash
git add packages/host/src tests/host-hooks.test.ts tests/host-launch.test.ts
git commit -m "feat(host): loopback hook listener, per-process hook injection, Codex relay"
```

---

### Task 7: Rehearsal provider dialogs

**Files:**
- Modify: `packages/host/src/demo.ts`

**Interfaces:**
- Produces: a `demo` process that, given an initial request containing `dialog`, prints a Claude-style numbered dialog after 2 s and answers arrow/Enter keys; with `hook`, also posts Claude-shaped hook payloads to `INFINITE_HOOK_URL`; with `yesno`, prints `Continue? [y/N]` and reads a line.

- [ ] **Step 1: Replace `demo.ts`**

```ts
import { createInterface } from "node:readline";
const request = process.argv[2] ?? "";
console.log("Infinite · local continuity rehearsal");
console.log("This is a deterministic demo process. No model requests are made.");
console.log(`Process ${process.pid} stays alive when clients disconnect.\n`);
if (request) console.log(`Initial request: ${request}\n`);

const hookUrl = process.env.INFINITE_HOOK_URL;
const hookToken = process.env.INFINITE_HOOK_TOKEN;
const withHooks = request.includes("hook") && hookUrl && hookToken;
async function hook(body: Record<string, unknown>) {
  if (!withHooks) return;
  await fetch(`${hookUrl}/claude`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({ session_id: "demo", transcript_path: "/dev/null", cwd: process.cwd(), permission_mode: "default", ...body }),
  }).catch(() => {});
}

const OPTIONS = ["Yes", "Yes, and don't ask again for rm commands", "No, and tell Claude what to do differently"];
let dialog: { highlighted: number } | null = null;
let rawBuffer = "";

function drawDialog() {
  console.log("\nBash command\n  rm -rf build\n  Remove the stale build directory\n\nDo you want to proceed?");
  OPTIONS.forEach((label, i) => console.log(`${dialog && dialog.highlighted === i ? "❯" : " "} ${i + 1}. ${label}`));
}
function redraw() {
  // Move the cursor up over the option lines and redraw them in place.
  process.stdout.write(`\x1b[${OPTIONS.length}A`);
  OPTIONS.forEach((label, i) => process.stdout.write(`\x1b[2K${dialog && dialog.highlighted === i ? "❯" : " "} ${i + 1}. ${label}\n`));
}
async function openDialog() {
  await hook({ hook_event_name: "UserPromptSubmit", prompt: request });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Remove the stale build directory" }, tool_use_id: "demo-1" });
  dialog = { highlighted: 0 };
  drawDialog();
  await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Remove the stale build directory" }, permission_suggestions: [] });
}
async function selectOption(index: number) {
  const label = OPTIONS[index];
  dialog = null;
  console.log(`\nSelected: ${label}\n`);
  if (index === 2) {
    console.log("Tell Claude what to do differently:");
  } else {
    await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: { stdout: "", exitCode: 0 }, tool_use_id: "demo-1", duration_ms: 42 });
    await hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Removed the build directory. Nothing else changed.", background_tasks: [] });
  }
  process.stdout.write("\n> ");
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (dialog) {
    rawBuffer += chunk;
    if (rawBuffer.includes("\x1b[A")) { dialog.highlighted = Math.max(0, dialog.highlighted - 1); redraw(); rawBuffer = ""; }
    else if (rawBuffer.includes("\x1b[B")) { dialog.highlighted = Math.min(OPTIONS.length - 1, dialog.highlighted + 1); redraw(); rawBuffer = ""; }
    else if (rawBuffer.includes("\r")) { const i = dialog.highlighted; rawBuffer = ""; void selectOption(i); }
    else if (rawBuffer.includes("\x1b") && rawBuffer.length === 1) { /* wait for the rest of the sequence */ }
    else if (!rawBuffer.startsWith("\x1b")) rawBuffer = "";
    return;
  }
  lineBuffer += chunk;
  let nl: number;
  while ((nl = lineBuffer.indexOf("\r")) >= 0 || (nl = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, nl).replace(/\x1b\[(200|201)~/g, "");
    lineBuffer = lineBuffer.slice(nl + 1);
    if (/^[yY]$/.test(line) && awaitingYesNo) { awaitingYesNo = false; console.log("\nContinuing.\n> "); continue; }
    if (/^[nN]$/.test(line) && awaitingYesNo) { awaitingYesNo = false; console.log("\nCancelled.\n> "); continue; }
    console.log(`\nYou: ${line}\nRehearsal: message received by process ${process.pid}.\n`);
    process.stdout.write("> ");
  }
});
let lineBuffer = "";
let awaitingYesNo = false;

if (request.includes("dialog")) setTimeout(() => void openDialog(), 2000);
else if (request.includes("yesno")) setTimeout(() => { awaitingYesNo = true; process.stdout.write("Installing 3 packages\nContinue? [y/N] "); }, 2000);
else {
  let tick = 0;
  setInterval(() => console.log(`[${new Date().toISOString()}] Checkpoint ${++tick} · process still running`), 3000);
}
process.on("SIGTERM", () => { console.log("Rehearsal stopped."); process.exit(0); });
```

Remove the unused `createInterface` import if TypeScript flags it. Raw mode requires a PTY; under node-pty `isTTY` is true.

- [ ] **Step 2: Manual check through the dev host**

Run: `npm run dev` in one terminal; in another: `npm run build -w @infinite/host && npm run host -- new --config .local/config.json --provider demo --title Dialog --prompt dialog` (the `new` command reads `--provider`, `--project`, `--title`, `--prompt`). Then `npm run host -- attach <id> --config .local/config.json`.
Expected: after 2 s the dialog appears with `❯ 1. Yes`; down arrow moves the marker; Enter prints `Selected: …` and a `>` prompt. `Ctrl+]` detaches.

- [ ] **Step 3: Run the existing suite**

Run: `npm test`
Expected: the continuity test still passes (its demo sessions use prompts without `dialog`).

- [ ] **Step 4: Commit**

```bash
git add packages/host/src/demo.ts
git commit -m "feat(host): rehearsal provider can show dialogs and emit Claude-shaped hooks"
```

---

### Task 8: Worker attention loop, OSC handler, and the answer operation

**Files:**
- Modify: `packages/host/src/worker.ts`, `packages/host/src/manager.ts` (`list`, `state`, `createOnce` bootstrap), `packages/host/src/server.ts` (answer route, session rows), `packages/host/src/types.ts` (`Bootstrap`)
- Test: `tests/worker-attention.test.ts`

**Interfaces:**
- Consumes: Task 3 reducer functions, Task 4 mappers, Task 6 `startHookServer`/`buildLaunch`, Task 7 demo behaviors.
- Produces: `WorkerState.attention` kept current; `op: "answer"` worker request returning `Receipt & { result: AnswerResult }`; `POST /api/sessions/:id/answer`; `GET /api/sessions` rows carry `attention` with `lastMessage` cut to 280 and `prompt.tool.input` removed.
- `Bootstrap` gains `prompt: string` and `attention: { hooks: { claude: boolean; codex: boolean }; idleAfterMs: number }`.

- [ ] **Step 1: Write the failing integration-style test**

`tests/worker-attention.test.ts` boots one API with the demo provider (copy the `freePort`, config and `fetchApi` helpers from `tests/continuity.test.ts` into a shared `tests/helpers.ts` first, exporting `startHost(agents)` that returns `{ origin, tokens, fetchApi, stop }`):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost, waitFor } from "./helpers.js";

test("dialog session: screen + hook prompt merge, answer closes it, stale answer is refused", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Dialog", prompt: "dialog hook" });
    assert.equal(created.status, 201);
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    const prompt = detail.body.attention.prompt;
    assert.equal(prompt.kind, "permission");
    assert.equal(prompt.source, "hook");                 // hook opened it
    assert.equal(prompt.options.length, 3);              // screen supplied the options
    assert.equal(prompt.tool.name, "Bash");              // hook supplied the tool
    assert.deepEqual(prompt.destructive, { pattern: "rm-recursive-force" });
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
    const again = await host.fetchApi(`/sessions/${id}/answer`, "controller", { requestId, promptId: prompt.id, option: 1 });
    assert.equal(again.status, 200);                     // idempotent replay
    assert.equal(again.body.seq, answer.body.seq);

    const finished = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention.state === "turn-finished", 10000);
    assert.match(finished.body.attention.lastMessage, /Removed the build directory/);

    const events = await host.fetchApi(`/sessions/${id}/events?types=signal`);
    const kinds = events.body.events.map((e: { data: { kind: string } }) => e.data.kind);
    for (const k of ["hooks-ready", "turn-start", "tool-start", "prompt-open", "answer", "prompt-closed", "tool-end", "turn-end"]) assert.ok(kinds.includes(k), k);
    const answered = events.body.events.find((e: { data: { kind: string } }) => e.data.kind === "answer").data;
    assert.equal(answered.option.label, "Yes, and don't ask again for rm commands");
    assert.equal(answered.result, "closed");
  } finally {
    await host.stop();
  }
});

test("screen-only yes/no prompt and idle detection without hooks", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "YesNo", prompt: "yesno" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention?.state === "needs-you", 15000);
    assert.equal(detail.body.attention.prompt.kind, "yes-no");
    assert.equal(detail.body.attention.prompt.source, "screen");
    assert.equal(detail.body.attention.hooks, "none");
    const answer = await host.fetchApi(`/sessions/${id}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 });
    assert.equal(answer.body.result, "closed");
    const idle = await waitFor(() => host.fetchApi(`/sessions/${id}`), (r) => r.body.attention.state === "idle", 30000);
    assert.equal(idle.body.attention.now, "Waiting for your direction");
  } finally {
    await host.stop();
  }
});
```

For the idle test, `startHost` must set `attention.idleAfterMs` to 3000 in the test config (Task 9 adds the config field; until then the worker reads `bootstrap.attention.idleAfterMs`, which the manager fills from `config.attention?.idleAfterMs ?? 20000`; add the optional field to the zod schema in this task).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/worker-attention.test.ts`
Expected: FAIL: `attention.prompt` never gains options/hash, `/answer` returns 404.

- [ ] **Step 3: Worker changes**

In `packages/host/src/worker.ts`:

1. Imports:

```ts
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applyLifecycle, applySignal, describeNow, detectPrompt, initialAttention, isIdleScreen,
  mapClaudeHook, claudeAgent, mapCodexHook, mapCodexNotify, mapCodexOsc, mergeScreenIntoPrompt, screenDecision,
  type Attention, type Prompt, type Signal, type SignalData, type SignalEvent,
} from "@infinite/attention";
import { startHookServer, type HookRoute } from "./hooks.js";
import { buildLaunch } from "./launch.js";
```

2. Attention helpers, placed after `state` is declared:

```ts
const provider = session.provider;
let attention: Attention = initialAttention(new Date().toISOString(), Boolean(config.prompt));
let lastOutputAt = Date.now();
let outputSinceCheck = false;
let vanishCount = 0;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

function record(signal: Signal, source: SignalData["source"], agent?: { id: string; type: string }): SignalEvent {
  const data: SignalData = { ...signal, source, provider, ...(agent ? { agent } : {}) } as SignalData;
  const event = journal.append("signal", data as unknown as Record<string, unknown>) as unknown as SignalEvent;
  attention = applySignal(attention, event);
  attention.now = describeNow(attention, provider);
  return event;
}
function syncState() {
  state = { ...state, attention };
}
```

Replace every `journal.append("lifecycle", ...)` that sets `exited` with the same call followed by `attention = applyLifecycle(attention, "exited", new Date().toISOString()); attention.now = describeNow(attention, provider); syncState();`. In `recordingFailure()` do the same with `"recording-error"`.

3. Hook ingestion:

```ts
let hooksReady = false;
function onHook(route: HookRoute, body: unknown) {
  try {
    if (!hooksReady) {
      hooksReady = true;
      const event = (body as { hook_event_name?: string; type?: string }).hook_event_name ?? (body as { type?: string }).type ?? route;
      record({ kind: "hooks-ready", event: String(event) }, "hook");
    }
    const signals = route === "claude" ? mapClaudeHook(body) : route === "codex" ? mapCodexHook(body) : mapCodexNotify(body);
    const agent = route === "claude" ? claudeAgent(body) : undefined;
    for (const signal of signals) {
      if (signal.kind === "prompt-open" && attention.prompt) {
        // A screen prompt is already open: keep its id, adopt the hook's tool and flag.
        attention = { ...attention, prompt: { ...attention.prompt, kind: signal.prompt.kind === "permission" ? "permission" : attention.prompt.kind, tool: signal.prompt.tool ?? attention.prompt.tool, destructive: signal.prompt.destructive ?? attention.prompt.destructive, source: attention.prompt.source } };
        attention.now = describeNow(attention, provider);
        continue;
      }
      record(signal, "hook", agent);
    }
    syncState();
  } catch {
    recordingFailure();
  }
}
```

4. Screen loop, run on a 1 s timer and after each flush:

```ts
function checkScreen() {
  if (state.status !== "running") return;
  const lines = screen().split("\n");
  const detected = detectPrompt(lines, provider);
  const idle = !outputSinceCheck && Date.now() - lastOutputAt >= config.attention.idleAfterMs && isIdleScreen(lines, provider);
  const decision = screenDecision(attention, detected, idle, outputSinceCheck, new Date().toISOString());
  outputSinceCheck = false;
  try {
    if (decision.close) {
      if (++vanishCount >= 2) { record({ kind: "prompt-closed", promptId: decision.close.promptId, reason: "vanished" }, "screen"); vanishCount = 0; }
    } else vanishCount = 0;
    if (decision.open) {
      const { fingerprint, ...rest } = decision.open;
      const prompt: Prompt = { ...rest, id: 0, hash: hashOf(fingerprint) };
      if (prompt.detail) {
        const pattern = matchDestructive(prompt.detail);
        if (pattern) prompt.destructive = { pattern };
      }
      record({ kind: "prompt-open", prompt }, "screen");
    }
    if (decision.merge && attention.prompt) {
      attention = { ...attention, prompt: mergeScreenIntoPrompt(attention.prompt, decision.merge, hashOf(decision.merge.fingerprint)) };
      attention.now = describeNow(attention, provider);
    }
    if (decision.idle) {
      attention = { ...attention, state: decision.idle, since: attention.state === decision.idle ? attention.since : new Date().toISOString(), source: "screen" };
      attention.now = describeNow(attention, provider);
    }
    if (decision.working) {
      attention = { ...attention, state: "working", since: new Date().toISOString(), source: "screen" };
      attention.now = describeNow(attention, provider);
    }
    syncState();
  } catch {
    recordingFailure();
  }
}
setInterval(checkScreen, 1000).unref();
```

Import `matchDestructive` from `@infinite/attention`. In `child.onData`, set `lastOutputAt = Date.now(); outputSinceCheck = true;` and call `checkScreen()` inside the flush timer after `flush()`.

5. OSC 9 handler, registered right after the terminal is created:

```ts
terminal.parser.registerOscHandler(9, (data) => {
  if (provider === "codex") try { for (const s of mapCodexOsc(data)) { if (s.kind === "prompt-open" && attention.prompt) continue; record(s, "osc"); } syncState(); } catch { recordingFailure(); }
  return false; // let xterm keep its default handling
});
```

6. Launch with hooks: replace the `child = spawn(profile.command, profile.args, …)` block. Before `server.listen`, start the hook server when the provider is `claude`, `codex` or `demo`:

```ts
const hookToken = randomBytes(32).toString("hex");
const hookServer = ["claude", "codex", "demo"].includes(provider)
  ? await startHookServer({ token: hookToken, onPayload: onHook, onError: () => { attention = { ...attention, hookErrors: attention.hookErrors + 1 }; syncState(); } })
  : null;
const relay = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./hook-relay.ts" : "./hook-relay.js", import.meta.url));
const launch = buildLaunch(provider, profile, config.prompt, hookServer ? { url: hookServer.url, token: hookToken } : null, relay, config.attention.hooks);
if (hookServer) { env.INFINITE_HOOK_URL = hookServer.url; env.INFINITE_HOOK_TOKEN = hookToken; }
child = spawn(launch.command, launch.args, { cwd: session.cwd, env, cols: 120, rows: 32, name: "xterm-256color" });
```

Close the hook server in the exit path before `process.exit(0)`.

7. The answer operation, as an async path guarded by a promise chain so answers and inputs never interleave:

```ts
let serial: Promise<unknown> = Promise.resolve();
const press = (key: string) => child!.write(key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function answer(request: Extract<WorkerRequest, { op: "answer" }>): Promise<Receipt & { result: string }> {
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest) throw new Error("Request ID already belongs to different input");
    return previous as Receipt & { result: string; digest: string };
  }
  if (state.status !== "running" || !child) throw new Error("Session is not running");
  const prompt = attention.prompt;
  const fail = (code: string) => { const e = new Error(code); (e as Error & { code: string }).code = code; throw e; };
  if (attention.state !== "needs-you" || !prompt || prompt.id !== request.promptId) fail("prompt-changed");
  if (!prompt!.hash) fail("prompt-changed");
  if (prompt!.multiSelect) fail("unsupported");
  const current = detectPrompt(screen().split("\n"), provider);
  if (!current || hashOf(current.fingerprint) !== prompt!.hash) fail("prompt-changed");
  const option = request.option;
  if (option !== undefined && (option < 0 || option >= prompt!.options.length)) fail("invalid-option");
  if (request.text !== undefined && !prompt!.acceptsText) fail("text-not-accepted");
  if (prompt!.kind === "yes-no" && request.text !== undefined) fail("text-not-accepted");
  const chosen = option !== undefined ? prompt!.options[option] : prompt!.options.find((o) => o.role === "reject-with-feedback");
  if (!chosen) fail("invalid-option");
  flush();
  const intent = journal.append("input-intent", { op: "answer", requestId: request.requestId, promptId: request.promptId, option: chosen!.index, text: request.text !== undefined });
  const receipt: Receipt & { digest: string; result: string } = { requestId: request.requestId, state: "uncertain", seq: intent.seq, digest, result: "refused" };
  receipts.set(request.requestId, receipt);
  let result: "closed" | "still-open" | "changed" = "still-open";
  if (prompt!.kind === "yes-no") {
    press(chosen!.role === "accept" ? "y" : "n"); await sleep(40); press("\r");
  } else {
    let at = current!.highlighted ?? 0;
    while (at !== chosen!.index) { press(at < chosen!.index ? "\x1b[B" : "\x1b[A"); at += at < chosen!.index ? 1 : -1; await sleep(40); }
    await sleep(60);
    const check = detectPrompt(screen().split("\n"), provider);
    if (!check || hashOf(check.fingerprint) !== prompt!.hash || (check.highlighted !== undefined && check.highlighted !== chosen!.index)) result = "changed";
    else press("\r");
  }
  if (result !== "changed") {
    const until = Date.now() + 1500;
    while (Date.now() < until) { await sleep(100); const now = detectPrompt(screen().split("\n"), provider); if (!now || hashOf(now.fingerprint) !== prompt!.hash) { result = "closed"; break; } }
  }
  if (result === "closed") {
    record({ kind: "prompt-closed", promptId: prompt!.id, reason: "answered-here", label: chosen!.label }, "host");
    if (request.text !== undefined) {
      await sleep(150);
      child.write(terminal.modes.bracketedPasteMode ? `\x1b[200~${request.text}\x1b[201~` : request.text);
      child.write("\r");
    }
  }
  record({ kind: "answer", promptId: prompt!.id, requestId: request.requestId, option: { index: chosen!.index, label: chosen!.label }, text: request.text !== undefined, result }, "host");
  const done = journal.append("input-result", { requestId: request.requestId, state: "delivered", result });
  receipt.state = "delivered"; receipt.seq = done.seq; receipt.result = result;
  syncState();
  return receipt;
}
```

In the socket handler, make the callback `async`, and route `request.op === "answer"` through `serial = serial.then(() => answer(request))` with validation: `requestId` string ≤ 80, `promptId` integer ≥ 1, `option` integer or undefined, `text` string ≤ 32000 without control characters. Also route `input`, `raw`, `key`, `stop` through the same `serial` chain so they wait for an in-flight answer. Error responses include `code` when present: `socket.end(JSON.stringify({ error: message, code }) + "\n")`. Update `workerCall` in `ipc.ts` to attach `code` to the rejected error.

- [ ] **Step 4: Manager and server changes**

`manager.ts`:
- `Bootstrap` gets `prompt` and `attention`; `createOnce` sends `prompt` (the composed context+request text) and `attention: { hooks: this.config.attention?.hooks ?? { claude: true, codex: true }, idleAfterMs: this.config.attention?.idleAfterMs ?? 20000 }`, and sends the unmodified `profile`.
- `list()` maps each row's attention through `publicAttention(att)`:

```ts
function publicAttention(att: Attention): Attention {
  if (!att.prompt) return { ...att, lastMessage: att.lastMessage?.slice(0, 280) };
  const { tool, ...prompt } = att.prompt;
  return {
    ...att,
    prompt: { ...prompt, ...(tool ? { tool: { name: tool.name, input: {} } } : {}) },
    lastMessage: att.lastMessage?.slice(0, 280),
  };
}
```

The list row therefore carries `prompt.tool.name` with an empty `input`, which is what the Step 1 test asserts.

- `state()` fallback: `attention: applyLifecycle(saved.attention ?? initialAttention(now, false), status, now)`.

`config.ts` schema: add

```ts
attention: z.object({
  idleAfterMs: z.number().int().min(1000).max(600000).default(20000),
  hooks: z.object({ claude: z.boolean().default(true), codex: z.boolean().default(true) }).default({ claude: true, codex: true }),
}).optional(),
```

and the matching optional `attention?: { idleAfterMs: number; hooks: { claude: boolean; codex: boolean } }` on `Config`.

`server.ts` answer route:

```ts
app.post("/api/sessions/:id/answer", requireRole(["owner", "controller"]), async (req, res) => {
  const sessionId = id.parse(req.params.id);
  manager.meta(sessionId);
  const body = z.object({
    requestId: id,
    promptId: z.number().int().min(1),
    option: z.number().int().min(0).max(50).optional(),
    text: z.string().min(1).max(32000).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/).optional(),
  }).strict().refine((b) => b.option !== undefined || b.text !== undefined, { message: "option or text is required" }).parse(req.body);
  try {
    res.json(await workerCall(config.runDir, sessionId, { op: "answer", ...body }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "prompt-changed" || code === "unsupported" || code === "invalid-option" || code === "text-not-accepted")
      return res.status(409).json({ error: code, attention: (await manager.state(sessionId)).attention });
    throw error;
  }
});
```

Register this route before the generic error handler and before the `/api` 404.

- [ ] **Step 5: Run the test**

Run: `npm run typecheck && npx tsx --test tests/worker-attention.test.ts`
Expected: PASS, 2 tests. If `prompt.options` stays empty, the demo's dialog is not reaching the xterm buffer before the hook: confirm `checkScreen()` runs in the flush timer and that `screenDecision` returns `merge` for a hook prompt without options.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all PASS, including the untouched continuity test.

- [ ] **Step 7: Commit**

```bash
git add packages/host/src tests/worker-attention.test.ts tests/helpers.ts
git commit -m "feat(host): attention state from hooks, OSC and screen; verified answer operation"
```

---

### Task 9: Push devices, the Notifier, and the Expo sender

**Files:**
- Create: `packages/host/src/push.ts`, `packages/host/src/notifier.ts`
- Modify: `packages/host/src/config.ts` (schema), `packages/host/src/types.ts` (`Config.push`), `packages/host/src/server.ts` (device routes, token id in `res.locals`, Notifier start), `packages/host/src/cli.ts` (start Notifier in `serve`/`dev`)
- Test: `tests/push.test.ts`

**Interfaces:**
- Produces:
  - `class PushStore { constructor(stateDir, key); list(): PushDevice[]; add(deviceId: string, token: string, platform: "android" | "ios"): void; remove(token: string): void }` with `PushDevice = { deviceId; token; platform; addedAt }`, persisted to `<stateDir>/push-devices.sealed`.
  - `expoSender(opts: { endpoint: string; accessToken?: string }): PushSender` where `PushSender = (messages: PushMessage[]) => Promise<PushTicket[]>`, `PushMessage = { to: string; title: string; body: string; data: { url: string }; channelId: "attention"; priority: "high" | "default"; collapseId: string }`, `PushTicket = { status: "ok" | "error"; id?: string; details?: { error?: string } }`.
  - `class Notifier { constructor(manager: Manager, store: PushStore, sender: PushSender, options: { detail: "minimal" | "full"; events: string[]; intervalMs: number }); start(); stop(); tick(): Promise<void> }`.
  - `POST /api/devices/push`, `DELETE /api/devices/push`; `GET /api/me` includes `capabilities`.
  - `res.locals.deviceId` is the authenticated token's `id`.

- [ ] **Step 1: Write the failing test**

`tests/push.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PushStore, expoSender } from "../packages/host/src/push.js";
import { Notifier } from "../packages/host/src/notifier.js";
import type { Attention } from "@infinite/attention";

const att = (state: Attention["state"], promptId?: number): Attention => ({
  state, since: "t", source: "hook", now: state === "needs-you" ? "Do you want to proceed? rm -rf build" : "Finished a turn",
  prompt: promptId ? { id: promptId, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook" } : undefined,
  lastActivityAt: "t", hooks: "active", hookErrors: 0, sawTurnEnd: false,
});

test("store adds once per token and removes", () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("viewer", "ExponentPushToken[b]", "ios");
  assert.equal(store.list().length, 2);
  store.remove("ExponentPushToken[a]");
  assert.deepEqual(store.list().map((d) => d.token), ["ExponentPushToken[b]"]);
  rmSync(dir, { recursive: true, force: true });
});

test("notifier sends once per transition, minimal body, prunes unregistered tokens", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("viewer", "ExponentPushToken[dead]", "android");
  const sent: unknown[][] = [];
  const sessions = [{ id: "s1", title: "Retry logic", provider: "claude", status: "running", attention: att("working") }];
  const manager = { list: async () => sessions } as never;
  const sender = async (messages: { to: string }[]) => { sent.push(messages); return messages.map((m) => m.to.includes("dead") ? { status: "error" as const, details: { error: "DeviceNotRegistered" } } : { status: "ok" as const, id: "x" }); };
  const notifier = new Notifier(manager, store, sender, { detail: "minimal", events: ["needs-you", "turn-finished", "exited", "recording-error"], intervalMs: 100000 });
  await notifier.tick();                 // baseline, no sends
  sessions[0].attention = att("needs-you", 7);
  await notifier.tick();
  await notifier.tick();                 // same prompt: no second send
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2);
  const first = sent[0][0] as { title: string; body: string; data: { url: string }; collapseId: string; priority: string };
  assert.equal(first.title, "Needs your approval");
  assert.equal(first.body, "Claude Code needs your approval in Retry logic");
  assert.equal(first.data.url, "/session/s1");
  assert.equal(first.collapseId, "s1");
  assert.equal(first.priority, "high");
  assert.deepEqual(store.list().map((d) => d.token), ["ExponentPushToken[a]"]);
  sessions[0].attention = att("needs-you", 8);
  await notifier.tick();                 // new prompt id: a new send
  assert.equal(sent.length, 2);
  sessions[0].attention = att("turn-finished");
  await notifier.tick();
  assert.equal((sent[2][0] as { body: string }).body, "Retry logic finished a turn");
  sessions[0].attention = att("working");
  await notifier.tick();                 // working is not a push event
  assert.equal(sent.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("expo sender posts the Expo push payload with a bearer token", async () => {
  let seen: { auth?: string; body: unknown } | undefined;
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen = { auth: req.headers.authorization, body: JSON.parse(b) }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ status: "ok", id: "t1" }] })); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const send = expoSender({ endpoint: `http://127.0.0.1:${port}/push/send`, accessToken: "exp-token" });
  const tickets = await send([{ to: "ExponentPushToken[a]", title: "T", body: "B", data: { url: "/session/x" }, channelId: "attention", priority: "high", collapseId: "x" }]);
  assert.deepEqual(tickets, [{ status: "ok", id: "t1" }]);
  assert.equal(seen?.auth, "Bearer exp-token");
  assert.equal((seen?.body as unknown[]).length, 1);
  server.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/push.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `push.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unseal, writeSealed } from "./vault.js";

export interface PushDevice { deviceId: string; token: string; platform: "android" | "ios"; addedAt: string }
export interface PushMessage { to: string; title: string; body: string; data: { url: string }; channelId: "attention"; priority: "high" | "default"; collapseId: string }
export interface PushTicket { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } }
export type PushSender = (messages: PushMessage[]) => Promise<PushTicket[]>;

export class PushStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly key: Buffer) { this.file = join(stateDir, "push-devices.sealed"); }
  list(): PushDevice[] {
    return existsSync(this.file) ? unseal<PushDevice[]>(this.key, "push-devices", readFileSync(this.file, "utf8")) : [];
  }
  private save(devices: PushDevice[]) { writeSealed(this.file, this.key, "push-devices", devices); }
  add(deviceId: string, token: string, platform: "android" | "ios") {
    const devices = this.list().filter((d) => d.token !== token);
    devices.push({ deviceId, token, platform, addedAt: new Date().toISOString() });
    this.save(devices);
  }
  remove(token: string) { this.save(this.list().filter((d) => d.token !== token)); }
}

export const isExpoToken = (token: string) => /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/.test(token);

export function expoSender(opts: { endpoint: string; accessToken?: string }): PushSender {
  return async (messages) => {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const response = await fetch(opts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}) },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(10000),
        });
        const json = (await response.json()) as { data?: PushTicket[] };
        tickets.push(...(Array.isArray(json.data) ? json.data : chunk.map(() => ({ status: "error" as const, message: `HTTP ${response.status}` }))));
      } catch (error) {
        tickets.push(...chunk.map(() => ({ status: "error" as const, message: (error as Error).message })));
      }
    }
    return tickets;
  };
}
```

- [ ] **Step 4: Implement `notifier.ts`**

```ts
import { PROVIDER_NAMES, type Attention, type Provider } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PushSender, PushStore } from "./push.js";

type Row = { id: string; title: string; provider: Provider; attention: Attention };
const PUSH_STATES = new Set(["needs-you", "turn-finished", "exited", "recording-error"]);

export class Notifier {
  private seen = new Map<string, string>();
  private primed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly manager: Pick<Manager, "list">,
    private readonly store: PushStore,
    private readonly sender: PushSender,
    private readonly options: { detail: "minimal" | "full"; events: string[]; intervalMs: number },
  ) {}
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    const rows = (await this.manager.list()) as unknown as Row[];
    const due: Row[] = [];
    for (const row of rows) {
      const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
      const previous = this.seen.get(row.id);
      this.seen.set(row.id, key);
      if (!this.primed || previous === key) continue;
      if (PUSH_STATES.has(row.attention.state) && this.options.events.includes(row.attention.state)) due.push(row);
    }
    this.primed = true;
    if (!due.length) return;
    const devices = this.store.list();
    if (!devices.length) return;
    const messages = due.flatMap((row) => devices.map((d) => this.message(row, d.token)));
    const tickets = await this.sender(messages);
    tickets.forEach((ticket, i) => { if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") this.store.remove(messages[i].to); });
  }
  private message(row: Row, to: string) {
    const name = PROVIDER_NAMES[row.provider] ?? row.provider;
    const [title, minimal] =
      row.attention.state === "needs-you"
        ? row.attention.prompt?.kind === "question" ? ["Question for you", `${name} asked a question in ${row.title}`] : ["Needs your approval", `${name} needs your approval in ${row.title}`]
        : row.attention.state === "turn-finished" ? ["Turn finished", `${row.title} finished a turn`]
        : row.attention.state === "exited" ? ["Session exited", `${row.title} exited`]
        : ["Recording stopped", `${row.title} stopped recording`];
    return {
      to, title, body: this.options.detail === "full" ? row.attention.now || minimal : minimal,
      data: { url: `/session/${row.id}` }, channelId: "attention" as const,
      priority: row.attention.state === "needs-you" ? ("high" as const) : ("default" as const), collapseId: row.id,
    };
  }
}
```

- [ ] **Step 5: Config, routes, startup**

`config.ts` schema addition and `Config` type:

```ts
push: z.object({
  enabled: z.boolean().default(false),
  accessTokenFile: z.string().optional(),
  endpoint: z.url().default("https://exp.host/--/api/v2/push/send"),
  detail: z.enum(["minimal", "full"]).default("minimal"),
  events: z.array(z.enum(["needs-you", "turn-finished", "exited", "recording-error"])).default(["needs-you", "turn-finished", "exited", "recording-error"]),
}).optional(),
```

In `readConfig`, when `push?.enabled && push.accessTokenFile`: require an absolute path outside `stateDir`, mode `0600`, non-empty contents; otherwise throw `"Push access token file must be absolute, outside stateDir, chmod 600"`.

`server.ts`:
- `authenticate` returns the matching token entry (`{ id, role }`); cookies store `{ role, id, expires }`; the `/api` middleware sets `res.locals.deviceId = entry.id`.
- Routes:

```ts
const pushStore = new PushStore(config.stateDir, key);
app.post("/api/devices/push", (req, res) => {
  const body = z.object({ token: z.string().max(200).refine(isExpoToken, "Not an Expo push token"), platform: z.enum(["android", "ios"]) }).strict().parse(req.body);
  pushStore.add(String(res.locals.deviceId), body.token, body.platform);
  res.json({ ok: true, push: Boolean(config.push?.enabled) });
});
app.delete("/api/devices/push", (req, res) => {
  const body = z.object({ token: z.string().max(200) }).strict().parse(req.body);
  pushStore.remove(body.token);
  res.json({ ok: true });
});
```

- `/api/me` adds `capabilities: { signals: true, answer: ["owner", "controller"].includes(res.locals.role), push: Boolean(config.push?.enabled) }`.
- `createApp` returns `{ app, manager, pushStore }`.

`cli.ts` in the `serve`/`dev` branch after the listener starts:

```ts
if (config.push?.enabled) {
  const accessToken = config.push.accessTokenFile ? readFileSync(config.push.accessTokenFile, "utf8").trim() : undefined;
  new Notifier(manager, pushStore, expoSender({ endpoint: config.push.endpoint, accessToken }), { detail: config.push.detail, events: config.push.events, intervalMs: 2000 }).start();
  console.log("Push notifications: enabled (" + config.push.detail + " bodies)");
}
```

- [ ] **Step 6: Run tests and the suite**

Run: `npm run typecheck && npx tsx --test tests/push.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/host/src tests/push.test.ts
git commit -m "feat(host): push device registry, transition notifier, Expo push sender"
```

---

### Task 10: Doctor, docs, and the web client's type parity

**Files:**
- Modify: `packages/host/src/cli.ts` (doctor), `docs/architecture.md`, `docs/security.md`, `README.md`, `apps/web/src/api.ts` (`LogEvent.type` union), `docs/superpowers/specs/2026-10-04-mobile-attention-brief-design.md` (§8.1 sender wording)

- [ ] **Step 1: Extend `doctor`**

In the `doctor` branch of `cli.ts`, after the existing binary checks, print:

```ts
console.log(`Hook relay: ${existsSync(relay) ? relay : "MISSING (run npm run build)"}`);
for (const [name, bin] of [["claude", "claude"], ["codex", "codex"]] as const) {
  if (!config.agents[name]) continue;
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout?.trim() || "not found";
  console.log(`${name}: ${version} · hooks ${config.attention?.hooks?.[name] === false ? "disabled" : "enabled"}`);
}
const userSettings = join(homedir(), ".claude", "settings.json");
if (existsSync(userSettings)) {
  try {
    const parsed = JSON.parse(readFileSync(userSettings, "utf8"));
    if (parsed.allowedHttpHookUrls) console.log("WARNING: ~/.claude/settings.json defines allowedHttpHookUrls; add http://127.0.0.1:*/hook/claude or Infinite's Claude hooks will not run.");
  } catch { /* unreadable settings are the user's concern */ }
}
if (config.push?.enabled) {
  const mode = config.push.accessTokenFile ? statSync(config.push.accessTokenFile).mode & 0o777 : 0;
  console.log(`Push: enabled · ${config.push.detail} bodies · token file ${config.push.accessTokenFile ?? "none"} (mode ${mode.toString(8)})`);
} else console.log("Push: disabled");
console.log("Codex hooks use --dangerously-bypass-hook-trust for the hooks Infinite injects per process only.");
```

Run: `npm run build && npm run host -- doctor --config .local/config.json`
Expected: the new lines appear with real versions (`2.1.289`, `codex-cli 0.160.0`).

- [ ] **Step 2: Documentation**

- `docs/architecture.md`: in "API capabilities" add rows for `GET /api/sessions/:id/events?types=`, `POST /api/sessions/:id/answer` (Owner, controller), `POST/DELETE /api/devices/push` (Any). Add a section "Signals and attention" of about 15 lines: the `signal` event, sources and their labels, the attention states, the answer contract (hash check, keystrokes, post-check), and that hooks never decide.
- `docs/security.md`: add the paragraph from spec §3.1 on hook tokens being readable by the agent, the trust-bypass flag scope, and push bodies being minimal by default with the Expo service as the first outbound dependency.
- `README.md`: under "Phone", describe the Brief and the push setup steps from spec §8.2 (EAS project id, Firebase `google-services.json`, FCM V1 key upload, Expo access token file, `push` config block). Under "What is implemented", add the attention bullets. Keep the existing honesty statements.
- `apps/web/src/api.ts`: widen `LogEvent.type` to include `"signal"` so the web recording view keeps compiling and renders signal rows as `kind` text.
- Spec §8.1: replace "(`expo-server-sdk`)" with "using `fetch` against the Expo push HTTP API" to match the implementation.

- [ ] **Step 3: Check and commit**

Run: `npm run check`
Expected: typecheck, tests and all three builds pass.

```bash
git add packages/host/src/cli.ts docs README.md apps/web/src/api.ts
git commit -m "docs(host): attention signals, answer contract, push setup; doctor reports hooks and push"
```

---

### Task 11: Continuity test extension (API restart keeps attention)

**Files:**
- Modify: `tests/continuity.test.ts` (or add to `tests/worker-attention.test.ts`)

- [ ] **Step 1: Add the assertion**

After the existing API kill-and-restart sequence in `continuity.test.ts`, create one more session before the kill with `prompt: "dialog"`, wait for `needs-you`, kill and restart the API, then:

```ts
const after = await fetchApi(`/sessions/${dialogId}`);
assert.equal(after.body.attention.state, "needs-you");
assert.equal(after.body.attention.prompt.options.length, 3);
assert.equal(after.body.pid, beforePid);
```

Also assert that `GET /sessions/:id/events?types=lifecycle,signal` after restart returns the same `prompt-open` seq as before the restart.

- [ ] **Step 2: Run**

Run: `npm test`
Expected: PASS. The worker never restarted, so its in-memory attention is intact; this guards the manager's `state()` path and the sealed status fallback.

- [ ] **Step 3: Commit**

```bash
git add tests
git commit -m "test(host): attention survives an API restart"
```

---

## Phase C — Phone

Phone tasks have no automated test runner. Each ends with `npm run lint -w @infinite/mobile`, `npx tsc --noEmit` in `apps/mobile`, and a run on the Android emulator against the local rehearsal host (`npm run dev` at the root, `adb reverse tcp:4780 tcp:4780`, `npm run android -w @infinite/mobile`, pair with `http://127.0.0.1:4780` and the controller key from `.local/devices.json`). Screenshots go to the scratchpad, not the repo.

### Task 12: Split the app and add the shared client, theme and Terminal route

**Files:**
- Create: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/usePoll.ts`, `apps/mobile/src/store/connection.ts`, `apps/mobile/src/theme.ts`, `apps/mobile/src/components/Button.tsx`, `apps/mobile/src/components/StatePill.tsx`, `apps/mobile/src/components/OfflineBanner.tsx`, `apps/mobile/src/features/pair/Pair.tsx`, `apps/mobile/src/features/inbox/Inbox.tsx`, `apps/mobile/src/features/session/Terminal.tsx`, `apps/mobile/src/features/session/Brief.tsx` (placeholder that renders Terminal until Task 14), `apps/mobile/src/app/session/[id]/index.tsx`, `apps/mobile/src/app/session/[id]/terminal.tsx`
- Modify: `apps/mobile/src/app/index.tsx`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/package.json` (add `"@infinite/attention": "0.1.0"`), `apps/mobile/tsconfig.json`
- Delete: `apps/mobile/src/App.tsx`, `apps/mobile/src/app/session/[id].tsx`, `apps/mobile/App.tsx` (keep `index.ts` only if `main` still points at `expo-router/entry`; it does, so delete both `App.tsx` files)

**Interfaces:**
- Produces:
  - `api<T>(connection: Connection, path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }): Promise<T>` throwing `ApiError { status: number; code?: string; attention?: Attention }`.
  - Types `Connection`, `SessionRow` (list row with `attention`), `SessionDetail`, `Me`.
  - `usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[]): { data: T | null; online: boolean; seen: string; refresh: () => void }`, pausing when the app is backgrounded.
  - `loadConnection(): Promise<Connection | null>`, `saveConnection(c)`, `clearConnection()`, `SECRET_KEY = "infinite.connection.v1"` (unchanged so existing pairings survive).
  - `theme` tokens: `colors` (canvas, paper, ink, mutedInk, rule, forest, white, fieldRule, placeholder, focus, selectedRow, secondarySurface, secondaryInk, screenSurface, screenInk, running, warningSurface, warningInk, error, terminalSurface, terminalInk) copied from `DESIGN.md`; `mono = Platform.OS === "ios" ? "Menlo" : "monospace"`; `radius = { control: 8, message: 10, panel: 12, sheet: 16 }`; `space = { compact: 8, label: 12, controlX: 18, inset: 20, section: 24 }`.
  - `<StatePill state={AttentionState} />` renders text and colour: `needs-you` amber, `working` forest, `turn-finished` ink on secondary surface, `idle` muted, terminal states muted/error.

- [ ] **Step 1: Install the workspace dependency and verify metro resolves it**

Add `"@infinite/attention": "0.1.0"` to `apps/mobile/package.json` dependencies, run `npm install`, then create `apps/mobile/src/theme.ts` and a temporary `apps/mobile/src/app/index.tsx` that imports `PROVIDER_NAMES` from `@infinite/attention` and renders `PROVIDER_NAMES.claude`. Run `npx expo export --platform android` in `apps/mobile`.
Expected: export succeeds. If metro cannot resolve the package, add to `apps/mobile/tsconfig.json` `"compilerOptions": { "paths": { "@infinite/attention": ["../../packages/attention/src/index.ts"] }, "baseUrl": "." }` and create `apps/mobile/metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../..")];
config.resolver.extraNodeModules = { "@infinite/attention": path.resolve(__dirname, "../../packages/attention/src") };
module.exports = config;
```

and retry. Record which path was needed in the commit message.

- [ ] **Step 2: Move code**

`api/client.ts` takes the `api()` function from the old `App.tsx` and adds `method`/`DELETE` support and `ApiError`:

```ts
import type { Attention } from "@infinite/attention";
export type Connection = { url: string; token: string };
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly attention?: Attention) { super(message); }
}
export async function api<T>(connection: Connection, path: string, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${connection.url}/api${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${connection.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok) throw new ApiError(value.error ?? "Host request failed", response.status, typeof value.error === "string" ? value.error : undefined, value.attention);
    return value as T;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new ApiError("The host did not respond. Input delivery may be uncertain.", 0);
    throw error;
  } finally { clearTimeout(timer); }
}
export type SessionRow = { id: string; title: string; provider: Provider; status: string; createdAt: string; pid?: number; seq: number; attention: Attention };
export type SessionDetail = SessionRow & { screen?: string; context: string; contextVersion: number; initialPrompt: string };
export type Me = { role: "owner" | "controller" | "viewer"; environment: string; capabilities?: { signals: boolean; answer: boolean; push: boolean } };
export type LogEvent = { seq: number; at: string; type: string; data: Record<string, unknown> };
```

(import `Provider` from `@infinite/attention`.)

`api/usePoll.ts` generalises the two polling effects in the old file: a `useEffect` with `active`/`polling` flags, `AppState` listener, `setTimeout(poll, intervalMs)` and a `refresh()` that clears the timer and polls now.

`store/connection.ts` wraps SecureStore with the same key and options as before.

`features/pair/Pair.tsx` is the old pairing form (hero, two fields, Connect button, footnote) using `theme`. `features/inbox/Inbox.tsx` is the old `Sessions` list unchanged in behaviour but using `usePoll` and `SessionRow`; rows navigate to `/session/[id]`. `features/session/Terminal.tsx` is the old `Detail` component's "Catch up" screen view plus the raw key row and composer, reading `SessionDetail` through `usePoll` every 1500 ms; the "Recording" and "Context" tabs are dropped (the Brief replaces them; context stays reachable later if wanted). `app/session/[id]/terminal.tsx` renders it; `app/session/[id]/index.tsx` renders `Brief`, which for this task simply renders `<Terminal />` so navigation works end-to-end.

`app/_layout.tsx` keeps the Stack with `headerShown: false` and the paper background.

- [ ] **Step 3: Lint, typecheck, run**

Run: `cd apps/mobile && npx expo lint && npx tsc --noEmit && npx expo export --platform android && npx expo export --platform ios`
Expected: clean. On the emulator: pairing, list, open a session, see the screen, send text, go back.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile
git commit -m "refactor(mobile): split App.tsx into api, store, theme, pair, inbox and terminal route"
```

---

### Task 13: Inbox grouped by attention

**Files:**
- Modify: `apps/mobile/src/features/inbox/Inbox.tsx`
- Create: `apps/mobile/src/components/StatePill.tsx`, `apps/mobile/src/components/SourceTag.tsx`

**Interfaces:**
- Consumes: `SessionRow.attention`.
- Produces: `groupSessions(rows)` and `groupFor(att)` in `packages/attention/src/inbox.ts` (pure, tested with node:test), imported by `Inbox.tsx`; `<StatePill state />`; `<SourceTag hooks source? />`.

- [ ] **Step 1: Add `groupSessions` to the shared package with a test**

`packages/attention/src/inbox.ts`:

```ts
import type { Attention } from "./types.js";
export type InboxGroup = "Needs you" | "Working" | "Finished" | "Exited";
export function groupFor(att: Attention): InboxGroup {
  switch (att.state) {
    case "needs-you": return "Needs you";
    case "working": return "Working";
    case "turn-finished": case "idle": return "Finished";
    default: return "Exited";
  }
}
export function groupSessions<T extends { attention: Attention; createdAt: string }>(rows: T[]): { title: InboxGroup; rows: T[] }[] {
  const order: InboxGroup[] = ["Needs you", "Working", "Finished", "Exited"];
  const byGroup = new Map<InboxGroup, T[]>(order.map((g) => [g, []]));
  for (const row of rows) byGroup.get(groupFor(row.attention))!.push(row);
  return order.map((title) => ({ title, rows: byGroup.get(title)!.sort((a, b) => (a.attention.since < b.attention.since ? 1 : -1)) })).filter((g) => g.rows.length);
}
```

Export from `index.ts`. Test in `tests/attention-inbox.test.ts`: four rows, one per state, come back in the fixed order; empty groups are omitted; within a group, newer `since` first.

- [ ] **Step 2: Components**

`StatePill.tsx`:

```tsx
import { Text, View, StyleSheet } from "react-native";
import type { AttentionState } from "@infinite/attention";
import { theme } from "../theme";
const LABEL: Record<AttentionState, string> = { "needs-you": "Needs you", working: "Working", "turn-finished": "Turn finished", idle: "Idle", exited: "Exited", unavailable: "Unreachable", "recording-error": "Recording error" };
export function StatePill({ state }: { state: AttentionState }) {
  const tone = state === "needs-you" ? s.amber : state === "working" ? s.forest : state === "recording-error" || state === "unavailable" ? s.error : s.muted;
  const text = state === "needs-you" ? s.amberText : state === "working" ? s.forestText : state === "recording-error" || state === "unavailable" ? s.errorText : s.mutedText;
  return <View style={[s.pill, tone]} accessibilityLabel={`State: ${LABEL[state]}`}><Text style={[s.text, text]}>{LABEL[state]}</Text></View>;
}
const s = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: "flex-start" },
  text: { fontSize: 12, fontWeight: "600" },
  amber: { backgroundColor: theme.colors.warningSurface }, amberText: { color: theme.colors.warningInk },
  forest: { backgroundColor: theme.colors.secondarySurface }, forestText: { color: theme.colors.running },
  muted: { backgroundColor: theme.colors.screenSurface }, mutedText: { color: theme.colors.mutedInk },
  error: { backgroundColor: "#f3dcd8" }, errorText: { color: theme.colors.error },
});
```

`SourceTag.tsx` renders "hooks active" / "screen only" in metadata size, and for a prompt `source === "screen"` the text "detected from screen".

- [ ] **Step 3: Inbox rows**

Replace the flat list in `Inbox.tsx` with `groupSessions(rows)` sections. Each section has a small-caps heading (`theme.colors.mutedInk`, 12 px, letter-spacing 0.6) and rows:

```tsx
<Pressable accessibilityRole="button" accessibilityLabel={`Open ${row.title}`} onPress={() => router.push({ pathname: "/session/[id]", params: { id: row.id } })}
  style={({ pressed }) => [s.row, row.attention.state === "needs-you" && s.rowNeedsYou, pressed && s.pressed]}>
  <View style={s.rowTop}>
    <Text style={s.title} numberOfLines={1}>{row.title}</Text>
    <StatePill state={row.attention.state} />
  </View>
  <Text style={s.now} numberOfLines={2}>
    {row.attention.prompt?.destructive ? <Text style={s.destructive}>⚠ </Text> : null}{row.attention.now || "—"}
  </Text>
  <Text style={s.meta}>{PROVIDER_NAMES[row.provider]} · {timeAgo(row.attention.since)}</Text>
</Pressable>
```

with `rowNeedsYou: { borderLeftWidth: 3, borderLeftColor: theme.colors.warningInk, paddingLeft: 12 }`, `destructive: { color: theme.colors.error }`, and `timeAgo(iso)` returning "just now", "4 min", "2 h", "3 d". Keep the header (brand, connection dot, Checked time), the stale warning, the running count, the empty state and the Disconnect footer.

- [ ] **Step 4: Verify**

Run: host tests (`npm test`), then `npx expo lint && npx tsc --noEmit` in `apps/mobile`. On the emulator with three rehearsal sessions (`dialog`, plain, `yesno` after answering), the inbox shows Needs you, Working and Finished sections in that order with pills and now lines.

- [ ] **Step 5: Commit**

```bash
git add packages/attention/src/inbox.ts packages/attention/src/index.ts tests/attention-inbox.test.ts apps/mobile/src
git commit -m "feat(mobile): inbox grouped by attention with state pills and now lines"
```

---

### Task 14: Brief with Now card and DecisionCard

**Files:**
- Create: `apps/mobile/src/components/NowCard.tsx`, `apps/mobile/src/components/DecisionCard.tsx`, `apps/mobile/src/components/Composer.tsx`
- Modify: `apps/mobile/src/features/session/Brief.tsx`

**Interfaces:**
- Consumes: `SessionDetail.attention`, `api()` with `ApiError`, `POST /sessions/:id/answer`, `POST /sessions/:id/input`, `POST /sessions/:id/key`.
- Produces: `<DecisionCard prompt onAnswer(option?: number, text?: string) busy status />`, `<NowCard attention provider onOpenTerminal />`, `<Composer canSteer onSend(text) onInterrupt receipt error />`.

- [ ] **Step 1: DecisionCard**

```tsx
import { useState } from "react";
import { Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import type { Prompt } from "@infinite/attention";
import { theme } from "../theme";
import { Button } from "./Button";

export type DecisionStatus = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "still-open" } | { kind: "changed" } | { kind: "error"; message: string };

export function DecisionCard({ prompt, onAnswer, status, canAnswer, onOpenTerminal }: {
  prompt: Prompt; canAnswer: boolean; status: DecisionStatus;
  onAnswer: (option?: number, text?: string) => void; onOpenTerminal: () => void;
}) {
  const [reply, setReply] = useState("");
  const busy = status.kind === "sending";
  const needsTerminal = prompt.multiSelect || !prompt.hash || prompt.options.length === 0;
  return (
    <View style={s.card} accessibilityRole="summary">
      <Text style={s.kicker}>{prompt.kind === "question" ? "Question" : prompt.kind === "elicitation" ? "Input requested" : "Approval needed"}{prompt.source === "screen" ? " · detected from screen" : ""}</Text>
      <Text style={s.title}>{prompt.title}</Text>
      {prompt.detail ? <Text selectable style={s.detail}>{prompt.detail}</Text> : null}
      {prompt.destructive ? <Text style={s.destructive}>⚠ Destructive command ({prompt.destructive.pattern.replace(/-/g, " ")})</Text> : null}
      {needsTerminal ? (
        <>
          <Text style={s.hint}>{prompt.multiSelect ? "This question allows several answers." : "The dialog has not been read from the screen yet."} Open the terminal to answer.</Text>
          <Button title="Open terminal" secondary onPress={onOpenTerminal} />
        </>
      ) : (
        <View style={s.options}>
          {prompt.options.map((o) => (
            <Pressable key={o.index} accessibilityRole="button" disabled={!canAnswer || busy} onPress={() => onAnswer(o.index)}
              style={({ pressed }) => [s.option, o.role.startsWith("accept") && s.optionAccept, o.index === prompt.highlighted && s.optionHighlighted, (pressed || busy || !canAnswer) && s.dim]}>
              <Text style={[s.optionText, o.role.startsWith("accept") && s.optionAcceptText]}>{o.index === prompt.highlighted ? "❯ " : ""}{o.label}</Text>
            </Pressable>
          ))}
          {prompt.acceptsText && prompt.kind !== "yes-no" ? (
            <View style={s.reply}>
              <TextInput accessibilityLabel="Reply instead" multiline value={reply} onChangeText={setReply} editable={canAnswer && !busy} placeholder="Reply instead: tell it what to do differently…" placeholderTextColor={theme.colors.placeholder} style={s.replyInput} maxLength={32000} />
              <Button title="Send reply" disabled={!canAnswer || busy || !reply.trim()} onPress={() => onAnswer(undefined, reply.trim())} />
            </View>
          ) : null}
        </View>
      )}
      {status.kind === "sending" ? <Text style={s.status}>Sent, waiting for the dialog to close…</Text> : null}
      {status.kind === "still-open" ? <Text style={s.statusWarn}>The dialog is still open. Check the terminal.</Text> : null}
      {status.kind === "changed" ? <Text style={s.statusWarn}>This prompt changed before the answer landed. Nothing was selected.</Text> : null}
      {status.kind === "error" ? <Text accessibilityRole="alert" style={s.statusError}>{status.message}</Text> : null}
    </View>
  );
}
const s = StyleSheet.create({
  card: { backgroundColor: theme.colors.warningSurface, borderRadius: theme.radius.panel, padding: 18, gap: 10 },
  kicker: { fontSize: 12, color: theme.colors.warningInk, fontWeight: "600" },
  title: { fontSize: 18, fontWeight: "600", color: theme.colors.ink },
  detail: { fontFamily: theme.mono, fontSize: 12, lineHeight: 18, color: theme.colors.screenInk, backgroundColor: theme.colors.paper, padding: 12, borderRadius: theme.radius.control },
  destructive: { color: theme.colors.error, fontSize: 13, fontWeight: "600" },
  hint: { fontSize: 13, color: theme.colors.mutedInk, lineHeight: 20 },
  options: { gap: 8, marginTop: 4 },
  option: { minHeight: 48, justifyContent: "center", paddingHorizontal: 14, borderRadius: theme.radius.control, backgroundColor: theme.colors.paper, borderWidth: 1, borderColor: theme.colors.rule },
  optionAccept: { backgroundColor: theme.colors.secondarySurface, borderColor: theme.colors.secondarySurface },
  optionHighlighted: { borderColor: theme.colors.forest },
  optionText: { fontSize: 14, color: theme.colors.ink }, optionAcceptText: { color: theme.colors.secondaryInk, fontWeight: "600" },
  dim: { opacity: 0.5 },
  reply: { gap: 8, marginTop: 6 },
  replyInput: { minHeight: 56, maxHeight: 140, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.message, padding: 12, fontSize: 14, color: theme.colors.ink, backgroundColor: theme.colors.white },
  status: { fontSize: 12, color: theme.colors.mutedInk }, statusWarn: { fontSize: 12, color: theme.colors.warningInk }, statusError: { fontSize: 12, color: theme.colors.error },
});
```

- [ ] **Step 2: NowCard**

Renders by `attention.state`: `needs-you` → the DecisionCard is rendered by the Brief instead (NowCard returns null); `working` → "Working" + `attention.now` + "for 3 min" from `since`; `turn-finished` → "Finished a turn" + first 280 chars of `lastMessage` with a "Read more" toggle that shows the full text; `idle` → "Waiting for your direction."; `exited` → "Process exited" with exit code if present; `unavailable` → "The host cannot reach this session. Your agent may still be running."; `recording-error` → "Recording failed. The process was suspended to protect the record." The word "done" must not appear.

- [ ] **Step 3: Brief assembly**

`Brief.tsx` polls `GET /sessions/:id` every 1500 ms and `GET /me` once. Layout: header row (back button "Sessions", connection text, "Terminal" link → `/session/[id]/terminal`), title block (title, `PROVIDER_NAMES`, `<StatePill>`, `<SourceTag hooks={attention.hooks} />`, host · Checked), optional offline banner, then a `ScrollView` with `DecisionCard` or `NowCard`, then the timeline placeholder (`Task 15` fills it), then the docked `Composer` for non-viewers.

Answer handler:

```ts
async function answer(option?: number, text?: string) {
  if (!detail?.attention.prompt) return;
  setStatus({ kind: "sending" });
  try {
    const receipt = await api<{ result: "closed" | "still-open" | "changed" }>(connection, `/sessions/${id}/answer`, { body: { requestId: Crypto.randomUUID(), promptId: detail.attention.prompt.id, ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}) } });
    setStatus(receipt.result === "closed" ? { kind: "sent" } : { kind: receipt.result });
    refresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) { setStatus({ kind: "error", message: "This prompt changed. Reloaded." }); refresh(); }
    else setStatus({ kind: "error", message: (error as Error).message });
  }
}
```

A new `requestId` is minted per tap; a "Retry" after a network error reuses the same id (store it in a ref like the old composer does for text).

`Composer.tsx` is the old composer plus the Interrupt button, with the same pending/retry semantics and receipt wording ("Delivered to terminal. Agent execution is not yet confirmed.").

- [ ] **Step 4: Verify on the emulator**

With a `dialog` rehearsal session: the Brief shows the amber DecisionCard with three options and the destructive banner; tapping option 2 shows "Sent, waiting…", then the card disappears and the Now card reads "Finished a turn" with "Removed the build directory." Tap option on a stale card after answering from `attach` on the laptop → "This prompt changed. Reloaded." Lint and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): Brief with Now card, decision card answers, docked composer"
```

---

### Task 15: Timeline of moments

**Files:**
- Create: `apps/mobile/src/components/MomentRow.tsx`, `apps/mobile/src/features/session/useSignals.ts`
- Modify: `apps/mobile/src/features/session/Brief.tsx`

**Interfaces:**
- Consumes: `deriveMoments` and `Moment` from `@infinite/attention`; `GET /sessions/:id/events?after=&types=signal,lifecycle,input-intent,input-result`.
- Produces: `useSignals(connection, id): { events: SignalEvent[]; loading: boolean }` keeping ≤ 2,000 signal events, paging with `after` until `more` is false, then polling every 1500 ms.

- [ ] **Step 1: `useSignals`**

Same shape as the old Detail polling loop, but requests `types=signal,lifecycle,input-intent,input-result`, keeps only `type === "signal"` events in state (lifecycle used only to stop polling on `exited`), and trims to the last 2,000.

- [ ] **Step 2: `MomentRow`**

```tsx
export function MomentRow({ moment }: { moment: Moment }) {
  const [open, setOpen] = useState(false);
  const glyph = { command: "$", edit: "✎", quiet: "…", decision: "?", turn: "◆", notice: "!" }[moment.kind];
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={s.row}>
      <Text style={[s.glyph, moment.kind === "turn" && s.glyphTurn]}>{glyph}</Text>
      <View style={s.body}>
        <Text style={[s.title, moment.kind === "command" && s.mono, moment.status === "failed" && s.failed]} numberOfLines={open ? undefined : 2}>
          {moment.destructive ? <Text style={s.destructive}>⚠ </Text> : null}{moment.title}{moment.count && moment.count > 1 ? ` ×${moment.count}` : ""}
        </Text>
        {moment.detail ? <Text style={s.detail} numberOfLines={open ? undefined : 1}>{moment.detail}</Text> : null}
        {moment.status === "running" ? <Text style={s.running}>running</Text> : null}
        {open ? moment.expanded.map((x, i) => (<View key={i} style={s.expanded}><Text style={s.expandedLabel}>{x.label}</Text><Text selectable style={s.mono}>{x.text}</Text></View>)) : null}
        <Text style={s.time}>{new Date(moment.at).toLocaleTimeString()}{moment.source === "screen" ? " · detected from screen" : ""}</Text>
      </View>
    </Pressable>
  );
}
```

Styles: row with bottom rule, glyph column 24 px in `mutedInk` (turn dividers in `forest`), `failed` in error red, `destructive` in error red, `mono` with `theme.mono` 12/18, time in metadata size.

- [ ] **Step 3: Wire into the Brief**

Under the Now card: heading "So far" with a count, then `deriveMoments(events).map((m) => <MomentRow key={m.id} moment={m} />)`; an empty state "Nothing recorded yet. Signals appear here as the agent works." For providers without hooks and no signals yet, the empty state adds "This provider reports through the screen only."

- [ ] **Step 4: Verify on the emulator**

With a `dialog hook` session answered: the timeline shows, newest first, "Removed the build directory." (turn), the decision row "Do you want to proceed? · Yes, and don't ask again… · answered from this device", the command row `rm -rf build` with ⚠ and "exit 0 · 0.0s", and the turn row "dialog hook". Expanding the command shows its input JSON. Lint and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): So far timeline derived from signals"
```

---

### Task 16: Push registration and notification routing

**Files:**
- Create: `apps/mobile/src/push/register.ts`, `apps/mobile/src/push/handler.ts`
- Modify: `apps/mobile/app.json`, `apps/mobile/package.json`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/features/pair/Pair.tsx` (register after pairing), `apps/mobile/src/features/inbox/Inbox.tsx` (unregister on disconnect), `README.md` (owner steps already written in Task 10; verify they match)

**Interfaces:**
- Produces: `registerForPush(connection): Promise<"registered" | "denied" | "unavailable">`, `unregisterPush(connection): Promise<void>`, `installNotificationHandler()` (module scope), `useNotificationRouting()` hook used in `_layout.tsx`.

- [ ] **Step 1: Install**

Run in `apps/mobile`: `npx expo install expo-notifications expo-device`
Add to `app.json` plugins: `["expo-notifications", { "icon": "./assets/notification-icon.png", "color": "#23654e", "defaultChannel": "attention" }]`; create a 96×96 white-on-transparent PNG at `assets/notification-icon.png` (export the existing monochrome icon at that size with `sips -z 96 96 assets/android-icon-monochrome.png --out assets/notification-icon.png`). Add `"extra": { "eas": { "projectId": "<set by eas init>" } }` only when the owner has run `eas init`; until then `registerForPush` returns `"unavailable"` and the UI says so.

- [ ] **Step 2: Registration**

```ts
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api, type Connection } from "../api/client";

const TOKEN_KEY = "infinite.push.v1";
export async function registerForPush(connection: Connection): Promise<"registered" | "denied" | "unavailable"> {
  const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId || !Device.isDevice && Platform.OS === "ios") return "unavailable";
  if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("attention", { name: "Needs your attention", importance: Notifications.AndroidImportance.MAX });
  const current = await Notifications.getPermissionsAsync();
  const status = current.status === "granted" ? current.status : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return "denied";
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api(connection, "/devices/push", { body: { token, platform: Platform.OS === "ios" ? "ios" : "android" } });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  Notifications.addPushTokenListener(async (next) => {
    try { await api(connection, "/devices/push", { body: { token: next.data, platform: Platform.OS === "ios" ? "ios" : "android" } }); await SecureStore.setItemAsync(TOKEN_KEY, next.data); } catch { /* retried on next launch */ }
  });
  return "registered";
}
export async function unregisterPush(connection: Connection) {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await api(connection, "/devices/push", { method: "DELETE", body: { token } }).catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
```

`handler.ts`:

```ts
import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
export function installNotificationHandler() {
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
}
function redirect(n: Notifications.Notification) {
  const url = n.request.content.data?.url;
  if (typeof url === "string" && url.startsWith("/session/")) router.push(url as never);
}
export function useNotificationRouting() {
  useEffect(() => {
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) redirect(last.notification);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => redirect(r.notification));
    return () => sub.remove();
  }, []);
}
```

Call `installNotificationHandler()` at module scope in `_layout.tsx` and `useNotificationRouting()` inside the layout component. After a successful pair, call `registerForPush` and show the result as a footnote ("Notifications on", "Notifications off: permission denied", or "Notifications unavailable until this build has an EAS project id"). Disconnect calls `unregisterPush` before clearing the connection. Also call `registerForPush` once on cold start when a connection exists and `/me` reports `capabilities.push === true`, so a token missing after a reinstall is re-registered.

- [ ] **Step 3: Verify**

`npx expo lint && npx tsc --noEmit && npx expo export --platform android`. On the emulator without an EAS project id: pairing shows "Notifications unavailable…" and nothing is posted to `/devices/push`. With the owner's EAS and FCM setup complete and `push.enabled: true` on the host: a `dialog` session produces a notification "Needs your approval · Claude Code… in Dialog" (the rehearsal provider reports as Rehearsal) on the emulator with Google Play services; tapping it opens the Brief. If the owner setup is not done, record that push was verified against the fake endpoint only (Task 9) and leave this line unchecked.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): push registration, attention channel, notification deep links"
```

---

### Task 17: Phone verification pass and screenshots

**Files:** none in the repo; screenshots in the scratchpad.

- [ ] **Step 1: Full emulator pass**

Start `npm run dev`; `adb reverse tcp:4780 tcp:4780; adb reverse tcp:8081 tcp:8081`; `npm run android -w @infinite/mobile`. Create from the laptop: a `dialog hook` session, a `yesno` session, a plain session, and stop one with `POST /api/sessions/:id/stop`. Walk: pair → inbox (four groups) → Brief of the dialog session → answer option 1 → timeline → Terminal route → back → composer send on the plain session → Interrupt → disconnect. Capture a screenshot per screen with `adb exec-out screencap -p > <scratchpad>/<name>.png` and review them against spec §9.

- [ ] **Step 2: Enlarged text**

Set Android font scale to 1.3 (`adb shell settings put system font_scale 1.3`) and confirm the DecisionCard options stay ≥ 48 dp and labels wrap without clipping. Reset to 1.0 afterwards.

- [ ] **Step 3: Exports**

Run: `npm run export:android -w @infinite/mobile && npm run export:ios -w @infinite/mobile && npm run check`
Expected: all pass.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A apps/mobile packages tests
git commit -m "fix(mobile): verification pass adjustments"
```

(Skip if nothing changed.)

---

## Phase D — Live spikes (owner approval required before each; they use provider quota)

### Task 18: S1 — Claude Code live verification

**Files:**
- Create: `tests/fixtures/screens/claude-permission.txt` (replace the synthetic fixture with the capture), `tests/fixtures/hooks/claude-*.json` (captured payloads with `cwd`/`transcript_path` redacted)
- Modify: `packages/attention/src/prompts.ts` if the real layout needs it; the spec's §13 register

- [ ] **Step 1: Ask the owner**

Stop and ask: "S1 runs one real Claude Code turn on the rehearsal workspace (`ls -la` with a permission prompt). It uses your Claude quota. Proceed?" Continue only on a yes.

- [ ] **Step 2: Run**

With `npm run dev` running and `.local/config.json` having `"claude": { "command": "claude", "args": [] }`, create: `provider: "claude"`, `title: "S1"`, `prompt: "Run `ls -la` in this directory and report how many entries there are. Do not do anything else."`. Watch `GET /api/sessions/:id` every second (a small loop with `curl` and the owner token) until `needs-you`. Save the detail JSON, the `screen` text, and `GET /events?types=signal` to the scratchpad. Answer with option 0 through `POST /answer` from the phone or `curl`. Wait for `turn-finished`; save again.

- [ ] **Step 3: Record**

Confirm: `hooks: "active"`; `prompt.source` is `hook` with options from the screen; `answer.result` is `closed`; `turn-end.message` is non-empty; `PermissionRequest` arrived before the dialog was detected. Copy the screen into `tests/fixtures/screens/claude-permission.txt` and the hook payloads (redacted) into `tests/fixtures/hooks/`. Add a parser test case per captured payload shape if anything differed from the synthetic ones; fix `prompts.ts` until the real screen parses with the correct options and highlighted index.

- [ ] **Step 4: Spec register and commit**

Append to spec §13: `| S1 | 2026-MM-DD | Claude Code 2.1.289: hooks injected via --settings, PermissionRequest + screen merge + option answer verified | …`.

```bash
git add tests/fixtures packages/attention/src docs/superpowers/specs
git commit -m "test(attention): real Claude Code permission dialog fixtures from spike S1"
```

### Task 19: S2 — Codex live verification

**Files:**
- Create: `tests/fixtures/screens/codex-command.txt` (replace), `tests/fixtures/hooks/codex-*.json`, `tests/fixtures/osc/codex.txt`
- Modify: `packages/attention/src/codex.ts` (`mapCodexOsc` wording), `packages/host/src/launch.ts` and its test if `-c hooks.*` is rejected, spec §3.3 and §13

- [ ] **Step 1: Ask the owner**

Stop and ask: "S2 runs one real Codex turn (`ls -la` with on-request approval). It uses your Codex quota. Proceed?" Continue only on a yes.

- [ ] **Step 2: Check the `-c hooks` override offline first**

Run: `codex -c 'hooks.Stop=[{hooks=[{type="command",command="true"}]}]' --dangerously-bypass-hook-trust --help`
Expected: help prints without a config parse error. If Codex rejects the key, remove the hook rows from `buildLaunch` (keep `notify`, `tui.*`), update `tests/host-launch.test.ts`, and amend spec §3.3 by deleting row 1 and D8's first clause.

- [ ] **Step 3: Run**

Config `"codex": { "command": "codex", "args": ["-a", "on-request", "-s", "workspace-write"] }`. Same prompt and procedure as S1. Additionally dump the raw `output` events around the approval to find the OSC 9 text (`printf '%s' "$text" | grep -a $'\x1b]9;'`) and save it to `tests/fixtures/osc/codex.txt`.

- [ ] **Step 4: Record**

Update `mapCodexOsc` to match the captured wording exactly (replace the `/approval/i` heuristics with the literal prefixes), add a test case, replace the synthetic Codex screen fixture, and verify `detectPrompt` finds the options and marker (`›`). Confirm `notify` delivered `turn-end` with a message.

- [ ] **Step 5: Spec register and commit**

Append S2's outcome to spec §13, including whether `-c hooks.*` worked.

```bash
git add tests/fixtures packages docs/superpowers/specs
git commit -m "test(attention): real Codex approval fixtures and OSC wording from spike S2"
```
