# Ubuntu commissioning

This template runs an owner-controlled, single-tenant host. The pilot installation and verified limits are recorded in [Host commissioning](commissioning.md). For multi-tenant development, use the [synthetic-only Proxmox profile](../proxmox/README.md). Operator-confidential multi-tenancy requires the separate [managed tenant architecture](../../docs/multi-tenant.md).

These files describe the deployment template; the commissioning record distinguishes checks performed on the actual server from outstanding work. No paid infrastructure is created by these scripts.

## Prepare the host

1. Select and approve the actual server, region, final price, backup destination, and recovery policy. For this workload, consult the [server comparison](../../docs/hosting.md) when choosing new hardware.
2. Install Ubuntu 24.04 LTS. Establish and verify encrypted storage mounted at `/srv/infinite-data`. On bare metal, arrange LUKS unlock and keep recovery material off-host. Verify encryption independently; a mount point alone does not prove it. Use encrypted swap or disable swap. Do not format a disk containing existing data as part of application installation.
3. Install Node.js 22.14+ from a verified upstream package, npm, build-essential, Python 3, Git, sudo, acl, Bubblewrap, and Tailscale. Confirm the actual Node path and update `ExecStart` if it differs from `/usr/local/bin/node`.
4. Enroll Tailscale through the owner's account, approve only the owner's devices, and configure narrow SSH/HTTPS access. Keep provider-console recovery available before closing public SSH. Deny public inbound API access. Port 4780 stays bound to loopback.

## Separate identities and directories

Create a control user `infinite-host` with home `/srv/infinite-data/control-home` and an agent user `infinite-agent` with home `/srv/infinite-data/agent-home`. These are distinct Unix accounts. Preserve the existing administrator login; never run the API as an account with administrator or LXD privileges. The `infinite-workspace` group grants both accounts access to approved workspaces. Do not add the agent user to Docker's group or allow sudo.

| Path | Owner | Mode / purpose |
| --- | --- | --- |
| `/opt/infinite` | root | Application code and dependencies; no agent write access |
| `/etc/infinite/config.json` | infinite-host | 0600, hashes and configured paths |
| `/srv/infinite-data/control` | infinite-host | 0700, encrypted records |
| `/srv/infinite-data/agent-home` | infinite-agent | 0700, provider auth and native history on encrypted storage |
| `/srv/infinite-data/workspaces` | infinite-host:infinite-workspace | 2750, host controls workspace creation and removal |
| `/srv/infinite-data/workspaces/hybrid` | infinite-host:infinite-workspace | 2750 with default ACL, host controls session directories |
| `/run/infinite` | infinite-host | 0700, worker sockets |
| `/run/infinite-key` | infinite-host | 0700, runtime key directory |
| `/run/infinite-key/vault.key` | infinite-host | 0600, 32 raw random bytes restored from owner-held recovery material |

After creating both accounts, provision workspace access as an administrator:

```sh
sudo groupadd --system --force infinite-workspace
sudo usermod --append --groups infinite-workspace infinite-host
sudo usermod --append --groups infinite-workspace infinite-agent
sudo install -d -o infinite-host -g infinite-workspace -m 2750 \
  /srv/infinite-data/workspaces /srv/infinite-data/workspaces/hybrid
sudo setfacl -m d:u::rwx,d:g::rwx,d:m::rwx,d:o::--- \
  /srv/infinite-data/workspaces/hybrid
```

Allow both accounts to traverse the encrypted mount's parent directories, without granting the agent write access to those directories. The agent must not be able to rename or replace the workspace root. Keep control state, provider homes, runtime sockets, and keys private. Do not apply workspace ownership or ACLs recursively to `/srv/infinite-data`. End existing sessions and restart the service after changing group membership; surviving workers retain their old supplementary groups.

