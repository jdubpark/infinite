#!/bin/sh
set -eu
umask 077
ulimit -c 0

# sudo -H supplies the dedicated agent account's encrypted home, provider logins and Jevcode state.
export TMPDIR=/srv/infinite-data/tmp/agent
export PATH=/opt/infinite-agents/v1/bin:/usr/local/bin:/usr/bin:/bin

# Jev (TypeSafe) gates refreshes and checks claims when the agent account holds a key.
if [ -r "$HOME/.config/jevcode/jev-api-key" ]; then
  JEV_API_KEY=$(cat "$HOME/.config/jevcode/jev-api-key")
  export JEV_API_KEY
fi

exec /usr/local/bin/node /opt/jevcode-repo-agent/dist/cli.js "$@"
