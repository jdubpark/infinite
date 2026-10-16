# Cloud-first execution, context transfer, and the delegate agent

Status: approved design, 2026-10-16. Supersedes the laptop-default execution direction recorded on 2026-10-09 in `PRODUCT.md` and `docs/hybrid-execution.md`. Implementation follows the plans derived from this spec.

## Decision

Sessions run on the selected cloud machine by default for every provider. The Mac and the phone are connectors: they attach to cloud sessions, edit prompts locally, and move context into the cloud. They do not execute tools unless the owner selects laptop execution explicitly.

Three sub-projects follow from this, in order:

1. Cloud-default execution and one-way workspace sync.
2. Context bundle and drop inbox.
3. Delegate agent, then a cloud browser profile.

Each sub-project gets its own implementation plan. This document holds the shared contract.

## Why

`docs/native-continuity.md` already names "local interface, persistent cloud execution" as the preferred boundary and treats Mac execution with automatic takeover as a separate mode. Claude, Grok, and OpenCode already run cloud-first. Only Codex defaults to laptop tools, and that path pins a patched Codex app-server, a code-mode helper, publication epochs, and fencing that never extended to the other providers. Measured on 2026-10-05, a Tailscale round trip was about 1.2 seconds against sub-10 ms loopback, so latency is solved by local native UI over a remote backend, not by local execution.

What the pivot does not change: platform-bound work such as iOS simulator builds and cmux still needs a Mac. Laptop execution stays available as an explicit mode.

## Goals

- A session created from any connector runs in the cloud and survives every connector disconnecting.
- A cloud session has the project files, declared secrets, and declared configuration from the owner's Mac without the owner copying anything by hand.
- The owner can add a file to a running session from web, phone, or the CLI, and the agent learns where it landed.
- When the owner is unreachable, a delegate agent can clear blocked sessions within an owner-written policy, and every action it takes is attributed and reviewable.
- Every client shows execution location, sync age, bundle sync time, and who answered each prompt.

## Scope boundary: the Infinite CLI only

Everything in this document applies to sessions started through `infinite`, the Infinite web client, the phone app, or a delegate. Running `claude`, `codex`, `grok`, or `opencode` directly on the Mac is unchanged: no sync service watches those directories, no bundle is read, no hooks are injected, and no delegate sees those sessions. The workspace sync service only watches projects the owner configured for Infinite, and only while the Infinite laptop service is running. Installing or updating Infinite must not modify provider configuration, shell startup files, or global hooks for the owner's plain CLIs.

## Non-goals

- Automatic migration of a running laptop process to the cloud in the default mode.
- Two-way file sync or automatic merge of cloud changes back to the Mac. Pulling cloud changes uses the existing recovery download into a separate directory.
- Copying browser cookies or keychains from the Mac.
- Multi-tenant operator confidentiality. That gate is unchanged in `docs/multi-tenant.md`.
- A native Mac app. The Mac connector is the web client, the `infinite` CLI, and the local native provider UIs.

## Execution model

`infinite codex` uses the configured cloud project, matching the other providers. `--laptop` selects laptop execution and keeps today's hybrid behavior, including background preparation and automatic handoff, behind that flag. `--cloud` remains accepted and is a no-op. The hybrid preparer, checkpoint coordinator, and Codex qualification remain in the repository but stop being a release gate for the default path.

Session records carry `executionLocation: "cloud" | "laptop"` and `machineId`. Clients show both. No component moves execution between locations without an explicit owner action.

Local native UIs for Codex and OpenCode remain the laptop interface for typing latency. Claude Code and Grok stay on streamed terminals until a supported native client-to-backend split is verified, as recorded in `docs/native-continuity.md`.

## Connectors and roles

A connector attaches to sessions it does not own. Roles become `owner`, `controller`, `viewer`, and `delegate`.

| Role | Create, resume, stop | Steer text, answer prompts | Monitor | Policy |
| --- | --- | --- | --- | --- |
| owner | yes | yes | yes | edits |
| controller | no | yes | yes | none |
| viewer | no | no | yes | none |
| delegate | no | within policy only | yes | none |

