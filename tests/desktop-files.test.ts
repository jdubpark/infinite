import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopFiles } from "../packages/host/src/desktop.js";
import type { Config } from "../packages/host/src/types.js";

test("DesktopFiles.directory preserves existing 0o700 directory mode while applying 0o2770 to new children", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-desktop-files-")));
  const projectDir = join(root, "project");
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const keyFile = join(root, "host.key");
  mkdirSync(projectDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(runDir, { mode: 0o700 });
  chownSync(projectDir, process.getuid!(), process.getgid!());

  const existing = join(projectDir, "private-existing");
  mkdirSync(existing, { mode: 0o700 });
  chownSync(existing, process.getuid!(), process.getgid!());

  const probe = join(root, "setgid-probe");
  mkdirSync(probe, { mode: 0o700 });
  chownSync(probe, process.getuid!(), process.getgid!());
  chmodSync(probe, 0o2770);
  const supportsSetgid = (statSync(probe).mode & 0o2000) === 0o2000;

  const config = {
    projects: [{ id: "rehearsal", name: "Rehearsal", path: projectDir }],
    stateDir,
    runDir,
    keyFile,
    sync: { sharedGroup: true },
  } as unknown as Config;

  const files = new DesktopFiles(config);
  try {
    const result = await files.directory("rehearsal", "private-existing/shared-child");
    assert.deepEqual(result, { path: "private-existing/shared-child", created: true });
    assert.equal(statSync(existing).mode & 0o7777, 0o700);
    const childMode = statSync(join(existing, "shared-child")).mode & 0o7777;
    assert.equal(childMode & 0o777, 0o770);
    if (supportsSetgid) assert.equal(childMode, 0o2770);
  } finally {
    files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
