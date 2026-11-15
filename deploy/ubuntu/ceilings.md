# Provider ceilings

A provider ceiling is a root-owned policy file that a provider CLI reads at startup. The agent account cannot change it. The host does not install it. The owner installs it as root on each server.

This template ships two ceilings:

| Provider | System file | Template |
| --- | --- | --- |
| Claude Code | `/etc/claude-code/managed-settings.json` | `deploy/ubuntu/ceilings/managed-settings.json` |
| Codex | `/etc/codex/requirements.toml` | `deploy/ubuntu/ceilings/requirements.toml` |

Nothing here is installed on any machine by the repository. The steps below are for the owner.

## What the ceilings do

- Claude Code: bypass-permissions mode and auto mode are turned off. Read rules deny the provider's read access to the GitHub App credential paths and the vault key.
- Codex: only the `read-only` and `workspace-write` sandbox modes are allowed.

The ceilings bound what a provider may do on its own. The host still decides approvals. The ceiling does not approve anything.

## Claude Code keys

Source: the Claude Code managed-settings and permissions documentation.

| Key | What it stops | What it does not stop |
| --- | --- | --- |
| `permissions.disableBypassPermissionsMode: "disable"` | Entering `bypassPermissions` mode, including `--dangerously-skip-permissions`. The provider does not refuse to start: it runs the session in `default` mode instead. | Any other mode that the host passes with `--permission-mode`. |
| `permissions.disableAutoMode: "disable"` | Auto mode, where the provider approves its own tool calls. | The host's own permission flow, which stays in charge. |
| `permissions.deny` `Read(//etc/infinite-github/**)` | Provider file reads under the GitHub App issuer directory, which holds the App configuration. | A shell command that reads the same file. Bash is not covered by a `Read` rule. |
| `permissions.deny` `Read(//srv/infinite-data/github-app/**)` | Provider file reads of the GitHub App private key directory. | A shell command that reads the same file. |
| `permissions.deny` `Read(//srv/infinite-data/github-app-tokens/**)` | Provider file reads of the short-lived token cache. | A shell command that reads the same file. |
| `permissions.deny` `Read(//run/infinite-key/**)` | Provider file reads of the vault key directory. | A shell command that reads the same file. |

A `Read` deny rule is a policy rule for the provider's file tool. It does not stop a shell command from reading a file that the agent account can read. The real controls are file modes and the credential helper. The issuer configuration is root-only (`0600`). The token cache is readable by the agent group on purpose, so a shell command can read a cached token. Only short-lived tokens belong in that directory. Keep the modes in `github-app.md` correct, and check them with `ls -l` after install.

Two of these keys were checked against Claude Code 2.1.325 on 2026-11-14, passed through `--settings` on a development machine, not through the managed file:

- A `Read(//ABSOLUTE/DIR/**)` deny rule refused the file tool with "File is in a directory that is denied by your permission settings".
- With `permissions.disableBypassPermissionsMode` set to `"disable"`, a session started with `--dangerously-skip-permissions` reported the permission mode `default`. Without the key it reported `bypassPermissions`.

Run `claude doctor` after install all the same. It reports settings-file validation errors and dropped entries. Adjust the rule text if it reports one.

### Keys deliberately not set

Each of these changes how the host's own launch flags work. Each needs a test on the real host before it is added.

- `allowManagedHooksOnly`. Hooks passed with `--settings` are probably blocked by this key. The host's Claude hooks use `--settings`. Test first: move the hooks into the managed file, or use the Agent SDK hook path, and confirm with a marker-file hook.
- `allowManagedPermissionRulesOnly`. This makes allow rules from `--allowedTools` inert. The host's headless roles depend on those rules. Test first: move the required allow rules into the managed file.
- `allowManagedMcpServersOnly` with `allowedMcpServers`. This filters the servers passed with `--mcp-config`. Test first: list every host server and confirm each one matches an entry.
- `managed-mcp.json`. With it present, Claude Code refuses to start when `--mcp-config` is passed. The host passes `--mcp-config`. Do not deploy this file while that is true.
- `disableSideloadFlags`. This rejects `--mcp-config` at startup. Do not set it.
- `disableAllHooks`. This turns off the host's hooks. Do not set it.
- `permissions.denyInsteadOfPrompting`. This denies calls that would prompt. The host's permission flow depends on prompts. Do not set it in the default ceiling.
- `sandbox` locks such as `failIfUnavailable`. These refuse to start when bubblewrap or socat is missing. Test first on the host with the sandbox dependencies installed.

