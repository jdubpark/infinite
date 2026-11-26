#!/usr/bin/env python3
"""Run a repository command on an enrolled remote host."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import re
import select
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path


ALIAS_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
PRIVATE_COMPONENTS = {".ssh", ".docker", ".local"}
OMIT_COMPONENTS = PRIVATE_COMPONENTS | {
    ".cache",
    ".expo",
    ".gradle",
    ".next",
    ".npm",
    ".parcel-cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".turbo",
    ".venv",
    "__pycache__",
    "node_modules",
}
SECRET_NAMES = {
    ".gitconfig",
    ".npmrc",
    "credentials",
    "credentials.txt",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
}


def git(root: Path, *args: str, input_data: bytes | None = None, check: bool = True) -> bytes:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(root), *args],
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(message or f"git {' '.join(args)} failed")
    return result.stdout


def decode_path(value: bytes) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("repository paths must be valid UTF-8 for remote transfer") from exc


def safe_path(value: str) -> str:
    path = value.replace(os.sep, "/")
    if not path or path.startswith("/") or "\x00" in path:
        raise RuntimeError("repository contains an unsupported path")
    if any(part in ("", ".", "..", ".git") for part in path.split("/")):
        raise RuntimeError("repository contains an unsafe nested repository path")
    return path


def private_or_runtime_path(path: str, *, tracked: bool = False) -> bool:
    parts = path.split("/")
    name = parts[-1].lower()
    return (
        any(part in (PRIVATE_COMPONENTS if tracked else OMIT_COMPONENTS) for part in parts)
        or name == ".env"
        or (name.startswith(".env.") and name != ".env.example")
        or name in SECRET_NAMES
        or name.endswith((".pem", ".key", ".p12", ".pfx"))
    )


def approved_env_examples(root: Path) -> dict[str, str]:
    origin = git(root, "config", "--local", "--get", "remote.origin.url", check=False).rstrip(b"\n")
    if not origin:
        return {}
    key = "infiniteProject." + hashlib.sha256(origin).hexdigest() + ".envExample"
    records = git(root, "config", "--global", "-z", "--get-all", key, check=False)
    approved = {}
    for record in records.split(b"\0"):
        if not record:
            continue
        digest, separator, path = decode_path(record).partition(" ")
        if (not separator or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not re.fullmatch(r"\.env\.[A-Za-z0-9_.-]+[.-]example", Path(path).name)
                or any(part in PRIVATE_COMPONENTS for part in path.split("/"))):
            raise RuntimeError("invalid owner-approved environment example")
        path = safe_path(path)
        if path in approved and approved[path] != digest:
            raise RuntimeError("multiple approved digests for one environment example")
        approved[path] = digest
    return approved


def check_tracked_input(root: Path, path: str, mode: bytes, oid: bytes, approved: dict[str, str]) -> None:
    if not private_or_runtime_path(path, tracked=True):
        return
    if (path in approved and mode in (b"100644", b"100755")
            and hashlib.sha256(git(root, "cat-file", "blob", oid.decode("ascii"))).hexdigest() == approved[path]):
        return
    raise RuntimeError("tracked private input or changed environment example cannot be transferred")


def config_value(root: Path, key: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(root), "config", "--bool", "--get", key],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode == 1:
        return None
    if result.returncode:
        raise RuntimeError(f"could not read Git setting {key}")
    return result.stdout.decode("ascii", "strict").strip().lower()


def validate_git_state(root: Path, index_entries: list[dict[str, object]], extra_paths: list[str]) -> None:
    if config_value(root, "core.autocrlf") not in (None, "false"):
        raise RuntimeError("core.autocrlf must be unset or false for exact snapshot parity")
    if config_value(root, "core.filemode") == "false":
        raise RuntimeError("core.filemode=false cannot preserve working-tree executable bits")
    if config_value(root, "core.symlinks") == "false":
        raise RuntimeError("core.symlinks=false cannot preserve working-tree symlinks")
    if config_value(root, "core.sparseCheckout") == "true":
        raise RuntimeError("sparse checkout is unsupported")

    flags = git(root, "ls-files", "-v", "-z").split(b"\0")
    for record in flags:
        if record and record[:1].decode("ascii", "strict").islower():
            raise RuntimeError("assume-unchanged index entries are unsupported")
        if record and record[:1] == b"S":
            raise RuntimeError("sparse checkout entries are unsupported")

    paths = [str(entry["path"]).encode("utf-8") for entry in index_entries]
    indexed = {str(entry["path"]) for entry in index_entries}
    paths.extend(path.encode("utf-8") for path in extra_paths if path not in indexed)
    if paths:
        attributes = git(root, "check-attr", "-z", "filter", "--stdin", input_data=b"\0".join(paths) + b"\0")
        fields = attributes.split(b"\0")
        for index in range(0, len(fields) - 2, 3):
            value = fields[index + 2]
            if value not in (b"unspecified", b"unset"):
                raise RuntimeError("Git clean/smudge filters are unsupported")


def index_entries(root: Path, approved: dict[str, str]) -> list[dict[str, object]]:
    raw = git(root, "ls-files", "--stage", "-z")
    entries: list[dict[str, object]] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        try:
            header, raw_path = item.split(b"\t", 1)
            mode, oid, stage = header.split(b" ", 2)
        except ValueError as exc:
            raise RuntimeError("git returned malformed index data") from exc
        path = safe_path(decode_path(raw_path))
        if stage != b"0":
            raise RuntimeError("unmerged index entries are unsupported")
        mode_text = mode.decode("ascii", "strict")
        if mode_text not in {"100644", "100755", "120000"}:
            raise RuntimeError("submodules and unsupported index modes cannot be transferred")
        if not oid.strip(b"0"):
            raise RuntimeError("intent-to-add index entries are unsupported")
        check_tracked_input(root, path, mode, oid, approved)
        entries.append({"mode": mode_text, "oid": oid.decode("ascii"), "stage": 0, "path": path})
    return entries


def validate_head_tree(root: Path, base_oid: str, approved: dict[str, str]) -> None:
    for item in git(root, "ls-tree", "-r", "-t", "-z", base_oid).split(b"\0"):
        if not item:
            continue
        try:
            metadata, raw_path = item.split(b"\t", 1)
            mode, object_type, oid = metadata.split(b" ", 2)
        except ValueError as exc:
            raise RuntimeError("git returned malformed HEAD tree data") from exc
        path = safe_path(decode_path(raw_path))
        if mode == b"160000" or object_type == b"commit":
            raise RuntimeError("submodules are unsupported")
        check_tracked_input(root, path, mode, oid, approved)


def status_entries(root: Path) -> tuple[list[dict[str, str]], int]:
    raw = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    rows = raw.split(b"\0")
    entries: list[dict[str, str]] = []
    omitted = 0
    index = 0
    while index < len(rows) and rows[index]:
        row = rows[index]
        if len(row) < 4 or row[2:3] != b" ":
            raise RuntimeError("git returned malformed status data")
        xy = row[:2].decode("ascii")
        path = safe_path(decode_path(row[3:]))
        item = {"xy": xy, "path": path}
        index += 1
        if "R" in xy or "C" in xy:
            if index >= len(rows) or not rows[index]:
                raise RuntimeError("git returned malformed rename status data")
            item["original_path"] = safe_path(decode_path(rows[index]))
            index += 1
        if xy == "??" and private_or_runtime_path(path):
            omitted += 1
        else:
            entries.append(item)
    return entries, omitted


def validate_link(root: Path, relative: str, target: str) -> None:
    if os.path.isabs(target):
        raise RuntimeError(f"absolute symlinks are unsupported: {relative}")
    resolved = (root / relative).parent.joinpath(target).resolve(strict=False)
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError(f"external symlinks are unsupported: {relative}") from exc


def file_record(root: Path, relative: str) -> tuple[dict[str, object], tarfile.TarInfo, object | None]:
    candidate = root / relative
    info = candidate.lstat()
    member = tarfile.TarInfo(relative)
    member.mode = stat.S_IMODE(info.st_mode)
    member.mtime = 0
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    executable = bool(info.st_mode & 0o111)
    if stat.S_ISLNK(info.st_mode):
        target = os.readlink(candidate)
        validate_link(root, relative, target)
        try:
            target_bytes = target.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise RuntimeError("symlink targets must be valid UTF-8") from exc
        member.type = tarfile.SYMTYPE
        member.linkname = target
        record = {"sha256": hashlib.sha256(target_bytes).hexdigest(), "type": "symlink", "executable": executable}
        return record, member, None
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f"unsupported file type: {relative}")
    member.size = info.st_size
    with candidate.open("rb") as source:
        content = source.read()
    record = {"sha256": hashlib.sha256(content).hexdigest(), "type": "file", "executable": executable}
    return record, member, content


def working_tree_archive(root: Path, entries: list[dict[str, object]], approved: dict[str, str]) -> tuple[bytes, dict[str, dict[str, object]], int]:
    tracked = {str(entry["path"]) for entry in entries}
    untracked_raw = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    untracked: list[str] = []
    omitted = 0
    for item in untracked_raw.split(b"\0"):
        if not item:
            continue
        path = safe_path(decode_path(item))
        try:
            info = (root / path).lstat()
        except FileNotFoundError as exc:
            raise RuntimeError("a nonignored untracked path changed during snapshot capture") from exc
        if stat.S_ISDIR(info.st_mode):
            raise RuntimeError("nested repositories and untracked directories are unsupported")
        if private_or_runtime_path(path):
            omitted += 1
            continue
        untracked.append(path)

    files: dict[str, dict[str, object]] = {}
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(tracked.union(untracked)):
            candidate = root / path
            if candidate.parent.resolve() != candidate.parent:
                raise RuntimeError(f"source path traverses a symlink: {path}")
            try:
                candidate.lstat()
            except (FileNotFoundError, NotADirectoryError):
                if path in tracked:
                    continue
                raise RuntimeError("a nonignored untracked path changed during snapshot capture")
            if candidate.is_dir() and not candidate.is_symlink() and path in tracked:
                continue
            if path not in tracked and private_or_runtime_path(path):
                continue
            record, member, content = file_record(root, path)
            if path in approved and (record["type"] != "file" or record["sha256"] != approved[path]):
                raise RuntimeError("working environment example differs from its owner-approved digest")
            files[path] = record
            if member.issym():
                archive.addfile(member)
            else:
                archive.addfile(member, io.BytesIO(content or b""))
    return data.getvalue(), files, omitted


def source_pack(root: Path, base_oid: str, entries: list[dict[str, object]]) -> bytes:
    tree_objects = git(root, "ls-tree", "-r", "-t", "--format=%(objectname)", base_oid)
    head_tree = git(root, "rev-parse", f"{base_oid}^{{tree}}").decode("ascii").strip()
    object_ids = {base_oid, head_tree, *(str(entry["oid"]) for entry in entries)}
    object_ids.update(line.decode("ascii") for line in tree_objects.splitlines() if line)
    result = subprocess.run(
        ["git", "-C", str(root), "pack-objects", "--stdout"],
        input=("\n".join(sorted(object_ids)) + "\n").encode("ascii"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or "could not create a shallow source pack")
    return result.stdout


def package_manager_pin(directory: Path) -> dict[str, object] | None:
    node_path = directory / ".nvmrc"
    package_path = directory / "package.json"
    node_exists = node_path.is_file()
    package_exists = package_path.is_file()
    if not node_exists and not package_exists:
        return None
    if not package_exists:
        raise RuntimeError("package.json is missing for the configured Node version")
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("package.json is malformed") from exc
    manager = package.get("packageManager") if isinstance(package, dict) else None
    if not node_exists:
        if manager is None:
            return None
        raise RuntimeError(".nvmrc is missing for the configured npm version")
    if not isinstance(manager, str):
        raise RuntimeError("package.json must declare packageManager as npm@<version>")
    try:
        node = node_path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(".nvmrc is unreadable") from exc
    node = node[1:] if node.startswith("v") else node
    match = re.fullmatch(r"npm@([0-9]+\.[0-9]+\.[0-9]+)", manager)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", node) or not match:
        raise RuntimeError(".nvmrc or packageManager has an unsupported version format")
    return {"node": node, "npm": match.group(1)}


def runner_profile(root: Path) -> object:
    profile = root / "scripts/cloud-check/linux-runner.json"
    if not profile.is_file():
        profile = Path(__file__).resolve().parent / "cloud-check/linux-runner.json"
    return json.loads(profile.read_text(encoding="utf-8"))


def toolchain_pin(root: Path, mode: str = "npm") -> bytes:
    if mode != "npm":
        pin = {"mode": mode, "runner": runner_profile(root)}
        return (json.dumps(pin, sort_keys=True, separators=(",", ":")) + "\n").encode()
    pin = package_manager_pin(root)
    if pin is None:
        launcher = Path(__file__).resolve().parent.parent
        for directory in (launcher, *launcher.parents):
            if not (directory / ".nvmrc").exists() and not (directory / "package.json").exists():
                continue
            pin = package_manager_pin(directory)
            if pin is not None:
                break
        if pin is None:
            raise RuntimeError("caller and launcher toolchain pins are missing")
    pin["runner"] = runner_profile(root)
    return (json.dumps(pin, sort_keys=True, separators=(",", ":")) + "\n").encode()


def capture(root: Path, cwd: Path, argv: list[str], worker: Path, project: Path, mode: str) -> dict[str, bytes]:
    base_oid = git(root, "rev-parse", "HEAD").decode("ascii").strip()
    head_ref = git(root, "symbolic-ref", "-q", "HEAD", check=False).decode().strip() or None
    toolchain = toolchain_pin(root, mode)
    if git(root, "ls-files", "-u", "-z"):
        raise RuntimeError("unmerged paths are unsupported")
    approved = approved_env_examples(root)
    validate_head_tree(root, base_oid, approved)
    entries = index_entries(root, approved)
    status, omitted_status = status_entries(root)
    pack = source_pack(root, base_oid, entries)
    archive, files, omitted_files = working_tree_archive(root, entries, approved)
    validate_git_state(root, entries, list(files))
    if omitted_status != omitted_files:
        raise RuntimeError("private untracked paths changed during snapshot capture")

    payload: dict[str, bytes] = {
        "worker.py": worker.read_bytes(),
        "project.py": project.read_bytes(),
        "toolchain.json": toolchain,
        "source.pack": pack,
        "working-tree.tar": archive,
    }
    hashes = {name: hashlib.sha256(value).hexdigest() for name, value in payload.items()}
    metadata = {
        "base_oid": base_oid,
        "head_ref": head_ref,
        "cwd": cwd.relative_to(root).as_posix() or ".",
        "argv": argv,
        "status": {"format": "porcelain-v1", "entries": status, "omitted_untracked": omitted_files},
        "index": entries,
        "files": files,
        "sha256": hashes,
    }
    payload["snapshot.json"] = (json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n").encode()

    after_oid = git(root, "rev-parse", "HEAD").decode("ascii").strip()
    after_ref = git(root, "symbolic-ref", "-q", "HEAD", check=False).decode().strip() or None
    after_entries = index_entries(root, approved)
    after_status, after_omitted_status = status_entries(root)
    after_archive, after_files, after_omitted_files = working_tree_archive(root, after_entries, approved)
    after_toolchain = toolchain_pin(root, mode)
    if (base_oid, entries, status, omitted_files, archive, files) != (
        after_oid,
        after_entries,
        after_status,
        after_omitted_status,
        after_archive,
        after_files,
    ) or after_ref != head_ref or after_omitted_files != omitted_files or after_toolchain != toolchain:
        raise RuntimeError("working tree changed during snapshot capture; retry after edits stop")
    return payload


def outer_archive(payload: dict[str, bytes]) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz", compresslevel=1, format=tarfile.PAX_FORMAT) as archive:
        for name, content in payload.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o600
            info.mtime = 0
            archive.addfile(info, io.BytesIO(content))
    return data.getvalue()



READY_LINE = b"INFINITE-CHECK-READY-v2\n"
HANDSHAKE_TIMEOUT_SECONDS = 30


def stop_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if process.poll() is not None:
        return
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def dispatch(transport_argv: list[str], archive: bytes, envelope: str, receipt: dict) -> int:
    process = subprocess.Popen(
        transport_argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    assert process.stdin is not None and process.stdout is not None
    descriptor = process.stdout.fileno()
    prefix = bytearray()
    try:
        deadline = time.monotonic() + HANDSHAKE_TIMEOUT_SECONDS
        while b"\n" not in prefix:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print("cloud-check: runner readiness handshake timed out", file=sys.stderr, flush=True)
                process.stdin.close()
                stop_process_group(process)
                return 2
            readable, _, _ = select.select([descriptor], [], [], remaining)
            if not readable:
                continue
            chunk = os.read(descriptor, 4096)
            if not chunk:
                sys.stdout.buffer.write(prefix)
                sys.stdout.buffer.flush()
                process.stdin.close()
                stop_process_group(process)
                code = process.wait()
                if code == 0:
                    print("cloud-check: runner closed before readiness handshake", file=sys.stderr, flush=True)
                    return 2
                return code
            prefix.extend(chunk)
            if len(prefix) > 4096:
                sys.stdout.buffer.write(prefix)
                sys.stdout.buffer.flush()
                print("cloud-check: invalid runner readiness handshake", file=sys.stderr, flush=True)
                process.stdin.close()
                stop_process_group(process)
                return 2
        line, separator, trailing = bytes(prefix).partition(b"\n")
        line += separator
        if line != READY_LINE:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            print("cloud-check: invalid runner readiness handshake", file=sys.stderr, flush=True)
            process.stdin.close()
            stop_process_group(process)
            return 2

        try:
            process.stdin.write(len(archive).to_bytes(8, "big"))
            process.stdin.write(archive)
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        if trailing:
            sys.stdout.buffer.write(trailing)
            sys.stdout.buffer.flush()
        tail = trailing[-8192:]
        while True:
            readable, _, _ = select.select([descriptor], [], [], 0.25)
            if readable:
                chunk = os.read(descriptor, 65536)
                if not chunk:
                    break
                tail = (tail + chunk)[-8192:]
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            elif process.poll() is not None:
                chunk = os.read(descriptor, 65536)
                if not chunk:
                    break
                tail = (tail + chunk)[-8192:]
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        code = process.wait()
        process.stdin.close()
        lines = tail.splitlines()
        prefix = b"CLOUD-CHECK-RECEIPT "
        if lines and lines[-1].startswith(prefix):
            observed = json.loads(lines[-1][len(prefix):])
            if isinstance(observed, dict) and observed.get("envelope") == envelope and observed.get("exit") == code:
                receipt.update(observed)
        if code == 0 and not receipt:
            print("cloud-check: successful transport returned no matching test receipt", file=sys.stderr)
            return 2
        return code
    except BaseException:
        stop_process_group(process)
        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        raise


def config_values(root: Path, *scope: str, key: str) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "config", *scope, "--get-all", key],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(f"could not read Git setting {key}")
    values = [line.decode("utf-8", "strict") for line in result.stdout.splitlines()]
    if any(not ALIAS_RE.fullmatch(value) for value in values):
        raise RuntimeError(f"Git setting {key} contains an invalid SSH alias")
    return list(dict.fromkeys(values))


def origin_url(root: Path) -> bytes | None:
    result = subprocess.run(
        ["git", "-C", str(root), "config", "--local", "--get", "remote.origin.url"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode == 1:
        return None
    if result.returncode:
        raise RuntimeError("could not read local Git origin")
    return result.stdout.rstrip(b"\n")


def common_dir_hash(root: Path) -> str:
    value = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").decode("utf-8", "strict").strip()
    return hashlib.sha256(os.fsencode(str(Path(value).resolve(strict=True)))).hexdigest()


def origin_key(origin: bytes) -> str:
    return "infiniteProject." + hashlib.sha256(origin).hexdigest() + ".verifyHost"


def common_dir_key(common_hash: str) -> str:
    return "infiniteWorkspace." + common_hash + ".verifyHost"


def runtime_policy(runtime: Path):
    path = runtime / "workspace_policy.py"
    spec = importlib.util.spec_from_file_location("infinite_cloud_check_workspace_policy", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("trusted workspace policy module is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.WorkspacePolicy.load()


def saved_aliases(root: Path, origin: bytes | None, common_hash: str) -> dict[str, str]:
    key = origin_key(origin) if origin is not None else common_dir_key(common_hash)
    binding = hashlib.sha256(origin).hexdigest() if origin is not None else common_hash
    return {alias: binding for alias in config_values(root, "--global", key=key)}


def legacy_aliases(root: Path) -> list[str]:
    return config_values(root, key="infinite.verifyHost")


def workspace_marker() -> str | None:
    marker_path = Path("/etc/infinite-check-workspace")
    try:
        descriptor = os.open(marker_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RuntimeError("host workspace marker cannot be inspected safely") from exc
    with os.fdopen(descriptor, "rb") as marker:
        info = os.fstat(marker.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("host workspace marker is not administrator-owned")
        value = marker.read(66)
    try:
        text = value.decode("ascii").removesuffix("\n")
    except UnicodeDecodeError as exc:
        raise RuntimeError("host workspace marker has an invalid identity") from exc
    if not ALIAS_RE.fullmatch(text):
        raise RuntimeError("host workspace marker has an invalid identity")
    return text


def admitted_npm_checkout(root: Path, scope: str | None) -> bool:
    handle = os.environ.get("INFINITE_CHECK_LEASE", "")
    if sys.platform != "linux" or not re.fullmatch(r"[1-9][0-9]*/[0-9]+", handle):
        return False
    owner, descriptor = (int(part) for part in handle.split("/"))
    try:
        parent = os.getppid()
        while parent != owner:
            if parent <= 1:
                return False
            fields = Path(f"/proc/{parent}/stat").read_bytes().rsplit(b") ", 1)[1].split()
            parent = int(fields[1])
        with open(f"/proc/{owner}/fd/{descriptor}", "rb") as lease:
            required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SEAL
            if fcntl.fcntl(lease, fcntl.F_GET_SEALS) & required != required:
                return False
            return json.loads(lease.read(8192)) == {
                "checkout": str(root), "run": os.environ.get("INFINITE_CHECK_RUN_ID"), "workspace": scope or "-"
            }
    except (OSError, IndexError, ValueError, UnicodeError):
        return False


def enroll(root: Path, aliases: list[str], policy, scope: str | None,
           origin: bytes | None, common_hash: str) -> None:
    if not aliases or any(not ALIAS_RE.fullmatch(alias) for alias in aliases):
        raise RuntimeError("--enroll requires valid SSH aliases")
    for alias in aliases:
        policy.allowed_aliases(scope, [alias], alias, enrolling=True)
    if origin is not None:
        key, scope_args = origin_key(origin), ["--global"]
    elif scope is not None:
        key, scope_args = common_dir_key(common_hash), ["--global"]
    else:
        key, scope_args = "infinite.verifyHost", ["--local"]
    existing = config_values(root, *scope_args, key=key)
    for alias in aliases:
        if alias not in existing:
            subprocess.run(["git", "-C", str(root), "config", *scope_args, "--add", key, alias], check=True)
            existing.append(alias)
    if scope is not None and key != "infinite.verifyHost":
        if key != common_dir_key(common_hash):
            prior = config_values(root, "--global", key=common_dir_key(common_hash))
            for alias in aliases:
                if alias not in prior:
                    subprocess.run(["git", "-C", str(root), "config", "--global", "--add", common_dir_key(common_hash), alias], check=True)
        local = legacy_aliases(root)
        for alias in aliases:
            if alias not in local:
                subprocess.run(["git", "-C", str(root), "config", "--local", "--add", "infinite.verifyHost", alias], check=True)
    print(f"Enrolled {len(aliases)} SSH alias(es)")


def advertised_tip(root: Path, remote: str, branch: str) -> str:
    remotes = git(root, "remote").decode("utf-8", "strict").splitlines()
    if remote not in remotes:
        raise RuntimeError("--require-tip needs an existing named Git remote")
    if git(root, "check-ref-format", f"refs/remotes/{remote}", check=False):
        raise RuntimeError("--require-tip needs a valid named Git remote")
    check = subprocess.run(["git", "-C", str(root), "check-ref-format", "--branch", branch], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if check.returncode:
        raise RuntimeError("--require-tip needs a valid branch name")
    ref = "refs/heads/" + branch
    result = subprocess.run(["git", "-C", str(root), "ls-remote", "--exit-code", "--", remote, ref], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError("STALE required remote tip is unavailable")
    try:
        oid, found_ref = result.stdout.decode("ascii").strip().split("\t", 1)
    except ValueError as exc:
        raise RuntimeError("STALE required remote tip is unavailable") from exc
    if found_ref != ref or not re.fullmatch(r"[0-9a-fA-F]{40,64}", oid):
        raise RuntimeError("STALE required remote tip is unavailable")
    return oid.lower()


def local_snapshot_matches(root: Path, payload: dict[str, bytes]) -> bool:
    metadata = json.loads(payload["snapshot.json"])
    head = git(root, "rev-parse", "HEAD").decode("ascii").strip()
    ref = git(root, "symbolic-ref", "-q", "HEAD", check=False).decode().strip() or None
    approved = approved_env_examples(root)
    entries = index_entries(root, approved)
    status, omitted_status = status_entries(root)
    archive, files, omitted_files = working_tree_archive(root, entries, approved)
    validate_git_state(root, entries, list(files))
    return (
        head == metadata["base_oid"] and ref == metadata["head_ref"]
        and entries == metadata["index"] and status == metadata["status"]["entries"]
        and omitted_status == metadata["status"]["omitted_untracked"]
        and archive == payload["working-tree.tar"] and files == metadata["files"]
        and omitted_files == metadata["status"]["omitted_untracked"]
    )


def standing_runner() -> bool:
    def administrator_managed(path: Path) -> bool:
        try:
            info = path.lstat()
        except OSError:
            return False
        return stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022

    return administrator_managed(Path("/etc/infinite-cloud-runner")) or (
        sys.platform == "linux" and Path("/etc/infinite").is_dir()
        and administrator_managed(Path("/etc/systemd/system/infinite.service"))
    )


def run_standing_build(root: Path, script: str, event: str, argv: list[str]) -> None:
    pins = json.loads(toolchain_pin(root))
    for tool, expected in (("node", "v" + pins["node"]), ("npm", pins["npm"])):
        actual = subprocess.check_output([tool, "--version"], text=True).strip()
        if actual != expected:
            raise RuntimeError(f"{tool} version mismatch: expected {expected}, got {actual}")
    base = git(root, "rev-parse", "HEAD").decode("ascii").strip()
    lock = hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest()
    print(f"CLOUD BUILD base={base} lock={lock} node={pins['node']} npm={pins['npm']}", flush=True)
    os.execvp("sh", ["sh", "-c", script + ' "$@"', event, *argv])


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a command on an enrolled Infinite host")
    parser.add_argument("--runner", help="enrolled SSH alias")
    parser.add_argument("--also-on", help="also run the same snapshot on a second enrolled SSH alias")
    parser.add_argument("--enroll", action="append", default=[], metavar="ALIAS", help="remember an SSH alias for this repository")
    parser.add_argument("--require-tip", nargs=2, metavar=("REMOTE", "BRANCH"), help="require the captured HEAD to match an advertised remote branch")
    parser.add_argument("--project-command", action="store_true", help="run raw host command arguments without npm")
    parser.add_argument("--npm-script", help=argparse.SUPPRESS)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.command
    if argv and argv[0] == "--":
        argv = argv[1:]
    if any("\x00" in item for item in argv):
        parser.error("command arguments cannot contain NUL")

    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip()).resolve()
        cwd = Path.cwd().resolve()
        cwd.relative_to(root)
        host_scope = workspace_marker()
        if args.npm_script is not None and not args.runner and not args.also_on and admitted_npm_checkout(root, host_scope):
            event = os.environ.get("npm_lifecycle_event")
            if not event:
                raise RuntimeError("npm dispatch requires a lifecycle event")
            os.execvp("sh", ["sh", "-c", args.npm_script + ' "$@"', event, *argv])
        runtime = Path(__file__).resolve().parent / "cloud-check"
        policy = runtime_policy(runtime)
        origin = origin_url(root)
        origin_hash = hashlib.sha256(origin).hexdigest() if origin is not None else None
        common_hash = common_dir_hash(root)
        trusted_saved = saved_aliases(root, origin, common_hash)
        directory_aliases = config_values(root, "--global", key=common_dir_key(common_hash))
        if args.enroll:
            if argv or args.runner or args.also_on or args.require_tip or args.project_command or args.npm_script:
                raise RuntimeError("--enroll is used by itself, outside command and npm jobs")
            scope = policy.scope_for(root, origin_hash, trusted_saved, directory_aliases=directory_aliases, enrolling=True)
            enroll(root, args.enroll, policy, scope, origin, common_hash)
            return 0
        if args.also_on and (args.also_on == args.runner or args.npm_script is not None):
            raise RuntimeError("--also-on requires a distinct second alias and cannot run in an npm lifecycle")
        if args.project_command and (args.npm_script is not None or not argv):
            raise RuntimeError("--project-command requires nonempty arguments and cannot combine with npm dispatch")
        if args.project_command:
            mode = "command"
        elif (root / ".infinite/check.json").is_file() and args.npm_script is None:
            mode = "compose"
        else:
            mode = "npm"
            if not argv and args.npm_script is None:
                argv = ["npm", "run", "check"]
        bootstrap = (runtime / "bootstrap.py").read_text(encoding="utf-8")
        worker = runtime / "worker.py"
        project = runtime / "project.py"
        if not project.is_file():
            raise RuntimeError("cloud-check project runner is missing")
        scope = policy.scope_for(root, origin_hash, trusted_saved, directory_aliases=directory_aliases)
        on_runner = not args.runner and not args.also_on and standing_runner()
        if sys.platform != "linux" and host_scope is not None:
            raise RuntimeError("unsupported workspace test platform")
        if (on_runner and scope != host_scope) or (host_scope is not None and scope != host_scope):
            raise RuntimeError("repository enrollment does not match the runner workspace")
        expected_workspace = scope or "-"
        if args.npm_script is not None:
            event = os.environ.get("npm_lifecycle_event")
            if not event or args.runner:
                raise RuntimeError("npm dispatch requires a lifecycle event")
            if on_runner and event in {"build", "desktop:build", "dev", "web", "start", "android", "ios", "export:android", "export:ios"}:
                run_standing_build(root, args.npm_script, event, argv)
            argv = ["npm", "run", event, "--", *argv]
        if on_runner:
            transports = [("standing", [sys.executable, "-c", bootstrap, expected_workspace])]
        else:
            candidates = None if scope is not None else list(dict.fromkeys([*trusted_saved, *legacy_aliases(root)]))
            eligible = policy.allowed_aliases(scope, candidates, args.runner)
            if not eligible:
                raise RuntimeError("no approved cloud-check SSH aliases are configured")
            targets = [eligible[0]]
            if args.also_on:
                if args.also_on == targets[0]:
                    raise RuntimeError("--also-on must name a distinct enrolled SSH alias")
                targets.extend(policy.allowed_aliases(scope, candidates, args.also_on))
            remote_command = "python3 -c " + shlex.quote(bootstrap) + " " + shlex.quote(expected_workspace)
            options = ["BatchMode=yes", "ConnectTimeout=90", "ServerAliveInterval=30", "ServerAliveCountMax=3",
                       "StrictHostKeyChecking=yes", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes",
                       "PermitLocalCommand=no", "RequestTTY=no", "RemoteCommand=none", "ControlPath=none"]
            ssh = ["ssh", "-T", *(item for option in options for item in ("-o", option))]
            transports = [(alias, [*ssh, alias, remote_command]) for alias in targets]

        payload = capture(root, cwd, argv, worker, project, mode)
        if origin_url(root) != origin or common_dir_hash(root) != common_hash:
            raise RuntimeError("STALE repository identity changed before transfer")
        metadata = json.loads(payload["snapshot.json"])
        tip = advertised_tip(root, *args.require_tip) if args.require_tip else None
        if tip is not None and tip != metadata["base_oid"]:
            print("STALE required remote tip differs from captured HEAD", file=sys.stderr, flush=True)
            return 3
        archive = outer_archive(payload)
        envelope = hashlib.sha256(payload["snapshot.json"]).hexdigest()
        digest = hashlib.sha256(archive).hexdigest()
        results = []
        for alias, transport in transports:
            print(f"Dispatch to {alias} (archive SHA-256 {digest})", file=sys.stderr, flush=True)
            receipt = {}
            code = dispatch(transport, archive, envelope, receipt)
            results.append({"runner": alias, "exit": code, "receipt": receipt})
            print(f"RUNNER {alias} exit={code}", flush=True)

        try:
            current = origin_url(root) == origin and common_dir_hash(root) == common_hash and local_snapshot_matches(root, payload)
            if tip is not None:
                current = current and advertised_tip(root, *args.require_tip) == tip
        except (OSError, RuntimeError, UnicodeError, ValueError):
            current = False
        code = next((job["exit"] for job in results if job["exit"] != 0), 0)
        if not current:
            print("STALE local worktree or required remote tip changed", file=sys.stderr, flush=True)
            code = code or 3
        else:
            print("CURRENT captured snapshot still matches the local worktree", flush=True)
        comparison = None
        if len(results) == 2 and current:
            comparison = "PARITY" if mode == "compose" else "REPLAY"
            if code == 0 and results[0]["receipt"] != results[1]["receipt"]:
                code = 4
                print("cloud-check: replay receipts differ across runners", file=sys.stderr, flush=True)
            verdict = "PASS" if code == 0 else "FAIL"
            print(f"{comparison} {verdict} runners={results[0]['runner']},{results[1]['runner']}", flush=True)

        state = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
        project_key = origin_hash or common_hash
        owner_dir = state / scope if scope else state / "infinite-check" / "projects" / project_key
        directory = owner_dir / "cloud-check/receipts"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        record = {"version": 1, "workspace": scope, "project": project_key, "base": metadata["base_oid"],
                  "archive": digest, "envelope": envelope, "requiredTip": tip, "current": current,
                  "worktreeChanges": len(metadata["status"]["entries"]), "omittedPrivate": metadata["status"]["omitted_untracked"],
                  "comparison": comparison, "runs": results, "exit": code}
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".run-", suffix=".tmp", delete=False) as temp:
            json.dump(record, temp, sort_keys=True)
            temp.write("\n")
        receipt_path = directory / (Path(temp.name).stem.lstrip(".") + ".json")
        os.replace(temp.name, receipt_path)
        print(f"RECEIPT {receipt_path}", flush=True)
        return code
    except KeyboardInterrupt:
        print("Cloud check interrupted", file=sys.stderr)
        return 130
    except (OSError, RuntimeError, UnicodeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"cloud-check: {exc}", file=sys.stderr)
        return 3 if str(exc).startswith("STALE ") else 2


if __name__ == "__main__":
    raise SystemExit(main())
