import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

// Provider ceilings: root-owned policy files that Claude Code and Codex read
// and that agents cannot change. The install script puts the shipped templates
// in place; this module checks what is installed.

export type CeilingProvider = "claude" | "codex";

export interface CeilingTarget {
  systemPath: string;
  // Repository-relative path of the template shipped in the release.
  template: string;
}

export const CEILING_TARGETS: Record<CeilingProvider, CeilingTarget> = {
  claude: {
    systemPath: "/etc/claude-code/managed-settings.json",
    template: "deploy/ubuntu/ceilings/managed-settings.json",
  },
  codex: {
    systemPath: "/etc/codex/requirements.toml",
    template: "deploy/ubuntu/ceilings/requirements.toml",
  },
};

export type CeilingFileKind = "file" | "directory" | "symlink" | "other";

export interface CeilingFileStat {
  uid: number;
  // Permission bits only (st_mode & 0o7777).
  mode: number;
  // What the path itself is. A symbolic link is reported as a link, never as its target.
  kind: CeilingFileKind;
}

// Injected so the checks run without root and without the real system paths.
export interface CeilingFs {
  // Describes the path itself and does not follow a symbolic link.
  stat(path: string): CeilingFileStat | undefined;
  read(path: string): Uint8Array | undefined;
}

export const nodeCeilingFs: CeilingFs = {
  stat(path) {
    try {
      const info = lstatSync(path);
      const kind: CeilingFileKind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
      return { uid: info.uid, mode: info.mode & 0o7777, kind };
    } catch {
      return undefined;
    }
  },
  read(path) {
    try {
      return readFileSync(path);
    } catch {
      return undefined;
    }
  },
};

// Absolute path of a shipped template, resolved from this module the same way
// other host code finds files under the repository root (src and dist share depth).
export function shippedCeilingTemplate(provider: CeilingProvider): string {
  return fileURLToPath(new URL(`../../../${CEILING_TARGETS[provider].template}`, import.meta.url));
}

export type CeilingCheck = "present" | "writable" | "hash" | "profile";
export type CeilingStatus = "ok" | "missing" | "writable" | "changed" | "conflict";

export interface CeilingLine {
  provider: CeilingProvider;
  check: CeilingCheck;
  status: CeilingStatus;
  detail: string;
}

export interface CeilingCheckInput {
  provider: CeilingProvider;
  systemPath: string;
  templatePath: string;
  // Launch arguments the host configures for this provider (args and appServerArgs).
  launchArgs: string[];
  fs: CeilingFs;
}

const WRITE_BITS = 0o022;

function octal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Every directory above the path, nearest first, ending at the root.
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
    out.push(dir);
    if (dir === "/" || dir === ".") return out;
  }
}

// Whoever can write a directory on the way to the file, or the target of a link on that way, can replace the file.
// So the file must be a regular root-owned file, and every directory above it a real root-owned directory.
function replaceable(systemPath: string, installed: CeilingFileStat, fs: CeilingFs): string[] {
  const problems: string[] = [];
  if (installed.kind === "symlink") problems.push(`${systemPath} is a symbolic link; whoever controls its target controls the ceiling`);
  else if (installed.kind !== "file") problems.push(`${systemPath} is not a regular file`);
  if (installed.uid !== 0) problems.push(`${systemPath} is owned by uid ${installed.uid}, not root`);
  if (installed.kind === "file" && installed.mode & WRITE_BITS) problems.push(`${systemPath} is group- or world-writable (${octal(installed.mode)})`);
  for (const dir of ancestors(systemPath)) {
    const info = fs.stat(dir);
    if (!info) { problems.push(`${dir} cannot be inspected`); continue; }
    if (info.kind === "symlink") { problems.push(`${dir} is a symbolic link`); continue; }
    if (info.kind !== "directory") { problems.push(`${dir} is not a directory`); continue; }
    if (info.uid !== 0) problems.push(`${dir} is owned by uid ${info.uid}, not root`);
    if (info.mode & WRITE_BITS) problems.push(`${dir} is group- or world-writable (${octal(info.mode)})`);
  }
  return problems;
}

const TOML_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };

