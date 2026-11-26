#!/bin/sh
set -eu

script=$1
shift

exec python3 "$(dirname "$0")/cloud-check.py" --npm-script "$script" -- "$@"
