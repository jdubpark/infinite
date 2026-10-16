# Remote machines

Infinite provides one web and phone interface for independently paired machines. Select a machine, choose a configured project and agent, then create or steer its sessions. An owner key permits creation, resumption, and termination; a controller key permits steering; a viewer key permits monitoring. CmuxControl remains an independent cmux controller and is not a dependency.

A machine can be a cloud host or an online laptop. The laptop must be awake, connected, and running Infinite. Closing a browser or disconnecting a phone leaves its sessions running. Laptop sleep does not move a laptop process to the cloud. Codex's separate [laptop execution mode](hybrid-execution.md) has its own preparation and handoff requirements; selecting a machine in these clients does not enable that flow.

## Set up a machine

Use Node.js 22.14+ and install/authenticate the desired providers on that machine. Run these commands from the Infinite repository. The host commands use the compiled host CLI; the separately installed `infinite` laptop client retains its direct-host terminal commands.

```sh
npm ci
npm run build
node packages/host/dist/cli.js init --local --name Laptop --cmux --remote --project /srv/projects/example --config /private/infinite/config.json
node packages/host/dist/cli.js machine-info --config /private/infinite/config.json
node packages/host/dist/cli.js serve --config /private/infinite/config.json
```

The paths above are placeholders. Choose private configuration/key storage and an actual project directory. `--local` allows a loopback origin. For a cloud runner, omit it and provide its private HTTPS `--origin`. Omit `--cmux` on machines without cmux. Add `remote: {"enabled": true}` to an existing single-tenant config to enable encrypted direct access; `connect-relay` also enables it. Existing configs receive a stable machine ID derived from their vault key; `machine-info` reports it. New configs store a random ID explicitly.

The machine owns provider credentials and configured project directories. A session created from a phone runs in the selected machine's project; it does not copy the phone's files or silently select another machine. Separate projects/worktrees are required for independent concurrent writers.

```sh
node packages/host/dist/cli.js project-add example /srv/projects/example --name Example --config /private/infinite/config.json
node packages/host/dist/cli.js device-add --role owner --name Phone --token-file /private/phone.key --config /private/infinite/config.json
node packages/host/dist/cli.js install-service --config /private/infinite/config.json
```

Use a new project ID when adding to an existing configuration. `device-add` creates a private key file and prints only its device ID. Pair with that key, not a relay registration key. Config edits require an API restart; ordinary API restarts preserve detached Infinite workers. `install-service` installs one current-user login service on macOS or Linux, using the compiled checkout and current Node/PATH. Keep that checkout available. It does not keep a laptop awake or authenticate providers. `uninstall-service` removes the service. Machine-level service behavior should be verified on the deployment platform before relying on unattended restarts.

To revoke a device, run `device-revoke DEVICE_ID --config /private/infinite/config.json` with the compiled host CLI, then restart its API immediately. At least one owner must remain. Keys remain valid until the running API reloads configuration.

## Access from any network

Direct access works over private HTTPS, such as Tailscale Serve, while every client can reach that private network. For a phone or browser without that VPN, run a separate relay behind public HTTPS. The runner opens an outbound connection, so the laptop needs no inbound port forwarding.

On the relay machine:

```sh
node packages/host/dist/cli.js relay-init --port 4790 --config /private/relay.json
node packages/host/dist/cli.js relay-add --machine MACHINE_UUID --token-file /private/registration.key --config /private/relay.json
node packages/host/dist/cli.js relay-serve --config /private/relay.json
```

Replace `MACHINE_UUID` with `machine-info`'s ID. Transfer the registration file privately to that machine. The relay stores only its hash; each machine needs a distinct registration. Restart the relay after registration changes. Terminate HTTPS at a reverse proxy that forwards WebSocket upgrades to the loopback relay port. The relay serves the built web portal and `/relay/hosts/:machineId` and `/relay/clients/:machineId`; it does not expose the runner's ordinary HTTP API.

On the runner:

```sh
node packages/host/dist/cli.js connect-relay https://relay.example.com --token-file /private/registration.key --config /private/infinite/config.json
```

Restart the runner API. In web or phone **Add machine**, enter the relay HTTPS origin, machine ID, and that machine's paired device key. Leave machine ID empty for a direct host connection. Browser cross-origin direct pairing uses the encrypted socket and requires remote access enabled on that host. Mobile direct pairing retains the ordinary HTTPS API for compatibility. Native profiles live in platform secure storage; browser profiles and keys stay in tab memory and must be entered again after reload. Same-origin browser cookie login remains supported.

