import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The owner's trust in a team root covers every member folder below it. Claude Code and
// Codex key folder trust by the folder or its own Git root, and each member is a separate
// clone, so a parent entry never reaches it: each launch records its exact folder instead.

function trustable(cwd: string) {
  return isAbsolute(cwd) && normalize(cwd) === cwd && cwd !== "/" && !/[\x00-\x1f\x7f]/.test(cwd);
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A per-launch Codex override; nothing is written to the account's configuration. */
export function codexTrustArgs(cwd: string): string[] {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  // A JSON string is a valid TOML basic string once control characters are excluded.
  return ["-c", `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`];
}

/** Mark one folder trusted in Claude Code's global config, leaving every other entry as it was. */
export function recordClaudeTrust(configPath: string, cwd: string): boolean {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  let existing: string | undefined;
  try { existing = readFileSync(configPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const data: unknown = existing?.trim() ? JSON.parse(existing) : {};
  if (!isObject(data)) throw new Error("Claude config is not a JSON object");
  const projects = isObject(data.projects) ? data.projects : {};
  const current = isObject(projects[cwd]) ? projects[cwd] : {};
  if (current.hasTrustDialogAccepted === true) return false;
  const next = { ...data, projects: { ...projects, [cwd]: { ...current, hasTrustDialogAccepted: true } } };
  const target = existing === undefined ? configPath : realpathSync(configPath);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, target); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  return true;
}

// Agent-side entry for wrappers that run providers in a separate account. It records trust
// only for the folder this launch runs in, in that account's own Claude config.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.env.INFINITE_TRUSTED_WORKSPACE;
  const home = process.env.CLAUDE_CONFIG_DIR || process.env.HOME;
  if (process.argv[2] !== "claude" || process.argv.length !== 3 || !requested || !home) {
    console.error("Usage: INFINITE_TRUSTED_WORKSPACE=DIR workspace-trust claude");
    process.exit(64);
  }
  if (realpathSync(process.cwd()) !== requested) {
    console.error("The trusted workspace must be the current folder.");
    process.exit(65);
  }
  recordClaudeTrust(join(home, ".claude.json"), requested);
}
