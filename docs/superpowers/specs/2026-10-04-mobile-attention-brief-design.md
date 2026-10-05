# Mobile attention Brief — design

Status: design approved in chat on 2026-10-04 (approach A); this document is the written spec for review.
Builds on: `README.md`, `PRODUCT.md`, `docs/architecture.md`, `DESIGN.md`.
Reference material: jevcode's Brief ("Now / So far"), decision cards and destructive-command classifier (its console-and-explainer design document). No code is copied from jevcode except the destructive pattern list, which is reproduced with attribution.

## 1. Summary

The phone app stops being a terminal mirror. Opening it answers three questions per session within a few seconds: is the agent working, blocked on me, or finished with its turn; if blocked, what exactly is it asking; and what has it done that matters. Blocked sessions are answered with one tap on the dialog's real options. Direction is given from a composer that is always one thumb away. The terminal remains available as a secondary screen.

The host makes this possible by gathering **signals**: structured facts about what the agent is doing, taken from provider hooks (Claude Code, Codex) and from the terminal screen the worker already maintains (all providers). Signals are appended to the existing encrypted journal, and the worker derives one **attention state** per session. The API exposes signals, attention, a structured **answer** endpoint, and a push-notification registration. The phone renders an inbox, a Brief, a decision card, a timeline and a composer from those.

### Goals

- Per session, one truthful state: `working`, `needs-you`, `turn-finished`, `idle`, plus the existing `exited`, `unavailable`, `recording-error`.
- When `needs-you`: the prompt header, the tool or command concerned, the option labels as the TUI shows them, and a destructive flag, answerable with one tap.
- A timeline of moments that matter: commands, file edits, errors, questions and answers, turn boundaries with the agent's own last message.
- Push notification on the phone when a session needs the person, finishes a turn, exits or hits a recording error.
- Verified for Claude Code and Codex through hooks; usable for Grok, OpenCode and the rehearsal provider through screen heuristics.

### Non-goals

- No automatic approval. A signal never answers a permission prompt. Only a person's tap or a laptop keystroke does.
- No task-completion inference. `turn-finished` means the agent said it finished a turn; it is shown with the agent's words, never as "done".
- No model calls on the host. All classification is rule-based.
- No change to the web client beyond keeping it working. No change to session creation (owner, laptop).
- No notification action buttons that answer from the lock screen. Approving a command without seeing it contradicts `PRODUCT.md`.
- No provider-native structured sessions (Codex app-server, Claude Agent SDK). Recorded as future work in §13.

## 2. Terms

| Term | Meaning |
| --- | --- |
| Signal | One structured fact appended to the journal as an event of type `signal`. Has a `kind` and a `source`. |
| Source | Where a signal came from: `hook` (Claude Code or Codex hook payload), `osc` (terminal notification sequence emitted by the TUI), `screen` (parsed from the xterm buffer), `host` (produced by Infinite itself, such as an answer). |
| Attention | The worker's derived per-session state object (§5). |
| Prompt | A dialog the agent has open and is waiting on: permission request, question, elicitation, yes/no, or a generic menu. |
| Moment | A row in the phone timeline, derived on the client from signals (§9.3). Not stored. |
| Brief | The session screen on the phone: Now card, So far timeline, composer. |

## 3. Signal sources

Sources are layered. A hook signal wins over a screen signal for the same fact. Screen heuristics are always on and are what Grok, OpenCode and the rehearsal provider get. Every signal carries its `source`, and the phone labels heuristic facts "detected from screen".

### 3.1 Hook listener in the worker

The worker owns the session process and outlives the API, so it also owns the hook endpoint.

- On start, the worker opens an HTTP listener on `127.0.0.1` with an ephemeral port and generates a 32-byte random token. It sets `INFINITE_HOOK_URL=http://127.0.0.1:<port>/hook` and `INFINITE_HOOK_TOKEN=<hex>` in the child's environment only when the provider is `claude`, `codex` or `demo`.
- Routes: `POST /hook/claude`, `POST /hook/codex`, `POST /hook/codex-notify`. Each requires `Authorization: Bearer <token>`. Body limit 256 KiB, JSON only. The worker records the signal and responds `204` with an empty body at once. It never returns a decision object, so Claude Code's and Codex's own dialogs always appear and the laptop can keep answering them.
- Any request that fails authentication, exceeds the limit or fails to parse is dropped and counted; the count is exposed in worker state as `hookErrors` and surfaced by `doctor`.
- Threat: the agent process can read its own environment and could post forged hook payloads. Signals are therefore evidence about the agent, not an authority over it. They are labeled by source, they never trigger approval, and the screen heuristics continue to run independently. `docs/security.md` gains a paragraph on this.