## Codex keys

Source: the Codex managed-configuration and config documentation.

| Key | What it stops | What it does not stop |
| --- | --- | --- |
| `allowed_sandbox_modes = ["read-only", "workspace-write"]` | A session that runs with `danger-full-access`. The client falls back to a compatible value and notifies the user. | Approval policy. The host still passes its own approval settings. |

This key is the legacy form. It limits `sandbox_mode`. The docs prefer permission profiles for Codex 0.138.0 or later. The host does not set `sandbox_mode` itself in its launch code. The key clamps whatever mode the CLI resolves, including a `-c` override. The docs do not say which Codex versions read `/etc/codex/requirements.toml` together with this key. Check the installed version on the host and run one session that tries `-c sandbox_mode="danger-full-access"`. The session should fall back. If it does not, the key is not in effect.

### Keys deliberately not set

- `features.hooks = false`. This turns off all hooks. The host passes Codex hooks with `-c hooks.*`. Do not set it.
- `allow_managed_hooks_only` under `[hooks]`. This disables user, project, and session hooks. Test first, because the host's hooks come from its own `-c` overrides.
- `allowed_approval_policies` and `allowed_approvals_reviewers`. Restricting these can break the host's approval flow. Test first.
- `mcp_servers` allowlist. An empty table disables every MCP server. The host passes `-c mcp_servers.*` overrides. Test first with each host server pinned by identity.
- `[network_proxy]`. The managed proxy does not cover model traffic, MCP connections, or web search. It adds nothing for the team members' network-off sandbox. Egress control must be done at the host or container firewall.
- `allowed_web_search_modes`. Not set. The host's own settings decide this.

## Install and check

Run these as root on the server. Use the path to the checkout that the server runs from.

```sh
sudo deploy/ubuntu/install-ceilings.sh
sudo deploy/ubuntu/install-ceilings.sh --check
infinite doctor --config /etc/infinite/config.json
```

What the install script does:

- Refuses to run unless it is root.
- Validates both templates before touching any file. A bad template installs nothing.
- Stops when a directory above `/etc/claude-code` or `/etc/codex` is a symbolic link, is not root-owned, or is group- or world-writable. Whoever can write such a directory can replace everything below it.
- Stops when `/etc/claude-code` or `/etc/codex` is a symbolic link or not a directory.
- Creates each directory as `root:root` mode `0755` if it does not exist. If it exists with another owner or mode, the script sets `root:root` `0755` and lists the directory, because another account could write it before. Remove any entry that does not belong.
- Installs each file as `root:root` mode `0644`.
- Writes through a temporary file and renames it into place. The rename replaces the entry itself, so a symbolic link at the file's path is replaced and never followed.
- If a regular file exists and differs, keeps a copy under a new name with a UTC timestamp and a random suffix, for example `/etc/codex/requirements.toml.before-ceilings-20260101T000000Z.Ab3dEf`. The copy is readable by root only, because the file it copies may have been restricted. If the entry was a symbolic link or a special file, no copy is kept.
- Prints the SHA-256 of each installed file.
- Changes no file when the installed file already matches the template and has the right owner and mode.

`--check` changes nothing and runs as root. It checks the directories before it reads the file. A directory above `/etc/claude-code` or `/etc/codex` that is not root-owned or is writable by others stops the check. So does the ceiling's own directory: if it is a symbolic link, not a directory, owned by another account, or group- or world-writable, the check reports `differs` and does not hash the file. Otherwise it reports `differs` when the file is missing, is not a regular file, has a different hash, or has the wrong owner or mode. It exits non-zero on any difference.

