import { setTimeout as delay } from "node:timers/promises";
import type { EntryHead } from "./evidence/entry-types.js";
import type { EntryPage } from "./evidence/blackboard.js";
import type {
  MissionProgressLinkedChild,
  MissionProgressMember,
  MissionProgressObservation,
  MissionProgressPage,
  MissionProgressResyncReason,
  MissionProgressSnapshot,
} from "./mission-progress.js";
import type { Mission } from "./mission-types.js";
import { recommendationLine } from "./question-recommendation.js";
import { teamWatchFrame, teamWatchScreen } from "./team-watch.js";

export type MissionWatchApi = {
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T>;
};

export type MissionWatchCommand =
  | "nextSubtask"
  | "prevSubtask"
  | "toggleEntries"
  | "toggleDetail"
  | "toggleFollow"
  | "pageUp"
  | "pageDown"
  | "top"
  | "bottom"
  | "quit";

export type MissionWatchEntryCache = {
  teamId: string;
  entries: EntryHead[];
  cursor: number;
  more: boolean;
  error?: string;
  selectedEntry?: { head: EntryHead; body: unknown };
  detailError?: string;
  loading?: boolean;
};

export type MissionWatchState = {
  selectedSubtaskIndex: number;
  selectedSubtaskId?: string;
  showEntries: boolean;
  showDetail: boolean;
  follow: boolean;
  lastResyncReason?: MissionProgressResyncReason | null;
  resyncCount?: number;
  observations?: MissionProgressObservation[];
  entriesByTeam?: Record<string, MissionWatchEntryCache>;
};

export type MissionWatchOptions = {
  interactive?: boolean;
  checkedAt?: string;
  width?: number;
  now?: number;
};

export type RunMissionWatchOptions = {
  json?: boolean;
  tty?: boolean;
  interactive?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  once?: boolean;
  initialState?: Partial<MissionWatchState>;
  onFrame?: (text: string) => void;
};

export type ResolvedWatchChild =
  | { kind: "unavailable"; reason: string }
  | { kind: "not-created" }
  | { kind: "missing" }
  | { kind: "mismatched"; reason: string }
  | { kind: "linked"; child: MissionProgressLinkedChild; verifiedTeamId: string };

const MAX_RETAINED_OBSERVATIONS = 40;
const MAX_RETAINED_ENTRIES = 200;
const REFRESH_WINDOW_ENTRIES = 50;
const MAX_ENTRY_PAGES = 10;
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const short = (value: unknown, max: number) => {
  const text = clean(value).trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
};

const authorityLabel = (authority: EntryHead["authority"]) =>
  authority === "receipt" ? "host receipt" : authority === "claim" ? "agent claim" : "owner direction";

const keySequences: [string, MissionWatchCommand][] = [
  ["\u001b[A", "prevSubtask"],
  ["\u001bOA", "prevSubtask"],
  ["\u001b[B", "nextSubtask"],
  ["\u001bOB", "nextSubtask"],
  ["\u001b[5~", "pageUp"],
  ["\u001b[6~", "pageDown"],
  ["\u001b[H", "top"],
  ["\u001bOH", "top"],
  ["\u001b[1~", "top"],
  ["\u001b[F", "bottom"],
  ["\u001bOF", "bottom"],
  ["\u001b[4~", "bottom"],
];

const keyMap: Record<string, MissionWatchCommand> = {
  j: "nextSubtask",
  k: "prevSubtask",
  e: "toggleEntries",
  "\r": "toggleDetail",
  "\n": "toggleDetail",
  f: "toggleFollow",
  q: "quit",
  " ": "pageDown",
  g: "top",
  G: "bottom",
};

export function initialMissionWatchState(): MissionWatchState {
  return {
    selectedSubtaskIndex: 0,
    showEntries: false,
    showDetail: false,
    follow: true,
    lastResyncReason: null,
    resyncCount: 0,
    observations: [],
    entriesByTeam: {},
  };
}

export function missionWatchCommand(chunk: string | Buffer): MissionWatchCommand | null {
  let action: MissionWatchCommand | null = null;
  const text = String(chunk);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\u0003") return "quit";
    const sequence = keySequences.find(([bytes]) => text.startsWith(bytes, index));
    if (sequence) {
      action = sequence[1];
      index += sequence[0].length - 1;
      continue;
    }
    if (text[index] === "\u001b") continue;
    action = keyMap[text[index]!] ?? action;
  }
  return action;
}