### 3.2 Claude Code

Injected at launch with a single extra argument, `--settings <json>`, appended after the profile's configured args and before the prompt. The JSON contains only `hooks`. Each handler is `{"type":"http","url":"$INFINITE_HOOK_URL/claude","headers":{"Authorization":"Bearer $INFINITE_HOOK_TOKEN"},"allowedEnvVars":["INFINITE_HOOK_TOKEN"],"timeout":5}` with no matcher, under these events:

| Event | Signal produced | Notes |
| --- | --- | --- |
| `UserPromptSubmit` | `turn-start` | Also fires for text typed on the laptop, so the phone sees every turn. |
| `PreToolUse` | `tool-start` | `tool_name`, `tool_input` (truncated per §4.3), `tool_use_id`, `agent_id`/`agent_type` when inside a subagent. `AskUserQuestion` opens a `question` prompt. |
| `PostToolUse` | `tool-end` ok | Includes `duration_ms`; Bash `tool_response.bashEditDiff.changedFiles` becomes `files`. |
| `PostToolUseFailure` | `tool-end` failed | Error text truncated. |
| `PermissionRequest` | `prompt-open` kind `permission` | `tool_name`, `tool_input`, `permission_suggestions`. Fires at once, before the six-second notification. |
| `PermissionDenied` | `prompt-closed` reason `resolved` | |
| `Notification` | `notice`, and for `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` a `prompt-open` if none is open | `idle_prompt` confirms `turn-finished`. |
| `Elicitation` | `prompt-open` kind `elicitation` | `mcp_server_name`, `message`, `mode`. |
| `Stop` | `turn-end` | `last_assistant_message` (truncated to 4,000 chars), `background_tasks.length`. `stop_hook_active` is recorded. |
| `StopFailure` | `error` and `turn-end` without message | |
| `SessionEnd` | `notice` | `reason`. |

Verified on 2026-10-04 against the official hooks reference (`code.claude.com/docs/en/hooks.md`) and the installed 2.1.289 binary. `--settings` merges with the person's own user and project hooks; theirs keep running. If the person's settings define `allowedHttpHookUrls`, the loopback URL must be allowed there; `doctor` detects this and prints the fix. The port is per session, so the allowlist entry is a prefix pattern if Claude Code supports one, otherwise the person disables the allowlist for this host. This is the only known configuration conflict.

Permission dialog option labels in the binary: "Yes", "Yes, and don't ask again for …", "No, and tell Claude what to do differently", "Yes, and switch to auto mode". These are shown as tappable buttons with the exact text read from the screen (§3.4), not from a hard-coded list; the hook only tells us a permission is pending and for what.

### 3.3 Codex

Codex hooks are command hooks only, so the host ships a relay: `packages/host/src/hook-relay.ts`, built to `dist/hook-relay.js`. It reads stdin (hook JSON) or `argv[2]` (notify JSON), POSTs to `$INFINITE_HOOK_URL/<route>` with the token, and exits 0 silently within 2 seconds regardless of outcome.

Injected per process with repeatable `-c` overrides appended after the profile's args:

1. `-c 'hooks.PermissionRequest=[{hooks=[{type="command",command="node <relay> codex"}]}]'` and the same for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `Interrupt`; plus `--dangerously-bypass-hook-trust` so the injected hooks run without a persisted trust hash. The flag only affects hooks Infinite itself injects for this process. Whether `-c` accepts inline-table arrays for `hooks.*` is unconfirmed and is spike S2 (§11.4).
2. `-c 'notify=["node","<relay>","codex-notify"]'` → `turn-end` with `last-assistant-message`. Confirmed payload shape from the Codex source.
3. `-c 'tui.notifications=["agent-turn-complete","approval-requested","async-question"]' -c 'tui.notification_method="osc9"' -c 'tui.notification_condition="always"'` → the TUI writes OSC 9 sequences into the PTY; the worker registers an OSC 9 handler on xterm headless and turns each into a `notice` signal with `source: "osc"`. `approval-requested` opens a `permission` prompt if none is open; `async-question` opens a `question` prompt.

If (1) fails in the spike, (2) and (3) plus screen heuristics are the Codex path, and the spec is amended by removing row 1.

Codex dialog headers and default keys (from `tui/src/bottom_pane/approval_overlay.rs`): "Would you like to run the following command?", "Would you like to make the following edits?", "Do you want to approve network access to …"; options such as "Yes, proceed", "Yes, and don't ask again for this command in this session", "No, continue without running it", "No, and tell Codex what to do differently". Answering uses arrow navigation and Enter (§6), never the single-letter shortcuts, because the keymap is user-rebindable.

