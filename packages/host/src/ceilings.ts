import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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

export interface CeilingFileStat {
  uid: number;
  // Permission bits only (st_mode & 0o7777).
  mode: number;
}

// Injected so the checks run without root and without the real system paths.
export interface CeilingFs {
  stat(path: string): CeilingFileStat | undefined;
  read(path: string): Uint8Array | undefined;
}

export const nodeCeilingFs: CeilingFs = {
  stat(path) {
    try {
      const info = statSync(path);
      return { uid: info.uid, mode: info.mode & 0o7777 };
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

// Flags the ceiling forbids, per provider. Matching is literal on argument
// boundaries; `pairs` match a flag followed by its value.
const FORBIDDEN: Record<CeilingProvider, { flags: string[]; pairs: [string, string][]; equals: string[]; patterns: RegExp[] }> = {
  claude: {
    flags: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
    pairs: [["--permission-mode", "bypassPermissions"]],
    equals: ["--permission-mode=bypassPermissions"],
    patterns: [],
  },
  codex: {
    flags: ["--dangerously-bypass-approvals-and-sandbox"],
    pairs: [
      ["--sandbox", "danger-full-access"],
      ["-s", "danger-full-access"],
    ],
    equals: ["--sandbox=danger-full-access"],
    // Covers `-c sandbox_mode="danger-full-access"` and `--config=sandbox_mode=...`.
    patterns: [/sandbox_mode\s*=\s*"?danger-full-access"?/],
  },
};

export function forbiddenLaunchFlags(provider: CeilingProvider, args: string[]): string[] {
  const rule = FORBIDDEN[provider];
  const hits: string[] = [];
  args.forEach((arg, index) => {
    if (rule.flags.includes(arg) || rule.equals.includes(arg)) hits.push(arg);
    if (rule.patterns.some((pattern) => pattern.test(arg))) hits.push(arg);
    for (const [flag, value] of rule.pairs) {
      if (arg === flag && args[index + 1] === value) hits.push(`${flag} ${value}`);
    }
  });
  return [...new Set(hits)];
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

    const problems: string[] = [];
    if (installed.uid !== 0) problems.push(`${systemPath} is owned by uid ${installed.uid}, not root`);
    if (installed.mode & WRITE_BITS) problems.push(`${systemPath} is group- or world-writable (${octal(installed.mode)})`);
    const parent = posix.dirname(systemPath);
    const parentStat = fs.stat(parent);
    if (!parentStat) problems.push(`${parent} cannot be inspected`);
    else {
      if (parentStat.uid !== 0) problems.push(`${parent} is owned by uid ${parentStat.uid}, not root`);
      if (parentStat.mode & WRITE_BITS) problems.push(`${parent} is group- or world-writable (${octal(parentStat.mode)})`);
    }
    if (problems.length > 0) line("writable", "writable", problems.join("; "));
    else line("writable", "ok", "root-owned, not group- or world-writable, parent directory too");

    const template = fs.read(templatePath);
    if (!template) {
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
