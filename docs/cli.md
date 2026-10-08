# Laptop CLI

The laptop CLI runs the native Claude Code, Codex, Grok, or OpenCode terminal on the cloud host. It carries the native terminal output and input over authenticated private HTTPS. Detaching, closing a terminal, or losing the laptop connection leaves the cloud process running.

Launch and attach report their current stage immediately, with elapsed time during longer waits. These messages go to stderr; JSON listings and detached session IDs remain machine-readable on stdout. Progress stops when native output takes over.

Updated clients and hosts use one authenticated WebSocket for ordered input, delivery receipts, and terminal output. Keystrokes do not wait for previous acknowledgments. Journal changes wake the output stream immediately, with a periodic lifecycle check. Older hosts retain the HTTPS streaming fallback. Native remote echo still includes network latency; this transport is not a locally running provider UI. See [native interaction and continuity](native-continuity.md) for the Herdr review and provider adapter requirements.

```sh
infinite claude
infinite codex --model MODEL
infinite grok
infinite opencode --model deepseek/deepseek-flash

infinite list
infinite list --json
infinite resume             # choose a running session
infinite resume 5ba58d55    # a unique Infinite session ID prefix also works
infinite monitor           # choose a session to watch
```

For terminal sessions, `resume` attaches to the existing OS process. It does not invoke the provider's resume command, fork a conversation, or submit the initial request again. An exited process remains available as a recording through `monitor`; restarting it requires explicit native-provider recovery. For example, `infinite codex resume NATIVE_ID` passes that native command through and creates a new Infinite recording. Use `infinite resume INFINITE_ID` while the existing process is alive.

## Experimental local Codex interface

```sh
infinite --local-ui codex "Inspect this repository"
infinite resume SESSION_ID
infinite --takeover resume SESSION_ID
infinite monitor SESSION_ID
```

This opt-in mode runs the installed Codex interface on the laptop and keeps its app server on the execution host. Prompt editing and cursor motion happen locally. Model requests, tools, history loading, and remote file searches still depend on the connection. A persistent cloud terminal supplies the recording and the web/phone controls for the same conversation.

Both machines need a Codex version with authenticated `--remote` support. A paired **owner** key is required for the local native interface. The initial launch requires a nonempty prompt: the tested app server cannot attach a second client to an empty conversation. Infinite uses legacy provider history because the tested WebSocket server cannot hydrate the native TUI's paginated default. Existing terminal sessions stay attached to their original process.

Supported launch options are `--model`, `--config`, `--ask-for-approval`, `--sandbox` (including their short forms), `--search`, and `--no-alt-screen`, plus one prompt. Other native arguments require ordinary terminal mode. Options retain their values; Infinite separates the prompt with `--` so prompt text cannot become a provider subcommand. The cloud owns model settings, credentials, working directory, tools, and history. Laptop files are not uploaded.

`resume` opens a new local interface attached by the recorded provider conversation ID; it does not create another thread or resubmit the initial prompt. Native Codex shortcuts apply. Infinite's Ctrl+E, Ctrl+G, and Ctrl+] shortcuts apply only to streamed terminals. `monitor` uses the cloud terminal and remains read-only until control is requested. A phone can take over using the existing controls; the worker rejects stale native requests, including approval replies. Losing control detaches the local interface. Reopen with `resume`; use `--takeover` only when intentionally replacing another device's control.

Closing the local interface leaves cloud execution running. Unsaved local drafts are not synchronized. Provider requests are not automatically replayed after a broken connection; check the current conversation before sending again. This mode remains experimental because Codex's WebSocket app-server transport is experimental. It does not provide recovery after an execution-host failure or local/cloud file synchronization.

## Experimental local OpenCode interface

```sh
infinite --local-ui opencode
infinite --local-ui opencode --model PROVIDER/MODEL --prompt "Inspect this project"
infinite resume SESSION_ID
infinite --takeover resume SESSION_ID
```

The installed OpenCode TUI runs locally and attaches to one persistent cloud OpenCode server and conversation. Empty sessions work. Supported launch options are `--model`/`-m`, `--agent`, `--prompt`, and `--pure`; other native arguments use ordinary terminal mode. `--pure` remains opt-in and disables external provider plugins. A bare positional argument is not treated as a prompt because OpenCode normally interprets it as a project directory.

A paired owner key is required. The native interface receives only a temporary loopback password; Infinite retains the paired device credential. `resume` rejoins the recorded conversation without creating one or replaying a prompt. A takeover invalidates the old interface's requests and closes its event stream. The cloud backend and observer continue after the laptop interface exits. The observer supplies the existing web/phone recording and terminal controls.

Provider permission and question events show **needs you**. Their current native dialog remains authoritative: use terminal controls to answer it; compact OpenCode approval choices are not yet mapped. Infinite does not answer requests automatically. Provider administration, new/fork/delete operations, and navigation into child sessions are unavailable through this pinned attachment. Cloud credentials, model settings, paths, and tools remain associated with the cloud workspace. This does not synchronize laptop files or unsent native drafts.

OpenCode 1.18.34 was rehearsed with its real TUI, server, and shell tool using a controlled model response fixture. A tool completed after UI detachment, a phone-side follow-up appeared under the same ID after reattachment, and a pending permission was answered explicitly through phone terminal controls. Ten typed characters measured about 22 ms p95 at a simulated 1,000 ms request round trip, with no mutating HTTP requests while typing. This small local rehearsal does not establish live provider authentication, Android runtime behavior, or host reboot recovery. The adapter follows OpenCode's [native attach contract](https://opencode.ai/docs/cli/#attach) and [server API](https://opencode.ai/docs/server/).


## Terminal controls

