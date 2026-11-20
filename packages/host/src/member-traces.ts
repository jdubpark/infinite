// Codex members' native traces (INF-337): where the host keeps them, the caps it enforces after a member's session
// exits, and their removal with the run. See docs/teams.md "Member traces".
//
// Links: each trace directory is checked with lstat up to the traces root, and with realpath, before the host reads or
// changes it, and no walk follows a link: a link is one entry, measured and unlinked as itself. Node has no openat, so a
// process of the host's own account can still swap a checked directory for a link before the removal that follows.
// Such a process can already change every file of that account, so this is no escalation; the checks keep the host
// from following a link by accident.
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from "node:fs";
import { lstat, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProfile, Config, Provider } from "./types.js";
import type { TeamAssignment, TeamRun } from "./team-types.js";
import { chmodDirectoryNoFollow } from "./team-workspace.js";

const capBytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** `teams.memberTraces`. Off when absent. Turning it on needs both caps: there are no default caps. */
export const memberTraceSettingsSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), memberBytes: capBytes.optional(), runBytes: capBytes.optional() }).strict(),
  z.object({ enabled: z.literal(true), memberBytes: capBytes, runBytes: capBytes }).strict(),
]);
export type MemberTraceSettings = z.infer<typeof memberTraceSettingsSchema>;

/** The host's own file in a member's trace directory. It holds no trace content. Every other entry counts as trace. */
const MANIFEST = "infinite-trace.json";
/** A manifest write in progress, under a random name. One left by an interrupted write is removed when found. */
const TEMPORARY = /^\.infinite-trace\.json\.[0-9a-f-]{36}\.tmp$/;
const MANIFEST_MAX_BYTES = 4096;
/**
 * `recording` from the member's start, with the caps then in force; once its session exited, `kept`, or `removing`
 * then `removed`; `not-recorded` for a launch the host could not give a private directory.
 */
const manifestSchema = z.object({
  version: z.literal(1),
  /** The member session this entry describes. */
  sessionId: z.string().min(1).max(128),
  state: z.enum(["recording", "kept", "removing", "removed", "not-recorded"]),
  caps: z.object({ memberBytes: capBytes, runBytes: capBytes }).strict().optional(),
  bytes: z.number().int().min(0).optional(),
  at: z.string(),
  reason: z.enum(["member-cap", "run-cap", "separate-account"]).optional(),
  /** The trace never replaces Codex's own session record, which stays where Codex keeps it. */
  sessionRecord: z.literal("kept"),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Errors from this module name no path, so they can reach the host log. */
const traceError = (code: string, message: string) => Object.assign(new Error(message), { code });
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
const tracesDirectory = (stateDir: string) => join(stateDir, "teams", "traces");
const separateAccount = (profile: AgentProfile) => /(^|\/)sudo$/.test(profile.command);
const manifestText = (manifest: Manifest) => `${JSON.stringify(manifestSchema.parse(manifest))}\n`;
const temporaryName = () => `.${MANIFEST}.${randomUUID()}.tmp`;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const ignoreMissing = (error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; };
async function lstatIfPresent(path: string) {
  try { return await lstat(path); } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}
/** The traces root, when it is a directory the host can use. A link or a file there is the owner's and is left alone. */
async function tracesRoot(stateDir: string) {
  const info = await lstatIfPresent(tracesDirectory(stateDir));
  return info && !info.isSymbolicLink() && info.isDirectory() ? tracesDirectory(stateDir) : undefined;
}
/**
 * Whether `traces/<runId>[/<memberId>]` is a usable directory. A link, or anything else that is not a directory, at a
 * level below the traces root is unlinked as itself, never its target, and logged by id; the directory then counts as
 * absent. The directory must also resolve to its place under the real traces root; otherwise this throws.
 */
async function traceDirectory(stateDir: string, parts: [string] | [string, string]) {
  const root = await tracesRoot(stateDir);
  if (!root) return false;
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstatIfPresent(path);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await unlink(path).catch(ignoreMissing);
      console.warn(`The trace directory of ${index ? `member ${parts[1]} in team ${parts[0]}` : `team ${parts[0]}`} was a link or not a directory; the host removed that entry and left its target alone.`);
      return false;
    }
  }
  if (await realpath(path) !== join(await realpath(root), ...parts))
    throw traceError("trace-path-unsafe", "A trace directory resolves outside the host's traces root.");
  return true;
}

