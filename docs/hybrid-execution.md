# Hybrid execution and cloud handoff

## Default flow

`infinite codex` uses the invoking laptop project by default. `--cloud` opts out and uses the configured cloud project. The conversation, provider history, model credentials, permissions and recording remain on one persistent cloud backend. Other providers retain their existing execution behavior.

The first tool does not wait for a repository scan or upload. A detached laptop service registers the actual launch directory before the original prompt starts. It prepares the complete selected project and explicit `--include` directories in the background. Closing the interface leaves that service running.

On laptop loss, the worker allows five seconds for an idle relay to reconnect. This avoids moving a healthy laptop session during an API restart. When the checkpoint covers all observed executor operations and the provider supports environment selection, the worker starts a cloud executor against the already prepared tree and selects it in the existing conversation. A captured request that has not been dispatched receives an explicit not-executed error; the next provider step refreshes its environment. An unresolved request, process or writable file handle pauses continuation. Infinite never replays it or supplies a provider approval.

```mermaid
flowchart LR
  Conversation[Persistent cloud conversation] --> Laptop[Laptop tools]
  Laptop --> Capture[Incremental background checkpoint]
  Capture --> Prepared[Verified prepared cloud tree]
  Prepared --> Cloud[Cloud tools after outage]
  Cloud --> Recovery[Separate recovery copy on laptop]
```

## Project scope and checkpoints

The canonical launch directory remains authoritative, including nested directories. Git determines the project root; additional directories require `--include`. The entire selected scope is copied, including unread files, ignored files, binary contents, empty directories, executable bits, local commits, staged and unstaged changes, and untracked files. Selecting the entire home or filesystem is refused. Personal configuration outside these roots is not mirrored.

Linked Git worktrees project their selected HEAD, index and worktree settings together with common repository objects and refs. Other worktrees' private metadata is excluded. Nested Git pointers require a separately selected root. External object alternates, escaping links, special files and unsupported names prevent checkpoint publication. Symlinks within the selected scope are remapped to their corresponding cloud locations. There is no silent cache or dependency exclusion.

Content travels in bounded SHA-256 chunks over the authenticated executor connection. Already verified chunks and unchanged file metadata are reused. Periodic full reads supplement incremental captures. A new manifest is acknowledged only after its chunks and execution tree are verified and durable. Failed or interrupted preparation leaves the previous complete checkpoint eligible if it still covers all observed tool outcomes. New editor saves may remain on the laptop; the checkpoint timestamp shows the recoverable point.

Preparation trees reuse unchanged files from the previous inactive tree. The old tree is retired after publication. Cloud task execution never writes the immutable content store, and the manifest remains the reconciliation baseline after its execution tree becomes writable.

A checkpoint records a **capture span**, not an atomic filesystem snapshot. Stable reads, metadata verification and the macOS vnode change detector reject observed races. Writable shared mappings and application-level database transactions need an application-specific snapshot; these checks do not certify them. Process memory, open terminals, browser state and local databases are not migrated.

## Execution state and uncertainty

The API, web and phone distinguish tool location from conversation-host location. Session execution state reports connecting, online, preparing or paused, checkpoint age, readiness and a concrete blocker. `cloudReady` means a verified prepared tree covers the recorded executor boundary and the backend supports selection. It does not certify every package, external service or platform capability.

Dispatch and results are journaled before forwarding. Any meaningful executor operation advances the revision. A later cloud checkpoint must cover that revision before handoff. New dispatch is held during loss and selection; a fresh environment ID prevents reuse of laptop connection metadata. Live-turn selection and sticky future-turn selection are both acknowledged, and the loaded thread selection is read back before releasing a held not-executed result.

An uncertain command stays paused even if some output or side effects were observed. Killing a parent process does not prove its descendants stopped. Publication epochs prevent late laptop checkpoints and responses from replacing cloud state; they are not a revocable sandbox for arbitrary descendants or external effects. Detached local work may still affect the preserved laptop copy. Independent human edits are also preserved there. No automatic command replay, permission approval or reverse takeover is performed.

The backend's native host-file utilities are refused through the attached UI when they would bypass the selected workspace. Provider MCP services remain associated with their configured server; hardware, keychains, laptop-only services and unavailable cloud credentials do not migrate. A new executor reports its actual shell, OS, cwd and roots. Cross-platform dependencies may require rebuilding from the copied lockfiles. Platform-specific builds still require an appropriate executor.

## Returning to the laptop

Reconnection keeps tools on the cloud executor. A surviving laptop service can download a separate recovery copy. Explicit recovery also works after service loss:

```sh
infinite recover SESSION_ID
infinite recover SESSION_ID --output NEW_DIRECTORY
```

Recovery authenticates the owner, verifies downloaded content, and creates a new directory. It prints the recovered cwd. Compare that copy with the original laptop tree to reconcile offline changes; existing files are never overwritten. Automatic conflict merging, applying a merged tree, and moving tools back to the laptop remain separate work. Reconnecting or recovering files does not resend a prompt.

## Preparing the host

The supported provider integration pins Codex 0.162.0 with the narrow app-server patch in `patches/`. Stock Codex can run laptop tools but does not expose the required live and sticky selection API. Its session reports handoff unavailable rather than pretending to be ready.

