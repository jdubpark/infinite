# Eval member account

This runbook installs the eval account, which runs the member of a replay trial. The member is a model session that works on one task of a project, with its own provider logins and no production credential. Each step is a root step unless it says otherwise, and each one says how to undo it and how to check it.

Nothing in this runbook starts a trial. A trial starts only when all of these hold: steps 1 to 10 are done, the grader runs launcher version 2 (step 9), and a project sets `trialsPerDay`. Until then the summary shows `eval identity not-configured` when no `eval.member` is set, and `eval identity unavailable` when the launcher is missing or fails. A baseline job waits `eval-identity` in both cases. A grader that still runs version 1 makes the summary show `grader ready (version 1: no trials)`, and a baseline job waits `grader`. Each check below says what it shows.

The design is in [eval trials](../../docs/teams.md#eval-trials), and the boundary is in [the eval member account](../../docs/security.md#eval-member-account). The grader is set up in [the eval grader account](grader.md), and the egress lists are in [egress](egress.md).

Use the account name `infinite-eval`. A second instance uses `infinite-NAME-eval`, as [instances](instances.md) names accounts. Every command below uses the default names. If a name differs, change it in every step: the account, the paths under `/var/lib/infinite-eval` and `/usr/local/share/infinite-eval`, the launcher's variables, the sudo rule, and the configuration.

## 1. Account and directories

```sh
sudo useradd --system --user-group --no-create-home --home-dir /var/lib/infinite-eval/home --shell /usr/sbin/nologin infinite-eval
sudo install -d -o root -g root -m 0755 /var/lib/infinite-eval
sudo install -d -o infinite-eval -g infinite-eval -m 0700 /var/lib/infinite-eval/home /var/lib/infinite-eval/tmp
sudo install -d -o infinite-eval -g infinite-eval -m 0711 /var/lib/infinite-eval/root /var/lib/infinite-eval/root/trials
```

The account joins no other group. It has no repository credential, no GitHub grant, and no project environment. Its home is `/var/lib/infinite-eval/home`, and `/var/lib/infinite-eval/tmp` is the temporary directory that the provider wrappers use (`EVAL_TMP` in the launcher). The root `/var/lib/infinite-eval/root` is the only tree the launcher works in. Trials live in its `trials` directory.

Next, stop a second route to the account's work: a cron or an `at` job would outlive `stop`. Where cron or `at` is installed, add the account to the deny file:

```sh
grep -qx infinite-eval /etc/cron.deny || echo infinite-eval | sudo tee -a /etc/cron.deny
grep -qx infinite-eval /etc/at.deny || echo infinite-eval | sudo tee -a /etc/at.deny
```

When `/etc/cron.allow` or `/etc/at.allow` exists, the deny file does nothing. Then the account is refused unless it is listed in the allow file, so check that it is not listed there.

Undo: stop the account's processes first (`pgrep -u infinite-eval -a` must print nothing), then `sudo userdel infinite-eval` and `sudo rm -rf /var/lib/infinite-eval`. Remove the `infinite-eval` lines from the deny files.

Check:

```sh
id -nG infinite-eval                                  # prints only infinite-eval
sudo stat -c '%U:%G %a' /var/lib/infinite-eval/root   # infinite-eval:infinite-eval 711
sudo grep -x infinite-eval /etc/cron.deny /etc/at.deny   # one line for each deny file that exists
```

## 2. The launcher

The host reaches the eval account only through a launcher. The launcher runs one operation as the eval account, under its root. The host never runs it as root.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec/infinite
sudo install -o root -g root -m 0755 deploy/ubuntu/eval-command.sh /usr/local/libexec/infinite/eval-command
```

The launcher needs these tools at the absolute paths it names, and refuses every operation but `probe` and `stop` with exit 125 when one is missing: `timeout`, `prlimit`, `env`, `git`, `realpath`, `find`, `cmp`, `head`, `stat`, `cp`, `chmod`, `rm`, `mv`, `sleep`, `id`, `wc`, `ipcs`, and `ipcrm` under `/usr/bin`, and `mkdir` and `bash` under `/bin`. `ipcs` and `ipcrm` come with the `util-linux` package. `probe` reports `"tools":false` when one is missing, and `stop` exits 1 when it cannot list the account's System V objects.

Set the variables at the top of the installed file to the values of this runbook. They are `ROOT=/var/lib/infinite-eval/root`, `ACCOUNT=infinite-eval`, `EVAL_HOME=/var/lib/infinite-eval/home`, `TEMPLATE=/usr/local/share/infinite-eval/home`, and `EVAL_TMP=/var/lib/infinite-eval/tmp`. `EVAL_TMP` must equal the `TMPDIR` of the provider wrappers (step 3). Change nothing else, including the `STOP_DIRS` list of shared directories that `stop` empties and the probe counts.

The launcher refuses to run as root, and it refuses every operation, with exit 64, when the caller is not `ACCOUNT` or when `ROOT` is not a directory of mode `711` owned by the account. It admits these operations: `probe`, `receive`, `prepare`, `check`, `exec`, `setup`, `stop`, `clean`, and `scrub`. Any other argument is refused.

Undo: `sudo rm -f /usr/local/libexec/infinite/eval-command`.

Check, before the sudo rule of step 4 exists, as the account itself:

```sh
sudo -u infinite-eval -- /usr/local/libexec/infinite/eval-command probe --
```

The output is one line of JSON. It holds `"version":1`, `"trials":0`, `"leftovers":0`, and `"fetch":"skipped"`. A probe that prints nothing and exits 64 means that `ROOT` has the wrong mode or owner. `stop` is not run by this check, because `stop` ends every process of the account. Run it only in step 11, when no trial exists.

## 3. The provider wrappers and the drain

The wrapper of each provider is one file, `deploy/ubuntu/eval-wrapper.sh`. It chooses the provider by its file name, so each name needs its own copy. The transcript drain runs after a provider exits.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec/infinite/eval
for name in claude codex codex-app-server opencode; do
  sudo install -o root -g root -m 0755 deploy/ubuntu/eval-wrapper.sh "/usr/local/libexec/infinite/eval/$name"
done
sudo install -o root -g root -m 0755 deploy/ubuntu/transcript-drain.sh /usr/local/libexec/infinite/eval/transcript-drain
```

The wrapper is the agent wrapper without the agent environment, the pnpm store, and the corepack cache. It removes the GitHub grant and the GitHub proxy from its environment, and it sets `TMPDIR` to `/var/lib/infinite-eval/tmp`. It runs the provider from `/opt/infinite-agents/v1/bin`, which the agent install already provides, so that directory must exist first.

Undo: `sudo rm -rf /usr/local/libexec/infinite/eval`. No trial starts while the wrappers are missing, and each one that is refused ends its trial `void-host`.

Check:

```sh
ls -l /usr/local/libexec/infinite/eval/     # five files, each root root with mode -rwxr-xr-x
test -x /opt/infinite-agents/v1/bin/claude && echo provider present
```

## 4. The sudo rule

Check the file before you install it. Then install it, and check the result.

```sh
sudo visudo -cf deploy/ubuntu/eval.sudoers
sudo install -o root -g root -m 0440 deploy/ubuntu/eval.sudoers /etc/sudoers.d/infinite-eval
sudo visudo -c
```

The file holds one `Defaults` line and three rules. The `Defaults` line removes every environment variable of the host from the launcher, so the launcher receives none. The rules let the host account run the launcher, the four provider wrappers, and the transcript drain as the eval account, with no password. The file does not change `/etc/sudoers.d/infinite`. Install it only after steps 1 to 3 exist.

Undo: `sudo rm -f /etc/sudoers.d/infinite-eval`, then `sudo visudo -c`. With the rule gone, no trial can start.

Check: the rule list of step 11 prints exactly these lines for `infinite-host`.

## 5. The network rule

This rule is only for a host where `autonomy.boundary.egress` is configured, as [egress](egress.md#3-point-the-host-at-the-proxy) sets it up. It rejects every output of the eval account except loopback, which is where the egress proxy listens. Without the proxy the account has no route to its provider, so load the rule only after the lists of step 6 exist.

A unit loads the rule at boot, and a drop-in for `nftables.service` loads it again whenever that service flushes the ruleset, the way [egress](egress.md) keeps the agent's rule:

```sh
sudo nft -c -f deploy/ubuntu/eval.nft
sudo install -o root -g root -m 0644 deploy/ubuntu/eval.nft /etc/infinite/eval.nft
sudo install -o root -g root -m 0644 deploy/ubuntu/infinite-eval-firewall.service /etc/systemd/system/infinite-eval-firewall.service
sudo install -d -o root -g root -m 0755 /etc/systemd/system/nftables.service.d
sudo install -o root -g root -m 0644 deploy/ubuntu/nftables-keeps-eval.conf /etc/systemd/system/nftables.service.d/infinite-eval.conf
sudo install -d -o root -g root -m 0755 /etc/systemd/system/infinite.service.d
sudo install -o root -g root -m 0644 deploy/ubuntu/infinite-requires-eval-firewall.conf /etc/systemd/system/infinite.service.d/eval-firewall.conf
sudo systemctl daemon-reload
sudo systemctl enable --now infinite-eval-firewall.service
```

The last drop-in makes `infinite.service` require the firewall unit: the API does not start while the rule is missing or failed to load, and it loads the rule again on every start. Without it, a firewall unit that fails at boot leaves every trial on a direct route, labelled `none`. Install it only on a host where the rule is installed, because it makes the API depend on this unit. A restart of the firewall unit also restarts the API, so stop trials first. It follows the egress firewall's drop-in (`deploy/ubuntu/egress/infinite-requires-egress-firewall.conf`).

The first command checks the file and that the `infinite-eval` account exists. The rule is in the `inet` family, so it rejects IPv4 and IPv6 alike, and each load replaces only the table `infinite_eval`, in one transaction. After a change to the file, reload the unit, never restart it: a restart removes the table first. The probe does not check the provider route, and it reports `network-open` only while the cloud metadata address answers, so `systemctl is-active infinite-eval-firewall.service` is what shows that the rule loaded.

Undo: stop trials first (write each project's team block without `trialsPerDay`). Then `sudo systemctl disable --now infinite-eval-firewall.service`, which deletes the table; remove `/etc/systemd/system/infinite.service.d/eval-firewall.conf` first, so that the API no longer requires the unit; remove `/etc/systemd/system/infinite-eval-firewall.service`, `/etc/systemd/system/nftables.service.d/infinite-eval.conf`, and `/etc/infinite/eval.nft`; and run `sudo systemctl daemon-reload`.

Check:

```sh
systemctl is-active infinite-eval-firewall.service     # active
systemctl show infinite.service -p Requires | grep -c infinite-eval-firewall.service   # 1
sudo nft list table inet infinite_eval                 # prints the table
sudo -u infinite-eval curl -sS --max-time 5 https://example.com   # fails: the rule refuses the direct connection
```

## 6. The egress lists

The eval account reaches the network only through the egress proxy, with the identities `_eval` (its member and its probe) and `_eval-setup` (the project's `setup` command). The proxy never gives them the global `allow` list. Each one gets only its own list, in the `projects` map of `/etc/infinite-egress/policy.json`. Add the two entries and keep every other entry as it is:

```json
"projects": {
  "_eval": { "allow": ["PROVIDER_API_HOST"] },
  "_eval-setup": { "allow": ["PACKAGE_REGISTRY_HOST"] }
}
```

- `_eval` lists the provider API hosts of the eval logins, and nothing else. Take the host names from the provider's documentation for its command-line tool, and keep only those.
- `_eval-setup` lists the package registries that the project's `setup` command needs. Do not list a registry that serves the project's own later releases: the setup credential lasts 15 minutes, and a process that setup leaves running can use it.
- The probe's proxied fetch of the repository uses a 60-second `_eval` credential. In enforce mode the proxy refuses that host for `_eval`, because the repository is not on the list. In observe mode the proxy lets `_eval` reach any public host, so the fetch succeeds and every trial is labelled `none`. Set `"mode": "enforce"` as step 5 of [egress](egress.md#5-enforce) describes. The proxy switch applies to every project, so read the observe results of all projects first.

Reload the proxy, then check the policy:

```sh
sudo systemctl reload infinite-egress-proxy
journalctl -u infinite-egress-proxy -o cat | grep '"event":"policy"' | tail -n 1   # status loaded
```

Undo: remove the two entries, set `"mode": "observe"` if you changed it, and reload the proxy with the same command.

Setup exports the host's whole egress set to the command it runs: the four proxy variables, `NO_PROXY` and `no_proxy` with the loopback addresses, and `NODE_USE_ENV_PROXY=1`. Node 22 ignores the proxy without that last variable, and the network rule refuses the direct connection. The launcher adds these variables, so the project does not set them.

## 7. The eval logins

Log in each provider as the eval account, with the provider's own login command, through the wrapper. Use the owner's sudo, not the host's:

```sh
sudo -H -u infinite-eval -- /usr/local/libexec/infinite/eval/claude    # then /login inside the session
sudo -H -u infinite-eval -- /usr/local/libexec/infinite/eval/codex login
sudo -H -u infinite-eval -- /usr/local/libexec/infinite/eval/opencode auth login
```

Turn off the provider's history and memory where the provider offers that. Use these logins for nothing else (owner decision 2 in the design). The launcher keeps only three login files when it resets the home, and nothing else of the home survives a trial:

- `.claude/.credentials.json`
- `.codex/auth.json`
- `.local/share/opencode/auth.json`

If a provider keeps its login anywhere else, the reset removes that login, and no trial can log in again. Report it rather than editing the launcher's list.

Undo: remove the login files that the login created, from `/var/lib/infinite-eval/home`, with `sudo rm -f`.

Check: each provider's login file exists and is not empty, for example `sudo -u infinite-eval test -s /var/lib/infinite-eval/home/.codex/auth.json && echo login present`.

## 8. The home template

The trial's home is reset from a template before every trial. Copy into the template the provider files that the provider needs besides its logins, after step 7. Copy no login file. Remove the `projects` map from `.claude.json` by hand, because it names the owner's project paths.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/share/infinite-eval
sudo install -d -o root -g infinite-eval -m 0750 /usr/local/share/infinite-eval/home
sudo install -D -o root -g infinite-eval -m 0640 SOURCE_FILE /usr/local/share/infinite-eval/home/RELATIVE_PATH
sudo chown -R root:infinite-eval /usr/local/share/infinite-eval/home
sudo find /usr/local/share/infinite-eval/home -type d -exec chmod 0750 {} +
sudo find /usr/local/share/infinite-eval/home -type f -exec chmod 0640 {} +
```

Use one `install -D` for each file. Examples of such files are `.claude.json` (without its `projects` map), `.claude/settings.json`, and `.codex/config.toml`. The last three commands set the template's directories to `0750` and its files to `0640`, owned `root:infinite-eval`, so the account can read them and nothing else can. `install -D` creates the parent directories with the default mode, so the `find` commands are needed.

The template must hold no login. Check that none of the three login paths of step 7 exists in it, and that the modes are right:

```sh
for p in .claude/.credentials.json .codex/auth.json .local/share/opencode/auth.json; do
  sudo test -e "/usr/local/share/infinite-eval/home/$p" && echo "login in template: $p"
done
sudo find /usr/local/share/infinite-eval/home -printf '%M %u:%g %p\n'   # dirs 0750 and files 0640 under root:infinite-eval
```

The first command prints nothing. The second lists the template with the modes above. A `scrub` without this template exits without changing the home, so no trial starts.

Undo: `sudo rm -rf /usr/local/share/infinite-eval`.

## 9. The grader launcher, version 2

Trials need the grader's `export` operation and its `result.patch` input, which the launcher admits from version 2. Install version 2 as [the grader install](grader.md#22-version-2) describes. Its `ROOT=` and `ACCOUNT=` lines must match step 1 of the grader install.

Check that the probe prints `"version":2`, and that `infinite eval status PROJECT_ID` no longer shows `version 1: no trials`.

Undo: install the version 1 file again, as [the grader install](grader.md#22-version-2) describes.

## 10. The configuration

Host configuration. Add the `member` block beside `grader` in the `eval` block of `/etc/infinite/config.json`, then restart the API so it reads the file:

```json
"eval": {
  "member": {
    "prefix": { "command": "/usr/bin/sudo", "args": ["-n", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval-command"] },
    "root": "/var/lib/infinite-eval/root",
    "agents": {
      "claude": { "command": "/usr/bin/sudo", "args": ["-n", "-H", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval/claude"] }
    },
    "canaries": ["/PATH/TO/GITHUB_APP_KEY", "/PATH/TO/GITHUB_APP_GRANT", "/etc/infinite-egress/key", "/PATH/TO/AGENT_HOME/canary"]
  }
}
```

Put in `canaries` the secret paths of [GitHub App renewal](github-app.md), [the GitHub proxy](github-proxy.md), the egress key of [egress](egress.md), and the relay key of [public relay](public-relay.md), and a canary file in the agent account's home. The probe reads each canary as the eval account. A canary it can read gives `exposed`, and no trial starts. The list holds at most 32 entries. Add `codex` and `opencode` under `agents` only for the providers whose logins you made in step 7. If the `agents.codex` entry sets `workspaceDir`, that directory must be owned by the eval account.

Grader canaries. Add the three login paths of step 7 under the eval home to `eval.grader.canaries`: `/var/lib/infinite-eval/home/.claude/.credentials.json`, `/var/lib/infinite-eval/home/.codex/auth.json`, and `/var/lib/infinite-eval/home/.local/share/opencode/auth.json`. The grader runs untrusted tests, and these files are what it must never read. The reset keeps them, and the probe only checks whether the grader can read each path, never its content. A separate canary file in the eval home would not work: the reset of step 8 removes every file there that is not a login, and the eval probe counts it as a leftover until then.

Project configuration. A project needs its validation settings, which [the grader install](grader.md#6-configuration) and [teams](../../docs/teams.md#eval-mining-and-validation) describe, and `trialsPerDay`. Without `trialsPerDay`, no trial starts. Set it as the owner through `PUT /api/projects/PROJECT_ID/team`, with the body `{ "team": { "eval": { "trialsPerDay": 6 } } }`. The default is off. The recommended first value is 6. `candidateProfiles` in the same block adds up to 8 profiles that the lineup does not have. No prompt shows them, and they serve only baseline jobs.

Undo: remove the `member` block and restart `infinite.service`. To stop trials for one project, write its team block again without `trialsPerDay`. `infinite eval status PROJECT_ID` then shows `trials off`.

## 11. The checks

Run every check after steps 1 to 10. A failed check means a trial could reach something it must not, so do not start one until each check passes.

```sh
sudo -l -U infinite-host                 # exactly the eval rules of step 4, and no others
```

The output shows the `Defaults` line of step 4 and these three rules, all for `infinite-eval`: the launcher, the four wrappers, and the transcript drain.

Environment. Create a work directory for one trial by hand, then run `/usr/bin/env` through the launcher from it. The output holds only the fixed list.

```sh
TRIAL=$(uuidgen | tr 'A-Z' 'a-z')
sudo -u infinite-eval mkdir -m 0711 "/var/lib/infinite-eval/root/trials/$TRIAL"
sudo -u infinite-eval mkdir -m 0711 "/var/lib/infinite-eval/root/trials/$TRIAL/work"
cd "/var/lib/infinite-eval/root/trials/$TRIAL/work" && sudo -u infinite-host -- sh -c \
  'export INFINITE_HOOK_TOKEN=check HTTPS_PROXY=http://127.0.0.1:1; sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command exec -- /usr/bin/env'
```

The output has exactly these ten names: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT`, `GIT_OPTIONAL_LOCKS`, and `GIT_NO_REPLACE_OBJECTS`. `INFINITE_HOOK_TOKEN` and `HTTPS_PROXY` must not appear.

Stop. Start a process as the account from the same work directory, and then stop the account. Run this only when no trial exists.

```sh
cd "/var/lib/infinite-eval/root/trials/$TRIAL/work" && sudo -u infinite-host -- sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command exec -- /bin/sleep 300 &
sleep 2 && pgrep -u infinite-eval -l sleep                     # prints the sleep
sudo -u infinite-host -- sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command stop
pgrep -u infinite-eval -l sleep                                # prints nothing
```

`stop` also removes the account's System V shared memory, semaphores, and message queues, and its files in `/tmp`, `/var/tmp`, `/dev/shm`, `/dev/mqueue`, `/run/lock`, and `/var/crash`. After it, `ipcs` lists no object owned by the account, and `sudo find /tmp /var/tmp /dev/shm /dev/mqueue /run/lock /var/crash -xdev -user infinite-eval 2>/dev/null` prints nothing (the redirection hides the error for a directory that does not exist on this machine).

Clean. Plant a file in the temporary directory and remove it with `clean`:

```sh
sudo -u infinite-eval touch /var/lib/infinite-eval/tmp/planted
sudo -u infinite-host -- sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command clean
sudo -u infinite-eval test -e /var/lib/infinite-eval/tmp/planted || echo "gone after clean"
```

Scrub. Plant a file in the home and reset the home with `scrub`:

```sh
sudo -u infinite-eval touch /var/lib/infinite-eval/home/planted
sudo -u infinite-host -- sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command scrub
sudo -u infinite-eval test -e /var/lib/infinite-eval/home/planted || echo "gone after scrub"
```

Probe and status. The probe line must show nothing left over, and the host reads it as `ready` only when every fact passes:

```sh
sudo -u infinite-host -- sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command probe --
infinite eval status PROJECT_ID          # eval identity ready
```

The probe line has `"trials":0` and `"leftovers":0`. `infinite eval status` then prints `eval identity ready`. Any other state names the failed check, and the states are those of [the eval member account](../../docs/security.md#eval-member-account).

The account is ready once every check above passed. A trial still starts only when `trialsPerDay` is set on a project.

## Stopping trials

Cancel a baseline job with `infinite eval cancel JOB`, which voids its live trial as `void-owner`. Remove `trialsPerDay` from the project, so that no job starts another trial. Remove `eval.member` and restart `infinite.service`, so that no eval identity is configured.
