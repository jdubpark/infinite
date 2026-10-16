# Delegate agent — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the owner is unreachable, an owner-configured delegate agent can clear blocked cloud sessions by answering prompts and sending text, strictly within an owner-written policy that the host enforces on every action, with every action attributed and reviewable.

**Architecture:** A fourth device role, `delegate`, can monitor, claim control without takeover, send text, and answer prompts. The host evaluates every delegate answer against a per-project policy (ordered deny and approve rules over prompt kind, option role, derived scope, and destructive match) plus an hourly cap before any keystroke, and journals refusals. A host-side runner polls attention, waits the configured delay, briefs a configured agent command over stdin, parses one JSON decision from its stdout, and performs that decision over the loopback HTTP API with the delegate key, so the policy path is identical for the built-in runner and any external delegate. An SSE attention stream lets external delegates wake without polling.

**Tech Stack:** TypeScript on Node.js 22, Express, zod, `node:test` via `tsx`, `@infinite/attention` prompt classification, React web client, Expo mobile client.

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md` (sections "Connectors and roles", "Delegate agent", "Honesty rule", "API summary", "Security", "Testing").

**Depends on:** Plan `2026-10-16-context-bundle-and-inbox.md` Task 1 (worker `note` op and host notices in Chat). Run that plan first.

## Global Constraints

- Node.js 22.14+. `npm run check` before declaring host work complete; mobile lint and `tsc --noEmit` for phone changes.
- The host never infers task completion and never approves a provider permission on its own. The delegate's authority is exactly the owner's written policy; the host, not the delegate, decides. `turn-finished` is never upgraded to "done".
- Deny wins over approve. No matching approve rule means deny. A session in a project with no policy entry receives no delegate action.
- A delegate key never creates, resumes, stops, resizes, or configures; never forces input past an open prompt; never takes over control.
- The delegate agent runs under its own provider account. The delegate device key is read by the runner from a private file and never placed in the agent's environment or arguments.
- No private paths or secrets in tracked files. Tests use `/tmp/inf-*`.
- Commit messages: no `Claude-Session:` trailers.

## Scope decisions recorded here

- **Runner performs the action, the agent only decides.** The agent command receives a briefing on stdin and returns one JSON decision. The runner, holding the delegate key, performs the answer or text through the HTTP API. This keeps the key out of model context and still exercises the exact policy path any external delegate hits. The spec's "Its token is placed in the delegate agent's environment" line is amended by Task 7.
- **Option role names follow the attention package:** `accept`, `accept-always`, `reject`, `reject-with-feedback`, `other`. The spec's policy example uses `allow`/`allow-always` and is amended by Task 7.
- **Hourly cap and back-off are in API-process memory.** An API restart resets them. Documented in Task 7.
- **Cloud browser profile** stays a follow-up, as the spec lists it.

## Review Focus

1. **A destructive prompt must never be approved under a deny-destructive policy, whatever approve rules say.** Property test in Task 2; end-to-end in Task 5 with the demo `rm -rf build` dialog.
2. **A delegate answer against a prompt that changed since the briefing must be refused.** The worker's existing prompt-id and screen-hash checks apply; the route additionally compares the live prompt id. Test in Task 3.
3. **A delegate text while a prompt is open must be refused even with `force: true`.** Test in Task 3.
4. **A delegate must not take control from a human.** `takeover: true` from a delegate key returns 403; `control-busy` makes the runner skip, not retry. Tests in Tasks 3 and 5.
5. **Three consecutive denials back the runner off for one hour and notify the owner.** Test in Task 5.

---

### Task 1: The `delegate` role

**Files:**
- Modify: `packages/host/src/types.ts:2` (`Role`), `packages/host/src/config.ts:35` (tokens role enum), `packages/host/src/machine-cli.ts:72` (`device-add` role enum), `packages/host/src/server.ts` (route role lists, `/me`), `tests/helpers.ts` (fourth token)
- Modify: `apps/web/src/api.ts` (`Me.role`), `apps/mobile/src/api/client.ts` (`Me.role`)
- Test: `tests/delegate-role.test.ts` (new); extend `tests/remote-sessions.test.ts` device-add assertion

**Interfaces:**
- Produces: `Role = "owner" | "controller" | "viewer" | "delegate"`. Route matrix for delegate: GET everything a viewer can; `POST /control` (claim, renew, release; `takeover` → 403); `POST /input` (see Task 3 for refusals); `POST /answer` (see Task 3); everything else owner-or-controller-only stays closed. `/me` → `capabilities.answer: true` for delegate, `capabilities.delegate: true`.
- `startHost` in `tests/helpers.ts` creates four tokens; `host.tokens.delegate` exists.

- [ ] **Step 1: Write the failing test**

Create `tests/delegate-role.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost, waitFor } from "./helpers.js";

test("a delegate key can monitor, claim control, and is refused owner actions and takeover", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const me = await host.fetchApi("/me", "delegate");
    assert.equal(me.status, 200); assert.equal(me.body.role, "delegate"); assert.equal(me.body.capabilities.delegate, true);
    const id = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "delegate", { requestId: id, provider: "demo", projectId: "rehearsal", title: "No", prompt: "" })).status, 403);
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Watch", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    assert.equal((await host.fetchApi(`/sessions/${id}`, "delegate")).status, 200);
    assert.equal((await host.fetchApi(`/sessions/${id}/messages`, "delegate")).status, 200);
    assert.equal((await host.fetchApi(`/sessions/${id}/stop`, "delegate", { requestId: randomUUID() })).status, 403);
    assert.equal((await host.fetchApi(`/sessions/${id}/resume`, "delegate", { requestId: randomUUID() })).status, 403);
    assert.equal((await host.fetchApi(`/sessions/${id}/resize`, "delegate", { cols: 80, rows: 24 })).status, 403);
    assert.equal((await host.fetchApi(`/sessions/${id}/key`, "delegate", { requestId: randomUUID(), key: "enter" })).status, 403);
    assert.equal((await host.fetchApi(`/sessions/${id}/raw`, "delegate", { requestId: randomUUID(), text: "x" })).status, 403);
    assert.equal((await host.fetchApi(`/projects/rehearsal/context`, "delegate", { text: "x", expectedVersion: 0 }, {}, "PUT")).status, 403);
    const takeover = await host.fetchApi(`/sessions/${id}/control`, "delegate", { action: "claim", takeover: true }, { "X-Infinite-Client": randomUUID() });
    assert.equal(takeover.status, 403);
    const claim = await host.fetchApi(`/sessions/${id}/control`, "delegate", { action: "claim" }, { "X-Infinite-Client": randomUUID() });
    assert.equal(claim.status, 200); assert.ok(claim.body.control.id);
  } finally { await host.stop(); }
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/delegate-role.test.ts`
Expected: FAIL (type error for `tokens.delegate` or 401).

- [ ] **Step 3: Implement**

- `types.ts`: `export type Role = "owner" | "controller" | "viewer" | "delegate";`
- `config.ts`: `role: z.enum(["owner", "controller", "viewer", "delegate"]),`
- `machine-cli.ts` `device-add`: `z.enum(["owner", "controller", "viewer", "delegate"])`.
- `tests/helpers.ts`: add `delegate: randomBytes(32).toString("base64url"),` to `tokens`; the `tokens` map already iterates `Object.keys(tokens)`.
- `server.ts`:
  - `/me`: `answer: ["owner", "controller", "delegate"].includes(res.locals.role)` and add `delegate: res.locals.role === "delegate"` to `capabilities`.
  - `/control`: `requireRole(["owner", "controller", "delegate"])` and after parsing the body: `if (res.locals.role === "delegate" && body.takeover) return void res.status(403).json({ error: "A delegate cannot take control from another device" });`
  - `/input` and `/answer`: `requireRole(["owner", "controller", "delegate"])` (refusal logic lands in Task 3).
  - `/key`, `/raw`, `/stop`, `/resize`, `/resume`, `PUT context`, session creation: unchanged lists (delegate excluded).
- `apps/web/src/api.ts`: `role: "owner" | "controller" | "viewer" | "delegate";`. `apps/mobile/src/api/client.ts`: same.
- `tests/remote-sessions.test.ts`: after the owner `device-add` assertions add `cli("device-add", "--role", "delegate", "--name", "Delegate", "--token-file", join(root, "delegate.key"), "--config", configFile); assert.ok(readConfig(configFile).config.tokens.some(d => d.role === "delegate"));`.

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test tests/delegate-role.test.ts tests/remote-sessions.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add packages/host/src/types.ts packages/host/src/config.ts packages/host/src/machine-cli.ts packages/host/src/server.ts tests/helpers.ts tests/delegate-role.test.ts tests/remote-sessions.test.ts apps/web/src/api.ts apps/mobile/src/api/client.ts
git commit -m "Add the delegate device role"
```

---

### Task 2: Policy evaluation module

**Files:**
- Create: `packages/host/src/delegate-policy.ts`
- Test: `tests/delegate-policy.test.ts` (new)

**Interfaces:**

```ts
import type { Attention, OptionRole, Prompt, PromptKind, PromptOption } from "@infinite/attention";
export type DelegateScope = "workspace-edit" | "read-only-command" | "network-push" | "other";
export interface DelegateRule { promptKind?: PromptKind; optionRole?: OptionRole; scope?: DelegateScope; destructive?: boolean }
export interface DelegateProjectPolicy { approve: DelegateRule[]; deny: DelegateRule[]; text: boolean; plan: "none" | "feedback-only" | "approve" }
export interface PromptClassification { scopes: DelegateScope[]; destructive: boolean; plan: boolean }
export interface DelegateDecision { allowed: boolean; rule?: string; reason: string }
export function classifyPrompt(prompt: Prompt, cwd: string): PromptClassification;
export function evaluateDelegateAnswer(input: { policy?: DelegateProjectPolicy; prompt: Prompt; option: PromptOption; cwd: string; approvalsThisHour: number; cap: number }): DelegateDecision;
export function evaluateDelegateText(policy: DelegateProjectPolicy | undefined, attention: Attention): DelegateDecision;
export const EDIT_TOOLS: ReadonlySet<string>;
```

