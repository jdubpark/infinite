import type { CandidateRecord, RoutingExplain, RoutingStatus, StatusProfile } from "./routing-types.js";

type Options = Record<string, string | boolean>;
type RoutingApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Me = { teams?: { routing?: number; routingAuto?: number } };
type ExplorePause = { projectId: string; explorePausedAt: string | null };

const USAGE = "Usage: infinite routing status PROJECT [--json] | infinite routing explain RUN_ID TASK_ID [--json] | infinite routing pause-explore PROJECT [--json] | infinite routing resume-explore PROJECT [--json]";
/** The newest decisions the status reads; routing-store.ts caps its project read at this many. */
export const DECISION_LIMIT = 500;
export const ROUTING_AUTO_NOTE = "Auto routing applies to runs created after the project's shadow period ends: 14 days and 50 recorded start decisions, whichever is later. infinite routing status PROJECT shows the progress.";
const ROUTING_VALUE_PRESETS = new Map<string, number>([["cost", 0.5], ["balanced", 2], ["quality", 8]]);
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const money = (value: number) => `$${value.toFixed(2)}`;
/** Three decimals, as status prints them. A value the host did not compute is printed as unknown, never as zero. */
const decimal = (value: number | undefined) => value === undefined ? "unknown" : String(Math.round(value * 1000) / 1000);

/** The settings the three --routing options name, checked before any request. Undefined when none is given. */
export function requestedRouting(options: Options): Record<string, unknown> | undefined {
  if (["--routing", "--routing-value", "--routing-contributor"].every(name => options[name] === undefined)) return undefined;
  const choice: Record<string, unknown> = {};
  if (options["--routing"] !== undefined) {
    const mode = String(options["--routing"]);
    if (mode !== "off" && mode !== "shadow" && mode !== "auto") throw new Error("--routing must be off, shadow, or auto.");
    choice.mode = mode;
  }
  if (options["--routing-value"] !== undefined) {
    const value = String(options["--routing-value"]);
    const dollars = ROUTING_VALUE_PRESETS.get(value) ?? (/^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN);
    if (!Number.isFinite(dollars) || dollars > 100) throw new Error("--routing-value must be cost, balanced, quality, or a dollar value from 0 to 100.");
    choice.successValueUsd = dollars;
  }
  if (options["--routing-contributor"] !== undefined) {
    const answer = String(options["--routing-contributor"]);
    if (answer !== "allow" && answer !== "deny") throw new Error("--routing-contributor must be allow or deny.");
    choice.allowContributor = answer === "allow";
  }
  return choice;
}

function profileLine(profile: StatusProfile): string {
  const name = clean(profile.profileId);
  if (profile.removed) return `  ${name}  removed: ${clean(profile.removed)}`;
  const { mass, appliedMass, rows } = profile.earlier;
  const earlier = mass === appliedMass ? `earlier mass ${mass} (${rows} rows)` : `earlier mass ${appliedMass} of ${mass} applied (${rows} rows)`;
  return `  ${name}  mean ${profile.mean} [${profile.interval[0]}, ${profile.interval[1]}] · rescue ${profile.rescue} · rows production ${profile.rows.production}, duel ${profile.rows.duel} · ${earlier} · level ${clean(profile.level)} · ${money(profile.costUsd)}${profile.greedy ? " · greedy" : ""}`;
}

