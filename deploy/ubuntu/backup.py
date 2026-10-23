#!/usr/bin/env python3
"""Create an age-encrypted, crash-consistent backup of the single-tenant host.

Only the public age recipient is installed on the server. All writers running as
infinite-host/infinite-agent must belong to the explicitly supported service
cgroups. Processes are frozen only while a private staging copy is made on the
encrypted application volume.
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
import re
import shlex
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


def archive_command(staging):
    # PAX ACL records retain named-user access and inherited directory access.
    return ["tar", "--create", "--gzip", "--format=pax", "--acls", "--numeric-owner", "--file=-", "--directory=" + str(staging), "."]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/infinite/backup.json")
    parser.add_argument("--preflight-only", action="store_true", help="Check writer and directory coverage without freezing or copying")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Run this host backup as root")
    os.umask(0o077)
    config_path = Path(args.config)
    info = config_path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Backup configuration must be root-owned and not writable by other users")
    config = json.loads(config_path.read_text())
    base_keys = {"recipient", "outputDir"}
    brain_keys = {"brainService", "brainDirectory", "brainConfig", "brainUnitFiles", "brainRuntimeFiles"}
    if set(config) not in (base_keys, base_keys | brain_keys):
        raise RuntimeError("Backup configuration must use the base schema or the complete brain schema")
    if not brain_keys <= config.keys():
        assert_no_unconfigured_brain_writer()
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
        if args.preflight_only:
            services, groups, names, processes, brain = backup_plan(source, config)
            print(json.dumps({"services": services, "controlGroups": groups, "directories": names,
                              "brainProtected": brain is not None,
                              "brainDatabases": ["knowledge.sqlite3", "routing.sqlite3", "queue.sqlite3"] if brain else [],
                              "writerCount": len(processes), "preflightPassed": True}))
            return
        create_backup(source, output, recipient, config)


def assert_no_unconfigured_brain_writer():
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if b"brain_service.py" in (process / "cmdline").read_bytes():
                raise RuntimeError("A brain writer is running; configure its service, store, and service files before backup")
        except (FileNotFoundError, PermissionError):
            continue


def service_groups(source, brain_service=None, config=None):
    groups = {}
    services = ("infinite.service", "infinite-cmux.service") + ((brain_service,) if brain_service else ())
    for service in services:
        loaded = run("systemctl", "show", service, "-p", "LoadState", "--value")
        if service == "infinite-cmux.service" and loaded == "not-found":
            continue
        if loaded != "loaded" or run("systemctl", "is-active", service) != "active":
            raise RuntimeError("Every installed application service must be active for this online backup")
        group = run("systemctl", "show", service, "--property=ControlGroup", "--value")
        if group != "/system.slice/" + service:
            raise RuntimeError("Application service has an unexpected cgroup; backup refused")
        groups[service] = group
        if service == brain_service:
            fragment = run("systemctl", "show", service, "-p", "FragmentPath", "--value")
            dropins = run("systemctl", "show", service, "-p", "DropInPaths", "--value")
            expected = {str(Path(fragment)), *(str(Path(path)) for path in dropins.split())}
            configured = {str(Path(path)) for path in config["brainUnitFiles"]}
            if not fragment or expected != configured:
                raise RuntimeError("Configured brain unit files do not cover the loaded service and every drop-in")
            exec_start = run("systemctl", "show", service, "-p", "ExecStart", "--value")
            expected_argv = ("/usr/bin/python3", str(Path(config["brainRuntimeFiles"][0])), "--config", str(Path(config["brainConfig"])))
            match = re.search(r"(?:^|\s)argv\[]=([^;]+)", exec_start)
            try:
                unit_argv = tuple(shlex.split(match.group(1).strip())) if match else ()
            except ValueError:
                unit_argv = ()
            main_pid = run("systemctl", "show", service, "-p", "MainPID", "--value")
            try:
                process_argv = tuple((Path("/proc") / main_pid / "cmdline").read_bytes().decode().rstrip("\0").split("\0"))
            except (OSError, UnicodeError):
                process_argv = ()
            if unit_argv != expected_argv or process_argv != expected_argv:
                raise RuntimeError("The brain service command must exactly match its configured writer and JSON path")
            username = run("systemctl", "show", service, "-p", "User", "--value")
            if not username or username == "root":
                raise RuntimeError("The brain writer must run as a dedicated non-root service account")
            try:
                pwd.getpwnam(username)
            except KeyError:
                raise RuntimeError("The brain service account does not exist") from None
    if "infinite-cmux.service" in groups and not (source / "cmux").is_dir():
        raise RuntimeError("The cmux service has no application-volume state directory")
    return groups


def application_writers(groups, brain_service=None):
    users = {"infinite-host", "infinite-agent"}
    if brain_service:
        users.add(run("systemctl", "show", brain_service, "-p", "User", "--value"))
    uids = {pwd.getpwnam(user).pw_uid for user in users}
    processes = {}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid in uids:
                memberships = (process / "cgroup").read_text().splitlines()
                if not any(f"0::{group}" in memberships for group in groups.values()):
                    raise RuntimeError("An application writer is outside the supported service cgroups; stop it before backup")
                processes[process.name] = (process / "stat").read_text().rsplit(")", 1)[1].split()[19]
        except FileNotFoundError:
            continue
    return processes


def backup_plan(source, config):
    brain_keys = {"brainService", "brainDirectory", "brainConfig", "brainUnitFiles", "brainRuntimeFiles"}
    configured_brain = bool(brain_keys & config.keys())
    if configured_brain and not brain_keys <= config.keys():
        raise RuntimeError("Brain protection requires the complete service, store, and service-file configuration")
    brain_service = config.get("brainService")
    brain = None
    if configured_brain:
        brain_directory = Path(config["brainDirectory"])
        brain_config = Path(config["brainConfig"])
        unit_files = config["brainUnitFiles"]
        runtime_files = config["brainRuntimeFiles"]
        if not isinstance(brain_service, str) or brain_service in {"infinite.service", "infinite-cmux.service"} or not brain_service.endswith(".service") or not brain_service.replace("-", "").replace("_", "").replace(".", "").isalnum():
            raise RuntimeError("Invalid brain service unit")
        if not isinstance(unit_files, list) or not unit_files or not all(isinstance(path, str) for path in unit_files):
            raise RuntimeError("At least one explicit brain systemd unit file is required")
        expected_runtime_names = ["brain_service.py", "brain.py", "routing.py", "profiles.json"]
        if (not isinstance(runtime_files, list) or len(runtime_files) != len(expected_runtime_names)
                or not all(isinstance(path, str) for path in runtime_files)
                or [Path(path).name for path in runtime_files] != expected_runtime_names
                or len({Path(path).parent for path in runtime_files[:3]}) != 1
                or Path(runtime_files[3]).parent != Path(runtime_files[0]).parent.parent):
            raise RuntimeError("Brain runtime must explicitly include the writer, its modules, and routing profiles")
        unit_files = [Path(path) for path in unit_files]
        runtime_files = [Path(path) for path in runtime_files]
        if len(set(unit_files)) != len(unit_files):
            raise RuntimeError("Brain systemd unit files must not be duplicated")
        for path, label in ((brain_directory, "brain store"), (brain_config, "brain service configuration"),
                            *((path, "brain systemd unit file") for path in unit_files),
                            *((path, "brain runtime file") for path in runtime_files)):
            if not path.is_absolute() or path.is_symlink() or not path.exists():
                raise RuntimeError("Configured " + label + " must be an existing absolute path")
        if not brain_directory.is_dir() or not brain_config.is_file():
            raise RuntimeError("Configured brain store and service configuration have invalid types")
        if any(not path.is_file() for path in (*unit_files, *runtime_files)):
            raise RuntimeError("Configured brain systemd and runtime files must be regular files")
        if brain_directory.stat().st_dev != source.stat().st_dev:
            raise RuntimeError("Brain store must be on the encrypted application volume")
        if any(path.stat().st_uid != 0 or path.stat().st_mode & 0o022 for path in (brain_config, *unit_files, *runtime_files)):
            raise RuntimeError("Brain configuration, systemd unit, and runtime files must be root-owned and protected")
        try:
            parsed_config = json.loads(brain_config.read_text())
        except (OSError, ValueError):
            raise RuntimeError("Brain service configuration is unreadable or invalid") from None
        if not isinstance(parsed_config, dict) or parsed_config.get("directory") != str(brain_directory):
            raise RuntimeError("Brain service configuration does not name the backed up store directory")
        if any(path.resolve() == brain_directory.resolve() or path.resolve() in brain_directory.resolve().parents
               or brain_directory.resolve() in path.resolve().parents for path in (source / name for name in ("control", "control-home", "agent-home", "workspaces", "cmux")) if path.exists()):
            raise RuntimeError("Brain store must not overlap another application snapshot directory")
        for database in ("knowledge.sqlite3", "routing.sqlite3", "queue.sqlite3"):
            path = brain_directory / database
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Brain store must contain all three supported SQLite databases")
        for directory, subdirs, files in os.walk(brain_directory, followlinks=False):
            current = Path(directory)
            if current.stat().st_dev != source.stat().st_dev:
                raise RuntimeError("Every brain store file must be on the encrypted application volume")
            if any((current / name).is_symlink() or (current / name).stat().st_dev != source.stat().st_dev for name in subdirs + files):
                raise RuntimeError("Brain store cannot contain symlinks or cross-volume files")
        brain_uid = pwd.getpwnam(run("systemctl", "show", brain_service, "-p", "User", "--value")).pw_uid
        if brain_directory.stat().st_uid != brain_uid or stat.S_IMODE(brain_directory.stat().st_mode) != 0o700:
            raise RuntimeError("Brain store must be owned by its service account with private directory permissions")
        for database in ("knowledge.sqlite3", "routing.sqlite3", "queue.sqlite3"):
            info = (brain_directory / database).stat()
            if info.st_uid != brain_uid or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError("Brain databases must be owned by the service account with mode 0600")
        brain = {"directory": brain_directory, "config": brain_config, "unitFiles": unit_files, "runtimeFiles": runtime_files}
    groups = service_groups(source, brain_service, config)
    processes = application_writers(groups, brain_service)
    names = ("control", "control-home", "agent-home", "workspaces")
    if (source / "cmux").exists() or (source / "cmux").is_symlink():
        names += ("cmux",)
    for name in names:
        path = source / name
        if path.is_symlink() or not path.is_dir() or path.stat().st_dev != source.stat().st_dev:
            raise RuntimeError("Application snapshot directories must be real directories on the encrypted volume")
    if brain:
        names += ("brain",)
    return list(groups), groups, names, processes, brain


def thaw_services(services):
    failed = False
    for service in services:
        try:
            run("systemctl", "thaw", service, timeout=5)
        except (subprocess.SubprocessError, OSError):
            failed = True
    if failed:
        raise RuntimeError("An application service did not thaw; the independent watchdog remains armed")


def create_backup(source, output, recipient, config):
    service = "infinite.service"
    services, groups, names, processes, brain = backup_plan(source, config)
    required = sum(int(run("du", "--summarize", "--block-size=1", str(brain["directory"] if name == "brain" else source / name)).split()[0]) for name in names)
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
        run("systemd-run", "--quiet", "--unit=" + thaw_unit, "--on-active=45s", "/usr/bin/systemctl", "thaw", *services)
        started = time.monotonic()
        try:
            frozen = True
            run("systemctl", "freeze", *services, timeout=5)
            if any(run("systemctl", "show", unit, "-p", "FreezerState", "--value") != "frozen" for unit in services):
                raise RuntimeError("An application service did not freeze")
            if service_groups(source, config.get("brainService"), config) != groups:
                raise RuntimeError("Application services changed during backup")
            processes = application_writers(groups, config.get("brainService"))
            run("sync", "-f", str(source), timeout=5)
            data = staging / "data"; data.mkdir(mode=0o700)
            # The dedicated temporary directory is omitted. Native homes are
            # copied in full, including databases and WAL/rollback journals.
            for name in names:
                budget = 30 - (time.monotonic() - started)
                if budget <= 0:
                    raise RuntimeError("Snapshot pause exceeded 30 seconds; use filesystem snapshots for larger workspaces")
                original = brain["directory"] if name == "brain" else source / name
                run("cp", "-a", "-x", "--reflink=auto", str(original), str(data / name), timeout=budget)
            if any(run("systemctl", "show", unit, "-p", "FreezerState", "--value") != "frozen" for unit in services):
                raise RuntimeError("Watchdog thawed during the copy; snapshot rejected")
            if service_groups(source, config.get("brainService"), config) != groups:
                raise RuntimeError("Application services changed during backup")
            application_writers(groups, config.get("brainService"))
        finally:
            if frozen:
                thaw_services(services)
                frozen = False
            run("systemctl", "stop", thaw_unit + ".timer", timeout=5)
        pause_seconds = round(time.monotonic() - started, 3)
        shutil.copytree("/etc/infinite", staging / "config", symlinks=True)
        if brain:
            shutil.copy2(brain["config"], staging / "config" / "brain-service.json")
            systemd = staging / "config" / "brain-systemd"
            systemd.mkdir(mode=0o700)
            for index, path in enumerate(brain["unitFiles"]):
                shutil.copy2(path, systemd / (str(index) + "-" + path.name))
            runtime = staging / "config" / "brain-runtime"
            runtime.mkdir(mode=0o700)
            (runtime / "scripts").mkdir(mode=0o700)
            for path in brain["runtimeFiles"]:
                relative = Path("profiles.json") if path.name == "profiles.json" else Path("scripts") / path.name
                shutil.copy2(path, runtime / relative)
        # Age, vault, and LUKS keys are recovered separately from the owner's device.
        manifest = {"format": 1, "createdAt": stamp, "consistency": "process-frozen-crash-consistent", "pauseSeconds": pause_seconds,
                    "service": service, "services": services, "controlGroups": groups, "processStartTicks": processes, "release": os.path.realpath("/opt/infinite"),
                    "brain": ({"service": config["brainService"], "databases": ["knowledge.sqlite3", "routing.sqlite3", "queue.sqlite3"],
                               "config": "config/brain-service.json", "unitFiles": ["config/brain-systemd/" + str(i) + "-" + path.name for i, path in enumerate(brain["unitFiles"])],
                               "runtimeFiles": ["config/brain-runtime/" + ("" if path.name == "profiles.json" else "scripts/") + path.name for path in brain["runtimeFiles"]]} if brain else None),
                    "keyRecovery": "owner-held age identity, vault.key, and storage.key; not included",
                    "offHostCoverage": {"automaticUpload": False, "independentCopy": "owner-download-required"},
                    "filesystemMetadata": {"format": "gnu-tar-pax", "posixACLs": True, "numericOwners": True}, "files": {}}
        for path in staging.rglob("*"):
            if path.is_file() and not path.is_symlink():
                manifest["files"][str(path.relative_to(staging))] = {"sha256": digest(path), "bytes": path.stat().st_size}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        with partial.open("xb") as target:
            tar = subprocess.Popen(archive_command(staging), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
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
                   "serviceState": run("systemctl", "show", service, "-p", "FreezerState", "--value"),
                   "serviceStates": {unit: run("systemctl", "show", unit, "-p", "FreezerState", "--value") for unit in services}}
        (output / (stamp + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))
    finally:
        if frozen:
            for unit in services:
                try:
                    subprocess.run(["systemctl", "thaw", unit], timeout=10, capture_output=True)
                except (subprocess.SubprocessError, OSError):
                    pass
        partial.unlink(missing_ok=True)
        shutil.rmtree(staging)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print filenames from native homes, credentials, or subprocess payloads.
        raise SystemExit("Backup failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