Classification:
- `destructive` = `prompt.destructive !== undefined` or `matchDestructive(command) !== null` where `command` is `prompt.tool.input.command` (string) if present, else the first line of `prompt.detail` that looks like a command for `permission` prompts without a tool.
- `plan` = `prompt.tool?.name === "ExitPlanMode"` or the title matches `/plan/i` with an accept option.
- `scopes`:
  - `workspace-edit` when `prompt.tool.name` ∈ `EDIT_TOOLS` (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `apply_patch`) and every path in the tool input (`file_path`, `path`, `notebook_path`, and `*** Update File: PATH` / `*** Add File: PATH` lines of an `apply_patch` input) resolves inside `cwd`.
  - `network-push` when the command matches `/\b(git\s+push|npm\s+publish|yarn\s+publish|pnpm\s+publish|gh\s+(pr|release)\s+create|vercel\b|netlify\b|fly\s+deploy|kubectl\s+apply|terraform\s+apply|docker\s+push|aws\s|gcloud\s|scp\s|rsync\s|ssh\s|curl\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)|wget\b[^|;&]*--post)/i`.
  - `read-only-command` when the command, split on `;`, `&&`, `||`, `|`, has every segment matching `/^\s*(ls|cat|head|tail|wc|pwd|echo|printf|grep|rg|find|fd|stat|file|which|type|tree|du|df|env|printenv|date|uname|git\s+(status|diff|log|show|branch|rev-parse|blame|ls-files|remote\s+-v)|npm\s+(ls|list|view|outdated|test|run\s+(test|lint|typecheck|check))|npx\s+(tsc|eslint|prettier\s+--check)|yarn\s+(test|lint)|pnpm\s+(test|lint)|node\s+(--version|-v)|python3?\s+(--version|-V))\b/` and no segment contains `>`, `$(`, or backticks.
  - otherwise `other`.
- Rule match: every defined field equals (`promptKind` vs `prompt.kind`, `optionRole` vs `option.role`, `scope` ∈ `scopes`, `destructive` vs classification).
- `evaluateDelegateAnswer`: no policy → deny `"no policy for this project"`; plan prompt → `plan === "none"` deny; `"feedback-only"` allow only `reject-with-feedback`/`reject`; `"approve"` allow any option (deny rules still apply after); accept roles with `approvalsThisHour >= cap` → deny `"hourly approval cap reached"`; first matching deny rule → deny with `rule: "deny[i]"`; first matching approve rule → allow with `rule: "approve[i]"`; else deny `"no approve rule matches"`.
- `evaluateDelegateText`: allow only when `policy?.text` and `attention.state` ∈ {`turn-finished`, `idle`} and no `attention.prompt`.

- [ ] **Step 1: Write the failing tests**

Create `tests/delegate-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { Prompt, PromptOption, OptionRole, PromptKind } from "@infinite/attention";
import { classifyPrompt, evaluateDelegateAnswer, evaluateDelegateText, type DelegateProjectPolicy, type DelegateRule, type DelegateScope } from "../packages/host/src/delegate-policy.js";

const cwd = "/home/dev/projects/infinite";
const options: PromptOption[] = [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "Yes, and don't ask again", role: "accept-always" }, { index: 2, label: "No, and tell Claude what to do differently", role: "reject-with-feedback" }];
const prompt = (over: Partial<Prompt>): Prompt => ({ id: 7, kind: "permission", title: "Bash command", options, acceptsText: false, source: "hook", ...over });
const policy: DelegateProjectPolicy = {
  approve: [{ promptKind: "permission", optionRole: "accept", scope: "workspace-edit" }, { promptKind: "permission", optionRole: "accept", scope: "read-only-command" }],
  deny: [{ destructive: true }, { scope: "network-push" }, { optionRole: "accept-always" }],
  text: true, plan: "feedback-only",
};

test("classifies edits inside the workspace, read-only commands, pushes, and destructive commands", () => {
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "Edit", input: { file_path: `${cwd}/src/a.ts` } } }), cwd).scopes, ["workspace-edit"]);
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "Write", input: { file_path: "/etc/passwd" } } }), cwd).scopes, ["other"]);
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch" } } }), cwd).scopes, ["workspace-edit"]);
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "Bash", input: { command: "git status && git diff" } } }), cwd).scopes, ["read-only-command"]);
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "Bash", input: { command: "ls > out.txt" } } }), cwd).scopes, ["other"]);
  assert.deepEqual(classifyPrompt(prompt({ tool: { name: "Bash", input: { command: "git push origin main" } } }), cwd).scopes, ["network-push"]);
  const rm = classifyPrompt(prompt({ tool: { name: "Bash", input: { command: "rm -rf build" } } }), cwd);
  assert.equal(rm.destructive, true); assert.deepEqual(rm.scopes, ["other"]);
  assert.equal(classifyPrompt(prompt({ detail: "rm -rf build\nRemove the stale build directory" }), cwd).destructive, true);
  assert.equal(classifyPrompt(prompt({ tool: { name: "ExitPlanMode", input: {} }, kind: "question" }), cwd).plan, true);
});

test("deny wins, no match denies, approve matches allow, cap applies to accepts only", () => {
  const edit = prompt({ tool: { name: "Edit", input: { file_path: `${cwd}/src/a.ts` } } });
  assert.equal(evaluateDelegateAnswer({ policy, prompt: edit, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).allowed, true);
  assert.equal(evaluateDelegateAnswer({ policy, prompt: edit, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).rule, "approve[0]");
  assert.equal(evaluateDelegateAnswer({ policy, prompt: edit, option: options[1], cwd, approvalsThisHour: 0, cap: 12 }).allowed, false, "accept-always is denied by rule");
  assert.equal(evaluateDelegateAnswer({ policy, prompt: edit, option: options[0], cwd, approvalsThisHour: 12, cap: 12 }).allowed, false);
  assert.match(evaluateDelegateAnswer({ policy, prompt: edit, option: options[0], cwd, approvalsThisHour: 12, cap: 12 }).reason, /cap/);
  const rm = prompt({ tool: { name: "Bash", input: { command: "rm -rf build" } } });
  assert.equal(evaluateDelegateAnswer({ policy, prompt: rm, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).allowed, false);
  assert.equal(evaluateDelegateAnswer({ policy, prompt: rm, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).rule, "deny[0]");
  assert.equal(evaluateDelegateAnswer({ policy: undefined, prompt: edit, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).allowed, false);
  const push = prompt({ tool: { name: "Bash", input: { command: "git push" } } });
  assert.equal(evaluateDelegateAnswer({ policy, prompt: push, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).rule, "deny[1]");
  const plan = prompt({ tool: { name: "ExitPlanMode", input: {} }, kind: "question" });
  assert.equal(evaluateDelegateAnswer({ policy, prompt: plan, option: options[0], cwd, approvalsThisHour: 0, cap: 12 }).allowed, false);
  assert.equal(evaluateDelegateAnswer({ policy, prompt: plan, option: options[2], cwd, approvalsThisHour: 0, cap: 12 }).allowed, true);
});

test("text is allowed only after a turn, never over an open prompt", () => {
  const base = { since: "", source: "hook" as const, now: "", lastActivityAt: "", hooks: "active" as const, hookErrors: 0, sawTurnEnd: true };
  assert.equal(evaluateDelegateText(policy, { ...base, state: "turn-finished" }).allowed, true);
  assert.equal(evaluateDelegateText(policy, { ...base, state: "working" }).allowed, false);
  assert.equal(evaluateDelegateText(policy, { ...base, state: "needs-you", prompt: prompt({}) }).allowed, false);
  assert.equal(evaluateDelegateText({ ...policy, text: false }, { ...base, state: "idle" }).allowed, false);
  assert.equal(evaluateDelegateText(undefined, { ...base, state: "idle" }).allowed, false);
});

/** Deterministic generator: invariants hold for every generated prompt, option, and policy. */
test("property: deny wins, no-match denies, allowed implies an approve match and no deny match", () => {
  let seed = 20261016;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = <T,>(items: readonly T[]) => items[rand(items.length)];
  const kinds: PromptKind[] = ["permission", "question", "elicitation", "yes-no", "menu"];
  const roles: OptionRole[] = ["accept", "accept-always", "reject", "reject-with-feedback", "other"];
  const scopes: DelegateScope[] = ["workspace-edit", "read-only-command", "network-push", "other"];
  const commands = ["git status", "rm -rf build", "git push origin x", "ls > out", "npm test", "cat README.md | head"];
  const rule = (): DelegateRule => ({ ...(rand(2) ? { promptKind: pick(kinds) } : {}), ...(rand(2) ? { optionRole: pick(roles) } : {}), ...(rand(2) ? { scope: pick(scopes) } : {}), ...(rand(3) === 0 ? { destructive: Boolean(rand(2)) } : {}) });
  const matches = (r: DelegateRule, p: Prompt, o: PromptOption) => {
    const c = classifyPrompt(p, cwd);
    return (r.promptKind === undefined || r.promptKind === p.kind) && (r.optionRole === undefined || r.optionRole === o.role) && (r.scope === undefined || c.scopes.includes(r.scope)) && (r.destructive === undefined || r.destructive === c.destructive);
  };
  for (let i = 0; i < 2000; i++) {
    const tool = rand(3) === 0 ? { name: "Edit", input: { file_path: rand(2) ? `${cwd}/x.ts` : "/tmp/x.ts" } } : { name: "Bash", input: { command: pick(commands) } };
    const p = prompt({ kind: pick(kinds), tool, options: roles.map((role, index) => ({ index, label: role, role })) });
    const o = pick(p.options);
    const pol: DelegateProjectPolicy = { approve: Array.from({ length: rand(4) }, rule), deny: Array.from({ length: rand(3) }, rule), text: Boolean(rand(2)), plan: pick(["none", "feedback-only", "approve"] as const) };
    const cap = 1 + rand(5), used = rand(7);
    const decision = evaluateDelegateAnswer({ policy: pol, prompt: p, option: o, cwd, approvalsThisHour: used, cap });
    const denyHit = pol.deny.some(r => matches(r, p, o)), approveHit = pol.approve.some(r => matches(r, p, o));
    if (denyHit) assert.equal(decision.allowed, false, `deny must win: ${JSON.stringify({ pol, p: p.tool, o })}`);
    if (!approveHit) assert.equal(decision.allowed, false, `no approve match must deny: ${JSON.stringify({ pol, p: p.tool, o })}`);
    if (decision.allowed) { assert.ok(approveHit && !denyHit); if (o.role === "accept" || o.role === "accept-always") assert.ok(used < cap); }
    if (pol.deny.some(r => r.destructive === true && Object.keys(r).length === 1) && classifyPrompt(p, cwd).destructive) assert.equal(decision.allowed, false);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/delegate-policy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/host/src/delegate-policy.ts`:

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import { matchDestructive, type Attention, type OptionRole, type Prompt, type PromptKind, type PromptOption } from "@infinite/attention";