/**
 * Before a team member's launch: the directory that Codex's native trace recorder writes to, or undefined. Only a Codex
 * member of a team run gets one, and only with the setting on. Each level below the state directory is created 0700 for
 * the host account, and a `recording` manifest keeps the caps in force, so they still apply after the setting is turned
 * off. A launch under another account (a sudo profile) could not write there, and a trace that account wrote would be
 * readable by every session of it, so it gets no directory to write to: its manifest says `not-recorded`. Never throws;
 * a member whose directory cannot be prepared starts without a trace.
 */
export function prepareMemberTrace(config: Pick<Config, "stateDir" | "teams">, sessionId: string, provider: Provider,
  team: TeamAssignment | undefined, profile: AgentProfile): string | undefined {
  const settings = config.teams?.memberTraces;
  if (!settings?.enabled || provider !== "codex" || !team || team.role === "mission-coordinator") return undefined;
  try {
    if (!SAFE_ID.test(team.runId) || !SAFE_ID.test(team.memberId)) throw traceError("trace-id-unsafe", "A trace directory needs path-safe ids.");
    const root = tracesDirectory(config.stateDir), directory = join(root, team.runId, team.memberId);
    for (const path of [join(config.stateDir, "teams"), root, join(root, team.runId), directory]) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      // Opens the directory without following a link, so a link here fails.
      chmodDirectoryNoFollow(path, 0o700);
      if (!lstatSync(path).isDirectory()) throw traceError("trace-path-unsafe", "A trace directory is a link or not a directory.");
    }
    if (realpathSync(directory) !== join(realpathSync(config.stateDir), "teams", "traces", team.runId, team.memberId))
      throw traceError("trace-path-unsafe", "A trace directory resolves outside the host's traces root.");
    const recording = !separateAccount(profile), at = new Date().toISOString();
    const manifest: Manifest = recording
      ? { version: 1, sessionId, state: "recording", caps: { memberBytes: settings.memberBytes, runBytes: settings.runBytes }, at, sessionRecord: "kept" }
      : { version: 1, sessionId, state: "not-recorded", bytes: 0, at, reason: "separate-account", sessionRecord: "kept" };
    const temporary = join(directory, temporaryName()), fd = openSync(temporary, NEW_FILE, 0o600);
    try { fchmodSync(fd, 0o600); writeSync(fd, manifestText(manifest)); } finally { closeSync(fd); }
    renameSync(temporary, join(directory, MANIFEST));
    return recording ? directory : undefined;
  } catch (error) {
    console.warn(`Member ${team.memberId} of team ${team.runId} starts without a trace: its trace directory could not be prepared (${errorCode(error)}).`);
    return undefined;
  }
}

/**
 * The bytes of every entry below `directory` that is not a directory, by lstat, without following a link; with
 * `remove`, removes each entry. With `manifest`, the directory's own regular-file manifest is neither counted nor
 * removed, and a regular file left by an interrupted manifest write is removed without being counted.
 */
async function walkTrace(directory: string, remove: boolean, manifest: boolean) {
  let total = 0;
  const visit = async (current: string, top: boolean) => {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      let info;
      try { info = await lstat(path); } catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
      if (top && manifest && info.isFile() && name === MANIFEST) continue;
      if (top && manifest && info.isFile() && TEMPORARY.test(name)) { await unlink(path).catch(ignoreMissing); continue; }
      if (info.isDirectory()) {
        await visit(path, false);
        if (remove) await rmdir(path);
      } else {
        total += info.size;
        if (remove) await unlink(path).catch(ignoreMissing);
      }
    }
  };
  await visit(directory, true);
  return total;
}

/**
 * Removes a run's member traces. A run without traces, including one whose id could never name a directory, is a no-op.
 * A link in the way is unlinked as itself, so a link never holds up the removal of the run's record.
 */