A delegate key never creates, resumes, or stops a session, never edits configuration or policy, and never forces input past an open prompt. Device keys for all roles are created with `device-add --role` and revoked with `device-revoke`, and take effect on API reload as today.

## Workspace sync

The laptop service already built for hybrid preparation becomes the workspace sync service. It runs detached on the Mac, watches each configured project, and pushes the selected scope to the cloud workspace for that project in bounded SHA-256 chunks over the authenticated connection. Scope rules are unchanged from `docs/hybrid-execution.md`: Git decides the project root, `--include` adds directories, the whole scope travels including ignored and untracked files, and the home or filesystem root is refused.

Differences from the hybrid preparer:

- The cloud workspace is the executing copy. The synced tree is applied to the configured project directory as a new generation, not held as a standby checkpoint.
- Sync is laptop to cloud only. While a session is running in that workspace, incoming generations are staged and listed as pending. Applying a pending generation is an explicit owner action on web, phone, or CLI, because applying it under a running tool would change files the agent is reading.
- A project records `lastSyncedManifest`, `lastSyncedAt`, and `pendingGeneration`. `GET /api/projects/:id` returns them. All clients show sync age next to execution location.
- Publication epochs and takeover fencing are not used. There is one executor per workspace, and it is the cloud.

Cloud changes return to the Mac through `infinite recover SESSION_ID --output DIRECTORY`, which is unchanged. Comparing and merging is the owner's work until the reconciliation units in `docs/plans/2026-10-09-001-feat-seamless-hybrid-execution-plan.md` are built.

## Context bundle

A context bundle is the set of secrets and configuration a project's sessions need from the Mac. The owner declares it; nothing outside the declaration is read.

Declaration lives in the private client configuration on the Mac, per project, with an optional global section:

```json
{
  "bundle": {
    "global": [
      { "kind": "file", "from": "~/.gitconfig", "to": "~/.gitconfig" },
      { "kind": "env", "from": "~/.config/infinite/global.env" }
    ],
    "projects": {
      "example": [
        { "kind": "env", "from": ".env.local" },
        { "kind": "file", "from": "~/.ssh/deploy_example", "to": "~/.ssh/deploy_example", "mode": "0600" },
        { "kind": "dir", "from": "~/.config/example-cli", "to": "~/.config/example-cli" }
      ]
    }
  }
}
```

Item kinds: `env` merges a dotenv file into the session environment; `file` and `dir` are placed at `to` under the cloud agent home or workspace with the given mode. Relative `from` paths resolve against the project root. Paths that escape the home or project, symlinks that escape, and sizes above 16 MiB per item are refused at declaration time with the offending path named.

Transport: the laptop service reads the declared items, encrypts the bundle to the host's vault key, and uploads it with `PUT /api/projects/:id/bundle` as an owner. The host stores it under the private runtime directory, application-encrypted like journals, and records `bundleVersion` and `bundleSyncedAt`. A re-upload replaces the previous version atomically. `DELETE` removes it.

Injection: when a worker starts a session for that project, the host materializes the bundle into that session's environment and home before the provider launches. `dir` and `file` items are written fresh each launch; stale copies from a removed declaration are deleted. Running sessions are not changed by a new bundle version; their session record shows which version they started with.

Visibility: web, phone, and `infinite bundle` list item kinds, destinations, sizes, and sync time. No client ever returns a value. The agent can read the materialized values on the host, which is the accepted single-tenant trust model.

## Drop inbox

`POST /api/sessions/:id/inbox` accepts a file for a running or idle session from any owner or controller connector. Web drag and drop, the phone share sheet and file picker, and `infinite push FILE [FILE...] --session ID` all use it.