export type DelegateScope = "workspace-edit" | "read-only-command" | "network-push" | "other";
export interface DelegateRule { promptKind?: PromptKind; optionRole?: OptionRole; scope?: DelegateScope; destructive?: boolean }
export interface DelegateProjectPolicy { approve: DelegateRule[]; deny: DelegateRule[]; text: boolean; plan: "none" | "feedback-only" | "approve" }
export interface PromptClassification { scopes: DelegateScope[]; destructive: boolean; plan: boolean }
export interface DelegateDecision { allowed: boolean; rule?: string; reason: string }

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "bash"]);
const NETWORK = /\b(git\s+push|npm\s+publish|yarn\s+publish|pnpm\s+publish|gh\s+(pr|release)\s+create|vercel\b|netlify\b|fly\s+deploy|kubectl\s+apply|terraform\s+apply|docker\s+push|aws\s|gcloud\s|scp\s|rsync\s|ssh\s|curl\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)|wget\b[^|;&]*--post)/i;
const READ_ONLY = /^\s*(ls|cat|head|tail|wc|pwd|echo|printf|grep|rg|find|fd|stat|file|which|type|tree|du|df|env|printenv|date|uname|git\s+(status|diff|log|show|branch|rev-parse|blame|ls-files|remote\s+-v)|npm\s+(ls|list|view|outdated|test|run\s+(test|lint|typecheck|check))|npx\s+(tsc|eslint|prettier\s+--check)|yarn\s+(test|lint)|pnpm\s+(test|lint)|node\s+(--version|-v)|python3?\s+(--version|-V))\b/;

const inside = (root: string, path: string) => { const rel = relative(root, resolve(root, path)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

function commandOf(prompt: Prompt): string | undefined {
  const input = prompt.tool?.input ?? {};
  if (prompt.tool && COMMAND_TOOLS.has(prompt.tool.name) && typeof input.command === "string") return input.command;
  if (prompt.tool && COMMAND_TOOLS.has(prompt.tool.name) && Array.isArray(input.command)) return (input.command as unknown[]).map(String).join(" ");
  if (!prompt.tool && prompt.kind === "permission" && prompt.detail) return prompt.detail.split("\n").map(l => l.trim()).find(l => l.length > 0);
  return undefined;
}
function editPaths(prompt: Prompt): string[] {
  const input = prompt.tool?.input ?? {};
  const paths: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) if (typeof input[key] === "string") paths.push(input[key] as string);
  if (typeof input.patch === "string") for (const match of (input.patch as string).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) paths.push(match[1].trim());
  if (Array.isArray(input.edits)) for (const edit of input.edits as Record<string, unknown>[]) if (typeof edit?.file_path === "string") paths.push(edit.file_path);
  return paths;
}
const readOnly = (command: string) => command.split(/\|\||&&|[;|]/).every(segment => READ_ONLY.test(segment) && !/[>`]|\$\(/.test(segment));

export function classifyPrompt(prompt: Prompt, cwd: string): PromptClassification {
  const command = commandOf(prompt);
  const destructive = prompt.destructive !== undefined || (command !== undefined && matchDestructive(command) !== null);
  const plan = prompt.tool?.name === "ExitPlanMode" || (/\bplan\b/i.test(prompt.title) && prompt.options.some(o => o.role === "accept"));
  let scope: DelegateScope = "other";
  if (prompt.tool && EDIT_TOOLS.has(prompt.tool.name)) {
    const paths = editPaths(prompt);
    if (paths.length && paths.every(path => inside(cwd, path))) scope = "workspace-edit";
  } else if (command !== undefined) {
    if (NETWORK.test(command)) scope = "network-push";
    else if (readOnly(command)) scope = "read-only-command";
  }
  return { scopes: [scope], destructive, plan };
}

function matches(rule: DelegateRule, prompt: Prompt, option: PromptOption, classification: PromptClassification) {
  return (rule.promptKind === undefined || rule.promptKind === prompt.kind)
    && (rule.optionRole === undefined || rule.optionRole === option.role)
    && (rule.scope === undefined || classification.scopes.includes(rule.scope))
    && (rule.destructive === undefined || rule.destructive === classification.destructive);
}
const accepting = (role: OptionRole) => role === "accept" || role === "accept-always";

export function evaluateDelegateAnswer(input: { policy?: DelegateProjectPolicy; prompt: Prompt; option: PromptOption; cwd: string; approvalsThisHour: number; cap: number }): DelegateDecision {
  const { policy, prompt, option } = input;
  if (!policy) return { allowed: false, reason: "no policy for this project" };
  const classification = classifyPrompt(prompt, input.cwd);
  const deny = policy.deny.findIndex(rule => matches(rule, prompt, option, classification));
  if (deny >= 0) return { allowed: false, rule: `deny[${deny}]`, reason: "a deny rule matches" };
  if (classification.plan) {
    if (policy.plan === "none") return { allowed: false, reason: "plan responses are disabled" };
    if (policy.plan === "feedback-only" && accepting(option.role)) return { allowed: false, reason: "policy allows plan feedback only" };
    if (policy.plan === "approve" || !accepting(option.role)) return { allowed: true, rule: `plan:${policy.plan}`, reason: "plan policy" };
  }
  if (accepting(option.role) && input.approvalsThisHour >= input.cap) return { allowed: false, reason: "hourly approval cap reached" };
  const approve = policy.approve.findIndex(rule => matches(rule, prompt, option, classification));
  if (approve >= 0) return { allowed: true, rule: `approve[${approve}]`, reason: "an approve rule matches" };
  return { allowed: false, reason: "no approve rule matches" };
}

export function evaluateDelegateText(policy: DelegateProjectPolicy | undefined, attention: Attention): DelegateDecision {
  if (!policy?.text) return { allowed: false, reason: "text replies are disabled for this project" };
  if (attention.prompt || attention.state === "needs-you") return { allowed: false, reason: "a prompt is open" };
  if (attention.state !== "turn-finished" && attention.state !== "idle") return { allowed: false, reason: `the agent is ${attention.state}` };
  return { allowed: true, rule: "text", reason: "turn finished" };
}
```

Check the property test's invariants against the plan branch: the test's `matches` helper ignores plan handling, so when `classification.plan` is true and `policy.plan === "approve"` the function allows without an approve-rule match. Keep the property test honest by excluding plan prompts from the generator (the generator above never produces `ExitPlanMode` and titles are "Bash command", so `plan` is always false). If the title regex ever trips, change the fixture title to "Tool request".

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test tests/delegate-policy.test.ts`
Expected: PASS (4 tests).

```bash
git add packages/host/src/delegate-policy.ts tests/delegate-policy.test.ts
git commit -m "Add delegate policy classification and evaluation"
```

---

### Task 3: Policy enforcement on `/answer` and `/input`, attribution in the journal

**Files:**
- Modify: `packages/host/src/config.ts` (`delegate` block), `packages/host/src/types.ts` (`Config.delegate`, `WorkerRequest` `by`), `packages/attention/src/types.ts` (`answer` signal `by`), `packages/host/src/worker.ts` (`requestDigest`, `answer`, `deliver`), `packages/host/src/server.ts` (enforcement, `inputAuthority`, events), `packages/host/src/session-content.ts` (answers in Chat)
- Modify: `packages/host/src/demo.ts` (a `safe-dialog` variant with a read-only command)
- Test: `tests/delegate-enforcement.test.ts` (new)

**Interfaces:**

Config:

```ts
export interface DelegateConfig {
  enabled: boolean;                       // default false
  waitMinutes: number;                    // default 10, min 0
  maxApprovalsPerSessionPerHour: number;  // default 12
  tokenFile?: string;                     // delegate device key for the built-in runner
  agent?: { command: string; args: string[] };
  projects: Record<string, DelegateProjectPolicy>;
}
```

`WorkerRequest` `answer` and `input` members gain `by?: { id: string; label: string; role: Role }`. The `answer` signal gains `by?: { id: string; label: string; role: string }`. `inputAuthority` returns `by` alongside `actor` and `leaseId` for workers with `inputControl`.

Enforcement in `/answer` when `res.locals.role === "delegate"`: load the session and live state; require `state.attention.prompt?.id === body.promptId` else 409 `prompt-changed`; resolve `option = prompt.options[body.option]` (text-only answers from a delegate are allowed only when `prompt.acceptsText` and the project policy has `text: true`); `evaluateDelegateAnswer` with the hourly count; on deny → journal `note` type `delegate-denied` (message `rule ?? reason`), emit `events.emit("delegate-denied", { sessionId, rule, reason })`, respond 403 `{ error: "policy-denied", code: "policy-denied", rule, reason }`; on allow → count the approval if the option accepts, pass through to the worker with `by`.

Enforcement in `/input` for delegate: delete `body.force`; if `state.attention.prompt` or `state.attention.state === "needs-you"` → 409 `prompt-open`; `evaluateDelegateText` → 403 `policy-denied` on deny.

`createApp` returns `events: EventEmitter` with `delegate-denied` and `delegate-acted` events.

Chat: `recordedMessages` adds for `answer` signals with `result === "closed"`: `{ id: "answer:<seq>", role: "user", toolName: by?.role === "delegate" ? "Delegate" : undefined, text: "<by.label ?? 'You'> answered: <option.label>" }`.

- [ ] **Step 1: Extend the demo fixture**

In `packages/host/src/demo.ts`, make the command variable: replace the `HEADER` and `RM_INPUT` constants with

```ts
const safe = request.includes("safe-dialog");
const COMMAND = safe ? "git status" : "rm -rf build";
const DESCRIPTION = safe ? "Show the working tree status" : "Remove the stale build directory";
const HEADER = `\nBash command\n  ${COMMAND}\n  ${DESCRIPTION}\n\nDo you want to proceed?`;
const RM_INPUT = { command: COMMAND, description: DESCRIPTION };
```

and in `selectOption` replace `tool_input: { command: "rm -rf build" }` with `tool_input: { command: COMMAND }`. The `OPTIONS` text keeps `rm commands` in the always-label; that is fine.

- [ ] **Step 2: Write the failing test**

Create `tests/delegate-enforcement.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claimControl, startHost, waitFor } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };
const delegate = {
  enabled: true, waitMinutes: 0, maxApprovalsPerSessionPerHour: 1,
  projects: { rehearsal: { approve: [{ promptKind: "permission", optionRole: "accept", scope: "read-only-command" }], deny: [{ destructive: true }, { optionRole: "accept-always" }], text: true, plan: "feedback-only" } },
};

async function openPrompt(host: Awaited<ReturnType<typeof startHost>>, prompt: string) {
  const id = randomUUID();
  await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: prompt, prompt });
  const detail = await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash && r.body.attention.prompt?.tool, 15000);
  return { id, prompt: detail.body.attention.prompt as { id: number; options: { index: number; label: string }[] } };
}

