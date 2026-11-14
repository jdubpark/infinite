import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProjectSignal } from "./signals/types.js";

type SignalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;

const usage = "Usage: infinite signal add --project ID TEXT [--request-id UUID] [--json] | infinite signal list --project ID [--after SEQ] [--json]";
const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const MAX_TEXT = 2_000;
const PAGE = 50;
/** Host text is data: control characters never reach the terminal. */
const clean = (value: unknown, max = 500) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, max);

function signalLine(signal: ProjectSignal): string {
  const parts = [String(signal.seq), clean(signal.at), clean(signal.kind)];
  if (signal.runId) parts.push(`run ${clean(signal.runId)}`);
  if (signal.commit) parts.push(`commit ${clean(signal.commit).slice(0, 12)}`);
  if (signal.text) parts.push(clean(signal.text, MAX_TEXT));
  return parts.join("  ");
}

export async function handleSignalClientCommand(positional: string[], options: Options, api: SignalApi): Promise<boolean> {
  const [verb, ...rest] = positional;
  const project = options["--project"];
  if ((verb !== "add" && verb !== "list") || typeof project !== "string") throw new Error(usage);
  if (!PROJECT_ID.test(project)) throw new Error("Project ID must be 1 to 80 lowercase letters, digits, or hyphens.");
  const path = `/projects/${encodeURIComponent(project)}/signals`;
  const json = options["--json"] === true;
  if (verb === "add") {
    const text = rest.join(" ").trim();
    if (!text) throw new Error(usage);
    if (text.length > MAX_TEXT) throw new Error("Signal text must be at most 2,000 characters.");
    // Checked before the request, so a typo sends nothing.
    const requestId = z.uuid().safeParse(String(options["--request-id"] ?? randomUUID()));
    if (!requestId.success) throw new Error("--request-id must be a UUID.");
    // Printed before the network call, so an uncertain request can be repeated with the same ID.
    console.error(`[Infinite] Adding a signal to ${clean(project)} · request ${requestId.data}`);
    const result = await api.json<{ recorded: boolean; signal: ProjectSignal }>(path, { requestId: requestId.data, text });
    if (json) { console.log(JSON.stringify(result, null, 2)); return true; }
    console.log(`${result.recorded ? "Recorded" : "Already recorded"} signal ${result.signal.seq} for ${clean(project)}.`);
    console.log("A signal starts nothing by itself. Routines that watch owner signals read it on their next pass.");
    return true;
  }
  if (rest.length) throw new Error(usage);
  const after = options["--after"] === undefined ? 0 : Number(options["--after"]);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("--after must be a whole number of at least 0.");
  const result = await api.json<{ signals: ProjectSignal[]; head: number }>(`${path}?after=${after}`);
  if (json) { console.log(JSON.stringify(result, null, 2)); return true; }
  if (!result.signals.length) console.log(`No signals after ${after}.`);
  for (const signal of result.signals) console.log(signalLine(signal));
  // A full page of the route's default size may have more after it.
  const last = result.signals[result.signals.length - 1];
  if (last && result.signals.length >= PAGE) console.log(`More may follow: infinite signal list --project ${clean(project)} --after ${last.seq}`);
  return true;
}