The relay can also serve the web client, but that makes its operator a trusted supplier of executable browser code. A separately trusted browser origin or trusted native build is needed when the relay operator is outside the trust boundary. See [security](security.md#remote-machine-transport).

## Sessions and cmux

Both clients offer Chat, Terminal, Files, creation, and lifecycle controls. Drafts, caches, routes, and input ownership are scoped by machine and session. Switching machine never transfers control. Notifications identify the exact paired machine; notifications for an unpaired machine do not open a different host's session. Dictation uses the phone keyboard or a supported browser speech service and never sends automatically.

The cmux backend supports Claude Code and Codex. Discovery uses cmux's workspace tree, Vault history, hook session records, and pending Feed items. Only sessions inside configured project roots are imported. cmux must provide the relevant JSON RPC methods and maintain provider hooks/history. `cmux.command` can select its executable; `cmux.hooksDir` can override its hook directory. Missing cmux or unverifiable foreground state disables input rather than sending text to a shell.

An existing native conversation receives a stable Infinite ID. Imported sessions remain owned by cmux; Infinite does not move their process under a worker. New cmux sessions use the configured provider command and project in a new cmux workspace. A current remote input lease, matching surface, and verified foreground provider process are required before mutation. Local keyboard input and CmuxControl are outside Infinite's lease boundary and can still change the screen. Infinite rechecks prompts before answering, refuses normal chat while a decision or unfinished local draft is present, and never approves provider permissions automatically.

Authenticated Feed questions accept explicit text, including one answer per line for multiple questions. Plan feedback without an approval choice rejects the plan. An unavailable Feed keeps a known unresolved decision blocked until a fresh Feed observation resolves it. Unsupported screen-only questions must be answered in native cmux on the machine; Infinite Terminal does not bypass an open decision. An exited Infinite recording does not hide a live cmux continuation of the same conversation.

For cmux, Terminal shows periodically captured plain screen snapshots at the observed viewport size. It is not a lossless PTY recording and does not resize the cmux window. Chat reads available native transcript entries with an opaque cursor. Infinite worker Chat shows submitted input with confirmed delivery and explicit provider message/tool signals; it may omit output that only exists in Terminal. Chat delivery is not proof that a model accepted or executed a request.

Files accepts a project-relative path, resolves symlinks, and rejects files outside the selected session directory. Previews are bounded to 1 MiB of text or 2 MiB of supported images. It is a convenience within the trusted runner, not a sandbox against a malicious local account changing the filesystem. Hybrid workspace previews are refused because the actual executor can differ from the host directory; inspect the executor or obtain an explicit recovery copy.

Explicit Resume is available after confirmed exit when a supported native conversation ID was recorded. Infinite worker resume creates a new runtime and recording with a new request ID; concurrent requests for the same recorded conversation attach to its existing continuation. Each request retains its result across API restarts and process exit. A fresh request is required to start a later continuation, and an unreachable continuation blocks another launch. cmux resume launches the recorded conversation in a new workspace. Neither resends the initial prompt. An unavailable process cannot safely be treated as exited. Grok worker resume and automatic process recovery after host reboot are not implemented.

Concurrent cmux observations share queued work. Each queue admits at most eight waiting observations or eight waiting mutations; controls run before queued observations, and observations expire after five seconds waiting. Busy reads return an explicit unavailable state or a retryable busy error. Admitted mutations still perform fresh permission, foreground, and lease checks and retain their delivery receipts.

## Request and failure contract

`GET /api/me` returns `machine`, enabled `backends`, and `backendProviders`. `POST /api/sessions` accepts optional `backend: "infinite" | "cmux"` and a stable `requestId`. Session records include `machineId` and `backend`. Additional endpoints are:

| Operation | Endpoint | Contract |
| --- | --- | --- |
| Chat | `GET /api/sessions/:id/messages` | Optional opaque `after` and bounded `limit`; returns messages, cursor, more, source |
| File preview | `GET /api/sessions/:id/file?path=` | Project-relative text or supported image |
| Resume | `POST /api/sessions/:id/resume` | Owner, stable requestId, explicit native continuation |

The shared `@infinite/remote` client carries these same API requests over encrypted WebSocket frames. Raw PTY/native provider protocols, workspace administration, and arbitrary native launch arguments are excluded. Existing roles, prompt checks, and device-bound control leases still apply. The installed terminal CLI continues to require direct private network access; relay access is available to web, native phone, and shared-client integrations.

Reconnect never replays pending mutations. A lost receipt is uncertain even if the connection returns. Explicit retry keeps the same request ID and payload. New session creation records durable intent before spawning; an ambiguous outcome cannot silently create a second process. A creation response with HTTP 400 and code `invalid-create` rejects the request before launch, so the form can be corrected. Pending creation and lifecycle receipts survive navigation within the running client and settle only their matching request. A fresh confirmed process exit retires an unconfirmed End request and exposes explicit Resume, while still reporting that End delivery was unconfirmed. Cached, unavailable, and recording-error observations cannot do this. An offline machine is unavailable; other paired machines remain independently usable. No component infers task completion from silence or an idle terminal.
