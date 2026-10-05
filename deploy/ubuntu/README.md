# Ubuntu commissioning

This template runs an owner-controlled, single-tenant host. The Scaleway installation and verified limits are recorded in [infinitebox commissioning](infinitebox.md). For multi-tenant development, use the [synthetic-only Proxmox profile](../proxmox/README.md). Operator-confidential multi-tenancy requires the separate [managed tenant architecture](../../docs/multi-tenant.md).

These files describe the deployment template; the commissioning record distinguishes checks performed on the actual server from outstanding work. No paid infrastructure is created by these scripts.

## Prepare the host

1. Select and approve the actual server, region, final price, backup destination, and recovery policy. For this workload, consult the [server comparison](../../docs/hosting.md) when choosing new hardware.
2. Install Ubuntu 24.04 LTS. Establish and verify encrypted storage mounted at `/srv/infinite-data`. On bare metal, arrange LUKS unlock and keep recovery material off-host. Verify encryption independently; a mount point alone does not prove it. Use encrypted swap or disable swap. Do not format a disk containing existing data as part of application installation.
3. Install Node.js 22.14+ from a verified upstream package, npm, build-essential, Python 3, Git, sudo, Bubblewrap, and Tailscale. Confirm the actual Node path and update `ExecStart` if it differs from `/usr/local/bin/node`.
4. Enroll Tailscale through the owner's account, approve only the owner's devices, and configure narrow SSH/HTTPS access. Keep provider-console recovery available before closing public SSH. Deny public inbound API access. Port 4780 stays bound to loopback.

## Separate identities and directories

Create a control user `infinite-host` with home `/srv/infinite-data/control-home` and an agent user `infinite-agent` with home `/srv/infinite-data/agent-home`. These are distinct Unix accounts. Preserve the existing administrator login; never run the API as an account with administrator or LXD privileges. A workspace group can grant the control user traverse/read access and the agent user write access to approved worktrees. Do not add the agent user to Docker's group or allow sudo.

| Path | Owner | Mode / purpose |
| --- | --- | --- |
| `/opt/infinite` | root | Application code and dependencies; no agent write access |
| `/etc/infinite/config.json` | infinite-host | 0600, hashes and configured paths |
| `/srv/infinite-data/control` | infinite-host | 0700, encrypted records |
| `/srv/infinite-data/agent-home` | infinite-agent | 0700, provider auth and native history on encrypted storage |
| `/srv/infinite-data/workspaces` | workspace group | Separate worktree per parallel writer |
| `/run/infinite` | infinite-host | 0700, worker sockets |
| `/run/infinite-key` | infinite-host | 0700, runtime key directory |
| `/run/infinite-key/vault.key` | infinite-host | 0600, 32 raw random bytes restored from owner-held recovery material |

Install provider tools as an unprivileged build user into a staging prefix, then copy that prefix to root-owned `/opt/infinite-agents/v1`. Install `agent-wrapper.sh` under `/usr/local/libexec/infinite/` as `claude`, `codex`, `grok`, `opencode`, and optionally `demo`. The wrappers set encrypted home/cache/temp paths and `SHELL=/bin/bash` for provider tool commands; the service account's login shell can remain disabled. Keep the installed tools and wrappers unwritable by agents. Use a new version directory for upgrades while existing sessions still use the old binaries.

Authenticate each provider as `infinite-agent` on the server. Do not forward a laptop-only credential and expect it to survive the laptop going offline. Keep project credentials narrow and verify the installed CLI version and default permission mode.

On Ubuntu 24.04, check Bubblewrap's namespace support before a Codex tool run. Install `bubblewrap`, `apparmor-profiles`, and `apparmor-utils`. If no loaded profile already attaches to `/usr/bin/bwrap`, install the distribution's `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` as `/etc/apparmor.d/bwrap-userns-restrict` and load it with `apparmor_parser -r`. Avoid duplicate profiles for that executable. Check a harmless sandbox command as the agent account from an accessible workspace, then verify a real Codex file edit through Infinite. Keep `kernel.apparmor_restrict_unprivileged_userns=1` and Codex sandboxing enabled. [OpenAI Linux sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing?sandbox-os=ubuntu-debian).

## Configure Infinite

Build a release from this checkout using `npm ci --workspace @infinite/host --workspace @infinite/web --include-workspace-root` and `npm run build`. Build as an unprivileged build user, then install the resulting tree under `/opt/infinite` with root-owned files. Keep the pinned lockfile. Mobile dependencies are unnecessary on the execution server.

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

Do not enable automatic destructive tool approval to make the acceptance test pass. Configure only the permissions the owner's workload actually needs. Server hardening, per-project isolation, spend limits, alerts, and provider quota handling remain deployment responsibilities.

## Laptop client and backups

Use the [laptop CLI](../../docs/cli.md) to launch native providers, list sessions, reattach, and monitor through private HTTPS. The server keeps the existing owner/controller/viewer roles; raw native input requires an owner bearer credential.

The [backup procedure](backups.md) uses an owner-held age identity, a bounded process freeze, a staging copy on encrypted storage, and authenticated restore verification. The daily timer creates local encrypted snapshots; independent cloud upload requires a separately configured storage destination.