- **Ctrl+]** detaches without interrupting the agent.
- **Ctrl+G** releases control, switches to monitoring, and drops unsent buffered keys. An open local draft is saved on the laptop.
- **Enter** in monitor mode requests control for an owner device. Input stays disabled until the host acknowledges it. That Enter is consumed locally; it does not approve a native prompt.
- **Ctrl+T** in monitor mode explicitly takes control from another device. The previous device's keys and resize requests are refused by the worker.
- **Ctrl+C** interrupts the agent in interactive mode and detaches in monitor mode.
- **Ctrl+E** opens a local draft editor for an interactive owner. Typing and line editing stay on the laptop. Enter adds a line, **Ctrl+S** inserts the draft into the native prompt without submitting it, **Esc** keeps the draft and closes the editor, and **Ctrl+X** discards it. The CLI is a terminal surface, so the draft is inserted even while a provider dialog is on screen, as typed keys would be. After insertion is acknowledged, Enter in the native terminal submits the prompt. Multiline insertion requires the provider's bracketed-paste support. Remote output continues updating the saved screen while drafting; closing the editor restores it.

A viewer remains read-only. Full native input requires an owner key. Controller keys retain the compact web/mobile steering controls, but cannot send arbitrary terminal control bytes. Monitoring does not resize the shared terminal; an interactive owner supplies its terminal dimensions.

On supported workers, attachment restores the current screen and up to 200 scrollback rows, then consumes output after that snapshot's exact journal cursor. Unsupported terminal state and older workers use recording replay. Older history stays on the host; the snapshot does not delete it.

After a broken connection, the CLI discards queued input and reconnects in monitor mode. An input with an uncertain delivery receipt is not automatically retried. Inspect the native screen, then press Enter to request control again. A confirmed control refusal means that attempt was not sent; it is distinct from an uncertain receipt.

Control expires after 30 seconds without renewal. This expiry releases input ownership only; the provider process keeps running. The current CLI renews every 10 seconds while interactive. Browser and phone clients open in monitoring mode and stop renewing when backgrounded. Older workers expose no control capability and retain their previous shared-input behavior; they are not restarted during an API upgrade.

Ctrl+E drafts are saved encrypted beside the private client configuration, scoped to the paired origin, device key, project, session, and runtime. Saves run within 200 ms while typing and flush before insertion or graceful detachment. A sudden process kill can lose the most recent unsaved keystrokes. Resume the same session, acquire control, and press Ctrl+E to review a recovered draft. Recovery never sends text. Each client writes its own file; another live editor's draft is not taken over. Additional recovered drafts remain available after the current one is inserted or discarded.

An insertion is recorded locally as unconfirmed before dispatch and cleared only after the host acknowledges delivery. If the receipt is lost, the recovered text is read-only and Ctrl+S is blocked. Esc returns to the native screen for inspection. Use Ctrl+X to discard text already inserted, or Ctrl+R to mark it as unsent after your review. That explicit choice can duplicate the earlier insertion; the wrapper never makes it automatically.

This recovery covers Infinite's Ctrl+E editor in streamed terminal mode. Native Codex/OpenCode edit buffers and browser/phone drafts retain their own lifecycle; they are not captured or synchronized by this feature. Losing or replacing the paired device key also loses access to its encrypted drafts. Deleting the local `drafts` directory beside the client configuration removes the saved copies.

## Native arguments and cloud workspaces

In ordinary terminal mode, everything after the provider name is passed as an argument array to that provider, unchanged. There is no shell evaluation. Put Infinite options before the provider:

```sh
infinite projects
infinite --project PROJECT_ID --title "Investigate tests" codex --model MODEL
infinite --detach --project PROJECT_ID claude "Review this checkout"
infinite --client-config /private/client.json monitor SESSION_ID
```

Paths, configuration files, native session IDs, installed tools, and credentials belong to the cloud host. A laptop path passed to `--cd`, `--add-dir`, or a provider configuration flag is not uploaded or translated. The CLI does not silently copy the current laptop checkout or its secrets.

To preserve native command and flag semantics, native CLI launches do not append Infinite's shared context as another positional prompt or inject provider hook flags. The project context version is retained in the encrypted session record; repository instructions and the provider's native cloud history continue to work normally. Browser-created sessions retain the existing shared-prompt behavior. Screen-based attention remains available for new workers; workers launched before that feature omit attention metadata until explicitly replaced.

Use separate configured worktrees for parallel writers. Multiple sessions launched against the same project directory share that working directory. Do not assume that a new session automatically creates a Git worktree.

## Install and pair another laptop

Requires Node.js 22.14 or newer and Tailscale access to the host.

```sh
make
infinite pair https://YOUR-HOST.tailnet.ts.net --token-file /private/owner.key
```

`make` (or `make build`) installs dependencies when `node_modules` is missing or older than the lockfile, builds `@infinite/attention` and `@infinite/host`, then runs `scripts/install-client.mjs`. The same steps by hand:

```sh
npm ci
npm run build -w @infinite/attention
npm run build -w @infinite/host
node scripts/install-client.mjs
```

The installer places `infinite` in `~/.local/bin` and an independent, versioned client runtime in the user's application-data directory. Add `~/.local/bin` to PATH if the installer reports it missing. The runtime bundles its dependencies and does not require this checkout or its `node_modules` directory. It refuses to overwrite an unrelated existing command.

Pairing validates the host and device role before saving a mode-0600 `~/.config/infinite/client.json`. Use `--token-file -` to receive the key through stdin instead of a file. Do not put a key in command arguments or shell history. Remote pairing requires HTTPS; HTTP is accepted only for literal loopback development addresses. Redirects are refused so credentials are not forwarded to another endpoint.

This client currently connects directly to a trusted single-tenant runner. TLS pairing is not confidential-VM attestation and does not implement the future operator-private multi-tenant protocol.
