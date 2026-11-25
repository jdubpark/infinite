#!/usr/bin/env python3
import hashlib
import os
import tempfile
from pathlib import Path


def install() -> None:
    project = Path(__file__).resolve().parent.parent
    parent = Path.home() / ".local" / "share" / "infinite" / "cloud-check"
    command = Path.home() / ".local" / "bin" / "infinite-check"
    if os.path.lexists(command) and not (command.is_symlink() and command.resolve().is_relative_to(parent)):
        raise SystemExit(f"An unmanaged command already exists at {command}")
    paths = (".nvmrc", "package.json", "scripts/cloud-check.py", "scripts/cloud-check/worker.py",
             "scripts/cloud-check/bootstrap.py", "scripts/cloud-check/linux-runner.json")
    files = {name: (project / name).read_bytes() for name in paths}
    fingerprint = hashlib.sha256(b"".join(hashlib.sha256(data).digest() for data in files.values()))
    runtime = parent / fingerprint.hexdigest()
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    command.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary:
        staging = Path(temporary) / "runtime"
        if not runtime.is_dir():
            for name, data in files.items():
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            (staging / "scripts/cloud-check.py").chmod(0o700)
            try:
                staging.rename(runtime)
            except OSError:
                if not runtime.is_dir():
                    raise
        with tempfile.TemporaryDirectory(dir=command.parent) as links:
            link = Path(links) / command.name
            link.symlink_to(runtime / "scripts/cloud-check.py")
            os.replace(link, command)
    print(f"Installed {command}")


if __name__ == "__main__":
    install()