export function applyMissionWatchCommand(
  state: MissionWatchState,
  command: MissionWatchCommand,
  subtaskCount: number,
): MissionWatchState {
  const maxIndex = Math.max(0, subtaskCount - 1);
  if (command === "nextSubtask") {
    return {
      ...state,
      selectedSubtaskIndex: subtaskCount > 0 ? Math.min(maxIndex, state.selectedSubtaskIndex + 1) : 0,
      selectedSubtaskId: undefined,
    };
  }
  if (command === "prevSubtask") {
    return {
      ...state,
      selectedSubtaskIndex: subtaskCount > 0 ? Math.max(0, state.selectedSubtaskIndex - 1) : 0,
      selectedSubtaskId: undefined,
    };
  }
  if (command === "toggleEntries") {
    return { ...state, showEntries: !state.showEntries };
  }
  if (command === "toggleDetail") {
    return { ...state, showDetail: !state.showDetail };
  }
  if (command === "toggleFollow") {
    return { ...state, follow: !state.follow };
  }
  return state;
}

export function missionWatchResyncBanner(reason: MissionProgressResyncReason | null | undefined, resyncCount = 0): string | null {
  if (!reason || reason === "initial") return null;
  const suffix = resyncCount > 1 ? ` (${resyncCount} resyncs)` : "";
  switch (reason) {
    case "host-restarted":
      return `RESYNC NOTICE (${reason}): Host restarted; replaced local view with current snapshot.${suffix}`;
    case "history-evicted":
      return `RESYNC NOTICE (${reason}): Progress history evicted on host; replaced local view with current snapshot.${suffix}`;
    case "retention-gap":
      return `RESYNC NOTICE (${reason}): Progress cursor fell behind retained observations; replaced local view with current snapshot.${suffix}`;
    case "cursor-ahead":
      return `RESYNC NOTICE (${reason}): Local cursor ahead of host sequence; replaced local view with current snapshot.${suffix}`;
    case "invalid-cursor":
      return `RESYNC NOTICE (${reason}): Invalid progress cursor; replaced local view with current snapshot.${suffix}`;
    case "mission-mismatch":
      return `RESYNC NOTICE (${reason}): Progress cursor belonged to another mission; replaced local view with current snapshot.${suffix}`;
  }
}