### 3.4 Screen heuristics (all providers)

`packages/attention/src/prompts.ts` is a pure function `detectPrompt(lines: string[], provider): DetectedPrompt | null` over the plain-text screen the worker already produces. It runs after every output flush (40 ms debounce) and on a 1 s timer while output is quiet.

Detection, in order:

1. **Numbered menu block.** A contiguous block of two or more lines matching `^\s*([❯›>]\s*)?(\d+)\.\s+(.+?)\s*$` with consecutive numbers starting at 1. The highlighted option is the line carrying the marker; if none carries it, `highlighted` is unknown. The header is the nearest non-empty line above the block that is not a box-drawing rule, up to three lines; the detail is the lines between header and options (command text, file path, question body). Kind: `permission` if the header or detail matches a known provider permission header; `question` if any option label matches `^Chat about this|^Other` or the block follows an `AskUserQuestion` tool-start; otherwise `menu`.
2. **Yes/no line.** The last non-empty line ends with `[y/N]`, `[Y/n]`, `(y/n)`, `(yes/no)` case-insensitively → kind `yes-no`, options `Yes`, `No`, answered by typing.
3. **Nothing.**

Idle detection: `idle` is true when no PTY output arrived for `attention.idleAfterMs` (default 20,000) and the last non-empty line looks like a composer (Claude Code's `>` prompt row, Codex's `›` row, or a shell prompt ending in `$ `, `% `, `> `). Idle plus a previous `turn-end` is `turn-finished`; idle without one is `idle`.

Each detected prompt carries `hash = sha256(header + options.join("\n"))` over the plain text. The hash is how the answer endpoint checks the dialog is unchanged (§6).
Amended 2026-10-05: the hashed fingerprint is `[header, ...detailLines, ...options].join("\n")`, where `detailLines` are the detail's non-empty lines with whitespace runs collapsed, so two dialogs that differ only in their command or path never share a hash.

Fixtures for the parser are real screens captured during spikes S1 and S2 and the rehearsal provider's synthetic dialogs. Grok and OpenCode have no fixture in this delivery; the generic rules apply and misses are acceptable because the terminal screen stays one tap away.

### 3.5 Destructive classification

`packages/attention/src/destructive.ts` reproduces jevcode's pattern list (`rm -rf` and long-form, `git push --force`/`-f`, `git reset --hard`, `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `db:reset`, migration down/rollback) and adds `git clean -f`, `git checkout -- .`, `git branch -D`, `chmod -R 777`, `kubectl delete`, `terraform destroy`, `docker system prune`. `matchDestructive(command)` returns the pattern name or null. It runs on every Bash `tool-start`, on every permission prompt's detail text, and on the command text inside a screen-detected prompt. The result is `destructive: { pattern }` on the signal and on the prompt. It is a flag for attention, not a block.

## 4. Journal: the `signal` event

The journal keeps its format. `Event.type` gains the value `"signal"`. `output`, `lifecycle`, `input-intent` and `input-result` are unchanged. Signals are ordered by `seq` with everything else, so replay and the recording stay one stream.

### 4.1 Common fields

```ts
interface SignalData {
  kind: SignalKind;
  source: "hook" | "osc" | "screen" | "host";
  provider: Provider;
  agent?: { id: string; type: string }; // Claude Code subagent, when present
}
```

### 4.2 Kinds

| `kind` | Extra fields | Produced by |
| --- | --- | --- |
| `hooks-ready` | `event: string` | First hook payload received (Claude `SessionStart` is not injected, so the first of any event). Lets the UI show "hooks active". |
| `turn-start` | `prompt?: string` (≤500 chars) | `UserPromptSubmit`; Codex `UserPromptSubmit`. |
| `turn-end` | `message?: string` (≤4,000), `backgroundTasks: number`, `stopHookActive?: boolean`, `failed?: boolean` | `Stop`, `StopFailure`, Codex `Stop`, `notify`. |
| `tool-start` | `tool: string`, `toolUseId?: string`, `input: Record<string, unknown>` (truncated), `quiet: boolean`, `destructive?: { pattern: string }` | `PreToolUse` (both providers). |
| `tool-end` | `tool`, `toolUseId?`, `ok: boolean`, `durationMs?`, `summary?: string` (≤300), `files?: string[]` (≤50), `error?: string` (≤1,000) | `PostToolUse`, `PostToolUseFailure`, Codex `PostToolUse`. |
| `prompt-open` | `prompt: Prompt` (§5.2) | `PermissionRequest`, `Elicitation`, `Notification` of a dialog type, OSC `approval-requested`/`async-question`, screen detection. |
| `prompt-closed` | `promptId: number`, `reason: "answered-here" \| "resolved" \| "vanished" \| "superseded"`, `label?: string` | Any later tool-end/denied/turn event for the same tool; screen block disappearing; a new prompt replacing it; a phone answer. |
| `answer` | `promptId`, `requestId`, `option?: { index: number; label: string }`, `text: boolean`, `result: "closed" \| "still-open" \| "changed" \| "refused"` | The answer endpoint (§6). The text itself is in the paired `input-intent`. |
| `notice` | `type: string`, `message?: string` (≤500), `title?: string` | `Notification`, `SessionEnd`, OSC notifications, Codex `SessionStart`/`Interrupt`. |
| `error` | `message: string` (≤1,000), `where: "provider" \| "hooks" \| "host"` | `StopFailure`; hook ingestion failures are counted, not journaled, except the first per session. |

