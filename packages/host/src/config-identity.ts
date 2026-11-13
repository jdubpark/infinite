import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalJson } from "./evidence/crypto.js";
import { profileIdentity } from "./run-events.js";
import { reportCommand, teamPrompt } from "./team-prompts.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import type { TeamCommand, TeamMember, TeamModelProfile, TeamRun, TeamScout, TeamTask } from "./team-types.js";
import type { Provider } from "./types.js";

/** Guidance files whose blobs a configuration identity covers (umbrella C7, component 3, default set). */
export const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const GUIDANCE_READ_TIMEOUT_MS = 30_000;
const GUIDANCE_CACHE_LIMIT = 64;
/** Guidance reads that may run at once in the host. A stalled read that cannot be stopped keeps its place. */
const GUIDANCE_READS_LIMIT = 4;
/** Git's empty tree ids. Compared with the commit's id length, so a SHA-256 repository gets its own. */
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
const GUIDANCE_MODES = new Set(["100644", "100755", "120000"]);
const PROMPT_CACHE_LIMIT = 256;

export type ProfileKey = { provider: string; model: string | null; effort: string | null };
export interface ConfigComponents {
  profile: ProfileKey;
  promptVersion: string;
  guidance: string;
  knowledge: "none";
  routing: "off";
  shape: "team" | "trial";
}
export type MemberConfiguration = ConfigComponents["profile"] & Omit<ConfigComponents, "profile"> & { configId: string };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 hex of the canonical JSON of the key. The profile id and label are not part of it. */
export function profileIdentityKey(profile: ProfileKey): string {
  return sha256(canonicalJson({ provider: profile.provider, model: profile.model ?? null, effort: profile.effort ?? null }));
}

/**
 * The identity that a profile id names among the given profiles. Undefined when no profile has the id, and
 * "ambiguous" when its profiles differ in provider, model, or effort. The lineup schema refuses such a lineup,
 * so "ambiguous" guards a rule that lives elsewhere.
 */
export function profileKeyOf(profiles: readonly TeamModelProfile[], profileId: string): ProfileKey | "ambiguous" | undefined {
  const keys = new Map<string, ProfileKey>();
  for (const profile of profiles) {
    if (profile.id !== profileId) continue;
    const identity = profileIdentity(profile, profile.provider);
    const key: ProfileKey = { provider: identity.provider, model: identity.model ?? null, effort: identity.effort ?? null };
    keys.set(profileIdentityKey(key), key);
  }
  if (keys.size === 0) return undefined;
  return keys.size === 1 ? [...keys.values()][0]! : "ambiguous";
}

/** SHA-256 hex of the canonical JSON of exactly the six components (umbrella C7). */
export function configId(components: ConfigComponents): string {
  return sha256(canonicalJson({
    profile: { provider: components.profile.provider, model: components.profile.model ?? null, effort: components.profile.effort ?? null },
    promptVersion: components.promptVersion,
    guidance: components.guidance,
    knowledge: components.knowledge,
    routing: components.routing,
    shape: components.shape,
  }));
}

const FIXED_TIME = "2026-11-01T00:00:00.000Z";
const FIXED_PROJECT_ID = "example";
const FIXED_BASE = "a".repeat(40);
const FIXTURE_CHECKS = [{ command: "npm", args: ["test"] }];
const FIXTURE_TASK: TeamTask = { id: "fixture-task", title: "Fixture task", instructions: "Fixture instructions.", paths: ["src/fixture.ts"], dependsOn: [], revision: 1, status: "pending" };
const FIXTURE_SCOUT: TeamScout = { id: "fixture-scout", title: "Fixture scout", instructions: "Fixture scout instructions.", agentProfileId: "fixture-scout", status: "pending" };
const FIXTURE_PROFILE = { id: "fixture-profile", label: "Fixture profile", provider: "claude", model: "fixture-model", effort: "high" } as const;

