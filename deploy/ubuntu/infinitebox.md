# infinitebox commissioning

Single-tenant pilot on `SERVER_PUBLIC_IP`, commissioned on 2026-10-05 UTC. This is an owner-controlled Ubuntu host. It does not provide confidentiality from root, the infrastructure operator, or compromised agent software. Multi-tenant private workloads remain disabled.

## Access and release

- Private application: `https://infinitebox.YOUR-TAILNET.ts.net`.
- Tailnet address: `TAILNET_IP`; administrator login: `infinite`.
- SSH ED25519 fingerprint, independently supplied by the owner: recorded privately, not in this repository.
- Application release: `/data/infinite-releases/RELEASE_ID`, selected through `/opt/infinite`.
- Release archive SHA-256: recorded privately with the release receipt.
- Service: `infinite.service`, running as `infinite-host`. Agent processes run as `infinite-agent`; neither account is the administrator login.
- Separately installed native launcher SHA-256: recorded privately with the release receipt. This launcher includes the explicit Bash tool-shell correction made after the application release was built.
- Initial session limit: 12. This is an admission limit, not a guarantee of twelve concurrent build workloads.

UFW denies unsolicited inbound traffic except administrator SSH on port 22 and HTTPS on the Tailscale interface. The API listens only on loopback port 4780. Public connections to 443 and 4780 timed out from the laptop. Tailscale Serve exposes HTTPS inside the tailnet; Funnel is not enabled. Administrator SSH still accepts the supplied password; SSH key onboarding and tighter administrator ingress can follow separately.

Device keys are generated on the laptop. Only their hashes are installed in `/etc/infinite/config.json`. Pair the laptop with `owner`, the phone with `controller`, and read-only devices with `viewer`. The device-key file stays in an ignored local directory; do not paste keys into chat or commit it.

## Storage and runtime

Live inspection found Ubuntu 24.04.2, AMD EPYC 4345P with 16 logical CPUs, approximately 62 GiB usable RAM, and two mirrored NVMe drives. The existing root, boot, and `/data` partitions were preserved. A later `/proc/mdstat` check confirmed that the initial resynchronization finished and all three arrays reported `[UU]` with both members active.

A new 128 GiB LUKS2 container at `/data/infinite-private/storage.luks` is mounted through `/dev/mapper/infinite-data` at `/srv/infinite-data`. Its UUID is recorded privately with the recovery material. The encrypted filesystem contains control records, provider homes, workspaces, caches, and persistent temporary files. The service additionally gives `/tmp` and `/var/tmp` RAM-backed mounts. Plaintext swap is disabled now and in `fstab`; core dumps are disabled for the service. No existing disk was formatted.

The storage unlock key is supplied from the laptop, used from `/run`, and removed after unlocking. The journal key exists in `/run/infinite-key/vault.key` while the server runs; `infinite-agent` cannot read it. Active root can access unlocked storage and runtime memory. Encryption at rest does not change that boundary.

Recovery material (storage key, journal key, device keys, pinned host key, metadata, and the backup age identity and recipient) is also copied to a private directory on the owner's machine, outside the repository.

The directory is mode 0700 and files are mode 0600. Preserve a separate protected backup of this recovery material. These are recovery files. A separate 212,439,341-byte encrypted data backup is stored privately on the owner's machine, outside the repository. Automatic independent cloud upload remains unconfigured; the server timer creates local encrypted snapshots daily.

## Verified behavior

- The current snapshot and device-control release passed all 63 tests on the laptop and the actual Ubuntu host. All laptop workspace typechecks, the mobile lint check, and the host/web production builds passed. Ubuntu passed attention, host, and web typechecks and builds; mobile runtime validation remains excluded. The clean Ubuntu build required compiling the attention package before host typechecking.
- Twelve deployed rehearsal processes continued recording with the same launcher and native PIDs while the test client disconnected for 15 seconds and the systemd API restarted. All native PIDs belonged to `infinite-agent`.
- Retrying a controller input retained one delivery intent. The eleven extra probe processes were stopped after verification; the browser rehearsal remains available.
- Browser checks over private HTTPS passed for owner login, creation, steering, compact/full terminal views, context, disconnect/reconnect, and a controller in a phone-sized browser.
- A subsequent release switch and API restart preserved the existing browser rehearsal's session and process.
- Agent-account probes could not read the API configuration, journal key, or control recordings, or traverse the worker socket directory.
- Installed binaries: Node 22.23.1, Tailscale 1.102.4, Claude Code 2.1.289, Codex 0.160.0, Grok 1.0.46, and OpenCode 1.18.34. Version checks used the actual configured launch wrappers.
- Claude authenticated through its server OAuth flow and created `infinite-claude-proof.txt` with exactly `Infinite cloud Claude works.` as the agent account. Its final permission mode was changed from the provider's new automatic default to manual, and the temporary authorization-code file was removed.
- Codex authenticated through device login and created `infinite-codex-proof.txt` through its normal sandbox. During a second tool call, the API was restarted while the command's 25-second sleep was running. The original Codex launcher and native processes remained alive with unchanged process start times, the file write completed, and a later message recalled the previous result in the same conversation.
- Grok authenticated through device login and created `infinite-grok-proof.txt`. A second edit paused for a native approval and completed with the single-edit option selected. Its final permission mode is normal manual approval.
- OpenCode used `meta/muse-spark-1.3-contributor` to create `infinite-opencode-proof.txt`, then `deepseek/deepseek-flash` to run Bash, append a second line, and read the file back. Native history confirmed both models in one conversation (its ID is recorded privately); the DeepSeek shell command exited successfully and the resulting two-line file was independently checked.
- The authenticated Codex result was visible to an owner in the desktop browser and a controller in a phone-sized browser, without horizontal overflow or JavaScript errors. Screenshots were inspected. These checks used a browser, not a physical native Android app.

