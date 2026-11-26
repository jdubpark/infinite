import type { TeamService } from "./teams.js";
import { TeamError } from "./teams.js";
import { HALT_CENSUS_MS } from "./team-command-fence.js";

export type WaitingControl = {
  action: "pause" | "resume" | "cancel" | "steer" | "parallelism";
  teamId: string;
  text?: string;
  halt?: { token: string; reason: string };
  waiting?: true;
};
type Body = { requestId: string; revision: number };
type Holder = { control?: WaitingControl; goal: { reason?: string } };
type Sink = { event(text: string): void; save(): void };

export async function deliverControl(teams: TeamService, control: WaitingControl, body: Body) {
  if (control.action === "steer") await teams.steer(control.teamId, { ...body, text: control.text! }, undefined, HALT_CENSUS_MS);
  else if (control.action === "pause" && control.halt) await teams.haltPauseChild(control.teamId, control.halt.token, control.halt.reason);
  else if (control.action === "resume") await teams.resume(control.teamId, body, undefined, HALT_CENSUS_MS);
  else await teams[control.action as "pause" | "cancel"](control.teamId, body);
}

export function supersedeWaiting(stored: Holder, by: string, sink: Pick<Sink, "event">) {
  const control = stored.control;
  if (!control?.waiting) return;
  stored.control = undefined;
  sink.event(control.action === "steer"
    ? `${by} replaced the goal's steer that waited for its team. The direction stays in the goal's steering; the team did not receive it.`
    : `${by} replaced the goal's ${control.action} that waited for its team.`);
}

export function holdForStoppedCommand(stored: Holder, control: WaitingControl, error: TeamError, sink: Sink) {
  if (error.code !== "team-command-running") return false;
  control.waiting = true;
  const reason = `The goal's ${control.action} waits for its team. ${error.message}`;
  if (stored.goal.reason === reason) return true;
  stored.goal.reason = reason;
  sink.event(reason);
  sink.save();
  return true;
}
