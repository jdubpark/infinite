import type { BoardColumn, BoardItem, Mission, Me, MissionDecision, MissionStatus, MissionSubtask } from "../../api/client";

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

/** The board's section order and newest-updated ordering are independent of rendering. */
export function groupBoard(items: BoardItem[], groupId?: string) {
  const selected = filterBoard(items, groupId);
  return BOARD_SECTIONS.map(section => ({
    ...section,
    items: selected.filter(item => item.column === section.column)
      .slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

export function openMissionDecisions(mission: Mission): MissionDecision[] {
  return mission.decisions.filter(decision => decision.answer == null);
}

export function missionStatusLabel(status: MissionStatus) {
  const labels: Record<MissionStatus, string> = {
    planning: "Planning", working: "Working", "needs-input": "Needs your input", paused: "Paused",
    blocked: "Blocked", "ready-for-review": "Ready for review", cancelled: "Cancelled",
  };
  return labels[status];
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
    resume: owner && mission.status === "paused" && Date.parse(mission.deadlineAt) > now,
    cancel: owner && live,
  };
}
