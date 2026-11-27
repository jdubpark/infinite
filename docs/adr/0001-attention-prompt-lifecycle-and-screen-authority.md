# ADR-0001: Attention Prompt Lifecycle, Screen Authority, and Delegation Evidence

- **Status**: Accepted
- **Scope**: `packages/attention/`

## Context

`@infinite/attention` reduces provider hooks, OSC sequences, terminal screen snapshots, and lifecycle transitions into a single `Attention` state shown across web, phone, and macOS clients. Provider hooks and screen captures arrive asynchronously, in either order, and terminal transcripts can contain arbitrary output written by the agent or commands it runs.

## Decisions

### 1. Screen-owned prompts and single-close journaling
- A prompt carrying a terminal screen `hash` belongs to the screen detector loop. Only its dialog block disappearing from the screen or an explicit answer closes it; late `turn-start` or `tool-start` hooks for the same dialog leave it open.
- `dropsPrompt` identifies signals that discard an open prompt without emitting `prompt-closed` (`turn-end` always drops it; `turn-start` and `tool-start` drop hook-only prompts without a screen hash). The worker journals `prompt-closed` before the dropping signal so every opened prompt is closed once.
- When Claude hook events emit a close with `promptId: 0`, the worker binds that close to the currently open prompt while preserving the notice reason.
- When hooks are active, a `turn-finished` state only returns to `working` on a `turn-start` or `tool-start` hook; terminal redraws or late output after the Stop hook do not restart work.
- For native protocol adapters, the adapter reports authoritative turn transitions; a quiet screen or late observer redraw must never override turn state into `idle`/`working`, while dialogs still use screen detection.
- When a hook prompt merges with its terminal dialog block, the worker records a `prompt-merged` notice so timelines display the dialog's title and detail even though the earlier `prompt-open` event kept the hook's title.

### 2. Bidirectional hook/screen merge rules
- **Screen arrives for an open hook prompt (`mergeScreenIntoPrompt`)**: The phone displays what the terminal dialog shows, so `title`, `detail`, `options`, `highlighted`, `acceptsText`, `pinned`, and `hash` come from the screen block. The hook retains its `tool`, its non-generic `kind` (replacing only `"menu"`), and its `destructive` flag.
- **Hook arrives for an open screen prompt (`mergeHookIntoPrompt`)**: The open prompt retains its `id`, `title`, `detail`, `options`, and `hash` (what the answer path verifies). The hook overlays only its specific `kind`, `tool`, `destructive`, and `multiSelect`.
- Safety flags (`destructive`, `multiSelect`) are monotonic: once set from either side, a merge never clears them.

### 3. Terminal dialog detection and transcript anti-spoofing
- `detectPrompt` claims only a dialog anchored at the bottom of the screen (followed solely by blank lines and known key hints) so historical menus scrolled into the transcript are never treated as active prompts.
- Box top edges and top-anchored headers (such as Codex command/edit dialogs) bound the dialog header; transcript text above them is excluded.
- Title selection prefers a top-anchored dialog title over a permission question, and a permission question over a generic trailing `?`, preventing reason prose from replacing the dialog title.
- Claude's first-run Code Mode dialog and folder trust prompt are matched explicitly as unnumbered two-option menus. For Code Mode, only its specific footer/key hint (whitespace stripped, optional narrow-wrap separator rule) may follow so an unrelated prompt's key hint cannot resurrect an older menu.
- Dialog detail text (command, path, or question body) is included in the dialog fingerprint so a different prompt with the same title does not alias an earlier prompt.

### 4. Answerability and delegated one-shot evidence
- `needsTerminalAnswer` returns `true` when the host answer route cannot safely deliver a selection: no verified screen block (`hash` absent on a hook-only prompt), zero options, or `multiSelect`. Protocol prompts (cmux) that accept text are answered via text instead.
- `delegableOption` returns a one-shot option only when evidence is complete and unambiguous:
  - Hook tool input was not truncated in storage (`inputComplete` true, no truncation markers), OR
  - A Codex command dialog is `pinned` to the bottom of the screen (ruling out scrolled agent output), shows exactly one `$` command line (a second `$` could come from transcript or agent-written reason prose), preserves internal spacing inside quoted arguments (trimming only line ends), and has no screen or detail-cap cut (`"… [+N chars]"`).
