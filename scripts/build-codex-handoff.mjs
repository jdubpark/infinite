#!/usr/bin/env node
// Prepare Infinite's backend without replacing the installed Codex frontend.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(`Prepare the qualified Codex 0.162.0 app-server for Infinite.

node scripts/build-codex-handoff.mjs

Requires npm, tar, patch, rustup, and an already installed Rust 1.95.0 toolchain.
Linux builds also require pkg-config and the OpenSSL and libcap development
packages (pkg-config, libssl-dev and libcap-dev on Ubuntu).
Builds an alternate app-server from official release source and packages the
matching official code-mode helper under ignored .local/. It does not install
Rust or replace the installed Codex.
The provider qualification runs before the backend is published for new sessions.
The patch exposes live environment selection; it does not add a process fence.`);
  process.exit(0);
}
if (process.argv.length > 2) throw new Error("Unknown argument. See --help.");
if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))
  throw new Error("Backend preparation supports macOS and Linux on x64 or arm64.");
const version = "0.162.0", toolchain = "1.95.0";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(repository, ".local");
await mkdir(local, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(local, "codex-handoff-build-"));
await chmod(directory, 0o700);
const patchPath = join(repository, "patches", `codex-${version}-execution.patch`);
const patchDigest = createHash("sha256").update(await readFile(patchPath)).digest("hex").slice(0, 12);
const target = join(local, "codex-handoff-target", `${version}-${patchDigest}`);
const run = (command, args, cwd = directory, env = process.env) => new Promise((resolve, reject) => {
  const process = spawn(command, args, { cwd, env, stdio: "inherit" });
  process.once("error", reject);
  process.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
});

try {
  await run("rustup", ["run", toolchain, "cargo", "--version"]);
  const archive = join(directory, "source.tar.gz");
  const response = await fetch(`https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v${version}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Official source download failed (HTTP ${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  await run("tar", ["-xzf", archive, "-C", directory]);
  const source = join(directory, `codex-rust-v${version}`), workspace = join(source, "codex-rs");
  await run("patch", ["-p1", "-i", patchPath], source);
  // The release tag stamps workspace manifests, while its lock metadata still
  // says 0.0.0. Adjust only source-less workspace package versions; registry and
  // Git dependencies remain unchanged and Cargo still builds with --locked.
  const lockPath = join(workspace, "Cargo.lock"), lock = await readFile(lockPath, "utf8");
  const stampedLock = lock.split("\n[[package]]\n").map(block =>
    /^source = /m.test(block) ? block : block.replace(/^version = "0\.0\.0"$/m, `version = "${version}"`)
  ).join("\n[[package]]\n");
  await writeFile(lockPath, stampedLock);
  await run("rustup", ["run", toolchain, "cargo", "build", "--locked", "-j", "4", "-p", "codex-app-server", "--bin", "codex-app-server"], workspace, {
    ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: "0", CARGO_INCREMENTAL: "0",
  });
  // Use the companion shipped in the pinned official distribution. Its V8
  // runtime is distributed as a binary and is not part of the app-server patch.
  const stock = join(directory, "stock");
  await mkdir(stock, { mode: 0o700 });
  await writeFile(join(stock, "package.json"), '{"name":"infinite-codex-runtime","version":"0.0.0","private":true}\n');
  await run("npm", ["install", "--prefix", stock, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", `@openai/codex@${version}`], stock);
  const require = createRequire(join(stock, "package.json"));
  const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
  const platformPackage = codexRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
  const packageMetadata = JSON.parse(await readFile(platformPackage, "utf8"));
  if (packageMetadata.version !== `${version}-${process.platform}-${process.arch}`)
    throw new Error("The official code-mode helper version does not match the backend.");
  const triple = `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "linux" ? "unknown-linux-musl" : "apple-darwin"}`;
  const helper = join(dirname(platformPackage), "vendor", triple, "bin", "codex-code-mode-host");
  // Qualify the complete publishable bundle, including the helper used by
  // code-mode-only models. Direct exec_command probes cannot detect its absence.
  const bundle = join(directory, "bin"), names = ["codex-code-mode-host", "codex-app-server"];
  await mkdir(bundle, { mode: 0o700 });
  for (const name of names) {
    await copyFile(name === "codex-code-mode-host" ? helper : join(target, "debug", name), join(bundle, name));
    await chmod(join(bundle, name), 0o700);
  }
  await run(process.execPath, [join(repository, "scripts/qualify-codex-handoff.mjs"), "--app-server", join(bundle, "codex-app-server")], repository);
  const bin = join(local, "codex-handoff", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  // Publish the same-version companion before making the new backend visible.
  for (const name of names) {
    const staged = join(bin, `.${name}-next`);
    await copyFile(join(bundle, name), staged); await chmod(staged, 0o700);
    await rename(staged, join(bin, name));
  }
  console.log("Qualified backend prepared for new Infinite Codex sessions. Installed Codex is unchanged.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Private build directory: ${directory}`);
  process.exitCode = 1;
}
