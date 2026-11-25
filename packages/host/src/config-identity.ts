import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalJson } from "./evidence/crypto.js";
import { intentCheckerPrompt } from "./intent-prompt.js";
import { evaluatorPrompt } from "./verdict-prompt.js";
import { judgePrompt } from "./judge-prompt.js";
import type { CriteriaRow } from "./verdict-types.js";
import type { ObjectivePrompt } from "./objective-digest.js";
import { profileIdentity } from "./run-events.js";
import { entryCommand, reportCommand, teamPrompt } from "./team-prompts.js";
import { memberLaunchPrompt } from "./code-mode.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import type { RecordDigest, RegisterDigest, TeamCommand, TeamMember, TeamModelProfile, TeamRun, TeamScout, TeamTask } from "./team-types.js";
import type { Provider } from "./types.js";

export type { ObjectivePrompt } from "./objective-digest.js";

export const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const GUIDANCE_READ_TIMEOUT_MS = 30_000;
const GUIDANCE_CACHE_LIMIT = 64;
const GUIDANCE_READS_LIMIT = 4;
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
const GUIDANCE_MODES = new Set(["100644", "100755", "120000"]);
const PROMPT_CACHE_LIMIT = 256;
const ROUTING_DIGEST = /^[0-9a-f]{64}$/;

export type ProfileKey = { provider: string; model: string | null; effort: string | null };
export interface ConfigComponents {
  profile: ProfileKey;
  promptVersion: string;
  guidance: string;
  knowledge: "none";
  routing: string;
  shape: "team" | "trial";
}
export type MemberConfiguration = ConfigComponents["profile"] & Omit<ConfigComponents, "profile"> & { configId: string };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function isRoutingComponent(value: unknown): value is string {
  return value === "off" || (typeof value === "string" && ROUTING_DIGEST.test(value));
}

export function profileIdentityKey(profile: ProfileKey): string {
  return sha256(canonicalJson({ provider: profile.provider, model: profile.model ?? null, effort: profile.effort ?? null }));
}

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