/** The status of one project, in the order the plan fixes. Every text value passes through `clean`. */
export function routingStatusLines(status: RoutingStatus): string[] {
  const lines: string[] = [];
  const auto = status.mode === "auto";
  if (status.mode === "off") lines.push(`${clean(status.projectId)} · routing off`);
  else if (auto) lines.push(`${clean(status.projectId)} · routing auto (${status.modeSource === "saved" ? "saved" : "autonomous default"})`);
  else {
    // The autonomous default, also a saved policy without a mode, starts auto once its period ends; this line says so.
    const source = status.modeSource === "saved" ? "saved" : "autonomous default";
    // Without an implementer that passes the fixed rules, a saved auto refuses new runs and the default stays shadow.
    const starts = status.covers.start ? ": auto starts after the shadow period" : "";
    const requested = status.modeSource === "saved" && status.requested === "auto" ? ` · requested auto${starts}`
      : status.modeSource === "autonomous-default" && status.covers.start ? " · auto starts after the shadow period" : "";
    lines.push(`${clean(status.projectId)} · routing shadow (${source})${requested}`);
  }
  if (status.knobs) {
    const defaults = new Set<string>(status.defaults);
    const tag = (name: string) => defaults.has(name) ? " (default)" : "";
    const knobs = status.knobs;
    lines.push(`Value $${knobs.successValueUsd} per success${tag("successValueUsd")} · list weight ${knobs.listWeight}${tag("listWeight")} · contributor profiles ${knobs.allowContributor ? "allowed" : "not allowed"}${tag("allowContributor")}`);
  }
  lines.push(status.covers.start ? "Start: covered" : `Start: not covered (${clean(String(status.covers.reason))})`);
  const shadow = status.shadow;
  const capped = shadow.capped ? ` (newest ${DECISION_LIMIT})` : "";
  lines.push(shadow.withCoordinator === 0
    ? `Shadow, last ${shadow.windowDays} days: ${shadow.decisions} decisions; no decision had a coordinator pick${capped}`
    : `Shadow, last ${shadow.windowDays} days: ${shadow.decisions} decisions; the router matched the coordinator in ${shadow.agreements} of ${shadow.withCoordinator}${capped}`);
  const period = status.period;
  if (period.endedAt) {
    // Only a saved shadow needs the owner to ask for auto; the autonomous default starts it on its own.
    const needs = status.modeSource === "saved" && status.requested === "shadow" ? " Auto routing needs --routing auto." : "";
    lines.push(`Shadow period: ended ${clean(period.endedAt)}.${needs}`);
  } else {
    lines.push(period.firstAt === null
      ? "Shadow period: no decision yet."
      : `Shadow period: ${period.decisions} of ${period.targetDecisions} decisions since ${clean(period.firstAt)}; it ends after ${period.targetDays} days and ${period.targetDecisions} decisions, whichever is later.`);
  }
  lines.push(auto
    ? `Explored: ${status.explore.exploratory} of ${status.explore.of} auto start decisions in the last 30 days.`
    : `Would explore: ${status.explore.exploratory} of ${status.explore.of}, before the share, budget, and headroom guards.`);
  if (status.share) {
    const share = status.share;
    lines.push(share.of === 0
      ? "Exploration share: no auto start decision yet."
      : `Exploration share: ${share.exploratory} of the last ${share.of} pending or applied starts; the limit is ${share.limit} of ${share.window}.`);
  }
  if (status.explore.pausedAt) lines.push(`Exploration paused since ${clean(status.explore.pausedAt)}.`);
  if (status.auto) {
    const counts = status.auto;
    lines.push(`Auto starts, last 30 days: ${counts.pending} pending, ${counts.applied} applied, ${counts.released} released.${counts.capped ? ` (newest ${DECISION_LIMIT})` : ""}`);
  }
  const costs = status.costs;
  lines.push(`Costs are tier defaults: light ${money(costs.lightUsd)}, strong ${money(costs.strongUsd)}, rescue ${money(costs.rescueUsd)}. Limit headroom is not modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.`);
  if (auto) lines.push("The router's applied choices count at full weight.");
  for (const entry of status.cells) {
    if (entry.cell.scope === "new-task") lines.push("New task (project level)");
    else {
      const cell = entry.cell;
      const map = cell.featureMap === "default" ? "default" : clean(cell.featureMap.slice(0, 12));
      lines.push(`Cell ${clean(cell.area)} · ${cell.taskKind === null ? "no kind" : clean(cell.taskKind)} · features v${cell.featureVersion} ${map}`);
    }
    for (const profile of entry.profiles) lines.push(profileLine(profile));
  }
  if (status.cellsCapped) lines.push("Older cells are not shown.");
  if (status.unreadableCells > 0) lines.push(`Cells with unreadable details: ${status.unreadableCells}.`);
  return lines;
}

