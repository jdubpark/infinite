# Confidentiality boundary

Managed multi-tenant operation requires confidentiality from the service operator. The current implementation does not provide it. The [managed tenant contract](multi-tenant.md) defines the required confidential execution, attestation, client, keys, and recovery design. The development host lacks confidential VM support; it currently runs the owner's single-tenant pilot and cannot host operator-confidential tenants. The [commissioning record](../deploy/ubuntu/commissioning.md) identifies the deployed controls and remaining checks.

An unattended agent's execution environment must read the files, credentials, and model context it uses. On an ordinary VM, the host administrator can potentially access that environment. Disk encryption, a VPN, containers, and application encryption do not solve that boundary. A properly attested confidential runtime can move trust away from the host operator, but still trusts the measured guest software, hardware/attestation chain, and user device. It does not protect plaintext from a compromised agent or guest software already authorized to read it.

## Implemented protection

Application records are encrypted with AES-256-GCM. Each record has a fresh 96-bit random nonce and authenticated data containing the format version, session ID, and sequence number. This detects content modification and substitution between records or sessions. It does not detect deletion/rollback of a whole valid suffix without an independently anchored checkpoint.

The 256-bit key is a separate 0600 file outside the data directory, loaded into the API and worker memory. Encrypting a backup of the state directory is useful only if the attacker does not also obtain this key. Back up the key separately through an owner-controlled channel; losing it loses the recording. The local development layout is not a protected production key management system.

Metadata and context use atomic encrypted writes. Workers fsync recording entries, serialize input, and refuse to silently continue after a detected recording error. A short output buffer of at most roughly 40 ms is not yet durable if the worker or machine dies; this is distinct from client disconnection.

The HTTP listener is loopback-only. Host and Origin checks, HttpOnly/SameSite cookies, role checks, bounded request bodies, login throttling, and a restrictive CSP cover the private control interface. Native release clients require HTTPS and keep their key in platform secure storage. Browser data is not cached to localStorage or a service worker. Decrypted log export is an explicit download to the owner's device.

The experimental native Codex gateway grants owner-level provider access and requires a bearer key plus the worker's device-bound control lease. Browser cookies and controller/viewer roles cannot connect. Both provider listeners and the laptop relay bind only to loopback and require per-run capabilities; the local TUI receives a relay capability, not the owner's device key. The worker fences each native request after takeover and never supplies an approval response itself. Conversation pinning prevents accidental session switching; it is not a sandbox against an owner or an agent that can execute commands. The observer capability and provider state stay inside the same trusted tenant runtime.

OpenCode's native HTTP gateway has the same owner/control boundary. Every request receives a single-use worker capability; streamed reads close after control is lost. The worker fixes the cloud directory and rejects session creation, forks, deletion, lifecycle/configuration changes, and unrelated permission/question replies. Request bodies are limited to 8 MiB and buffered responses to 32 MiB. Native provider access is still a trusted owner capability, not isolation between projects or tenants. The local interface can read provider configuration returned by OpenCode; do not treat this endpoint as a restricted viewer API.

## Required on a real host

Use Tailscale with device approval, restrictive ACLs, and SSH policy. Expose the API through **Serve**, never Funnel. Serve is private to the tailnet; it is a transport layer, not file encryption or runtime isolation. Check with a device outside the tailnet that the host is inaccessible. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Put source repositories, native agent home directories, native history, caches, temporary files containing project data, and swap on encrypted storage. For Hetzner bare metal, use LUKS2 with a recovery/unlock plan. For AWS, encrypted EBS is a baseline against storage exposure, not against an authorized running guest or an attacker holding the cloud account. Files must be mounted while work runs.

Separate the API service Unix identity from native agent execution identities. The local default profiles intentionally run as the current user; **they are not a sandbox**. The Ubuntu template uses a distinct `infinite-agent` account and constrained sudo launch profiles so an ordinary agent command cannot directly read the API key, device credentials, or worker sockets. Agents sharing that account still share its trust boundary. Use separate users/containers per project if those projects need isolation, and do not mount Docker's host socket.

Authenticate providers on the server in their own protected home, with only the credentials needed for approved projects. An SSH-agent forwarded from the laptop stops being useful when the laptop disappears. Copying the entire laptop home would import excessive credentials and platform-specific paths. Inventory skills, AGENTS.md, MCP services, environment variables, tool versions, Git identity, and project dependencies explicitly.

The owner pilot now has an age-encrypted laptop backup with file, SQLite, and journal restore verification. Its daily server timer creates encrypted snapshots; automatic upload to independent storage is still pending. See [backup operations](../deploy/ubuntu/backups.md).

Use encrypted off-host backups with restore testing. Keep the backup decryption key outside the rented host where feasible, and separate its repository credentials from keys that can delete prior backups. RAID is availability against a drive failure, not a backup. Monitor disk capacity and inode counts; the recording currently has no automatic retention cap.

## Threats that remain

- Compromised guest root or the active agent can read the plaintext accessible to that agent. A compromised API process can read all records it has a key for.
- A stolen paired device key permits that role until it is removed from host configuration and the API is restarted. Browser login cookies expire after 12 hours or API restart in this prototype.
- Agents can leak data through allowed tools, the internet, model API requests, or prompt injection. Provider retention policies are a separate boundary.
- Native terminal recordings are not a complete audit of every filesystem operation or hidden model context. An agent can write a file without printing it.
- Hook tokens are readable by the agent process. Each worker passes `INFINITE_HOOK_URL` and `INFINITE_HOOK_TOKEN` in the agent's environment, so the agent can post forged signals. Signals are evidence about the agent, never authority over it. They are labeled by source, never approve anything, and the screen checks run independently. The answer endpoint only presses keys for a dialog the terminal shows and checks it before and after.
- Codex hooks are off by default. When `attention.hooks.codex` is enabled, they are injected with `--dangerously-bypass-hook-trust`. Unverified until spike S2: the flag applies only to the hooks Infinite injects for that one process, and hooks the person configured keep their own trust requirements. `doctor` prints a line naming the flag when Codex hooks are enabled.
- Push is the first outbound dependency of the host. Bodies are minimal by default and carry no session content; `push.detail: "full"` is opt-in. Messages go through Expo's push service and can be cached there. The Expo access token lives in a 0600 file outside the state directory. Push can be left disabled.
- Signal payloads can contain commands and file contents. They are journaled encrypted like the rest of the recording and shown only to paired roles.
- Confidential VMs can narrow provider/hypervisor threats, but they do not protect against compromised software inside the trusted guest. Attestation and external key release would be a separate security project, not a box to check on this service. [Confidential VM model](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/about-cvm).

Before putting private production repositories here, verify the isolation and storage controls on the selected host and repeat a real provider session through an actual laptop-network outage. Local synthetic continuity tests establish neither cloud hardening nor provider acceptance.

## Dependency audit

The current lockfile's production host dependency audit reports zero known advisories. The full workspace audit reports 29 findings (19 high, 10 moderate), propagated from four transitive packages in the Expo 57 dependency tree: `braces`, `node-forge`, `uuid`, and `decode-uri-component`. Most are in build tooling; the Router URI decoder also requires review before native release. At the time of the check, the registry's latest `braces` and `node-forge` versions remained affected. A forced audit fix proposed incompatible SDK changes, so it was not applied. These findings remain open; the mobile debug build is not a security-reviewed release.