export async function removeMemberTraces(stateDir: string, runId: string) {
  if (!SAFE_ID.test(runId)) return;
  if (!await tracesRoot(stateDir) && await lstatIfPresent(tracesDirectory(stateDir))) {
    console.warn(`The member traces of team ${runId} were not looked for: the traces root is a link or not a directory, which the host leaves alone.`);
    return;
  }
  if (!await traceDirectory(stateDir, [runId])) return;
  const run = join(tracesDirectory(stateDir), runId);
  await walkTrace(run, true, false);
  await rmdir(run);
}

/**
 * The manifest, opened without following a link and without blocking, so a FIFO in its place cannot hold the open;
 * the descriptor must then be a regular file. Undefined when there is none, or when what is there is no manifest: a
 * link, a FIFO or other non-regular file, an oversized file, or text that is not a valid manifest. A read that fails
 * throws, so the caller retries instead of taking the manifest for absent.
 */
async function readManifest(directory: string): Promise<Manifest | undefined> {
  let file;
  try { file = await open(join(directory, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    // ELOOP: a link in its place; ENXIO and EOPNOTSUPP: a socket or a FIFO the platform refuses to open.
    if (["ENOENT", "ELOOP", "ENXIO", "EOPNOTSUPP"].includes(errorCode(error))) return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MANIFEST_MAX_BYTES) return undefined;
    const text = await file.readFile("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    const result = manifestSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } finally { await file.close(); }
}
async function writeManifest(directory: string, manifest: Manifest) {
  const temporary = join(directory, temporaryName()), file = await open(temporary, NEW_FILE, 0o600);
  try { await file.chmod(0o600); await file.writeFile(manifestText(manifest)); } finally { await file.close(); }
  await rename(temporary, join(directory, MANIFEST));
}
/**
 * Bytes of the run's traces in state `kept`, other than one member's. A sibling manifest that cannot be read throws:
 * its usage is unknown, so the run cap is not decided until a later pass can read it.
 */
async function keptBytes(run: string, exceptMemberId: string) {
  let total = 0;
  for (const entry of await readdir(run, { withFileTypes: true })) {
    if (entry.name === exceptMemberId || !entry.isDirectory()) continue;
    const manifest = await readManifest(join(run, entry.name));
    if (manifest?.state === "kept") total += manifest.bytes ?? 0;
  }
  return total;
}

/** How long a trace whose session still runs waits for the next look, and the waits after a failure. */
const EXIT_RECHECK_MS = 5_000, FAILURE_RETRY_MS = 30_000, FAILURE_RETRY_MAX_MS = 30 * 60_000;
export interface TraceSettlementHost {
  stateDir: string;
  /** Whether a session has exited, asked of the session itself: a member's status says nothing about its process. */
  exited(sessionId: string): Promise<boolean>;
  now(): number;
}
type Outcome = "settled" | "running";

/**
 * The caps, enforced after the fact because Codex writes the files itself. The scheduler tick calls `settle` for each
 * run, whatever the setting is now: a trace keeps the caps its manifest recorded when its member started. A run is
 * looked at, outside the team mutation queue and one pass at a time, when a member session starts and when a member's
 * wait is over. A trace whose session still runs is looked at again a few seconds later. Once that session exited, a
 * trace over the member cap, or one that would take the run's kept traces over the run cap, is marked `removing`,
 * removed, and only then marked `removed`. A failure is retried on a later tick, after a wait that doubles up to a
 * bound. Writes Codex makes after its trace was settled are not measured again; they go with the run.
 *
 * Bookkeeping: the started sessions last looked at are kept per run object, so they go when the run's record goes;
 * waits and passes are kept by run id, only while a member waits or a pass runs, and `forget` drops them when the run
 * is deleted. A pass that ends after its run was forgotten records nothing.
 */
export class MemberTraces {
  private readonly looked = new WeakMap<TeamRun, string>();
  private readonly waits = new Map<string, Map<string, { at: number; failures: number }>>();
  private readonly passes = new Map<string, Promise<void>>();
  settle(run: TeamRun, host: TraceSettlementHost): Promise<void> | undefined {
    if (this.passes.has(run.id)) return undefined;
    // A member has its start time only after its launch returned, so by then its directory was prepared if ever.
    const started = run.members.filter(member => member.startedAt);
    const sessions = started.map(member => `${member.memberId}/${member.sessionId}`).join(" ");
    const changed = this.looked.get(run) !== sessions, now = host.now(), waits = this.waits.get(run.id);
    const due = [...new Set(started.map(member => member.memberId))]
      .filter(memberId => { const wait = waits?.get(memberId); return wait ? wait.at <= now : changed; });
    if (!due.length) { this.looked.set(run, sessions); return undefined; }
    const outcomes = new Map<string, { at: number; failures: number } | undefined>();
    // Assigned before the body's first await; the body compares it to tell whether the run was forgotten meanwhile.
    let pass: Promise<void> | undefined = undefined;
    pass = (async () => {
      let present: boolean | Error;
      try { present = SAFE_ID.test(run.id) && await traceDirectory(host.stateDir, [run.id]); } catch (error) { present = error as Error; }
      for (const memberId of due) {
        try {
          if (present instanceof Error) throw present;
          const outcome: Outcome = present && SAFE_ID.test(memberId) ? await this.settleMember(host, run.id, memberId) : "settled";
          outcomes.set(memberId, outcome === "settled" ? undefined : { at: host.now() + EXIT_RECHECK_MS, failures: 0 });
        } catch (error) {
          const failures = (waits?.get(memberId)?.failures ?? 0) + 1;
          outcomes.set(memberId, { at: host.now() + Math.min(FAILURE_RETRY_MAX_MS, FAILURE_RETRY_MS * 2 ** (failures - 1)), failures });
          console.warn(`The trace of member ${memberId} in team ${run.id} could not be settled (${errorCode(error)}); the host tries again later.`);
        }
      }
      // A run forgotten while this pass ran keeps nothing of it.
      if (this.passes.get(run.id) !== pass) return;
      this.looked.set(run, sessions);
      const startedIds = new Set(started.map(member => member.memberId));
      const next = new Map([...(this.waits.get(run.id) ?? [])].filter(([memberId]) => startedIds.has(memberId)));
      for (const [memberId, wait] of outcomes) if (wait) next.set(memberId, wait); else next.delete(memberId);
      if (next.size) this.waits.set(run.id, next); else this.waits.delete(run.id);
    })().finally(() => { if (this.passes.get(run.id) === pass) this.passes.delete(run.id); });
    this.passes.set(run.id, pass);
    return pass;
  }
  /** Drops what is kept for a run whose record is being deleted. Resolves once a pass still running over it has ended. */
  async forget(run: TeamRun) {
    const pass = this.passes.get(run.id);
    this.passes.delete(run.id);
    this.waits.delete(run.id);
    this.looked.delete(run);
    await pass?.catch(() => {});
  }
  private async settleMember(host: TraceSettlementHost, runId: string, memberId: string): Promise<Outcome> {
    if (!await traceDirectory(host.stateDir, [runId, memberId])) return "settled";
    const directory = join(tracesDirectory(host.stateDir), runId, memberId);
    let manifest = await readManifest(directory);
    // The manifest names the session that recorded, which is the member's earlier session if a later launch had none.
    if (manifest?.state !== "recording" && manifest?.state !== "removing") return "settled";
    if (!manifest.caps) throw traceError("trace-manifest-invalid", "A recording trace manifest has no caps.");
    if (manifest.state === "recording") {
      if (!await host.exited(manifest.sessionId)) return "running";
      const bytes = await walkTrace(directory, false, true);
      const reason = bytes > manifest.caps.memberBytes ? "member-cap" as const
        : await keptBytes(join(tracesDirectory(host.stateDir), runId), memberId) + bytes > manifest.caps.runBytes ? "run-cap" as const : undefined;
      manifest = { ...manifest, state: reason ? "removing" : "kept", bytes, at: new Date(host.now()).toISOString(), ...(reason ? { reason } : {}) };
      await writeManifest(directory, manifest);
      if (!reason) return "settled";
    }
    // Checked again just before the removal.
    if (!await traceDirectory(host.stateDir, [runId, memberId])) return "settled";
    await walkTrace(directory, true, true);
    await writeManifest(directory, { ...manifest, state: "removed", at: new Date(host.now()).toISOString() });
    return "settled";
  }
}
