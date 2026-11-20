# Eval grader account

This runbook installs the grader account. The grader runs the focused tests of a replay candidate, so that no test runs as the host or the agent account. Each step is a root step, and each one says how to undo it.

Mining needs steps 5 and 6. Validation needs steps 1 to 4 and 6, and it also reads the mirror through the forms of step 5. Until step 6 is set, the grader state is `not-configured`, a validate job waits `grader`, and the summary says so. Replay trials need launcher version 2 (section 2.2) and the eval member account of [eval.md](eval.md). While version 1 is installed, the summary shows `grader ready (version 1: no trials)`. The design is in [eval mining and validation](../../docs/teams.md#eval-mining-and-validation), and the boundary is in [the eval grader account](../../docs/security.md#eval-grader-account).

Use the account name `infinite-grader`. A second instance uses `infinite-NAME-grader`, as [instances](instances.md) names accounts. Every command below uses the default names. If a name differs, change it in every step.

## 1. Account and root

```sh
sudo useradd --system --user-group --no-create-home --home-dir /var/lib/infinite-grader --shell /usr/sbin/nologin infinite-grader
sudo install -d -o root -g root -m 0755 /var/lib/infinite-grader
sudo install -d -o infinite-grader -g infinite-grader -m 0700 /var/lib/infinite-grader/root
```

The account joins no other group. It is not the agent account's group, not the host's group, not the group that reads the GitHub App token cache, and not the `infinite-egress` group that reads the egress key. It has no provider login and no repository credential.

The root is the only directory the grader can write. The home directory above it belongs to root, so the grader cannot write there.

*Recommended, not required:* give the account a disk quota. Without one, a round can fill the disk up to the host's storage check.

Undo: `sudo rm -rf /var/lib/infinite-grader` and `sudo userdel infinite-grader`. This removes every grader file.

## 2. The launcher

The host reaches the grader only through a launcher. The launcher runs one operation as the grader account, under the root.

```sh
sudo install -o root -g root -m 0755 deploy/ubuntu/grader-command.sh /usr/local/libexec/infinite/grader-command
```

Edit the `ROOT=` and `ACCOUNT=` lines of the installed file only when the account or the root differs from step 1. The launcher refuses to run as root. It refuses a root that is not a directory of mode `0700` owned by the caller. It refuses every operation when the caller is not `ACCOUNT`, with exit 64.

The launcher admits nine operations. Any other argument is refused.

| Operation | Arguments | What it does |
|---|---|---|
| `probe` | `-- [CANARY...]` | Prints the account's facts as one line of JSON, with `"version":2`. |
| `receive` | `JOB NAME MAXBYTES` | Stores stdin as the job's input `NAME`. |
| `run` | `JOB DIR SECONDS -- ARGV...` | Runs one command in the job's work directory, with the limits of step 2.1. |
| `read` | `JOB REPORT MAXBYTES` | Prints one report file. |
| `digest` | `JOB` | Prints the SHA-256 of the job's base bundle. |
| `export` | `JOB` | Streams a bundle of the trial branch `refs/heads/trial` from the job's task clone to stdout. It runs under the limits of `run`, with a 600-second limit. |
| `stop` | none | Ends every process of the account, then removes its files in `/tmp`, `/var/tmp`, and `/dev/shm`. |
| `clean` | `JOB` | Leaves only the job's base bundle. |
| `remove` | `JOB` | Removes the job's directory. |

`JOB` is a lowercase UUID. `NAME` is `base.bundle`, `base-delta.patch`, `reference.patch`, or `result.patch`. `DIR` is `.`, `task`, or `round-1` to `round-6`. `REPORT` is `reports/round-1.xml` to `reports/round-6.tap`.

The launcher's exit codes are these. Before a child starts: 0 done, 2 missing, 3 over the byte limit, 64 refused, and 125 a launcher failure. The `run` and `export` operations add two more. Their time limit ends with 124. `export` returns 2 when the job's task clone has no `refs/heads/trial`. Once a child has started, the launcher returns the child's status when it is below 64, and 1 for any other status. A child cannot borrow codes 64 or 125.

Undo: `sudo rm -f /usr/local/libexec/infinite/grader-command`.

### 2.1 Limits of a round

Each `run` and `export` starts the child from an empty environment with the fixed list of step 7.2. It runs under `setsid`, `timeout`, and `prlimit`. The limits are 512 processes, a 4 GiB file size, no core files, and 4,096 open files. The time limit is the `SECONDS` argument, from 1 to 3,600.

The probe checks that these tools exist: `setsid`, `timeout`, `prlimit`, `env`, `sha256sum`, `realpath`, and `find`.

### 2.2 Version 2

Version 2 adds the `export` operation and the input `result.patch`, and its probe prints `"version":2`. A probe without a `version` field is version 1. Trials need version 2. Validation runs on either version.

Install version 2 over version 1:

1. Pause each running validate job with `infinite eval pause JOB`, and wait until `infinite eval job JOB --json` shows `paused` and `pgrep -u infinite-grader -a` prints nothing. Install the launcher only then.
2. Install the file, as step 2 does:

   ```sh
   sudo install -o root -g root -m 0755 deploy/ubuntu/grader-command.sh /usr/local/libexec/infinite/grader-command
   ```

3. Check that `ROOT=` and `ACCOUNT=` match step 1:

   ```sh
   sudo grep -n '^ROOT=\|^ACCOUNT=' /usr/local/libexec/infinite/grader-command
   ```

4. Check the probe. Its last field is `"version":2`:

   ```sh
   sudo -u infinite-host -- sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command probe --
   ```

5. Resume each paused job with `infinite eval resume JOB`.

While version 1 is installed, validation runs as before, and no trial starts. Baseline jobs wait `grader`, and the summary shows `grader ready (version 1: no trials)`. Mining is not affected. The host sends `export` and `result.patch` only to version 2.

Undo: install the file of the release before version 2 with the command of step 2, and check that the probe prints no `version` field. Trials then stop, and so does everything that needs version 2.

## 3. The sudo rule

Check the file before you install it. Then install it, and check the result.

```sh
sudo visudo -cf deploy/ubuntu/grader.sudoers
sudo install -o root -g root -m 0440 deploy/ubuntu/grader.sudoers /etc/sudoers.d/infinite-grader
sudo visudo -c
```

The file holds exactly two lines. The first sets `env_reset` for the launcher. The second lets the host account run the launcher as the grader, with no password. Install it only after step 1 exists. The rule does not change `/etc/sudoers.d/infinite`.

Undo: `sudo rm -f /etc/sudoers.d/infinite-grader`.

## 4. The network rule

`deploy/ubuntu/grader.nft` rejects the grader's output to these ranges, over IPv4 and IPv6: link-local `169.254.0.0/16` and `fe80::/10`, private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `fc00::/7`, carrier-grade NAT `100.64.0.0/10`, and multicast `224.0.0.0/4` and `ff00::/8`. Loopback and public addresses stay open.

A unit loads the rule at boot, and a drop-in for `nftables.service` loads it again whenever that service flushes the ruleset, the way [egress](egress.md) keeps the agent's rule:

```sh
sudo nft -c -f deploy/ubuntu/grader.nft
sudo install -o root -g root -m 0644 deploy/ubuntu/grader.nft /etc/infinite/grader.nft
sudo install -o root -g root -m 0644 deploy/ubuntu/infinite-grader-firewall.service /etc/systemd/system/infinite-grader-firewall.service
sudo install -d -o root -g root -m 0755 /etc/systemd/system/nftables.service.d
sudo install -o root -g root -m 0644 deploy/ubuntu/nftables-keeps-grader.conf /etc/systemd/system/nftables.service.d/infinite-grader.conf
sudo systemctl daemon-reload
sudo systemctl enable --now infinite-grader-firewall.service
```

The first command checks the file and that the `infinite-grader` account exists. Each load replaces only the table `infinite_grader`, in one transaction. After a change to the file, reload the unit, never restart it: a restart removes the table first.

This rule is required where the cloud metadata address answers. Until it is loaded, the probe shows `network-open`, and no task starts. It is recommended on every host: where no metadata address answers, the probe cannot see a missing rule, and `systemctl is-active infinite-grader-firewall.service` is what shows that it loaded.

Check: `systemctl is-active infinite-grader-firewall.service` prints `active`, and `sudo nft list table inet infinite_grader` prints the table.

Undo: `sudo systemctl disable --now infinite-grader-firewall.service`, which deletes the table; remove `/etc/systemd/system/infinite-grader-firewall.service`, `/etc/systemd/system/nftables.service.d/infinite-grader.conf`, and `/etc/infinite/grader.nft`; and run `sudo systemctl daemon-reload`.

## 5. The mirror forms

Validation and mining read the source mirror through the production launcher of `teams.commandPrefix`. Add the Git forms that [the eval section](../../docs/teams.md#git-forms-of-mining-and-validation) lists to that launcher:

- E1 and E2, the change counts and the message of one commit. Limit 35 seconds.
- E3, the base-branch bundle. Limit 660 seconds.
- Forms 1 to 4 of the base scan, if their launcher audit is still pending.

Each form sets `GIT_NO_LAZY_FETCH=1`. Until a form is added, its reads are refused. The mining pass then ends `failing`, and a validation waits `mirror`.

Undo: remove the forms from the launcher's list.

## 6. Configuration

Set the grader in the host configuration. The host reads it from `eval.grader`. A project has no grader field.

```json
"eval": {
  "grader": {
    "prefix": { "command": "/usr/bin/sudo", "args": ["-n", "-u", "infinite-grader", "--", "/usr/local/libexec/infinite/grader-command"] },
    "root": "/var/lib/infinite-grader/root",
    "canaries": ["/PATH/TO/GITHUB_APP_KEY", "/etc/infinite-egress/key"]
  }
}
```

The host also probes its own paths on every probe: the evidence database, the vault key file, the state, run, and team workspace directories, and the mirror of each GitHub project. The grader must not read any of them.

Put in `canaries` every other path that holds a secret. Each entry must be absolute, and the list holds at most 32 entries. Include:

- the GitHub App paths in [GitHub App renewal](github-app.md) and [GitHub credential proxy](github-proxy.md) that hold a key, a token, or a grant;
- the egress key, `/etc/infinite-egress/key`, from [egress](egress.md);
- the relay registration key, from [public relay](public-relay.md);
- the provider login directories of the agent account, such as its Claude Code and Codex homes.

The probe reads each canary as the grader. Any canary it can read gives `exposed`, and no task starts.

Turn mining or validation on in a project's team block, through `PUT /api/projects/PROJECT_ID/team` or the configuration file:

```json
{ "team": { "eval": { "mine": true } } }
```

For validation, also set `focusedTest`, `reportFormat`, and, as needed, `gradingPaths` and `guardChecks`. See [settings](../../docs/teams.md#eval-mining-and-validation).

## 7. Install checks

Run each check after the step it follows. Do not skip one.

### 7.1 The sudo rule

```sh
sudo -l -U infinite-host
```

The output shows exactly one grader rule: `(infinite-grader) NOPASSWD: /usr/local/libexec/infinite/grader-command`.

### 7.2 The child environment

Run one round through the launcher as the host account, with a token exported by the caller. The round must print only the fixed list.

```sh
JOB=$(uuidgen | tr 'A-Z' 'a-z')
sudo -u infinite-host -- sh -c 'export INFINITE_HOOK_TOKEN=check; sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command run '"$JOB"' . 10 -- /usr/bin/env'
sudo -u infinite-host -- sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command remove "$JOB"
```

The output has exactly these ten names: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT`, `GIT_NO_REPLACE_OBJECTS`, and `CI`. `INFINITE_HOOK_TOKEN` must not appear.

### 7.3 The stop operation

`stop` ends every process of the grader account. Run this check only on a host with no validation job running. Do not run `stop` as your own account. The launcher acts only as `ACCOUNT`, so this check ends only grader processes.

Start a round that sleeps, in one shell:

```sh
JOB=$(uuidgen | tr 'A-Z' 'a-z')
sudo -u infinite-host -- sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command run "$JOB" . 300 -- /bin/sleep 300
```

In a second shell, confirm that the sleep runs, then stop the account and confirm that it is gone:

```sh
pgrep -u infinite-grader -l sleep
sudo -u infinite-host -- sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command stop
pgrep -u infinite-grader -l sleep
```

The first `pgrep` prints the sleep. The second prints nothing. The first shell's `run` returns. Then remove the job with `remove`, as in 7.2.

### 7.4 The probe

With `eval.grader` set, the state of the grader appears in the summary:

```sh
infinite eval status PROJECT_ID
```

The line `grader ready` means every check of the probe passed. Any other state names the failed check. `misconfigured` covers the account, the root, a writable ancestor, and missing tools. `exposed` covers a readable canary. `network-open` covers the metadata address. `unavailable` covers a launcher that fails or prints output that does not parse.

## Owner choices

These are the owner's choices. The launcher does not make them.

- Memory and CPU in a round are bounded only by the time limit and by the host-load check before each task.
- `/proc` shows the command lines of agent processes to the grader. To hide them, mount `/proc` with `hidepid=invisible` and a `gid=` exemption for the host account.
- A private `/tmp`, a disk quota, and a memory limit for the grader are hardening choices. The design does not require them.

What the grader can still reach is listed in [the eval grader account](../../docs/security.md#eval-grader-account).
