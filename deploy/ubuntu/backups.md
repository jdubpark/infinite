# Encrypted backups and restore verification

The single-tenant backup uses an owner-generated age identity. Only its public recipient is installed on the server. A snapshot contains the agent home (including native credentials/history), project workspaces, encrypted Infinite records, control home, and `/etc/infinite` configuration. Temporary files and the separate vault/LUKS recovery keys are excluded. The final archive is encrypted before it is written outside the LUKS volume.

The server remains trusted while running: an attacker with active root can read its mounted data. Keeping the backup decryption identity off the server protects the stored archive; it does not make ordinary execution operator-confidential.

## Consistency and failure behavior

All `infinite-host` and `infinite-agent` processes must belong to `infinite.service`; the script rejects other writers under those identities. It freezes the service cgroup, syncs storage, and copies the application directories to a root-private staging directory on the encrypted volume. SQLite database and WAL files are copied together. It then thaws the original processes before compression/encryption. This is a crash-consistent filesystem snapshot, not a snapshot of process memory or an application-wide business transaction.

The copy must finish within 30 seconds. An independent systemd timer thaws the service after 45 seconds even if the backup process is killed. A failed or timed-out copy is not published. Free-space checks preserve a 2 GiB margin plus estimated snapshot capacity on both filesystems. Large workspaces that cannot meet this pause bound need a filesystem snapshot backend rather than a longer pause. Do not run untracked writers as root while taking a backup.

Failed publication does not replace a previous archive. There is no automatic archive deletion or retention pruning yet; monitor capacity and remove obsolete copies only after confirming independent copies and recovery keys.

## Installation

Install distribution `age`, Python 3, GNU tar/coreutils, and the scripts from this directory. Generate the identity on the owner's device with `age-keygen`. The private identity must not be uploaded to the server. [age usage](https://github.com/FiloSottile/age#usage).

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

The separate `vault.key` is required to decrypt Infinite's restored recordings. `storage.key` unlocks the original LUKS volume; a replacement host can use a new encrypted volume and restore these logical files with appropriate numeric owners and modes. Keep provider credentials and restored plaintext in a private location, and remove temporary restore copies after verification.

A successful data restore does not prove unattended cold-boot recovery or preservation of an OS process through a server reboot. The current server starts locked after a reboot and needs the owner's recovery material. Native provider recovery must inspect interrupted operations and must not automatically repeat unconfirmed tool calls.