```sh
npm run prepare:codex
```

This builds and qualifies an alternate app-server with its code-mode helper before publishing the complete bundle under ignored runtime storage. New default Codex profiles select that backend automatically; the installed Codex frontend is unchanged. Wrapped profiles use `appServerCommand` and `appServerArgs` explicitly to preserve their execution identity. Install both binaries together: models that require code mode cannot execute tools with an app-server alone. See [Ubuntu deployment](../deploy/ubuntu/README.md) for the separate agent account, shared execution-data directory and private control store. No host deployment is implied by local verification.

Both transfer endpoints require a paired owner. Executor attachment additionally requires a per-session capability. Capabilities stay out of model context and native frontend arguments. Checkpoint files and source data are plaintext in private runtime directories and need encrypted host storage; journals remain application-encrypted. All files within the selected roots are transferred, including any credentials stored there. The single-tenant trust boundary does not provide confidentiality from its owner or administrator.

Worker and provider process restart recovery, automatic dependency provisioning, arbitrary descendant containment, atomic database snapshots, and automatic merge/application are not implemented. API restart preserves the detached worker. Source and content storage currently require operator-managed retention.

## Verification

The existing provider-boundary integration owns default project selection, dirty/untracked/included files, real checkpoint transfer, API restart, automatic handoff, uncertain-operation pause, recovery and authorization. It uses actual Infinite processes with a fixture provider, without fabricating checkpoint receipts.

Separate rehearsals use actual Codex app-server, TUI and exec-server processes with an isolated loopback model fixture. They verify first-turn local instructions and edits, empty launch without a synthetic prompt, idle handoff, and active-turn continuation after abrupt laptop service loss. A delayed old-environment command is refused before execution; the next command and later native prompt use cloud files in the original thread. Offline laptop changes and the unrelated host project stay intact. The installed CLI bundle also completed launch, background preparation, handoff and recovery. These are local integration results, not proof of a deployed cross-OS host or live provider account.

A separate deployed rehearsal on 2026-10-09 used the installed CLI, an authenticated model using code-mode tools, a macOS laptop, and a Linux host. With workspace-write sandboxing and on-request approvals, the first tool edited the laptop fixture. Abrupt laptop-service loss selected the cloud checkpoint in about six seconds; a follow-up in the same conversation read the checkpoint and wrote a Linux file. Recovery preserved an independent offline laptop edit. Git access through the deployed agent identity and preservation of existing sessions through the API upgrade were checked separately. Private receipts remain outside this repository. This establishes that bounded workflow, not general toolchain or platform parity.

The [implementation plan](plans/2026-10-09-001-feat-seamless-hybrid-execution-plan.md) retains stronger isolation and reconciliation follow-ups. This page describes the implemented boundary.

## Earlier SSH prototype

The opt-in [prototype script](../scripts/hybrid-codex.mjs) keeps an existing Infinite Codex conversation on its cloud backend and attaches the current laptop as its execution environment. It uses the installed Codex execution server, Infinite's owner authentication and device control, and an authenticated loopback executor reached through a private SSH reverse tunnel. It does not upload a repository before starting work.

This is a single-tenant development prototype. Use a disposable native Codex conversation and a fixture repository. The integrated default launch described above replaces this manual setup. The script retains its original behavior and does not use the checkpoint coordinator.

## Run

Create a native Codex conversation, let its first turn finish, and detach its interface. Keep its Infinite session ID. The chosen cloud project remains the conversation's administrative association; `--cwd` selects the laptop files used by the prototype.

```sh
infinite --cloud --detach --local-ui --project PROJECT_ID codex "Describe the intended task; do not use tools yet."
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

## Current prototype offline behavior

When the laptop is unavailable, local tool calls fail with an executor connection error. Codex may still reason about that failure; disconnection does not freeze all model activity. There is no automatic substitution of a cloud working directory and no automatic resend by the prototype. A phone can inspect the conversation, but cannot make an unavailable laptop execute commands.

The integrated launch described above owns checkpoint preparation and automatic handoff. This prototype's lifecycle test establishes wrapper/helper cleanup only; it does not establish execution-lease expiry for arbitrary processes.

The protocol foundation is Codex's experimental `environment/add`, `environment/info`, and per-turn environment selection in the installed generated schema. The official [app-server guide](https://learn.chatgpt.com/docs/app-server) describes the native client protocol and experimental environment inspection. The separate [self-hosted sandbox guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) illustrates harness/executor separation, but its hosted registration and authentication flow is not used here.

On 2026-10-09, freshly generated experimental types from installed Codex 0.162.0 still expose `environment/add`, `turn/start.environments`, per-environment cwd and workspace roots. This is protocol evidence, not a new cloud-handoff test. The upstream [execution-server documentation](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md) describes filesystem/process RPCs and authenticated connections; it does not establish Infinite's fencing or checkpoint contract. [Git partial-clone documentation](https://git-scm.com/docs/partial-clone) explains deferred object retrieval, which can reduce history transfer but does not establish completeness of a selected checkout by itself.
