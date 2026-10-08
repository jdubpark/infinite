# Hybrid Codex prototype

The opt-in [prototype script](../scripts/hybrid-codex.mjs) keeps an existing Infinite Codex conversation on its cloud backend and attaches the current laptop as its execution environment. It uses the installed Codex execution server, Infinite's owner authentication and device control, and an authenticated loopback executor reached through a private SSH reverse tunnel. It does not upload a repository before starting work.

This is a single-tenant development prototype. Use a disposable native Codex conversation and a fixture repository. Normal `infinite codex` and `infinite --local-ui codex` launches retain cloud execution. The phone and web clients do not yet display a separate execution environment or its availability, and no production launch default has changed.

## Run

Create a native Codex conversation, let its first turn finish, and detach its interface. Keep its Infinite session ID. The chosen cloud project remains the conversation's administrative association; `--cwd` selects the laptop files used by the prototype.

```sh
infinite --detach --local-ui --project PROJECT_ID codex "Describe the intended task; do not use tools yet."
node scripts/hybrid-codex.mjs \
  --session SESSION_ID \
  --ssh USER@HOST \
  --cwd /workspace/example \
  --prompt "Read this repository's instructions and inspect the working tree."
```

Run the script from an Infinite checkout with dependencies installed. Supply an existing SSH destination for the same execution host; host-key checking is mandatory. `--ssh-config FILE` selects an existing private OpenSSH configuration. `--client-config FILE` selects another paired Infinite configuration. Credentials remain in their existing stores and never belong in command-line arguments or this repository.

The script claims input control for setup, registers a fresh executor generation, verifies its working directory, and submits the supplied follow-up once against the existing native conversation. It updates both Codex's selected environment and its default working directory so a native interface reconnect uses the laptop repository. It then releases control and opens the installed native Infinite interface. `--no-ui` keeps the laptop executor connected while another device monitors or steers the session. Provider permission requests remain explicit native dialogs; the script never answers them.

Close the prototype to disconnect local tools. Parent-owned pipes close the executor, SSH tunnel and native interface helpers even if the prototype process is killed. A process already started by a tool may have produced side effects before disconnection; inspect those files and conversation history before continuing.

To reconnect, invoke the script again with the same Infinite session and laptop directory, and a new explicit follow-up. Each connection gets a new provider environment ID because loaded Codex threads can retain a cached connection for an older ID. The native conversation ID remains unchanged. `infinite resume` alone restores the interface; it does not start this laptop executor.

## What stays where

| Data or action | Location |
| --- | --- |
| Conversation, model authentication, Infinite history and provider permission dialogs | Cloud backend |
| Repository, uncommitted files, installed dependencies, local shell and tool processes | Selected laptop |
| Files read into prompts and tool results | Sent into the cloud conversation and selected model provider as needed |
| Executor capability | Held in memory by the prototype and cloud app server; never passed to the native TUI |
| Repository checkpoints and offline execution | Not implemented |

The SSH tunnel binds a remote loopback port and forwards to an authenticated laptop loopback listener. The prototype requires a trusted single-tenant owner pairing. It does not offer confidentiality from the cloud host administrator, isolate laptop credentials from an authorized local tool, or provide a tenant boundary.

## Validation

A live rehearsal with Codex 0.161.0 on macOS and 0.160.0 on Linux verified laptop repository instruction discovery, reading and editing an uncommitted laptop-only file, explicit permission handling, and reconnecting to the same cloud conversation. A follow-up typed into the installed native TUI also read the laptop file without a workspace fallback. Killing the wrapper removed its executor, tunnel and native interface helpers while preserving the cloud conversation. Rehearsal data and deployment details are recorded privately, outside this repository.

The automated process-lifecycle regression uses fixture executables and a fixture host; it verifies wrapper cleanup without requiring a cloud account. A separate probe using real Codex processes and a fixture model verified that disconnected laptop tool calls fail without writing into the cloud workspace. These checks do not establish automatic offline handoff, arbitrary background-process cleanup, or support for other providers.

## Offline behavior and remaining gates

When the laptop is unavailable, local tool calls fail with an executor connection error. Codex may still reason about that failure; disconnection does not freeze all model activity. There is no automatic substitution of a cloud working directory and no automatic resend by the prototype. A phone can inspect the conversation, but cannot make an unavailable laptop execute commands.

Before making hybrid execution a normal launch mode:

- Persist conversation ownership separately from execution ownership, workspace identity, and executor generation.
- Show the selected repository, tool location, connectivity and checkpoint age on the CLI, phone and web clients.
- Gate a new execution generation on interrupted-command reconciliation, including background processes and uncertain external effects.
- Verify provider permissions, native patch tools, instruction discovery, local MCP configuration and reconnect behavior across supported Codex versions.
- Prepare an optional cloud workspace from explicit incremental checkpoints, preserving uncommitted and divergent files. A lid-close hook cannot upload data after connectivity has disappeared.
- Rehearse checkpoint-based cloud handoff with exclusive execution ownership. A macOS process cannot migrate intact to Linux.

The protocol foundation is Codex's experimental `environment/add`, `environment/info`, and per-turn environment selection in the installed generated schema. The official [app-server guide](https://learn.chatgpt.com/docs/app-server) describes the native client protocol and experimental environment inspection. The separate [self-hosted sandbox guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) illustrates harness/executor separation, but its hosted registration and authentication flow is not used here.
