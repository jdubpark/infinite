# Encrypted backups and restore verification

The single-tenant backup uses an owner-generated age identity. Only its public recipient is installed on the server. A snapshot contains the agent home (including native credentials/history), project workspaces, encrypted Infinite records, control home, optional cmux daemon state and enrollment identities, and `/etc/infinite` configuration. Temporary files and the separate vault/LUKS recovery keys are excluded. The final archive is encrypted before it is written outside the LUKS volume.

The server remains trusted while running: an attacker with active root can read its mounted data. Keeping the backup decryption identity off the server protects the stored archive; it does not make ordinary execution operator-confidential.

## Consistency and failure behavior

All `infinite-host` and `infinite-agent` processes must belong to the exact `infinite.service` or installed `infinite-cmux.service` cgroup under `system.slice`; the script rejects other writers under those identities. Both installed services must be active. It freezes all supported service cgroups before copying, checks writer membership again while frozen, syncs storage, and copies the application directories to a root-private staging directory on the encrypted volume. SQLite database and WAL files are copied together, including cmux `.sqlite3` databases. It then thaws every service before compression/encryption. This is a crash-consistent filesystem snapshot, not a snapshot of process memory or an application-wide business transaction. Restoring cmux state does not restore a live PTY process; reinstall its separately managed runtime and service before reconnecting clients.

The copy must finish within 30 seconds. An independent systemd timer thaws every covered service after 45 seconds even if the backup process is killed. A failed or timed-out copy is not published. A thaw failure does not prevent attempts to thaw the other service and leaves the watchdog armed. Free-space checks preserve a 2 GiB margin plus estimated snapshot capacity on both filesystems. Large workspaces that cannot meet this pause bound need a filesystem snapshot backend rather than a longer pause. Do not run untracked writers as root while taking a backup. `infinite-backup --preflight-only` validates service, writer, and directory coverage without freezing or copying data.

Failed publication does not replace a previous archive. There is no automatic archive deletion or retention pruning yet; monitor capacity and remove obsolete copies only after confirming independent copies and recovery keys.

## Installation

Install distribution `age`, Python 3, GNU tar/coreutils with POSIX ACL support, the `acl` utilities, and the scripts from this directory. Generate the identity on the owner's device with `age-keygen`. The private identity must not be uploaded to the server. [age usage](https://github.com/FiloSottile/age#usage).

```json
{
  "recipient": "age1REPLACE_WITH_OWNER_PUBLIC_RECIPIENT",
  "outputDir": "/data/infinite-backups"
}
```

Save this as root-owned `/etc/infinite/backup.json`, mode 0600. Install `backup.py` as `/usr/local/libexec/infinite-backup` and the service/timer units into `/etc/systemd/system`. Run a backup and validate recovery before enabling the timer:

```sh
sudo systemctl daemon-reload
sudo systemctl start infinite-backup.service
sudo journalctl -u infinite-backup.service --no-pager
# After the owner verifies the downloaded archive:
sudo systemctl enable --now infinite-backup.timer
```

The timer runs daily at 03:30 UTC plus up to 15 minutes of randomized delay. It creates encrypted archives on the rented host. **It does not upload them to independent storage.** An S3-compatible destination/account and restricted upload credentials remain necessary for automatic off-host protection while the laptop is offline. A manually downloaded encrypted laptop copy is already independent of the rented server, but its freshness stops when the laptop is disconnected.

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