`quiet` on `tool-start` is true for Read, Glob, Grep, WebSearch, WebFetch, TodoWrite, ToolSearch, LSP and any tool whose name starts with `mcp__` but is not in the loud list. The phone collapses quiet tools into a count. Loud tools: Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit, AskUserQuestion, Agent, Workflow, ExitPlanMode, `apply_patch`, and Codex `Bash`.

### 4.3 Truncation and privacy

Every string in `input` is cut at 4,000 characters with a trailing ` … [+N chars]` marker, except `Write.content`, `Edit.old_string` and `Edit.new_string`, which are cut at 2,000. The whole `tool-start` data is capped at 16 KiB. The journal is encrypted at rest as before; the phone receives signal contents only over the paired, authenticated connection. Push bodies are separate and minimal by default (§8).

## 5. Attention state

### 5.1 Shape

```ts
interface Attention {
  state: "working" | "needs-you" | "turn-finished" | "idle"
       | "exited" | "unavailable" | "recording-error";
  since: string;              // ISO time the state was entered
  source: "hook" | "osc" | "screen" | "lifecycle";
  now: string;                // one line, ≤140 chars, for list rows and push bodies
  prompt?: Prompt;            // present only in needs-you
  lastMessage?: string;       // from the last turn-end, ≤4,000
  lastTool?: { tool: string; summary: string; at: string };
  lastActivityAt: string;     // last PTY output or hook
  hooks: "active" | "none";   // hooks-ready seen
  hookErrors: number;
}
```

`WorkerState` gains `attention`. `status.sealed` persists it (without `prompt.hash` being needed on restore), so an API restart recovers the last attention; a dead worker reports `unavailable` as today.

### 5.2 Prompt

```ts
interface Prompt {
  id: number;                 // seq of the prompt-open signal
  kind: "permission" | "question" | "elicitation" | "yes-no" | "menu";
  title: string;              // dialog header as displayed
  detail?: string;            // command, file path, question body (≤2,000)
  options: PromptOption[];    // in display order
  highlighted?: number;       // index carrying the marker on screen, if known
  acceptsText: boolean;       // an option is reject-with-feedback, or kind is yes-no
  multiSelect?: boolean;      // AskUserQuestion multi-select; answered via terminal only
  destructive?: { pattern: string };
  tool?: { name: string; input: Record<string, unknown> }; // from the hook, truncated
  source: "hook" | "osc" | "screen";
  hash?: string;              // from screen detection; required to answer
}
interface PromptOption {
  index: number;
  label: string;
  role: "accept" | "accept-always" | "reject" | "reject-with-feedback" | "other";
}
```

Roles are assigned by label: `^Yes, and (don't ask again|allow|switch)` → `accept-always`; `^Yes` → `accept`; `^No, and tell` → `reject-with-feedback`; `^No` → `reject`; else `other`. The phone uses roles for button emphasis only; it always shows the label text.

A hook-sourced prompt is merged with the screen-detected block when both exist: title, detail, options, highlighted and hash come from the screen; kind, tool and destructive flag come from the hook when the hook has them; multi-select set by either side stays set (amended 2026-10-05). A hook prompt with no screen block yet keeps `options: []` and `hash: undefined`, and the phone shows "Open terminal to answer" until the block is detected (normally within one flush).

### 5.3 Transitions