function candidateLine(candidate: CandidateRecord): string {
  const name = clean(candidate.profileId);
  if (candidate.removed) return `  ${name}  removed: ${clean(candidate.removed)}`;
  const cost = candidate.costUsd === undefined ? "unknown" : money(candidate.costUsd);
  const fallback = candidate.samplerFallback ? " · sampler fallback" : "";
  return `  ${name}  mean ${decimal(candidate.thetaMean)} · deviation ${decimal(candidate.thetaSd)} · rescue ${decimal(candidate.phiMean)} · cost ${cost} · greedy utility ${decimal(candidate.greedyUtility)} · sample ${decimal(candidate.sample)} · sampled utility ${decimal(candidate.sampledUtility)}${fallback}`;
}

/** The start decisions of one task, per decision: its header, its choice, its seed, and one line per candidate. */
export function routingExplainLines(explain: RoutingExplain): string[] {
  return explain.decisions.flatMap(decision => {
    const lines = [
      `Revision ${decision.revision} · ${clean(decision.point)} ${decision.ordinal} · ${clean(decision.mode)} · ${clean(decision.state)} · basis ${clean(decision.basis)} · decided ${clean(decision.decidedAt)}`,
      `Chosen ${clean(decision.chosenProfileId)} · greedy ${clean(decision.greedyProfileId)} · coordinator ${decision.coordinatorProfileId === null ? "none" : clean(decision.coordinatorProfileId)} · explore ${decision.explore ? "yes" : "no"}`,
      `Policy ${clean(decision.policyDigest.slice(0, 12))} · seed ${clean(decision.seed.slice(0, 12))} · algorithm ${decision.algorithmVersion} · reward ${decision.rewardVersion}`,
    ];
    const guards = decision.payload?.guards;
    if (guards) lines.push(`Guards: pause ${guards.pausedAt ? `since ${clean(guards.pausedAt)}` : "none"} · spare attempts ${guards.spareAttempts} · share ${guards.share.exploratory} of ${guards.share.of}`);
    if (decision.payload === null) lines.push("The decision's details are unreadable.");
    else for (const candidate of decision.payload.candidates) lines.push(candidateLine(candidate));
    return lines;
  });
}

/** Maps the host's fixed error answers to the plan's sentences. Other failures pass through unchanged. */
async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
    if (failure.status === 503) throw new Error("The evidence store is unavailable.");
    if (failure.status === 404 && failure.code === "unknown-project") throw new Error("No project has this ID.");
    if (failure.status === 404 && failure.code === "routing-decision-not-found") throw new Error("No routing decision exists for this run and task.");
    if (failure.status === 400) throw new Error("The host refused the routing request as invalid.");
    throw error;
  }
}

export async function handleRoutingClientCommand(positional: string[], options: Options, api: RoutingApi): Promise<void> {
  const [verb, first, second] = positional;
  const status = verb === "status" && positional.length === 2;
  const explain = verb === "explain" && positional.length === 3;
  const exploration = (verb === "pause-explore" || verb === "resume-explore") && positional.length === 2;
  if (!status && !explain && !exploration) throw new Error(USAGE);
  // Checked before the route, so an older host answers with the upgrade sentence instead of a 404.
  const me = await api.json<Me>("/me");
  if (me.teams?.routing !== 1) throw new Error("This host does not record routing decisions. Upgrade the host first.");
  const json = options["--json"] === true;
  if (exploration) {
    if (me.teams?.routingAuto !== 1) throw new Error("This host does not support exploration pauses. Upgrade the host first.");
    const pausing = verb === "pause-explore";
    const value = await read(() => api.json<ExplorePause>(`/routing/projects/${encodeURIComponent(first!)}/explore/${pausing ? "pause" : "resume"}`, {}));
    if (json) console.log(JSON.stringify(value, null, 2));
    else console.log(pausing ? `Exploration paused for ${clean(first!)} since ${clean(String(value.explorePausedAt))}.` : `Exploration resumed for ${clean(first!)}.`);
    return;
  }
  if (status) {
    const value = await read(() => api.json<RoutingStatus>(`/routing/projects/${encodeURIComponent(first!)}`));
    if (json) console.log(JSON.stringify(value, null, 2));
    else for (const line of routingStatusLines(value)) console.log(line);
    return;
  }
  const value = await read(() => api.json<RoutingExplain>(`/teams/${encodeURIComponent(first!)}/routing/${encodeURIComponent(second!)}`));
  if (json) console.log(JSON.stringify(value, null, 2));
  else for (const line of routingExplainLines(value)) console.log(line);
}