/** Two fixed runs, each with its work item. Rendering them is the prompt version; no live run is read. */
const FIXTURES: { run: TeamRun; work: TeamTask | TeamScout }[] = [
  {
    run: { id: "00000000-0000-4000-8000-000000000001", projectId: FIXED_PROJECT_ID, provider: "claude", title: "Fixture run", objective: "Fixture objective.", parallelism: 1, revision: 1, status: "implementing", createdAt: FIXED_TIME, updatedAt: FIXED_TIME, workspace: "/home/dev/projects/infinite", branch: "infinite/team-fixture", baseCommit: FIXED_BASE, tasks: [FIXTURE_TASK], members: [], decisions: [], checks: [], steering: [], events: [], round: 1 } as TeamRun,
    work: FIXTURE_TASK,
  },
  {
    run: { id: "00000000-0000-4000-8000-000000000002", projectId: FIXED_PROJECT_ID, provider: "claude", title: "Fixture goal run", objective: "Fixture goal objective.", parallelism: 1, revision: 1, status: "discovering", createdAt: FIXED_TIME, updatedAt: FIXED_TIME, workspace: "/home/dev/projects/infinite", branch: "infinite/team-fixture-goal", baseCommit: FIXED_BASE, tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 1,
      goal: { id: "00000000-0000-4000-8000-000000000003", revision: 1, cycle: 1, successCriteria: "Fixture success criteria.", nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt: "2026-12-01T00:00:00.000Z", maxMembers: 2 },
      lineup: { coordinator: FIXTURE_PROFILE, integrator: FIXTURE_PROFILE, reviewer: FIXTURE_PROFILE, implementers: [FIXTURE_PROFILE] } } as TeamRun,
    work: FIXTURE_SCOUT,
  },
];

const promptCache = new Map<string, string>();
const guidanceCache = new Map<string, string>();
/** A read in flight and the callers that wait for its result. A caller leaves the set when its own deadline ends its wait. */
type GuidanceRead = { waiters: Set<(digest: string | undefined) => void> };
/** Reads in flight, by workspace and commit. A read leaves only when its child has ended. */
const guidanceReads = new Map<string, GuidanceRead>();
/** Callers that wait for a free place. Each is woken when a read ends, and leaves when its own deadline ends its wait. */
const placeWaiters = new Set<() => void>();

/**
 * Waits in `waiters` until a value arrives or the signal aborts, and then leaves the set. The stalled read holds no
 * reference to a caller that gave up, so callers of a read that never ends do not add up.
 */
