# Encrypted backups and restore verification

The single-tenant backup uses an owner-generated age identity. Only its public recipient is installed on the server. A snapshot contains the agent home (including native credentials/history), project workspaces, encrypted Infinite records, control home, optional cmux daemon state and enrollment identities, and `/etc/infinite` configuration. When the shared brain service is installed, the snapshot also contains its complete state directory and the configured service JSON, unit fragment, and drop-ins. Temporary files and the separate vault/LUKS recovery keys are excluded. The final archive is encrypted before it is written outside the LUKS volume.

The shared brain has one independent service writer. It stores knowledge, advisory routing observations, and durable queued mutations in `knowledge.sqlite3`, `routing.sqlite3`, and `queue.sqlite3` in the same private directory. Configure all five `brain*` fields in `/etc/infinite/backup.json` to enable protection. The directory must be on the encrypted application volume, owned by the brain service account, and mode 0700. The service JSON must name that exact directory. List the effective systemd unit fragment and every drop-in in `brainUnitFiles`. `brainRuntimeFiles` must list, in order, `brain_service.py`, `brain.py`, `routing.py`, and `profiles.json` from one directory. The supported command is exactly `/usr/bin/python3 <brainRuntimeFiles[0]> --config <brainConfig>`; preflight compares both systemd's effective argv and the running main process argv against it. Config, unit, and runtime files must be root-owned and not writable by group or other users. A partial configuration, missing database, uncovered unit file, unsupported writer, or inactive service fails preflight. A host with no installed brain can keep the base backup configuration; an active unconfigured brain writer blocks the backup.

The server remains trusted while running: an attacker with active root can read its mounted data. Keeping the backup decryption identity off the server protects the stored archive; it does not make ordinary execution operator-confidential.

## Consistency and failure behavior

All `infinite-host` and `infinite-agent` processes must belong to the exact `infinite.service` or installed `infinite-cmux.service` cgroup under `system.slice`; the script rejects other writers under those identities. The configured brain service must also be active in its own exact cgroup, and every process owned by its service account must belong to one of the covered cgroups. The script freezes every covered service before copying, checks service identity and writer membership again while frozen, syncs storage, and copies each data directory to a root-private staging directory on the encrypted volume. It copies the brain directory as a unit, including SQLite database, WAL, shared-memory, and rollback-journal files. A queued operation left in `applying` remains in `queue.sqlite3`; after restore, the service retries it through its normal idempotent writer path. The script then thaws every service before compression/encryption. This is a crash-consistent filesystem snapshot, not a snapshot of process memory or an application-wide business transaction. Restoring cmux state does not restore a live PTY process; reinstall its separately managed runtime and service before reconnecting clients.

The copy must finish within 30 seconds. An independent systemd timer thaws every covered service after 45 seconds even if the backup process is killed. A failed or timed-out copy is not published. A thaw failure does not prevent attempts to thaw the other service and leaves the watchdog armed. Free-space checks preserve a 2 GiB margin plus estimated snapshot capacity on both filesystems. Large workspaces that cannot meet this pause bound need a filesystem snapshot backend rather than a longer pause. Do not run untracked writers as root while taking a backup. `infinite-backup --preflight-only` validates service, writer, and directory coverage without freezing or copying data.

Failed publication does not replace a previous archive. There is no automatic archive deletion or retention pruning yet; monitor capacity and remove obsolete copies only after confirming independent copies and recovery keys.

## Installation

Install distribution `age`, Python 3, GNU tar/coreutils with POSIX ACL support, the `acl` utilities, and the scripts from this directory. Generate the identity on the owner's device with `age-keygen`. The private identity must not be uploaded to the server. [age usage](https://github.com/FiloSottile/age#usage).

```json
{
  "recipient": "age1REPLACE_WITH_OWNER_PUBLIC_RECIPIENT",
  "outputDir": "/data/infinite-backups",
  "brainService": "your-brain.service",
  "brainDirectory": "/srv/infinite-data/brain",
  "brainConfig": "/etc/infinite/brain.json",
  "brainUnitFiles": ["/etc/systemd/system/your-brain.service"],
  "brainRuntimeFiles": [
    "/usr/local/libexec/infinite-brain/scripts/brain_service.py",
    "/usr/local/libexec/infinite-brain/scripts/brain.py",
    "/usr/local/libexec/infinite-brain/scripts/routing.py",
    "/usr/local/libexec/infinite-brain/profiles.json"
  ]
}
```

