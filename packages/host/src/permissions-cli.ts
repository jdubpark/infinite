import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { WorkspaceDelegationView } from "./permission-delegation-types.js";
import { REPLAY_SET_BYTES, replaySetSchema } from "./permission-replay.js";

type PermissionsApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;
type RateFigure = { count: number; relevant: number; rate: number | null; lower: number; upper: number };
type ReplaySummary = { id: string; finishedAt: string; cases: number; missRate: RateFigure };
type PermissionStatus = {
  agent: string; policyVersion: number; interruptClasses: string[]; workspaces: WorkspaceDelegationView[];
  rates: { lastHour: { decisions: number }; lastDay: { decisions: number } } | null;
  readiness?: { ready: boolean; reasons: string[] };
  replay?: { latest: ReplaySummary | null; running: { id: string; done: number; total: number } | null };
};
type ReplayFigures = { cases: number; outcomes: Record<string, number>; missRate: RateFigure; wrongfulRejectRate: RateFigure };
type ReplayJob = {
  id: string; state: "running" | "finished" | "failed"; done: number; total: number; error?: string;
  result?: { id: string; cases: number; finishedAt: string; set: ReplayFigures; byClass: Record<string, ReplayFigures>; byTier: Record<string, ReplayFigures> };
};
type DelegationResult = { agent: string; views: WorkspaceDelegationView[]; replacedOptOuts: string[] };
type RevocationResult = { agent: string; view: WorkspaceDelegationView };

const clean = (value: unknown, limit = 500) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);
const INACTIVE_NOTICE = "The permission agent is not active on this host yet. Requests are handled as before; this record takes effect when the agent is activated.";
const STATUS_USAGE = "Usage: infinite permissions status [--json]";
const DELEGATE_USAGE = "Usage: infinite permissions delegate (--workspace W | --all) [--direction TEXT | --clear-direction] [--request-id UUID]";
const REVOKE_USAGE = "Usage: infinite permissions revoke --workspace W [--request-id UUID]";
const REPLAY_USAGE = "Usage: infinite permissions replay --set FILE [--json] [--request-id UUID]";
const REPLAY_POLL_MS = 2_000;

const stringOption = (options: Options, name: string) => {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
};

function requestIdOption(options: Options): string {
  const value = options["--request-id"];
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !z.uuid().safeParse(value).success) throw new Error("--request-id must be a UUID");
  return value;
}

async function requireDelegationHost(api: PermissionsApi) {
  const me = await api.json<{ permissions?: { workspaceDelegation?: number } }>("/me");
  if (me.permissions?.workspaceDelegation !== 1) throw new Error("This host does not support workspace permission delegation. Upgrade the host.");
}

function printView(view: WorkspaceDelegationView) {
  console.log(`${clean(view.name)}  ${clean(view.workspaceId)}  ${clean(view.state)}`);
  if (view.direction) console.log(`  Direction: ${clean(view.direction, 4000)}`);
  for (const project of view.projects) console.log(`  ${clean(project.name)}  ${clean(project.projectId)}  ${clean(project.state)}`);
}

function printNotice(agent: string) {
  if (agent === "inactive") console.log(INACTIVE_NOTICE);
}

const percent = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const rateLine = (figure: RateFigure) => `${percent(figure.rate)} (${Number(figure.count)} of ${Number(figure.relevant)}, 95% interval ${percent(figure.lower)} to ${percent(figure.upper)})`;

function printReadiness(status: PermissionStatus) {
  if (!status.readiness) return;
  console.log(`Permission agent: ${status.readiness.ready ? "ready" : "not ready"}`);
  for (const reason of status.readiness.reasons) console.log(`  ${clean(reason, 1000)}`);
  const latest = status.replay?.latest;
  if (latest) console.log(`Replay: ${Number(latest.cases)} cases on ${clean(latest.finishedAt, 40)}, miss rate ${rateLine(latest.missRate)}`);
  const running = status.replay?.running;
  if (running) console.log(`Replay running: ${Number(running.done)} of ${Number(running.total)} cases`);
}

function printReplay(job: ReplayJob) {
  const result = job.result!;
  console.log(`Replay ${clean(result.id)}: ${Number(result.cases)} cases`);
  console.log(`  Miss rate: ${rateLine(result.set.missRate)}`);
  console.log(`  Wrongful reject rate: ${rateLine(result.set.wrongfulRejectRate)}`);
  for (const [title, groups] of [["Class", result.byClass], ["Tier", result.byTier]] as const) {
    for (const [name, figures] of Object.entries(groups))
      console.log(`  ${title} ${clean(name, 60)}: ${Number(figures.cases)} cases, miss rate ${rateLine(figures.missRate)}, wrongful reject rate ${rateLine(figures.wrongfulRejectRate)}`);
  }
}

