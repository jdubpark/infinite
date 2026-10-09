# Infinite

A persistent agent host for Claude Code, Codex, Grok Build, and OpenCode. Agents run on the host; cmux, a browser, and the React Native phone app attach to the same sessions. Closing the laptop does not move or restart the agent.

**Status: single-tenant cloud pilot with a paired laptop CLI.** Claude, Codex, Grok, and OpenCode have completed authenticated tool runs on the rented server. Cloud processes survive client disconnection and API restarts. Encrypted backup and data-restore checks are complete. Independent cloud backup storage, cold-boot recovery, and operator-confidential multi-tenant execution remain unfinished. See the [commissioning record](deploy/ubuntu/commissioning.md).

**Two deployment modes are supported by the architecture:** direct single-tenant execution with no VM isolation requirement, and a managed multi-tenant service with a complete context bucket per user. The single-tenant runner is deployed directly on the owner-controlled host. The managed target also requires confidentiality from the operator, which the current runner does not provide. One full VM and one Infinite installation per user is the development boundary; the development host lacks the required confidential VM support. See the [managed tenant architecture](docs/multi-tenant.md) and [Proxmox development plan](deploy/proxmox/README.md). Private workloads are refused by that planner.

```sh
npm run host -- plan-fleet deploy/proxmox/fleet.example.json
```

This emits a secret-free, capacity-checked development specification and makes no infrastructure changes. `tenant-development` runners accept only the rehearsal provider and report their lack of operator confidentiality through `/api/me`. `confidential` initialization refuses until a real attestation and user-key-release implementation exists.

For direct use, initialization defaults to `--deployment-mode single-tenant` and permits the four native providers. No tenant UUID, Proxmox, or attestation is required. Legacy `personal` configurations map to this mode. This does not disable authentication or recording encryption.

## Laptop CLI

```sh
infinite claude
infinite codex --model MODEL
infinite grok
infinite opencode --model deepseek/deepseek-flash
infinite list
infinite resume
infinite monitor
```

The CLI is installed and paired on the commissioning laptop. Codex uses the current laptop project by default; the other providers retain their native cloud terminals. `resume` attaches to the same process; `monitor` starts read-only. Press Enter to enable steering, Ctrl+G to monitor, or Ctrl+] to detach. Put wrapper options before the provider, for example `infinite --project PROJECT_ID --title "Task" codex`. Use `--cloud` before `codex` to select the configured cloud project. See [installation, pairing, and CLI behavior](docs/cli.md).

