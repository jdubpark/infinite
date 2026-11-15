export type MissionStatus = "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";

type MissionState = { status: MissionStatus; stopReason?: "deadline" };

export function missionTimeLeftMs(mission: { deadlineAt: string; clockStoppedAt?: string }, now: number): number {
  return Date.parse(mission.deadlineAt) - (mission.clockStoppedAt === undefined ? now : Date.parse(mission.clockStoppedAt));
}

export function missionLeftLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return "less than a minute";
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours && remainingMinutes) return hours + " h " + remainingMinutes + " min";
  if (hours) return hours + " h";
  return minutes + " min";
}

export function missionExtensionConfirmation(mission: { deadlineAt: string; clockStoppedAt?: string }, now: number, formatDate: (value: string) => string): string {
  if (mission.clockStoppedAt !== undefined) return "Time extension recorded. The clock is stopped with " + missionLeftLabel(missionTimeLeftMs(mission, now)) + " left.";
  return "Time extension recorded. The mission now stops " + formatDate(mission.deadlineAt) + ".";
}

export function missionShowsReason(mission: MissionState & { reason?: string }): boolean {
  return Boolean(mission.reason) && !missionStoppedAtLimit(mission);
}

export function missionStopLine(
  mission: MissionState & { deadlineAt: string; clockStoppedAt?: string },
  now: number,
  formatDate: (deadlineAt: string) => string,
): string | undefined {
  if (missionStoppedAtLimit(mission)) return "Stopped at its time limit. Its work is kept. Extend to continue, or cancel.";
  if (mission.status === "cancelled" || mission.status === "ready-for-review" || mission.status === "blocked") return undefined;
  const timeLeft = missionTimeLeftMs(mission, now);
  if (timeLeft <= 0) return "Its time limit has passed. Extend to continue.";
  if (mission.clockStoppedAt !== undefined) return "Clock stopped while it waits · " + missionLeftLabel(timeLeft) + " left";
  return "Stops " + formatDate(mission.deadlineAt);
}

export function missionStoppedAtLimit(mission: MissionState): boolean {
  return mission.status === "blocked" && mission.stopReason === "deadline";
}

export function missionStateLabel(mission: MissionState): string {
  if (missionStoppedAtLimit(mission)) return "Stopped at time limit";
  return {
    planning: "Planning",
    working: "Working",
    "needs-input": "Needs your input",
    paused: "Paused",
    blocked: "Blocked",
    "ready-for-review": "Ready for review",
    cancelled: "Cancelled",
  }[mission.status];
}

export function missionControls(
  mission: MissionState & { deadlineAt: string; clockStoppedAt?: string },
  role: string | undefined,
  fresh: boolean,
  now: number,
): { extend: boolean; pause: boolean; resume: boolean; cancel: boolean } {
  const owner = role === "owner" && fresh;
  const stoppedAtLimit = missionStoppedAtLimit(mission);
  return {
    extend: owner && (["planning", "working", "needs-input", "paused"].includes(mission.status) || stoppedAtLimit),
    pause: owner && ["planning", "working", "needs-input"].includes(mission.status),
    resume: owner && mission.status === "paused" && missionTimeLeftMs(mission, now) > 0,
    cancel: owner && !["cancelled", "ready-for-review"].includes(mission.status),
  };
}

export function missionExtendChoices(maxMinutes: number): { minutes: number; label: string; ownLimit: boolean }[] {
  const minutes = [60, 360, 1440];
  if (Number.isInteger(maxMinutes) && maxMinutes >= 5 && maxMinutes <= 1440 && !minutes.includes(maxMinutes)) minutes.push(maxMinutes);
  return minutes.sort((a, b) => a - b).map(value => {
    const ownLimit = value === maxMinutes;
    const label = value % 60 === 0 ? "+" + value / 60 + " h" : "+" + value + " min";
    return { minutes: value, label: label + (ownLimit ? " (its limit)" : ""), ownLimit };
  });
}
