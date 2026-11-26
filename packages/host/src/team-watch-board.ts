import { setTimeout as delay } from "node:timers/promises";
import type { EntryPage } from "./evidence/blackboard.js";
import type { EntryHead, EntryKind } from "./evidence/entry-types.js";
import {
  canAskForBrief,
  chooseTeamBrief,
  clean,
  decisionLines,
  failedTeamBriefRow,
  orderedTeamMembers,
  roleNames,
  short,
  summaryMember,
  teamHeading,
  teamLogsText,
  teamMonitorText,
  teamSummaryText,
  teamWatchCommand,
  teamWatchFrame,
  teamWatchScreen,
  wrapText,
  type TeamBriefRow,
  type TeamBriefStatus,
  type TeamWatchCommand,
} from "./team-watch.js";

export type WatchApi = {
  request(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<Response>;
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T>;
};

export const BOARD_KIND_FILTERS: readonly (EntryKind | "all")[] = [
  "all",
  "check",
  "integration",
  "report",
  "direction",
  "contract",
  "finding",
  "blocker",
  "handoff",
];

export type TeamBoardState = {
  selectedEntryId: string | null;
  detailOpen: boolean;
  kindFilterIndex: number;
  follow: boolean;
};

export type TeamBoardDetail = {
  head: EntryHead;
  body: unknown;
};

export function createTeamBoardState(): TeamBoardState {
  return { selectedEntryId: null, detailOpen: false, kindFilterIndex: 0, follow: true };
}

export function boardKindFilter(state: TeamBoardState): EntryKind | "all" {
  return BOARD_KIND_FILTERS[state.kindFilterIndex % BOARD_KIND_FILTERS.length] ?? "all";
}

export function filterBoardEntries(entries: readonly EntryHead[], state: TeamBoardState): EntryHead[] {
  const kind = boardKindFilter(state);
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  return kind === "all" ? sorted : sorted.filter(entry => entry.kind === kind);
}

export function syncBoardEntries(state: TeamBoardState, entries: readonly EntryHead[]): {
  state: TeamBoardState;
  visible: EntryHead[];
  selected: EntryHead | null;
} {
  const visible = filterBoardEntries(entries, state);
  if (visible.length === 0) {
    return { state: { ...state, selectedEntryId: null }, visible, selected: null };
  }
  const existing = state.selectedEntryId ? visible.find(entry => entry.entryId === state.selectedEntryId) : undefined;
  const selected = state.follow ? visible[visible.length - 1]! : existing ?? visible[visible.length - 1]!;
  return {
    state: selected.entryId === state.selectedEntryId ? state : { ...state, selectedEntryId: selected.entryId },
    visible,
    selected,
  };
}

export function applyBoardCommand(
  state: TeamBoardState,
  command: TeamWatchCommand,
  entries: readonly EntryHead[],
): { state: TeamBoardState; jumpToMemberId?: string; needDetail?: string } {
  const synced = syncBoardEntries(state, entries);
  const { visible, selected } = synced;
  const current = synced.state;
  const index = selected ? visible.findIndex(entry => entry.entryId === selected.entryId) : -1;

  if (command === "up") {
    if (visible.length === 0) return { state: { ...current, follow: false } };
    const nextIndex = index > 0 ? index - 1 : 0;
    const nextId = visible[nextIndex]!.entryId;
    return { state: { ...current, follow: false, selectedEntryId: nextId }, ...(current.detailOpen ? { needDetail: nextId } : {}) };
  }
  if (command === "down") {
    if (visible.length === 0) return { state: current };
    const nextIndex = index >= 0 && index < visible.length - 1 ? index + 1 : visible.length - 1;
    const nextId = visible[nextIndex]!.entryId;
    return { state: { ...current, selectedEntryId: nextId }, ...(current.detailOpen ? { needDetail: nextId } : {}) };
  }
  if (command === "top") {
    const nextId = visible[0]?.entryId ?? null;
    return { state: { ...current, follow: false, selectedEntryId: nextId }, ...(current.detailOpen && nextId ? { needDetail: nextId } : {}) };
  }
  if (command === "bottom") {
    const nextId = visible[visible.length - 1]?.entryId ?? null;
    return { state: { ...current, selectedEntryId: nextId }, ...(current.detailOpen && nextId ? { needDetail: nextId } : {}) };
  }
  if (command === "enter") {
    if (!selected) return { state: current };
    const detailOpen = !current.detailOpen;
    return {
      state: { ...current, detailOpen },
      ...(detailOpen ? { needDetail: selected.entryId } : {}),
    };
  }
  if (command === "prev") {
    const nextFilterIndex = (current.kindFilterIndex + 1) % BOARD_KIND_FILTERS.length;
    const nextSynced = syncBoardEntries({ ...current, kindFilterIndex: nextFilterIndex }, entries);
    return {
      state: nextSynced.state,
      ...(nextSynced.state.detailOpen && nextSynced.selected ? { needDetail: nextSynced.selected.entryId } : {}),
    };
  }
  if (command === "follow") {
    const follow = !current.follow;
    const nextSynced = syncBoardEntries({ ...current, follow }, entries);
    return {
      state: nextSynced.state,
      ...(nextSynced.state.detailOpen && nextSynced.selected ? { needDetail: nextSynced.selected.entryId } : {}),
    };
  }
  if (command === "openMember") {
    if (selected?.authorMemberId) return { state: current, jumpToMemberId: selected.authorMemberId };
    return { state: current };
  }
  return { state: current };
}

function authorityLabel(authority: EntryHead["authority"]): string {
  if (authority === "receipt") return "Host receipt";
  if (authority === "direction") return "Owner direction";
  return "Agent claim";
}

function entryClock(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? short(iso, 16)
    : new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function overviewLines(lines: string[], team: any): void {
  const tasks = Array.isArray(team?.tasks) ? team.tasks : [];
  const criteria = Array.isArray(team?.goal?.record?.criteria) ? team.goal.record.criteria : [];
  const assessment = team?.assessment;
  const members = Array.isArray(team?.members) ? team.members : [];
  const revision = team?.revision;
  lines.push("", "OVERVIEW");
  if (criteria.length > 0) {
    for (const criterion of criteria) {
      const id = String(criterion.id ?? "");
      const label = id === "c0" && !criterion.statement ? short(team?.goal?.successCriteria || "Primary objective", 90) : short(criterion.statement, 90);
      const linked = tasks.filter((task: any) => Array.isArray(task?.criterionRefs?.criteria) && task.criterionRefs.criteria.includes(id));
      const integrated = linked.filter((task: any) => task?.status === "integrated").length;
      const assessed = Array.isArray(assessment?.criteria) ? assessment.criteria.find((item: any) => item?.id === id)?.state : undefined;
      const provisional = assessed ? ` · provisional: ${clean(assessed)}` : "";
      lines.push(`  ${clean(id)}  ${integrated}/${linked.length} tasks integrated${provisional} · ${label}`);
    }
  } else if (tasks.length > 0) {
    const integrated = tasks.filter((task: any) => task?.status === "integrated").length;
    const provisional = assessment?.result ? ` · provisional: ${clean(assessment.result)}` : "";
    lines.push(`  Tasks: ${integrated} of ${tasks.length} integrated${provisional}`);
  } else {
    lines.push("  No tasks planned yet.");
  }
  const active = members.filter((member: any) => member?.revision === revision && ["queued", "running", "waiting"].includes(member?.status));
  const finished = members.length - active.length;
  const activeText = active.length
    ? active.slice(0, 4).map((member: any) => `${roleNames[member.role] ?? clean(member.role)} ${clean(member.status)}${member.taskId ? `(${clean(member.taskId)})` : ""}`).join(", ")
    : "none";
  lines.push(`  Roster: Active (${active.length}) ${activeText} · Finished (${finished})`);
}

function detailBodyLines(lines: string[], detail: TeamBoardDetail): void {
  const body = typeof detail.body === "object" && detail.body !== null && !Array.isArray(detail.body)
    ? detail.body as Record<string, unknown>
    : null;
  if (!body) {
    lines.push(`  ${short(JSON.stringify(detail.body), 400)}`);
    return;
  }
  if (typeof body.command === "object" && body.command !== null) {
    const cmd = body.command as { command?: unknown; args?: unknown[] };
    const text = [String(cmd.command ?? ""), ...(Array.isArray(cmd.args) ? cmd.args.map(String) : [])].filter(Boolean).join(" ");
    lines.push(`  Command: ${short(text, 200)}`);
  }
  if (typeof body.status === "string") lines.push(`  Status: ${clean(body.status)}${body.exitCode !== undefined ? ` · exit ${String(body.exitCode)}` : ""}${body.round !== undefined ? ` · round ${String(body.round)}` : ""}`);
  if (typeof body.taskId === "string") lines.push(`  Task: ${clean(body.taskId)}`);
  const commit = typeof body.headCommit === "string" ? body.headCommit : typeof body.commit === "string" ? body.commit : undefined;
  if (commit) lines.push(`  Commit: ${clean(commit)}`);
  const report = typeof body.report === "object" && body.report !== null ? body.report as Record<string, unknown> : null;
  if (report) {
    if (typeof report.verdict === "string") lines.push(`  Verdict: ${clean(report.verdict)}`);
    if (typeof report.summary === "string") lines.push(`  Summary: ${short(report.summary, 400)}`);
    if (typeof report.uiEvidence === "string") lines.push(`  UI evidence: ${short(report.uiEvidence, 300)}`);
    if (Array.isArray(report.acceptance)) {
      for (const item of report.acceptance.slice(0, 6)) {
        const row = item as { criterion?: unknown; verdict?: unknown; evidence?: unknown };
        lines.push(`  Acceptance #${String(row.criterion ?? "?")}: ${clean(row.verdict)} — ${short(row.evidence, 180)}`);
      }
    }
  } else if (typeof body.summary === "string") {
    lines.push(`  Summary: ${short(body.summary, 400)}`);
  }
  if (typeof body.changedPaths === "object" && body.changedPaths !== null) {
    const cp = body.changedPaths as { paths?: unknown[] };
    if (Array.isArray(cp.paths) && cp.paths.length > 0) lines.push(`  Changed: ${cp.paths.slice(0, 8).map(p => clean(p)).join(", ")}`);
  }
  if (typeof body.question === "string") lines.push(`  Question: ${short(body.question, 240)}`);
  if (typeof body.text === "string") lines.push(`  Text: ${short(body.text, 400)}`);
  if (typeof body.output === "string" && body.output.trim()) {
    lines.push("  Output:");
    for (const line of body.output.trim().split(/\r?\n/).slice(-8)) lines.push(`    ${short(line, 240)}`);
  }
}

export function teamBoardText(
  team: any,
  entries: readonly EntryHead[],
  boardState: TeamBoardState,
  detail: TeamBoardDetail | null,
  checkedAt = "",
  interactive = false,
  width = 80,
): string {
  const lines = teamHeading(team, "board");
  if (team?.reason) lines.push(`Reason: ${short(team.reason, 400)}`);
  decisionLines(lines, team);
  overviewLines(lines, team);
  const membersById = new Map<string, any>((Array.isArray(team?.members) ? team.members : []).map((m: any) => [m.memberId, m]));
  const synced = syncBoardEntries(boardState, entries);
  const kindLabel = boardKindFilter(synced.state);
  const countLabel = synced.visible.length === entries.length
    ? `${synced.visible.length}`
    : `${synced.visible.length} of ${entries.length}`;
  lines.push("", `BLACKBOARD ENTRIES (${countLabel}) · filter ${kindLabel} · follow ${synced.state.follow ? "on" : "off"}`);
  if (synced.visible.length === 0) {
    lines.push("  No blackboard entries match this filter.");
  } else {
    for (const entry of synced.visible) {
      const marker = synced.selected?.entryId === entry.entryId ? ">" : " ";
      const member = entry.authorMemberId ? membersById.get(entry.authorMemberId) : undefined;
      const author = member
        ? roleNames[member.role] ?? clean(member.role)
        : entry.authorRole
          ? roleNames[entry.authorRole] ?? clean(entry.authorRole)
          : entry.author === "owner" ? "Owner" : "Host";
      const task = entry.taskId ? ` · ${clean(entry.taskId)}` : "";
      const commit = entry.headCommit ? ` · ${clean(entry.headCommit).slice(0, 7)}` : "";
      const stateTag = entry.state !== "active" ? ` · ${clean(entry.state)}` : "";
      lines.push(`${marker} seq ${entry.seq}  ${entryClock(entry.at)}  [${authorityLabel(entry.authority)}]  ${clean(entry.kind)}  ${author}${task}${commit}${stateTag}`);
      lines.push(`  ${short(entry.summary, Math.max(24, width - 4))}`);
    }
  }
  if (synced.state.detailOpen && synced.selected) {
    const sel = synced.selected;
    lines.push("", `ENTRY DETAIL · seq ${sel.seq} · ${clean(sel.entryId)}`);
    lines.push(`  Authority: ${authorityLabel(sel.authority)} · kind: ${clean(sel.kind)} · state: ${clean(sel.state)} · revision: ${sel.revision}`);
    if (sel.headCommit) lines.push(`  Commit: ${clean(sel.headCommit)}`);
    if (sel.supersedes) lines.push(`  Supersedes: ${clean(sel.supersedes)}`);
    if (detail && detail.head.entryId === sel.entryId) detailBodyLines(lines, detail);
    else lines.push("  Loading entry detail...");
  }
  const footer = interactive
    ? `↑↓ entry · enter detail · p filter (${kindLabel}) · f follow (${synced.state.follow ? "on" : "off"}) · o member logs · l logs · s summary · q quit`
    : `Summary: infinite team status ${clean(team?.id)} · Logs: infinite team status ${clean(team?.id)} --logs`;
  lines.push("", checkedAt ? `${clean(checkedAt)} · ${footer}` : footer);
  return lines.join("\n");
}

export function boardFocusOffset(
  text: string,
  rows: number,
  columns: number,
  currentOffset: number,
  detailOpen: boolean,
): number {
  const all = text.split("\n");
  all.pop();
  while (all.length && !all[all.length - 1]!.trim()) all.pop();
  const width = Math.max(1, columns || 80);
  const wrapped = wrapText(all.join("\n"), width);
  const visible = Math.max(1, Math.max(3, rows || 24) - 3);
  const selectedIdx = wrapped.findIndex(line => line.startsWith("> seq "));
  const detailIdx = detailOpen ? wrapped.findIndex(line => line.startsWith("ENTRY DETAIL ")) : -1;
  const focusStart = detailOpen && detailIdx >= 0 ? detailIdx : selectedIdx;
  if (focusStart < 0) return currentOffset;
  const focusEnd = detailOpen && detailIdx >= 0
    ? wrapped.length - 1
    : Math.min(wrapped.length - 1, focusStart + 1);
  if (focusStart < currentOffset) return focusStart;
  if (focusEnd >= currentOffset + visible) {
    return Math.min(focusStart, Math.max(0, focusEnd - visible + 1));
  }
  return currentOffset;
}

function eventLine(event: { type?: string; data?: Record<string, unknown> }) {
  const data = event.data ?? {};
  const label = event.type === "signal" ? String(data.kind ?? "Signal")
    : event.type === "input-result" ? (data.state === "delivered" ? "Input delivered" : "Input")
    : event.type === "lifecycle" ? String(data.status ?? "Session updated")
    : String(event.type ?? "Event");
  const detail = data.message ?? data.text ?? data.error;
  return typeof detail === "string" && detail.trim() ? `${label}: ${detail}` : label;
}

async function teamBriefRows(api: WatchApi, team: any, signal: AbortSignal, previous: TeamBriefRow[] = []): Promise<TeamBriefRow[]> {
  const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
  const current = ordered.filter(member => member?.revision === team?.revision);
  const targets = (current.length ? current : ordered).slice(0, 6);
  return Promise.all(targets.map(async member => {
    const sessionId = String(member.sessionId);
    try {
      return { sessionId, status: await api.json<TeamBriefStatus>(`/sessions/${sessionId}/summary?status=1`, undefined, signal) };
    } catch (error) {
      if (signal.aborted) throw error;
      return failedTeamBriefRow(sessionId, clean((error as Error).message), previous);
    }
  }));
}

async function memberLog(api: WatchApi, member: any, signal: AbortSignal) {
  const sessionId = String(member.sessionId);
  const detail = await api.json<{ screen?: string; seq?: number }>(`/sessions/${sessionId}`, undefined, signal);
  const after = Math.max(0, Number(detail?.seq ?? 0) - 80);
  const page = await api.json<{ events?: { at?: string; type?: string; data?: Record<string, unknown> }[] }>(
    `/sessions/${sessionId}/events?after=${after}&types=lifecycle,signal,input-result&limit=80`,
    undefined,
    signal,
  );
  return { screen: detail?.screen, events: (page.events ?? []).map(event => ({ at: event.at, text: eventLine(event) })) };
}

function shiftMember(members: any[], memberId: string, direction: 1 | -1) {
  const index = members.findIndex(member => member?.memberId === memberId);
  if (index < 0) return String(members[0]?.memberId ?? "");
  return String(members[(index + direction + members.length) % members.length]?.memberId ?? "");
}

function preferredMember(team: any, memberId: string, followRunning: boolean) {
  const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
  const current = ordered.filter(member => member?.revision === team?.revision);
  const pool = current.length ? current : ordered;
  if (!followRunning && memberId) {
    const selected = ordered.find(member => member?.memberId === memberId);
    if (selected) return selected;
  }
  return pool.find(member => member?.status === "running" || member?.status === "waiting") ?? pool[0];
}

async function printTeamLogs(api: WatchApi, team: any, signal: AbortSignal) {
  const current = orderedTeamMembers(team).filter(member => member?.revision === team?.revision && member?.sessionId);
  const shown = current.slice(0, 8);
  if (!shown.length) {
    console.log(`${clean(team?.id)} · review logs\n\nNo agents are in this revision.\n`);
    return;
  }
  const recorded = await Promise.all(shown.map(async member => {
    try { return { member, ...(await memberLog(api, member, signal)) }; }
    catch (error) {
      if (signal.aborted) throw error;
      return { member, screen: `Log unavailable: ${clean((error as Error).message)}`, events: [] as { at?: string; text?: string }[] };
    }
  }));
  for (const item of recorded) console.log(`${teamLogsText(team, shown, item.member, item.screen, item.events)}\n`);
  if (current.length > shown.length) console.log(`+ ${current.length - shown.length} more agents. Follow one with infinite team watch ${clean(team?.id)} --logs\n`);
}

async function askForBrief(api: WatchApi, team: any, rows: TeamBriefRow[], signal: AbortSignal, show: (text: string) => void, checkedAt: string): Promise<TeamBriefRow[]> {
  const chosen = chooseTeamBrief(rows, summaryMember(team)?.sessionId);
  if (!chosen || !canAskForBrief(team, rows)) return rows;
  const card = teamSummaryText(team, rows, checkedAt, true, Date.now()).split("\n");
  const footer = card.pop() ?? "";
  show([...card, "", "Refreshing the Brief. This can take a few minutes.", "", footer].join("\n"));
  try {
    const response = await api.request(`/sessions/${chosen.sessionId}/summary?after=0`, undefined, AbortSignal.any([signal, AbortSignal.timeout(180000)]));
    const summary = await response.json() as TeamBriefStatus["summary"];
    const ready = Boolean(summary?.repository?.brief?.summary || summary?.text);
    const next: TeamBriefRow = { sessionId: chosen.sessionId, status: { state: ready ? "ready" : "empty", summary, ...(ready ? {} : { error: "No recorded chat is available for a repository brief." }) } };
    return [...rows.filter(row => row.sessionId !== chosen.sessionId), next];
  } catch (error) {
    if (signal.aborted) throw error;
    return [...rows.filter(row => row.sessionId !== chosen.sessionId), { sessionId: chosen.sessionId, status: { state: "failed", error: clean((error as Error).message) } }];
  }
}

async function fetchAllEntries(api: WatchApi, teamId: string, signal: AbortSignal): Promise<EntryHead[]> {
  const collected = new Map<string, EntryHead>();
  let since = 0;
  for (let hops = 0; hops < 6; hops += 1) {
    const page = await api.json<EntryPage>(`/teams/${teamId}/entries?limit=100${since > 0 ? `&since=${since}` : ""}`, undefined, signal);
    for (const entry of page.entries) collected.set(entry.entryId, entry);
    if (!page.more || page.cursor <= since) break;
    since = page.cursor;
  }
  return [...collected.values()].sort((a, b) => a.seq - b.seq);
}

export async function runTeamWatch({
  subcommand,
  id,
  options,
  api,
}: {
  subcommand: "status" | "watch";
  id: string | undefined;
  options: { json: boolean; logs: boolean; board: boolean };
  api: WatchApi;
}): Promise<boolean> {
  const abort = new AbortController(), stop = () => abort.abort();
  const { json, logs, board } = options;
  const tty = subcommand === "watch" && Boolean(process.stdout.isTTY) && !json;
  const interactive = tty && Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  let mode: "summary" | "logs" | "board" = board ? "board" : logs ? "logs" : "summary";
  let memberId = "";
  let previous: string | null = null;
  let pending: ReturnType<typeof teamWatchCommand> = null;
  let pendingMemberId = "";
  let keepBoardFocus = board;
  let wake = new AbortController();
  let card = "";
  let notice = "";
  let status = "";
  let briefRows: TeamBriefRow[] = [];
  let boardState = createTeamBoardState();
  let boardEntries: EntryHead[] = [];
  const detailCache = new Map<string, TeamBoardDetail>();
  let lastTeam: any = null;
  let view = "";
  let offset = 0;
  let page = 1;
  const paint = () => {
    if (!card) return;
    const screen = teamWatchScreen(card, { rows: process.stdout.rows || 24, columns: process.stdout.columns || 80, offset, color: !process.env.NO_COLOR, status: notice || status });
    offset = screen.offset;
    page = screen.page;
    process.stdout.write(screen.frame);
  };
  const scrolls: Partial<Record<TeamWatchCommand, () => number>> = {
    up: () => offset - 1, down: () => offset + 1, pageUp: () => offset - page, pageDown: () => offset + page,
    top: () => 0, bottom: () => Number.MAX_SAFE_INTEGER,
  };
  const clock = () => tty ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const show = (text: string, fixedStatus = "") => {
    const output = fixedStatus ? `${text}\n${fixedStatus}` : text;
    if (subcommand !== "watch") console.log(`${process.stdout.isTTY ? wrapText(output, process.stdout.columns || 80).join("\n") : output}\n`);
    else if (!tty) {
      const frame = teamWatchFrame(previous, output, false);
      if (frame) process.stdout.write(frame);
      previous = output;
    } else {
      const key = `${mode}/${mode === "logs" ? memberId : ""}`;
      if (key !== view) { view = key; offset = 0; }
      if (mode === "board" && keepBoardFocus) {
        offset = boardFocusOffset(text, process.stdout.rows || 24, process.stdout.columns || 80, offset, boardState.detailOpen);
      }
      card = text;
      notice = "";
      status = fixedStatus;
      paint();
    }
  };
  const boardCommands = new Set<TeamWatchCommand>(["up", "down", "top", "bottom", "enter", "prev", "follow", "openMember"]);
  const onData = (data: string | Buffer) => {
    const command = teamWatchCommand(String(data));
    if (command === "detach") { stop(); return; }
    if (!command) return;
    if (mode === "board" && boardCommands.has(command) && lastTeam) {
      const result = applyBoardCommand(boardState, command, boardEntries);
      boardState = result.state;
      if (result.jumpToMemberId) {
        pending = "openMember";
        pendingMemberId = result.jumpToMemberId;
        wake.abort();
        return;
      }
      keepBoardFocus = true;
      const selected = boardState.selectedEntryId ? detailCache.get(boardState.selectedEntryId) ?? null : null;
      show(teamBoardText(lastTeam, boardEntries, boardState, selected, clock(), interactive, process.stdout.columns || 80));
      if (result.needDetail && !detailCache.has(result.needDetail)) wake.abort();
      return;
    }
    const scroll = scrolls[command];
    if (scroll) {
      keepBoardFocus = false;
      offset = scroll();
      paint();
      return;
    }
    pending = command;
    wake.abort();
  };
  process.once("SIGINT", stop);
  if (tty) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.stdout.on("resize", paint);
  }
  if (interactive) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  }
  try {
    do {
      try {
        const teams = id ? [await api.json<any>(`/teams/${id}`, undefined, abort.signal)] : (await api.json<{ teams: any[] }>("/teams", undefined, abort.signal)).teams;
        if (json) {
          const text = JSON.stringify(id ? teams[0] : teams, null, subcommand === "watch" ? undefined : 2);
          if (subcommand !== "watch" || text !== previous) console.log(text);
          previous = text;
        } else if (!id) {
          for (const team of teams) console.log(`${teamMonitorText(team)}\n`);
          if (teams.length) console.log("Open one team for its Brief: infinite team status ID\n");
        } else {
          const team = teams[0];
          lastTeam = team;
          const action = pending;
          pending = null;
          if (action === "logs") mode = "logs";
          else if (action === "summary") mode = "summary";
          else if (action === "board") {
            mode = "board";
            keepBoardFocus = true;
          } else if (action === "openMember") {
            mode = "logs";
            if (pendingMemberId) memberId = pendingMemberId;
            pendingMemberId = "";
          } else if (action === "next" || action === "prev") {
            mode = "logs";
            const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
            const known = ordered.some(member => member?.memberId === memberId);
            memberId = known ? shiftMember(ordered, memberId, action === "next" ? 1 : -1) : String(ordered[0]?.memberId ?? "");
          }
          if (subcommand === "status" && logs) await printTeamLogs(api, team, abort.signal);
          else if (mode === "board") {
            boardEntries = await fetchAllEntries(api, String(team.id), abort.signal);
            if (pending) continue;
            const synced = syncBoardEntries(boardState, boardEntries);
            boardState = synced.state;
            if (boardState.follow) keepBoardFocus = true;
            let detail: TeamBoardDetail | null = null;
            if (boardState.detailOpen && synced.selected) {
              detail = detailCache.get(synced.selected.entryId) ?? null;
              if (!detail) {
                detail = await api.json<TeamBoardDetail>(`/teams/${team.id}/entries/${synced.selected.entryId}`, undefined, abort.signal);
                detailCache.set(synced.selected.entryId, detail);
              }
            }
            if (!pending) show(teamBoardText(team, boardEntries, boardState, detail, clock(), interactive, process.stdout.columns || 80));
          } else if (mode === "logs") {
            const member = preferredMember(team, memberId, !interactive);
            if (member?.memberId) memberId = String(member.memberId);
            if (!member) {
              if (!pending) show(`${clean(team?.id)} · review logs\n\nNo agent session is available.\n\n${interactive ? "b board · s summary · q quit" : "Summary: infinite team status " + clean(team?.id)}`);
            } else {
              const recorded = await memberLog(api, member, abort.signal);
              if (!pending) show(teamLogsText(team, orderedTeamMembers(team).filter(item => item?.sessionId), member, recorded.screen, recorded.events, clock(), interactive, process.stdout.columns || 80));
            }
          } else {
            let rows = await teamBriefRows(api, team, abort.signal, briefRows);
            briefRows = rows;
            if (action === "ask" && interactive) rows = await askForBrief(api, team, rows, abort.signal, show, clock());
            const chosen = chooseTeamBrief(rows, summaryMember(team)?.sessionId);
            const failed = rows.find(row => row.fetchError);
            const briefInProgress = chosen && (chosen.status.state === "pending" || chosen.status.state === "running");
            const hasBrief = Boolean(chosen?.status.summary?.repository?.brief?.summary || chosen?.status.summary?.text);
            const progress = briefInProgress ? hasBrief ? "Understanding is updating this Brief." : "Understanding is writing the Brief." : "";
            const failureStatus = failed ? `Summary refresh failed: ${failed.fetchError}` : "";
            if (!pending) show(teamSummaryText(team, rows, clock(), interactive, interactive ? Date.now() : undefined, tty), failureStatus || (tty ? progress : ""));
          }
        }
      } catch (error) {
        if (abort.signal.aborted || subcommand !== "watch") throw error;
        const failure = `Update failed: ${clean((error as Error).message)}`;
        if (tty && card) { notice = `${failure}. Showing the last received card.`; status = ""; paint(); }
        else show(`${failure}\n\n${interactive ? "q quit" : "Ctrl+C detaches"}`);
      }
      if (subcommand !== "watch") break;
      if (wake.signal.aborted) wake = new AbortController();
      else {
        try { await delay(2000, undefined, { signal: AbortSignal.any([abort.signal, wake.signal]) }); }
        catch { if (abort.signal.aborted) break; }
        if (wake.signal.aborted) wake = new AbortController();
      }
    } while (!abort.signal.aborted);
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    if (interactive) {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    if (tty) {
      process.stdout.off("resize", paint);
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
    process.off("SIGINT", stop);
  }
  return true;
}