- Files land in `.infinite/inbox/` inside the session workspace under their original basename. A name collision appends a short hash suffix. Nothing is overwritten.
- Uploads are chunked at 4 MiB, limited to 256 MiB per file, and resumable by file hash. A completed upload returns `{ path, bytes, sha256, receivedAt }`.
- On completion the worker journals a `host` signal of kind `inbox-file` with the path and hash, so the agent sees it in Chat and the owner sees it in the timeline. For terminal-only providers, Chat also shows a prefilled one-line notice naming the path that the owner, a controller, or the delegate can send as ordinary input; the worker never types it on its own.
- `.infinite/` is added to the workspace sync exclusion so inbox files do not round-trip to the Mac.
- A cmux-backed session has no Infinite-owned workspace writer. Inbox is refused for cmux sessions with `409 { error: "backend-unsupported" }`.

## Browser logins

Cookies, keychains, and browser profiles are not copied from the Mac. In sub-project 3, the host gains one persistent browser profile per project. The owner signs in once through a streamed browser view from web or phone, and agents in that project use that profile. Until that exists, a session blocked on a web login is a `needs-you` that the delegate cannot clear, and clients say so.

## Delegate agent

The delegate is an ordinary agent session, Claude Code or Codex, running on the cloud host under a `delegate` device key and its own provider account. The host supplies events and enforces policy. The model decides whether to act within that policy.

### Components

- **Delegate key.** `device-add --role delegate --name Delegate`. Its token is placed in the delegate agent's environment on the host, never in a client or in the repository.
- **Policy file.** Owner-written, stored in host configuration, reloaded on API restart like device keys. See grammar below.
- **Attention subscription.** `GET /api/attention/stream` streams session attention transitions as server-sent events to owner and delegate roles. Each event carries the session id, the new state, the open prompt id and classification if any, and the delegate policy outcome the host would apply.
- **Delegate runner.** A host-side service that launches the delegate agent when a subscribed session enters `needs-you` or `turn-finished` and no owner has acted within a configurable delay, default 10 minutes. The runner passes a briefing: session title, project, the last 40 chat messages, the open prompt with its options and classification, and the policy summary for that project. One delegate run per session at a time. The runner backs off after three consecutive denied actions on one session and pushes the owner.
- **Attribution.** Every delegate answer, text, and plan response is journaled with `source: "delegate"`, the delegate device id, and the policy rule that allowed it. Clients show the delegate as the responder in Chat and in the timeline.

### Policy grammar

```json
{
  "delegate": {
    "enabled": true,
    "waitMinutes": 10,
    "maxApprovalsPerSessionPerHour": 12,
    "projects": {
      "example": {
        "approve": [
          { "promptKind": "permission", "optionRole": "allow", "scope": "workspace-edit" },
          { "promptKind": "permission", "optionRole": "allow", "scope": "read-only-command" }
        ],
        "deny": [
          { "destructive": true },
          { "scope": "network-push" },
          { "promptKind": "permission", "optionRole": "allow-always" }
        ],
        "text": true,
        "plan": "feedback-only"
      }
    }
  }
}
```

- `approve` and `deny` are ordered rule lists. Deny wins over approve. No matching approve rule means deny.
- `promptKind` and `optionRole` come from the shared attention package's prompt classification. `scope` is derived by the host from the prompt detail: `workspace-edit` for file writes inside the workspace, `read-only-command` for commands with no write or network effect by pattern, `network-push` for commands matching push, publish, or deploy patterns. `destructive: true` matches the existing destructive pattern list.
- `text: true` allows text replies when no prompt is open. `plan: "feedback-only"` allows plan feedback but not plan approval; `"approve"` allows both; `"none"` allows neither.
- Policy is evaluated per project. A session in a project with no policy entry receives no delegate action.

### Enforcement

The host, not the delegate, decides what is allowed.

- `POST /api/sessions/:id/answer` from a delegate key is evaluated against the policy and the live screen hash before any keystroke. Out-of-scope answers return `403 { error: "policy-denied", rule }`, journal a `delegate-denied` notice, and count toward the back-off. In-scope answers follow the existing pre-check, navigate, Enter, post-check sequence.
- `POST /api/sessions/:id/input` from a delegate key is refused while any prompt is open, including with `force: true`.
- The hourly approval cap is enforced per session. The cap exhausting pushes the owner.
- A delegate key cannot reach `/api/sessions` creation, `/resume`, `/stop`, `/control`, `/bundle`, `/inbox`, or any configuration route.

