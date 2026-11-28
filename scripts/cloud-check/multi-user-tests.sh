#!/bin/sh
set -eu

node=$1
runner=$(id -un)
probe=$(mktemp -d /tmp/team-check-stop-sudo.XXXXXX)
chmod 0777 "$probe"
trap 'rm -rf "$probe"' EXIT
sudo -n -u "$runner" -- sudo -n -u nobody -- "$node" -e 'require("node:fs").writeFileSync(process.argv[1], "")' "$probe/probe"
rm -rf "$probe"
trap - EXIT
exec "$node" --import tsx --test --test-concurrency=1 tests/team-check-stop.test.ts
