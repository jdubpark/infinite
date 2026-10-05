# infinitebox commissioning

Single-tenant pilot on `SERVER_PUBLIC_IP`, commissioned on 2026-10-05 UTC. This is an owner-controlled Ubuntu host. It does not provide confidentiality from root, the infrastructure operator, or compromised agent software. Multi-tenant private workloads remain disabled.

## Access and release

- Private application: `https://infinitebox.YOUR-TAILNET.ts.net`.
- Tailnet address: `TAILNET_IP`; administrator login: `infinite`.
- SSH ED25519 fingerprint, independently supplied by the owner: recorded privately, not in this repository.
- Application release: `/data/infinite-releases/RELEASE_ID`, selected through `/opt/infinite`.
- Release archive SHA-256: recorded privately with the release receipt.
- Service: `infinite.service`, running as `infinite-host`. Agent processes run as `infinite-agent`; neither account is the administrator login.
- Initial session limit: 12. This is an admission limit, not a guarantee of twelve concurrent build workloads.

UFW denies unsolicited inbound traffic except administrator SSH on port 22 and HTTPS on the Tailscale interface. The API listens only on loopback port 4780. Public connections to 443 and 4780 timed out from the laptop. Tailscale Serve exposes HTTPS inside the tailnet; Funnel is not enabled. Administrator SSH still accepts the supplied password; SSH key onboarding and tighter administrator ingress can follow separately.

Device keys are generated on the laptop. Only their hashes are installed in `/etc/infinite/config.json`. Pair the laptop with `owner`, the phone with `controller`, and read-only devices with `viewer`. The device-key file stays in an ignored local directory; do not paste keys into chat or commit it.

## Storage and runtime

Live inspection found Ubuntu 24.04.2, AMD EPYC 4345P with 16 logical CPUs, approximately 62 GiB usable RAM, and two mirrored NVMe drives. The existing root, boot, and `/data` partitions were preserved. The initial RAID resynchronization was still running during commissioning; check `/proc/mdstat` before relying on completed redundancy.

A new 128 GiB LUKS2 container at `/data/infinite-private/storage.luks` is mounted through `/dev/mapper/infinite-data` at `/srv/infinite-data`. Its UUID is recorded privately with the recovery material. The encrypted filesystem contains control records, provider homes, workspaces, caches, and persistent temporary files. The service additionally gives `/tmp` and `/var/tmp` RAM-backed mounts. Plaintext swap is disabled now and in `fstab`; core dumps are disabled for the service. No existing disk was formatted.

The storage unlock key is supplied from the laptop, used from `/run`, and removed after unlocking. The journal key exists in `/run/infinite-key/vault.key` while the server runs; `infinite-agent` cannot read it. Active root can access unlocked storage and runtime memory. Encryption at rest does not change that boundary.

Recovery material (storage key, journal key, device keys, pinned host key, and metadata) is also copied to a private directory on the owner's machine, outside the repository.

The directory is mode 0700 and files are mode 0600. Preserve a separate protected backup of this recovery material. These files are keys, not backups of server data. No automatic off-host data backup has been configured.

## Verified behavior

- Host/web typechecks, builds, and all six integration/security tests passed on the actual Ubuntu host.
- Twelve deployed rehearsal processes continued recording with the same launcher and native PIDs while the test client disconnected for 15 seconds and the systemd API restarted. All native PIDs belonged to `infinite-agent`.
- Retrying a controller input retained one delivery intent. The eleven extra probe processes were stopped after verification; the browser rehearsal remains available.
- Browser checks over private HTTPS passed for owner login, creation, steering, compact/full terminal views, context, disconnect/reconnect, and a controller in a phone-sized browser.
- A subsequent release switch and API restart preserved the existing browser rehearsal's session and process.
- Agent-account probes could not read the API configuration, journal key, or control recordings, or traverse the worker socket directory.
- Installed binaries: Node 22.23.1, Tailscale 1.102.4, Claude Code 2.1.289, Codex 0.160.0, Grok 1.0.46, and OpenCode 1.18.34. Version checks used the actual configured launch wrappers.

The continuity tests used the deterministic demo provider. They are not authenticated model-turn evidence, physical Android evidence, or a host-reboot test. The recording test was corrected to wait for durable output rather than assuming a screen update implies the buffered recording is already flushed. The diagnostic command was corrected to include configured launcher arguments.

Local receipts and screenshots are kept in an ignored local directory. They contain no device-key values. Remote build output is in `/data/infinite-build/final-build.log`.

## Provider authentication

Authenticate inside the protected agent account. Do not authenticate as the administrator or API user, copy an entire laptop home, or depend on a forwarded laptop SSH agent.

```sh
ssh -t infinite@SERVER_PUBLIC_IP
sudo -H -u infinite-agent /usr/local/libexec/infinite/codex login --device-auth
sudo -H -u infinite-agent /usr/local/libexec/infinite/claude auth login
sudo -H -u infinite-agent /usr/local/libexec/infinite/grok login --device-auth
sudo -H -u infinite-agent /usr/local/libexec/infinite/opencode auth login
```

The initial workspace is a disposable rehearsal directory. Add explicit project entries with separate working directories for parallel writers after Git/MCP credentials and project dependencies are configured. No personal repositories or laptop model credentials were copied during commissioning.

## Operations and recovery

```sh
sudo systemctl status infinite
sudo journalctl -u infinite --since '10 minutes ago'
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
sudo -H -u infinite-host /usr/local/bin/infinite list --config /etc/infinite/config.json
sudo -H -u infinite-host /usr/local/bin/infinite attach SESSION_ID --config /etc/infinite/config.json
```

API restarts preserve workers. Stop individual sessions through Infinite before maintenance that must terminate them. A server reboot stops processes and leaves the encrypted volume locked; it cannot preserve the same OS processes. The service deliberately skips startup until its mount and runtime journal key are present.

From the owner's machine, a private recovery helper kept outside the repository verifies the existing LUKS UUID, restores keys only into `/run`, unlocks the existing container without formatting it, and starts the service. It uses the strict pinned SSH identity and privately stored credentials. The helper was checked while the volume was already unlocked, without restarting the active API. Cold boot/unlock and native provider resume have not yet been rehearsed. After any actual host restart, explicitly inspect interrupted work and use supported provider recovery rather than silently issuing requests twice.

Remaining commissioning work: authenticate providers, run real tools through laptop disconnection, configure project worktrees/MCP dependencies, select off-host encrypted backups and test restoration, rehearse cold recovery, and finish physical-phone release validation. Confidential multi-tenant execution is a separate unfinished backend.