test("the host enforces delegate policy before any keystroke and attributes delegate answers", { timeout: 90000 }, async () => {
  const host = await startHost({ config: { attention, delegate } as never });
  try {
    // Destructive dialog: denied, journaled, and the dialog stays open.
    const rm = await openPrompt(host, "dialog hook");
    const rmControl = await claimControl(host, rm.id, "delegate");
    const denied = await host.fetchApi(`/sessions/${rm.id}/answer`, "delegate", { requestId: randomUUID(), promptId: rm.prompt.id, option: 0 }, rmControl.headers);
    assert.equal(denied.status, 403); assert.equal(denied.body.code, "policy-denied"); assert.equal(denied.body.rule, "deny[0]");
    assert.equal((await host.fetchApi(`/sessions/${rm.id}`)).body.attention.state, "needs-you");
    const notices = (await host.fetchApi(`/sessions/${rm.id}/events?types=signal`)).body.events as { data: { kind: string; type?: string; message?: string } }[];
    assert.ok(notices.some(e => e.data.kind === "notice" && e.data.type === "delegate-denied" && e.data.message === "deny[0]"));
    // Text over an open prompt is refused even when forced.
    const forced = await host.fetchApi(`/sessions/${rm.id}/input`, "delegate", { requestId: randomUUID(), text: "go ahead", force: true }, rmControl.headers);
    assert.equal(forced.status, 409); assert.equal(forced.body.error, "prompt-open");
    // A stale prompt id is refused before the worker is asked.
    assert.equal((await host.fetchApi(`/sessions/${rm.id}/answer`, "delegate", { requestId: randomUUID(), promptId: rm.prompt.id + 50, option: 0 }, rmControl.headers)).status, 409);
    // The owner can still answer the same dialog.
    const ownerControl = await claimControl(host, rm.id, "owner", { takeover: true });
    const ownerAnswer = await host.fetchApi(`/sessions/${rm.id}/answer`, "owner", { requestId: randomUUID(), promptId: rm.prompt.id, option: 2 }, ownerControl.headers);
    assert.equal(ownerAnswer.status, 200);

    // Read-only dialog: allowed once, attributed, then capped.
    const safe = await openPrompt(host, "safe-dialog hook");
    const control = await claimControl(host, safe.id, "delegate");
    const allowed = await host.fetchApi(`/sessions/${safe.id}/answer`, "delegate", { requestId: randomUUID(), promptId: safe.prompt.id, option: 0 }, control.headers);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body)); assert.equal(allowed.body.result, "closed");
    const signals = (await host.fetchApi(`/sessions/${safe.id}/events?types=signal`)).body.events as { data: { kind: string; by?: { role: string; label: string }; option?: { label: string } } }[];
    const answer = signals.find(e => e.data.kind === "answer")!;
    assert.equal(answer.data.by?.role, "delegate");
    const messages = (await host.fetchApi(`/sessions/${safe.id}/messages`)).body.messages as { toolName?: string; text: string }[];
    assert.ok(messages.some(m => m.toolName === "Delegate" && /answered: Yes/.test(m.text)));
    // Text after the turn finishes is allowed for this project.
    await waitFor(() => host.fetchApi(`/sessions/${safe.id}`), r => ["turn-finished", "idle"].includes(r.body.attention.state), 15000);
    const text = await host.fetchApi(`/sessions/${safe.id}/input`, "delegate", { requestId: randomUUID(), text: "Thanks, continue with the tests." }, control.headers);
    assert.equal(text.status, 200);
    // Cap: a second accept in the same hour is refused.
    const again = await openPrompt(host, "safe-dialog hook");
    const againControl = await claimControl(host, again.id, "delegate");
    const capped = await host.fetchApi(`/sessions/${again.id}/answer`, "delegate", { requestId: randomUUID(), promptId: again.prompt.id, option: 0 }, againControl.headers);
    assert.equal(capped.status, 200, "the cap is per session; a new session starts at zero");
  } finally { await host.stop(); }
});

test("a project without a policy receives no delegate action", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention, delegate: { ...delegate, projects: {} } } as never });
  try {
    const safe = await openPrompt(host, "safe-dialog hook");
    const control = await claimControl(host, safe.id, "delegate");
    const denied = await host.fetchApi(`/sessions/${safe.id}/answer`, "delegate", { requestId: randomUUID(), promptId: safe.prompt.id, option: 0 }, control.headers);
    assert.equal(denied.status, 403); assert.match(denied.body.reason, /no policy/);
  } finally { await host.stop(); }
});
```

The cap assertion at the end expects 200 because the cap is per session. To exercise the cap itself, add after it: open a third `safe-dialog hook` prompt in the **same** session is not possible with the demo fixture, so the per-session cap is covered by the unit test in Task 2 and left there.

- [ ] **Step 3: Run to verify failure**

Run: `npx tsx --test tests/delegate-enforcement.test.ts`
Expected: FAIL (config rejects `delegate`).

- [ ] **Step 4: Config and types**

`packages/host/src/config.ts`, add to the schema after `bundle`:

```ts
    delegate: z.object({
      enabled: z.boolean().default(false),
      waitMinutes: z.number().int().min(0).max(1440).default(10),
      maxApprovalsPerSessionPerHour: z.number().int().min(0).max(1000).default(12),
      tokenFile: z.string().refine(isAbsolute).optional(),
      agent: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) }).strict().optional(),
      projects: z.record(z.string().regex(/^[a-z0-9-]{1,80}$/), z.object({
        approve: z.array(delegateRule).max(64).default([]),
        deny: z.array(delegateRule).max(64).default([]),
        text: z.boolean().default(false),
        plan: z.enum(["none", "feedback-only", "approve"]).default("none"),
      }).strict()).default({}),
    }).strict().optional(),
