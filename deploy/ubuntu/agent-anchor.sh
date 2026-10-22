#!/bin/sh
# Sourced by install-agent-env.sh.
#
# infinite_wrapper_anchor_ok FILE is a cheap static precheck: exactly one
# unindented `export SHELL=/bin/bash` line with no brace group open before it.
# Static reading of shell cannot prove placement (heredocs, comments, case
# patterns), so the gate is infinite_wrapper_hook_proven FILE: it runs the
# wrapper under INFINITE_AGENT_ENV_SELFTEST=1 and requires the loader's marker.
# The loader exits before any provider starts; FILE must carry a basename that
# is not a provider name, so a wrapper whose hook never runs reaches the
# "Unknown agent launcher" branch and exits instead of launching anything.
infinite_wrapper_anchor_ok() {
  awk '
    BEGIN { anchors = 0; depth = 0; bad = 0 }
    $0 == "export SHELL=/bin/bash" {
      anchors++
      if (depth != 0) bad = 1
      next
    }
    /^[ \t]*#/ { next }
    {
      line = $0
      gsub(/"[^"]*"/, "", line)
      gsub(/'"'"'[^'"'"']*'"'"'/, "", line)
      opens = gsub(/\{/, "{", line)
      closes = gsub(/\}/, "}", line)
      depth += opens - closes
    }
    END { exit (anchors == 1 && bad == 0) ? 0 : 1 }
  ' "$1"
}

infinite_wrapper_hook_proven() {
  case $(basename "$1") in
    claude|codex|codex-app-server|grok|opencode|demo) return 2 ;;
  esac
  [ -x "$1" ] || return 1
  _infinite_hook_output=$(INFINITE_AGENT_ENV_SELFTEST=1 INFINITE_PROJECT_ID= "$1" </dev/null 2>&1) || return 1
  case $_infinite_hook_output in
    *'infinite-agent-env: loaded'*) return 0 ;;
  esac
  return 1
}
