#!/usr/bin/env python3
"""Build a private, incremental Graphify snapshot for one repository ref."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

MAX_LOG = 32_000
_ACTIVE_CHILD: subprocess.Popen[bytes] | None = None
_INTERRUPTED = False


class BuildError(RuntimeError):
    pass


def _safe_path(path: Path, *, allow_missing: bool = True) -> Path:
    supplied = path.expanduser().absolute()
    # Resolve caller-provided parent directories (system temporary roots may
    # themselves be symlink aliases), but never follow a cache-root symlink.
    missing: list[str] = []
    parent = supplied.parent
    while not parent.exists():
        try:
            if stat.S_ISLNK(parent.lstat().st_mode):
                raise BuildError("symlink in cache parent path")
        except FileNotFoundError:
            pass
        missing.append(parent.name)
        parent = parent.parent
    resolved_parent = parent.resolve(strict=True)
    for part in reversed(missing):
        resolved_parent = resolved_parent / part
    path = resolved_parent / supplied.name
    try:
        info = path.lstat()
    except FileNotFoundError:
        if not allow_missing:
            raise BuildError("path does not exist")
        return path
    if stat.S_ISLNK(info.st_mode):
        raise BuildError("cache root is a symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise BuildError("cache root is not a directory")
    return path


def _git(repo: Path, *args: str, timeout: float = 30) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "-c", "safe.directory=" + str(repo),
             "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=True, timeout=timeout,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                 "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.SubprocessError) as exc:
        detail = getattr(exc, "stderr", b"")
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "replace")
        raise BuildError((str(detail).strip() or str(exc))[-1000:]) from exc
    return result.stdout


def _resolve(repo: Path, ref: str) -> str:
    try:
        value = _git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()
    except BuildError as exc:
        raise BuildError("cannot resolve requested git ref") from exc
    if len(value) not in (40, 64) or any(c not in "0123456789abcdef" for c in value.lower()):
        raise BuildError("git returned an invalid commit id")
    return value.lower()


def _tree(repo: Path, head: str) -> tuple[dict[str, tuple[str, str]], list[str]]:
    raw = _git(repo, "ls-tree", "-r", "-z", "--full-tree", head)
    files: dict[str, tuple[str, str]] = {}
    warnings: list[str] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        metadata, raw_name = item.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()[:3]
        name = raw_name.decode("utf-8", "surrogateescape")
        pure = PurePosixPath(name)
        if pure.is_absolute() or any(part in ("", ".", "..") for part in name.split("/")):
            raise BuildError("unsafe path in git tree")
        if mode == "120000" or kind == "commit":
            warnings.append("skipped symlink or submodule entries")
            continue
        if kind == "blob" and mode in ("100644", "100755"):
            files[name] = (oid, mode)
    return files, warnings


def _is_resolution_input(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    if name in {"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "jsconfig.json"}:
        return True
    return name == "tsconfig.json" or (name.startswith("tsconfig.") and name.endswith(".json"))


def _is_js_ts_source(path: str) -> bool:
    return PurePosixPath(path).suffix.lower() in {
        ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
        ".ejs", ".ets", ".vue", ".svelte", ".astro",
    }


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _graph_schema(value: dict[str, Any] | None) -> int | None:
    graph_meta = value.get("graph") if value else None
    schema = graph_meta.get("schema_version") if isinstance(graph_meta, dict) else None
    return schema if isinstance(schema, int) and not isinstance(schema, bool) else None


def _write_graph_root(output: Path, source: Path) -> None:
    marker = output / ".graphify_root"
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise BuildError("invalid Graphify source-root marker")
    marker.write_text(str(source.resolve()), encoding="utf-8")


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".meta-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _current(root: Path) -> Path | None:
    path = root / "current"
    try:
        if not path.is_symlink():
            return None
        target = os.readlink(path)
        if not target.startswith("generations/") or "/" in target[len("generations/"):]:
            raise BuildError("unsafe current pointer")
        result = root / target
        if not result.is_dir() or result.is_symlink():
            return None
        return result
    except FileNotFoundError:
        return None


def _result(status: str, *, graph: Path | None = None, head: str | None = None,
            requested: str | None = None, mode: str | None = None,
            changed: int = 0, deleted: int = 0, affected: int = 0, reason: str | None = None,
            warnings: list[str] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"status": status, "graphPath": str(graph) if graph else None,
                              "head": head, "requestedHead": requested, "mode": mode,
                              "changedFiles": changed, "deletedFiles": deleted,
                              "affectedFiles": affected}
    if reason:
        result["reason"] = reason[:500]
    if warnings:
        result["warnings"] = list(dict.fromkeys(w[:200] for w in warnings))[:8]
    return result


def _run(command: list[str], *, cwd: Path, env: dict[str, str], timeout: float,
         logs: Path, label: str) -> None:
    if _INTERRUPTED:
        raise BuildError("builder interrupted by SIGTERM")
    logs.mkdir(parents=True, exist_ok=True)
    out_path, err_path = logs / (label + ".stdout"), logs / (label + ".stderr")
    global _ACTIVE_CHILD
    proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    _ACTIVE_CHILD = proc
    buffers = [bytearray(), bytearray()]

    def drain(stream: Any, buffer: bytearray) -> None:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                return
            buffer.extend(chunk)
            if len(buffer) > MAX_LOG:
                del buffer[:-MAX_LOG]

    readers = [threading.Thread(target=drain, args=(proc.stdout, buffers[0]), daemon=True),
               threading.Thread(target=drain, args=(proc.stderr, buffers[1]), daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        code = proc.returncode
    for reader in readers:
        reader.join()
    _ACTIVE_CHILD = None
    out_path.write_bytes(buffers[0])
    err_path.write_bytes(buffers[1])
    if timed_out:
        raise BuildError("Graphify command timed out")
    if _INTERRUPTED:
        raise BuildError("builder interrupted by SIGTERM")
    if code:
        raise BuildError("Graphify command failed; see bounded private logs")


def _handle_sigterm(_signum: int, _frame: Any) -> None:
    global _INTERRUPTED
    _INTERRUPTED = True
    child = _ACTIVE_CHILD
    if child is not None and child.poll() is None:
        try:
            # Graphify runs in a private process group, so terminate its full
            # descendant tree when the host stops this builder.
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _ensure_safe_entries(root: Path) -> None:
    for name in ("lock", "generations", "logs", "current"):
        child = root / name
        if child.is_symlink():
            if name != "current" or _current(root) is None:
                raise BuildError("symlink in cache entries")
        elif child.exists() and name in ("generations", "logs") and not child.is_dir():
            raise BuildError("invalid cache entry")
        elif child.exists() and name == "lock" and not child.is_file():
            raise BuildError("invalid cache lock")
    for directory_name in ("generations", "logs"):
        directory = root / directory_name
        if directory.is_dir() and not directory.is_symlink():
            for child in directory.iterdir():
                if child.is_symlink():
                    raise BuildError("symlink in cache entries")
                if directory_name == "generations" and not child.is_dir():
                    raise BuildError("invalid generation entry")
                if directory_name == "logs" and not child.is_file():
                    raise BuildError("invalid log entry")


def _assert_no_symlinks(path: Path) -> None:
    if path.is_symlink():
        raise BuildError("symlink in cached generation")
    if path.is_dir():
        for child in path.iterdir():
            _assert_no_symlinks(child)


def _version(executable: str) -> str:
    try:
        proc = subprocess.run([executable, "--version"], stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=10, check=True,
                              env={k: v for k, v in os.environ.items() if not k.startswith("GRAPHIFY_")})
    except (OSError, subprocess.SubprocessError) as exc:
        raise BuildError("cannot determine Graphify version") from exc
    value = proc.stdout.strip()
    if not value or len(value) > 100:
        raise BuildError("invalid Graphify version response")
    return value


def _dependent_sources(graph_path: Path, affected_sources: set[str],
                       live_sources: set[str], initial_target_ids: set[str] | None = None) -> set[str]:
    """Return reverse dependents whose old edges target changed source nodes."""
    graph = _read_json(graph_path)
    if graph is None:
        raise BuildError("baseline graph is missing or invalid")
    nodes = graph.get("nodes", [])
    links = graph.get("links", [])
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise BuildError("baseline graph has an invalid node or link list")

    def node_ids_for(sources: set[str]) -> set[str]:
        return {node["id"] for node in nodes if isinstance(node, dict)
                and node.get("source_file") in sources and isinstance(node.get("id"), str)}

    impacted = set(affected_sources)
    affected_files: set[str] = set()
    target_ids = node_ids_for(impacted) | (initial_target_ids or set())
    while target_ids:
        newly_affected: set[str] = set()
        for edge in links:
            if not isinstance(edge, dict) or edge.get("target") not in target_ids:
                continue
            source = edge.get("source_file")
            if isinstance(source, str) and source in live_sources and source not in impacted:
                newly_affected.add(source)
        newly_affected -= affected_files
        if not newly_affected:
            break
        affected_files.update(newly_affected)
        impacted.update(newly_affected)
        target_ids = node_ids_for(newly_affected)
    return affected_files


def _newly_resolved_dependents(baseline_graph_path: Path, current_graph_path: Path,
                               changed_sources: set[str], live_sources: set[str],
                               already_affected: set[str]) -> set[str]:
    baseline = _read_json(baseline_graph_path)
    current = _read_json(current_graph_path)
    if baseline is None or current is None:
        raise BuildError("cannot verify Graphify dependency merge")
    old_nodes, new_nodes = baseline.get("nodes", []), current.get("nodes", [])
    if not isinstance(old_nodes, list) or not isinstance(new_nodes, list):
        raise BuildError("invalid graph node list")
    external_ids = {n["id"] for n in old_nodes if isinstance(n, dict)
                    and n.get("external") and isinstance(n.get("id"), str)}
    new_provider_ids = {n["id"] for n in new_nodes if isinstance(n, dict)
                        and n.get("source_file") in changed_sources
                        and isinstance(n.get("id"), str)}
    resolved_ids: set[str] = set()
    for external_id in external_ids:
        # Graphify names unresolved module anchors `ref_<module>` but emits a
        # concrete file anchor as `<module>` when that source is added. Compare
        # the normalized module identity as well as exact node IDs so `ref_api`
        # correctly maps to the new `api` anchor and its `api_*` declarations.
        aliases = {external_id}
        if external_id.startswith("ref_"):
            aliases.add(external_id[4:])
        if any(provider_id in aliases or any(provider_id.startswith(alias + "_") for alias in aliases)
               for provider_id in new_provider_ids):
            resolved_ids.add(external_id)
    affected = _dependent_sources(baseline_graph_path, set(), live_sources, resolved_ids)
    previous_provider_ids = {n["id"] for n in old_nodes if isinstance(n, dict)
                             and n.get("source_file") and isinstance(n.get("id"), str)}
    introduced_js_provider = any(
        isinstance(n, dict) and n.get("source_file") in changed_sources
        and _is_js_ts_source(n["source_file"]) and isinstance(n.get("id"), str)
        and n["id"] not in previous_provider_ids for n in new_nodes
    )
    if introduced_js_provider:
        # Unresolved module IDs omit the importing directory. New concrete IDs
        # include it, so string normalization cannot safely resolve these links.
        # Revisit unresolved JS/TS consumers only when a provider is introduced;
        # ordinary body edits still reuse their unchanged graph entries.
        unresolved_consumers = {
            edge["source_file"] for edge in baseline.get("links", [])
            if isinstance(edge, dict) and edge.get("target") in external_ids
            and isinstance(edge.get("source_file"), str)
            and edge["source_file"] in live_sources and _is_js_ts_source(edge["source_file"])
        }
        affected.update(unresolved_consumers)
        affected.update(_dependent_sources(baseline_graph_path, unresolved_consumers, live_sources))
    return affected - already_affected


def build(args: argparse.Namespace) -> dict[str, Any]:
    repo = Path(args.repo).expanduser().resolve(strict=True)
    if not (repo / ".git").exists():
        raise BuildError("repo is not a git worktree")
    root = _safe_path(Path(args.cache_dir))
    try:
        if root == repo or root.is_relative_to(repo) or repo.is_relative_to(root):
            raise BuildError("cache-dir must be separate from the source workspace")
    except ValueError:
        pass
    root.mkdir(parents=True, exist_ok=True)
    root = _safe_path(root, allow_missing=False)
    _ensure_safe_entries(root)
    lock_path = root / "lock"
    with lock_path.open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            current = _current(root)
            meta = _read_json(current / "metadata.json") if current else None
            graph = current / "out" / "graphify-out" / "graph.json" if current and (current / "out" / "graphify-out" / "graph.json").is_file() else None
            return _result("busy", graph=graph, head=(meta or {}).get("head"), reason="cache lane is locked")

        requested = None
        try:
            requested = _resolve(repo, args.ref)
            entries, warnings = _tree(repo, requested)
            digest_input = json.dumps([[k, v[0], v[1]] for k, v in sorted(entries.items())],
                                      ensure_ascii=True, separators=(",", ":")).encode()
            tree_digest = hashlib.sha256(digest_input).hexdigest()
            current = _current(root)
            if current:
                _assert_no_symlinks(current)
            prior_meta = _read_json(current / "metadata.json") if current else None
            graph = current / "out" / "graphify-out" / "graph.json" if current else None
            executable = str(Path(args.graphify).expanduser())
            graphify_version = _version(executable)
            current_graph = _read_json(graph) if graph else None
            graph_schema = _graph_schema(current_graph)
            current_output = current / "out" / "graphify-out" if current else None
            current_ok = bool(current and graph and current_graph and graph_schema is not None
                            and current_output
                            and _read_json(current_output / "manifest.json") is not None
                            and _read_json(current_output / ".graphify_build.json") is not None
                            and prior_meta and prior_meta.get("treeDigest")
                            and prior_meta.get("graphifyVersion") == graphify_version
                            and prior_meta.get("graphSchema") == graph_schema
                            and prior_meta.get("options") == {"codeOnly": True, "maxWorkers": args.max_workers})
            if current and not current_ok:
                if prior_meta and prior_meta.get("graphifyVersion") != graphify_version:
                    warnings.append("Graphify version changed; performed an initial rebuild")
                elif prior_meta and prior_meta.get("graphSchema") != graph_schema:
                    warnings.append("Graph schema changed or is invalid; performed an initial rebuild")
                elif prior_meta and prior_meta.get("options") != {"codeOnly": True, "maxWorkers": args.max_workers}:
                    warnings.append("Graphify options changed; performed an initial rebuild")
                else:
                    warnings.append("Graph cache is missing or corrupt; performed an initial rebuild")
            if current_ok and prior_meta and prior_meta.get("head") == requested and prior_meta.get("treeDigest") == tree_digest:
                return _result("unchanged", graph=graph, head=requested, requested=requested,
                               mode="unchanged", warnings=warnings)

            baseline = current if current_ok else None
            baseline_meta = prior_meta if current_ok else None
            if baseline is None and args.seed_cache_dir:
                try:
                    seed_root = _safe_path(Path(args.seed_cache_dir), allow_missing=False)
                    if seed_root == root:
                        raise BuildError("seed cache must be a different lane")
                    seed_current = _current(seed_root)
                    seed_meta = _read_json(seed_current / "metadata.json") if seed_current else None
                    if not seed_current or not seed_meta:
                        raise BuildError("seed cache has no valid generation")
                    if seed_meta.get("graphifyVersion") != graphify_version or \
                            seed_meta.get("options") != {"codeOnly": True, "maxWorkers": args.max_workers}:
                        raise BuildError("seed cache Graphify version or options mismatch")
                    seed_head = str(seed_meta.get("head", ""))
                    _git(repo, "merge-base", "--is-ancestor", seed_head, requested)
                    seed_files, _ = _tree(repo, seed_head)
                    if seed_files != {k: (v[0], v[1]) for k, v in seed_meta.get("files", {}).items()}:
                        raise BuildError("seed cache source identity mismatch")
                    seed_out = seed_current / "out" / "graphify-out"
                    for artifact in ("graph.json", "manifest.json", ".graphify_build.json"):
                        path = seed_out / artifact
                        if path.is_symlink() or not path.is_file():
                            raise BuildError("seed cache is missing a regular Graphify artifact")
                    if (seed_out / ".graphify_root").is_symlink():
                        raise BuildError("seed cache source-root marker is a symlink")
                    seed_graph = _read_json(seed_out / "graph.json")
                    if _read_json(seed_out / "manifest.json") is None or \
                            _read_json(seed_out / ".graphify_build.json") is None or \
                            _graph_schema(seed_graph) is None or seed_meta.get("graphSchema") != _graph_schema(seed_graph):
                        raise BuildError("seed cache Graphify schema mismatch")
                    _assert_no_symlinks(seed_current / "source")
                    _assert_no_symlinks(seed_out)
                    baseline, baseline_meta = seed_current, seed_meta
                except (BuildError, OSError, TypeError, ValueError) as exc:
                    warnings.append("seed cache rejected: " + str(exc))
            baseline_ok = baseline is not None and baseline_meta is not None
            prior_files = (baseline_meta or {}).get("files", {}) if baseline_ok else {}
            changed_names = [name for name, (oid, mode) in entries.items()
                             if prior_files.get(name) != [oid, mode]]
            deleted_names = [name for name in prior_files if name not in entries]
            dependent_names: set[str] = set()
            if baseline_ok and baseline and (changed_names or deleted_names):
                affected_sources = set(changed_names) | set(deleted_names)
                dependent_names = _dependent_sources(
                    baseline / "out" / "graphify-out" / "graph.json",
                    affected_sources, set(entries),
                )
                if any(_is_resolution_input(name) for name in affected_sources):
                    dependent_names.update(
                        name for name in entries
                        if _is_js_ts_source(name) and name not in affected_sources
                    )
            is_initial = not baseline_ok
            mode = "initial" if is_initial else "incremental"
            gen_id = uuid.uuid4().hex
            staging = root / (".building-" + gen_id)
            if staging.exists() or staging.is_symlink():
                raise BuildError("staging path collision")
            staging.mkdir()
            try:
                source = staging / "source"
                out = staging / "out"
                if baseline_ok and baseline:
                    _assert_no_symlinks(baseline / "source")
                    _assert_no_symlinks(baseline / "out" / "graphify-out")
                    # Source blobs are immutable once committed. Hard links make
                    # warm snapshots cheap; changed files are replaced via a new
                    # inode and deletions unlink only this generation's name.
                    shutil.copytree(baseline / "source", source, copy_function=os.link)
                    shutil.copytree(baseline / "out" / "graphify-out", out / "graphify-out", copy_function=shutil.copy2)
                    _write_graph_root(out / "graphify-out", source)
                    if dependent_names:
                        manifest_path = out / "graphify-out" / "manifest.json"
                        manifest = _read_json(manifest_path)
                        if manifest is None:
                            raise BuildError("baseline Graphify manifest is missing or invalid")
                        for name in dependent_names:
                            manifest.pop(name, None)
                        _atomic_json(manifest_path, manifest)
                else:
                    source.mkdir()
                    out.mkdir()
                for name in deleted_names:
                    target = source / name
                    if target.is_symlink():
                        raise BuildError("symlink found in cached source")
                    if target.is_file():
                        target.unlink()
                    parent = target.parent
                    while parent != source and parent.exists():
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent
                for name in changed_names:
                    target = source / name
                    parent = target.parent
                    parent.mkdir(parents=True, exist_ok=True)
                    cursor = source
                    for part in PurePosixPath(name).parts[:-1]:
                        cursor = cursor / part
                        if cursor.is_symlink():
                            raise BuildError("symlink in cached source path")
                    data = _git(repo, "cat-file", "blob", entries[name][0], timeout=60)
                    temp = target.with_name("." + target.name + ".tmp-" + gen_id)
                    temp.write_bytes(data)
                    os.chmod(temp, 0o755 if entries[name][1] == "100755" else 0o644)
                    os.replace(temp, target)
                env = os.environ.copy()
                for key in list(env):
                    if key.startswith("GRAPHIFY_"):
                        env.pop(key, None)
                env.update({"GRAPHIFY_BACKEND": "none", "GRAPHIFY_QUERY_LOG_DISABLE": "1",
                            "GRAPHIFY_MAX_WORKERS": str(args.max_workers)})
                _run([executable, "extract", str(source), "--code-only", "--max-workers",
                      str(args.max_workers), "--out", str(out), "--no-cluster", "--no-viz"],
                     cwd=source, env=env, timeout=args.timeout_seconds, logs=root / "logs", label="extract")
                staged_output = out / "graphify-out"
                generated_graph = _read_json(staged_output / "graph.json")
                if generated_graph is None:
                    raise BuildError("Graphify extract produced no graph.json")
                if baseline_ok and baseline and changed_names:
                    followup_names = _newly_resolved_dependents(
                        baseline / "out" / "graphify-out" / "graph.json",
                        staged_output / "graph.json", set(changed_names), set(entries),
                        set(changed_names) | set(deleted_names) | dependent_names,
                    )
                    if followup_names:
                        manifest_path = staged_output / "manifest.json"
                        manifest = _read_json(manifest_path)
                        if manifest is None:
                            raise BuildError("updated Graphify manifest is missing or invalid")
                        for name in followup_names:
                            manifest.pop(name, None)
                        _atomic_json(manifest_path, manifest)
                        _run([executable, "extract", str(source), "--code-only", "--max-workers",
                              str(args.max_workers), "--out", str(out), "--no-cluster", "--no-viz"],
                             cwd=source, env=env, timeout=args.timeout_seconds,
                             logs=root / "logs", label="extract-followup")
                        dependent_names.update(followup_names)
                        if not (staged_output / "graph.json").is_file():
                            raise BuildError("Graphify follow-up produced no graph.json")
                _run([executable, "cluster-only", str(out), "--no-viz", "--no-label"],
                     cwd=source, env=env, timeout=min(args.timeout_seconds, 600),
                     logs=root / "logs", label="cluster")
                generated_graph = _read_json(staged_output / "graph.json")
                generated_schema = _graph_schema(generated_graph)
                if generated_graph is None or generated_schema is None:
                    raise BuildError("Graphify cluster-only produced no versioned graph.json")
                generations = root / "generations"
                generations.mkdir(exist_ok=True)
                final = generations / gen_id
                _write_graph_root(staged_output, final / "source")
                (staged_output / "graph.html").unlink(missing_ok=True)
                metadata = {"head": requested, "treeDigest": tree_digest,
                            "files": {k: [v[0], v[1]] for k, v in entries.items()},
                            "graphifyVersion": graphify_version,
                            "graphSchema": generated_schema,
                            "options": {"codeOnly": True, "maxWorkers": args.max_workers},
                            "affectedFiles": len(dependent_names)}
                _atomic_json(staging / "metadata.json", metadata)
                os.replace(staging, final)
                temp_link = root / (".current-" + gen_id)
                os.symlink("generations/" + gen_id, temp_link)
                os.replace(temp_link, root / "current")
                # Keep the prior generation for 24 hours so already-returned
                # immutable paths survive normal queued-agent runs. Keep at most
                # two newer generations regardless of age.
                now = time.time()
                generations_by_age = sorted(generations.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
                for index, old in enumerate(generations_by_age):
                    if old == final or old.is_symlink():
                        continue
                    if index >= 2 and now - old.stat().st_mtime > 24 * 60 * 60:
                        shutil.rmtree(old, ignore_errors=True)
                return _result("ready", graph=final / "out" / "graphify-out" / "graph.json",
                               head=requested, requested=requested, mode=mode,
                               changed=len(changed_names), deleted=len(deleted_names),
                               affected=len(dependent_names), warnings=warnings)
            finally:
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
        except Exception as exc:
            current = _current(root)
            meta = _read_json(current / "metadata.json") if current else None
            graph = current / "out" / "graphify-out" / "graph.json" if current and (current / "out" / "graphify-out" / "graph.json").is_file() else None
            return _result("failed", graph=graph, head=(meta or {}).get("head"),
                           requested=requested, reason=str(exc))


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_sigterm)
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--graphify", required=True)
    parser.add_argument("--seed-cache-dir")
    parser.add_argument("--timeout-seconds", type=float, default=1800)
    parser.add_argument("--max-workers", type=int, default=2)
    args = parser.parse_args()
    if args.timeout_seconds <= 0 or args.max_workers < 1:
        result = _result("failed", reason="invalid timeout or worker count")
    else:
        try:
            result = build(args)
        except Exception as exc:
            result = _result("failed", reason=str(exc))
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0 if result["status"] in ("ready", "unchanged") else 2 if result["status"] == "busy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