function parseProgressSequence(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^mp1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.([1-9][0-9]{0,8})$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

export function resolveWatchChild(
  mission: Pick<Mission, "id">,
  subtask: Pick<Mission["subtasks"][number], "id" | "repoProjectId" | "teamId">,
  snapshot: MissionProgressSnapshot | null,
): ResolvedWatchChild {
  if (!snapshot) {
    return { kind: "unavailable", reason: "Mission progress snapshot is unavailable." };
  }
  if (snapshot.mission.id !== mission.id) {
    return { kind: "unavailable", reason: "Progress snapshot belongs to a different mission." };
  }
  const progressSubtask = snapshot.subtasks.find(item => item.id === subtask.id);
  if (!progressSubtask) {
    if (snapshot.subtasksTruncated) {
      return { kind: "unavailable", reason: "Subtask progress omitted because the progress snapshot is truncated." };
    }
    return { kind: "unavailable", reason: "Progress snapshot does not include this subtask yet." };
  }
  const { child } = progressSubtask;
  if (child.kind === "not-created") {
    if (subtask.teamId) {
      return { kind: "unavailable", reason: "Mission records a subteam, but the latest progress snapshot has not observed it yet." };
    }
    return { kind: "not-created" };
  }
  if (child.kind === "missing") return { kind: "missing" };
  if (child.kind === "mismatched") {
    return { kind: "mismatched", reason: "Linked subteam does not match this mission or project." };
  }
  if (child.missionId !== mission.id || child.projectId !== subtask.repoProjectId || !child.runId) {
    return { kind: "mismatched", reason: "Linked subteam progress does not match this mission or repository." };
  }
  if (!subtask.teamId || child.runId !== subtask.teamId) {
    return { kind: "mismatched", reason: "Linked subteam run does not match the mission subtask record." };
  }
  return { kind: "linked", child, verifiedTeamId: child.runId };
}

const isConfirmedFinished = (member: Pick<MissionProgressMember, "recordedStatus" | "exitConfirmedAt">) =>
  member.recordedStatus === "stopped" || (member.recordedStatus === "reported" && Boolean(member.exitConfirmedAt));

const isAwaitingExit = (member: Pick<MissionProgressMember, "recordedStatus" | "exitConfirmedAt">) =>
  member.recordedStatus === "reported" && !member.exitConfirmedAt;

export function currentWatchAssignmentCount(assignments: readonly MissionProgressMember[]): number {
  const active = assignments.filter(member => !isConfirmedFinished(member));
  const activeTaskSlots = new Set(
    active.filter(member => member.taskId !== undefined).map(member => `${member.role}\0${member.taskId}`),
  );
  const finishedTaskSlots = new Set<string>();
  let finishedUnscoped = 0;
  for (const member of assignments) {
    if (!isConfirmedFinished(member)) continue;
    if (member.taskId === undefined) {
      finishedUnscoped += 1;
      continue;
    }
    const slot = `${member.role}\0${member.taskId}`;
    if (!activeTaskSlots.has(slot)) finishedTaskSlots.add(slot);
  }
  return active.length + finishedTaskSlots.size + finishedUnscoped;
}

function compactMemberLines(assignments: readonly MissionProgressMember[], showFinished: boolean): string[] {
  const active = assignments.filter(item => !isConfirmedFinished(item));
  const finished = assignments.filter(item => isConfirmedFinished(item));
  const lines: string[] = [];
  const latestActiveBySlot = new Map<string, MissionProgressMember>();
  for (const member of active) {
    if (!member.taskId) continue;
    const key = `${member.role}\0${member.taskId}`;
    const prev = latestActiveBySlot.get(key);
    if (!prev) {
      latestActiveBySlot.set(key, member);
      continue;
    }
    const prevAwaiting = isAwaitingExit(prev);
    const curAwaiting = isAwaitingExit(member);
    if ((prevAwaiting && !curAwaiting) || (prevAwaiting === curAwaiting && member.revision >= prev.revision)) {
      latestActiveBySlot.set(key, member);
    }
  }
  const linkedFinished = new Set<string>();
  const priorByActive = new Map<string, MissionProgressMember[]>();
  for (const member of finished) {
    if (!member.taskId) continue;
    const target = latestActiveBySlot.get(`${member.role}\0${member.taskId}`);
    if (!target) continue;
    linkedFinished.add(member.memberId);
    const list = priorByActive.get(target.memberId) ?? [];
    list.push(member);
    priorByActive.set(target.memberId, list);
  }
  for (const member of active) {
    const task = member.taskId ? ` · ${short(member.taskId, 40)}` : "";
    const recorded = isAwaitingExit(member) ? "reported (awaiting exit)" : clean(member.recordedStatus);
    lines.push(`  ${clean(member.role)}${task}  recorded:${recorded}  worker:${clean(member.workerStatus)}  r${member.revision}`);
    for (const prior of (priorByActive.get(member.memberId) ?? []).sort((a, b) => a.revision - b.revision)) {
      lines.push(`    earlier attempt: recorded:${clean(prior.recordedStatus)}  r${prior.revision}`);
    }
  }
  const remainingFinished = finished.filter(item => !linkedFinished.has(item.memberId));
  if (remainingFinished.length) {
    if (showFinished) {
      lines.push(`  Finished (${remainingFinished.length})`);
      for (const member of remainingFinished) {
        const task = member.taskId ? ` · ${short(member.taskId, 40)}` : "";
        lines.push(`    ${clean(member.role)}${task}  recorded:${clean(member.recordedStatus)}  worker:${clean(member.workerStatus)}  r${member.revision}`);
      }
    } else {
      lines.push(`  Finished (${remainingFinished.length}) · press enter for detail`);
    }
  }
  return lines;
}

export function missionWatchText(
  mission: Mission,
  progress: MissionProgressPage | null,
  state: MissionWatchState,
  options: MissionWatchOptions = {},
): string {
  const interactive = Boolean(options.interactive);
  const subtasks = mission.subtasks ?? [];
  const doneCount = subtasks.filter(task => task.status === "done").length;
  const lines: string[] = [
    `${clean(mission.id)}  ${clean(mission.status)}  revision ${clean(mission.revision)}  ${short(mission.title, 100)}`,
    `${clean(mission.groupName)}  ·  ${doneCount}/${subtasks.length} subtasks done  ·  repos ${mission.repoProjectIds.map(clean).join(", ")}`,
  ];
  if (mission.reason) lines.push(`Reason: ${short(mission.reason, 240)}`);
  lines.push(short(mission.objective, state.showDetail ? 1000 : 220));

  const resyncReason = progress?.resync.required && progress.resync.reason !== "initial"
    ? progress.resync.reason
    : state.lastResyncReason;
  const banner = missionWatchResyncBanner(resyncReason, state.resyncCount ?? 0);
  if (banner) lines.push("", banner);

  const openDecisions = (mission.decisions ?? []).filter(item => !item.answer);
  if (openDecisions.length) {
    lines.push("", `DECISIONS FOR YOU (${openDecisions.length})`);
    for (const decision of openDecisions.slice(0, 3)) {
      lines.push(`  • ${short(decision.question, 300)}`);
      if (decision.recommendation) lines.push(`    ${short(recommendationLine(decision.recommendation), 300)}`);
      if (decision.options.length) lines.push(`    Options: ${decision.options.map(option => short(option, 60)).join(" / ")}`);
      lines.push(`    infinite mission answer ${clean(mission.id)} ${clean(decision.id)} "YOUR ANSWER"`);
    }
    if (openDecisions.length > 3) lines.push(`  + ${openDecisions.length - 3} more`);
  }

  const progressCoordinator = progress?.snapshot.mission.coordinator;
  const recordedCoordinator = progressCoordinator?.recordedStatus ?? mission.coordinator?.status ?? "not-started";
  const workerCoordinator = progressCoordinator?.workerStatus ?? "not-sampled";
  lines.push("", `COORDINATOR  recorded:${clean(recordedCoordinator)}  ·  worker:${clean(workerCoordinator)}`);

  const selectedIndex = subtasks.length
    ? Math.min(Math.max(0, state.selectedSubtaskIndex), subtasks.length - 1)
    : 0;

  lines.push("", `SUBTASKS (${subtasks.length})`);
  if (!subtasks.length) {
    lines.push("  No subtasks dispatched yet.");
  } else {
    subtasks.forEach((subtask, index) => {
      const marker = index === selectedIndex ? ">" : " ";
      const resolved = resolveWatchChild(mission, subtask, progress?.snapshot ?? null);
      const childSummary =
        resolved.kind === "linked"
          ? `${clean(resolved.child.status)} · ${currentWatchAssignmentCount(resolved.child.assignments)} assigned`
          : resolved.kind === "unavailable"
            ? "progress unavailable"
            : clean(resolved.kind);
      lines.push(`${marker} ${index + 1}. ${short(subtask.title, 60)}  [${clean(subtask.status)}]  ${clean(subtask.repoProjectId)}  (${childSummary})`);
    });
  }

  const selected = subtasks[selectedIndex];
  if (selected) {
    const resolved = resolveWatchChild(mission, selected, progress?.snapshot ?? null);
    const verifiedTeamId = resolved.kind === "linked" ? resolved.verifiedTeamId : undefined;
    lines.push("", `SELECTED SUBTASK  ${short(selected.title, 80)}  [${clean(selected.status)}]`);
    lines.push(`  repo ${clean(selected.repoProjectId)}${verifiedTeamId ? ` · team ${clean(verifiedTeamId)}` : ""}`);
    if (state.showDetail && selected.objective) {
      lines.push(`  objective: ${short(selected.objective, 400)}`);
    }
    if (resolved.kind === "linked") {
      const { child } = resolved;
      lines.push(`  child status: ${clean(child.status)} · revision ${child.revision}`);
      const memberLines = compactMemberLines(child.assignments, state.showDetail);
      if (memberLines.length) lines.push(...memberLines);
      else lines.push("  No current child assignments.");
      if (child.checks.length) {
        lines.push(`  Checks (${child.checks.length})`);
        for (const check of child.checks.slice(state.showDetail ? 0 : -3)) {
          const commit = check.headCommit ? ` ${clean(check.headCommit).slice(0, 8)}` : "";
          const code = check.exitCode !== undefined && check.exitCode !== null ? ` exit:${check.exitCode}` : "";
          lines.push(`    ${clean(check.status)}  r${check.revision}${check.round !== undefined ? ` round:${check.round}` : ""}${commit}${code}`);
        }
      }
    } else {
      const reasonSuffix = resolved.kind === "mismatched" || resolved.kind === "unavailable"
        ? ` — ${short(resolved.reason, 200)}`
        : "";
      lines.push(`  child: ${clean(resolved.kind)}${reasonSuffix}`);
      if (selected.finalEvidence?.reason) lines.push(`  final reason: ${short(selected.finalEvidence.reason, 200)}`);
    }

    if (state.showEntries) {
      lines.push("", "CHILD BLACKBOARD ENTRIES");
      if (!verifiedTeamId) {
        if (resolved.kind === "mismatched") {
          lines.push(`  Blackboard entries suppressed: ${short(resolved.reason, 200)}`);
        } else if (resolved.kind === "unavailable") {
          lines.push(`  Blackboard entries unavailable: ${short(resolved.reason, 200)}`);
        } else if (resolved.kind === "missing") {
          lines.push("  Blackboard entries unavailable: linked subteam record is missing on the host.");
        } else {
          lines.push("  No child team is linked to this subtask.");
        }
      } else {
        const cache = state.entriesByTeam?.[verifiedTeamId];
        if (!cache) {
          lines.push("  Loading child blackboard entries...");
        } else if (cache.error) {
          lines.push(`  Error: ${short(cache.error, 200)}`);
        } else if (!cache.entries.length) {
          lines.push("  No blackboard entries recorded for this subteam.");
        } else {
          for (const entry of cache.entries.slice(-10)) {
            const stateTag = entry.state !== "active" ? `  [${clean(entry.state)}]` : "";
            const taskPart = entry.taskId ? `  task:${clean(entry.taskId)}` : "";
            lines.push(`  blackboard #${entry.seq}  ${clean(entry.kind)}  ${authorityLabel(entry.authority)}${stateTag}  ${clean(entry.authorRole ?? entry.author)}${taskPart}  ${short(entry.summary, 120)}`);
          }
          if (cache.more) lines.push(`  More entries available (cursor ${cache.cursor}).`);
          if (state.showDetail) {
            if (cache.selectedEntry) {
              const detailState = cache.selectedEntry.head.state !== "active" ? `  [${clean(cache.selectedEntry.head.state)}]` : "";
              lines.push("", `ENTRY DETAIL  blackboard #${cache.selectedEntry.head.seq}  ${clean(cache.selectedEntry.head.kind)}  ${authorityLabel(cache.selectedEntry.head.authority)}${detailState}`);
              lines.push(`  ${short(JSON.stringify(cache.selectedEntry.body), 500)}`);
            } else if (cache.detailError) {
              lines.push("", "ENTRY DETAIL");
              lines.push(`  Error loading entry detail: ${short(cache.detailError, 200)}`);
            }
          }
        }
      }
    }
  }

  const observations = state.observations?.length ? state.observations : (progress?.observations ?? []);
  if (observations.length) {
    lines.push("", `PROGRESS OBSERVATIONS (${observations.length})`);
    for (const obs of observations.slice(-5)) {
      lines.push(`  progress #${obs.sequence}  ${clean(obs.snapshot.mission.status)}  r${obs.snapshot.mission.revision}  ${clean(obs.observedAt)}`);
    }
  }
  if (progress?.cursor) {
    lines.push("", `Progress cursor: ${clean(progress.cursor)}`);
  }

  const controls = interactive
    ? `j/k ↑↓ subtask · e entries · enter detail · f follow(${state.follow ? "on" : "off"}) · q quit`
    : `infinite mission progress ${clean(mission.id)}`;
  lines.push("", options.checkedAt ? `${clean(options.checkedAt)} · ${controls}` : controls);
  return lines.join("\n");
}

export async function runMissionWatch(
  api: MissionWatchApi,
  missionId: string,
  options: RunMissionWatchOptions = {},
): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const onExternalAbort = () => abort.abort();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const json = Boolean(options.json);
  const tty = json ? false : (options.tty ?? Boolean(process.stdout.isTTY));
  const interactive = options.interactive ?? (tty && Boolean(process.stdin.isTTY && process.stdin.setRawMode));
  const pollIntervalMs = options.pollIntervalMs ?? 1800;

  let state: MissionWatchState = { ...initialMissionWatchState(), ...options.initialState };
  let mission: Mission | null = null;
  let progress: MissionProgressPage | null = null;
  let progressCursor: string | undefined;
  let lastSequence = 0;
  let activeEntriesTeamId: string | undefined;
  let previous: string | null = null;
  let offset = 0;
  let pageSize = 1;
  let card = "";
  let notice = "";
  let wake = new AbortController();

  const paint = () => {
    if (!card) return;
    const screen = teamWatchScreen(card, {
      rows: process.stdout.rows || 24,
      columns: process.stdout.columns || 80,
      offset,
      color: !process.env.NO_COLOR,
      status: notice,
    });
    offset = screen.offset;
    pageSize = screen.page;
    if (options.onFrame) options.onFrame(screen.frame);
    else process.stdout.write(screen.frame);
  };

  const renderCurrent = (checkedAt = "") => {
    if (!mission) return;
    const text = missionWatchText(mission, progress, state, {
      interactive,
      checkedAt,
      width: process.stdout.columns || 80,
    });
    if (json) {
      const selected = mission.subtasks[state.selectedSubtaskIndex];
      const resolved = selected ? resolveWatchChild(mission, selected, progress?.snapshot ?? null) : null;
      const verifiedTeamId = resolved?.kind === "linked" ? resolved.verifiedTeamId : undefined;
      const payload = JSON.stringify({
        mission,
        progress,
        ...(verifiedTeamId && state.entriesByTeam?.[verifiedTeamId] ? { entries: state.entriesByTeam[verifiedTeamId] } : {}),
      });
      if (payload !== previous) {
        if (options.onFrame) options.onFrame(payload);
        else console.log(payload);
      }
      previous = payload;
    } else if (!tty) {
      const frame = teamWatchFrame(previous, text, false);
      if (frame) {
        if (options.onFrame) options.onFrame(frame);
        else process.stdout.write(frame);
      }
      previous = text;
    } else {
      card = text;
      if (state.follow && (state.showEntries || state.showDetail)) {
        offset = Number.MAX_SAFE_INTEGER;
      }
      paint();
    }
  };

  const onData = (data: string | Buffer) => {
    const command = missionWatchCommand(data);
    if (!command) return;
    if (command === "quit") {
      stop();
      return;
    }
    if (command === "pageUp") {
      offset = Math.max(0, offset - pageSize);
      paint();
      return;
    }
    if (command === "pageDown") {
      offset += pageSize;
      paint();
      return;
    }
    if (command === "top") {
      offset = 0;
      paint();
      return;
    }
    if (command === "bottom") {
      offset = Number.MAX_SAFE_INTEGER;
      paint();
      return;
    }
    const subtasks = mission?.subtasks ?? [];
    state = applyMissionWatchCommand(state, command, subtasks.length);
    if (subtasks[state.selectedSubtaskIndex]) {
      state = { ...state, selectedSubtaskId: subtasks[state.selectedSubtaskIndex]!.id };
    }
    if (command === "nextSubtask" || command === "prevSubtask") {
      offset = 0;
    }
    renderCurrent(tty ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
    if (command === "toggleEntries" || command === "toggleDetail" || command === "nextSubtask" || command === "prevSubtask") {
      wake.abort();
    }
  };

  let ttyEntered = false;
  let rawModeEnabled = false;
  process.once("SIGINT", stop);

  try {
    if (tty) {
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      ttyEntered = true;
      process.stdout.on("resize", paint);
    }
    if (interactive) {
      process.stdin.setRawMode(true);
      rawModeEnabled = true;
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", onData);
    }
    do {
      try {
        const query = progressCursor ? `?cursor=${encodeURIComponent(progressCursor)}` : "";
        const [nextMission, nextProgress] = await Promise.all([
          api.json<Mission>(`/missions/${encodeURIComponent(missionId)}`, undefined, abort.signal),
          api.json<MissionProgressPage>(`/missions/${encodeURIComponent(missionId)}/progress${query}`, undefined, abort.signal),
        ]);
        mission = nextMission;
        progress = nextProgress;
        progressCursor = nextProgress.cursor;
        if (state.selectedSubtaskId) {
          const kept = mission.subtasks.findIndex(item => item.id === state.selectedSubtaskId);
          if (kept >= 0) state = { ...state, selectedSubtaskIndex: kept };
        }
        const nextIndex = mission.subtasks.length
          ? Math.min(Math.max(0, state.selectedSubtaskIndex), mission.subtasks.length - 1)
          : 0;
        state = {
          ...state,
          selectedSubtaskIndex: nextIndex,
          selectedSubtaskId: mission.subtasks[nextIndex]?.id,
        };

        if (nextProgress.resync.required) {
          const seq = parseProgressSequence(nextProgress.cursor);
          lastSequence = Math.max(seq, ...nextProgress.observations.map(item => item.sequence), 0);
          state = {
            ...state,
            lastResyncReason: nextProgress.resync.reason,
            resyncCount: (state.resyncCount ?? 0) + (nextProgress.resync.reason === "initial" ? 0 : 1),
            observations: nextProgress.observations.slice(-MAX_RETAINED_OBSERVATIONS),
          };
        } else {
          const freshObs = nextProgress.observations
            .filter(item => item.sequence > lastSequence)
            .sort((a, b) => a.sequence - b.sequence);
          const maxObs = freshObs.reduce((max, item) => Math.max(max, item.sequence), lastSequence);
          lastSequence = Math.max(maxObs, parseProgressSequence(nextProgress.cursor));
          if (freshObs.length) {
            state = {
              ...state,
              observations: [...(state.observations ?? []), ...freshObs].slice(-MAX_RETAINED_OBSERVATIONS),
            };
          }
        }

        const selected = mission.subtasks[state.selectedSubtaskIndex];
        const resolvedSelected = selected ? resolveWatchChild(mission, selected, nextProgress.snapshot) : null;
        const verifiedTeamId = resolvedSelected?.kind === "linked" ? resolvedSelected.verifiedTeamId : undefined;
        if (activeEntriesTeamId !== undefined && verifiedTeamId !== activeEntriesTeamId) {
          state = { ...state, entriesByTeam: {} };
        }
        activeEntriesTeamId = verifiedTeamId;

        if (state.showEntries && verifiedTeamId && (state.follow || !state.entriesByTeam?.[verifiedTeamId])) {
          const priorCache = state.entriesByTeam?.[verifiedTeamId];
          try {
            const mergedById = new Map<string, EntryHead>();
            for (const existing of priorCache?.entries ?? []) mergedById.set(existing.entryId, existing);
            const startCursor = priorCache?.cursor ?? 0;
            let nextSince: number | undefined = startCursor > 0 ? startCursor : undefined;
            let finalCursor = startCursor;
            let hasMore = false;
            for (let pageIndex = 0; pageIndex < MAX_ENTRY_PAGES; pageIndex += 1) {
              const entryQuery = nextSince !== undefined ? `?since=${nextSince}` : "";
              const page = await api.json<EntryPage>(`/teams/${encodeURIComponent(verifiedTeamId)}/entries${entryQuery}`, undefined, abort.signal);
              for (const head of page.entries) {
                mergedById.set(head.entryId, head);
              }
              if (page.cursor > finalCursor) finalCursor = page.cursor;
              hasMore = page.more;
              if (!page.more || page.entries.length === 0 || page.cursor <= (nextSince ?? 0)) break;
              nextSince = page.cursor;
            }
            if (startCursor > 0 && !hasMore) {
              const refreshWindow = [...mergedById.values()]
                .sort((a, b) => a.seq - b.seq)
                .slice(-REFRESH_WINDOW_ENTRIES);
              if (refreshWindow.some(entry => entry.seq <= startCursor)) {
                const refreshSince = Math.max(0, refreshWindow[0]!.seq - 1);
                const refreshQuery = refreshSince > 0 ? `?since=${refreshSince}` : "";
                const refreshed = await api.json<EntryPage>(
                  `/teams/${encodeURIComponent(verifiedTeamId)}/entries${refreshQuery}`,
                  undefined,
                  abort.signal,
                );
                for (const head of refreshed.entries) {
                  mergedById.set(head.entryId, head);
                }
                if (refreshed.cursor > finalCursor) finalCursor = refreshed.cursor;
              }
            }
            const mergedEntries = [...mergedById.values()]
              .sort((a, b) => a.seq - b.seq)
              .slice(-MAX_RETAINED_ENTRIES);
            const syncedSelectedEntry = priorCache?.selectedEntry
              ? {
                  ...priorCache.selectedEntry,
                  head: mergedById.get(priorCache.selectedEntry.head.entryId) ?? priorCache.selectedEntry.head,
                }
              : undefined;
            state = {
              ...state,
              entriesByTeam: {
                ...state.entriesByTeam,
                [verifiedTeamId]: {
                  teamId: verifiedTeamId,
                  entries: mergedEntries,
                  cursor: finalCursor,
                  more: hasMore,
                  selectedEntry: syncedSelectedEntry,
                  detailError: priorCache?.detailError,
                },
              },
            };
          } catch (error) {
            if (abort.signal.aborted) throw error;
            state = {
              ...state,
              entriesByTeam: {
                ...state.entriesByTeam,
                [verifiedTeamId]: {
                  teamId: verifiedTeamId,
                  entries: priorCache?.entries ?? [],
                  cursor: priorCache?.cursor ?? 0,
                  more: priorCache?.more ?? false,
                  selectedEntry: priorCache?.selectedEntry,
                  detailError: priorCache?.detailError,
                  error: clean((error as Error).message),
                },
              },
            };
          }
        }

        if (state.showEntries && verifiedTeamId && state.showDetail) {
          const cached = state.entriesByTeam?.[verifiedTeamId];
          const latestHead = cached && !cached.error ? cached.entries[cached.entries.length - 1] : undefined;
          if (cached && latestHead && cached.selectedEntry?.head.entryId !== latestHead.entryId) {
            try {
              const selectedEntry = await api.json<{ head: EntryHead; body: unknown }>(
                `/teams/${encodeURIComponent(verifiedTeamId)}/entries/${encodeURIComponent(latestHead.entryId)}`,
                undefined,
                abort.signal,
              );
              state = {
                ...state,
                entriesByTeam: {
                  ...state.entriesByTeam,
                  [verifiedTeamId]: {
                    ...cached,
                    selectedEntry,
                    detailError: undefined,
                  },
                },
              };
            } catch (error) {
              if (abort.signal.aborted) throw error;
              state = {
                ...state,
                entriesByTeam: {
                  ...state.entriesByTeam,
                  [verifiedTeamId]: {
                    ...cached,
                    selectedEntry: undefined,
                    detailError: clean((error as Error).message),
                  },
                },
              };
            }
          }
        }

        notice = "";
        renderCurrent(tty ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
      } catch (error) {
        if (abort.signal.aborted) break;
        const message = `Update failed: ${clean((error as Error).message)}`;
        if (tty) {
          if (card) {
            notice = `${message}. Showing last received view.`;
            paint();
          } else {
            card = `${clean(missionId)}  error\n\n${message}\n\n${interactive ? "q quit" : "Ctrl+C detaches"}`;
            notice = "";
            paint();
          }
        } else if (options.once) {
          throw error;
        } else if (json) {
          process.stderr.write(`${message}\n`);
        } else {
          const text = `${message}\n\n${interactive ? "q quit" : "Ctrl+C detaches"}`;
          if (options.onFrame) options.onFrame(text);
          else process.stdout.write(`${text}\n`);
        }
      }

      if (options.once) break;
      if (wake.signal.aborted) {
        wake = new AbortController();
      } else {
        try {
          await delay(pollIntervalMs, undefined, { signal: AbortSignal.any([abort.signal, wake.signal]) });
        } catch {
          if (abort.signal.aborted) break;
        }
        if (wake.signal.aborted) wake = new AbortController();
      }
    } while (!abort.signal.aborted);
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onExternalAbort);
    if (interactive) {
      process.stdin.off("data", onData);
      if (rawModeEnabled) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      process.stdin.pause();
    }
    if (ttyEntered) {
      process.stdout.off("resize", paint);
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
    process.off("SIGINT", stop);
  }
}
