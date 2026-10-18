#!/bin/sh
set -eu
umask 077
ulimit -c 0

# sudo -H supplies the dedicated agent account's encrypted home and Codex login.
export TMPDIR=/srv/infinite-data/tmp/agent
export PATH=/opt/infinite-agents/v1/bin:/usr/local/bin:/usr/bin:/bin

exec /usr/local/bin/node /opt/jevcode-repo-agent/dist/cli.js "$@"
