import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HaltTarget } from "./halt/rules.js";
import type { HaltEngageResult, HaltItem, HaltReleaseResult, HaltState, HaltView } from "./halt/service.js";

type HaltApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;

export type HaltCommand =
  | { action: "view" }
  | { action: "on"; target: HaltTarget; requestId: string; reason?: string }
  | { action: "off"; target: HaltTarget; requestId: string; keepPaused: boolean };

const USAGE = "Usage: infinite halt [--json] | infinite halt on --host | --project ID [--reason TEXT] | infinite halt off --host | --project ID [--keep-paused]";
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);

export function parseHaltCommand(positional: readonly string[], options: Options): HaltCommand {
  const host = options["--host"] === true, project = options["--project"];
  const reason = options["--reason"], keepPaused = options["--keep-paused"] === true;
  if (positional.length === 0 && !host && project === undefined && reason === undefined && !keepPaused) return { action: "view" };
  const [verb] = positional;
  if (positional.length !== 1 || (verb !== "on" && verb !== "off") || host === (project !== undefined)) throw new Error(USAGE);
  if ((verb === "on" && keepPaused) || (verb === "off" && reason !== undefined)) throw new Error(USAGE);
  const target: HaltTarget = host ? { scope: "host" } : { scope: "project", projectId: String(project) };
  const requestId = String(options["--request-id"] ?? randomUUID());
  if (!z.uuid().safeParse(requestId).success) throw new Error("--request-id takes the UUID of an earlier halt request.");
  if (verb === "on") {
    const text = reason === undefined ? undefined : String(reason).trim();
    if (text !== undefined && (!text || text.length > 500)) throw new Error("--reason takes 1 to 500 characters.");
    return { action: "on", target, requestId, ...(text === undefined ? {} : { reason: text }) };
  }
  return { action: "off", target, requestId, keepPaused };
}

export function haltLines(view: HaltView): string[] {
  if (!view.readable) return ["The host cannot read its halt record, so the whole host is halted. Restore the record to change the halt."];
  const line = (name: string, state: HaltState) =>
    `${name}: halted since ${clean(state.at)} by ${clean(state.by)}${state.reason ? `: ${clean(state.reason)}` : ""}`;
  return [
    view.host ? line("Host", view.host) : "Host: not halted",
    ...view.projects.map(project => line(`Project ${clean(project.projectId)}`, project)),
  ];
}

const itemLine = (verb: string, entry: HaltItem) =>
  `${verb} ${clean(entry.kind)} ${clean(entry.title)}${entry.id ? ` (${clean(entry.id)})` : ""}${entry.reason ? `: ${clean(entry.reason)}` : ""}`;

export function haltEngageLines(result: HaltEngageResult): string[] {
  return [
    result.engaged ? "Halt engaged. New work in scope waits until the owner releases it." : "That scope was already halted. Nothing changed.",
    ...result.paused.map(entry => itemLine("Paused", entry)),
    ...result.failed.map(entry => itemLine("Could not pause", entry)),
    ...haltLines(result.halt),
  ];
}

export function haltReleaseLines(result: HaltReleaseResult): string[] {
  return [
    result.released ? "Halt released." : "That scope was not halted. Nothing changed.",
    ...result.resumed.map(entry => itemLine("Resumed", entry)),
    ...result.notResumed.map(entry => itemLine("Not resumed", entry)),
    ...haltLines(result.halt),
  ];
}

export async function handleHaltClientCommand(positional: string[], options: Options, api: HaltApi): Promise<boolean> {
  const command = parseHaltCommand(positional, options);
  const json = options["--json"] === true;
  if (command.action === "view") {
    const view = await api.json<HaltView>("/halt");
    if (json) console.log(JSON.stringify(view, null, 2));
    else for (const line of haltLines(view)) console.log(line);
    return true;
  }
  const scope = command.target.scope === "host" ? "the host" : `project ${clean(command.target.projectId)}`;
  console.error(`[Infinite] ${command.action === "on" ? "Halting" : "Releasing"} ${scope} · request ${command.requestId}`);
  if (command.action === "on") {
    const result = await api.json<HaltEngageResult>("/halt", { requestId: command.requestId, ...command.target, ...(command.reason === undefined ? {} : { reason: command.reason }) });
    if (json) console.log(JSON.stringify(result, null, 2));
    else for (const line of haltEngageLines(result)) console.log(line);
    return true;
  }
  const result = await api.json<HaltReleaseResult>("/halt/release", { requestId: command.requestId, ...command.target, ...(command.keepPaused ? { keepPaused: true } : {}) });
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of haltReleaseLines(result)) console.log(line);
  return true;
}
