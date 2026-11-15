import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
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
    // O_NOFOLLOW makes a symbolic link fail instead of being followed. O_NONBLOCK keeps a named pipe from
    // waiting for a writer. Only a regular file is returned.
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) return undefined;
      return readFileSync(fd);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
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

// Reads a TOML string literal: basic and literal strings, one line or several. Anything else comes back as written,
// so a value this reader does not understand is compared as text and reported rather than assumed safe.
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

// Codex accepts exactly these two sandbox modes under the ceiling.
const CODEX_SANDBOX_ALLOWED = new Set(["read-only", "workspace-write"]);

// The value of `sandbox_mode` in a Codex `key=value` override, or undefined for any other key.
function sandboxModeOverride(text: string): string | undefined {
  const equals = text.indexOf("=");
  if (equals < 0) return undefined;
  const key = text.slice(0, equals).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (key !== "sandbox_mode") return undefined;
  return tomlString(text.slice(equals + 1).trim());
}

// Claude Code: a flag, a flag with its value as the next argument, or the flag joined to its value with "=".
function claudeHits(args: string[]): string[] {
  const hits: string[] = [];
  args.forEach((arg, index) => {
    if (["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"].includes(arg)) hits.push(arg);
    let mode: string | undefined;
    if (arg === "--permission-mode") mode = args[index + 1];
    else if (arg.startsWith("--permission-mode=")) mode = arg.slice("--permission-mode=".length);
    if (mode === "bypassPermissions" || mode === "auto") hits.push(`--permission-mode ${mode}`);
  });
  return hits;
}

// Codex: an override, --sandbox, or -s is reported unless its value reads as exactly one of the allowed modes.
// This is inverted on purpose. A hand-written reader cannot cover every TOML spelling, so an unusual but valid
// spelling of an allowed mode can be reported too. That costs one warning line.
function codexHits(args: string[]): string[] {
  const hits: string[] = [];
  args.forEach((arg, index) => {
    if (arg === "--dangerously-bypass-approvals-and-sandbox") hits.push(arg);
    // --sandbox MODE, --sandbox=MODE, -s MODE, -sMODE
    let mode: string | undefined;
    if (arg === "--sandbox" || arg === "-s") mode = args[index + 1];
    else if (arg.startsWith("--sandbox=")) mode = arg.slice("--sandbox=".length);
    else if (arg.startsWith("-s") && !arg.startsWith("--")) mode = arg.slice(2);
    if (mode !== undefined && !CODEX_SANDBOX_ALLOWED.has(mode)) hits.push(`--sandbox ${mode}`);
    // -c KEY=VALUE, --config KEY=VALUE, --config=KEY=VALUE, -cKEY=VALUE
    let override: string | undefined;
    if (arg === "-c" || arg === "--config") override = args[index + 1];
    else if (arg.startsWith("--config=")) override = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && !arg.startsWith("--")) override = arg.slice(2);
    const value = override === undefined ? undefined : sandboxModeOverride(override);
    if (value !== undefined && !CODEX_SANDBOX_ALLOWED.has(value)) hits.push(`-c sandbox_mode=${JSON.stringify(value)}`);
  });
  return hits;
}

// Launch arguments the ceiling conflicts with. See claudeHits and codexHits for the rules.
export function forbiddenLaunchFlags(provider: CeilingProvider, args: string[]): string[] {
  return [...new Set(provider === "claude" ? claudeHits(args) : codexHits(args))];
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
    // The ceiling is not read while any placement check fails. Whoever controls the path could swap in other bytes.
    if (problems.length > 0) {
      line("hash", "writable", `not read: ${systemPath} is not in a safe place (see the writable line), so its hash is not computed`);
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
  const note = provider === "codex" ? "; a sandbox_mode value is reported unless it reads as exactly read-only or workspace-write, so a valid but unusual spelling can be a false positive" : "";
  if (forbidden.length > 0)
    line("profile", "conflict", `configured launch profile uses ${forbidden.join(", ")}, which this ceiling forbids${note}`);
  else line("profile", "ok", "no configured launch flag that this ceiling forbids");

  return lines;
}
