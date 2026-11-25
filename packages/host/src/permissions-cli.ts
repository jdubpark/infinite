import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { WorkspaceDelegationView } from "./permission-delegation-types.js";
import { REPLAY_SET_BYTES, replaySetSchema } from "./permission-replay.js";
import type { HeadlessChannelStatus } from "./permission-agent-types.js";

type PermissionsApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;
type RateFlag = { sessionId: string; workspaceId: string; lastHour: number; baselineMedian: number; threshold: number };
type Mark = { requestId: string; decisionId: string; at: string; label: string; note: string };
type LogEntry = {
  id: string; at: string; workspaceId: string; workspaceName?: string; projectId: string; projectName?: string; taskId: string; assignment: string;
  sessionId: string; role?: string; provider: string; family?: string; action: { tool: string; summary: string }; rules: string[];
  tiers: Array<{ tier: string; profileId: string; family: string; startedAt: string; endedAt: string }>;
  verdict: string; code?: string; interruptClass?: string; note?: string; replayOf?: string; repeats?: string; durationMs: number | null;
  rejectState?: string; rateFlagged?: boolean; deliveries: Array<{ at: string; kind: string; detail?: string }>; marks: Mark[];
  controls: Array<{ kind: string; at: string; reason?: string }>;
};
type LogPage = { entries: LogEntry[]; next?: string; rateFlags: RateFlag[] | null };
type RateFigure = { count: number; relevant: number; rate: number | null; lower: number; upper: number };
type ReplaySummary = { id: string; finishedAt: string; cases: number; missRate: RateFigure };
type PermissionStatus = {
  agent: string; policyVersion: number; interruptClasses: string[]; workspaces: WorkspaceDelegationView[];
  rates: { lastHour: { decisions: number }; lastDay: { decisions: number } } | null;
  rateFlags?: RateFlag[] | null;
  readiness?: { ready: boolean; reasons: string[] };
  replay?: { latest: ReplaySummary | null; running: { id: string; done: number; total: number } | null };
  headless?: HeadlessChannelStatus | null;
};
type ReplayFigures = { cases: number; outcomes: Record<string, number>; missRate: RateFigure; wrongfulRejectRate: RateFigure };
type ReplayJob = {
  id: string; state: "running" | "finished" | "failed"; done: number; total: number; error?: string;
  result?: { id: string; cases: number; finishedAt: string; set: ReplayFigures; byClass: Record<string, ReplayFigures>; byTier: Record<string, ReplayFigures> };
};
type DelegationResult = { agent: string; views: WorkspaceDelegationView[]; replacedOptOuts: string[]; deliveryFence?: "uncertain" };
type RevocationResult = { agent: string; view: WorkspaceDelegationView; deliveryFence?: "uncertain" };
const UNFENCED = "An answer that was already with a session could not be stopped for certain. Run infinite permissions log to see what was delivered.";
type ReopenResult = { decisionId: string; reject: string; code: string; assignment: string; locked: boolean };
type UnlockResult = { assignment: string; wasLocked: boolean; locked: boolean };

const clean = (value: unknown, limit = 500) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);
const INACTIVE_NOTICE = "The permission agent is not ready on this host, so it serves no request. Run infinite permissions status to see why. Requests are handled as before; this record takes effect when the host is ready.";
const STATUS_USAGE = "Usage: infinite permissions status [--json]";
const DELEGATE_USAGE = "Usage: infinite permissions delegate (--workspace W | --all) [--direction TEXT | --clear-direction] [--request-id UUID]";
const REVOKE_USAGE = "Usage: infinite permissions revoke --workspace W [--request-id UUID]";
const REOPEN_USAGE = "Usage: infinite permissions reopen DECISION_ID [--request-id UUID] [--json]";
const UNLOCK_USAGE = "Usage: infinite permissions unlock ASSIGNMENT [--request-id UUID] [--json]";
const LOG_USAGE = "Usage: infinite permissions log [--rejected] [--raised] [--workspace W] [--since T] [--limit N] [--before CURSOR] [--json]";
const MARK_USAGE = "Usage: infinite permissions mark DECISION_ID --wrong --note TEXT [--request-id UUID]";
const MARK_NOTICE = "A mark is a record only and changes no decision. To change later decisions, reopen the reject or change the workspace's direction.";

