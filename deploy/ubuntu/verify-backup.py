#!/usr/bin/env python3
"""Decrypt a backup into a fresh private directory, verify every file, and check SQLite."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--restore-dir", type=Path, required=True)
    parser.add_argument("--sha256", required=True, help="Checksum saved on the owner device at backup receipt")
    args = parser.parse_args()
    os.umask(0o077)
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("Use Python with tarfile's safe data extraction filter (3.12 or newer)")
    with args.archive.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != args.sha256:
            raise RuntimeError("Encrypted archive checksum does not match the owner receipt")
    # Never overwrite an existing project or restore over the live server.
    args.restore_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    external_links = []
    def safe_member(member, destination):
        if member.issym():
            target = Path(destination) / Path(member.name).parent / member.linkname
            if Path(member.linkname).is_absolute() or not target.resolve().is_relative_to(Path(destination).resolve()):
                external_links.append({"path": member.name, "target": member.linkname})
                return None
        return tarfile.data_filter(member, destination)
    child = subprocess.Popen(["age", "--decrypt", "--identity", str(args.identity), str(args.archive)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with tarfile.open(fileobj=child.stdout, mode="r|gz") as archive:
            archive.extractall(args.restore_dir, filter=safe_member)
        while child.stdout.read(65536):
            pass
        if child.wait():
            raise RuntimeError("Backup decryption did not authenticate successfully")
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill(); child.wait()
    manifest = json.loads((args.restore_dir / "manifest.json").read_text())
    if manifest["format"] != 1:
        raise RuntimeError("Unsupported backup format")
    for relative, expected in manifest["files"].items():
        path = args.restore_dir / relative
        if path.is_symlink() or not path.resolve().is_relative_to(args.restore_dir.resolve()):
            raise RuntimeError("Invalid manifest path")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected["sha256"]:
                raise RuntimeError("Restored file failed integrity verification")
        if path.stat().st_size != expected["bytes"]:
            raise RuntimeError("Restored file size differs from the manifest")
    if external_links:
        (args.restore_dir / "external-links.json").write_text(json.dumps(external_links, indent=2) + "\n")
    checked = 0
    for path in (args.restore_dir / "data").rglob("*.db"):
        if path.is_symlink():
            continue
        with path.open("rb") as source:
            if source.read(16) != b"SQLite format 3\x00":
                continue
        # Open the restored copy normally so SQLite can recover its copied WAL.
        with sqlite3.connect(str(path)) as database:
            if database.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("A restored SQLite database failed integrity checking")
        checked += 1
    print(json.dumps({"verifiedFiles": len(manifest["files"]), "sqliteDatabases": checked, "createdAt": manifest["createdAt"], "pauseSeconds": manifest["pauseSeconds"], "externalSymlinksSkipped": len(external_links), "restoreVerified": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("Restore verification failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