```

with, above the schema:

```ts
const delegateRule = z.object({
  promptKind: z.enum(["permission", "question", "elicitation", "yes-no", "menu"]).optional(),
  optionRole: z.enum(["accept", "accept-always", "reject", "reject-with-feedback", "other"]).optional(),
  scope: z.enum(["workspace-edit", "read-only-command", "network-push", "other"]).optional(),
  destructive: z.boolean().optional(),
}).strict();
```

In `readConfig`, after the push checks: `if (config.delegate?.tokenFile) { const file = config.delegate.tokenFile; const rel = relative(resolve(config.stateDir), resolve(file)); if ((!rel.startsWith("..") && !isAbsolute(rel)) || (statSync(file).mode & 0o777) !== 0o600 || !/^[\x21-\x7e]{32,200}$/.test(readFileSync(file, "utf8").trim())) throw new Error("Delegate key file must be private, outside stateDir, chmod 600"); }`.

`packages/host/src/types.ts`: import `DelegateProjectPolicy` type from `./delegate-policy.js`; add to `Config`: `delegate?: { enabled: boolean; waitMinutes: number; maxApprovalsPerSessionPerHour: number; tokenFile?: string; agent?: { command: string; args: string[] }; projects: Record<string, DelegateProjectPolicy> };`. Add `by?: { id: string; label: string; role: Role }` to the `input` and `answer` members of `WorkerRequest`.

`packages/attention/src/types.ts`: change the `answer` signal to `| { kind: "answer"; promptId: number; requestId: string; option?: { index: number; label: string }; text: boolean; result: AnswerResult; by?: { id: string; label: string; role: string } }`. Run `npm run build -w @infinite/attention`.

- [ ] **Step 5: Worker attribution**

In `packages/host/src/worker.ts`:
- `requestDigest`: `const { actor: _actor, leaseId: _leaseId, by: _by, ...input } = request as DeliveryRequest & AnswerRequest & { by?: unknown };`
- In `answer`, the `record({ kind: "answer", ... }, "host")` call gains `...(request.by ? { by: request.by } : {}),` inside the signal object.
- In `deliver`, the `append("input-intent", { ...request })` already captures `by`; also pass `by` into the `input-result` append where `message` is recorded (search for `append("input-result"` in the input path and add `...(request.by ? { by: request.by } : {})`).

- [ ] **Step 6: Server enforcement**

In `packages/host/src/server.ts`:
- Imports: `import { EventEmitter } from "node:events";`, `import { evaluateDelegateAnswer, evaluateDelegateText } from "./delegate-policy.js";`.
- After `const manager = ...`: `const events = new EventEmitter();` and `const approvals = new Map<string, number[]>();` with helper

```ts
  const approvalsThisHour = (sessionId: string) => { const now = Date.now(); const list = (approvals.get(sessionId) ?? []).filter(t => now - t < 3600000); approvals.set(sessionId, list); return list.length; };
  const by = (res: express.Response) => ({ id: String(res.locals.deviceId), label: String(res.locals.actor.label), role: res.locals.role as Role });
```

- `inputAuthority`: return `{ actor: res.locals.actor, leaseId: res.locals.leaseId, by: by(res) }` when `inputControl` is present.
- `/answer` route, after `const body = answerSchema.parse(req.body);` add:

```ts
      if (res.locals.role === "delegate") {
        const session = manager.meta(sessionId).session;
        const state = await manager.state(sessionId);
        const prompt = state.attention.prompt;
        if (!prompt || prompt.id !== body.promptId) return void res.status(409).json({ error: "prompt-changed", attention: state.attention });
        const policy = config.delegate?.projects[session.projectId];
        const option = body.option !== undefined ? prompt.options[body.option] : undefined;
        const decision = option
          ? evaluateDelegateAnswer({ policy, prompt, option, cwd: session.cwd, approvalsThisHour: approvalsThisHour(sessionId), cap: config.delegate?.maxApprovalsPerSessionPerHour ?? 12 })
          : prompt.acceptsText && policy?.text ? { allowed: true, rule: "text", reason: "text answer" } : { allowed: false, reason: "text answers are not allowed here" };
        if (!decision.allowed) {
          await workerCall(config.runDir, sessionId, { op: "note", type: "delegate-denied", message: decision.rule ?? decision.reason, detail: decision.reason }).catch(() => {});
          events.emit("delegate-denied", { sessionId, title: session.title, rule: decision.rule, reason: decision.reason });
          return void res.status(403).json({ error: "policy-denied", code: "policy-denied", rule: decision.rule, reason: decision.reason });
        }
        if (option && (option.role === "accept" || option.role === "accept-always")) approvals.set(sessionId, [...(approvals.get(sessionId) ?? []), Date.now()]);
        events.emit("delegate-acted", { sessionId, title: session.title, rule: decision.rule, option: option?.label });
      }
```

- `/input` route, after `const body = inputSchema.parse(req.body);` add:

```ts
      if (res.locals.role === "delegate") {
        delete body.force;
        const session = manager.meta(sessionId).session;
        const state = await manager.state(sessionId);
        if (state.attention.prompt || state.attention.state === "needs-you") return void res.status(409).json({ error: "prompt-open", attention: state.attention });
        const decision = evaluateDelegateText(config.delegate?.projects[session.projectId], state.attention);
        if (!decision.allowed) return void res.status(403).json({ error: "policy-denied", code: "policy-denied", reason: decision.reason });
        events.emit("delegate-acted", { sessionId, title: session.title, rule: "text" });
      }
```

- Return `events` from `createApp`.

`packages/host/src/session-content.ts`: add in `recordedMessages` after the notice branch:

```ts
    } else if (event.type === "signal" && data.kind === "answer" && data.result === "closed" && data.option && typeof (data.option as { label?: unknown }).label === "string") {
      const by = data.by as { label?: string; role?: string } | undefined;
      messages.push({ id: `answer:${event.seq}`, role: "user", ...(by?.role === "delegate" ? { toolName: "Delegate" } : {}), text: `${by?.label ?? "You"} answered: ${(data.option as { label: string }).label}`, ts: event.at });
```

- [ ] **Step 7: Run and commit**

Run: `npm run build -w @infinite/attention && npx tsx --test tests/delegate-enforcement.test.ts tests/worker-attention.test.ts tests/attention-reducer.test.ts`
Expected: PASS. The attention tests still pass because `by` is optional.

```bash
git add packages/host/src/config.ts packages/host/src/types.ts packages/attention/src/types.ts packages/host/src/worker.ts packages/host/src/server.ts packages/host/src/session-content.ts packages/host/src/demo.ts tests/delegate-enforcement.test.ts
git commit -m "Enforce delegate policy on answers and text and attribute delegate actions"
```

---

### Task 4: Attention stream for delegates

**Files:**
- Create: `packages/host/src/attention-stream.ts`
- Modify: `packages/host/src/server.ts` (route)
- Test: `tests/attention-stream.test.ts` (new)

**Interfaces:**

```ts
export interface AttentionTransition { sessionId: string; title: string; provider: Provider; projectId: string; from: AttentionState | null; to: AttentionState; prompt?: { id: number; kind: PromptKind; title: string; options: { index: number; label: string; role: OptionRole }[]; destructive: boolean; tool?: string }; at: string }
export async function* attentionTransitions(manager: Pick<Manager, "list">, signal: AbortSignal, intervalMs = 2000): AsyncGenerator<AttentionTransition>;
```

Route: `GET /api/attention/stream` (owner, delegate) → `text/event-stream`; each transition is `event: attention\ndata: <json>\n\n`; a `: keep-alive\n\n` comment every 15 s; the first poll emits nothing (priming), so clients get only changes.

- [ ] **Step 1: Write the failing test**

Create `tests/attention-stream.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

test("the attention stream reports needs-you transitions with the open prompt and refuses viewers", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { attention } });
  try {
    assert.equal((await fetch(`${host.origin}/api/attention/stream`, { headers: { Authorization: `Bearer ${host.tokens.viewer}` } })).status, 403);
    const response = await fetch(`${host.origin}/api/attention/stream`, { headers: { Authorization: `Bearer ${host.tokens.delegate}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Stream", prompt: "safe-dialog hook" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "", found: { sessionId: string; to: string; prompt?: { tool?: string; options: unknown[] } } | undefined;
    const deadline = Date.now() + 30000;
    while (!found && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n").slice(0, -1)) {
        const data = block.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.sessionId === id && event.to === "needs-you") found = event;
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
    assert.ok(found, "a needs-you transition arrived");
    assert.equal(found!.prompt?.tool, "Bash");
    assert.equal(found!.prompt?.options.length, 3);
    await reader.cancel();
  } finally { await host.stop(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/attention-stream.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

Create `packages/host/src/attention-stream.ts`:

```ts
import { setTimeout as delay } from "node:timers/promises";
import type { AttentionState, OptionRole, PromptKind, Provider } from "@infinite/attention";
import type { Manager } from "./manager.js";

export interface AttentionTransition {
  sessionId: string; title: string; provider: Provider; projectId: string;
  from: AttentionState | null; to: AttentionState;
  prompt?: { id: number; kind: PromptKind; title: string; options: { index: number; label: string; role: OptionRole }[]; destructive: boolean; tool?: string };
  at: string;
}
type Row = { id: string; title: string; provider: Provider; projectId: string; attention: { state: AttentionState; prompt?: { id: number; kind: PromptKind; title: string; options: { index: number; label: string; role: OptionRole }[]; destructive?: unknown; tool?: { name: string } } } };

/** Yields one transition per session whose attention state or open prompt changed since the previous poll. */
export async function* attentionTransitions(manager: Pick<Manager, "list">, signal: AbortSignal, intervalMs = 2000): AsyncGenerator<AttentionTransition> {
  const seen = new Map<string, { key: string; state: AttentionState }>();
  let primed = false;
  while (!signal.aborted) {
    const rows = (await manager.list().catch(() => [])) as unknown as Row[];
    const at = new Date().toISOString();
    for (const row of rows) {
      const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
      const previous = seen.get(row.id);
      seen.set(row.id, { key, state: row.attention.state });
      if (!primed || previous?.key === key) continue;
      const prompt = row.attention.prompt;
      yield {
        sessionId: row.id, title: row.title, provider: row.provider, projectId: row.projectId,
        from: previous?.state ?? null, to: row.attention.state, at,
        ...(prompt ? { prompt: { id: prompt.id, kind: prompt.kind, title: prompt.title, options: prompt.options, destructive: prompt.destructive !== undefined, ...(prompt.tool ? { tool: prompt.tool.name } : {}) } } : {}),
      };
    }
    primed = true;
    await delay(intervalMs, undefined, { signal }).catch(() => {});
  }
}
```

Route in `server.ts` (before the `/api` 404 handler):

```ts
  app.get("/api/attention/stream", requireRole(["owner", "delegate"]), async (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const keepAlive = setInterval(() => { if (!res.destroyed) res.write(": keep-alive\n\n"); }, 15000);
    try { for await (const transition of attentionTransitions(manager, abort.signal)) if (!res.destroyed) res.write(`event: attention\ndata: ${JSON.stringify(transition)}\n\n`); }
    finally { clearInterval(keepAlive); res.end(); }
  });
```

Import `attentionTransitions`.

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test tests/attention-stream.test.ts`
Expected: PASS.

```bash
git add packages/host/src/attention-stream.ts packages/host/src/server.ts tests/attention-stream.test.ts
git commit -m "Stream attention transitions to owners and delegates"
```

---

### Task 5: Delegate runner

**Files:**
- Create: `packages/host/src/delegate-runner.ts`, `tests/fixtures/delegate-agent.mjs`
- Modify: `packages/host/src/cli.ts:278-310` (`serve` wiring), `packages/host/src/server.ts` (`GET /api/delegate/activity`)
- Test: `tests/delegate-runner.test.ts` (new)

**Interfaces:**

```ts
export interface DelegateDecision = { action: "answer"; option: number } | { action: "text"; text: string } | { action: "none"; reason: string };
export interface DelegateActivity { at: string; sessionId: string; title: string; action: "answer" | "text" | "none" | "denied" | "skipped" | "error" | "backoff"; detail: string }
export interface DelegateRunnerOptions {
  manager: Pick<Manager, "list" | "meta" | "state" | "events">;
  config: Config;                 // reads config.delegate
  origin: string;                 // loopback API origin
  token: string;                  // delegate device key
  intervalMs?: number;            // default 5000
  agentTimeoutMs?: number;        // default 120000
  now?: () => number;
  onEvent?: (event: { type: "delegate-backoff" | "delegate-denied" | "delegate-acted" | "delegate-error"; sessionId: string; title: string; detail: string }) => void;
}
export class DelegateRunner {
  constructor(options: DelegateRunnerOptions);
  start(): void; stop(): void;
  tick(): Promise<void>;
  activity(): DelegateActivity[];   // last 100, newest first
}
export function buildBriefing(input: { session: Session; state: WorkerState; messages: ChatMessage[]; policy?: DelegateProjectPolicy }): string;
export function parseDecision(stdout: string): DelegateDecision;
```

Behavior:
- `tick`: for each `manager.list()` row with `backend !== "cmux"`, `executionLocation !== "laptop"`, a policy entry for its project, and attention `needs-you` or `turn-finished`: key = `${state}:${promptId}`; record first-seen time per `(sessionId, key)`; skip if handled, if a run is active for that session, or if the session is backed off; when `now - firstSeen >= waitMinutes * 60000`, run.
- `run`: build the briefing from `manager.meta`, `manager.state(id, false)`, and `recordedMessages(manager, session, "0", 200)` (last 40); spawn `config.delegate.agent.command` with `args`, write the briefing to stdin, collect stdout up to 1 MiB with the timeout; `parseDecision` takes the last line that parses as a JSON object with a valid `action`. Then act over HTTP against `origin` with `Authorization: Bearer <token>`, `X-Infinite-Client: <runner uuid>`: claim control (`POST /control {action:"claim"}`); on 409 `control-busy` → activity `skipped` and mark handled; then `POST /answer` or `POST /input` with `X-Infinite-Control`; release control in `finally`. 403 `policy-denied` → activity `denied`, increment consecutive denials for the session; three in a row → `backoff` until `now + 3600000`, `onEvent("delegate-backoff")`. A 200 resets the denial count and emits `delegate-acted`. `none` → handled, activity `none`. Agent failure or unparseable output → activity `error`, `onEvent("delegate-error")`, handled for this key.
- Briefing (plain text with one JSON block) ends with: `Reply with exactly one JSON object on the last line of your output: {"action":"answer","option":N} to pick option N, {"action":"text","text":"..."} to send a message, or {"action":"none","reason":"..."} to leave it for the owner. Only options the policy allows will be executed; the host refuses anything else.`
- Route: `GET /api/delegate/activity` (owner) → `{ activity: DelegateActivity[] }` from a runner registered on the app via `app.locals.delegateRunner` (set by `cli.ts`), `[]` when none.
- `cli.ts` `serve`: when `config.delegate?.enabled && config.delegate.agent && config.delegate.tokenFile`, read the token, `new DelegateRunner({ manager, config, origin: \`http://127.0.0.1:${config.port}\`, token, onEvent })`, `start()`, store on `app.locals`. `onEvent` for `delegate-backoff` and `delegate-error` sends a push through the existing `pushStore`/`expoSender` when push is enabled: title `Delegate needs you`, body `${title}: ${detail}`.

Test fixture `tests/fixtures/delegate-agent.mjs`:

```js
// Reads the briefing from stdin and always picks option 0 (the accept option) when a prompt is open;
// otherwise says nothing. Deterministic stand-in for a model.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const briefing = JSON.parse(input.slice(input.indexOf("{"), input.lastIndexOf("}") + 1));
  console.log("Thinking about it…");
  if (briefing.attention?.prompt) console.log(JSON.stringify({ action: "answer", option: 0 }));
  else console.log(JSON.stringify({ action: "none", reason: "nothing to do" }));
});
```

`buildBriefing` must therefore emit the briefing JSON object as one block between the human-readable header and the instruction line, so `indexOf("{")`/`lastIndexOf("}")` isolate it. Structure: header line, blank line, the JSON, blank line, instruction.

- [ ] **Step 1: Write the failing test**

Create `tests/delegate-runner.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Manager } from "../packages/host/src/manager.js";
import { DelegateRunner, parseDecision } from "../packages/host/src/delegate-runner.js";
import { startHost, waitFor } from "./helpers.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };
const agent = { command: process.execPath, args: [resolve("tests/fixtures/delegate-agent.mjs")] };
const policy = { approve: [{ promptKind: "permission", optionRole: "accept", scope: "read-only-command" }], deny: [{ destructive: true }], text: true, plan: "none" };

test("parseDecision takes the last JSON object line and rejects garbage", () => {
  assert.deepEqual(parseDecision('thinking\n{"action":"answer","option":0}\n'), { action: "answer", option: 0 });
  assert.deepEqual(parseDecision('{"action":"none","reason":"x"}'), { action: "none", reason: "x" });
  assert.throws(() => parseDecision("no json here"), /decision/);
  assert.throws(() => parseDecision('{"action":"stop"}'), /decision/);
  assert.throws(() => parseDecision('{"action":"text","text":""}'), /decision/);
});

test("the runner answers an allowed prompt, is refused on a destructive one, and backs off after three denials", { timeout: 120000 }, async () => {
  const delegate = { enabled: true, waitMinutes: 0, maxApprovalsPerSessionPerHour: 12, agent, projects: { rehearsal: policy } };
  const host = await startHost({ config: { attention, delegate } as never });
  const events: { type: string; sessionId: string }[] = [];
  const manager = new Manager(host.config, readFileSync(host.config.keyFile));
  const runner = new DelegateRunner({ manager, config: { ...host.config, delegate } as never, origin: host.origin, token: host.tokens.delegate, intervalMs: 500, onEvent: e => events.push(e) });
  try {
    const safe = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: safe, provider: "demo", projectId: "rehearsal", title: "Safe", prompt: "safe-dialog hook" });
    await waitFor(() => host.fetchApi(`/sessions/${safe}`), r => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    await runner.tick();
    await waitFor(() => host.fetchApi(`/sessions/${safe}`), r => r.body.attention.state !== "needs-you", 15000);
    const signals = (await host.fetchApi(`/sessions/${safe}/events?types=signal`)).body.events as { data: { kind: string; by?: { role: string }; result?: string } }[];
    assert.ok(signals.some(e => e.data.kind === "answer" && e.data.by?.role === "delegate" && e.data.result === "closed"));
    assert.equal(runner.activity()[0]?.action, "answer");

    const rm = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: rm, provider: "demo", projectId: "rehearsal", title: "Destructive", prompt: "dialog hook" });
    await waitFor(() => host.fetchApi(`/sessions/${rm}`), r => r.body.attention?.state === "needs-you" && r.body.attention.prompt?.hash, 15000);
    for (let i = 0; i < 3; i++) { runner.forget(rm); await runner.tick(); }
    const denied = runner.activity().filter(a => a.sessionId === rm && a.action === "denied");
    assert.equal(denied.length, 3);
    assert.ok(events.some(e => e.type === "delegate-backoff" && e.sessionId === rm));
    assert.equal((await host.fetchApi(`/sessions/${rm}`)).body.attention.state, "needs-you", "the destructive dialog is still open for the owner");
    runner.forget(rm); await runner.tick();
    assert.equal(runner.activity().filter(a => a.sessionId === rm && a.action === "denied").length, 3, "backed off: no fourth attempt");
    const activity = await host.fetchApi("/delegate/activity", "owner");
    assert.equal(activity.status, 200);
  } finally { runner.stop(); await host.stop(); }
});
```

`runner.forget(sessionId)` clears the handled marker for a session so the test can re-run the same open prompt; add it to the public interface: `forget(sessionId: string): void`.

The `GET /api/delegate/activity` route returns `[]` here because the test's runner is not the one registered on the API process; assert only on status.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/delegate-runner.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `delegate-runner.ts`**

```ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Config, Session, WorkerState } from "./types.js";
import type { Manager } from "./manager.js";
import { recordedMessages, type ChatMessage } from "./session-content.js";
import type { DelegateProjectPolicy } from "./delegate-policy.js";

export type DelegateDecision = { action: "answer"; option: number } | { action: "text"; text: string } | { action: "none"; reason: string };
export interface DelegateActivity { at: string; sessionId: string; title: string; action: "answer" | "text" | "none" | "denied" | "skipped" | "error" | "backoff"; detail: string }
export interface DelegateRunnerOptions {
  manager: Pick<Manager, "list" | "meta" | "state" | "events">;
  config: Config; origin: string; token: string;
  intervalMs?: number; agentTimeoutMs?: number; now?: () => number;
  onEvent?: (event: { type: "delegate-backoff" | "delegate-denied" | "delegate-acted" | "delegate-error"; sessionId: string; title: string; detail: string }) => void;
}
type Row = { id: string; title: string; projectId: string; backend?: string; executionLocation?: string; status: string; attention: { state: string; prompt?: { id: number } } };

export function parseDecision(stdout: string): DelegateDecision {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith("{") && l.endsWith("}")).reverse();
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const v = value as Record<string, unknown>;
    if (v.action === "answer" && Number.isInteger(v.option) && (v.option as number) >= 0 && (v.option as number) <= 50) return { action: "answer", option: v.option as number };
    if (v.action === "text" && typeof v.text === "string" && v.text.trim() && v.text.length <= 32000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v.text)) return { action: "text", text: v.text };
    if (v.action === "none") return { action: "none", reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : "" };
  }
  throw new Error("The delegate agent did not return a valid decision");
}

export function buildBriefing(input: { session: Session; state: WorkerState; messages: ChatMessage[]; policy?: DelegateProjectPolicy }): string {
  const prompt = input.state.attention.prompt;
  const briefing = {
    session: { id: input.session.id, title: input.session.title, provider: input.session.provider, projectId: input.session.projectId },
    attention: { state: input.state.attention.state, now: input.state.attention.now, lastMessage: input.state.attention.lastMessage,
      ...(prompt ? { prompt: { id: prompt.id, kind: prompt.kind, title: prompt.title, detail: prompt.detail, options: prompt.options, destructive: prompt.destructive !== undefined, acceptsText: prompt.acceptsText, tool: prompt.tool?.name } } : {}) },
    recentMessages: input.messages.slice(-40).map(m => ({ role: m.role, toolName: m.toolName, text: m.text.slice(0, 2000) })),
    policy: input.policy ? { approve: input.policy.approve, deny: input.policy.deny, text: input.policy.text, plan: input.policy.plan } : null,
  };
  return [
    "You are the owner's delegate for an Infinite session. The owner is unavailable. Decide whether to unblock the session.",
    "",
    JSON.stringify(briefing, null, 2),
    "",
    'Reply with exactly one JSON object on the last line of your output: {"action":"answer","option":N} to pick option N, {"action":"text","text":"..."} to send a message, or {"action":"none","reason":"..."} to leave it for the owner. Only options the policy allows will be executed; the host refuses anything else. Never approve destructive or network-publishing actions.',
    "",
  ].join("\n");
}

export class DelegateRunner {
  private readonly firstSeen = new Map<string, number>();
  private readonly handled = new Set<string>();
  private readonly running = new Set<string>();
  private readonly denials = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly log: DelegateActivity[] = [];
  private readonly clientId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: DelegateRunnerOptions) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs ?? 5000); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  activity() { return [...this.log].reverse().slice(0, 100); }
  forget(sessionId: string) { for (const key of [...this.handled]) if (key.startsWith(`${sessionId}:`)) this.handled.delete(key); for (const key of [...this.firstSeen.keys()]) if (key.startsWith(`${sessionId}:`)) this.firstSeen.delete(key); }
  private record(entry: Omit<DelegateActivity, "at">) { this.log.push({ at: new Date().toISOString(), ...entry }); if (this.log.length > 500) this.log.shift(); }

  async tick(): Promise<void> {
    const delegate = this.options.config.delegate;
    if (!delegate?.enabled || !delegate.agent) return;
    const rows = (await this.options.manager.list()) as unknown as Row[];
    const wait = delegate.waitMinutes * 60000;
    for (const row of rows) {
      if (row.backend === "cmux" || row.executionLocation === "laptop" || row.status !== "running" || !delegate.projects[row.projectId]) continue;
      if (!["needs-you", "turn-finished"].includes(row.attention.state)) continue;
      const key = `${row.id}:${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, this.now());
      if (this.handled.has(key) || this.running.has(row.id)) continue;
      if ((this.backoffUntil.get(row.id) ?? 0) > this.now()) continue;
      if (this.now() - this.firstSeen.get(key)! < wait) continue;
      this.handled.add(key);
      this.running.add(row.id);
      try { await this.run(row.id, row.title, delegate.projects[row.projectId]); }
      finally { this.running.delete(row.id); }
    }
  }

  private async run(sessionId: string, title: string, policy: DelegateProjectPolicy) {
    const session = this.options.manager.meta(sessionId).session;
    const state = await this.options.manager.state(sessionId, false);
    const messages = recordedMessages(this.options.manager as Manager, session, "0", 200).messages;
    let decision: DelegateDecision;
    try { decision = parseDecision(await this.ask(buildBriefing({ session, state, messages, policy }))); }
    catch (error) { this.record({ sessionId, title, action: "error", detail: (error as Error).message }); this.options.onEvent?.({ type: "delegate-error", sessionId, title, detail: (error as Error).message }); return; }
    if (decision.action === "none") { this.record({ sessionId, title, action: "none", detail: decision.reason }); return; }
    const api = async (path: string, body: unknown, control?: string) => {
      const response = await fetch(`${this.options.origin}/api/sessions/${sessionId}${path}`, { method: "POST", headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json", "X-Infinite-Client": this.clientId, ...(control ? { "X-Infinite-Control": control } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    };
    const claim = await api("/control", { action: "claim" });
    if (claim.status !== 200) { this.record({ sessionId, title, action: "skipped", detail: claim.status === 409 ? "another device holds control" : `control ${claim.status}` }); return; }
    const lease = (claim.body.control as { id: string }).id;
    try {
      const result = decision.action === "answer"
        ? await api("/answer", { requestId: randomUUID(), promptId: state.attention.prompt?.id ?? 0, option: decision.option }, lease)
        : await api("/input", { requestId: randomUUID(), text: decision.text }, lease);
      if (result.status === 200) {
        this.denials.set(sessionId, 0);
        const detail = decision.action === "answer" ? `answered option ${decision.option} (${String(result.body.result ?? "delivered")})` : "sent text";
        this.record({ sessionId, title, action: decision.action, detail });
        this.options.onEvent?.({ type: "delegate-acted", sessionId, title, detail });
      } else if (result.status === 403 && result.body.code === "policy-denied") {
        const count = (this.denials.get(sessionId) ?? 0) + 1;
        this.denials.set(sessionId, count);
        const detail = `${String(result.body.rule ?? result.body.reason ?? "policy")}`;
        this.record({ sessionId, title, action: "denied", detail });
        this.options.onEvent?.({ type: "delegate-denied", sessionId, title, detail });
        if (count >= 3) { this.backoffUntil.set(sessionId, this.now() + 3600000); this.denials.set(sessionId, 0); this.record({ sessionId, title, action: "backoff", detail: "three consecutive refusals" }); this.options.onEvent?.({ type: "delegate-backoff", sessionId, title, detail: "three consecutive policy refusals; waiting an hour" }); }
      } else this.record({ sessionId, title, action: "error", detail: `${result.status} ${String(result.body.error ?? "")}` });
    } finally { await api("/control", { action: "release", leaseId: lease }, lease).catch(() => {}); }
  }

  private ask(briefing: string): Promise<string> {
    const agent = this.options.config.delegate!.agent!;
    return new Promise((resolve, reject) => {
      const child = spawn(agent.command, agent.args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "C.UTF-8" } });
      let out = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("The delegate agent timed out")); }, this.options.agentTimeoutMs ?? 120000);
      child.stdout.on("data", chunk => { out += chunk; if (out.length > 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("The delegate agent produced too much output")); } });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", () => { clearTimeout(timer); resolve(out); });
      child.stdin.on("error", () => {});
      child.stdin.end(briefing);
    });
  }
}
```

The agent process environment contains only `PATH`, `HOME`, and `LANG`: no Infinite variables, no delegate key. A real agent profile points `command` at the provider CLI in print mode (for example `claude` with `-p --output-format text`, or `codex exec -`), authenticated under the delegate's own account in that `HOME`.

- [ ] **Step 4: Wire `serve` and the activity route**

In `packages/host/src/server.ts` add before the 404 handler:

```ts
  app.get("/api/delegate/activity", requireRole(["owner"]), (_req, res) => {
    const runner = app.locals.delegateRunner as { activity: () => unknown[] } | undefined;
    res.json({ activity: runner?.activity() ?? [] });
  });
