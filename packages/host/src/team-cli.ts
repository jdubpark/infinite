import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createTeamSchema } from "./team-types.js";
import { captureWorkspace, readWorkspaceBlob } from "./workspace-checkpoint.js";
import { localProjectPath } from "./mirrored-projects.js";
import { readSyncState, syncServiceRunning } from "./sync-service.js";

type ClientConfig = { origin: string; token: string; projectId?: string };
type Api = {
  request(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<Response>;
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T>;
};
type Options = Record<string, string | boolean>;
const commandSchema = z.object({ command: z.string().min(1).max(4096).refine(value => !value.includes("\0")), args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]) }).strict();
const projectConfigSchema = z.object({ setup: commandSchema.optional(), checks: z.array(commandSchema).min(1).max(8) }).strict();
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const projectIdPattern = /^[a-z0-9-]{1,80}$/;

function privateJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function readPrivateJson(path: string, fallback: unknown) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("Private CLI state is unreadable; preserve it and inspect the file before retrying.");
  }
}
function git(cwd: string, args: string[], timeout = 10000) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}
function canonicalRoot(directory: string) {
  const path = realpathSync(directory);
  if (!statSync(path).isDirectory()) throw new Error("Choose a repository directory.");
  const root = realpathSync(git(path, ["rev-parse", "--show-toplevel"]));
  if (root === realpathSync(homedir()) || root === dirname(root)) throw new Error("Run this inside a project repository; the home directory and filesystem root are not supported.");
  return root;
}
export function boundTeamProject(config: ClientConfig, configPath: string, directory = process.cwd()): string | undefined {
  let root: string;
  try {
    root = canonicalRoot(directory);
  } catch { return undefined; }
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const file = join(dirname(configPath), "team-cli", identity, "repo-mappings.json");
  const stored = (readPrivateJson(file, {}) as Record<string, unknown>)[`${config.origin}\n${root}`];
  const projectId = typeof stored === "string" ? stored : (stored as { projectId?: unknown } | undefined)?.projectId;
  if (projectId === undefined) return undefined;
  if (typeof projectId !== "string" || !projectIdPattern.test(projectId)) throw new Error("Saved repository binding is invalid; inspect private team CLI state before launching.");
  return projectId;
}
function commandArray(text: string, flag: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${flag} must contain a JSON command array.`); }
  if (!Array.isArray(value)) throw new Error(`${flag} must contain a JSON command array.`);
  return value.map(item => commandSchema.parse(item));
}
function inferredProjectConfig(root: string, options: Options) {
  const pkgFile = join(root, "package.json");
  let pkg: { scripts?: Record<string, unknown> } | undefined;
  try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("package.json is unreadable; supply explicit setup and check JSON.");
  }
  const hasLock = ["package-lock.json", "npm-shrinkwrap.json"].some(name => { try { return statSync(join(root, name)).isFile(); } catch { return false; } });
  const setup = options["--setup-json"] !== undefined ? commandArray(String(options["--setup-json"]), "--setup-json") : hasLock ? [{ command: "npm", args: ["ci"] }] : [];
  const checks = options["--check-json"] !== undefined ? commandArray(String(options["--check-json"]), "--check-json") : pkg?.scripts?.check ? [{ command: "npm", args: ["run", "check"] }] : [];
  if (!checks.length) throw new Error("No package check script was found. Supply --check-json with a JSON array of command objects.");
  if (setup.length > 1) throw new Error("--setup-json contains one setup command at most.");
  return projectConfigSchema.parse({ ...(setup[0] ? { setup: setup[0] } : {}), checks });
}
function outputTeam(team: any, json: boolean) {
  if (json) { console.log(JSON.stringify(team, null, 2)); return; }
  console.log(`${clean(team.id)}  ${clean(team.status)}  ${clean(team.title)}`);
  console.log(`Project ${clean(team.projectId)} · workspace ${clean(team.workspace)} · branch ${clean(team.branch)}`);
  if (team.linear?.issue?.url) console.log(`Linear ${clean(team.linear.issue.url)}`);
  else if (team.linear?.url) console.log(`Linear ${clean(team.linear.url)}`);
  if (team.reason) console.log(`Reason: ${clean(team.reason)}`);
  for (const question of team.decisions ?? []) if (!question.answer) console.log(`Question ${clean(question.id)}: ${clean(question.question)}`);
}
function receipt(path: string, key: string, body: unknown) {
  const records = readPrivateJson(path, {}) as Record<string, unknown>;
  const record = { requestId: (body as { requestId: string }).requestId, body, createdAt: new Date().toISOString(), state: "pending" };
  records[key] = record;
  privateJson(path, records);
}
function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function requireSamePendingIntent(path: string, prefix: string, endpoint: string, intent: (body: any) => boolean, requestId: string | undefined, rawArgs: string[]) {
  const records = readPrivateJson(path, {}) as Record<string, any>;
  const prior = Object.entries(records).find(([key, value]) => key.startsWith(prefix) && value?.state === "pending" && value.endpoint === endpoint && intent(value.body));
  if (!prior) return;
  if (requestId === prior[1].requestId) return;
  const commandArgs = rawArgs.filter((value, index) => value !== "--request-id" && rawArgs[index - 1] !== "--request-id");
  const retry = `infinite ${[...commandArgs, "--request-id", prior[1].requestId].map(shellQuote).join(" ")}`;
  throw new Error(`An earlier request has an uncertain result. Inspect the current state first. If this is the same operation, retry with its saved request ID: ${retry}`);
}
async function postMutation(api: Api, receiptPath: string, key: string, endpoint: string, body: Record<string, unknown>, method = "POST", logRequest = true) {
  const records = readPrivateJson(receiptPath, {}) as Record<string, any>;
  const prior = records[key];
  if (prior?.requestId === body.requestId) {
    if (prior.endpoint !== endpoint || prior.method !== method) throw new Error("This request ID was already used for a different mutation.");
    if (prior.state === "confirmed") {
      const readPath = method === "PUT" ? endpoint : endpoint === "/teams" ? `/teams/${prior.resultId}` : `/${endpoint.split("/").filter(Boolean).slice(0, 2).join("/")}`;
      return api.json<any>(readPath);
    }
    body = prior.body;
  } else {
    records[key] = { requestId: body.requestId, endpoint, method, body, createdAt: new Date().toISOString(), state: "pending" };
    privateJson(receiptPath, records);
  }
  if (logRequest) process.stderr.write(`[Infinite] Request ${String(body.requestId)}\n`);
  const result = await api.json<any>(endpoint, body, undefined, undefined, method);
  records[key] = { ...records[key], state: "confirmed", resultId: result.id };
  privateJson(receiptPath, records);
  return result;
}

async function uploadCommit(api: Api, projectId: string, root: string, commit: string, tempStore: string, captured: (manifestId: string) => void) {
  const detail = await api.json<any>(`/projects/${projectId}`);
  if (detail.sync?.pendingGeneration) throw new Error("The cloud project has a pending sync generation. Resolve it before capturing local source.");
  const cloned = mkdtempSync(join(tmpdir(), "infinite-team-source-"));
  rmSync(cloned, { recursive: true, force: true });
  const source = join(cloned, "repo");
  try {
    execFileSync("git", ["clone", "--no-local", "--no-hardlinks", "--no-checkout", root, source], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", source, "checkout", "--detach", commit], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "ignore", "pipe"] });
    try { execFileSync("git", ["-C", source, "remote", "remove", "origin"], { stdio: "ignore", timeout: 5000 }); } catch { /* No remote is safe. */ }
    const cwd = realpathSync(source);
    const manifest = await captureWorkspace({ roots: [cwd], cwd, storeDir: tempStore });
    captured(manifest.id);
    const { generation } = await api.json<{ generation: string }>(`/projects/${projectId}/sync/begin`, {});
    const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
    for (let offset = 0; offset < hashes.length; offset += 512) {
      const batch = hashes.slice(offset, offset + 512);
      const { missing } = await api.json<{ missing: string[] }>(`/projects/${projectId}/sync/has`, { hashes: batch });
      if (!Array.isArray(missing) || missing.some(hash => !batch.includes(hash))) throw new Error("Host returned an invalid source upload request.");
      for (const hash of missing) {
        const bytes = Buffer.from(await readWorkspaceBlob(tempStore, hash), "base64");
        const response = await api.request(`/projects/${projectId}/sync/blob/${hash}`, bytes, undefined, { "Content-Type": "application/octet-stream" }, "PUT");
        await response.body?.cancel();
      }
    }
    const commitResponse = await api.request(`/projects/${projectId}/sync/commit`, { generation, manifest }, AbortSignal.timeout(300000));
    const committed = await commitResponse.json() as any;
    const current = await api.json<any>(`/projects/${projectId}`);
    return { manifestId: manifest.id, committed, sync: current.sync };
  } finally { rmSync(cloned, { recursive: true, force: true }); }
}

export async function handleTeamClientCommand(command: "repo" | "team", positional: string[], options: Options, config: ClientConfig, api: Api, configPath: string, rawArgs: string[]): Promise<boolean> {
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const stateDir = join(dirname(configPath), "team-cli", identity);
  const mappingsPath = join(stateDir, "repo-mappings.json"), receiptsPath = join(stateDir, "receipts.json");
  if (command === "repo") {
    if (positional[0] !== "init" || positional.length > 2) throw new Error("Usage: infinite repo init [DIRECTORY] [--project ID] [--setup-json JSON] [--check-json JSON] [--linear-team UUID] [--linear-project UUID]");
    const root = canonicalRoot(positional[1] ?? process.cwd());
    const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
    if (status) throw new Error("Repository must be clean before onboarding. Commit or remove tracked and untracked changes first.");
    const commit = git(root, ["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git did not report a valid commit.");
    const repoConfig = inferredProjectConfig(root, options);
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    const linearTeam = options["--linear-team"] === undefined ? undefined : z.uuid().parse(String(options["--linear-team"]));
    const linearProject = options["--linear-project"] === undefined ? undefined : z.uuid().parse(String(options["--linear-project"]));
    const handoff = String(options["--handoff"] ?? "auto");
    if (handoff !== "auto" && handoff !== "off") throw new Error("--handoff must be auto or off.");
    const me = await api.json<any>("/me");
    if (me.teams?.repoEnrollment !== 1) throw new Error("This host does not support repository enrollment. Upgrade the host before running repo init.");
    const mappings = readPrivateJson(mappingsPath, {}) as Record<string, unknown>;
    const key = `${config.origin}\n${root}`;
    const stored = mappings[key];
    const storedProject = typeof stored === "string" ? stored : (stored as { projectId?: unknown } | undefined)?.projectId;
    const explicitProject = options["--project"] !== undefined;
    const localSource = !explicitProject && !storedProject;
    const project = localSource ? await api.json<{ id: string; name: string; path: string }>("/projects/resolve", { path: localProjectPath(root) }) : undefined;
    const selected = String(options["--project"] ?? storedProject ?? project?.id ?? "");
    if (!projectIdPattern.test(selected)) throw new Error("Invalid project ID.");
    const target = await api.json<any>(`/projects/${selected}/team`);
    if (!target.hostSetup?.ready) throw new Error(`Host team configuration is incomplete: ${clean((target.hostSetup?.missing ?? ["teams.workspaceDir"]).join(", "))}. Configure the host before enrolling a repository.`);
    const detail = await api.json<any>(`/projects/${selected}`);
    const sourceKind = explicitProject ? "project" : localSource ? "local" : (stored as { source?: string } | undefined)?.source ?? "project";
    const uploadKey = `${key}:source-upload:${selected}:${commit}`;
    const records = readPrivateJson(receiptsPath, {}) as Record<string, any>;
    let sourceReceipt = records[uploadKey];
    if (sourceKind === "local" && sourceReceipt?.state === "pending-apply") {
      if (!detail.sync?.pendingGeneration && detail.sync?.appliedManifest === sourceReceipt.manifestId) {
        sourceReceipt = { ...sourceReceipt, state: "confirmed" };
        records[uploadKey] = sourceReceipt; privateJson(receiptsPath, records);
      } else {
        const reason = clean(detail.sync?.pendingGeneration?.reason ?? "sync-state-changed");
        throw new Error(`The source snapshot is not applied (${reason}). No team configuration was written. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun repo init for this directory with --request-id ${sourceReceipt.requestId}. Do not force apply over cloud changes.`);
      }
    }
    const uploadSource = sourceKind === "local" && !detail.sync?.appliedManifest && sourceReceipt?.state !== "confirmed";
    if (uploadSource && detail.sync?.pendingGeneration) throw new Error("The cloud project has a pending sync generation. Resolve it before capturing local source.");
    if (uploadSource) {
      const state = readSyncState(join(dirname(configPath), "sync", `${selected}.json`));
      if (state && syncServiceRunning(state) && state.origin === config.origin && state.root === root)
        throw new Error("Continuous sync is active for this checkout. Stop it before one-time team source capture.");
    }
    if (linearProject && !linearTeam && !target.linear?.teamId) throw new Error("--linear-project requires --linear-team unless Linear is already configured for this project.");
    const body: Record<string, any> = { requestId, revision: target.revision, team: { ...repoConfig, handoff }, ...(linearTeam ? { linear: { teamId: linearTeam, ...(linearProject ? { projectId: linearProject } : {}) } } : linearProject ? { linear: { teamId: target.linear?.teamId, projectId: linearProject } } : {}) };
    requireSamePendingIntent(receiptsPath, `${key}:repo-init:`, `/projects/${selected}/team`, prior => JSON.stringify(prior.team) === JSON.stringify(body.team) && JSON.stringify(prior.linear ?? null) === JSON.stringify(body.linear ?? null), options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    if (uploadSource) {
      process.stderr.write(`[Infinite] Request ${requestId}\n`);
      const temp = mkdtempSync(join(tmpdir(), "infinite-team-blobs-"));
      sourceReceipt = readPrivateJson(receiptsPath, {})[uploadKey];
      if (sourceReceipt?.state === "pending") {
        rmSync(temp, { recursive: true, force: true });
        throw new Error("A prior source upload has an uncertain result. Inspect the cloud project before attempting another capture.");
      }
      const alreadyUploaded = sourceReceipt?.state === "confirmed";
      if (!alreadyUploaded) receipt(receiptsPath, uploadKey, { requestId, projectId: selected, commit });
      try {
        if (!alreadyUploaded) {
          const result = await uploadCommit(api, selected, root, commit, join(temp, "objects"), manifestId => {
            const prepared = readPrivateJson(receiptsPath, {}) as Record<string, any>;
            prepared[uploadKey] = { ...prepared[uploadKey], manifestId };
            privateJson(receiptsPath, prepared);
          });
          if (result.committed.pendingGeneration || result.committed.appliedManifest !== result.manifestId || result.sync?.pendingGeneration || result.sync?.appliedManifest !== result.manifestId) {
            const reason = clean(result.sync?.pendingGeneration?.reason ?? result.committed.pendingGeneration?.reason ?? "not-applied");
            const pending = readPrivateJson(receiptsPath, {}) as Record<string, any>;
            pending[uploadKey] = { ...pending[uploadKey], state: "pending-apply", pendingReason: reason };
            privateJson(receiptsPath, pending);
            throw new Error(`The source snapshot is pending (${reason}); repo init stopped before team configuration. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun repo init for this directory with --request-id ${requestId}. Do not force apply over cloud changes.`);
          }
          const completed = readPrivateJson(receiptsPath, {}) as Record<string, any>;
          completed[uploadKey] = { ...completed[uploadKey], state: "confirmed" };
          privateJson(receiptsPath, completed);
        }
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    await postMutation(api, receiptsPath, `${key}:repo-init:${requestId}`, `/projects/${selected}/team`, body, "PUT", !uploadSource);
    const output = await api.json<any>(`/projects/${selected}/team`);
    mappings[key] = { projectId: selected, source: sourceKind }; privateJson(mappingsPath, mappings);
    if (explicitProject || uploadSource) { config.projectId = selected; privateJson(configPath, config); }
    console.log(JSON.stringify({ id: selected, name: clean(output.name), path: clean(output.path), team: output.team, linear: output.linear, revision: output.revision, execution: output.execution, source: uploadSource ? `local commit ${commit}` : detail.sync?.appliedManifest ? "existing cloud checkout retained" : "configured project checkout" }, null, 2));
    return true;
  }
  const [subcommand, id, ...rest] = positional;
  if (subcommand === "start") {
    if (rest.length) throw new Error("Usage: infinite team start [OBJECTIVE] [--prd FILE] [--provider PROVIDER]");
    const prd = options["--prd"] === undefined ? "" : readFileSync(String(options["--prd"]), "utf8");
    const objective = [id ?? "", prd].filter(Boolean).join("\n\n").trim();
    if (!objective) throw new Error("Provide an objective or --prd FILE.");
    const projectId = String(options["--project"] ?? (() => {
      const root = canonicalRoot(process.cwd()), mappings = readPrivateJson(mappingsPath, {}) as Record<string, unknown>;
      const entry = mappings[`${config.origin}\n${root}`];
      return typeof entry === "string" ? entry : (entry as { projectId?: string } | undefined)?.projectId ?? "";
    })());
    if (!projectIdPattern.test(projectId)) throw new Error("No repository project is bound to this directory. Run infinite repo init or use --project ID.");
    const project = await api.json<any>(`/projects/${projectId}/team`);
    if (!project.hostSetup?.ready) throw new Error(`Host team configuration is incomplete: ${clean((project.hostSetup?.missing ?? ["teams.workspaceDir"]).join(", "))}. Configure the host before starting a team.`);
    if (!project.team?.checks?.length) throw new Error("Team setup is missing. Run infinite repo init with setup/check commands before starting a team.");
    const me = await api.json<any>("/me");
    const provider = String(options["--provider"] ?? me.teams?.lineup?.coordinator?.provider ?? "");
    if (!provider) throw new Error("The host has no configured team lineup. Set one up on the host or use --provider PROVIDER for a single-provider team.");
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    const body = createTeamSchema.parse({ requestId, projectId, provider, useConfiguredLineup: options["--provider"] === undefined, title: String(options["--title"] ?? objective.split("\n")[0].slice(0, 100)), objective, parallelism: 2 });
    requireSamePendingIntent(receiptsPath, "team-start:", "/teams", prior => prior.projectId === body.projectId && prior.provider === body.provider && prior.useConfiguredLineup === body.useConfiguredLineup && prior.title === body.title && prior.objective === body.objective, options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    const team = await postMutation(api, receiptsPath, `team-start:${requestId}`, "/teams", body);
    outputTeam(team, Boolean(options["--json"])); return true;
  }
  if (subcommand === "status" || subcommand === "watch") {
    if (subcommand === "watch" && !id) throw new Error("Usage: infinite team watch ID");
    if (id && rest.length) throw new Error(`Usage: infinite team ${subcommand} [ID]`);
    const abort = new AbortController(), stop = () => abort.abort();
    process.once("SIGINT", stop);
    try {
      do {
        const teams = id ? [await api.json<any>(`/teams/${id}`, undefined, abort.signal)] : (await api.json<{ teams: any[] }>("/teams", undefined, abort.signal)).teams;
        if (options["--json"]) console.log(JSON.stringify(id ? teams[0] : teams, null, subcommand === "watch" ? undefined : 2));
        else for (const team of teams) outputTeam(team, false);
        if (subcommand !== "watch") break;
        await delay(2000, undefined, { signal: abort.signal });
      } while (!abort.signal.aborted);
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { process.off("SIGINT", stop); }
    return true;
  }
  if (["steer", "answer", "pause", "resume", "cancel"].includes(subcommand ?? "")) {
    if (!id) throw new Error(`Usage: infinite team ${subcommand} ID ...`);
    const current = await api.json<any>(`/teams/${id}`);
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    let endpoint = `/teams/${id}/${subcommand}`, body: Record<string, unknown>;
    if (subcommand === "steer") {
      const text = rest.join(" "); if (!text) throw new Error("Provide steering text.");
      body = { requestId, revision: current.revision, text };
    } else if (subcommand === "answer") {
      const [questionId, ...answer] = rest, text = answer.join(" ");
      if (!questionId || !text) throw new Error("Usage: infinite team answer ID QUESTION_ID TEXT");
      endpoint = `/teams/${id}/decisions/${questionId}/answer`; body = { requestId, revision: current.revision, text };
    } else {
      if (rest.length) throw new Error(`Usage: infinite team ${subcommand} ID`);
      body = { requestId, revision: current.revision };
    }
    requireSamePendingIntent(receiptsPath, `team-${subcommand}:`, endpoint, prior => subcommand === "steer" || subcommand === "answer" ? prior.text === body.text : true, options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    outputTeam(await postMutation(api, receiptsPath, `team-${subcommand}:${requestId}`, endpoint, body), Boolean(options["--json"])); return true;
  }
  throw new Error("Usage: infinite team start|status|watch|steer|answer|pause|resume|cancel ...");
}
