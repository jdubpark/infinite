import type { IntakeRecord } from "./intake-types.js";
import type { Mission, MissionStatus, MissionSubtask } from "./mission-types.js";

const PHASE: Record<MissionStatus, string> = {
  planning: "Planning",
  working: "Working",
  "needs-input": "Waiting for owner input",
  paused: "Paused",
  blocked: "Blocked",
  "ready-for-review": "Ready for review",
  cancelled: "Cancelled",
};

const SUBTASK_STATES: MissionSubtask["status"][] = ["running", "queued", "done", "blocked", "cancelled"];

export function formatThreadStatus(record: IntakeRecord, mission: Mission | undefined, owner: boolean): string {
  const label = record.identifier || (record.direct?.route?.kind === "answer" ? "Question" : "Request");
  if (!mission) {
    const state = record.state === "queued" ? "Queued" : record.state === "finished" ? "Finished" : "Mission status unavailable";
    return `${label} · ${state}`;
  }
  const details: string[] = [];
  if (mission.subtasks.length) {
    const counts = SUBTASK_STATES.flatMap(state => {
      const count = mission.subtasks.filter(task => task.status === state).length;
      return count ? [`${count} ${state}`] : [];
    });
    details.push(`Subtasks · ${counts.join(", ")}`);
  }
  const open = mission.decisions.filter(decision => !decision.answer).length;
  details.push(`${open} open decision${open === 1 ? "" : "s"}`);
  if (owner && open) {
    for (const question of record.questions) {
      const decision = mission.decisions.find(item => item.id === question.decisionId && !item.answer);
      if (decision) details.push(`Q${question.n}: ${decision.question}`);
    }
  }
  return [`${label} · ${PHASE[mission.status]}`, ...details].join("\n");
}