| From | Trigger | To |
| --- | --- | --- |
| lifecycle `running` | initial prompt supplied | `working` |
| lifecycle `running` | no initial prompt | `idle` |
| any live | `turn-start`, or `tool-start`, or PTY output while `idle`/`turn-finished` and no prompt detected | `working` |
| any live | `prompt-open` | `needs-you` (prompt set) |
| `needs-you` | `prompt-closed` | `working` |
| any live | `turn-end` | `turn-finished` (lastMessage set) |
| any live | screen idle, no prompt, a prior `turn-end` in this session | `turn-finished` |
| any live | screen idle, no prompt, no prior `turn-end` | `idle` |
| any | lifecycle `exited` | `exited` |
| any | recording failure | `recording-error` |

`now` text by state: `needs-you` → the prompt title plus detail head ("Run `rm -rf node_modules`?"); `working` → "Running `npm test`" / "Editing src/app.tsx" / "Thinking" when no loud tool is open; `turn-finished` → first sentence of `lastMessage` or "Finished a turn"; `idle` → "Waiting for direction"; terminal states → existing wording.

Prompt closure sources: a `tool-end` or `PermissionDenied` whose `toolUseId` or tool name matches; a `turn-start`; a new `prompt-open` (reason `superseded`); the screen block disappearing for two consecutive checks (reason `vanished`); the answer endpoint reporting `closed` (reason `answered-here`).
Amended 2026-10-05: a prompt with a screen hash stays open across `turn-start` and `tool-start`; only its block leaving the screen or an answer closes it. A hook-only prompt still closes on them, and any prompt closes on `turn-end`; the worker journals that close as `prompt-closed` reason `resolved` before the signal, so every `prompt-open` is closed exactly once. `PermissionDenied` closes the open prompt unless its block is still on screen. With hooks active, PTY output alone never moves `turn-finished` back to `working`. `turn-start` clears `lastMessage`; an answer or close whose label is a reject option clears `lastTool`.

## 6. Answering a prompt

`POST /api/sessions/:id/answer` for owner and controller.

```ts
{ requestId: uuid; promptId: number; option?: number; text?: string }
```

Rules, enforced in the worker inside the existing serialized `deliver` path and idempotent by `requestId` like text input:

1. The session must be `needs-you` and `attention.prompt.id === promptId`, else `409 { error: "prompt-changed", attention }`.
2. The prompt must have a `hash` and the current screen's detected prompt must have the same hash, else `409 prompt-changed`. Hook-only prompts are not answerable here.
3. `multiSelect` prompts are refused with `409 unsupported`; the phone sends people to the terminal.
4. `option` must be a valid index. `text` requires `acceptsText`; for `yes-no` text is refused.
5. Delivery for a menu: compute `highlighted` (default 0 if unknown), send `down` or `up` presses to reach the target with 40 ms gaps, re-read the screen, require the marker to sit on the target (else `result: "changed"`, nothing further sent), then send Enter. For `yes-no`: type `y` or `n` followed by Enter.
6. If the chosen option is `reject-with-feedback` and `text` is present: after the dialog closes, send `text` as a normal `input` with submit through the same request's journal entries. The text travels through the existing control-character filter and bracketed-paste rules.
7. Post-check: wait up to 1,500 ms for the block to leave the screen. `result` is `closed`, `still-open` or `changed`. The receipt returns `{ requestId, state: "delivered", seq, result }`. A `still-open` result is reported to the person; nothing is retried automatically.

Every answer appends `input-intent` (the key sequence as one record with `op: "answer"`), the `answer` signal and `input-result`, so the recording shows who answered and what happened. The web client and native attach keep working unchanged; the laptop can still answer in the TUI, which the worker observes as `vanished`.

## 7. API changes

| Change | Detail |
| --- | --- |
| `GET /api/sessions` | Each row adds `attention` with `lastMessage` cut to 280 chars and `prompt.tool.input` omitted. |
| `GET /api/sessions/:id` | Adds full `attention`. |
| `GET /api/sessions/:id/events` | New optional `types` query, a comma list of event types; default remains all. The phone asks for `signal,lifecycle,input-intent,input-result`. |
| `POST /api/sessions/:id/answer` | §6. |
| `POST /api/sessions/:id/input` | Amended 2026-10-05: refused with `409 { error: "prompt-open", attention }` while the open prompt's block is on screen, unless the body has `force: true`. The Brief's composer never forces; the Terminal route does. |
| Input control | Amended 2026-10-05: on workers that advertise `capabilities.inputControl`, `answer`, `input` and `key` need this device's lease (`POST /api/sessions/:id/control`, header `X-Infinite-Control`). Without it the worker refuses with `409 { code: "control-busy" \| "control-lost", error }` before any guard here runs, and journals nothing. See `docs/architecture.md`. |
| `POST /api/devices/push` | `{ token: string, platform: "android" \| "ios" }`. Any paired role. Stored under the caller's device-key id; one list per key, deduplicated by token. |
| `DELETE /api/devices/push` | `{ token }`. Called on disconnect. |
| `GET /api/me` | Adds `capabilities: { signals: true, answer: boolean (role), push: boolean (host configured) }`. |