### Honesty rule

`PRODUCT.md` keeps "the host never infers task completion and never approves a provider permission on its own" and adds: an owner-configured delegate may approve only what the owner's written policy allows, the host enforces that policy on every answer, and every delegate action is attributed and reviewable. The delegate does not infer task completion either; `turn-finished` is reported, never upgraded to done.

## API summary

| Change | Endpoint | Role |
| --- | --- | --- |
| Project sync state | `GET /api/projects/:id` adds `lastSyncedAt`, `pendingGeneration` | Any |
| Apply pending generation | `POST /api/projects/:id/sync/apply` | Owner |
| Upload bundle | `PUT /api/projects/:id/bundle`, `DELETE` | Owner |
| List bundle items | `GET /api/projects/:id/bundle` | Owner, controller |
| Upload to inbox | `POST /api/sessions/:id/inbox` | Owner, controller |
| Attention stream | `GET /api/attention/stream` | Owner, delegate |
| Delegate policy | host config, reloaded on API restart | Owner |

The shared remote client carries these over the encrypted relay like the existing routes. Chunked upload frames fit the existing 96 KiB request limit by using 64 KiB chunks over the relay and 4 MiB chunks over direct HTTPS.

## Security

- Bundle values on the host are readable by any agent running in that project. This is the single-tenant trust model the owner accepted; it does not provide confidentiality from the host or its administrator. The multi-tenant confidential runtime remains the gate for private tenants.
- The bundle is encrypted in transit by the authenticated connection and at rest by the vault key. Declarations with escaping paths are refused on the Mac before anything is read.
- Delegate agents use their own provider account. Their provider history and spend are separate from the owner's.
- The delegate token lives in the delegate agent's environment on the host, so the delegate agent can read it. It is a `delegate` key and grants nothing beyond that role.
- Inbox uploads are owner or controller only, size-capped, and never overwrite. Content is untrusted data to the agent, as any file is.
- Push notifications stay minimal by default and never carry bundle contents, inbox contents, or prompt detail unless `push.detail: "full"` is set.

## Testing

- **Policy enforcement.** Property tests generate prompts, option roles, scopes, and policies, and assert deny wins, no-match denies, and the cap holds. Concrete cases cover each example rule above.
- **Workspace sync.** Integration tests with real Infinite processes and a fixture provider cover a dirty tree with untracked and ignored files, a pending generation while a session runs, explicit apply, and recovery download. No fabricated receipts.
- **Bundle.** Tests cover declaration validation, encrypted round trip, materialization with modes, removal of stale items, and that no client route returns a value.
- **Inbox.** Tests cover chunked and resumed upload, collision suffixing, the `inbox-file` signal, the cmux refusal, and the relay chunk size.
- **Delegate loop.** An end-to-end test runs the runner against a fixture agent that attempts one allowed approval, one denied approval, one text reply with a prompt open, and verifies attribution, the 403, the refusal, and the back-off push.
- **Providers.** Each provider is qualified separately for cloud-default launch and for delegate answers against its real dialogs. A shared transport test does not establish a provider.

## Documentation changes

- `PRODUCT.md`: rewrite the Operating Context paragraph to state cloud execution as the model, laptop execution as an explicit mode, and the delegate amendment to the honesty rule.
- `docs/architecture.md`: update the execution model and the role table.
- `docs/hybrid-execution.md`: retitle around laptop execution mode and recovery; move sync semantics to a new `docs/workspace-sync.md`.
- `docs/cli.md`: document `--laptop`, `infinite push`, and `infinite bundle`.
- `docs/security.md`: add the bundle, inbox, and delegate threat notes above.
- New `docs/delegate.md` for the policy grammar and enforcement contract.

## Open follow-ups

- Cloud browser profile with a streamed sign-in view.
- Two-way sync and reconciliation, carried from the hybrid plan.
- Claude Code and Grok native client-to-backend attachment, pending provider support.
- Multi-tenant confidential execution, unchanged.
