#!/usr/bin/python3
"""Run the installed code graph builder within the deployment's workspace roots."""

import argparse
import os
from pathlib import Path
import re


WORKSPACES = Path("/srv/infinite-data/workspaces")
CACHE = Path("/srv/infinite-data/repository-graphs")
BUILDER = "/opt/infinite/scripts/repository_graph.py"
GRAPHIFY = "/usr/local/bin/graphify"


def inside(value, root):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("An absolute path is required.")
    resolved = path.resolve()
    if resolved == root or root not in resolved.parents:
        raise ValueError("The requested path is outside its assigned root.")
    # The builder also checks its own files. Reject symlinks before crossing the
    # fixed deployment boundary, including paths whose final directory is new.
    cursor = path
    while cursor != root and cursor != cursor.parent:
        if cursor.is_symlink():
            raise ValueError("Symlinked repository or cache paths are not supported.")
        cursor = cursor.parent
    return str(resolved)


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--graphify", default=GRAPHIFY)
    parser.add_argument("--seed-cache-dir")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--max-workers", type=int, default=2)
    args = parser.parse_args()
    if args.graphify != GRAPHIFY or not (args.ref == "HEAD" or re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", args.ref)):
        raise ValueError("Use the installed extractor and an exact commit or HEAD.")
    if not 1 <= args.timeout_seconds <= 300 or not 1 <= args.max_workers <= 2:
        raise ValueError("The extraction budget exceeds the deployment limit.")
    command = ["/usr/bin/python3", BUILDER, "--repo", inside(args.repo, WORKSPACES),
               "--cache-dir", inside(args.cache_dir, CACHE), "--ref", args.ref,
               "--graphify", GRAPHIFY, "--timeout-seconds", str(args.timeout_seconds),
               "--max-workers", str(args.max_workers)]
    if args.seed_cache_dir:
        command.extend(["--seed-cache-dir", inside(args.seed_cache_dir, CACHE)])
    os.umask(0o077)
    # No provider environment, network credentials, or inherited Graphify flags
    # are needed by deterministic code extraction.
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "HOME": str(CACHE / "tool-home"), "TMPDIR": "/srv/infinite-data/tmp/agent",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_TERMINAL_PROMPT": "0"}
    os.chdir(str(CACHE))
    os.execve(command[0], command, env)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit("Repository graph request refused: " + str(error))
