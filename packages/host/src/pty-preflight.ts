import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SOURCE_BUILD_DIRS = ["build/Release", "build/Debug"] as const;

export interface PtyPreflightStat {
  mode: number;
  uid?: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface PtyPreflightFs {
  statSync(path: string): PtyPreflightStat;
  accessSync(path: string, mode: number): void;
  getuid?: () => number | undefined;
}

const NODE_PREFLIGHT_FS: PtyPreflightFs = {
  statSync: path => statSync(path),
  accessSync: (path, mode) => accessSync(path, mode),
  getuid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
};

export interface ResolvePtySpawnHelperOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePkg?: () => string;
  canLoadAddon?: (addonPath: string) => boolean;
  fs?: Pick<PtyPreflightFs, "statSync">;
}

export type PtySpawnHelperCheck =
  | { status: "not-applicable" }
  | { status: "ok"; helperPath: string }
  | { status: "missing-exec-bit"; helperPath: string; fixCommand: string }
  | { status: "missing-binary"; helperPath: string }
  | { status: "unreadable"; helperPath: string; fixCommand: string }
  | { status: "inaccessible"; helperPath: string };

export interface CheckPtySpawnHelperOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  helperPath?: string;
  resolvePkg?: () => string;
  canLoadAddon?: (addonPath: string) => boolean;
  fs?: Partial<PtyPreflightFs>;
}

function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

function defaultResolveNodePtyPackage(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("node-pty/package.json");
}

function defaultCanLoadAddon(addonPath: string, hostPlatform: boolean, fs: Pick<PtyPreflightFs, "statSync">): boolean {
  if (!hostPlatform) {
    try {
      return fs.statSync(addonPath).isFile();
    } catch {
      return false;
    }
  }
  try {
    const require = createRequire(import.meta.url);
    require(addonPath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(fs: Pick<PtyPreflightFs, "statSync">, path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canAccess(fs: Pick<PtyPreflightFs, "accessSync">, path: string, mode: number): boolean {
  try {
    fs.accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function isOwnedByCurrentProcess(stats: PtyPreflightStat, getuid: (() => number | undefined) | undefined): boolean {
  if (stats.uid === undefined || !getuid) return true;
  const uid = getuid();
  return uid === undefined || stats.uid === uid;
}

export function resolvePtySpawnHelperPath(options: ResolvePtySpawnHelperOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolvePkg = options.resolvePkg ?? defaultResolveNodePtyPackage;
  const fs = options.fs ?? NODE_PREFLIGHT_FS;
  const hostPlatform = platform === process.platform && arch === process.arch;
  const canLoad = options.canLoadAddon ?? (addonPath => defaultCanLoadAddon(addonPath, hostPlatform, fs));
  try {
    const pkgPath = resolvePkg();
    if (!pkgPath) return undefined;
    const pkgDir = dirname(pkgPath);
    for (const buildDir of SOURCE_BUILD_DIRS) {
      const candidateDir = join(pkgDir, buildDir);
      if (canLoad(join(candidateDir, "pty.node"))) {
        return join(candidateDir, "spawn-helper");
      }
    }
    return join(pkgDir, "prebuilds", `darwin-${arch}`, "spawn-helper");
  } catch {
    return undefined;
  }
}

export function checkPtySpawnHelper(options: CheckPtySpawnHelperOptions = {}): PtySpawnHelperCheck {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { status: "not-applicable" };
  const fs: PtyPreflightFs = {
    statSync: options.fs?.statSync ?? NODE_PREFLIGHT_FS.statSync,
    accessSync: options.fs?.accessSync ?? NODE_PREFLIGHT_FS.accessSync,
    getuid: options.fs?.getuid ?? NODE_PREFLIGHT_FS.getuid,
  };
  const helperPath = options.helperPath ?? resolvePtySpawnHelperPath({
    platform,
    arch: options.arch,
    resolvePkg: options.resolvePkg,
    canLoadAddon: options.canLoadAddon,
    fs,
  });
  if (!helperPath) return { status: "not-applicable" };

  let stats: PtyPreflightStat;
  try {
    stats = fs.statSync(helperPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return { status: "inaccessible", helperPath };
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      return isDirectory(fs, dirname(helperPath))
        ? { status: "missing-binary", helperPath }
        : { status: "not-applicable" };
    }
    return { status: "inaccessible", helperPath };
  }

  if (!stats.isFile()) return { status: "missing-binary", helperPath };
  const ownedByHost = isOwnedByCurrentProcess(stats, fs.getuid);
  const readable = (stats.mode & 0o444) !== 0 && canAccess(fs, helperPath, constants.R_OK);
  if (!readable) {
    const chmodFlag = ownedByHost && (stats.mode & 0o400) === 0 ? "u+rx" : "a+rx";
    return { status: "unreadable", helperPath, fixCommand: `chmod ${chmodFlag} ${shellQuote(helperPath)}` };
  }
  const executable = (stats.mode & 0o111) !== 0 && canAccess(fs, helperPath, constants.X_OK);
  if (!executable) {
    const chmodFlag = ownedByHost && (stats.mode & 0o100) === 0 ? "+x" : "a+x";
    return { status: "missing-exec-bit", helperPath, fixCommand: `chmod ${chmodFlag} ${shellQuote(helperPath)}` };
  }
  return { status: "ok", helperPath };
}

export function ptyDoctorLine(check: PtySpawnHelperCheck = checkPtySpawnHelper()): string | undefined {
  switch (check.status) {
    case "not-applicable":
      return undefined;
    case "ok":
      return `PTY helper: ok (${check.helperPath})`;
    case "missing-exec-bit":
      return `Warning: PTY helper is not executable (${check.helperPath}); PTY sessions will fail to spawn. Fix with: ${check.fixCommand}`;
    case "missing-binary":
      return `Warning: PTY helper is missing (${check.helperPath}); reinstall dependencies (npm ci) to restore node-pty.`;
    case "unreadable":
      return `Warning: PTY helper is not readable (${check.helperPath}); restore permissions with: ${check.fixCommand}`;
    case "inaccessible":
      return `Warning: could not inspect PTY helper (${check.helperPath}); check directory access permissions along this path.`;
  }
}

export function ptyStartupWarning(check: PtySpawnHelperCheck = checkPtySpawnHelper()): string | undefined {
  if (check.status === "ok" || check.status === "not-applicable") return undefined;
  return ptyDoctorLine(check);
}

function isPtyHelperSpawnFailure(message: string): boolean {
  return /posix_spawnp|spawn-helper|EACCES/i.test(message);
}

export function describePtySpawnError(error: unknown, check?: PtySpawnHelperCheck): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isPtyHelperSpawnFailure(message)) return message;
  const result = check ?? checkPtySpawnHelper();
  switch (result.status) {
    case "missing-exec-bit":
      return `${message} macOS node-pty spawn-helper is missing execute permission (${result.helperPath}). Fix with: ${result.fixCommand}`;
    case "missing-binary":
      return `${message} macOS node-pty spawn-helper is missing (${result.helperPath}). Reinstall dependencies (npm ci).`;
    case "unreadable":
      return `${message} macOS node-pty spawn-helper is not readable (${result.helperPath}). Fix with: ${result.fixCommand}`;
    case "inaccessible":
      return `${message} Could not inspect macOS node-pty spawn-helper (${result.helperPath}); check directory access permissions along this path.`;
    case "ok":
    case "not-applicable":
      return message;
  }
}
