---
name: verify-infinite
description: Drive the running Infinite web client (React app served by the host API) like a user and capture evidence. Launches a private host on a free port from this checkout, checks it, signs in and walks features with Playwright, keeps screenshots and logs under .local/verify, and cleans up. Use when a task needs proof that web sign-in, the session list, sessions, steering, teams, or goals work on a running host, or to reproduce a web UI bug. The phone app and Mac app are other surfaces (see the end of this file).
---

# Verify Infinite

Use this skill to run a disposable Infinite host from this checkout, drive the web client in a real browser, and keep the evidence. The host runs with the demo provider only, which the UI calls **Rehearsal**: a local test process that does not call a model. Do not start any other provider from a verification run.

Pick the feature to drive from `features/README.md`. Only the sign-in journey is scripted; the other feature files give the selectors and steps to drive with Playwright.

## Conventions

Every shell block below assumes these variables. Shell state does not persist between tool calls, so set them again in each block that needs them. `ROOT` comes from the checkout that contains the shell's current directory, and a new shell can start in a different checkout (for example the primary one). Start each block with `cd` into the checkout you are verifying, and confirm the `checkout` line that the launch prints.

```sh
ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
RUN=$(cat "$ROOT/.local/verify/LAST-RUN")
INST="$ROOT/.local/verify/$RUN/instance"
EVID="$ROOT/.local/verify/$RUN/evidence"
PORT=$(node -p "require('$INST/config.json').port")
```

- `instance/` holds what the host owns: `config.json`, `devices.json` (the owner, controller, and viewer keys), the vault key, state, the workspace, and the PID file. Cleanup deletes it.
- `evidence/` holds screenshots, JSON and text logs, and `cleanup.log`. Cleanup never deletes it.
- `.local/` is git-ignored. Evidence contains local paths from the server log. Redact before copying anything into a tracked file.

## Launch

1. Build once. Skip this if `apps/web/dist/index.html` and `packages/host/dist/cli.js` already exist. Build again after changing `packages/host` or `apps/web`, because the host serves `apps/web/dist` and `doctor` runs `packages/host/dist`. The build takes about 15 seconds.

   ```sh
   ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
   cd "$ROOT" && npm run build
   ```

2. Pick a free port, create the run, and start the host. Run the whole block in one shell call, because the variables do not carry over. The README default is 4780, but another process may already hold it; this block skips any port with a listener and never touches a process it did not start. The first start initializes an empty instance: config, device keys, vault key, and the demo workspace.

   The run directory is under `/tmp`, which is also the host's own default run directory. The session workers listen on Unix sockets inside it, and short socket paths are the portable choice (the macOS header limits `sun_path` to 104 bytes). Repository-local socket paths also worked in testing on this machine, but do not rely on that. `npm run dev` wraps `tsx`; this block runs the same entry point directly, so the recorded PID is the API process.

   ```sh
   ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel) && echo "checkout: $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD) $(git -C "$ROOT" rev-parse --short HEAD))"
   PORT=""
   for CANDIDATE in 4780 4781 4782 4783 4784 4785 4786 4787; do
     if [ -z "$(lsof -nP -iTCP:$CANDIDATE -sTCP:LISTEN 2>/dev/null)" ]; then PORT=$CANDIDATE; break; fi
   done
   [ -n "$PORT" ] || { echo "no free port in 4780-4787"; exit 1; }
   RUN="verify-$(date -u +%Y%m%dT%H%M%SZ)"
   INST="$ROOT/.local/verify/$RUN/instance"
   EVID="$ROOT/.local/verify/$RUN/evidence"
   RUNDIR=$(mktemp -d /tmp/iv-XXXXXX)
   mkdir -p "$INST" "$EVID"
   printf '%s\n' "$RUN" > "$ROOT/.local/verify/LAST-RUN"
   printf '%s\n' "$RUNDIR" > "$INST/run-dir"
   cd "$ROOT"
   nohup node --import tsx packages/host/src/cli.ts dev \
     --config "$INST/config.json" --port "$PORT" \
     --state-dir "$INST/data" --run-dir "$RUNDIR" \
     --project "$INST/workspace" --name "Verification host" \
     > "$EVID/server.log" 2>&1 &
   echo $! > "$INST/server.pid"
   echo "run $RUN on port $PORT"
   curl --retry 30 --retry-connrefused --retry-delay 1 -s -o /dev/null -w 'api %{http_code}\n' "http://127.0.0.1:$PORT/api/me"
   ```

   Expected last line: `api 401`. An anonymous `/api/me` returns 401, which means the API is up and authentication is enforced. Curl's own retry delay waits for the start, so no shell sleep is needed.

   Any other result after 30 seconds means the start failed. Read `evidence/server.log` and run cleanup before starting again with a new run. A port conflict appears there as `listen EADDRINUSE`; the block above should prevent that, so check whether something else started on the port in the meantime.

