#!/usr/bin/env python3
"""Receive trusted GitHub events and verify enrolled revisions on cloud guests."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SHA = re.compile(r"[0-9a-f]{40,64}\Z", re.ASCII)
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z", re.ASCII)
CONTEXT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,99}\Z", re.ASCII)
MAX_BODY = 1_000_000
MAX_ATTEMPTS = 2


class RevisionError(RuntimeError):
    pass


def private_file(path: Path) -> bytes:
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077:
        raise RevisionError(f"private file has unsafe permissions: {path.name}")
    return path.read_bytes().strip()


def load_config(path: Path) -> dict:
    raw = json.loads(private_file(path))
    required = {"repository", "origin", "workspace", "snapshotRoot", "runner", "refs", "mode", "command", "profileSha256", "context", "stateDirectory", "launcher", "webhookSecretFile", "githubTokenFile"}
    if not isinstance(raw, dict) or set(raw) != required:
        raise RevisionError("config must contain the documented enrollment fields")
    if not isinstance(raw["repository"], str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", raw["repository"]):
        raise RevisionError("invalid enrolled repository")
    if not isinstance(raw["origin"], str) or not raw["origin"] or "\n" in raw["origin"]:
        raise RevisionError("invalid enrolled Git origin")
    for field in ("workspace", "runner"):
        if not isinstance(raw[field], str) or not NAME.fullmatch(raw[field]):
            raise RevisionError(f"invalid {field} enrollment")
    if not isinstance(raw["refs"], list) or not raw["refs"] or any(not isinstance(x, str) or not x.startswith("refs/heads/") or ".." in x or "\n" in x for x in raw["refs"]):
        raise RevisionError("refs must be a non-empty list of branch refs")
    if len(set(raw["refs"])) != len(raw["refs"]):
        raise RevisionError("duplicate enrolled refs")
    if raw["mode"] not in {"npm", "compose", "command"}:
        raise RevisionError("mode must be npm, compose or command")
    if not isinstance(raw["command"], list) or any(not isinstance(x, str) or not x or "\x00" in x for x in raw["command"]):
        raise RevisionError("command must be an argv array")
    if (raw["mode"] == "npm" and raw["command"] != ["npm", "run", "check"]
            or raw["mode"] == "compose" and raw["command"]
            or raw["mode"] == "command" and not raw["command"]):
        raise RevisionError("command does not match the enrolled verification mode")
    if not re.fullmatch(r"[0-9a-f]{64}", raw["profileSha256"]):
        raise RevisionError("invalid pinned runner profile digest")
    if not isinstance(raw["context"], str) or not CONTEXT.fullmatch(raw["context"]):
        raise RevisionError("invalid GitHub status context")
    for field in ("snapshotRoot", "stateDirectory", "launcher", "webhookSecretFile", "githubTokenFile"):
        if not isinstance(raw[field], str) or not Path(raw[field]).is_absolute():
            raise RevisionError(f"{field} must be an absolute path")
    root = Path(raw["snapshotRoot"]).resolve(strict=True)
    if not root.is_dir() or str(root) != raw["snapshotRoot"]:
        raise RevisionError("snapshotRoot must be a canonical directory")
    launcher = Path(raw["launcher"]).resolve(strict=True)
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise RevisionError("launcher must name the installed executable")
    raw["launcherSha256"] = hashlib.sha256(launcher.read_bytes()).hexdigest()
    installed_profile = launcher.parent / "cloud-check/linux-runner.json"
    try:
        profile_value = json.loads(installed_profile.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RevisionError("installed runner profile is missing or invalid") from error
    if canonical_digest(profile_value) != raw["profileSha256"]:
        raise RevisionError("installed runner profile does not match trusted enrollment")
    raw["snapshotRoot"] = str(root)
    raw["launcher"] = str(launcher)
    return raw


def state_dir(config: dict) -> Path:
    path = Path(config["stateDirectory"])
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or str(path.resolve()) != str(path) or path.stat().st_mode & 0o077:
        raise RevisionError("state directory must be private and not a symlink")
    for name in ("jobs",):
        (path / name).mkdir(mode=0o700, exist_ok=True)
    return path


def pin_enrollment(config: dict, state: Path) -> None:
    pin = state / "enrollment.json"
    digest = config_digest(config)
    if pin.exists():
        if pin.is_symlink() or json.loads(private_file(pin)).get("digest") != digest:
            raise RevisionError("enrollment changed; use a new state directory and status context")
    else:
        atomic_json(pin, {"digest": digest})
    registry = Path(config["stateDirectory"]).parent / ".contexts"
    registry.mkdir(mode=0o700, exist_ok=True)
    if registry.is_symlink() or registry.stat().st_mode & 0o077:
        raise RevisionError("context registry must be private and not a symlink")
    context_key = hashlib.sha256((config["repository"] + "\0" + config["context"]).encode()).hexdigest()
    context_pin = registry / f"{context_key}.json"
    if context_pin.exists():
        if context_pin.is_symlink() or json.loads(private_file(context_pin)).get("digest") != digest:
            raise RevisionError("status context is already bound to a different enrollment")
    else:
        atomic_json(context_pin, {"digest": digest})


def config_digest(config: dict) -> str:
    identity = {key: config[key] for key in ("repository", "origin", "workspace", "runner", "refs", "mode", "command", "profileSha256", "launcherSha256", "context")}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def canonical_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()


def effective_state_home() -> Path:
    if os.environ.get("XDG_STATE_HOME"):
        return Path(os.environ["XDG_STATE_HOME"])
    if os.environ.get("XDG_CONFIG_HOME"):
        return Path(os.environ["XDG_CONFIG_HOME"]).parent / ".local/state"
    return Path.home() / ".local/state"


def check_argv(config: dict) -> tuple[list[str], str]:
    return config["command"], config["mode"]


def receipt_path(config: dict, raw: str) -> Path:
    state_home = effective_state_home().resolve(strict=True)
    directory = state_home / config["workspace"] / "cloud-check/receipts"
    candidate = Path(raw)
    try:
        directory = directory.resolve(strict=True)
        path = candidate.resolve(strict=True)
    except OSError as error:
        raise RevisionError("cloud launcher receipt is missing") from error
    if not candidate.is_absolute() or candidate.is_symlink() or str(candidate) != str(path) or path.parent != directory:
        raise RevisionError("cloud launcher receipt is outside the enrolled workspace")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RevisionError("cloud launcher receipt has unsafe ownership or permissions")
    directory_info = directory.stat()
    if directory_info.st_uid != os.geteuid() or directory_info.st_mode & 0o077:
        raise RevisionError("cloud launcher receipt directory is not private")
    return path


def verify_receipt(config: dict, sha: str, exit_code: int, output: bytes, argv: list[str], mode: str, prior_receipts: set[str]) -> dict:
    lines = output.decode("utf-8", "replace").splitlines()
    receipt_lines = [line.removeprefix("RECEIPT ") for line in lines if line.startswith("RECEIPT ")]
    if not receipt_lines:
        raise RevisionError("cloud launcher returned no receipt")
    path = receipt_path(config, receipt_lines[-1])
    if path.name in prior_receipts:
        raise RevisionError("cloud launcher returned a stale receipt")
    record = json.loads(path.read_text(encoding="utf-8"))
    expected_project = hashlib.sha256(config["origin"].encode()).hexdigest()
    expected_command = hashlib.sha256(json.dumps(argv, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()
    if (record.get("version") != 1 or record.get("current") is not True or record.get("base") != sha
            or record.get("project") != expected_project or record.get("workspace") != config["workspace"]
            or record.get("worktreeChanges") != 0 or record.get("exit") != exit_code):
        raise RevisionError("cloud launcher receipt does not match the enrolled source and check")
    runs = record.get("runs")
    if not isinstance(runs, list) or len(runs) != 1 or runs[0].get("runner") != config["runner"]:
        raise RevisionError("cloud launcher receipt does not identify the enrolled guest")
    guest = runs[0].get("receipt")
    if (not isinstance(guest, dict) or guest.get("base") != sha or guest.get("exit") != exit_code
            or guest.get("envelope") != record.get("envelope") or not guest.get("snapshot")
            or guest.get("mode") != mode or guest.get("commandSha256") != expected_command
            or canonical_digest(guest.get("profile")) != config["profileSha256"]
            or not guest.get("machine") or not guest.get("engine")):
        raise RevisionError("cloud guest receipt does not match the captured source")
    return record


def atomic_json(path: Path, value: dict) -> None:
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def event_from(payload: dict, event: str, config: dict) -> dict | None:
    repository = payload.get("repository")
    if not isinstance(repository, dict) or repository.get("full_name") != config["repository"]:
        raise RevisionError("event repository is not enrolled")
    ref = None
    sha = None
    if event == "push":
        ref = payload.get("ref")
        sha = payload.get("after")
        if sha == "0" * len(str(sha)):
            return None
    elif event == "pull_request":
        if payload.get("action") not in {"opened", "reopened", "synchronize", "ready_for_review"}:
            return None
        pr = payload.get("pull_request")
        if not isinstance(pr, dict):
            raise RevisionError("malformed pull request event")
        base = pr.get("base") or {}
        head = pr.get("head") or {}
        base_repo = base.get("repo") or {}
        head_repo = head.get("repo") or {}
        if base_repo.get("full_name") != config["repository"] or head_repo.get("full_name") != config["repository"] or head_repo.get("fork") is True:
            raise RevisionError("fork and foreign-repository heads are not trusted")
        base_ref = base.get("ref")
        ref = f"refs/heads/{base_ref}" if isinstance(base_ref, str) else None
        sha = head.get("sha")
    else:
        return None
    if ref not in config["refs"] or not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise RevisionError("event ref or revision is outside the enrollment")
    return {"event": event, "ref": ref, "sha": sha, "receivedAt": int(time.time())}


def publish(config: dict, token: bytes, sha: str, state: str, description: str, api: str) -> None:
    body = json.dumps({"state": state, "context": config["context"], "description": description[:140]}).encode()
    request = Request(f"{api.rstrip('/')}/repos/{config['repository']}/statuses/{sha}", data=body, method="POST", headers={"Authorization": "Bearer " + token.decode("ascii"), "Accept": "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"})
    with urlopen(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise RevisionError(f"status API returned HTTP {response.status}")


def publish_current(config: dict, sha: str, state: str, description: str, api: str) -> None:
    publish(config, private_file(Path(config["githubTokenFile"])), sha, state, description, api)


def git(root: Path, *args: str, env: dict | None = None) -> str:
    clean = {"PATH": "/usr/bin:/bin:/usr/local/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "HOME": str(root)}
    if env:
        clean.update(env)
    result = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean, check=False)
    if result.returncode:
        raise RevisionError(result.stderr.decode("utf-8", "replace").strip() or "Git operation failed")
    return result.stdout.decode("ascii", "strict").strip()


def prepare_snapshot(config: dict, state: Path, sha: str) -> Path:
    temp = Path(tempfile.mkdtemp(prefix=".cloud-revision-", dir=config["snapshotRoot"]))
    try:
        env = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "HOME": os.environ.get("HOME", str(temp))}
        if "SSH_AUTH_SOCK" in os.environ:
            env["SSH_AUTH_SOCK"] = os.environ["SSH_AUTH_SOCK"]
        subprocess.run(["git", "init", "--quiet", "--template=", str(temp)], check=True, env={"PATH": "/usr/bin:/bin:/usr/local/bin", **env}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        git(temp, "-c", "core.hooksPath=/dev/null", "remote", "add", "origin", config["origin"], env=env)
        git(temp, "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--no-recurse-submodules", "origin", sha, env=env)
        git(temp, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", sha, env=env)
        if git(temp, "rev-parse", "HEAD", env=env) != sha or git(temp, "config", "--local", "--get", "remote.origin.url", env=env) != config["origin"]:
            raise RevisionError("captured source identity differs from the event")
        profile = temp / "scripts/cloud-check/linux-runner.json"
        if profile.exists() or profile.is_symlink():
            if profile.is_symlink():
                raise RevisionError("source runner profile cannot be a symlink")
            try:
                profile_value = json.loads(profile.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise RevisionError("source runner profile is invalid") from error
            if canonical_digest(profile_value) != config["profileSha256"]:
                raise RevisionError("source runner profile differs from trusted enrollment")
        return temp
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise


def verifier_env(config: dict) -> dict:
    keep = {"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": os.environ.get("HOME", "/nonexistent"), "USER": os.environ.get("USER", ""), "LOGNAME": os.environ.get("LOGNAME", ""), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
    for key in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "SSH_AUTH_SOCK"):
        if key in os.environ:
            keep[key] = os.environ[key]
    if "XDG_CONFIG_HOME" in keep and "XDG_STATE_HOME" not in keep:
        keep["XDG_STATE_HOME"] = str(effective_state_home())
    return keep


def run_job(config: dict, state: Path, job_path: Path, api: str) -> None:
    worker_lock_path = job_path.with_suffix(".worker.lock")
    queue_lock_path = job_path.with_suffix(".queue.lock")
    with worker_lock_path.open("a+b") as worker_lock:
        fcntl.flock(worker_lock, fcntl.LOCK_EX)
        with queue_lock_path.open("a+b") as queue_lock:
            fcntl.flock(queue_lock, fcntl.LOCK_EX)
            job = json.loads(job_path.read_text(encoding="utf-8"))
            sha = job["sha"]
            if job.get("configDigest") != config_digest(config):
                raise RevisionError("queued event belongs to a different enrollment")
            if job.get("result") in {"success", "failure", "error"}:
                if job.get("publishedResult") != job["result"]:
                    publish_current(config, sha, job["result"], job["description"], api)
                    job["publishedResult"] = job["result"]
                    atomic_json(job_path, job)
                return
            if int(job.get("attempts", 0)) >= MAX_ATTEMPTS:
                job["result"] = "error"
                job["description"] = "Cloud verification could not complete"
                job["error"] = "retry limit reached"
                job["completedAt"] = int(time.time())
                atomic_json(job_path, job)
                publish_current(config, sha, "error", job["description"], api)
                job["publishedResult"] = "error"
                atomic_json(job_path, job)
                return
            if not job.get("pendingPublished"):
                try:
                    publish_current(config, sha, "pending", "Cloud verification queued", api)
                    job["pendingPublished"] = True
                except (OSError, URLError, HTTPError, RevisionError):
                    pass
            job["attempts"] = int(job.get("attempts", 0)) + 1
            job["startedAt"] = int(time.time())
            atomic_json(job_path, job)
        try:
            if hashlib.sha256(Path(config["launcher"]).read_bytes()).hexdigest() != config["launcherSha256"]:
                raise RevisionError("installed launcher changed after enrollment")
            snapshot = prepare_snapshot(config, state, sha)
            check, mode = check_argv(config)
            launcher_args = [config["launcher"], "--runner", config["runner"]]
            if mode == "command":
                launcher_args.extend(["--project-command", "--", *check])
            receipt_dir = effective_state_home() / config["workspace"] / "cloud-check/receipts"
            prior_receipts = {path.name for path in receipt_dir.iterdir()} if receipt_dir.is_dir() else set()
            try:
                with tempfile.TemporaryFile(dir=state) as output:
                    completed = subprocess.run(launcher_args, cwd=snapshot, env=verifier_env(config), stdout=output, stderr=subprocess.STDOUT, check=False, timeout=24 * 60 * 60)
                    output.flush()
                    output.seek(0)
                    output_bytes = output.read(16 * 1024 * 1024 + 1)
                    if len(output_bytes) > 16 * 1024 * 1024:
                        raise RevisionError("cloud launcher output exceeded 16 MiB")
            finally:
                shutil.rmtree(snapshot, ignore_errors=True)
            exit_code = completed.returncode
            job["launcherExit"] = exit_code
            job["runner"] = config["runner"]
            job["profileSha256"] = config["profileSha256"]
            job["commandSha256"] = hashlib.sha256(json.dumps(check, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()
            record = verify_receipt(config, sha, exit_code, output_bytes, check, mode, prior_receipts)
            job["result"] = "success" if exit_code == 0 else "failure"
            job["description"] = "Cloud verification passed" if exit_code == 0 else "Cloud verification failed"
            job["outputSha256"] = hashlib.sha256(output_bytes).hexdigest()
            job["receiptSha256"] = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        except Exception as error:
            job["result"] = "error"
            job["runner"] = config["runner"]
            job["profileSha256"] = config["profileSha256"]
            job["description"] = "Cloud verification could not complete"
            job["error"] = type(error).__name__
        job["completedAt"] = int(time.time())
        with queue_lock_path.open("a+b") as queue_lock:
            fcntl.flock(queue_lock, fcntl.LOCK_EX)
            current = json.loads(job_path.read_text(encoding="utf-8"))
            for key, value in job.items():
                if key != "deliveries":
                    current[key] = value
            atomic_json(job_path, current)
            publish_current(config, sha, current["result"], current["description"], api)
            current["publishedResult"] = current["result"]
            atomic_json(job_path, current)


def receive(config: dict, state: Path, body: bytes, headers: dict[str, str], api: str) -> tuple[int, str]:
    headers = {key.lower(): value for key, value in headers.items()}
    secret = private_file(Path(config["webhookSecretFile"]))
    signature = headers.get("x-hub-signature-256", "")
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return 401, "invalid signature"
    try:
        payload = json.loads(body)
        delivery = headers.get("x-github-delivery", "")
        if not NAME.fullmatch(delivery):
            raise RevisionError("invalid delivery id")
        event = headers.get("x-github-event", "")
        accepted = event_from(payload, event, config)
        if accepted is None:
            return 202, "ignored"
        accepted["delivery"] = delivery
        accepted["configDigest"] = config_digest(config)
        digest = hashlib.sha256((config_digest(config) + accepted["sha"]).encode()).hexdigest()
        queue = state / "jobs" / (digest + ".json")
        with queue.with_suffix(".queue.lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = json.loads(queue.read_text(encoding="utf-8")) if queue.exists() else None
            delivery_record = {key: accepted[key] for key in ("delivery", "event", "ref", "sha", "receivedAt")}
            if current is None:
                check, _mode = check_argv(config)
                command_hash = hashlib.sha256(json.dumps(check, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()
                current = {**accepted, "attempts": 0, "runner": config["runner"], "profileSha256": config["profileSha256"], "commandSha256": command_hash, "deliveries": [delivery_record]}
            elif not any(item.get("delivery") == delivery for item in current.get("deliveries", [])):
                current.setdefault("deliveries", []).append(delivery_record)
            atomic_json(queue, current)
            try:
                result = current.get("result") if current.get("result") in {"success", "failure", "error"} else "pending"
                description = current.get("description", "Cloud verification queued")
                if result == "pending" and not current.get("pendingPublished"):
                    publish_current(config, accepted["sha"], result, description, api)
                    current["pendingPublished"] = True
                    atomic_json(queue, current)
                elif result != "pending" and current.get("publishedResult") != result:
                    publish_current(config, accepted["sha"], result, description, api)
                    current["publishedResult"] = result
                    atomic_json(queue, current)
            except (OSError, URLError, HTTPError, RevisionError):
                pass
        return 202, "queued"
    except (ValueError, TypeError, KeyError, RevisionError) as error:
        return 400, str(error)


def main() -> int:
    parser = argparse.ArgumentParser(description="Receive and verify enrolled pushed revisions")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8418)
    parser.add_argument("--api", default="https://api.github.com")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        state = state_dir(config)
        pin_enrollment(config, state)
        if args.once:
            failures = 0
            for job in sorted((state / "jobs").glob("*.json")):
                try:
                    run_job(config, state, job, args.api)
                except Exception as error:
                    failures += 1
                    print(f"cloud-revision: job failed: {type(error).__name__}: {error}", file=sys.stderr)
            return 1 if failures else 0
        if not args.serve or args.host != "127.0.0.1" or not (1 <= args.port <= 65535):
            raise RevisionError("choose --once or --serve on loopback")

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path != "/github-webhook":
                    self.send_error(404)
                    return
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0 or length > MAX_BODY:
                    self.send_error(413)
                    return
                status, body = receive(config, state, self.rfile.read(length), dict(self.headers.items()), args.api)
                encoded = body.encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
        return 0
    except Exception as error:
        print(f"cloud-revision: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
