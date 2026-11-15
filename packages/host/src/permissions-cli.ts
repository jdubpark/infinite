import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceDelegationView } from "./permission-delegation-types.js";
import type { HeadlessChannelStatus } from "./permission-agent-types.js";

type PermissionsApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;
type PermissionStatus = { agent: string; policyVersion: number; interruptClasses: string[]; workspaces: WorkspaceDelegationView[]; rates: { lastHour: { decisions: number }; lastDay: { decisions: number } } | null; headless?: HeadlessChannelStatus | null };
type DelegationResult = { agent: string; views: WorkspaceDelegationView[]; replacedOptOuts: string[] };
type RevocationResult = { agent: string; view: WorkspaceDelegationView };

const clean = (value: unknown, limit = 500) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);
const INACTIVE_NOTICE = "The permission agent is not active on this host yet. Requests are handled as before; this record takes effect when the agent is activated.";
const STATUS_USAGE = "Usage: infinite permissions status [--json]";
const DELEGATE_USAGE = "Usage: infinite permissions delegate (--workspace W | --all) [--direction TEXT | --clear-direction] [--request-id UUID]";
const REVOKE_USAGE = "Usage: infinite permissions revoke --workspace W [--request-id UUID]";

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

/** Live headless sessions, and the allow rules of served ones that a class rule outranks. */
function printHeadless(status: HeadlessChannelStatus) {
  if (!status.sessions.length) return;
  console.log("Headless sessions:");
  for (const session of status.sessions) {
    console.log(`  ${clean(session.title, 200)}  ${clean(session.sessionId)}  ${clean(session.state)}${session.reason ? `: ${clean(session.reason)}` : ""}`);
    if (session.waiting) console.log(`    Waits for you: ${clean(session.waiting.tool)} (${clean(session.waiting.interruptClass)}) since ${clean(session.waiting.since)}, retired at ${clean(session.waiting.expiresAt)}`);
  }
  for (const rule of status.shadowed)
    console.log(`  Allow rule ${clean(rule.rule)} of ${clean(rule.sessionId)} is outranked by ${clean(rule.classRule)} (${clean(rule.interruptClass)}): such a call waits for you.`);
}

function printNotice(agent: string) {
  if (agent === "inactive") console.log(INACTIVE_NOTICE);
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
      if (result.headless) printHeadless(result.headless);
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
  throw new Error("Usage: infinite permissions status|delegate|revoke ...");
}
