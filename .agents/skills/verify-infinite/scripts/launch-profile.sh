#!/bin/sh
# Starts a disposable teams or goals host for the verify-infinite journeys.
# Usage (from any directory): sh launch-profile.sh teams|goals
# Steps, each of which stops the launch on failure: claim the instance, init it without starting, configure it
# with fixture agents, start the API, and wait for it to answer. Writes .local/verify/LAST-RUN so the Doctor,
# Drive, and Cleanup blocks read this run. Set CHECKOUT to the checkout to use.
set -eu

PROFILE="${1:-}"
case "$PROFILE" in
  teams|goals) ;;
  *) echo "usage: launch-profile.sh teams|goals" >&2; exit 1 ;;
esac

ROOT=$(cd "${CHECKOUT:-.}" && git rev-parse --show-toplevel)
DRIVE="$ROOT/.agents/skills/verify-infinite/scripts/drive.mjs"
RUN="$PROFILE-$(date -u +%Y%m%dT%H%M%SZ)"
INST="$ROOT/.local/verify/$RUN/instance"
EVID="$ROOT/.local/verify/$RUN/evidence"
mkdir -p "$ROOT/.local/verify"
printf '%s\n' "$RUN" > "$ROOT/.local/verify/LAST-RUN"

# Ports 4781 and up. 4780 is never a candidate.
PORT=""
for CANDIDATE in 4781 4782 4783 4784 4785 4786 4787; do
  if [ -z "$(lsof -nP -iTCP:$CANDIDATE -sTCP:LISTEN 2>/dev/null)" ]; then PORT=$CANDIDATE; break; fi
done
if [ -z "$PORT" ]; then echo "no free port in 4781-4787" >&2; exit 1; fi

mkdir -p "$EVID"
node "$DRIVE" claim --instance "$INST" --profile "$PROFILE" --port "$PORT"
RUNDIR=$(cat "$INST/run-dir")
cd "$ROOT"
node --import tsx packages/host/src/cli.ts init --local --config "$INST/config.json" --port "$PORT" \
  --state-dir "$INST/data" --run-dir "$RUNDIR" --project "$INST/workspace" --name "Verification host" > "$EVID/init.log" 2>&1
node "$DRIVE" configure --instance "$INST" --profile "$PROFILE"
nohup node --import tsx packages/host/src/cli.ts dev --config "$INST/config.json" --port "$PORT" \
  --state-dir "$INST/data" --run-dir "$RUNDIR" --project "$INST/workspace" --name "Verification host" \
  > "$EVID/server.log" 2>&1 &
echo $! > "$INST/server.pid"
curl --retry 30 --retry-connrefused --retry-delay 1 -s -o /dev/null -w 'api %{http_code}\n' "http://127.0.0.1:$PORT/api/me"
echo "run $RUN port $PORT"