## Doctor

Run the doctor before driving, and whenever something looks wrong. Both commands are read-only.

```sh
ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
RUN=$(cat "$ROOT/.local/verify/LAST-RUN")
INST="$ROOT/.local/verify/$RUN/instance"
EVID="$ROOT/.local/verify/$RUN/evidence"
node "$ROOT/.agents/skills/verify-infinite/scripts/drive.mjs" doctor --instance "$INST"
cd "$ROOT" && npm run --silent host -- doctor --config "$INST/config.json" > "$EVID/doctor-cli.txt" 2>&1; echo "cli doctor exit=$?"; cat "$EVID/doctor-cli.txt"
```

The first command checks that the recorded PID is this instance's process (its arguments contain this instance's config path), that the port's listener is that PID, that anonymous API calls are refused, that the owner key is accepted, that the session list is readable, and that the web and host builds exist. It exits 1 on any failure.

The second command is the CLI's own doctor. It prints provider versions and warnings. The warnings about `/etc/claude-code/managed-settings.json` and `/etc/codex/requirements.toml` are expected on a development host. Those ceilings are installed on the cloud host by `deploy/ubuntu/install-ceilings.sh`.

## Drive

Run the scripted journey:

```sh
ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
RUN=$(cat "$ROOT/.local/verify/LAST-RUN")
INST="$ROOT/.local/verify/$RUN/instance"
node "$ROOT/.agents/skills/verify-infinite/scripts/drive.mjs" sign-in --instance "$INST"
```

The `sign-in` journey does the following, and writes one line per step to `evidence/sign-in.log`:

1. Opens the origin and waits for the heading "Pick up where you left off."
2. Negative control: submits an unknown 40-character key and expects the alert "Device key was not recognized".
3. Signs in with the owner key from `devices.json`.
4. Checks that the browser session cookie is set (httpOnly, path `/api`).
5. Opens the All filter in the session list and compares the rail count with `GET /api/sessions`.
6. Checks that the owner key does not appear in the page text or HTML, and that the page logged no errors.

It exits 0 on pass and 1 on fail. A failed run also writes `99-failure.png`.

For any other feature, write a script in `$ROOT/.local/verify/$RUN/` so Playwright resolves from the repository's `node_modules`. Read the owner key with `JSON.parse(readFileSync(...devices.json)).owner`, never print it, and launch Chromium with the same executable lookup as `drive.mjs` (see Helpers). Do not run `npx playwright install`; if no Chrome is available, set `PLAYWRIGHT_CHROMIUM_PATH` to an installed Chrome.

## Evidence

Proof standards:

- Exercise the real user path: the browser UI for actions and the owner API only to read state. Do not use internal setters, test-only endpoints, or a pre-seeded session as the thing being proved.
- Capture the action and the resulting state, not only the final screen. For sign-in, that is the refused key, the accepted key, and the session count the UI shows against the API count.
- Check side effects next to what is visible. For sign-in, that is the browser cookie.
- Use no mocks. The demo provider is a real local process under the real session worker, but it does not call a model.

After the journey, confirm the evidence exists and that the owner key is not in it. The check prints only file names and a verdict:

```sh
ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
RUN=$(cat "$ROOT/.local/verify/LAST-RUN")
INST="$ROOT/.local/verify/$RUN/instance"
EVID="$ROOT/.local/verify/$RUN/evidence"
ls "$EVID"
KEY=$(node -p "require('$INST/devices.json').owner")
grep -rlF "$KEY" "$EVID" && echo "owner key found in evidence: fix before sharing" || echo "owner key not in evidence"
unset KEY
```