export function sinceOption(value: string, now = Date.now()): string {
  const span = /^(\d{1,4})([mhd])$/.exec(value);
  if (span) return new Date(now - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m" | "h" | "d"]).toISOString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))
    return new Date(Date.parse(value)).toISOString();
  throw new Error("--since needs a time with a zone, such as 2026-11-14T09:00Z, or a span such as 30m, 24h or 7d");
}

const when = (value: string) => clean(value).replace(/:\d{2}(?:\.\d+)?Z$/, "Z").replace("T", " ");
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function verdictLine(entry: LogEntry) {
  const outcome = entry.verdict === "reject" ? `reject ${clean(entry.code)}` : entry.verdict === "owner" ? `owner ${clean(entry.interruptClass)}` : "allow";
  return [outcome, entry.rejectState && clean(entry.rejectState), entry.replayOf && "replay", entry.rateFlagged && "above usual rate"].filter(Boolean).join(" · ");
}

function printRateFlags(flags: RateFlag[] | null | undefined) {
  for (const flag of flags ?? [])
    console.log(`Above usual rate: session ${clean(flag.sessionId)} in ${clean(flag.workspaceId)}, ${Number(flag.lastHour)} decisions in the last hour (flagged above ${Number(flag.threshold)})`);
}

function printEntry(entry: LogEntry) {
  const place = [entry.workspaceName ?? entry.workspaceId, entry.projectName ?? entry.projectId].map(value => clean(value)).join(" / ");
  console.log(`${when(entry.at)}  ${verdictLine(entry)}  ${place}`);
  console.log(`  Id: ${clean(entry.id)}`);
  console.log(`  Action: ${clean(entry.action.tool)}: ${clean(entry.action.summary, 2000)}`);
  const requester = [`session ${clean(entry.sessionId)}`, entry.role && clean(entry.role), clean(entry.provider), entry.family && `family ${clean(entry.family)}`].filter(Boolean).join(" · ");
  console.log(`  Requester: ${requester}`);
  console.log(`  Task: ${clean(entry.taskId)} · assignment ${clean(entry.assignment)}`);
  if (entry.rules.length) console.log(`  Host rules: ${entry.rules.map(rule => clean(rule)).join(", ")}`);
  if (entry.tiers.length) {
    const tiers = entry.tiers.map(tier => `${clean(tier.tier)} ${clean(tier.profileId)} (${clean(tier.family)}) ${seconds(Date.parse(tier.endedAt) - Date.parse(tier.startedAt))}`);
    console.log(`  Tiers: ${tiers.join(", then ")}${entry.durationMs === null ? "" : ` · ${seconds(entry.durationMs)} in all`}`);
  } else console.log("  Tiers: none");
  if (entry.replayOf) console.log(`  Replay of: ${clean(entry.replayOf)}`);
  if (entry.repeats) console.log(`  Repeats: ${clean(entry.repeats)}`);
  if (entry.deliveries.length) console.log(`  Delivery: ${entry.deliveries.map(event => `${clean(event.kind)} ${when(event.at)}${event.detail ? ` (${clean(event.detail, 200)})` : ""}`).join(", ")}`);
  for (const control of entry.controls) console.log(`  ${control.kind === "reopen" ? "Reopened" : "Closed"}: ${when(control.at)}${control.reason ? ` (${clean(control.reason)})` : ""}`);
  if (entry.note) console.log(`  Note (owner only): ${clean(entry.note, 2000)}`);
  for (const mark of entry.marks) console.log(`  Marked ${clean(mark.label)}: ${when(mark.at)}: ${clean(mark.note, 2000)}`);
}
const REPLAY_USAGE = "Usage: infinite permissions replay --set FILE [--json] [--request-id UUID]";
const REPLAY_POLL_MS = 2_000;
const REPLAY_CONTACT_MS = 120_000;

function unanswered(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

function dropped(error: unknown): boolean {
  return error instanceof TypeError;
}

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

async function requireDecisionLogHost(api: PermissionsApi) {
  const me = await api.json<{ permissions?: { decisionLog?: number } }>("/me");
  if (me.permissions?.decisionLog !== 1) throw new Error("This host does not have the permission decision log. Upgrade the host.");
}

function printView(view: WorkspaceDelegationView) {
  console.log(`${clean(view.name)}  ${clean(view.workspaceId)}  ${clean(view.state)}`);
  if (view.direction) console.log(`  Direction: ${clean(view.direction, 4000)}`);
  for (const project of view.projects) console.log(`  ${clean(project.name)}  ${clean(project.projectId)}  ${clean(project.state)}`);
}

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
      printRateFlags(result.rateFlags);
      printReadiness(result);
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
      if (result.deliveryFence === "uncertain") console.log(UNFENCED);
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
      if (result.deliveryFence === "uncertain") console.log(UNFENCED);
      printNotice(result.agent);
    }
    return true;
  }
  if (verb === "reopen") {
    const [, decisionId] = positional;
    if (positional.length !== 2 || !decisionId) throw new Error(REOPEN_USAGE);
    const requestId = requestIdOption(options);
    await requireDelegationHost(api);
    console.error(`[Infinite] Reopening permission decision ${clean(decisionId)} · request ${requestId}`);
    const result = await api.json<ReopenResult>("/permissions/reopenings", { requestId, decisionId });
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Reopened reject ${clean(result.reject)} (${clean(result.code)}). It is closed, it is not replayed, and the same request gets a fresh review. Nothing was allowed.`);
      if (result.locked) console.log(`Assignment ${clean(result.assignment)} is still locked by another reject. Use infinite permissions unlock to release it.`);
    }
    return true;
  }
  if (verb === "unlock") {
    const [, assignment] = positional;
    if (positional.length !== 2 || !assignment) throw new Error(UNLOCK_USAGE);
    const requestId = requestIdOption(options);
    await requireDelegationHost(api);
    console.error(`[Infinite] Unlocking permission assignment ${clean(assignment)} · request ${requestId}`);
    const result = await api.json<UnlockResult>("/permissions/unlocks", { requestId, assignment });
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.wasLocked ? "Unlocked" : "Was not locked:"} ${clean(result.assignment)}. Its repeat count is reset. Nothing was allowed.`);
    return true;
  }
  if (verb === "log") {
    if (positional.length !== 1) throw new Error(LOG_USAGE);
    const params = new URLSearchParams();
    if (options["--rejected"]) params.set("rejected", "1");
    if (options["--raised"]) params.set("raised", "1");
    const workspace = stringOption(options, "--workspace");
    if (workspace !== undefined) params.set("workspace", workspace);
    const since = stringOption(options, "--since");
    if (since !== undefined) params.set("since", sinceOption(since));
    const limit = stringOption(options, "--limit");
    if (limit !== undefined) {
      if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error("--limit must be a number from 1 to 200");
      params.set("limit", limit);
    }
    const before = stringOption(options, "--before");
    if (before !== undefined) {
      if (!/^\d{1,15}\.\d{1,15}$/.test(before)) throw new Error("--before must be the cursor that a previous page printed");
      params.set("before", before);
    }
    await requireDecisionLogHost(api);
    const query = params.toString();
    const page = await api.json<LogPage>(`/permissions/log${query ? `?${query}` : ""}`);
    if (options["--json"]) console.log(JSON.stringify(page, null, 2));
    else {
      printRateFlags(page.rateFlags);
      if (!page.entries.length) console.log("No permission decisions match.");
      for (const entry of page.entries) printEntry(entry);
      if (page.next) console.log(`More decisions: add --before ${clean(page.next)}`);
    }
    return true;
  }
  if (verb === "mark") {
    const decisionId = positional[1];
    const note = stringOption(options, "--note");
    if (positional.length !== 2 || !decisionId || options["--wrong"] !== true || note === undefined) throw new Error(MARK_USAGE);
    if (!note.trim()) throw new Error("--note needs text that says why the decision was wrong");
    if (note.length > 2000) throw new Error("--note can hold at most 2000 characters");
    const requestId = requestIdOption(options);
    await requireDecisionLogHost(api);
    console.error(`[Infinite] Marking decision ${clean(decisionId)} wrong · request ${requestId}`);
    const result = await api.json<{ mark: Mark }>("/permissions/marks", { requestId, decisionId, label: "wrong", note });
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Marked ${clean(result.mark.decisionId)} ${clean(result.mark.label)} at ${when(result.mark.at)}`);
      console.log(MARK_NOTICE);
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
    const status = await api.json<PermissionStatus>("/permissions/status");
    if (!status.readiness) throw new Error("This host does not support permission replays. Upgrade the host.");
    console.error(`[Infinite] Replaying ${parsed.data.cases.length} cases · request ${requestId}`);
    let answered = Date.now();
    const ask = async <T>(path: string, body?: unknown): Promise<T> => {
      for (;;) {
        try {
          const answer = await api.json<T>(path, body);
          answered = Date.now();
          return answer;
        } catch (error) {
          if (!unanswered(error) && !(body === undefined && dropped(error))) throw error;
          if (Date.now() - answered >= REPLAY_CONTACT_MS)
            throw new Error(`The host did not answer for ${REPLAY_CONTACT_MS / 60_000} minutes. The replay may still run: run this command again with --request-id ${requestId} to follow it. If the host restarted meanwhile, that starts the replay again.`);
          await delay(REPLAY_POLL_MS);
        }
      }
    };
    let { job } = await ask<{ job: ReplayJob }>("/permissions/replays", { requestId, set });
    let shown = -1;
    while (job.state === "running") {
      if (job.done !== shown) { console.error(`[Infinite] ${Number(job.done)} of ${Number(job.total)} cases`); shown = job.done; }
      await delay(REPLAY_POLL_MS);
      job = (await ask<{ job: ReplayJob }>(`/permissions/replays/${encodeURIComponent(job.id)}`)).job;
    }
    if (job.state !== "finished" || !job.result) throw new Error(clean(job.error ?? "The replay did not finish.", 500));
    if (options["--json"]) console.log(JSON.stringify(job.result, null, 2));
    else printReplay(job);
    return true;
  }
  throw new Error("Usage: infinite permissions status|delegate|revoke|reopen|unlock|log|mark|replay ...");
}
