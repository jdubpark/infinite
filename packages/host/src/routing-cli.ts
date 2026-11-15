import type { CandidateRecord, RoutingExplain, RoutingStatus, StatusProfile } from "./routing-types.js";

type Options = Record<string, string | boolean>;
type RoutingApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Me = { teams?: { routing?: number } };

const USAGE = "Usage: infinite routing status PROJECT [--json] | infinite routing explain RUN_ID TASK_ID [--json]";
/** The newest decisions the status reads; routing-store.ts caps its project read at this many. */
const DECISION_LIMIT = 500;
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const money = (value: number) => `$${value.toFixed(2)}`;
/** A value the host did not compute is printed as unknown, never as zero. */
const known = (value: number | undefined) => value === undefined ? "unknown" : String(value);

function profileLine(profile: StatusProfile): string {
  const name = clean(profile.profileId);
  if (profile.removed) return `  ${name}  removed: ${profile.removed}`;
  return `  ${name}  mean ${profile.mean} [${profile.interval[0]}, ${profile.interval[1]}] · rescue ${profile.rescue} · rows production ${profile.rows.production}, duel ${profile.rows.duel} · earlier mass ${profile.earlier.mass} (${profile.earlier.rows} rows) · level ${profile.level} · ${money(profile.costUsd)}${profile.greedy ? " · greedy" : ""}`;
}

/** The status of one project, in the order the plan fixes. Every text value passes through `clean`. */
export function routingStatusLines(status: RoutingStatus): string[] {
  const lines: string[] = [];
  if (status.mode === "off") lines.push(`${clean(status.projectId)} · routing off`);
  else {
    const source = status.source === "saved" ? "saved" : "autonomous default";
    const requested = status.requested === "auto" ? " · requested auto: this host records shadow decisions only" : "";
    lines.push(`${clean(status.projectId)} · routing shadow (${source})${requested}`);
  }
  if (status.knobs) {
    const defaults = new Set<string>(status.defaults);
    const tag = (name: string) => defaults.has(name) ? " (default)" : "";
    const knobs = status.knobs;
    lines.push(`Value $${knobs.successValueUsd} per success${tag("successValueUsd")} · list weight ${knobs.listWeight}${tag("listWeight")} · contributor profiles ${knobs.allowContributor ? "allowed" : "not allowed"}${tag("allowContributor")}`);
  }
  lines.push(status.covers.start ? "Start: covered" : `Start: not covered (${status.covers.reason})`);
  const shadow = status.shadow;
  const capped = shadow.capped ? ` (newest ${DECISION_LIMIT})` : "";
  lines.push(shadow.withCoordinator === 0
    ? `Shadow, last ${shadow.windowDays} days: ${shadow.decisions} decisions; no decision had a coordinator pick${capped}`
    : `Shadow, last ${shadow.windowDays} days: ${shadow.decisions} decisions; the router matched the coordinator in ${shadow.agreements} of ${shadow.withCoordinator}${capped}`);
  const period = status.period;
  lines.push(period.firstAt === null
    ? "Shadow period: no decision yet."
    : `Shadow period: ${period.decisions} of ${period.targetDecisions} decisions since ${clean(period.firstAt)}; it ends after ${period.targetDays} days and ${period.targetDecisions} decisions, whichever is later.`);
  lines.push(`Would explore: ${status.explore.exploratory} of ${status.explore.of}, before the share, budget, and headroom guards.`);
  const costs = status.costs;
  lines.push(`Costs are tier defaults: light ${money(costs.lightUsd)}, strong ${money(costs.strongUsd)}, rescue ${money(costs.rescueUsd)}. Limit headroom is not modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.`);
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
  if (candidate.removed) return `  ${name}  removed: ${candidate.removed}`;
  const cost = candidate.costUsd === undefined ? "unknown" : money(candidate.costUsd);
  const fallback = candidate.samplerFallback ? " · sampler fallback" : "";
  return `  ${name}  mean ${known(candidate.thetaMean)} · deviation ${known(candidate.thetaSd)} · rescue ${known(candidate.phiMean)} · cost ${cost} · greedy utility ${known(candidate.greedyUtility)} · sample ${known(candidate.sample)} · sampled utility ${known(candidate.sampledUtility)}${fallback}`;
}

/** The start decisions of one task, per decision: its header, its choice, its seed, and one line per candidate. */
export function routingExplainLines(explain: RoutingExplain): string[] {
  return explain.decisions.flatMap(decision => {
    const lines = [
      `Revision ${decision.revision} · ${clean(decision.point)} ${decision.ordinal} · ${clean(decision.mode)} · ${clean(decision.state)} · basis ${clean(decision.basis)} · decided ${clean(decision.decidedAt)}`,
      `Chosen ${clean(decision.chosenProfileId)} · greedy ${clean(decision.greedyProfileId)} · coordinator ${decision.coordinatorProfileId === null ? "none" : clean(decision.coordinatorProfileId)} · explore ${decision.explore ? "yes" : "no"}`,
      `Policy ${clean(decision.policyDigest.slice(0, 12))} · seed ${clean(decision.seed.slice(0, 12))} · algorithm ${decision.algorithmVersion} · reward ${decision.rewardVersion}`,
    ];
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
  if (!status && !explain) throw new Error(USAGE);
  // Checked before the route, so an older host answers with the upgrade sentence instead of a 404.
  const me = await api.json<Me>("/me");
  if (me.teams?.routing !== 1) throw new Error("This host does not record routing decisions. Upgrade the host first.");
  const json = options["--json"] === true;
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