The twelve-process capacity rehearsal used the deterministic demo provider. The separate Codex check establishes one authenticated provider's in-flight tool continuity; it is not a twelve-model workload benchmark, physical laptop Wi-Fi shutdown, physical Android check, or host-reboot test. The recording test was corrected to wait for durable output rather than assuming a screen update implies the buffered recording is already flushed. The diagnostic command was corrected to include configured launcher arguments.

The first Codex tool run exposed missing Ubuntu Bubblewrap/AppArmor setup. Installing the distribution packages and loading its dedicated Bubblewrap profile fixed it without restarting the Codex session. The global unprivileged-user-namespace restriction remains enabled. Grok's initial menu ignored a pasted option number and accepted its broader default; that mode was explicitly reverted before the second edit. Use native Tab/arrow keys to select an approval scope, inspect the selection, then press Enter.

OpenCode initially inherited `/usr/sbin/nologin` for tool execution. The launcher now exports `SHELL=/bin/bash`, while the account's login shell remains disabled. Applying that correction required restarting the disposable OpenCode process: its existing native conversation was explicitly resumed under a new Infinite recording (its ID is recorded privately). The earlier recording remains closed. Codex's original native processes stayed alive through these API restarts. The temporary resume arguments were removed from the launch profile after commissioning.

The laptop link showed intermittent Tailscale connection timeouts during testing. A subsequent direct Tailscale ping succeeded at approximately 770 ms and fresh private HTTPS checks returned 200. Treat this as an observed high-latency client connection; no claim of reliable low latency or a physical-phone outage rehearsal is made.

Local receipts and screenshots (cloud continuity, active release, provider commissioning, and browser checks) are kept in an ignored local directory. They contain no device-key values. Remote build output is in `/data/infinite-build/final-build.log`.

## Provider authentication

Authenticate inside the protected agent account. Do not authenticate as the administrator or API user, copy an entire laptop home, or depend on a forwarded laptop SSH agent.

Codex, Grok, and Claude authenticated through separate server logins. At the owner's request, OpenCode uses Meta and DeepSeek: only those two existing credential entries were copied from the laptop's OpenCode store into the encrypted agent home. Its unrelated provider entries were not transferred. The pending OpenCode ChatGPT login was cancelled.

OpenCode enables the `meta` and `deepseek` providers, defaults new sessions to `meta/muse-spark-1.3-contributor`, and disables public session sharing. The installed catalog also offers `deepseek/deepseek-flash` (displayed as DeepSeek V4.1 Flash) and `deepseek/deepseek-v4-pro`. Meta's Contributor tier permits training on prompts and completions; the encrypted execution host does not change those provider terms. Commissioning uses disposable text only. [Meta tier terms](https://dev.meta.ai/docs/pricing-rate-limits#contributor-tier).

```sh
ssh -t infinite@SERVER_PUBLIC_IP
sudo -H -u infinite-agent /usr/local/libexec/infinite/codex login --device-auth
sudo -H -u infinite-agent /usr/local/libexec/infinite/claude auth login
sudo -H -u infinite-agent /usr/local/libexec/infinite/grok login --device-auth
sudo -H -u infinite-agent /usr/local/libexec/infinite/opencode auth login
```

The existing commissioning sessions use a disposable rehearsal directory. A committed snapshot of the Infinite repository (its commit is recorded privately) is now available in four separate Git worktrees: `infinite-claude`, `infinite-codex`, `infinite-grok`, and `infinite-opencode`. Select one with `infinite --project infinite-codex codex`. These are configured projects, not automatic per-session worktrees; two sessions using one entry still share its checkout. Uncommitted laptop edits and unrelated laptop projects were not imported. Model-provider credentials are connected; repository-specific Git/MCP credentials and dependencies require their own explicit setup.

## Laptop CLI and backup receipts

