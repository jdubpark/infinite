#!/usr/bin/env python3
"""Reconstruct and run a cloud verification snapshot in an isolated checkout."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


PAYLOAD = pathlib.Path(__file__).resolve().parent
RUN_DIR: pathlib.Path | None = None
CHILD: subprocess.Popen[str] | None = None
GIT_ENV: dict[str, str] | None = None


class CheckError(Exception):
    pass


def run(command: list[str], *, cwd: pathlib.Path | None = None,
        env: dict[str, str] | None = None, capture: bool = False,
        input_data: bytes | None = None) -> bytes:
    code, output, error = execute(command, cwd=cwd, env=env, capture=capture, input_data=input_data)
    if code:
        detail = (error or output or b"").decode("utf-8", "replace").strip() if capture else ""
        raise CheckError(f"{command[0]} failed ({code})" + (f": {detail}" if detail else ""))
    return output


def terminate_group(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(0.2)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def execute(command: list[str], *, cwd: pathlib.Path | None = None,
            env: dict[str, str] | None = None, capture: bool = False,
            input_data: bytes | None = None) -> tuple[int, bytes, bytes]:
    global CHILD
    if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
        raise CheckError("safe process-group cleanup requires waitid(WNOWAIT)")
    stdout = tempfile.TemporaryFile() if capture else None
    stderr = tempfile.TemporaryFile() if capture else None
    try:
        CHILD = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if input_data is not None else None,
            text=False,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        if input_data is not None:
            try:
                CHILD.stdin.write(input_data)
            except BrokenPipeError:
                pass
            finally:
                CHILD.stdin.close()
        while True:
            status = os.waitid(os.P_PID, CHILD.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            if status is not None:
                break
            time.sleep(0.05)
        code = status.si_status if status.si_code == os.CLD_EXITED else 128 + status.si_status
        terminate_group(CHILD.pid)
        CHILD.wait()
        CHILD = None
        if capture:
            stdout.seek(0)
            stderr.seek(0)
            return code, stdout.read(), stderr.read()
        return code, b"", b""
    finally:
        if CHILD is not None and CHILD.returncode is None:
            terminate_group(CHILD.pid)
            CHILD.wait()
        CHILD = None
        if stdout:
            stdout.close()
        if stderr:
            stderr.close()


def version(executable: str, args: list[str]) -> str:
    path = shutil.which(executable)
    if not path:
        raise CheckError(f"required tool missing: {executable}")
    return run([path, *args], env=GIT_ENV, capture=True).decode("utf-8", "replace").strip()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_pin(pin: dict[str, object]) -> tuple[str, str, str]:
    if sys.platform != "linux":
        raise CheckError(f"cloud checkout requires a Linux runner, got {sys.platform}")
    node = version("node", ["--version"]).removeprefix("v")
    npm = version("npm", ["--version"])
    git = version("git", ["--version"])
    if node != pin["node"]:
        raise CheckError(f"Node version mismatch: expected {pin['node']}, got {node}")
    if npm != pin["npm"]:
        raise CheckError(f"npm version mismatch: expected {pin['npm']}, got {npm}")
    return node, npm, git


def private_env(home: pathlib.Path, temp: pathlib.Path, marker: pathlib.Path, run_id: str) -> dict[str, str]:
    config = home / ".npmrc"
    config.write_text("fund=false\naudit=false\n")
    git_config = home / ".gitconfig"
    git_config.write_text("")
    cache_root = pathlib.Path.home() / ".cache" / "infinite-cloud-check"
    cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_root.chmod(0o700)
    npm_cache = cache_root / "npm"
    browsers = cache_root / "playwright"
    npm_cache.mkdir(mode=0o700, exist_ok=True)
    browsers.mkdir(mode=0o700, exist_ok=True)
    npm_cache.chmod(0o700)
    browsers.chmod(0o700)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "TZ": "UTC",
        "HOME": str(home),
        "USERPROFILE": str(home),
        "CI": "1",
        "TMPDIR": str(temp),
        "npm_config_userconfig": str(config),
        "npm_config_cache": str(npm_cache),
        "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
        "GIT_CONFIG_GLOBAL": str(git_config),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "INFINITE_CLOUD_CHECK": str(marker),
        "INFINITE_CHECK_RUN_ID": run_id,
        "COMPOSE_PROJECT_NAME": run_id,
    }
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def cleanup(_signum: int | None = None, _frame: object | None = None) -> None:
    if _signum is not None and CHILD and CHILD.returncode is None:
        try:
            terminate_group(CHILD.pid)
            CHILD.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            CHILD.kill()
            CHILD.wait()
    if RUN_DIR and RUN_DIR.exists():
        shutil.rmtree(RUN_DIR)
    if _signum is not None:
        raise SystemExit(128 + _signum)


def git(cwd: pathlib.Path, *args: str, env: dict[str, str] | None = None,
        input_data: bytes | None = None, capture: bool = False) -> bytes:
    return run([shutil.which("git") or "git", "-C", str(cwd), *args],
               env=env if env is not None else GIT_ENV, input_data=input_data, capture=capture)


def parse_manifest(manifest: object) -> dict[str, dict[str, object]]:
    if not isinstance(manifest, dict):
        raise CheckError("snapshot file manifest is missing")
    result: dict[str, dict[str, object]] = {}
    for relative, expected in manifest.items():
        if not isinstance(relative, str) or not isinstance(expected, dict):
            raise CheckError("invalid snapshot file manifest entry")
        rel = pathlib.PurePosixPath(relative)
        if rel.is_absolute() or rel.as_posix() != relative or not rel.parts or any(part in ("", ".", "..", ".git") for part in rel.parts):
            raise CheckError(f"unsafe snapshot file path: {relative}")
        if not isinstance(expected.get("sha256"), str) or expected.get("type") not in ("file", "symlink"):
            raise CheckError(f"invalid snapshot file entry: {relative}")
        if not isinstance(expected.get("executable"), bool):
            raise CheckError(f"invalid snapshot mode entry: {relative}")
        result[rel.as_posix()] = expected
    return result


def install_index(checkout: pathlib.Path, entries: object) -> set[str]:
    if not isinstance(entries, list):
        raise CheckError("snapshot index entries are missing")
    records: list[bytes] = []
    paths: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise CheckError("invalid snapshot index entry")
        relative = entry.get("path")
        mode = entry.get("mode")
        oid = entry.get("oid")
        stage = entry.get("stage")
        if not isinstance(relative, str) or not isinstance(oid, str) or stage != 0:
            raise CheckError("snapshot index must contain stage-zero entries")
        rel = pathlib.PurePosixPath(relative)
        if rel.is_absolute() or rel.as_posix() != relative or not rel.parts or any(part in ("", ".", "..", ".git") for part in rel.parts):
            raise CheckError(f"unsafe snapshot index path: {relative}")
        if relative in paths or len(oid) not in (40, 64) or any(char not in "0123456789abcdef" for char in oid):
            raise CheckError(f"invalid snapshot index object: {relative}")
        if isinstance(mode, int):
            mode_text = format(mode, "o")
        elif isinstance(mode, str):
            mode_text = mode
        else:
            raise CheckError(f"invalid snapshot index mode: {relative}")
        if mode_text not in {"100644", "100755", "120000"}:
            raise CheckError(f"unsupported snapshot index mode: {relative}")
        paths.add(relative)
        records.append(f"{mode_text} {oid} 0\t{relative}\0".encode("utf-8"))
    git(checkout, "read-tree", "--empty")
    if records:
        git(checkout, "update-index", "-z", "--index-info", input_data=b"".join(records))
    return paths


def extract_worktree(archive: pathlib.Path, checkout: pathlib.Path,
                     manifest: dict[str, dict[str, object]]) -> None:
    with tarfile.open(archive, "r:*") as bundle:
        members = bundle.getmembers()
        names: set[str] = set()
        symlinks: set[str] = set()
        regular_files: set[str] = set()
        for member in members:
            rel = pathlib.PurePosixPath(member.name)
            if rel.is_absolute() or rel.as_posix() != member.name or not rel.parts or any(part in ("", ".", "..", ".git") for part in rel.parts):
                raise CheckError(f"unsafe working-tree path: {member.name}")
            name = rel.as_posix()
            if name in names or name not in manifest:
                raise CheckError(f"unexpected or duplicate working-tree entry: {name}")
            if not (member.isfile() or member.issym()):
                raise CheckError(f"unsupported working-tree entry: {name}")
            names.add(name)
            if member.issym():
                symlinks.add(name)
                target = pathlib.PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise CheckError(f"absolute working-tree symlink: {name}")
                depth = 0
                for part in rel.parent.joinpath(target).parts:
                    if part == "..":
                        depth -= 1
                    elif part not in ("", "."):
                        depth += 1
                    if depth < 0:
                        raise CheckError(f"working-tree symlink escapes checkout: {name}")
            else:
                regular_files.add(name)
            if manifest[name]["type"] != ("symlink" if member.issym() else "file"):
                raise CheckError(f"working-tree entry type mismatch: {name}")
        for name in names:
            parent = pathlib.PurePosixPath(name).parent
            if any(partial.as_posix() in symlinks | regular_files for partial in (parent, *parent.parents)):
                raise CheckError(f"working-tree path traverses a non-directory entry: {name}")
        if names != set(manifest):
            raise CheckError("working-tree archive does not cover the file manifest")
        for member in members:
            if member.issym():
                continue
            rel = pathlib.PurePosixPath(member.name)
            destination = checkout.joinpath(*rel.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise CheckError(f"cannot read working-tree file: {member.name}")
            with source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)
            destination.chmod(member.mode & 0o777)
        for member in members:
            if member.issym():
                destination = checkout.joinpath(*pathlib.PurePosixPath(member.name).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(member.linkname, destination)
        for name in symlinks:
            resolved = (checkout / name).resolve(strict=False)
            try:
                resolved.relative_to(checkout.resolve())
            except ValueError as error:
                raise CheckError(f"working-tree symlink escapes checkout: {name}") from error


def verify_files(checkout: pathlib.Path, manifest: dict[str, dict[str, object]]) -> set[str]:
    paths: set[str] = set()
    for relative, expected in manifest.items():
        path = checkout / relative
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise CheckError(f"snapshot file missing after reconstruction: {relative}") from error
        if stat.S_ISLNK(info.st_mode):
            kind = "symlink"
            digest = sha256_bytes(os.readlink(path).encode("utf-8"))
            executable = bool(info.st_mode & 0o111)
        elif stat.S_ISREG(info.st_mode):
            kind = "file"
            digest = sha256_file(path)
            executable = bool(info.st_mode & 0o111)
        else:
            raise CheckError(f"unsupported reconstructed file type: {relative}")
        if expected["type"] != kind or expected["executable"] is not executable or expected["sha256"] != digest:
            raise CheckError(f"snapshot file content or mode mismatch: {relative}")
        paths.add(relative)
    return paths


def status_entries(checkout: pathlib.Path) -> list[dict[str, str]]:
    output = subprocess.run(
        [shutil.which("git") or "git", "-C", str(checkout), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=GIT_ENV,
        check=False,
    )
    if output.returncode:
        raise CheckError("could not read reconstructed snapshot status")
    rows = output.stdout.split(b"\0")
    entries: list[dict[str, str]] = []
    index = 0
    while index < len(rows) and rows[index]:
        row = rows[index]
        if row.startswith(b"?? "):
            entries.append({"xy": "??", "path": row[3:].decode("utf-8")})
            index += 1
        elif len(row) >= 4 and row[2:3] == b" ":
            xy = row[:2].decode("ascii")
            path = row[3:].decode("utf-8")
            if "R" in xy or "C" in xy:
                if index + 1 >= len(rows) or not rows[index + 1]:
                    raise CheckError("malformed reconstructed rename status")
                entries.append({"xy": xy, "path": path, "original_path": rows[index + 1].decode("utf-8")})
                index += 2
            else:
                entries.append({"xy": xy, "path": path})
                index += 1
        else:
            raise CheckError("unsupported reconstructed status record")
    return entries


def main() -> int:
    global CHILD, GIT_ENV, RUN_DIR
    os.umask(0o022)
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGHUP, cleanup)
    try:
        envelope = json.loads((PAYLOAD / "snapshot.json").read_text())
        base = envelope["base_oid"]
        cwd_value = envelope["cwd"]
        argv = envelope["argv"]
        head_ref = envelope.get("head_ref")
        if not isinstance(base, str) or len(base) not in (40, 64) or any(char not in "0123456789abcdef" for char in base) or not isinstance(cwd_value, str):
            raise CheckError("invalid snapshot identity or working directory")
        cwd_rel = pathlib.PurePosixPath(cwd_value)
        if cwd_rel.is_absolute() or ".." in cwd_rel.parts or cwd_rel.as_posix() != cwd_value:
            raise CheckError("snapshot working directory escapes repository")
        if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
            raise CheckError("snapshot argv must be a non-empty string array")
        hashes = envelope.get("sha256")
        status = envelope.get("status")
        if not isinstance(hashes, dict) or not isinstance(status, dict) or status.get("format") != "porcelain-v1":
            raise CheckError("snapshot metadata is invalid")
        if not isinstance(status.get("entries"), list):
            raise CheckError("snapshot status entries are missing")
        if not isinstance(status.get("omitted_untracked", 0), int) or status.get("omitted_untracked", 0) < 0:
            raise CheckError("snapshot omitted-file count is invalid")
        expected_files = ("worker.py", "toolchain.json", "source.pack", "working-tree.tar")
        for name in expected_files:
            path = PAYLOAD / name
            if not path.is_file() or not isinstance(hashes.get(name), str) or sha256_file(path) != hashes[name]:
                raise CheckError(f"snapshot payload missing or hash mismatch: {name}")
        pin = json.loads((PAYLOAD / "toolchain.json").read_text())
        if not isinstance(pin, dict) or not all(isinstance(pin.get(key), str) for key in ("node", "npm")):
            raise CheckError("toolchain pin is invalid")
        manifest = parse_manifest(envelope.get("files"))
        index_entries = envelope.get("index")

        RUN_DIR = PAYLOAD / "j"
        RUN_DIR.mkdir(mode=0o700)
        run_id = os.environ["INFINITE_CHECK_RUN_ID"]
        home = RUN_DIR / "h"
        home.mkdir(mode=0o700)
        temp = RUN_DIR / "x"
        temp.mkdir(mode=0o700)
        marker = RUN_DIR / "cloud-executor"
        marker.write_text("infinite-cloud-check-v1\n")
        env = private_env(home, temp, marker, run_id)
        GIT_ENV = env
        node, npm, git_version = ensure_pin(pin)
        checkout = RUN_DIR / "t"
        checkout.mkdir()
        git(checkout, "init", "--quiet")
        git(checkout, "config", "core.autocrlf", "false")
        git(checkout, "config", "core.filemode", "true")
        git(checkout, "config", "core.symlinks", "true")
        git(checkout, "config", "core.attributesFile", "/dev/null")
        pack = (PAYLOAD / "source.pack").read_bytes()
        run([shutil.which("git") or "git", "-C", str(checkout), "index-pack", "--stdin"], env=env, input_data=pack)
        (checkout / ".git" / "shallow").write_text(base + "\n")
        if head_ref is None:
            git(checkout, "update-ref", "--no-deref", "HEAD", base)
        elif isinstance(head_ref, str) and head_ref.startswith("refs/heads/"):
            git(checkout, "check-ref-format", head_ref)
            git(checkout, "update-ref", head_ref, base)
            git(checkout, "symbolic-ref", "HEAD", head_ref)
        else:
            raise CheckError("snapshot branch ref is invalid")
        index_paths = install_index(checkout, index_entries)
        file_paths = set(manifest)
        extract_worktree(PAYLOAD / "working-tree.tar", checkout, manifest)
        if file_paths - index_paths != {entry["path"] for entry in status["entries"] if entry.get("xy") == "??"}:
            raise CheckError("snapshot manifest untracked paths do not match status metadata")
        verify_files(checkout, manifest)
        actual_status = status_entries(checkout)
        if actual_status != status["entries"]:
            raise CheckError("reconstructed working tree status does not match snapshot metadata")
        if git(checkout, "rev-parse", "HEAD", capture=True).decode("ascii").strip() != base:
            raise CheckError("reconstructed HEAD does not match caller base")

        lockfile = checkout / "package-lock.json"
        if not lockfile.is_file():
            raise CheckError("snapshot package-lock.json missing")
        lock_hash = sha256_file(lockfile)
        snapshot_state = {
            "base_oid": base,
            "head_ref": head_ref,
            "index": sorted(index_entries, key=lambda entry: entry["path"]),
            "files": manifest,
        }
        snapshot_id = sha256_bytes(json.dumps(snapshot_state, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        print(f"CLOUD CHECK base={base} snapshot={snapshot_id} lock={lock_hash} status_entries={len(status['entries'])} omitted_private={status.get('omitted_untracked', 0)}", flush=True)
        print(f"RUNNER os={platform.system()} release={platform.release()} arch={platform.machine()} node={node} npm={npm} git={git_version}", flush=True)
        print("INSTALL npm ci", flush=True)
        install_code, _, _ = execute([shutil.which("npm") or "npm", "ci"], cwd=checkout, env=env)
        if install_code:
            install_exit = install_code if install_code > 0 else 128 - install_code
            print(f"RESULT FAIL npm ci exit={install_exit}", flush=True)
            return install_exit
        print(f"RUN cwd={cwd_value} argv={json.dumps(argv, ensure_ascii=True)}", flush=True)
        cwd = checkout.joinpath(*cwd_rel.parts)
        if not cwd.is_dir():
            raise CheckError(f"snapshot working directory missing: {cwd_value}")
        code, _, _ = execute(argv, cwd=cwd, env=env)
        state = "PASS" if code == 0 else "FAIL"
        exit_code = code if code > 0 else (128 - code if code < 0 else 0)
        print(f"RESULT {state} exit={exit_code}", flush=True)
        return exit_code
    except (CheckError, KeyError, OSError, RuntimeError, TypeError, ValueError, UnicodeError,
            tarfile.TarError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"CLOUD CHECK ERROR: {error}", file=sys.stderr, flush=True)
        print("RESULT FAIL preflight", flush=True)
        return 2
    finally:
        cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