```

In `packages/host/src/cli.ts` `serve` branch, after `const { sessions, pushStore, server, closeConnections } = createApp(config, key);` (also destructure `app` and `manager`), add after the push setup:

```ts
    if (config.delegate?.enabled && config.delegate.agent && config.delegate.tokenFile) {
      const runner = new DelegateRunner({
        manager, config, origin: `http://127.0.0.1:${config.port}`, token: readFileSync(config.delegate.tokenFile, "utf8").trim(),
        onEvent: event => {
          if (!config.push?.enabled || !["delegate-backoff", "delegate-error"].includes(event.type)) return;
          const devices = pushStore.list();
          if (!devices.length) return;
          void sender(devices.map(d => ({ to: d.token, title: "Delegate needs you", body: `${event.title}: ${event.detail}`, data: { url: `/session/${event.sessionId}`, machineId: config.machine?.id }, channelId: "attention" as const, priority: "high" as const, collapseId: `delegate:${event.sessionId}` }))).catch(() => {});
        },
      });
      runner.start();
      app.locals.delegateRunner = runner;
      console.log("Delegate runner active for projects: " + Object.keys(config.delegate.projects).join(", "));
    }
```

where `sender` is the `expoSender(...)` instance the push block already creates; hoist it so both uses share it (create it when `config.push?.enabled` regardless of the Notifier). Import `DelegateRunner`.

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test tests/delegate-runner.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add packages/host/src/delegate-runner.ts packages/host/src/server.ts packages/host/src/cli.ts tests/fixtures/delegate-agent.mjs tests/delegate-runner.test.ts
git commit -m "Run a policy-bound delegate agent against blocked sessions"
```