// What a TOML string literal means: basic and literal strings, one-line and multi-line. Text that is not a
// string literal is returned as written, which is how Codex reads an override value that is not valid TOML.
function tomlString(value: string): string {
  const unescape = (text: string) =>
    text.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g, (whole, short?: string, long?: string, char?: string) => {
      if (short || long) {
        const point = Number.parseInt(short ?? long!, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      }
      return TOML_ESCAPES[char!] ?? whole;
    });
  for (const [quote, basic] of [['"""', true], ["'''", false], ['"', true], ["'", false]] as const) {
    if (value.length < quote.length * 2 || !value.startsWith(quote) || !value.endsWith(quote)) continue;
    let inner = value.slice(quote.length, value.length - quote.length);
    if (quote.length === 3) inner = inner.replace(/^\r?\n/, "");
    return basic ? unescape(inner) : inner;
  }
  return value;
}

// The value of a Codex `key=value` override, read as Codex reads it.
function overrideValue(text: string, key: string): string | undefined {
  const equals = text.indexOf("=");
  if (equals < 0 || text.slice(0, equals).trim() !== key) return undefined;
  return tomlString(text.slice(equals + 1).trim());
}

// Launch arguments the ceiling forbids. Matching is on argument boundaries: a flag, a flag with its value as the
// next argument, or a flag joined to its value with "=".
export function forbiddenLaunchFlags(provider: CeilingProvider, args: string[]): string[] {
  const hits = new Set<string>();
  const valued = (index: number, flags: string[]): string | undefined => {
    const arg = args[index];
    for (const flag of flags) {
      if (arg === flag) return args[index + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
    return undefined;
  };
  args.forEach((arg, index) => {
    if (provider === "claude") {
      if (["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--enable-auto-mode"].includes(arg)) hits.add(arg);
      const mode = valued(index, ["--permission-mode"]);
      if (mode === "bypassPermissions" || mode === "auto") hits.add(`--permission-mode ${mode}`);
      return;
    }
    if (["--dangerously-bypass-approvals-and-sandbox", "--yolo"].includes(arg)) hits.add(arg);
    if (valued(index, ["--sandbox", "-s"]) === "danger-full-access") hits.add("--sandbox danger-full-access");
    const override = valued(index, ["-c", "--config"]);
    if (override !== undefined && overrideValue(override, "sandbox_mode") === "danger-full-access") hits.add(`-c sandbox_mode="danger-full-access"`);
  });
  return [...hits];
}

export function checkCeiling(input: CeilingCheckInput): CeilingLine[] {
  const { provider, systemPath, templatePath, fs } = input;
  const lines: CeilingLine[] = [];
  const line = (check: CeilingCheck, status: CeilingStatus, detail: string) =>
    lines.push({ provider, check, status, detail });

  const installed = fs.stat(systemPath);
  if (!installed) {
    line("present", "missing", `${systemPath} is not installed; run deploy/ubuntu/install-ceilings.sh as root on the host`);
  } else {
    line("present", "ok", systemPath);

    const problems = replaceable(systemPath, installed, fs);
    if (problems.length > 0) line("writable", "writable", problems.join("; "));
    else line("writable", "ok", "a regular root-owned file, not group- or world-writable, under root-owned directories");

    const template = fs.read(templatePath);
    // Only a regular file is read. Opening a pipe or a device here would block, and the warning above would never print.
    if (installed.kind !== "file") {
      line("hash", "changed", `${systemPath} was not read: it is not a regular file`);
    } else if (!template) {
      line("hash", "missing", `shipped template not found at ${templatePath}; this release cannot verify the ceiling`);
    } else {
      const expected = sha256(template);
      const bytes = fs.read(systemPath);
      if (!bytes) line("hash", "changed", `${systemPath} could not be read to compare with the shipped template`);
      else {
        const actual = sha256(bytes);
        if (actual === expected) line("hash", "ok", `sha256 ${actual} matches the shipped template`);
        else line("hash", "changed", `sha256 ${actual} differs from the shipped template ${expected}`);
      }
    }
  }

  const forbidden = forbiddenLaunchFlags(provider, input.launchArgs);
  if (forbidden.length > 0)
    line("profile", "conflict", `configured launch profile uses ${forbidden.join(", ")}, which this ceiling forbids`);
  else line("profile", "ok", "no configured launch flag that this ceiling forbids");

  return lines;
}
