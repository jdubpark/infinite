#!/usr/bin/python3 -I
"""Run the installed code graph builder within the deployment's workspace roots."""

import argparse
import os
from pathlib import Path
import re
import subprocess

WORKSPACES = Path("/srv/infinite-data/workspaces")
TEAM_WORKSPACES = Path("/srv/infinite-data/team-workspaces")
CACHE = Path("/srv/infinite-data/repository-graphs")
BUILDER = "/opt/infinite/scripts/repository_graph.py"
GRAPHIFY = "/usr/local/bin/graphify"
GIT_OVERRIDE_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
)
GIT_ENV = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
}

def check_no_symlink_ancestors(root):
    cursor = Path("/")
    for part in root.parts[1:]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("Symlinked repository or cache paths are not supported.")

def inside(value, *roots):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("An absolute path is required.")
    if ".." in path.parts:
        raise ValueError("The requested path is outside its assigned root.")
    resolved = path.resolve()
    matched = None
    matched_resolved = None
    for root in roots:
        check_no_symlink_ancestors(root)
        resolved_root = root.resolve()
        if resolved != resolved_root and resolved_root in resolved.parents:
            matched = root
            matched_resolved = resolved_root
            break
    if matched is None:
        raise ValueError("The requested path is outside its assigned root.")
    cursor = path
    while cursor != matched and cursor != matched_resolved and cursor != cursor.parent:
        if cursor.is_symlink():
            raise ValueError("Symlinked repository or cache paths are not supported.")
        cursor = cursor.parent
    return str(resolved)

def validate_git_dirs(repo_path, *roots):
    repo = Path(repo_path)
    if repo.exists() and not repo.is_dir():
        raise ValueError("Repository path must be a directory.")
    if not repo.is_dir():
        return
    probe = subprocess.run(
        ["/usr/bin/git", "-c", "safe.directory=*", "-C", repo_path, "rev-parse",
         "--show-toplevel", "--path-format=absolute", "--git-dir", "--git-common-dir"],
        env=GIT_ENV,
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        dot_git = repo / ".git"
        if dot_git.exists() or dot_git.is_symlink():
            raise ValueError("Cannot resolve git repository.")
        return
    lines = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
    if len(lines) != 3:
        raise ValueError("Cannot resolve git repository.")
    for git_path in lines:
        inside(git_path, *roots)

def main():
    for key in GIT_OVERRIDE_VARS:
        os.environ.pop(key, None)
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
    repo_path = inside(args.repo, WORKSPACES, TEAM_WORKSPACES)
    validate_git_dirs(repo_path, WORKSPACES, TEAM_WORKSPACES)
    command = ["/usr/bin/python3", BUILDER, "--repo", repo_path,
               "--cache-dir", inside(args.cache_dir, CACHE), "--ref", args.ref,
               "--graphify", GRAPHIFY, "--timeout-seconds", str(args.timeout_seconds),
               "--max-workers", str(args.max_workers)]
    if args.seed_cache_dir is not None:
        command.extend(["--seed-cache-dir", inside(args.seed_cache_dir, CACHE)])
    os.umask(0o077)
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
