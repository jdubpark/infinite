#!/bin/sh
# The final transcript drain: after a provider exits, the worker runs the hook relay once more as the
# agent account. It takes no arguments. The worker's authenticated reply names the transcript, and
# sudo's env_keep passes the hook address and token.
set -eu
umask 077
ulimit -c 0
if [ "$#" -ne 0 ]; then
  printf 'transcript-drain takes no arguments\n' >&2
  exit 64
fi
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/node /opt/infinite/packages/host/dist/hook-relay.js drain
