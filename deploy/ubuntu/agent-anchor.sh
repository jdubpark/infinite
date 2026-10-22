#!/bin/sh
# Sourced by install-agent-env.sh.
#
# The installer never reasons about arbitrary shell: it patches a wrapper only
# when everything from line 1 through the `export SHELL=/bin/bash` anchor is
# byte-identical to the shipped deploy/ubuntu/agent-wrapper.sh. That prefix is
# known straight-line code (set -eu, umask, ulimit, exports), so a hook placed
# right after it executes on every launch. Nothing is executed to decide.
#
# infinite_wrapper_prefix_state FILE REFERENCE prints one of:
#   patched   FILE starts with the reference prefix followed by the hook line
#   patchable FILE starts with the reference prefix and no hook line
#   drifted   FILE differs from the reference before the anchor, or lacks it
# and prints the reference anchor line number on a second line for patchable.
infinite_wrapper_prefix_state() {
  _infinite_file=$1
  _infinite_ref=$2
  _infinite_anchor_line=$(grep -nFx 'export SHELL=/bin/bash' "$_infinite_ref" | head -n 1 | cut -d: -f1)
  if [ -z "$_infinite_anchor_line" ]; then printf 'drifted\n'; return 1; fi
  _infinite_hook=$(sed -n "$((_infinite_anchor_line + 1))p" "$_infinite_ref")
  case $_infinite_hook in *agent-env.sh*infinite_load_env*) ;; *) printf 'drifted\n'; return 1 ;; esac

  _infinite_patched=$(head -n "$((_infinite_anchor_line + 1))" "$_infinite_ref")
  _infinite_prefix=$(head -n "$_infinite_anchor_line" "$_infinite_ref")
  if [ "$(head -n "$((_infinite_anchor_line + 1))" "$_infinite_file")" = "$_infinite_patched" ]; then
    printf 'patched\n'; return 0
  fi
  if [ "$(head -n "$_infinite_anchor_line" "$_infinite_file")" = "$_infinite_prefix" ]; then
    printf 'patchable\n%s\n' "$_infinite_anchor_line"; return 0
  fi
  printf 'drifted\n'; return 1
}