Run `infinite codex` inside your project. Tools use that directory immediately while a detached service prepares an incremental cloud checkpoint. With a qualified backend, laptop loss automatically moves tools to the prepared cloud workspace in the same conversation; uncertain operations pause. `infinite recover SESSION_ID` downloads cloud edits into a separate copy for reconciliation. See [laptop execution](docs/cli.md#laptop-execution-and-automatic-handoff).

An experimental `infinite --cloud --local-ui codex "Initial prompt"` mode runs Codex's interface locally while its backend remains on the host. Typing stays local; `resume` rejoins the recorded conversation. This requires a supported Codex binary on both machines and an initial prompt. See [local Codex usage and limits](docs/cli.md#experimental-local-codex-interface). OpenCode also supports `infinite --local-ui opencode`, including empty sessions; see [local OpenCode usage](docs/cli.md#experimental-local-opencode-interface).

## Run locally

Requires Node.js 22.14+ and npm. Linux needs the usual C++/Python build tools for `node-pty`; macOS needs Xcode Command Line Tools.

```sh
npm ci
npm run build
npm run dev
```

Open **http://127.0.0.1:4780**. The first run creates private `.local/config.json`, `.local/devices.json`, and a separate `.local/secrets/vault.key`. Copy the owner key from `devices.json` into the browser sign-in. This development key layout is convenient for rehearsal; copying the entire `.local` directory copies both ciphertext and its key.

Create a **Rehearsal** session to check continuity without calling a model. Other providers launch the configured native binaries with their normal permissions. They may wait for authentication, workspace trust, or tool approval.

```sh
npm run host -- doctor --config .local/config.json
npm run host -- list --config .local/config.json
npm run host -- attach SESSION_ID --config .local/config.json
```

`Ctrl+]` detaches the terminal client. `Ctrl+C` interrupts the underlying agent. Closing a client or the API leaves worker processes alive. To stop a session, use the authenticated owner `POST /api/sessions/:id/stop` endpoint. Stopping the entire VM stops its processes; automatic recovery after a host reboot is not implemented.

## Browser

Search sessions by title, provider, project ID, or session ID. **Active** shows running and starting processes, **Needs you** shows reported attention requests, and **All** includes recordings. The selected session and view stay in the URL, so reload and browser Back return to them.

Type a draft while monitoring or offline, then take control explicitly to send. **Cmd/Ctrl+Enter** sends; Enter adds a line. Switching sessions preserves drafts and recent views in this tab's memory. Reconnecting refreshes the view without sending the draft or reclaiming control. Reloading or closing the tab discards unsent drafts; they are not synchronized to other devices.

## Phone

The React Native app is in `apps/mobile`. It supports Android and has an iPhone build configuration. Pair it with an HTTPS Tailscale Serve address and a **controller** or **viewer** key. Keys go into Android Keystore/iOS Keychain through Expo SecureStore. Logs are kept in memory while the app is open and remain on the host for replay.

```sh
npm run android -w @infinite/mobile
npm run ios -w @infinite/mobile
```

On hosts whose workers enforce input control, the phone sends nothing until you tap **Take control** (or **Take over** when another device holds the session). The lease lasts 30 seconds, renews while the session is on screen, and is released when you leave the session or background the app. Viewers stay read-only.

Search the inbox or pull down to refresh it. The composer allows local drafting while monitoring or reconnecting, with a control action beside the draft when the host is ready. Taking control never sends the draft. Drafts remain in this app's memory across navigation; they are not shared with another device or retained after the app exits.

Push notifications need an EAS project ID. Keep it in the ignored `apps/mobile/.local/eas.json` file as `{ "projectId": "YOUR_EAS_PROJECT_ID" }`, or set `INFINITE_EAS_PROJECT_ID`. The dynamic app config adds it to `extra.eas.projectId` at build time. Set the same variable in the EAS preview and production environments for cloud builds; do not commit the real identifier to `app.json` or `eas.json`. See [Expo dynamic configuration](https://docs.expo.dev/workflow/configuration/).

For an Android emulator connected to the local rehearsal host:

```sh
adb reverse tcp:4780 tcp:4780
adb reverse tcp:8081 tcp:8081
```

Use `http://127.0.0.1:4780` in a **development** build. Release pairing requires HTTPS. If macOS binds Metro only to IPv6 localhost, start it with `NODE_OPTIONS=--dns-result-order=ipv4first npx expo start --localhost` from `apps/mobile`.

`eas.json` includes an Android internal APK profile. Signing and distribution to a physical phone require the owner's app signing setup. The debug APK is a development artifact, not a release build.

### Attention Brief and push

The host side is implemented: sessions report an attention state, `GET /api/me` advertises `capabilities` for signals, answering and push, and the API can send push notifications. The phone Brief is implemented too: the inbox, the decision card, the "So far" timeline, the docked composer and the terminal route. It was exercised on an Android emulator against the rehearsal host.

Two things are not verified yet. The live Claude Code and Codex spikes (S1 and S2 in the design spec) have not been run, so hook behavior against the real CLIs is untested. Push was verified only against a fake Expo endpoint, not delivered to a phone. Codex hooks are off by default until S2 runs; set `attention.hooks.codex` to `true` to try them.

Push setup, in order:

1. Create an EAS project with `eas init` in `apps/mobile` and set its project id.
2. Create a Firebase project for `dev.infinite.app`, download `google-services.json`, and point `android.googleServicesFile` at it.
3. Upload an FCM V1 service-account key with `eas credentials`.
4. Create an Expo access token and store it in a file with mode 0600 outside the state directory.
5. Enable the `push` block in the host config:

```json
"push": { "enabled": true, "accessTokenFile": "/path/outside/state/expo-token", "detail": "minimal" }
```

`detail` is `minimal` by default and `events` selects which states notify. Push messages go through Expo's push service, so enabling it adds an outbound dependency. Run `infinite doctor` to confirm the relay, hooks and push status.

## What is implemented

- Detached PTY workers; client and API lifetimes are independent of agent lifetimes.
- Same-process terminal attachment, screen snapshots, full raw terminal recordings, and paginated replay by sequence number.
- An encrypted record of session metadata, initial context, output, input intent, and delivery receipts. Records use AES-256-GCM with session/sequence authenticated data and a key outside the state directory.
- Owner, controller, and viewer access. Creation is owner-only; the phone UI only monitors and steers. These are credential roles, not proof of a physical laptop's identity.
- Device input control: one renewable 30-second lease per session, enforced in the worker, with explicit takeover. A refused input journals nothing.
- A laptop CLI that launches native provider CLIs with exact arguments, reattaches over one WebSocket, and starts from a bounded terminal snapshot.
- Idempotent creation and input IDs. An ambiguous terminal write is not automatically repeated. A delivered receipt means bytes reached the PTY, not that the provider accepted or completed a task.
- Versioned project context with conflict detection and an immutable starting snapshot per session.
- Responsive web client and native React Native client. Both visibly distinguish an unreachable host from an exited agent.
- A configurable concurrent session limit, default 24.
- Attention signals from agent hooks, terminal sequences and screen detection, journaled by source, with a per-session state (`working`, `needs-you`, `turn-finished`, `idle`, `exited`, `unavailable`, `recording-error`).
- A verified answer operation: the host presses keys for an on-screen dialog only when the prompt id and screen hash match, then reports `closed`, `still-open` or `changed`. Hooks never approve anything.
- Optional Expo push notifications with minimal bodies by default.

## Important boundaries

This is a universal terminal wrapper. It records visible terminal output and supplied requests; it does not expose hidden model reasoning or merge the internal state of four different providers. Provider-native history remains on the host. Mobile recording is a compact rendering of terminal events; it is not yet a structured message/tool-call timeline.

Project context is deliberately shared at session creation. Later changes must be sent to running sessions explicitly. Each session should use its own worktree when agents edit the same repository. Infinite currently uses the configured project directory directly; it does not create isolated worktrees or reconcile simultaneous file edits automatically. Configure separate project entries for parallel writers.

The system does not upload the laptop's home directory, synchronize arbitrary credentials, replicate local apps, provision MCP dependencies, or automatically pull cloud file changes into a dirty checkout. The cloud workspace is authoritative; use Git or SSH-based file access for source changes. Those boundaries matter for both fidelity and privacy.

Unattended work is limited by each provider's permissions, quotas, authentication expiry, and the task supplied. Infinite does not loop “continue” forever or silently approve tools. A machine that can execute a tool is not necessarily permitted to execute it unattended.

**An attacker controlling the active worker or guest root can read active files and memory.** Journal encryption does not change that. Workspace files, native CLI histories, swap, credentials, and backups need the separate storage/isolation controls described in [security](docs/security.md).

## Checks and deployment

```sh
npm run check
npm run lint -w @infinite/mobile
npm run export:android -w @infinite/mobile
npm run export:ios -w @infinite/mobile
```

The integration test starts 12 real demo PTYs, kills and restarts the API process, checks the same PIDs continue, replays recordings, and checks authorization and duplicate delivery. The vault test checks segment boundaries and authentication failures. These do not establish live Claude/Codex/Grok/OpenCode compatibility or cloud security.

An actual Android debug build was installed on the Pixel 9 emulator. Pairing, steering, native back navigation, and saved pairing after app restart were exercised. Android and iOS JavaScript bundles export successfully; iPhone native builds, physical phones, and release signing remain unverified. The terminal protocol regression also checks cursor-query responses without an attached client and a compact screen that preserves full history in the recording.

`scripts/browser-smoke.py` checks desktop/phone browser reconnect and steering against the local rehearsal server using Python Playwright. It reads `.local/devices.json` without printing keys.

See [architecture and protocol](docs/architecture.md), [server comparison](docs/hosting.md), and [Ubuntu commissioning](deploy/ubuntu/README.md). The commissioning record separates authenticated provider results, client/API continuity, tested data restoration, and cold-boot recovery work still required.
