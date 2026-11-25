#!/usr/bin/env python3
"""Run a repository command on an enrolled remote host."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tarfile
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


def index_entries(root: Path) -> list[dict[str, object]]:
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
        if private_or_runtime_path(path, tracked=True):
            raise RuntimeError("tracked private runtime, cache, or credential paths cannot be transferred")
        entries.append({"mode": mode_text, "oid": oid.decode("ascii"), "stage": 0, "path": path})
    return entries


def validate_head_tree(root: Path, base_oid: str) -> None:
    for item in git(root, "ls-tree", "-r", "-t", "-z", base_oid).split(b"\0"):
        if not item:
            continue
        try:
            metadata, raw_path = item.split(b"\t", 1)
            mode, object_type, _oid = metadata.split(b" ", 2)
        except ValueError as exc:
            raise RuntimeError("git returned malformed HEAD tree data") from exc
        path = safe_path(decode_path(raw_path))
        if mode == b"160000" or object_type == b"commit":
            raise RuntimeError("submodules are unsupported")
        if private_or_runtime_path(path, tracked=True):
            raise RuntimeError("HEAD contains a tracked private runtime, cache, or credential path")


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


def working_tree_archive(root: Path, entries: list[dict[str, object]]) -> tuple[bytes, dict[str, dict[str, object]], int]:
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
    return {"platforms": ["darwin", "linux"], "node": node, "npm": match.group(1)}


def toolchain_pin(root: Path) -> bytes:
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
    return (json.dumps(pin, sort_keys=True, separators=(",", ":")) + "\n").encode()


def capture(root: Path, cwd: Path, argv: list[str], worker: Path) -> dict[str, bytes]:
    base_oid = git(root, "rev-parse", "HEAD").decode("ascii").strip()
    head_ref = git(root, "symbolic-ref", "-q", "HEAD", check=False).decode().strip() or None
    toolchain = toolchain_pin(root)
    if git(root, "ls-files", "-u", "-z"):
        raise RuntimeError("unmerged paths are unsupported")
    validate_head_tree(root, base_oid)
    entries = index_entries(root)
    status, omitted_status = status_entries(root)
    pack = source_pack(root, base_oid, entries)
    archive, files, omitted_files = working_tree_archive(root, entries)
    validate_git_state(root, entries, list(files))
    if omitted_status != omitted_files:
        raise RuntimeError("private untracked paths changed during snapshot capture")

    payload: dict[str, bytes] = {
        "worker.py": worker.read_bytes(),
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
    after_entries = index_entries(root)
    after_status, after_omitted_status = status_entries(root)
    after_archive, after_files, after_omitted_files = working_tree_archive(root, after_entries)
    after_toolchain = toolchain_pin(root)
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



def dispatch(transport_argv: list[str], archive: bytes) -> int:
    process = subprocess.Popen(
        transport_argv,
        stdin=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        process.stdin.write(len(archive).to_bytes(8, "big") + archive)
        process.stdin.flush()
        code = process.wait()
    except (BrokenPipeError, OSError):
        code = process.wait()
    except BaseException:
        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        raise
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    return code


def enrolled_aliases(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "config", "--get-all", "infinite.verifyHost"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("could not read enrolled SSH aliases from Git configuration")
    aliases = [line.decode("utf-8", "strict") for line in result.stdout.splitlines()]
    if not aliases or any(not ALIAS_RE.fullmatch(alias) for alias in aliases):
        raise RuntimeError("no valid infinite.verifyHost SSH aliases are configured")
    return list(dict.fromkeys(aliases))


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
    parser.add_argument("--npm-script", help=argparse.SUPPRESS)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.command
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv and args.npm_script is None:
        argv = ["npm", "run", "check"]
    if any("\x00" in item for item in argv):
        parser.error("command arguments cannot contain NUL")

    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip()).resolve()
        cwd = Path.cwd().resolve()
        cwd.relative_to(root)
        runtime = Path(__file__).resolve().parent / "cloud-check"
        bootstrap = (runtime / "bootstrap.py").read_text(encoding="utf-8")
        worker = runtime / "worker.py"
        if args.npm_script is not None:
            event = os.environ.get("npm_lifecycle_event")
            if not event or args.runner:
                raise RuntimeError("npm dispatch requires a lifecycle event")
            on_runner = standing_runner()
            if on_runner and event in {"build", "desktop:build", "dev", "web", "start", "android", "ios", "export:android", "export:ios"}:
                run_standing_build(root, args.npm_script, event, argv)
            argv = ["npm", "run", event, "--", *argv]
            if on_runner:
                archive = outer_archive(capture(root, cwd, argv, worker))
                return dispatch([sys.executable, "-c", bootstrap], archive)
        aliases = enrolled_aliases(root)
        if args.runner:
            if not ALIAS_RE.fullmatch(args.runner) or args.runner not in aliases:
                raise RuntimeError("--runner must name a configured infinite.verifyHost alias")
            alias = args.runner
        else:
            alias = aliases[0]

        if not worker.is_file():
            raise RuntimeError("cloud-check worker files are missing")
        payload = capture(root, cwd, argv, worker)
        archive = outer_archive(payload)
        digest = hashlib.sha256(archive).hexdigest()
        print(f"Sending snapshot to {alias} (SHA-256 {digest})", file=sys.stderr, flush=True)
        remote_command = "python3 -c " + shlex.quote(bootstrap)
        return dispatch(
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ForwardAgent=no",
                "-o",
                "ForwardX11=no",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "PermitLocalCommand=no",
                "-o",
                "RequestTTY=no",
                "-o",
                "RemoteCommand=none",
                "-o",
                "ControlPath=none",
                alias,
                remote_command,
            ],
            archive,
        )
    except (OSError, RuntimeError, UnicodeError, subprocess.CalledProcessError) as exc:
        print(f"cloud-check: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