function waitIn<T>(waiters: Set<(value: T | undefined) => void>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise(resolve => {
    const done = (value: T | undefined) => { waiters.delete(done); signal.removeEventListener("abort", onAbort); resolve(value); };
    const onAbort = () => done(undefined);
    waiters.add(done);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The fixture renders of `teamPrompt`. The report command holds the Node path and the reporter's own file path,
 * which change with the install directory and not with the wording, so a placeholder stands in for it.
 * Throws when teamPrompt throws.
 */
export function renderedPrompts(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean): string[] {
  const command = reportCommand();
  return FIXTURES.map(({ run, work }) =>
    teamPrompt(run, role, work, undefined, provider, profile, { checks: FIXTURE_CHECKS }, [], publishHeads).split(command).join("<report-command>"));
}

/**
 * The digest of `renderedPrompts`. Cached per exact render input: the prompt prints the whole profile object, so
 * every profile field is part of the key. Throws when teamPrompt throws.
 */
export function promptVersion(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean): string {
  const key = JSON.stringify([role, provider, profile ?? null, publishHeads]);
  const cached = promptCache.get(key);
  if (cached !== undefined) return cached;
  const version = sha256(canonicalJson(renderedPrompts(role, provider, profile, publishHeads)));
  if (promptCache.size >= PROMPT_CACHE_LIMIT) promptCache.delete(promptCache.keys().next().value!);
  promptCache.set(key, version);
  return version;
}

/**
 * The guidance entries of `git diff-tree -r --raw` output, sorted by path. Each line is
 * `:000000 <mode> <zero id> <object id> A`, a tab, then the path. With `core.quotePath` on, Git writes a path that
 * holds a non-ASCII byte, a quote, a backslash, or a control character in its quoted form, so every line is ASCII
 * and a tab or a line break never appears inside a path. A line is kept when its status is `A`, its mode is a file
 * or a symbolic link, and its last path segment equals a GUIDANCE_FILES name. Malformed lines are skipped.
 */
export function parseGuidanceTree(stdout: string): { path: string; object: string }[] {
  const entries: { path: string; object: string }[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (meta.length !== 5 || !meta[0]!.startsWith(":")) continue;
    const [, mode, , object, status] = meta;
    // A quoted path ends with a quote. The file name itself needs no quoting when it is a guidance name.
    const name = basename(path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path);
    if (status !== "A" || !GUIDANCE_MODES.has(mode!) || !(GUIDANCE_FILES as readonly string[]).includes(name)) continue;
    entries.push({ path, object: object! });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** SHA-256 over the sorted path and object id pairs. No path or object id is kept. */
export function guidanceDigest(entries: readonly { path: string; object: string }[]): string {
  const sorted = entries.map(({ path, object }) => ({ path, object })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(canonicalJson(sorted));
}

/**
 * Best effort. Undefined on any failure. Never throws. Successes are cached per workspace and commit.
 *
 * Under a launcher such as sudo the host may not signal the command, so a stalled read cannot be stopped. Three
 * rules keep that bounded: one read per workspace and commit runs at a time and later callers share it; at most
 * GUIDANCE_READS_LIMIT reads run at once, and a caller that finds no free place waits for one; and a caller's wait
 * ends when its signal aborts, whether or not any child has ended.
 */
export async function readGuidanceDigest(workspace: string, commit: string, prefix: TeamCommand | undefined, signal: AbortSignal): Promise<string | undefined> {
  const key = JSON.stringify([workspace, commit]);
  for (;;) {
    const cached = guidanceCache.get(key);
    if (cached !== undefined) return cached;
    if (signal.aborted) return undefined;
    let read = guidanceReads.get(key);
    if (read === undefined && guidanceReads.size < GUIDANCE_READS_LIMIT) {
      const started: GuidanceRead = { waiters: new Set() };
      read = started;
      guidanceReads.set(key, started);
      void guidanceRead(workspace, commit, prefix, key).then(digest => {
        guidanceReads.delete(key);
        for (const waiter of [...started.waiters]) waiter(digest);
        for (const waiter of [...placeWaiters]) waiter();
      });
    }
    if (read !== undefined) return waitIn(read.waiters, signal);
    // No place is free. Wait for one, or for this caller's deadline, and look again.
    await waitIn(placeWaiters as Set<(value: undefined) => void>, signal);
  }
}

/** One read under its own time limit. It takes no caller's signal, because several callers share it. Never rejects. */
async function guidanceRead(workspace: string, commit: string, prefix: TeamCommand | undefined, key: string): Promise<string | undefined> {
  try {
    // One bounded read: the commit against the empty tree lists only the guidance files, so a large repository is not cut by the output cap.
    const emptyTree = commit.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
    const pathspecs = GUIDANCE_FILES.map(name => `:(glob)**/${name}`);
    // Quoted paths keep the output ASCII: the command decodes each output chunk on its own, and a split character would change the digest.
    const result = await teamCommand({ command: "git", args: teamGitArgs(workspace, ["-c", "core.quotePath=true", "diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames", emptyTree, commit, "--", ...pathspecs]) }, workspace, undefined, GUIDANCE_READ_TIMEOUT_MS, prefix);
    if (result.exitCode !== 0 || result.interrupted || result.truncated) return undefined;
    const digest = guidanceDigest(parseGuidanceTree(result.stdout));
    if (guidanceCache.size >= GUIDANCE_CACHE_LIMIT) guidanceCache.delete(guidanceCache.keys().next().value!);
    guidanceCache.set(key, digest);
    return digest;
  } catch {
    return undefined;
  }
}

/** The data of `member.configured`, or undefined when any component is unknown. Never throws. */
export async function memberConfiguration(input: {
  workspace: string; baseCommit: string; role: TeamMember["role"]; provider: Provider;
  profile?: TeamModelProfile; publishHeads: boolean; prefix?: TeamCommand;
}, signal: AbortSignal): Promise<MemberConfiguration | undefined> {
  try {
    const guidance = await readGuidanceDigest(input.workspace, input.baseCommit, input.prefix, signal);
    if (guidance === undefined) return undefined;
    const identity = profileIdentity(input.profile, input.provider);
    const profile: ProfileKey = { provider: identity.provider, model: identity.model ?? null, effort: identity.effort ?? null };
    const version = promptVersion(input.role, input.provider, input.profile, input.publishHeads);
    const components: ConfigComponents = { profile, promptVersion: version, guidance, knowledge: "none", routing: "off", shape: "team" };
    return { ...profile, promptVersion: version, guidance, knowledge: "none", routing: "off", shape: "team", configId: configId(components) };
  } catch {
    return undefined;
  }
}
