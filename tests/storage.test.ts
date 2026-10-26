import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleVolumes } from "../packages/host/src/desktop.js";
import { storageShortfall, volumeFullness, volumeUsage } from "../packages/host/src/storage.js";

test("volumeUsage reports byte and inode capacity for the filesystem containing a directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inf-storage-"));
  try {
    const usage = await volumeUsage(directory);
    assert.equal(usage.path, directory);
    assert.ok(usage.totalBytes > 0);
    assert.ok(usage.availableBytes >= 0);
    assert.ok(usage.totalInodes > 0);
    assert.ok(usage.availableInodes >= 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sampleVolumes includes configured roots and deduplicates a shared filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inf-storage-"));
  try {
    const volumes = await sampleVolumes({ stateDir: directory, teams: { workspaceDir: directory } });
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0].label, "state");
    assert.equal(volumes[0].path, directory);
    assert.ok(volumes[0].totalBytes && volumes[0].totalInodes && volumes[0].availableBytes !== null && volumes[0].availableInodes !== null);
    assert.ok(volumes[0].availableBytes! >= 0 && volumes[0].availableInodes! >= 0);
    assert.ok(Number.isFinite(volumes[0].fullness));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("volumeFullness uses the scarcer of bytes and inodes", () => {
  assert.equal(volumeFullness({ path: ".", totalBytes: 100, availableBytes: 5, totalInodes: 100, availableInodes: 60 }), 0.95);
  assert.equal(volumeFullness({ path: ".", totalBytes: 100, availableBytes: 40, totalInodes: 100, availableInodes: 2 }), 0.98);
});

test("storageShortfall explains inode and byte floors and allows sufficient headroom", () => {
  const floor = { inodes: 300_000, bytes: 2 * 1024 ** 3 };
  const inodeMessage = storageShortfall({ path: ".", totalBytes: 10 * 1024 ** 3, availableBytes: 5 * 1024 ** 3, totalInodes: 1_000_000, availableInodes: 123_456 }, floor);
  assert.match(inodeMessage ?? "", /123,456 free inodes; new runs need at least 300,000/);
  const byteMessage = storageShortfall({ path: ".", totalBytes: 10 * 1024 ** 3, availableBytes: 1024 ** 3, totalInodes: 1_000_000, availableInodes: 400_000 }, floor);
  assert.match(byteMessage ?? "", /1 GiB free; new runs need at least 2 GiB/);
  assert.equal(storageShortfall({ path: ".", totalBytes: 10 * 1024 ** 3, availableBytes: 3 * 1024 ** 3, totalInodes: 1_000_000, availableInodes: 400_000 }, floor), undefined);
});
