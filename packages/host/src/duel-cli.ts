import type { EvalApi } from "./eval-cli.js";
import type { CalibrationView } from "./judge-store.js";

type Options = Record<string, string | boolean>;

const USAGE = "Usage: infinite duels calibrate --judge PROFILE_ID [--pairs N] [--project ID[,ID...]] [--judge-minutes N] --request-id UUID [--json] | infinite duels judges [--json] | infinite duels cancel CALIBRATION [--json]. Without --pairs the host picks 36.";
const CALIBRATE_USAGE = USAGE.split(" | ")[0]!;
const PAIRS_RANGE = [30, 60] as const;
const MINUTES_RANGE = [2, 30] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSALS = new Map([
  ["judge-not-configured", "The host has no judge configured."],
  ["judge-profile-mismatch", "That profile is not the configured judge."],
  ["judge-launch-missing", "The judge's provider has no eval login on the host."],
  ["calibration-active", "A calibration is already running."],
  ["request-conflict", "This request ID was already used for a different request."],
  ["eval-config-incomplete", "The host's eval configuration is incomplete."],
  ["too-few-pairs", "The projects hold too few resolved pairs for this request."],
  ["invalid-calibration-request", "The host refused the request as invalid."],
  ["unknown-calibration", "No calibration has this ID."],
]);
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const fixed = (value: number | null | undefined) => typeof value === "number" ? value.toFixed(3) : "unknown";
const whole = (value: number | null | undefined) => typeof value === "number" ? String(value) : "unknown";
const spend = (cost: CalibrationView["cost"]) => `known spend ${whole(cost.tokens)} tokens, ${typeof cost.spentUsd === "number" ? `$${cost.spentUsd.toFixed(2)}` : "USD unknown"}`;

function viewLines(view: CalibrationView): string[] {
  const running = view.status === "running";
  const reason = view.reason ? ` · ${clean(view.reason)}` : "";
  const projects = view.pairs.perProject.map(p => `${clean(p.projectId)} ${whole(p.pairs)}`).join(", ");
  return [
    `calibration ${clean(view.calibrationId)} judge ${clean(view.profileId)} epoch ${whole(view.profileEpoch)} · ${clean(view.status)}${reason} · state ${view.state === null || view.state === undefined ? "none" : clean(view.state)}${typeof view.waiting === "string" ? ` · waiting on ${clean(view.waiting)}` : ""}`,
    `pairs ${running ? "unknown" : whole(view.pairs.counted)} (${projects}) of ${whole(view.pairs.planned)} planned · correct ${running ? "unknown" : whole(view.pairs.correct)} · accuracy ${fixed(view.accuracy)} · lower bound ${fixed(view.lowerBound)} · swap agreement ${fixed(view.swapAgreement)}`,
    `${view.inForce ? "in force" : "not in force"} · judge minutes ${whole(view.judgeMinutes)} · ${spend(view.cost)} · created ${clean(view.createdAt)}${view.validUntil ? ` · valid until ${clean(view.validUntil)}` : ""}`,
  ];
}

export function judgeLines(views: CalibrationView[]): string[] {
  const note = "A calibration measures a judge against pairs whose answer is known.";
  return views.length === 0 ? [note, "no calibrations"] : [note, ...views.flatMap(viewLines)];
}

async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
    const known = typeof failure.code === "string" ? REFUSALS.get(failure.code) : undefined;
    if (known) throw new Error(known);
    if (failure.status === 503) throw new Error("The evidence store is unavailable.");
    if (failure.status === 404) throw new Error("This host has no duel routes. Upgrade the host first.");
    throw error;
  }
}

function integer(options: Options, name: string, [low, high]: readonly [number, number]): number | undefined {
  const raw = options[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw) || Number(raw) < low || Number(raw) > high) throw new Error(CALIBRATE_USAGE);
  return Number(raw);
}

function calibrationBody(options: Options): Record<string, unknown> {
  const judge = options["--judge"], requestId = options["--request-id"], project = options["--project"];
  if (typeof judge !== "string" || judge === "" || typeof requestId !== "string" || !UUID.test(requestId)) throw new Error(CALIBRATE_USAGE);
  const pairs = integer(options, "--pairs", PAIRS_RANGE);
  const judgeMinutes = integer(options, "--judge-minutes", MINUTES_RANGE);
  if (project !== undefined && typeof project !== "string") throw new Error(CALIBRATE_USAGE);
  const projects = project?.split(",").filter(Boolean);
  return {
    requestId, judgeProfileId: judge,
    ...(pairs === undefined ? {} : { pairs }),
    ...(projects === undefined ? {} : { projects }),
    ...(judgeMinutes === undefined ? {} : { judgeMinutes }),
  };
}

export async function handleDuelClientCommand(positional: string[], options: Options, api: EvalApi): Promise<boolean> {
  const [verb, first] = positional;
  const json = options["--json"] === true;
  const print = (value: unknown, lines: () => string[]) => {
    if (json) console.log(JSON.stringify(value, null, 2));
    else for (const line of lines()) console.log(line);
  };
  if (verb === "calibrate" && positional.length === 1) {
    const body = calibrationBody(options);
    const result = await read(() => api.json<{ calibration: CalibrationView }>("/duels/judges/calibrations", body, undefined, undefined, "POST"));
    print(result, () => viewLines(result.calibration));
    return true;
  }
  if (verb === "judges" && positional.length === 1) {
    const result = await read(() => api.json<{ calibrations: CalibrationView[] }>("/duels/judges"));
    print(result, () => judgeLines(result.calibrations));
    return true;
  }
  if (verb === "cancel" && positional.length === 2) {
    const result = await read(() => api.json<{ calibration: CalibrationView }>(`/duels/judges/calibrations/${encodeURIComponent(first!)}/cancel`, undefined, undefined, undefined, "POST"));
    print(result, () => viewLines(result.calibration));
    return true;
  }
  throw new Error(USAGE);
}
