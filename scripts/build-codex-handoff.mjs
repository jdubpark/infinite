#!/usr/bin/env node
// Prepare Infinite's backend without replacing the installed Codex frontend.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(`Prepare the qualified Codex 0.162.0 app-server for Infinite.

node scripts/build-codex-handoff.mjs

Requires tar, patch, rustup, and an already installed Rust 1.95.0 toolchain.
Downloads the official release source and builds only an alternate app-server
under ignored .local/. It does not install Rust or replace the installed Codex.
The provider qualification runs before the backend is published for new sessions.
The patch exposes live environment selection; it does not add a process fence.`);
  process.exit(0);
}
if (process.argv.length > 2) throw new Error("Unknown argument. See --help.");
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
  const binary = join(target, "debug", "codex-app-server");
  await run(process.execPath, [join(repository, "scripts/qualify-codex-handoff.mjs"), "--app-server", binary], repository);
  const bin = join(local, "codex-handoff", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const staged = join(bin, ".codex-app-server-next");
  await copyFile(binary, staged); await chmod(staged, 0o700);
  await rename(staged, join(bin, "codex-app-server"));
  console.log("Qualified backend prepared for new Infinite Codex sessions. Installed Codex is unchanged.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Private build directory: ${directory}`);
  process.exitCode = 1;
}