The standalone laptop command is installed at `~/.local/bin/infinite`, with its own versioned runtime in the user's application-support directory. It is paired to private Tailscale HTTPS with a mode-0600 `~/.config/infinite/client.json`. Run `infinite list`, `infinite resume`, or `infinite monitor`. The default project remains `workspace` until the owner selects a default repository; explicit `--project` can select a cloud worktree now. See [CLI behavior](../../docs/cli.md).

All four providers' native `--version` flags completed through the deployed CLI. A real Codex session was monitored without input, switched into interaction with Enter, and returned `INFINITE_NATIVE_CLI_OK`. Detaching and resuming retained the same Infinite session ID and launcher PID (both recorded privately); the verification created no new session. The original nine agent-account processes survived deployment/API restarts. Older workers and unsupported terminal states still replay history on attachment; long recordings and high-latency links can delay reaching the live screen.

Rolling upgrades keep older workers alive. Those workers omit attention metadata; the API neither fails list/launch requests nor invents an activity state for them, and reports their attention as `unavailable`. Native replay is streamed one record at a time. Client monitor controls consume coalesced shortcut input, and explicit detachment terminates only the local client after restoring its terminal.

The terminal transport release reports connection and startup stages immediately and uses one authenticated WebSocket for output, ordered input, and delivery receipts. Keys no longer wait for the preceding key's acknowledgment. All seven pre-existing native processes retained their PIDs and start times across this release's API restart. The installed client completed `infinite grok --version` against the new release and detached from a disposable demo session without stopping its process.

Ctrl+E opens the optional local draft editor; native terminal interaction remains the default. An earlier live synthetic probe measured a 1 ms draft update on this laptop; this is not a latency distribution or a native provider UI benchmark. Ctrl+S inserts the draft without submitting it. Unsent drafts survive connection loss in the current client's memory. The installed client runtime revision is recorded privately.

The snapshot and device-control release switched the API at 11:49 UTC on 2026-10-05. All nine existing agent-account processes retained their PIDs and process start times. New workers can restore a bounded current-screen snapshot followed by exact-cursor deltas, and enforce one renewable input/resize lease. CLI Ctrl+G releases control, Enter requests it, and Ctrl+T explicitly takes over. Existing workers keep their original capabilities and are not replaced to enable these features.

The deployed synthetic rehearsal verified snapshot attachment without duplicate prefix output, two-device takeover, refusal of stale input, and monitor mode without a control claim. The installed laptop CLI restored an unsent draft after releasing and reacquiring control, then detached with the same session PID and runtime ID still running. The draft painted in 1 ms in this single sample and produced no agent input. Only the disposable rehearsal was stopped afterward; this check made no model requests and does not establish native provider UI latency.

Local Chrome verification covered explicit takeover, disabled stale/offline inputs, retained drafts, foreground refresh, and a delayed poll that previously revoked newly acknowledged control. The fixed client retained control after that older response completed. React Native received the same refresh-order repair and passed typecheck/lint; no Android runtime result is claimed. Source, activation, and live verification receipts are kept in the ignored local directory. Ubuntu validation output is `/data/infinite-build/adoption-RELEASE_ID.log`.

Direct Tailscale RTT was 1.183 seconds during this investigation, while loopback API responses took 0.3–10.2 ms. Remote native echo still depends on that network latency. Local native frontend adapters, synchronized laptop workspaces, and portable provider checkpoints remain unimplemented; see [native interaction and continuity](../../docs/native-continuity.md). Transport receipts are kept in the ignored local directory; Ubuntu validation output is `/data/infinite-build/terminal-RELEASE_ID.log`.

The first encrypted archive's name and SHA-256 are recorded privately with its receipt. The snapshot paused the service for 0.192 seconds and preserved its processes. The archive was downloaded and verified on the FileVault-enabled laptop: 1,694 file hashes/sizes, two SQLite integrity checks, 17 decrypted session metadata records, 6,241 authenticated journal events, and all four provider proof files passed. Eighteen external symlinks were inventoried rather than restored automatically. Temporary decrypted restore directories were removed.

`infinite-backup.timer` is enabled for daily 03:30 UTC plus up to 15 minutes. Only the age public recipient is installed on the server; the private identity remains with the owner's recovery files. This timer creates encrypted server-local snapshots. Independent cloud storage upload and retention pruning are not configured. See [backup and restoration](backups.md).

Private receipts for the CLI release, native versions, live CLI check, backup, and restore are kept in the ignored local directory.

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

Remaining commissioning work: select the default project and project-specific Git/MCP dependencies, configure an independent automatic backup destination and retention, rehearse cold-boot/native recovery, and repeat continuity during a physical laptop-network outage. Android validation is explicitly excluded from this continuation. Operator-confidential multi-tenant execution still needs a selected confidential provider, attestation, user-controlled key release, and trusted client transport; it remains disabled on this hardware.