---

### Task 6: Show the responder on web and phone

**Files:**
- Modify: `apps/web/src/main.tsx` (signal timeline renderer for `answer` signals; search for `"answer"` in the timeline component), `apps/mobile/src/features/session/Brief.tsx` or `useSignals.ts` (same)
- Modify: `apps/web/src/main.tsx` session detail: a small "Delegate activity" list for owners reading `GET /api/delegate/activity` (optional when the machine is reached through the relay: the route is not relayed, so render only for the direct machine)

- [ ] **Step 1: Web timeline**

Find the timeline entry rendering for `data.kind === "answer"` in `apps/web/src/main.tsx` (search `kind === "answer"` or the signal label map). Append ` · by ${data.by.label}${data.by.role === "delegate" ? " (delegate)" : ""}` when `data.by` is present. Chat already shows "Delegate" through `recordedMessages`.

- [ ] **Step 2: Mobile timeline**

In the mobile signal description (`apps/mobile/src/features/session/useSignals.ts` or where `answer` signals are summarized), add the same suffix.

- [ ] **Step 3: Delegate activity (web, owner, direct machine only)**

In the session detail or a settings area, add for `me.role === "owner" && machines.active.id === "direct"` a collapsed `<details>` titled "Delegate activity" that fetches `/delegate/activity` on open and lists `at · title · action · detail`. Skip if the layout has no natural place; the Chat attribution is the required surface.