export async function handlePermissionsClientCommand(positional: string[], options: Options, api: PermissionsApi): Promise<boolean> {
  const [verb] = positional;
  if (verb === "status") {
    if (positional.length !== 1) throw new Error(STATUS_USAGE);
    const result = await api.json<PermissionStatus>("/permissions/status");
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else {
      if (!result.workspaces.length) console.log("No projects are enrolled on this host.");
      for (const view of result.workspaces) printView(view);
      if (result.rates) console.log(`Decisions: ${Number(result.rates.lastHour.decisions)} in the last hour, ${Number(result.rates.lastDay.decisions)} in the last day`);
      printReadiness(result);
      printNotice(result.agent);
    }
    return true;
  }
  if (verb === "delegate") {
    const workspace = stringOption(options, "--workspace");
    const all = options["--all"] === true;
    if (positional.length !== 1) throw new Error(DELEGATE_USAGE);
    if ((workspace !== undefined) === all) throw new Error("Choose one of --workspace W or --all");
    if (options["--direction"] !== undefined && options["--clear-direction"]) throw new Error("Choose either --direction TEXT or --clear-direction");
    const text = stringOption(options, "--direction");
    if (text !== undefined && !text.trim()) throw new Error("--direction needs text. Use --clear-direction to remove the direction.");
    const direction = options["--clear-direction"] ? null : text?.trim();
    const requestId = requestIdOption(options);
    await requireDelegationHost(api);
    const body = {
      requestId,
      ...(workspace !== undefined ? { workspaceId: workspace } : { all: true }),
      ...(direction === undefined ? {} : { direction }),
    };
    console.error(`[Infinite] Delegating ${workspace !== undefined ? `workspace ${clean(workspace)}` : "all workspaces"} · request ${requestId}`);
    const result = await api.json<DelegationResult>("/permissions/delegations", body);
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else {
      for (const view of result.views) printView(view);
      if (result.replacedOptOuts.length) console.log(`Replaced opt-outs: ${result.replacedOptOuts.map(projectId => clean(projectId)).join(", ")}`);
      printNotice(result.agent);
    }
    return true;
  }
  if (verb === "revoke") {
    const workspace = stringOption(options, "--workspace");
    if (positional.length !== 1 || workspace === undefined || options["--all"] || options["--direction"] !== undefined || options["--clear-direction"])
      throw new Error(REVOKE_USAGE);
    const requestId = requestIdOption(options);
    await requireDelegationHost(api);
    console.error(`[Infinite] Revoking workspace ${clean(workspace)} · request ${requestId}`);
    const result = await api.json<RevocationResult>("/permissions/revocations", { requestId, workspaceId: workspace });
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else {
      printView(result.view);
      printNotice(result.agent);
    }
    return true;
  }
  if (verb === "replay") {
    const file = stringOption(options, "--set");
    if (positional.length !== 1 || file === undefined) throw new Error(REPLAY_USAGE);
    const requestId = requestIdOption(options);
    let set: unknown;
    try {
      if (statSync(file).size > REPLAY_SET_BYTES) throw new Error("size");
      set = JSON.parse(readFileSync(file, "utf8"));
    } catch { throw new Error(`The replay set must be a readable JSON file of at most ${REPLAY_SET_BYTES / (1024 * 1024)} MB.`); }
    const parsed = replaySetSchema.safeParse(set);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`The replay set is invalid at ${clean(issue.path.join(".") || "the top level", 200)}: ${clean(issue.message, 300)}`);
    }
    // A host without the decision core reports no readiness.
    const status = await api.json<PermissionStatus>("/permissions/status");
    if (!status.readiness) throw new Error("This host does not support permission replays. Upgrade the host.");
    console.error(`[Infinite] Replaying ${parsed.data.cases.length} cases · request ${requestId}`);
    let { job } = await api.json<{ job: ReplayJob }>("/permissions/replays", { requestId, set });
    let shown = -1;
    // A replay can take many model turns. The host runs it as a job; the CLI polls until it ends.
    while (job.state === "running") {
      if (job.done !== shown) { console.error(`[Infinite] ${Number(job.done)} of ${Number(job.total)} cases`); shown = job.done; }
      await delay(REPLAY_POLL_MS);
      job = (await api.json<{ job: ReplayJob }>(`/permissions/replays/${encodeURIComponent(job.id)}`)).job;
    }
    if (job.state !== "finished" || !job.result) throw new Error(clean(job.error ?? "The replay did not finish.", 500));
    if (options["--json"]) console.log(JSON.stringify(job.result, null, 2));
    else printReplay(job);
    return true;
  }
  throw new Error("Usage: infinite permissions status|delegate|revoke|replay ...");
}
