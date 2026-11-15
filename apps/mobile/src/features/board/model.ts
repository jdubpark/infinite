import type { BoardColumn, BoardItem, Mission, Me, MissionDecision, MissionStatus, MissionSubtask } from "../../api/client";
import type { StatusKind } from "../../status";

export type BoardSection = "needs-input" | "working" | "review" | "ended";
export const BOARD_SECTIONS: { id: BoardSection; title: string; subtitle: string; column: BoardColumn }[] = [
  { id: "needs-input", title: "Needs input", subtitle: "Questions and blockers waiting on you.", column: "needs-input" },
  { id: "working", title: "Working", subtitle: "Missions and runs still in progress.", column: "working" },
  { id: "review", title: "Ready for review", subtitle: "Work reported ready for your review.", column: "review" },
  { id: "ended", title: "Ended", subtitle: "Stopped or completed runs.", column: "ended" },
];

/** Filter by explicit group when available, while retaining standalone runs under All. */
export function filterBoard(items: BoardItem[], groupId?: string) {
  return groupId ? items.filter(item => item.groupId === groupId) : items;
}

/** A superseded attempt is folded behind the newest one; a live older attempt keeps its own row. */
export function foldAttempts(items: BoardItem[]) {
  return items.filter(item => !item.attempt?.superseded);
}

/** The board's section order and newest-updated ordering are independent of rendering. */
export function groupBoard(items: BoardItem[], groupId?: string) {
  const selected = foldAttempts(filterBoard(items, groupId));
  return BOARD_SECTIONS.map(section => ({
    ...section,
    items: selected.filter(item => item.column === section.column)
      .slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

/** Every attempt of the item's work the board holds, oldest first; empty when the item has one start. */
export function attemptsOf(items: BoardItem[], item: BoardItem): BoardItem[] {
  const work = item.attempt?.workId;
  if (!work) return [];
  return items.filter(other => other.attempt?.workId === work)
    .sort((a, b) => (a.attempt?.number ?? 0) - (b.attempt?.number ?? 0));
}

/** "Attempt 2 of 3", or nothing when the host holds a single attempt of this work. */
export function attemptLabel(item: BoardItem) {
  return item.attempt ? `Attempt ${item.attempt.number} of ${item.attempt.of}` : undefined;
}

export function findBoardItem(items: BoardItem[], kind: BoardItem["kind"], id: string) {
  return items.find(item => item.kind === kind && item.id === id);
}

export function boardStatusLabel(item: BoardItem) {
  if (item.kind === "mission") return missionStatusLabel(item.status as MissionStatus);
  const words = item.status.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function boardKind(item: BoardItem): StatusKind {
  if (item.status === "needs-input") return "attention";
  if (item.status === "blocked") return "blocked";
  if (item.status === "paused") return "paused";
  if (item.column === "review") return "review";
  if (item.column === "ended") return item.status === "cancelled" ? "cancelled" : "done";
  return "progress";
}

export function openMissionDecisions(mission: Mission): MissionDecision[] {
  return mission.decisions.filter(decision => decision.answer == null);
}

export function missionStatusLabel(status: MissionStatus, stopReason?: Mission["stopReason"]) {
  if (status === "blocked" && stopReason === "deadline") return "Stopped at time limit";
  const labels: Record<MissionStatus, string> = {
    planning: "Planning", working: "Working", "needs-input": "Needs your input", paused: "Paused",
    blocked: "Blocked", "ready-for-review": "Ready for review", cancelled: "Cancelled",
  };
  return labels[status];
}

/** Blocked because its approved time ran out; its work is kept and the owner can extend it. */
export function missionStoppedAtLimit(mission: Pick<Mission, "status" | "stopReason">): boolean {
  return mission.status === "blocked" && mission.stopReason === "deadline";
}

/**
 * Time left before the mission stops. While an intake mission's clock is stopped, `deadlineAt`
 * does not yet include the stopped span, so the time left is counted up to `clockStoppedAt`.
 */
export function missionTimeLeftMs(mission: Pick<Mission, "deadlineAt" | "clockStoppedAt">, now: number): number {
  return mission.clockStoppedAt ? Date.parse(mission.deadlineAt) - Date.parse(mission.clockStoppedAt) : Date.parse(mission.deadlineAt) - now;
}

/** Time left in words, rounded down to whole minutes: "2 h 15 min", "2 h", "45 min", or "less than a minute". */
export function missionLeftLabel(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Extension amounts for the owner: one hour, six hours and a day, plus the mission's own limit
 * when it is a whole number of minutes from 5 to 1440 that the list does not already hold.
 * `spoken` is the accessibility label for the button.
 */
export function missionExtendChoices(maxMinutes: number): { minutes: number; label: string; spoken: string; ownLimit: boolean }[] {
  const minutes = [60, 360, 1440];
  if (Number.isInteger(maxMinutes) && maxMinutes >= 5 && maxMinutes <= 1440 && !minutes.includes(maxMinutes)) minutes.push(maxMinutes);
  const unit = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
  return minutes.sort((a, b) => a - b).map(value => {
    const ownLimit = value === maxMinutes;
    const span = value % 60 === 0 ? `+${value / 60} h` : `+${value} min`;
    const amount = value % 60 === 0 ? unit(value / 60, "hour") : unit(value, "minute");
    return { minutes: value, label: ownLimit ? `${span} (its limit)` : span, spoken: `Extend by ${amount}${ownLimit ? ", its limit" : ""}`, ownLimit };
  });
}

export function missionSubtaskLabel(status: MissionSubtask["status"]) {
  const labels: Record<MissionSubtask["status"], string> = {
    queued: "Queued", running: "Working", done: "Done", cancelled: "Cancelled", blocked: "Blocked",
  };
  return labels[status];
}

/** Mission controls are owner-only and pause when the view is stale. */
export function missionControls(mission: Mission, role: Me["role"] | undefined, fresh: boolean, now: number) {
  const owner = role === "owner" && fresh;
  const live = !["cancelled", "ready-for-review"].includes(mission.status);
  return {
    answer: owner && live,
    steer: owner && live && mission.status !== "paused",
    pause: owner && ["planning", "working", "needs-input"].includes(mission.status),
    resume: owner && mission.status === "paused" && missionTimeLeftMs(mission, now) > 0,
    extend: owner && (["planning", "working", "needs-input", "paused"].includes(mission.status) || missionStoppedAtLimit(mission)),
    cancel: owner && live,
  };
}