The brain entries are required when the shared brain service is installed. Add each active systemd drop-in to `brainUnitFiles`. Keep the brain service JSON's `directory` equal to `brainDirectory`; keep the service unit, JSON, and writer runtime recoverable together. The archive preserves the Python modules in `config/brain-runtime/scripts/` with `profiles.json` one directory above, as required by the routing module. Their SHA-256 hashes appear in `manifest.json`. Save the backup configuration as root-owned `/etc/infinite/backup.json`, mode 0600. Install `backup.py` as `/usr/local/libexec/infinite-backup` and the service/timer units into `/etc/systemd/system`. Run preflight, take a backup, and validate recovery before enabling the timer:

```sh
sudo systemctl daemon-reload
sudo /usr/local/libexec/infinite-backup --preflight-only
sudo systemctl start infinite-backup.service
sudo journalctl -u infinite-backup.service --no-pager
# After the owner verifies the downloaded archive:
sudo systemctl enable --now infinite-backup.timer
```

The timer runs daily at 03:30 UTC plus up to 15 minutes of randomized delay. It creates encrypted archives on the server. It does not upload them to independent storage. A manually downloaded encrypted copy protects against server loss only as of its download time. Automatic off-host protection still needs an independent destination, restricted upload credentials, retention rules, and a monitored upload receipt. The backup currently covers none of those upload steps.

## Restore verification

Download an archive through the pinned SSH connection and save its receipt SHA-256 independently on the owner device. On a trusted device with encrypted local storage, use Python 3.12 or newer:

```sh
python3 deploy/ubuntu/verify-backup.py BACKUP.tar.gz.age \
  --identity /private/backup.agekey \
  --restore-dir /private/new-restore-directory \
  --sha256 OWNER_RECEIPT_SHA256
```

The destination must not already exist. The verifier checks the ciphertext checksum, decrypts/authenticates the archive, safely extracts files, verifies every manifest file hash/size, and runs SQLite integrity checks on the restored databases. External symlinks are skipped and listed in `external-links.json`; restore required links only after installing and verifying their external dependencies. It does not follow arbitrary archive links or restore directly over a live environment.

This is a content verification copy, not an operational filesystem restore. Python extraction does not apply numeric owners or POSIX ACLs and may restrict file modes; the receipt reports this explicitly and counts ACL records present in the archive. New archives use GNU tar PAX access/default ACL records. Older archives without those records cannot recover named-user or default ACLs from their file hashes.

The verifier runs SQLite integrity checks, but that does not prove the brain can serve restored records or resume queued work. For a restore rehearsal, use a disposable Linux system with no live service directories mounted. Extract the authenticated archive into a new private directory, restore the numeric owner and mode for `data/brain`, and use the archived runtime files and unit files rather than locally installed brain code. Configure the isolated unit to use that runtime copy and the archived JSON; change only the isolated test copy's socket and allowed test UID if the original values do not fit the recovery environment. Start the writer from that copy; query knowledge, routing recommendations, and queue state through its Unix socket. Include a queued or `applying` job in the rehearsal and confirm the service reports its durable state after restart. Keep the rehearsal disconnected from production agents. Record the restored database names, integrity results, permission checks, and service query results separately from the archive checksum receipt.

For operational recovery, first complete the content check above. Use a fresh isolated Linux recovery environment with encrypted storage and no live application directories mounted. Preserve the original numeric user/group IDs, inspect `external-links.json`, and authenticate the archive completely before restoring its ownership, modes, and ACLs with GNU tar. The recovery destination must be a new empty private directory:

```sh
umask 077
age --decrypt --identity /private/backup.agekey \
  --output /private/authenticated-backup.tar.gz BACKUP.tar.gz.age
mkdir -m 700 /private/new-linux-recovery
sudo tar --extract --gzip --acls --numeric-owner --same-owner \
  --same-permissions --keep-old-files \
  --file=/private/authenticated-backup.tar.gz \
  --directory=/private/new-linux-recovery
```

Verify named access and default ACLs with `getfacl --numeric`, along with modes and numeric ownership, before moving recovered data onto a replacement host. Confirm that the control account can read existing workspace files and newly inherited files while unauthorized accounts remain denied. File hashes and SQLite checks alone do not establish that access controls were restored. Do not activate services until external links and separately installed runtimes have been reviewed. Remove both plaintext verification copies and the decrypted archive after recovery.

The separate `vault.key` is required to decrypt Infinite's restored recordings. `storage.key` unlocks the original LUKS volume; a replacement host can use a new encrypted volume and restore these logical files with appropriate numeric owners and modes. Keep provider credentials and restored plaintext in a private location, and remove temporary restore copies after verification.

A successful data restore does not prove unattended cold-boot recovery or preservation of an OS process through a server reboot. The current server starts locked after a reboot and needs the owner's recovery material. Native provider recovery must inspect interrupted operations and must not automatically repeat unconfirmed tool calls.