Config additions, all optional, in `config.json`:

```json
"attention": { "idleAfterMs": 20000, "hooks": { "claude": true, "codex": false } },
"push": {
  "enabled": false,
  "accessTokenFile": "/abs/path/outside/stateDir/expo-access-token",
  "detail": "minimal",
  "events": ["needs-you", "turn-finished", "exited", "recording-error"]
}
```

`doctor` reports: hook relay path exists, Claude Code and Codex binaries and versions, the person's `allowedHttpHookUrls` conflict if any, push configuration and token file mode `0600`.

## 8. Push notifications

### 8.1 Host

A `Notifier` in the API process polls `manager.list()` every 2 s and diffs `(attention.state, attention.prompt?.id)` per session. On a transition into a configured event it sends one message through the Expo push API (`https://exp.host/--/api/v2/push/send`, using `fetch` against the Expo push HTTP API) to every registered token of every device key, with `collapseId = sessionId`, `channelId = "attention"`, `priority = "high"` for `needs-you`, and `data = { url: "/session/<id>" }`. Push happens only while the API runs, which is also the only time phones can reach the host; this is documented.

Body text by `push.detail`:

- `minimal` (default): "<Provider> needs your approval in <title>", "<Provider> asked a question in <title>", "<title> finished a turn", "<title> exited", "<title> stopped recording". No command, file, or message text leaves the tailnet.
- `full`: the `now` line (≤140 chars) is the body.

Tickets are checked once and `DeviceNotRegistered` removes the token. The Expo access token is read from `push.accessTokenFile` (mode `0600`, outside `stateDir`) and never logged.

### 8.2 App

- `expo-notifications`, `expo-device`, `expo-constants` installed with `npx expo install`. The plugin config sets the Android icon, color and `defaultChannel: "attention"`. The app creates the `attention` channel at importance MAX before requesting permission.
- After pairing succeeds the app requests permission, gets the Expo push token with the EAS `projectId` from app config, and calls `POST /api/devices/push`. A `addPushTokenListener` re-registers on rotation. Disconnect calls `DELETE` before clearing the keychain.
- A module-scope notification handler shows banners in the foreground. The root layout reads `getLastNotificationResponse()` on cold start and subscribes to responses; a `data.url` string is pushed through the router.
- Manual steps for the owner, listed in `README.md`: create the EAS project (`eas init` writes `extra.eas.projectId`), create a Firebase project for `dev.infinite.app`, place `google-services.json` and reference it from `android.googleServicesFile`, upload the FCM V1 service account key with `eas credentials`, create an Expo access token and store it in `push.accessTokenFile`. iOS needs an APNs key and a paid developer account and is not verified in this delivery. Expo Go cannot receive push on Android; a development build is required, which the project already uses.

## 9. Phone interface

### 9.1 Structure

`apps/mobile/src/App.tsx` (822 lines) is split:

```
apps/mobile/src/
  app/_layout.tsx              Stack + notification response routing
  app/index.tsx                Pair or Inbox
  app/session/[id]/index.tsx   Brief
  app/session/[id]/terminal.tsx  Terminal (current screen + raw keys)
  api/client.ts                api(), request types, error mapping
  api/usePoll.ts               the polling hook shared by Inbox and Brief
  store/connection.ts          SecureStore pairing, push registration
  theme.ts                     tokens from DESIGN.md
  components/                  Button, StatePill, DecisionCard, NowCard, MomentRow, Composer, OfflineBanner, SourceTag
  features/pair/Pair.tsx
  features/inbox/Inbox.tsx
  features/session/Brief.tsx, Terminal.tsx
```

Shared pure logic lives in a new workspace package `packages/attention` (TypeScript, no runtime dependencies): `types.ts`, `destructive.ts`, `prompts.ts`, `roles.ts`, `moments.ts`. The host imports it directly; the mobile app imports it through the workspace, which Expo's metro config supports for npm workspaces. If metro resolution fails in practice, the fallback is a `tsconfig` path alias to the package source; the plan has a check for this.

### 9.2 Inbox

Sections in fixed order: **Needs you**, **Working**, **Finished**, **Exited**; empty sections are hidden. A row shows the title, provider name, a state pill, the `now` line, and a destructive mark (the error red) when the pending prompt or the last loud command is destructive. Needs-you rows have an amber left rule. The header keeps the connection dot, "Checked HH:MM" and the stale warning. Disconnect moves to a footer action as now.