const FIXTURE_RECORD: RecordDigest = {
  version: 1,
  criteria: [
    { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" },
    { id: "c1", statement: "Fixture owner criterion.", check: "command:npm test", producer: "host" },
  ],
};
const FIXTURE_REGISTER: RegisterDigest = {
  assumptions: [{ id: "a1", status: "unchecked", criticality: "plan", statement: "Fixture assumption." }],
  questions: [{ id: "q1", text: "Fixture question? Default: keep." }],
};
const FIXTURE_ROWS: CriteriaRow[] = [
  { criterion: "c0", status: "met", check: "judgement:owner-text" },
  { criterion: "c1", status: "not-met", check: "command:npm test" },
];
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
type GuidanceRead = { waiters: Set<(digest: string | undefined) => void> };
const guidanceReads = new Map<string, GuidanceRead>();
const placeWaiters = new Set<() => void>();

function waitIn<T>(waiters: Set<(value: T | undefined) => void>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise(resolve => {
    const done = (value: T | undefined) => { waiters.delete(done); signal.removeEventListener("abort", onAbort); resolve(value); };
    const onAbort = () => done(undefined);
    waiters.add(done);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function objectiveFixture(plain: TeamRun, objectiveDigest: ObjectivePrompt): TeamRun {
  if (objectiveDigest === false || !plain.goal) return plain;
  const rows = typeof objectiveDigest === "string" && objectiveDigest.endsWith("criteria") ? { criteria: FIXTURE_ROWS } : {};
  if (objectiveDigest === true || objectiveDigest === "criteria") return { ...plain, goal: { ...plain.goal, record: FIXTURE_RECORD, ...rows } };
  return {
    ...plain,
    autonomy: String(objectiveDigest).startsWith("register-autonomous") ? "autonomous" : "supervised",
    goal: { ...plain.goal, record: { ...FIXTURE_RECORD, register: FIXTURE_REGISTER }, ...rows },
  };
}

export function renderedPrompts(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean, entryTools = false, objectiveDigest: ObjectivePrompt = false, codeMode = false): string[] {
  const command = reportCommand();
  if (role === "intent-checker") return [memberLaunchPrompt(intentCheckerPrompt(provider, profile), provider, codeMode).split(command).join("<report-command>")];
  if (role === "evaluator") return [memberLaunchPrompt(evaluatorPrompt(provider, profile), provider, codeMode).split(command).join("<report-command>")];
  if (role === "judge") return [memberLaunchPrompt(judgePrompt(provider), provider, codeMode).split(command).join("<report-command>")];
  const entry = entryCommand();
  return FIXTURES.map(({ run: plain, work }) => {
    const run = objectiveFixture(plain, objectiveDigest);
    return memberLaunchPrompt(teamPrompt(entryTools ? { ...run, blackboard: { tools: true } } : run, role, work, undefined, provider, profile, { checks: FIXTURE_CHECKS }, [], publishHeads), provider, codeMode)
      .split(command).join("<report-command>").split(entry).join("<entry-command>");
  });
}

export function promptVersion(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean, entryTools = false, objectiveDigest: ObjectivePrompt = false, codeMode = false): string {
  const key = JSON.stringify([role, provider, profile ?? null, publishHeads, entryTools, objectiveDigest, codeMode]);
  const cached = promptCache.get(key);
  if (cached !== undefined) return cached;
  const version = sha256(canonicalJson(renderedPrompts(role, provider, profile, publishHeads, entryTools, objectiveDigest, codeMode)));
  if (promptCache.size >= PROMPT_CACHE_LIMIT) promptCache.delete(promptCache.keys().next().value!);
  promptCache.set(key, version);
  return version;
}

export function judgePromptVersion(provider: Provider): string {
  return promptVersion("judge", provider, undefined, false);
}

export function parseGuidanceTree(stdout: string): { path: string; object: string }[] {
  const entries: { path: string; object: string }[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (meta.length !== 5 || !meta[0]!.startsWith(":")) continue;
    const [, mode, , object, status] = meta;
    const name = basename(path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path);
    if (status !== "A" || !GUIDANCE_MODES.has(mode!) || !(GUIDANCE_FILES as readonly string[]).includes(name)) continue;
    entries.push({ path, object: object! });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function guidanceDigest(entries: readonly { path: string; object: string }[]): string {
  const sorted = entries.map(({ path, object }) => ({ path, object })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(canonicalJson(sorted));
}

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
    await waitIn(placeWaiters as Set<(value: undefined) => void>, signal);
  }
}

async function guidanceRead(workspace: string, commit: string, prefix: TeamCommand | undefined, key: string): Promise<string | undefined> {
  try {
    const emptyTree = commit.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
    const pathspecs = GUIDANCE_FILES.map(name => `:(glob)**/${name}`);
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

export async function memberConfiguration(input: {
  workspace: string; baseCommit: string; role: TeamMember["role"]; provider: Provider;
  profile?: TeamModelProfile; publishHeads: boolean; entryTools?: boolean; objectiveDigest?: ObjectivePrompt; prefix?: TeamCommand;
  shape?: "team" | "trial";
  routing?: string;
  codeMode?: boolean;
}, signal: AbortSignal): Promise<MemberConfiguration | undefined> {
  if (input.routing !== undefined && !isRoutingComponent(input.routing)) return undefined;
  const routing = input.routing ?? "off";
  try {
    const guidance = await readGuidanceDigest(input.workspace, input.baseCommit, input.prefix, signal);
    if (guidance === undefined) return undefined;
    const identity = profileIdentity(input.profile, input.provider);
    const profile: ProfileKey = { provider: identity.provider, model: identity.model ?? null, effort: identity.effort ?? null };
    const version = promptVersion(input.role, input.provider, input.profile, input.publishHeads, input.entryTools === true, input.objectiveDigest ?? false, input.codeMode === true);
    const shape = input.shape ?? "team";
    const components: ConfigComponents = { profile, promptVersion: version, guidance, knowledge: "none", routing, shape };
    return { ...profile, promptVersion: version, guidance, knowledge: "none", routing, shape, configId: configId(components) };
  } catch {
    return undefined;
  }
}
