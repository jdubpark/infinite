import { randomUUID } from "node:crypto";
import { z } from "zod";
import { autonomyModeSchema, type AutonomySource } from "./autonomy.js";

type AutonomyApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;
type AutonomyView = { id?: string; revision: number; autonomy?: string; autonomySource?: AutonomySource };

const usage = "Usage: infinite autonomy mode PROJECT [supervised|autonomous] [--revision N] [--request-id UUID] [--json]";
const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const SOURCE_LABEL: Record<AutonomySource, string> = { saved: "saved", "host-default": "host default", "not-enrolled": "not enrolled" };
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);

function printView(project: string, view: AutonomyView, json: boolean | undefined) {
  if (json) { console.log(JSON.stringify(view, null, 2)); return; }
  console.log(`${clean(project)}  ${clean(view.autonomy)} (${SOURCE_LABEL[view.autonomySource ?? "not-enrolled"]}) · revision ${view.revision}`);
}

export async function handleAutonomyClientCommand(positional: string[], options: Options, api: AutonomyApi): Promise<boolean> {
  const [verb, project, requested] = positional;
  if (verb !== "mode" || !project || positional.length > 3) throw new Error(usage);
  const path = `/projects/${encodeURIComponent(project)}/team`;
  if (requested === undefined) {
    const view = await api.json<AutonomyView>(path);
    if (view.autonomy === undefined) throw new Error("This host does not support autonomy modes. Upgrade the host.");
    printView(project, view, options["--json"] === true);
    return true;
  }
  const mode = autonomyModeSchema.safeParse(requested);
  if (!mode.success) throw new Error("Autonomy mode must be supervised or autonomous.");
  if (!PROJECT_ID.test(project)) throw new Error("Project ID must be 1 to 80 lowercase letters, digits, or hyphens.");
  // Checked before the first request, so a typo never reads or changes the enrollment.
  const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
  const revisionOption = options["--revision"] === undefined ? undefined : Number(options["--revision"]);
  if (revisionOption !== undefined && (!Number.isInteger(revisionOption) || revisionOption < 1)) throw new Error("--revision must be a positive integer.");
  const view = await api.json<AutonomyView>(path);
  if (view.autonomy === undefined) throw new Error("This host does not support autonomy modes. Upgrade the host.");
  if (view.autonomySource === "not-enrolled") throw new Error(`${clean(project)} is not enrolled. Run infinite repo init first; other projects stay supervised.`);
  // A rerun after a lost reply reads the new revision, so a resend would conflict. Print the saved state instead.
  if (view.autonomySource === "saved" && view.autonomy === mode.data) { printView(project, view, options["--json"] === true); return true; }
  console.error(`[Infinite] Setting ${clean(project)} to ${mode.data} · request ${requestId}`);
  const saved = await api.json<AutonomyView>(`/projects/${encodeURIComponent(project)}/autonomy`, { requestId, revision: revisionOption ?? view.revision, mode: mode.data }, undefined, undefined, "PUT");
  printView(project, saved, options["--json"] === true);
  return true;
}
