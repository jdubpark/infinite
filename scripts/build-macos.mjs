import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The desktop app requires macOS and Xcode command-line tools.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".local/desktop-dependencies");
const output = join(root, ".local/desktop");
const sdk = join(cache, "CmuxTerminalClient.xcframework/macos");
const run = (command, args, options = {}) => new Promise((done, reject) => {
  const process = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
  process.on("error", reject); process.on("exit", code => code === 0 ? done() : reject(new Error(`${command} exited ${code}`)));
});
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });

async function download(name, url, digest, algorithm = "sha256", encoding = "hex", reuse) {
  const target = join(cache, name);
  const valid = async path => {
    try { return createHash(algorithm).update(await readFile(path)).digest(encoding) === digest; } catch { return false; }
  };
  if (await valid(target)) return target;
  if (reuse && await valid(reuse)) await copyFile(reuse, target);
  else {
    console.log(`Downloading pinned desktop dependency: ${name}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Dependency download failed: ${response.status}`);
    const temporary = target + ".partial";
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    if (!await valid(temporary)) { await rm(temporary); throw new Error(`Checksum mismatch: ${name}`); }
    await rename(temporary, target);
  }
  return target;
}

const archive = await download("terminal-client.zip",
  "https://github.com/manaflow-ai/cmux/releases/download/cmux-terminal-client-v0.1.0%2B6ba5de550cd4/CmuxTerminalClient.xcframework.zip",
  "ecda518668cb64ad54c25869dd0996fc99e63c738bfa5e176b2b524d78290681", "sha256", "hex",
  join(root, ".local/cmux-evaluation/transport-probe/client.zip"));
await run("unzip", ["-oq", archive, "CmuxTerminalClient.xcframework/macos/*", "CmuxTerminalClient.xcframework/Info.plist", "-d", cache]);
const architecture = process.arch;
if (!["arm64", "x64"].includes(architecture)) throw new Error("Unsupported macOS architecture");
const helper = await download(`cmux-${architecture}.tgz`,
  `https://registry.npmjs.org/cmux-tui-darwin-${architecture}/-/cmux-tui-darwin-${architecture}-0.13.4.tgz`,
  architecture === "arm64" ? "2ccf659012af7c6668dbad6b071ad4eba0d490bf1abcc51996936e060ca73870" : "jNbjhV/blp+DAKYLbbXKp5xxfi6RocNyjZZuK0M5akFMNxkSg64Si0Nf1tQEj9DipIvUeOzHyzBogDUdYMd0aQ==",
  architecture === "arm64" ? "sha256" : "sha512", architecture === "arm64" ? "hex" : "base64",
  join(root, `.local/cmux-evaluation/darwin-${architecture}.tgz`));
await run("tar", ["-xzf", helper, "-C", cache, "package/bin/cmux-tui"]);

const vendor = join(root, "apps/macos/Sources/InfiniteDesktop/Resources/vendor");
await mkdir(vendor, { recursive: true });
for (const [source, target] of [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"], ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-webgl/lib/addon-webgl.js", "addon-webgl.js"],
  ["@xterm/xterm/LICENSE", "xterm-LICENSE"], ["@xterm/addon-fit/LICENSE", "addon-fit-LICENSE"],
  ["@xterm/addon-webgl/LICENSE", "addon-webgl-LICENSE"],
]) await copyFile(join(root, "node_modules", source), join(vendor, target));

const scratch = join(root, ".local/macos-build");
const flags = ["--package-path", "apps/macos", "--scratch-path", scratch, "-c", "release",
  "-Xswiftc", "-F", "-Xswiftc", sdk, "-Xlinker", "-F", "-Xlinker", sdk];
for (const framework of ["CmuxTerminalClientFFI", "Network", "CoreFoundation", "Security", "SystemConfiguration"])
  flags.push("-Xlinker", "-framework", "-Xlinker", framework);
flags.push("-Xlinker", "-lc++");
await run("swift", ["build", ...flags]);
const bundle = join(output, "Infinite-staging.app");
await rm(bundle, { recursive: true, force: true });
await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
await mkdir(join(bundle, "Contents/Resources"), { recursive: true });
await copyFile(join(scratch, "release/InfiniteDesktop"), join(bundle, "Contents/MacOS/Infinite"));
await copyFile(join(cache, "package/bin/cmux-tui"), join(bundle, "Contents/Resources/cmux"));
await chmod(join(bundle, "Contents/MacOS/Infinite"), 0o755);
await chmod(join(bundle, "Contents/Resources/cmux"), 0o755);
await cp(join(root, "apps/macos/Sources/InfiniteDesktop/Resources"), join(bundle, "Contents/Resources/Terminal"), { recursive: true });
await copyFile(join(root, "apps/macos/THIRD-PARTY.md"), join(bundle, "Contents/Resources/THIRD-PARTY.md"));
const iconset = join(output, "Infinite.iconset");
await mkdir(iconset, { recursive: true });
const iconSource = join(output, "icon-source.png");
await run("swift", ["scripts/macos-icon.swift", iconSource]);
for (const size of [16, 32, 128, 256, 512]) {
  await run("sips", ["-z", String(size), String(size), iconSource, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" });
  await run("sips", ["-z", String(size * 2), String(size * 2), iconSource, "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
}
await run("iconutil", ["-c", "icns", iconset, "-o", join(bundle, "Contents/Resources/Infinite.icns")]);
await writeFile(join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.infinite.desktop</string>
<key>CFBundleName</key><string>Infinite</string><key>CFBundleDisplayName</key><string>Infinite</string>
<key>CFBundleExecutable</key><string>Infinite</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>Infinite</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Infinite personal desktop client</string>
</dict></plist>`);
// A stable local development signature keeps Keychain access valid across
// rebuilds. No developer identity is written to project files.
const signingIdentity = process.env.INFINITE_SIGN_IDENTITY ||
  execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).match(/\) ([0-9A-F]{40}) "Apple Development:/)?.[1] || "-";
await run("codesign", ["--force", "--sign", signingIdentity, join(bundle, "Contents/Resources/cmux")]);
await run("codesign", ["--force", "--sign", signingIdentity, bundle]);
await run("codesign", ["--verify", "--deep", "--strict", bundle]);
const finished = join(output, "Infinite.app");
const previousBuild = join(output, "Infinite-previous-build");
await rm(previousBuild, { recursive: true, force: true });
try { await rename(finished, previousBuild); } catch (error) { if (error.code !== "ENOENT") throw error; }
await rename(bundle, finished);
console.log("Built .local/desktop/Infinite.app");
if (process.argv.includes("--install")) {
  const destination = join(homedir(), "Applications/Infinite.app");
  try {
    const previous = await readFile(join(destination, "Contents/Info.plist"), "utf8");
    if (!previous.includes("<string>dev.infinite.desktop</string>")) throw new Error("An unrelated Infinite app already occupies the installation location.");
    const backup = join(output, "Infinite-previous-installation");
    await rm(backup, { recursive: true, force: true });
    await rename(destination, backup);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(destination), { recursive: true });
  await cp(finished, destination, { recursive: true });
  await run("open", [destination]);
  console.log("Installed Infinite in the user Applications folder and requested launch. If it was already running, quit and reopen it to use the new build.");
}
