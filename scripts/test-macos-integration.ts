import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { inProcessHost } from "../tests/helpers.js";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";

if (process.platform !== "darwin") throw new Error("The native integration check requires macOS");
const host = await inProcessHost();
host.config.remote = { enabled: true };
const closeRemote = connectRemoteAccess(host.server, host.config);
try {
  const status = await new Promise<number>((resolveStatus, reject) => {
    const child = spawn("swift", ["test", "--filter", "DesktopIntegrationTests"], {
      cwd: resolve("apps/macos"), stdio: "inherit",
      env: { ...process.env, INFINITE_TEST_ORIGIN: host.origin, INFINITE_TEST_TOKEN: host.tokens.owner },
    });
    child.once("error", reject);
    child.once("exit", code => resolveStatus(code ?? 1));
  });
  assert.equal(status, 0, "Swift encrypted integration must pass");
  assert.equal(await readFile(join(host.config.projects[0].path, "nested/swift-upload.bin"), "utf8"), "new server content");
} finally { closeRemote(); await host.stop(); }