- [ ] **Step 4: Typecheck, lint, build, commit**

Run: `npm run typecheck && npm run build -w @infinite/web && npm run lint -w @infinite/mobile && (cd apps/mobile && npx tsc --noEmit)`

```bash
git add apps/web/src apps/mobile/src
git commit -m "Show who answered a prompt, including the delegate"
```

---

### Task 7: Documentation and spec amendments

**Files:**
- Create: `docs/delegate.md`
- Modify: `PRODUCT.md` ("Capabilities and Constraints"), `docs/architecture.md` (roles, routes), `docs/security.md` ("Threats that remain"), `docs/remote-machines.md` (device-add roles), `docs/cli.md` (host commands mention), `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md`

- [ ] **Step 1: `docs/delegate.md`**

```
# Delegate agent

A delegate is an owner-configured agent that clears blocked cloud sessions while the owner is unreachable. It acts only within the owner's written policy. The host checks every delegate answer against that policy before any keystroke and journals every action and refusal. The host still never approves a permission on its own and never infers task completion.

## Role

`device-add --role delegate` creates a delegate device key. A delegate can list and read sessions, claim control when nobody holds it, send text after a turn, and answer prompts the policy allows. It cannot create, resume, stop, or resize sessions, send raw keys, edit configuration, take control from another device, or force text past an open prompt.

## Policy

Host configuration:

```json
{
  "delegate": {
    "enabled": true,
    "waitMinutes": 10,
    "maxApprovalsPerSessionPerHour": 12,
    "tokenFile": "/private/delegate.key",
    "agent": { "command": "claude", "args": ["-p", "--output-format", "text"] },
    "projects": {
      "example": {
        "approve": [
          { "promptKind": "permission", "optionRole": "accept", "scope": "workspace-edit" },
          { "promptKind": "permission", "optionRole": "accept", "scope": "read-only-command" }
        ],
        "deny": [
          { "destructive": true },
          { "scope": "network-push" },
          { "optionRole": "accept-always" }
        ],
        "text": true,
        "plan": "feedback-only"
      }
    }
  }
}
```

`approve` and `deny` are ordered rule lists. A rule matches when every field it names matches the prompt: `promptKind` (`permission`, `question`, `elicitation`, `yes-no`, `menu`), `optionRole` (`accept`, `accept-always`, `reject`, `reject-with-feedback`, `other`), `scope`, and `destructive`. Deny wins. No matching approve rule means deny. A project with no entry receives no delegate action.

Scopes are derived by the host from the prompt: `workspace-edit` for an edit tool whose paths are inside the workspace; `read-only-command` for a command made only of listing, reading, status, diff, and test commands with no redirection or substitution; `network-push` for push, publish, deploy, or data-sending commands; `other` for everything else. `destructive` uses the shared destructive pattern list. Plan prompts follow `plan`: `none`, `feedback-only` (rejections only), or `approve`. `text: true` allows a text message when a turn has finished and no prompt is open.

The hourly approval cap counts accepts per session in API-process memory. Three consecutive refusals in one session back the built-in runner off for an hour and notify the owner. Both counters reset when the API restarts.

## Built-in runner

With `enabled`, `agent`, and `tokenFile` set, the API runs a delegate loop. It polls attention, and when a session in a configured project has been in `needs-you` or `turn-finished` for `waitMinutes`, it spawns the agent command with a briefing on stdin: session, open prompt with options and classification, the last 40 chat messages, and the policy summary. The agent replies with one JSON decision. The runner performs that decision through the HTTP API with the delegate key, exactly as an external delegate would, so the same policy check applies. The agent process receives only `PATH`, `HOME`, and `LANG`; the delegate key never enters its environment or arguments. Point `command` at a provider CLI in non-interactive mode, authenticated in that `HOME` under the delegate's own account.

`GET /api/delegate/activity` (owner) lists the runner's recent decisions and refusals. Each delegate answer is journaled with `by: { id, label, role: "delegate" }` and shown in Chat as "Delegate".

## External delegates

Any process holding a delegate key can subscribe to `GET /api/attention/stream` (server-sent events of attention transitions with the open prompt) and act through `/control`, `/input`, and `/answer`. The host applies the same policy and attribution.

## Limits

The delegate cannot clear a web login, a prompt whose tool and command cannot be classified, or anything the policy denies; those remain `needs-you` for the owner. A refused delegate answer leaves the dialog open. Counters live in memory. cmux sessions and `--laptop` sessions are not delegated.
```

- [ ] **Step 2: Other docs**

`PRODUCT.md` "Capabilities and Constraints": after `Do not infer task completion from an idle terminal or automatically approve provider permissions.` add `An owner-configured delegate may answer prompts only within the owner's written policy; the host enforces that policy on every answer, journals every refusal, and attributes every delegate action. The delegate never infers completion either.`

`docs/architecture.md`: in the paragraph above the API table, add `Device roles are owner, controller, viewer, and delegate; see [delegate](delegate.md) for the fourth.` Add rows:

```
| Answer / send text as a delegate, within policy | `POST /api/sessions/:id/answer`, `/input` | Delegate |
| Attention stream | `GET /api/attention/stream` | Owner, delegate |
| Delegate activity | `GET /api/delegate/activity` | Owner |
```

`docs/security.md` "Threats that remain" add:

```
- A delegate agent decides within the owner's policy, but the model can be manipulated by session content into choosing a permitted option it should not. The policy, cap, back-off, and attribution bound that damage; they do not make the delegate trustworthy. Keep deny rules for destructive and network-publishing actions. The delegate's own provider account and `HOME` are separate from the owner's.
```

`docs/remote-machines.md`: in the `device-add` paragraph change `An owner key permits creation, resumption, and termination; a controller key permits steering; a viewer key permits monitoring.` to add `; a delegate key permits policy-bound answers and text, see [delegate](delegate.md)`.

`docs/cli.md`: no change beyond the role list if it enumerates roles; otherwise skip.

- [ ] **Step 3: Spec amendments**

In the spec "Delegate agent" section:
- Replace `Its token is placed in the delegate agent's environment on the host, never in a client or in the repository.` with `Its token is read by the host runner from a private file and used for the runner's own HTTP calls. It never enters the agent's environment or arguments.`
- Replace the runner sentence `a runner that launches the delegate agent with a briefing...` with `a runner that briefs the delegate agent over stdin and performs the agent's single JSON decision through the HTTP API with the delegate key, so the policy path is identical for the built-in runner and an external delegate.`
- In the policy example replace `"optionRole": "allow"` with `"optionRole": "accept"` and `"optionRole": "allow-always"` with `"optionRole": "accept-always"`.
- In "Security", replace `The delegate token lives in the delegate agent's environment on the host, so the delegate agent can read it.` with `The delegate token lives in a private file read by the host runner; the agent process receives only PATH, HOME, and LANG.`

- [ ] **Step 4: Scan and commit**

Run: `git add -A docs PRODUCT.md && git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'`
Expected: `/private/delegate.key` is a documentation placeholder, not a home path; no other hits.

```bash
git commit -m "Document the delegate role, policy, and runner"
```

---

### Task 8: Full check

- [ ] Run: `npm run check && npm run lint -w @infinite/mobile && (cd apps/mobile && npx tsc --noEmit)`
Expected: clean.