### 9.3 Brief

Top: title, provider, state pill, source tag ("hooks active" or "screen only"), host and last check.

**Now card**, by state:

- `needs-you`: a **DecisionCard**. Title is the dialog header. Detail shows the command in monospace, or the file path, or the question body. A destructive banner names the pattern. Option buttons in display order with the label text; `accept` and `accept-always` are secondary, `reject` and `reject-with-feedback` plain, the highlighted one has a marker. Tapping sends `answer`; the card shows "Sent, waiting for the dialog to close", then either dismisses or reads "The dialog is still open. Check the terminal." When `acceptsText`, a "Reply instead" field appears under the options; sending picks the `reject-with-feedback` option plus text. `multiSelect` or missing `hash` shows "Open terminal to answer" with a button to the Terminal route. A `409 prompt-changed` reloads the card from the returned attention and says "This prompt changed."
- `working`: "Working" with the current loud tool line and elapsed time since `since`.
- `turn-finished`: "Finished a turn" with the first 280 chars of `lastMessage` and an expand to the full text. Never the word "done".
- `idle`: "Waiting for your direction."
- `exited`, `unavailable`, `recording-error`: existing wording.

**So far**: a timeline of moments, newest first, derived on the client by `moments.ts` from signal events:

- `tool-start`/`tool-end` pairs joined by `toolUseId` (or by order for Codex) become one **command** moment (icon, command in monospace, destructive mark, exit summary or failure, duration) or one **edit** moment (file name, Edit old/new as a two-line mini diff, Write as "wrote N chars"). Consecutive edits to one file within one turn collapse into a single moment with a count.
- Quiet tools collapse into "Read 12 files, searched 3 times" per turn.
- `prompt-open` + `answer`/`prompt-closed` become one **decision** moment: header, chosen label, who (this phone, elsewhere, or resolved).
- `turn-start` and `turn-end` become **turn** dividers with the prompt head and the message head respectively.
- `error` and `notice` of interest (`StopFailure`, `SessionEnd`, auth) become **notice** moments.
- Each moment expands in place to its full stored text. Nothing in the timeline is an `output` event.

The timeline pages forward through `events?types=…` from the first signal; the phone keeps at most 2,000 signal events in memory.

**Composer**: docked at the bottom as today, with Send and Interrupt. Receipts keep their wording. A "Terminal" link in the header opens the Terminal route, which is the current Catch up screen plus the raw key row, unchanged in function.

**Control** (amended 2026-10-05): on a worker that enforces input control, the DecisionCard options, the reply field, the composer and the Terminal's keys stay disabled until this phone holds the session's lease. A control bar under the title shows who holds it and offers "Take control", or "Take over" when another device has it. Once held, an answer is one tap again. The Brief and Terminal routes share the lease; leaving both, backgrounding the app or losing the host releases it, and nothing reacquires it without a tap. Unsent text and an unconfirmed request stay in memory per route until the phone disconnects.

### 9.4 Visual

The working-journal system in `DESIGN.md` applies: paper `#fafaf6`, ink `#222a27`, forest `#23654e`, rules `#d5d9d1`. New uses: amber (`warning-surface`/`warning-ink`) for `needs-you` pills, rules and the DecisionCard tint; the existing error red for destructive marks only; monospace for commands, paths and the mini diff. Touch targets ≥ 48 dp. Light theme only, as before. No new fonts or icon libraries; glyphs are text.

## 10. Rehearsal provider

`demo.ts` gains deterministic behaviors so everything above runs without a model:

- If the initial request contains `dialog`, after 2 s it prints a Claude-style numbered permission dialog ("Do you want to proceed?", `rm -rf build`, three options with `❯`), reads raw key presses (arrows move the marker, Enter selects, Esc cancels) and prints "Selected: <label>", then returns to a `>` composer line.
- If the initial request contains `hook` and `INFINITE_HOOK_URL` is set, it also posts synthetic `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse` and `Stop` payloads in Claude Code's shapes around that dialog.
- If the initial request contains `yesno`, it prints `Continue? [y/N]` and reads a line.
- Any typed line still echoes as today.

## 11. Testing and verification

### 11.1 Unit (node:test, `tests/`)

