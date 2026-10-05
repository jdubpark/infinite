#!/usr/bin/env python3
"""Create an age-encrypted, crash-consistent backup of the single-tenant host.

Only the public age recipient is installed on the server. All writers running as
infinite-host/infinite-agent must belong to infinite.service. Processes are frozen
only while a private staging copy is made on the encrypted application volume.
An independent systemd timer thaws them even if this process is killed.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import tempfile
import time
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/infinite/backup.json")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Run this host backup as root")
    os.umask(0o077)
    config_path = Path(args.config)
    info = config_path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Backup configuration must be root-owned and not writable by other users")
    config = json.loads(config_path.read_text())
    if set(config) != {"recipient", "outputDir"}:
        raise RuntimeError("Expected only recipient and outputDir in backup configuration")
    recipient = config["recipient"]
    if not isinstance(recipient, str) or not recipient.startswith("age1") or not recipient.isalnum():
        raise RuntimeError("Use an age public recipient, never a private identity")
    source = Path("/srv/infinite-data")
    if not run("findmnt", "-rn", "-T", str(source), "-o", "SOURCE").startswith("/dev/mapper/"):
        raise RuntimeError("Application storage must be an unlocked encrypted volume")
    output = Path(config["outputDir"])
    if not output.is_absolute() or output.is_symlink():
        raise RuntimeError("Use an absolute, private backup directory")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = output.stat()
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("Backup directory must be root-owned with mode 0700")
    with Path("/run/infinite-backup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        create_backup(source, output, recipient)


def create_backup(source, output, recipient):
    service = "infinite.service"
    if run("systemctl", "is-active", service) != "active":
        raise RuntimeError("The runner must be active for this online backup")
    group = run("systemctl", "show", service, "--property=ControlGroup", "--value")
    uids = {pwd.getpwnam(user).pw_uid for user in ("infinite-host", "infinite-agent")}
    processes = {}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid in uids:
                if f"0::{group}" not in (process / "cgroup").read_text().splitlines():
                    raise RuntimeError("An application writer is outside the frozen service; stop it before backup")
                processes[process.name] = (process / "stat").read_text().rsplit(")", 1)[1].split()[19]
        except FileNotFoundError:
            continue
    names = ("control", "control-home", "agent-home", "workspaces")
    required = sum(int(run("du", "--summarize", "--block-size=1", str(source / name)).split()[0]) for name in names)
    reserve = 2 * 1024 ** 3
    if shutil.disk_usage(source).free < required * 1.2 + reserve or shutil.disk_usage(output).free < required * 1.2 + reserve:
        raise RuntimeError("Insufficient free space for a snapshot while preserving the working volume reserve")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    archive = output / (stamp + ".tar.gz.age")
    partial = output / (stamp + ".partial")
    staging = Path(tempfile.mkdtemp(prefix=".backup-", dir=source))
    thaw_unit = "infinite-backup-thaw-" + uuid.uuid4().hex
    frozen = False
    try:
        # Register the independent watchdog before freezing. A slow/failed copy
        # is never published; the pause is bounded even after SIGKILL.
        run("systemd-run", "--quiet", "--unit=" + thaw_unit, "--on-active=45s", "/usr/bin/systemctl", "thaw", service)
        started = time.monotonic()
        try:
            frozen = True
            run("systemctl", "freeze", service, timeout=5)
            if run("systemctl", "show", service, "-p", "FreezerState", "--value") != "frozen":
                raise RuntimeError("Service did not freeze")
            run("sync", "-f", str(source), timeout=5)
            data = staging / "data"; data.mkdir(mode=0o700)
            # The dedicated temporary directory is omitted. Native homes are
            # copied in full, including databases and WAL/rollback journals.
            for name in names:
                budget = 30 - (time.monotonic() - started)
                if budget <= 0:
                    raise RuntimeError("Snapshot pause exceeded 30 seconds; use filesystem snapshots for larger workspaces")
                run("cp", "-a", "-x", "--reflink=auto", str(source / name), str(data / name), timeout=budget)
            if run("systemctl", "show", service, "-p", "FreezerState", "--value") != "frozen":
                raise RuntimeError("Watchdog thawed during the copy; snapshot rejected")
        finally:
            if frozen:
                run("systemctl", "thaw", service, timeout=5)
                frozen = False
            run("systemctl", "stop", thaw_unit + ".timer", timeout=5)
        pause_seconds = round(time.monotonic() - started, 3)
        shutil.copytree("/etc/infinite", staging / "config", symlinks=True)
        # Vault and LUKS keys are recovered separately from the owner's device.
        manifest = {"format": 1, "createdAt": stamp, "consistency": "process-frozen-crash-consistent", "pauseSeconds": pause_seconds,
                    "service": service, "processStartTicks": processes, "release": os.path.realpath("/opt/infinite"),
                    "keyRecovery": "owner-held vault.key and storage.key; not included", "files": {}}
        for path in staging.rglob("*"):
            if path.is_file() and not path.is_symlink():
                manifest["files"][str(path.relative_to(staging))] = {"sha256": digest(path), "bytes": path.stat().st_size}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        with partial.open("xb") as target:
            tar = subprocess.Popen(["tar", "--create", "--gzip", "--numeric-owner", "--file=-", "--directory=" + str(staging), "."], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                encrypted = subprocess.run(["age", "--encrypt", "--recipient", recipient], stdin=tar.stdout, stdout=target, stderr=subprocess.DEVNULL, timeout=600)
                tar.stdout.close()
                if encrypted.returncode or tar.wait(timeout=30):
                    raise RuntimeError("Archive encryption failed")
                target.flush(); os.fsync(target.fileno())
            finally:
                if tar.poll() is None:
                    tar.kill(); tar.wait()
        partial.rename(archive)
        receipt = {"archive": archive.name, "bytes": archive.stat().st_size, "sha256": digest(archive), "pauseSeconds": pause_seconds,
                   "serviceState": run("systemctl", "show", service, "-p", "FreezerState", "--value")}
        (output / (stamp + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))
    finally:
        if frozen:
            subprocess.run(["systemctl", "thaw", service], timeout=10, capture_output=True)
        partial.unlink(missing_ok=True)
        shutil.rmtree(staging)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print filenames from native homes, credentials, or subprocess payloads.
        raise SystemExit("Backup failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
