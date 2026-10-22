#!/bin/sh
# Sourced by install-agent-env.sh. Defines infinite_wrapper_anchor_ok FILE:
# succeeds only when FILE contains exactly one unindented
# `export SHELL=/bin/bash` line that sits at top level, i.e. no function
# definition or brace group has been opened before it. The installer inserts
# the loader hook right after that line, so the anchor must execute on every
# launch, not inside an optional function.
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