- `attention.test.ts`: `detectPrompt` against fixtures (rehearsal dialogs, Claude Code and Codex screens from the spikes); role assignment; destructive classifier positives and negatives (`rm -rf node_modules` yes, `rm -r --dry-run` no, `git push --force-with-lease` yes by the force pattern and recorded as a known over-match); state machine transitions in §5.3 as a table test; `moments.ts` derivation (pairing, collapsing, decisions).
- `hooks.test.ts`: the worker hook listener rejects a missing or wrong token, oversized bodies and non-JSON; accepts each Claude payload and journals the mapped signal; `hookErrors` counts; the relay posts stdin and argv payloads.

### 11.2 Integration

Extend `continuity.test.ts` with a rehearsal `dialog hook` session: the API sees `needs-you` with options from the screen merged with the hook's tool input; a controller `answer` with option 1 closes the dialog (`result: "closed"`), journals `input-intent`, `answer`, `input-result`; a stale `promptId` returns 409; a viewer gets 403; after API restart the attention state survives from `status.sealed`. Push: with a fake `exp.host` server on loopback, the Notifier sends one message for the needs-you transition and none on repeat polls.

### 11.3 Phone

`npm run lint -w @infinite/mobile`, `tsc --noEmit`, Android and iOS bundle exports. Android emulator run against the local rehearsal host: pair, inbox grouping with a `dialog` session, answer from the DecisionCard, timeline rows, terminal route, and a push notification delivered from the fake sender path through a real Expo token only if the owner has completed the EAS and FCM steps; otherwise push is verified to the fake endpoint only and the gap is stated.

### 11.4 Live spikes (owner approval required, they use provider quota)

- **S1 Claude Code**: one session on the rehearsal workspace in default permission mode with the prompt "Run `ls -la` and report the file count." Expected: `turn-start`, `tool-start Bash`, `PermissionRequest` hook, screen dialog detected and merged, phone answer option 1 closes it, `tool-end`, `Stop` with `last_assistant_message`. Captured screen becomes a parser fixture.
- **S2 Codex**: the same prompt with `-a on-request -s workspace-write` and the injected `-c hooks.*` plus `--dangerously-bypass-hook-trust`. Decides whether row 1 of §3.3 stays. Captures the approval dialog and the OSC 9 marker text as fixtures.

Both are recorded in this spec's decision register when run.

## 12. Security and privacy notes

- Hooks run inside the agent's environment; the token and URL are readable by the agent. Signals are evidence, never authority. No approval happens without a person's input. (§3.1)
- The answer endpoint only presses keys the TUI already shows and checks the dialog before and after. It cannot approve a prompt that is not on screen.
- Push bodies default to no content. Full detail is opt-in. Tokens and the Expo access token are stored encrypted or `0600`. Push adds the first outbound dependency from the host; it can be left disabled.
- `--dangerously-bypass-hook-trust` applies only to hooks Infinite injects for that process; the person's own hooks keep their trust requirements. This is unverified until spike S2, and Codex hooks are off by default until then. The flag name is surfaced in `doctor` output so the person knows it is in use.
- Signal payloads can contain file contents and commands; they are journaled encrypted and shown only to paired roles, as the recording already is.

## 13. Decision register

| # | Decision | Why |
| --- | --- | --- |
| D1 | Hooks reply at once and never decide. | Keeps the TUI dialog visible to the laptop and cmux; the phone and laptop both remain able to answer. |
| D2 | Answers are keystrokes verified against the screen, not hook decisions. | Same as D1, and works for every provider. |
| D3 | One `signal` event type in the existing journal rather than a second store. | One ordered stream, replay unchanged, encryption unchanged. |
| D4 | Moments are derived on the client. | Keeps the host to facts; the timeline shape can change without a migration. |
| D5 | Pure logic in `packages/attention`, shared by host and phone. | Tested once with node:test; the phone has no test runner. |
| D6 | Push is sent by the API process on a 2 s poll. | Workers never hold the Expo token; no push when the API is down, which is also when phones cannot reach the host. |
| D7 | Minimal push bodies by default. | Terminal content should not leave the tailnet without an explicit choice. |
| D8 | Codex hooks through `-c` overrides with trust bypass, with OSC 9 and `notify` as the confirmed fallback. Codex hooks ship off by default until S2 confirms flag acceptance and scope. | No per-process hooks file location exists; the overrides are the least invasive way and the fallback is verified. |
| D9 | Web client unchanged. | Out of scope for this delivery; the API additions are usable by it later. |
| D10 | Multi-select questions and hook-only prompts are answered in the terminal. | Keystroke mapping without a visible, hashed block is not verifiable. |

Future work, not scheduled: Codex app-server and Claude Agent SDK as structured sources; notification actions once a safe subset exists (for example "Reply" with text only); dark theme; web Brief.
