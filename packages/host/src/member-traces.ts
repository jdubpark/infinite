import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from "node:fs";
import { lstat, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProfile, Config, Provider } from "./types.js";
import type { TeamAssignment, TeamRun } from "./team-types.js";
import { chmodDirectoryNoFollow } from "./team-workspace.js";

const capBytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const memberTraceSettingsSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), memberBytes: capBytes.optional(), runBytes: capBytes.optional() }).strict(),
  z.object({ enabled: z.literal(true), memberBytes: capBytes, runBytes: capBytes }).strict(),
]);
export type MemberTraceSettings = z.infer<typeof memberTraceSettingsSchema>;

const MANIFEST = "infinite-trace.json";
const TEMPORARY = /^\.infinite-trace\.json\.[0-9a-f-]{36}\.tmp$/;
const MANIFEST_MAX_BYTES = 4096;
const manifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1).max(128),
  state: z.enum(["recording", "kept", "removing", "removed", "not-recorded"]),
  caps: z.object({ memberBytes: capBytes, runBytes: capBytes }).strict().optional(),
  bytes: z.number().int().min(0).optional(),
  at: z.string(),
  reason: z.enum(["member-cap", "run-cap", "separate-account"]).optional(),
  sessionRecord: z.literal("kept"),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const knownRoots = new Set<string>();
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
async function tracesRoot(stateDir: string) {
  const info = await lstatIfPresent(tracesDirectory(stateDir));
  return info && !info.isSymbolicLink() && info.isDirectory() ? tracesDirectory(stateDir) : undefined;
}
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

export function prepareMemberTrace(config: Pick<Config, "stateDir" | "teams">, sessionId: string, provider: Provider,
  team: TeamAssignment | undefined, profile: AgentProfile): string | undefined {
  const settings = config.teams?.memberTraces;
  if (!settings?.enabled || provider !== "codex" || !team || team.role === "mission-coordinator") return undefined;
  try {
    if (!SAFE_ID.test(team.runId) || !SAFE_ID.test(team.memberId)) throw traceError("trace-id-unsafe", "A trace directory needs path-safe ids.");
    const root = tracesDirectory(config.stateDir), directory = join(root, team.runId, team.memberId);
    for (const path of [join(config.stateDir, "teams"), root, join(root, team.runId), directory]) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      if (path === root) knownRoots.add(config.stateDir);
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

async function readManifest(directory: string): Promise<Manifest | undefined> {
  let file;
  try { file = await open(join(directory, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
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
async function keptBytes(run: string, exceptMemberId: string) {
  let total = 0;
  for (const entry of await readdir(run, { withFileTypes: true })) {
    if (entry.name === exceptMemberId || !entry.isDirectory()) continue;
    const manifest = await readManifest(join(run, entry.name));
    if (manifest?.state === "kept") total += manifest.bytes ?? 0;
  }
  return total;
}

const EXIT_RECHECK_MS = 5_000, FAILURE_RETRY_MS = 30_000, FAILURE_RETRY_MAX_MS = 30 * 60_000;
export interface TraceSettlementHost {
  stateDir: string;
  exited(sessionId: string): Promise<boolean>;
  now(): number;
}
type Outcome = "settled" | "running";

export class MemberTraces {
  constructor(private readonly stateDir: string) {
    try { lstatSync(tracesDirectory(stateDir)); knownRoots.add(stateDir); }
    catch (error) { if (errorCode(error) !== "ENOENT") knownRoots.add(stateDir); }
  }
  inUse(config: Pick<Config, "teams">) {
    return config.teams?.memberTraces?.enabled === true || knownRoots.has(this.stateDir);
  }
  private readonly looked = new WeakMap<TeamRun, string>();
  private readonly waits = new Map<string, Map<string, { at: number; failures: number }>>();
  private readonly passes = new Map<string, Promise<void>>();
  settle(run: TeamRun, host: TraceSettlementHost): Promise<void> | undefined {
    if (this.passes.has(run.id)) return undefined;
    const started = run.members.filter(member => member.startedAt);
    const sessions = started.map(member => `${member.memberId}/${member.sessionId}`).join(" ");
    const changed = this.looked.get(run) !== sessions, now = host.now(), waits = this.waits.get(run.id);
    const due = [...new Set(started.map(member => member.memberId))]
      .filter(memberId => { const wait = waits?.get(memberId); return wait ? wait.at <= now : changed; });
    if (!due.length) { this.looked.set(run, sessions); return undefined; }
    const outcomes = new Map<string, { at: number; failures: number } | undefined>();
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
    if (!await traceDirectory(host.stateDir, [runId, memberId])) return "settled";
    await walkTrace(directory, true, true);
    await writeManifest(directory, { ...manifest, state: "removed", at: new Date(host.now()).toISOString() });
    return "settled";
  }
}