`infinite doctor` adds one line per check for each configured provider with a ceiling. The lines are:

- `present`: the system file exists.
- `writable`: the file is a regular root-owned file that is not group- or world-writable, and every directory above it up to the root is a real root-owned directory that is not group- or world-writable. A symbolic link at the file's path or above it is reported, even when its target matches the template.
- `hash`: the installed file matches the template shipped in the running release. Doctor does not read the file while any `writable` check fails. Whoever controls an unsafe path could swap in other bytes after a read, so the line says `not read` and gives no hash. The file is also opened without following links and without waiting on a named pipe. Only a regular file is read; any other entry is reported and not opened.
- `profile`: the configured launch arguments and app-server arguments contain no flag that the ceiling forbids.

A `missing`, `changed`, `writable`, or `conflict` word prints as a warning. Doctor does not stop on a warning.

Forbidden flags:

- Claude Code: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, and `--permission-mode` with `bypassPermissions` or `auto`, each as a separate argument or joined with `=`. `--enable-auto-mode` is not in the installed help, so it is not checked.
- Codex: `--dangerously-bypass-approvals-and-sandbox`, and any `--sandbox` or `-s` value, and any `sandbox_mode` in a `-c` or `--config` override, that is not exactly `read-only` or `workspace-write`.

The Codex rule is an allow-list, so it reports a value it does not read as exactly one of the two allowed modes. Doctor reads a TOML string value only in its basic, literal, and multi-line forms, and it does not parse comments. A valid but unusual spelling of an allowed mode, such as a value with a trailing comment, is therefore reported. That costs one warning line.

A flag may take its value as the next argument, after `=`, or attached (`-sVALUE`, `-cKEY=VALUE`). The forms were checked against `codex-cli 0.167.2` and `claude` 2.1.325 help output and parse errors. Codex validates the `--sandbox` value at parse time. It does not validate the `-c` key, and whether it accepts a quoted key was not checked. The check reads the configured arguments only. It does not read a Codex profile or a configuration file that an argument names. It is a warning for the owner. The ceiling file is what clamps the mode.

## How the hash check works

Doctor computes the SHA-256 of the template file in the running release. It computes the SHA-256 of the installed system file. It reports `hash: ok` when they match. It reports `changed` when they differ.

After you update the release, the template may change. Doctor then reports `changed` until you run the install script again. This is expected.

## Roll back

Keep the timestamped copy the install script printed. To restore it:

```sh
sudo cp -p /etc/codex/requirements.toml.before-ceilings-STAMP /etc/codex/requirements.toml
```

To remove a ceiling completely:

```sh
sudo rm /etc/claude-code/managed-settings.json
```

Removing a ceiling removes the protection. Doctor then reports `missing`. Do this only while you investigate a problem. Restore the ceiling afterward.

## Limits

- The ceilings are machine-wide. Every account on this server that runs the provider CLI reads them. They do not apply to other machines.
- The four `Read` deny rules name the first instance's paths. A second instance's agents read the same file, so the two mode keys apply to them, but its own issuer directory, key directory, token cache, and vault key directory are not named. File modes still protect those. Doctor compares the installed file with the shipped template, so adding an instance's paths by hand makes the hash check report `changed`.
- The install script has not been run. It needs root on Linux, and no test in this repository covers it.
- A `Read` deny rule does not block shell commands. See the note in the Claude Code table.
- Doctor reads the installed files as the account that runs it. A file the account cannot read is reported as `changed`.
- The Claude Code `disableAutoMode` key has two spellings in the vendor documentation. This template uses the one from the permissions page. Confirm it with `claude doctor` after install.
- Nothing here has run against a real server or through the managed file path. Installing the files is the first step. The tests listed above still need to run on the host.
- A session that the ceiling moves from bypass mode to `default` mode starts to raise permission requests. Check the `profile` line of `infinite doctor` before installing, and remove a forbidden flag from the launch profile first.