Files from the sign-in journey: `01-sign-in.png`, `02-session-list.png`, `sign-in.json` (verdict, steps, page errors), `sign-in.log`, `server.log`, and `doctor-cli.txt`. Cleanup adds `cleanup.log`.

## Cleanup

Run cleanup after every attempt, including failed ones, before starting another run:

```sh
ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
RUN=$(cat "$ROOT/.local/verify/LAST-RUN")
INST="$ROOT/.local/verify/$RUN/instance"
EVID="$ROOT/.local/verify/$RUN/evidence"
PORT=$(node -p "require('$INST/config.json').port" 2>/dev/null || echo 4780)
node "$ROOT/.agents/skills/verify-infinite/scripts/drive.mjs" cleanup --instance "$INST"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || echo "port $PORT is free"
ls "$EVID"
```

Cleanup does this, and logs each step to `evidence/cleanup.log`:

1. Finds this instance's processes. A session worker is a `packages/host/src/worker.ts` (or `dist/worker.js`) process that holds a unix socket under this instance's run directory. Its agent process is any descendant of the worker. Nothing else is included: a shell or editor with a file open in the instance directory is never signalled. Each process's command line is recorded when it is found.
2. If the API is this instance's process (its arguments contain this instance's config path), stops each running or starting session through `POST /api/sessions/:id/stop` as the owner.
3. Gives those processes 10 seconds to exit, sends TERM to any still alive, and sends KILL after a further 5 seconds.
4. Stops the API the same way: TERM, a wait of up to 10 seconds, then KILL. Then it checks again for late instance processes and stops them.
5. Removes the `/tmp/iv-*` run directory and the instance directory. It keeps the evidence directory.

Workers are detached and outlive the API by design, so cleanup finds and stops them whether or not the API is still up. It does not match by process name (no `pkill`). It signals only the processes found by the checks above, and before every TERM or KILL it checks that the PID still runs the recorded command line (the API must still carry this instance's config path), so a reused PID is never signalled.

If cleanup reports a PID it could not stop, check its arguments and working directory before doing anything by hand. Do not kill by name, and do not kill a process whose arguments do not contain this instance's paths.

## Helpers

`scripts/drive.mjs` is executable and runs with `node`. Its commands:

- `doctor --instance DIR [--port PORT]`: read-only checks listed under Doctor.
- `sign-in --instance DIR [--port PORT] [--evidence DIR]`: the sign-in journey.
- `cleanup --instance DIR`: teardown under Cleanup.

`--port` defaults to the port in `DIR/config.json`. `--evidence` defaults to `DIR/../evidence`. Chromium is taken from `PLAYWRIGHT_CHROMIUM_PATH` when set, then from the macOS Google Chrome app at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then from Playwright's bundled build. The helper imports `playwright` and `@playwright/test` from the repository's `node_modules`.

## Feature map

`features/README.md` lists the web features and which ones are scripted. Each feature file has the sub-features, how to reach the feature as a user, how to drive it with Playwright, and its gotchas.

## Other surfaces

These surfaces are not covered by this skill. Read their own docs:

- Phone app (`apps/mobile`, React Native with Expo): `apps/mobile/AGENTS.md`, and the "Phone" section of `README.md`. Run `npm run android -w @infinite/mobile` against an emulator, paired with the local host through `adb reverse`.
- Mac app (`apps/macos`): `docs/desktop.md`. Build and install with `npm run desktop:install`.

## Known limits

- Only the sign-in journey is scripted and has been run end to end. Sessions, steering, teams, and goals are mapped to source; their selectors come from `apps/web/src`, but they have not been driven yet.
- The cleanup path with a live session was tested with demo sessions started through the owner API on throwaway instances, not through the browser UI. Both orders were tested: API stopped through cleanup, and API killed first with a worker still running.
- Socket path length was measured on the development machine only. Long repository-local socket paths bound and accepted connections there; the `/tmp` run directory is the portable choice.
- The host binds to `127.0.0.1` only. Cloud, relay, and Tailscale access are out of scope.
- The rehearsal config has teams and goals disabled. Driving those pages needs host setup that this skill does not perform.
