// Codex members' native traces (INF-337): where the host keeps them, the caps it enforces after a member ends, and
// their removal with the run. See docs/teams.md "Member traces".
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProfile, Config, Provider } from "./types.js";
import type { TeamAssignment, TeamMember, TeamRun } from "./team-types.js";
import { chmodDirectoryNoFollow } from "./team-workspace.js";

const capBytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** `teams.memberTraces`. Off when absent. Turning it on needs both caps: there are no default caps. */
export const memberTraceSettingsSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), memberBytes: capBytes.optional(), runBytes: capBytes.optional() }).strict(),
  z.object({ enabled: z.literal(true), memberBytes: capBytes, runBytes: capBytes }).strict(),
]);
export type MemberTraceSettings = z.infer<typeof memberTraceSettingsSchema>;

/** The host's own file in a member's trace directory. It holds no trace content. */
const MANIFEST = "infinite-trace.json";
const manifestSchema = z.object({
  version: z.literal(1),
  /** The member session this entry describes. A later session of the same member is measured again. */
  sessionId: z.string(),
  state: z.enum(["kept", "removed", "not-recorded"]),
  bytes: z.number().int().min(0),
  at: z.string(),
  reason: z.enum(["member-cap", "run-cap", "separate-account"]).optional(),
  /** The trace never replaces Codex's own session record, which stays where Codex keeps it. */
  sessionRecord: z.literal("kept"),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const tracesDirectory = (stateDir: string) => join(stateDir, "teams", "traces");
function runDirectory(stateDir: string, runId: string) {
  if (!SAFE_ID.test(runId)) throw new Error("A trace directory needs a path-safe run id.");
  return join(tracesDirectory(stateDir), runId);
}
function memberDirectory(stateDir: string, runId: string, memberId: string) {
  if (!SAFE_ID.test(memberId)) throw new Error("A trace directory needs a path-safe member id.");
  return join(runDirectory(stateDir, runId), memberId);
}
const separateAccount = (profile: AgentProfile) => /(^|\/)sudo$/.test(profile.command);
const manifestText = (manifest: Manifest) => `${JSON.stringify(manifestSchema.parse(manifest))}\n`;

/**
 * Before a team member's launch: the directory that Codex's native trace recorder writes to, or undefined. Only a Codex
 * member of a team run gets one, and only with the setting on. Each level below the state directory is created 0700 for
 * the host account. A launch under another account (a sudo profile) could not write there, and a trace that account
 * wrote would be readable by every session of it, so it gets no directory to write to: its manifest says
 * `not-recorded`. Never throws; a member whose directory cannot be prepared starts without a trace.
 */
export function prepareMemberTrace(config: Pick<Config, "stateDir" | "teams">, sessionId: string, provider: Provider,
  team: TeamAssignment | undefined, profile: AgentProfile): string | undefined {
  if (!config.teams?.memberTraces?.enabled || provider !== "codex" || !team || team.role === "mission-coordinator") return undefined;
  try {
    const directory = memberDirectory(config.stateDir, team.runId, team.memberId);
    for (const path of [join(config.stateDir, "teams"), tracesDirectory(config.stateDir), runDirectory(config.stateDir, team.runId), directory]) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      chmodDirectoryNoFollow(path, 0o700);
    }
    if (!separateAccount(profile)) return directory;
    const file = join(directory, MANIFEST);
    writeFileSync(`${file}.tmp`, manifestText({ version: 1, sessionId, state: "not-recorded", bytes: 0, at: new Date().toISOString(),
      reason: "separate-account", sessionRecord: "kept" }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.warn("A Codex member's trace directory could not be prepared; the member starts without a trace.", error);
  }
  return undefined;
}

/** Removes a run's member traces. A run without traces, including one whose id could never name a directory, is a no-op. */
export async function removeMemberTraces(stateDir: string, runId: string) {
  if (SAFE_ID.test(runId)) await rm(runDirectory(stateDir, runId), { recursive: true, force: true });
}

async function readManifest(directory: string): Promise<Manifest | undefined> {
  try { return manifestSchema.parse(JSON.parse(await readFile(join(directory, MANIFEST), "utf8"))); }
  catch { return undefined; }
}
async function writeManifest(directory: string, manifest: Manifest) {
  const file = join(directory, MANIFEST);
  await writeFile(`${file}.tmp`, manifestText(manifest), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
/** Bytes of the regular files Codex wrote, without following links and without the manifest. */
async function traceBytes(directory: string) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (current === directory && entry.name.startsWith(MANIFEST)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await lstat(path)).size;
    }
  }
  return total;
}
async function clearTrace(directory: string) {
  for (const name of await readdir(directory))
    if (!name.startsWith(MANIFEST)) await rm(join(directory, name), { recursive: true, force: true });
}
async function keptBytes(run: string, exceptMemberId: string) {
  let total = 0;
  for (const name of await readdir(run)) {
    if (name === exceptMemberId) continue;
    const manifest = await readManifest(join(run, name));
    if (manifest?.state === "kept") total += manifest.bytes;
  }
  return total;
}

/** A member whose process has ended: stopped, or reported with its exit confirmed. */
const memberEnded = (member: TeamMember) => member.status === "stopped" || (member.status === "reported" && Boolean(member.exitConfirmedAt));

/**
 * The caps, enforced after the fact because Codex writes the files itself. The scheduler tick calls `settle` for each
 * run; it measures each ended Codex member's trace once per member session, one run at a time, outside the team
 * mutation queue. A trace over the member cap, or one that would take the run's kept traces over the run cap, is
 * removed after its manifest records the measurement and the reason.
 */
export class MemberTraces {
  private readonly settled = new Set<string>();
  private readonly running = new Set<string>();
  settle(config: Pick<Config, "stateDir" | "teams">, run: TeamRun): Promise<void> | undefined {
    const settings = config.teams?.memberTraces;
    if (!settings?.enabled || this.running.has(run.id)) return undefined;
    const ended = run.members
      .filter(member => (member.provider ?? run.provider) === "codex" && memberEnded(member) && !this.settled.has(`${run.id}/${member.memberId}/${member.sessionId}`))
      .map(member => ({ memberId: member.memberId, sessionId: member.sessionId }));
    if (!ended.length) return undefined;
    this.running.add(run.id);
    return this.settleRun(config.stateDir, run.id, ended, settings)
      .catch(error => console.warn("A Codex member's trace could not be measured; it is measured again after a host restart.", error))
      .finally(() => this.running.delete(run.id));
  }
  private async settleRun(stateDir: string, runId: string, members: { memberId: string; sessionId: string }[], caps: { memberBytes: number; runBytes: number }) {
    const run = runDirectory(stateDir, runId);
    for (const { memberId, sessionId } of members) {
      const key = `${runId}/${memberId}/${sessionId}`, directory = memberDirectory(stateDir, runId, memberId);
      // Marked first: a failure is not retried on every tick, only after a restart.
      this.settled.add(key);
      const current = await readManifest(directory);
      if (current?.sessionId === sessionId) {
        // A removal that stopped part way is finished.
        if (current.state === "removed") await clearTrace(directory);
        continue;
      }
      let bytes: number;
      try { bytes = await traceBytes(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const reason = bytes > caps.memberBytes ? "member-cap" as const
        : await keptBytes(run, memberId) + bytes > caps.runBytes ? "run-cap" as const : undefined;
      await writeManifest(directory, { version: 1, sessionId, state: reason ? "removed" : "kept", bytes, at: new Date().toISOString(),
        ...(reason ? { reason } : {}), sessionRecord: "kept" });
      if (reason) await clearTrace(directory);
    }
  }
}
