#!/bin/sh
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
API=$!
echo "$API" > "$INST/server.pid"
echo "run $RUN port $PORT"
STATUS=""
DEADLINE=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  kill -0 "$API" 2>/dev/null || { echo "the API process $API exited; see $EVID/server.log" >&2; exit 1; }
  if [ "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)" = "$API" ]; then
    STATUS=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" || true)
    [ "$STATUS" = 401 ] && break
  fi
  sleep 1
done
[ "$STATUS" = 401 ] || { echo "the API process $API did not answer 401 on port $PORT as its only listener" >&2; exit 1; }
echo "api $STATUS"