Setgid directories preserve the workspace group. The default ACL preserves group access for ordinary new files even though the service and provider wrappers use `umask 077`. Programs that explicitly create mode 0600 files or remove group access can still make recovery fail; the host must report that failure. See [Linux default ACL inheritance](https://man7.org/linux/man-pages/man5/acl.5.html#OBJECT_CREATION_AND_DEFAULT_ACLs).

Session directories and preparation roots remain mode 2700 while files are prepared. At cloud selection, only the selected preparation root becomes 2770 and its session directory becomes 2750. Interior execution directories use 2770 and files grant the workspace group read/write access, plus execute access for executable files. Other prepared generations remain inaccessible to the agent.

Git also requires an ownership exception because materialized repositories belong to the host account. As an administrator, add a protected global setting for the agent account, scoped to the hybrid workspace directory:

```sh
sudo -H -u infinite-agent git config --global --add safe.directory \
  '/srv/infinite-data/workspaces/hybrid/*'
```

Keep the trailing wildcard quoted. This trusts repositories beneath that directory; do not replace it with an unrestricted `*`. Use Git 2.46 or newer: older Ubuntu Git packages can reject repositories despite this scoped setting. The [Git installation guide](https://git-scm.com/install/linux) lists the upstream Ubuntu package source. Verify access with the account-specific checks below. See [Git safe.directory](https://git-scm.com/docs/git-config/2.46.0#Documentation/git-config.txt-safedirectory).

This group is a single-tenant trust boundary. Agent processes sharing the account and group can access other active workspaces in that group. Separate directories prevent accidental concurrent edits; they do not isolate active projects from one another.

Install provider tools as an unprivileged build user into a staging prefix, then copy that prefix to root-owned `/opt/infinite-agents/v1`. Install `agent-wrapper.sh` under `/usr/local/libexec/infinite/` as `claude`, `codex`, `codex-app-server`, `grok`, `opencode`, and optionally `demo`. The prepared Codex backend is built and installed below. The wrappers set encrypted home/cache/temp paths and `SHELL=/bin/bash` for provider tool commands; the service account's login shell can remain disabled. Keep the installed tools and wrappers unwritable by agents. Use a new version directory for upgrades while existing sessions still use the old binaries.

Authenticate each provider as `infinite-agent` on the server. Do not forward a laptop-only credential and expect it to survive the laptop going offline. Keep project credentials narrow and verify the installed CLI version and default permission mode.

On Ubuntu 24.04, check Bubblewrap's namespace support before a Codex tool run. Install `bubblewrap`, `apparmor-profiles`, and `apparmor-utils`. If no loaded profile already attaches to `/usr/bin/bwrap`, install the distribution's `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` as `/etc/apparmor.d/bwrap-userns-restrict` and load it with `apparmor_parser -r`. Avoid duplicate profiles for that executable. Check a harmless sandbox command as the agent account from an accessible workspace, then verify a real Codex file edit through Infinite. Keep `kernel.apparmor_restrict_unprivileged_userns=1` and Codex sandboxing enabled. [OpenAI Linux sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing?sandbox-os=ubuntu-debian).

## Configure Infinite

Build a release from this checkout using `npm ci --workspace @infinite/host --workspace @infinite/web --include-workspace-root` and `npm run build`. Build as an unprivileged build user, then install the resulting tree under `/opt/infinite` with root-owned files. Keep the pinned lockfile. Mobile dependencies are unnecessary on the execution server.

Prepare the Codex backend on the target operating system as the unprivileged build user. The build requires rustup with Rust 1.95.0 installed, plus tar, patch, pkg-config, libssl-dev, libcap-dev, and stock Codex 0.162.0; `codex` must be on the build user's `PATH`. From the checkout, run:

```sh
npm run prepare:codex
```

Preparation builds the pinned alternate app-server and fetches its matching `codex-code-mode-host` companion from the official npm distribution, then qualifies the complete bundle before publishing it under `.local/codex-handoff/bin/`. Qualification uses real Codex executors with a fixture model to check direct and code-mode tools, environment changes within and between turns, and refusal before command dispatch. It does not use model credentials or replace stock Codex. Keep stock Codex installed for the native interface and execution server.

After preparation succeeds, install the backend and its wrapper as an administrator:

```sh
sudo install -d -o root -g root -m 0755 \
  /opt/infinite-agents/v1/bin /usr/local/libexec/infinite
sudo install -o root -g root -m 0755 \
  .local/codex-handoff/bin/codex-code-mode-host \
  /opt/infinite-agents/v1/bin/codex-code-mode-host
sudo install -o root -g root -m 0755 \
  .local/codex-handoff/bin/codex-app-server \
  /opt/infinite-agents/v1/bin/codex-app-server
sudo install -o root -g root -m 0755 deploy/ubuntu/agent-wrapper.sh \
  /usr/local/libexec/infinite/codex-app-server
```

Run initialization as the control user, using the actual tailnet name and an already-created project directory:

```sh
node /opt/infinite/packages/host/dist/cli.js init \
  --config /etc/infinite/config.json \
  --state-dir /srv/infinite-data/control \
  --run-dir /run/infinite \
  --key-file /run/infinite-key/vault.key \
  --origin https://infinite.YOUR-TAILNET.ts.net \
  --project /srv/infinite-data/workspaces/project-a
```

Back up the vault key through a separate owner-controlled channel immediately. Initialization does not overwrite an existing key or configuration. Store the generated owner key on the laptop, controller key in the phone, and viewer key only where read access is intended; remove the delivery copy of plaintext device keys from the server after pairing. The host needs only their hashes. Restoring a key after server reboot is an explicit recovery step in this template.

Copy the `agents` block from `config.example.json` into the generated config, keeping real generated hashes and real project paths. The `sudo -H -u infinite-agent` boundary is essential: generated default profiles run as the control user and are suitable only for local rehearsal. Add a separate project directory for each concurrent writer. Do not blindly point ten sessions at one checkout.

Default local Codex profiles select the prepared backend automatically. This wrapped deployment selects it explicitly through `appServerCommand` and `appServerArgs`, preserving the transition to `infinite-agent`. The sudoers allowlist names the `codex-app-server` wrapper separately. Keep the backend and stock Codex launch settings together when updating the profile.

The Codex profile sets `workspaceDir` to the prepared hybrid directory and enables `sharedWorkspace`. Preparation remains host-private until cloud selection grants access to the selected execution tree. Checkpoint blobs and placement receipts stay in the private control directory. Keep `workspaceDir` outside control state and on encrypted storage.

Validate and install `infinite.sudoers` using `visudo -cf`; then install `infinite.service`, reload systemd, and start it. Check that the API binds only to 127.0.0.1. `ProtectSystem` and the listed writable paths may require adjustment for legitimate project toolchains, but no adjustment should expose the control directory or runtime key to agent code.

Expose it privately:

```sh
tailscale serve --bg http://127.0.0.1:4780
tailscale serve status
```

Use **Serve**, not Funnel. Verify the HTTPS hostname matches `origin`. The systemd unit requires a storage mount and runtime key and deliberately does not auto-create a new key after reboot. API restart keeps workers; host reboot does not. The unit uses RAM-backed `/tmp` and `/var/tmp`, disables core dumps, and applies initial CPU, memory, and task ceilings. The sudoers policy disables command-argument logging for `infinite-host` because those arguments can contain prompts. Validate these controls on the target OS. [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Acceptance before private work

Run each authenticated provider on a disposable worktree. From cmux, use `ssh -t HOST 'sudo -H -u infinite-host /usr/local/bin/infinite attach SESSION_ID --config /etc/infinite/config.json'`. Native access uses the administrator's SSH identity and an explicit transition to `infinite-host`; a phone needs only its API key and tailnet connection.

Check real prompts, tool approvals, output, and visible context on laptop and phone. Disconnect the laptop's network while an approved operation runs. Confirm progress from the phone, reconnect the laptop, and verify the session ID and native PID are unchanged. Repeat through an API restart. Confirm rejection from an unpaired device and a network outside the tailnet.

Use arrow-key controls and Enter to select native permission-menu options. The prompt composer sends pasted text; a pasted option number may be ignored by the provider while Enter accepts its current default. Inspect the selected scope before confirming, and verify the provider's permission mode afterward.

From an agent-run shell, verify that the control directory, vault key, device key delivery file, and worker sockets are unreadable. Confirm native history, workspace, and temporary project data actually reside on the encrypted filesystem. Test an off-host backup restore with separately held keys. These steps are outstanding until performed on the selected server.

For hybrid Codex, verify both account memberships and the default ACL with `id infinite-host`, `id infinite-agent`, and `getfacl /srv/infinite-data/workspaces/hybrid`. In a disposable handoff workspace, confirm the agent can edit a host-materialized file and create a new file under `umask 077`; confirm the host can read both through their absolute paths. Then perform a completed tool operation, wait for a verified checkpoint, disconnect the laptop, and verify a cloud edit and the recovered copy after reconnect. Keep this result separate from a cloud-only session continuity check. Do not claim hybrid acceptance from configuration validation alone.

After handoff, set `HYBRID_REPOSITORY` to the absolute repository path in the selected cloud execution tree, then run:

```sh
sudo -H -u infinite-agent test ! -w /srv/infinite-data/workspaces
sudo -H -u infinite-agent test ! -w /srv/infinite-data/workspaces/hybrid
sudo -H -u infinite-agent git config --global --get-all safe.directory
sudo -H -u infinite-agent git -C "$HYBRID_REPOSITORY" status --short
sudo -H -u infinite-agent git -C "$HYBRID_REPOSITORY" diff --stat
```

Confirm the agent cannot traverse a session's preparation tree before handoff and cannot rename its session directory afterward. The Git commands must succeed through the agent identity without disabling ownership checks globally.

Do not enable automatic destructive tool approval to make the acceptance test pass. Configure only the permissions the owner's workload actually needs. Server hardening, per-project isolation, spend limits, alerts, and provider quota handling remain deployment responsibilities.

## Laptop client and backups

Use the [laptop CLI](../../docs/cli.md) to launch native providers, list sessions, reattach, and monitor through private HTTPS. The server keeps the existing owner/controller/viewer roles; raw native input requires an owner bearer credential.

The [backup procedure](backups.md) uses an owner-held age identity, a bounded process freeze, a staging copy on encrypted storage, and authenticated restore verification. The daily timer creates local encrypted snapshots; independent cloud upload requires a separately configured storage destination.
