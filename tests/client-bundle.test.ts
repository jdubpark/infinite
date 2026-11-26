import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

test("bundled client-entry runs CLI help without triggering standalone entrypoints", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-client-bundle-")));
  try {
    const bundle = await build({
      entryPoints: [resolve("packages/host/src/client-entry.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);' },
    });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    const bundlePath = join(root, "client-entry.js");
    writeFileSync(bundlePath, bundle.outputFiles[0]!.contents);
    const result = spawnSync(process.execPath, [bundlePath, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes("workspace-trust"), result.stderr);
    assert.ok(!result.stderr.includes("process-census"), result.stderr);
    assert.ok(result.stdout.includes("Infinite — cloud sessions in your native terminal"));
    assert.ok(result.stdout.includes("usage repairs"));
    assert.ok(result.stdout.includes("usage interrupted"));
    assert.ok(result.stdout.includes("mission watch"));
    assert.ok(result.stdout.includes("team watch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace-trust still runs as a standalone CLI entrypoint", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/workspace-trust.ts")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 64, result.stderr);
  assert.ok(result.stderr.includes("Usage: INFINITE_TRUSTED_WORKSPACE=DIR workspace-trust claude"), result.stderr);
});
