import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CreateRoutine, Routine } from "./routine-types.js";
import { createRoutineSchema, routineActionSchema } from "./routine-types.js";

type RoutineApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);

function readRoutineFile(file: string, requestId?: string): CreateRoutine {
  const info = statSync(file);
  if (!info.isFile() || info.size > 40 * 1024) throw new Error("Routine file must be a regular JSON file no larger than 40 KiB");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Routine file must contain valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Routine file must contain a JSON object");
  const value = parsed as Record<string, unknown>;
  if (requestId !== undefined) {
    if (value.requestId !== undefined && value.requestId !== requestId) throw new Error("--request-id must match the requestId in the routine file");
    value.requestId = requestId;
  }
  if (!value.requestId) throw new Error("Routine creation needs a stable request ID. Put requestId in the file or pass --request-id UUID.");
  const result = createRoutineSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid routine file: ${result.error.issues.map(issue => `${issue.path.join(".") || "routine"}: ${issue.message}`).join("; ")}`);
  if (Date.parse(result.data.expiresAt) <= Date.parse(result.data.startsAt)) throw new Error("expiresAt must be later than startsAt");
  return result.data;
}

function printRoutine(routine: Routine) {
  const goal = routine.goal;
  const budget = `${goal.maxRuns} goal cycles · ${goal.maxTotalMinutes ?? goal.maxMinutes} min per occurrence · up to ${goal.maxMembers} members`;
  console.log(`${clean(routine.id)}  ${clean(routine.status)}  revision ${routine.revision}  ${clean(goal.title)}`);
  console.log(`  Project ${clean(goal.projectId)} · ${budget} · ${routine.occurrences.length}/${routine.maxOccurrences} occurrences`);
  if (routine.activeGoalId) console.log(`  Active goal ${clean(routine.activeGoalId)}`);
  if (routine.nextRunAt && (routine.status === "scheduled" || (routine.status === "running" && !routine.activeGoalId))) console.log(`  Next due ${clean(routine.nextRunAt)}`);
  if (routine.reason) console.log(`  Reason ${clean(routine.reason)}`);
  if (["paused", "cancelled"].includes(routine.status)) console.log("  Future triggers stopped; any active goal continues under its own controls and limits.");
  if (routine.status === "blocked") console.log("  Review the reason and current project policy before resuming or replacing this routine.");
  for (const occurrence of routine.occurrences) console.log(`  Goal ${clean(occurrence.goalId)} · started ${clean(occurrence.startedAt)}`);
}

export async function handleRoutineClientCommand(positional: string[], options: Options, api: RoutineApi): Promise<boolean> {
  const [verb, id] = positional;
  if (verb === "create") {
    if (positional.length !== 1 || !options["--file"]) throw new Error("Usage: infinite routine create --file FILE [--request-id UUID] [--json]");
    const input = readRoutineFile(String(options["--file"]), options["--request-id"] === undefined ? undefined : String(options["--request-id"]));
    // Print before the network call so an interrupted/ambiguous request can be retried with this same identity.
    console.error(`[Infinite] Creating routine ${input.requestId}`);
    const result = await api.json<Routine>("/routines", input);
    if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else printRoutine(result);
    return true;
  }
  if (verb === "list") {
    if (positional.length !== 1) throw new Error("Usage: infinite routine list [--json]");
    const result = await api.json<{ routines: Routine[] }>("/routines");
    if (options["--json"]) console.log(JSON.stringify(result, null, 2));
    else if (!result.routines.length) console.log("No routines. Create one with infinite routine create --file FILE.");
    else for (const routine of result.routines) printRoutine(routine);
    return true;
  }
  if (verb === "status") {
    if (positional.length !== 2) throw new Error("Usage: infinite routine status ID [--json]");
    const result = await api.json<Routine>(`/routines/${encodeURIComponent(id!)}`);
    if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else printRoutine(result);
    return true;
  }
  if (["pause", "resume", "cancel"].includes(verb ?? "")) {
    if (positional.length !== 2 || !id) throw new Error(`Usage: infinite routine ${verb} ID --revision N [--request-id UUID] [--json]`);
    const revision = Number(options["--revision"]);
    const requestId = String(options["--request-id"] ?? randomUUID());
    const payload = routineActionSchema.safeParse({ requestId, revision });
    if (!payload.success) throw new Error(`Routine ${verb} requires --revision N and a valid --request-id UUID`);
    console.error(`[Infinite] ${verb} routine ${clean(id)} · request ${payload.data.requestId}`);
    const result = await api.json<Routine>(`/routines/${encodeURIComponent(id)}/${verb}`, payload.data);
    if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else printRoutine(result);
    return true;
  }
  throw new Error("Usage: infinite routine create|list|status|pause|resume|cancel ...");
}
