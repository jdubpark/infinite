import assert from "node:assert/strict";
import { chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPtySpawnHelper,
  describePtySpawnError,
  ptyDoctorLine,
  ptyStartupWarning,
  resolvePtySpawnHelperPath,
  type PtyPreflightStat,
} from "../packages/host/src/pty-preflight.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "infinite-pty-preflight-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeStat(mode: number, uid = 1000, kind: "file" | "dir" = "file"): PtyPreflightStat {
  return {
    mode,
    uid,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
  };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated filesystem error`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("resolvePtySpawnHelperPath follows node-pty loadNativeModule fallback order", () => {
  const pkgPath = "/home/dev/projects/infinite/node_modules/node-pty/package.json";
  const prebuilt = resolvePtySpawnHelperPath({
    platform: "darwin",
    arch: "arm64",
    resolvePkg: () => pkgPath,
    canLoadAddon: () => false,
  });
  assert.equal(prebuilt, "/home/dev/projects/infinite/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");

  const releaseBuild = resolvePtySpawnHelperPath({
    platform: "darwin",
    arch: "arm64",
    resolvePkg: () => pkgPath,
    canLoadAddon: candidate => candidate.endsWith("/build/Release/pty.node"),
  });
  assert.equal(releaseBuild, "/home/dev/projects/infinite/node_modules/node-pty/build/Release/spawn-helper");

  const debugBuild = resolvePtySpawnHelperPath({
    platform: "darwin",
    arch: "arm64",
    resolvePkg: () => pkgPath,
    canLoadAddon: candidate => candidate.endsWith("/build/Debug/pty.node"),
  });
  assert.equal(debugBuild, "/home/dev/projects/infinite/node_modules/node-pty/build/Debug/spawn-helper");

  const missing = resolvePtySpawnHelperPath({
    platform: "darwin",
    arch: "arm64",
    resolvePkg: () => {
      throw new Error("Cannot find module 'node-pty/package.json'");
    },
  });
  assert.equal(missing, undefined);
});

test("checkPtySpawnHelper inspects active loaded addon helper and falls back past unloadable Release builds", () => {
  withTempDir(dir => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, "{}");
    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const prebuildHelper = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(prebuildHelper, "prebuilt-helper");
    chmodSync(prebuildHelper, 0o644);

    const releaseDir = join(dir, "build", "Release");
    const releaseHelper = join(releaseDir, "spawn-helper");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "pty.node"), "native-addon");
    writeFileSync(releaseHelper, "built-helper");
    chmodSync(releaseHelper, 0o755);

    const activeRelease = checkPtySpawnHelper({
      platform: "darwin",
      arch: "arm64",
      resolvePkg: () => pkgPath,
      canLoadAddon: candidate => candidate === join(releaseDir, "pty.node"),
    });
    assert.deepEqual(activeRelease, { status: "ok", helperPath: releaseHelper });

    const unloadableReleaseFallsBack = checkPtySpawnHelper({
      platform: "darwin",
      arch: "arm64",
      resolvePkg: () => pkgPath,
      canLoadAddon: () => false,
    });
    assert.deepEqual(unloadableReleaseFallsBack, {
      status: "missing-exec-bit",
      helperPath: prebuildHelper,
      fixCommand: `chmod +x ${prebuildHelper}`,
    });
  });
});

test("checkPtySpawnHelper detects missing execute bit on darwin without mutating file mode", () => {
  withTempDir(dir => {
    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(helperPath, "stub-helper");
    chmodSync(helperPath, 0o644);

    const result = checkPtySpawnHelper({ platform: "darwin", helperPath });
    assert.deepEqual(result, {
      status: "missing-exec-bit",
      helperPath,
      fixCommand: `chmod +x ${helperPath}`,
    });
    assert.equal(statSync(helperPath).mode & 0o777, 0o644);
  });
});

test("checkPtySpawnHelper uses effective process access and host-account ownership for remediation", () => {
  const helperPath = "/opt/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";

  const rootOwned0744 = checkPtySpawnHelper({
    platform: "darwin",
    helperPath,
    fs: {
      statSync: () => fakeStat(0o744, 0),
      accessSync: (_path, mode) => {
        if ((mode & constants.X_OK) !== 0) throw errnoError("EACCES");
      },
      getuid: () => 501,
    },
  });
  assert.deepEqual(rootOwned0744, {
    status: "missing-exec-bit",
    helperPath,
    fixCommand: `chmod a+x ${helperPath}`,
  });

  const installerOwned0000 = checkPtySpawnHelper({
    platform: "darwin",
    helperPath,
    fs: {
      statSync: () => fakeStat(0o000, 0),
      accessSync: () => {
        throw errnoError("EACCES");
      },
      getuid: () => 501,
    },
  });
  assert.deepEqual(installerOwned0000, {
    status: "unreadable",
    helperPath,
    fixCommand: `chmod a+rx ${helperPath}`,
  });

  const installerOwned0644 = checkPtySpawnHelper({
    platform: "darwin",
    helperPath,
    fs: {
      statSync: () => fakeStat(0o644, 0),
      accessSync: (_path, mode) => {
        if ((mode & constants.X_OK) !== 0) throw errnoError("EACCES");
      },
      getuid: () => 501,
    },
  });
  assert.deepEqual(installerOwned0644, {
    status: "missing-exec-bit",
    helperPath,
    fixCommand: `chmod a+x ${helperPath}`,
  });
});

test("checkPtySpawnHelper reports inaccessible on production statSync EACCES instead of file chmod", () => {
  const helperPath = "/opt/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
  const result = checkPtySpawnHelper({
    platform: "darwin",
    helperPath,
    fs: {
      statSync: () => {
        throw errnoError("EACCES");
      },
    },
  });
  assert.deepEqual(result, { status: "inaccessible", helperPath });
});

test("checkPtySpawnHelper shell-quotes remediation command when helper path has spaces", () => {
  withTempDir(dir => {
    const prebuildDir = join(dir, "my workspace", "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(helperPath, "stub-helper");
    chmodSync(helperPath, 0o644);

    const result = checkPtySpawnHelper({ platform: "darwin", helperPath });
    assert.deepEqual(result, {
      status: "missing-exec-bit",
      helperPath,
      fixCommand: `chmod +x '${helperPath}'`,
    });
    assert.equal(statSync(helperPath).mode & 0o777, 0o644);
  });
});

test("checkPtySpawnHelper returns ok for executable regular file on darwin", () => {
  withTempDir(dir => {
    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(helperPath, "stub-helper");
    chmodSync(helperPath, 0o755);

    const result = checkPtySpawnHelper({ platform: "darwin", helperPath });
    assert.deepEqual(result, { status: "ok", helperPath });
    assert.equal(statSync(helperPath).mode & 0o777, 0o755);
  });
});

test("checkPtySpawnHelper returns not-applicable on non-darwin platforms", () => {
  withTempDir(dir => {
    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(helperPath, "stub-helper");
    chmodSync(helperPath, 0o644);

    assert.deepEqual(checkPtySpawnHelper({ platform: "linux", helperPath }), { status: "not-applicable" });
    assert.deepEqual(checkPtySpawnHelper({ platform: "win32", helperPath }), { status: "not-applicable" });
    assert.equal(statSync(helperPath).mode & 0o777, 0o644);
  });
});

test("checkPtySpawnHelper distinguishes absent prebuilds from missing binary and invalid entries", () => {
  withTempDir(dir => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, "{}");

    const noPrebuildDir = checkPtySpawnHelper({
      platform: "darwin",
      arch: "arm64",
      resolvePkg: () => pkgPath,
    });
    assert.deepEqual(noPrebuildDir, { status: "not-applicable" });

    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });

    const missingBinary = checkPtySpawnHelper({
      platform: "darwin",
      arch: "arm64",
      resolvePkg: () => pkgPath,
    });
    assert.deepEqual(missingBinary, { status: "missing-binary", helperPath });

    mkdirSync(helperPath, { mode: 0o755 });
    const dirInsteadOfFile = checkPtySpawnHelper({ platform: "darwin", helperPath });
    assert.deepEqual(dirInsteadOfFile, { status: "missing-binary", helperPath });
  });

  const unresolved = checkPtySpawnHelper({
    platform: "darwin",
    arch: "arm64",
    resolvePkg: () => {
      throw new Error("not installed");
    },
  });
  assert.deepEqual(unresolved, { status: "not-applicable" });
});

test("checkPtySpawnHelper flags owner-unreadable files without mutating mode", () => {
  withTempDir(dir => {
    const prebuildDir = join(dir, "prebuilds", "darwin-arm64");
    const helperPath = join(prebuildDir, "spawn-helper");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(helperPath, "stub-helper");
    chmodSync(helperPath, 0o100);
    try {
      const result = checkPtySpawnHelper({ platform: "darwin", helperPath });
      assert.deepEqual(result, {
        status: "unreadable",
        helperPath,
        fixCommand: `chmod u+rx ${helperPath}`,
      });
      assert.equal(statSync(helperPath).mode & 0o777, 0o100);
    } finally {
      chmodSync(helperPath, 0o600);
    }
  });
});

test("describePtySpawnError enriches posix_spawnp failures for all unhealthy states and passes through others", () => {
  const helperPath = "/opt/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
  const missingExec = {
    status: "missing-exec-bit" as const,
    helperPath,
    fixCommand: `chmod +x ${helperPath}`,
  };

  const enriched = describePtySpawnError(new Error("posix_spawnp failed."), missingExec);
  assert.match(enriched, /posix_spawnp failed\./);
  assert.ok(enriched.includes(helperPath));
  assert.ok(enriched.includes(`chmod +x ${helperPath}`));

  const unrelated = describePtySpawnError(new Error("File not found: missing-cli"), missingExec);
  assert.equal(unrelated, "File not found: missing-cli");

  assert.equal(describePtySpawnError(new Error("posix_spawnp failed."), { status: "ok", helperPath }), "posix_spawnp failed.");
  assert.equal(describePtySpawnError(new Error("posix_spawnp failed."), { status: "not-applicable" }), "posix_spawnp failed.");

  const missingBin = describePtySpawnError(new Error("posix_spawnp failed."), { status: "missing-binary", helperPath });
  assert.match(missingBin, /posix_spawnp failed\./);
  assert.ok(missingBin.includes(helperPath));
  assert.match(missingBin, /npm ci/);

  const inaccessible = describePtySpawnError(new Error("posix_spawnp failed."), { status: "inaccessible", helperPath });
  assert.match(inaccessible, /could not inspect/i);
  assert.match(inaccessible, /directory access permissions/);
  assert.ok(!inaccessible.includes("chmod"));
});

test("ptyDoctorLine and ptyStartupWarning format status and warning lines cleanly", () => {
  const helperPath = "/opt/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";

  assert.equal(ptyDoctorLine({ status: "not-applicable" }), undefined);
  assert.equal(ptyDoctorLine({ status: "ok", helperPath }), `PTY helper: ok (${helperPath})`);
  assert.equal(ptyStartupWarning({ status: "not-applicable" }), undefined);
  assert.equal(ptyStartupWarning({ status: "ok", helperPath }), undefined);

  const execWarning = ptyDoctorLine({
    status: "missing-exec-bit",
    helperPath,
    fixCommand: `chmod +x ${helperPath}`,
  });
  assert.ok(execWarning);
  assert.match(execWarning, /^Warning: PTY helper is not executable/);
  assert.ok(execWarning.includes(helperPath));
  assert.ok(execWarning.includes(`chmod +x ${helperPath}`));
  assert.equal(ptyStartupWarning({ status: "missing-exec-bit", helperPath, fixCommand: `chmod +x ${helperPath}` }), execWarning);

  const missingWarning = ptyDoctorLine({ status: "missing-binary", helperPath });
  assert.ok(missingWarning);
  assert.match(missingWarning, /^Warning: PTY helper is missing/);
  assert.ok(missingWarning.includes(helperPath));

  const unreadableWarning = ptyDoctorLine({
    status: "unreadable",
    helperPath,
    fixCommand: `chmod u+rx ${helperPath}`,
  });
  assert.ok(unreadableWarning);
  assert.match(unreadableWarning, /^Warning: PTY helper is not readable/);
  assert.ok(unreadableWarning.includes(`chmod u+rx ${helperPath}`));

  const inaccessibleWarning = ptyDoctorLine({ status: "inaccessible", helperPath });
  assert.ok(inaccessibleWarning);
  assert.match(inaccessibleWarning, /^Warning: could not inspect PTY helper/);
  assert.match(inaccessibleWarning, /directory access permissions/);
  assert.ok(!inaccessibleWarning.includes("chmod"));
});
