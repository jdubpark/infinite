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

`resume` attaches to the existing OS process. It does not invoke the provider's resume command, fork a conversation, or submit the initial request again. An exited process remains available as a recording through `monitor`; restarting it requires explicit native-provider recovery. For example, `infinite codex resume NATIVE_ID` passes that native command through and creates a new Infinite recording. Use `infinite resume INFINITE_ID` while the existing process is alive.

## Terminal controls

- **Ctrl+]** detaches without interrupting the agent.
- **Ctrl+G** releases control, switches to monitoring, and drops unsent buffered keys. An open local draft stays in memory.
- **Enter** in monitor mode requests control for an owner device. Input stays disabled until the host acknowledges it. That Enter is consumed locally; it does not approve a native prompt.
- **Ctrl+T** in monitor mode explicitly takes control from another device. The previous device's keys and resize requests are refused by the worker.
- **Ctrl+C** interrupts the agent in interactive mode and detaches in monitor mode.
- **Ctrl+E** opens an in-memory local draft editor for an interactive owner. Typing and line editing stay on the laptop. Enter adds a line, **Ctrl+S** inserts the draft into the native prompt without submitting it, and **Esc** cancels. The CLI is a terminal surface, so the draft is inserted even while a provider dialog is on screen, as typed keys would be. After insertion is acknowledged, Enter in the native terminal submits the prompt. Multiline insertion requires the provider's bracketed-paste support. Remote output continues updating the saved screen while drafting; closing the editor restores it.

A viewer remains read-only. Full native input requires an owner key. Controller keys retain the compact web/mobile steering controls, but cannot send arbitrary terminal control bytes. Monitoring does not resize the shared terminal; an interactive owner supplies its terminal dimensions.

On supported workers, attachment restores the current screen and up to 200 scrollback rows, then consumes output after that snapshot's exact journal cursor. Unsupported terminal state and older workers use recording replay. Older history stays on the host; the snapshot does not delete it.

After a broken connection, the CLI discards queued input and reconnects in monitor mode. An input with an uncertain delivery receipt is not automatically retried. Inspect the native screen, then press Enter to request control again. A confirmed control refusal means that attempt was not sent; it is distinct from an uncertain receipt.

Control expires after 30 seconds without renewal. This expiry releases input ownership only; the provider process keeps running. The current CLI renews every 10 seconds while interactive. Browser and phone clients open in monitoring mode and stop renewing when backgrounded. Older workers expose no control capability and retain their previous shared-input behavior; they are not restarted during an API upgrade.

If a connection drops while drafting, the unsent draft stays in the current client's memory. After reconnecting, press Enter to enable interaction and Ctrl+E to reopen the draft. Closing the client discards that unsent draft; it has not been uploaded or saved to disk.

## Native arguments and cloud workspaces

Everything after the provider name is passed as an argument array to that provider, unchanged. There is no shell evaluation. Put Infinite options before the provider:

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
npm ci
npm run build -w @infinite/attention
npm run build -w @infinite/host
node scripts/install-client.mjs
infinite pair https://YOUR-HOST.tailnet.ts.net --token-file /private/owner.key
```

The installer places `infinite` in `~/.local/bin` and an independent, versioned client runtime in the user's application-data directory. Add `~/.local/bin` to PATH if the installer reports it missing. The runtime bundles its dependencies and does not require this checkout or its `node_modules` directory. It refuses to overwrite an unrelated existing command.

Pairing validates the host and device role before saving a mode-0600 `~/.config/infinite/client.json`. Use `--token-file -` to receive the key through stdin instead of a file. Do not put a key in command arguments or shell history. Remote pairing requires HTTPS; HTTP is accepted only for literal loopback development addresses. Redirects are refused so credentials are not forwarded to another endpoint.

This client currently connects directly to a trusted single-tenant runner. TLS pairing is not confidential-VM attestation and does not implement the future operator-private multi-tenant protocol.