- Detail truncation in `prompts.ts` always appends a visible `"… [+N chars]"` suffix so truncated commands can never satisfy the complete-evidence check.
- Prompts that modify account-wide settings (such as Claude Code Mode) are owner-reserved and never delegable.
- Host list rows expose `Prompt.delegable` as a summary of complete delegated evidence.

### 5. Destructive command matching
- Destructive patterns are checked against the full, untruncated command text (`util.ts`) so storage truncation cannot hide a destructive tail.
- A leading `echo ...` prints words only, so destructive matching still inspects commands following shell chaining operators (`;`, `&&`, `||`, `|`).

### 6. Provider limit detection, reset parsing, and recovery proof
- Reset hints (`resets 3:45pm`, `resets Mon 12:00am`, `Try again at ...`) parse clock times in UTC (matching host timezone) and resolve to the next occurrence after `now`.
- Screen-based Codex usage-limit detection inspects only Codex's own status row (the final non-empty row, as a whole `·`-separated segment) so printed transcript text (`cat`/`grep`) cannot spoof a usage limit.
- Only a non-failed `turn-end` from a source capable of reporting failure (`protocol` adapters or Claude `hook` `Stop`/`StopFailure`) clears an active `limit`. Codex terminal turn-end signals (`Stop` hook, `notify`, OSC 9/777) do not distinguish failure and therefore never clear a limit.
- A `quota_auto_resume_fired` notice clears `limit` as a notice-only signal that the wait ended.

### 7. Codex OSC 9 and OSC 777 notification parsing
- Codex TUI notifications arrive either as OSC 9 (`\x1b]9;<body>\x07`) or OSC 777 (`\x1b]777;notify;Codex;<body>\x1b\\`). `mapCodexOsc777` accepts only `notify;Codex;<body>` (preserving semicolons in `<body>`) and ignores other OSC 777 titles or verbs without emitting a notice.
- On nonempty turn completion, Codex places the assistant's response preview directly in the OSC notification body, so prompt-shaped text (`Approval requested: ...`, `Approval requested by <server>`, `Codex wants to edit <target>`, `Question: ...`, `Plan mode prompt: ...`) is ambiguous without terminal or structured corroboration and would otherwise open a hashless `source: "osc"` prompt that `screenDecision` could never close. `mapCodexOsc` therefore classifies those delimiter-bounded prefixes as notice-only signals (`osc_approval` / `osc_question`) rather than `prompt-open`, emits `turn-end` only on turn-complete markers (`Agent turn complete` / `Turn complete`, exact or with `:`), and leaves unrelated text as plain `osc` notices.
- When the worker receives an `osc_approval` or `osc_question` notice, it triggers a coalesced screen inspection (`terminal.write("", () => checkScreen())`) so a genuine Codex dialog on screen opens as a screen-owned prompt (`source: "screen"`, `hash`, options, and clean `vanished` close, with Codex's Plan Mode choices `Yes, implement this plan` / `No, stay in Plan mode` classified as `question` in `prompts.ts`), while an assistant response preview with no dialog on screen stays safely notice-only. When the session is already `turn-finished`, the worker keeps any OSC `notice` but suppresses fallback OSC `turn-end` transitions so a late completion-shaped preview never erases a structured `codex-notify` `lastMessage` or duplicates completion moments. `launch.ts` includes `"plan-mode-prompt"` alongside `"agent-turn-complete"`, `"approval-requested"`, and `"async-question"` in `tui.notifications`.

### 8. Timeline moments and provenance labels
- Provider-submitted turns (`turn-start` with `automatic: true`, such as continuing after an owner's answer) are labeled as provider prompts rather than owner requests.
- Timeline moments sort by latest activity timestamp so a completed tool surfaces above decisions opened while it ran.

## Consequences

- `Attention` and `ScreenDecision` are encoded as compile-time discriminated unions (`packages/attention/src/types.ts`, `packages/attention/src/attention.ts`), making states like `needs-you` without a `prompt` or simultaneous `open`/`close` decisions unrepresentable.
- All anti-spoofing, monotonicity, and provenance invariants are documented here rather than repeated in inline comments.
