import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Board, BoardItem, Mission } from "./mission-types.js";
import type { ProjectGroup, ProjectGroupList } from "./project-group-types.js";
import type { TeamRun } from "./team-types.js";
import { boundTeamProject } from "./team-cli.js";
import { teamWatchFrame } from "./team-watch.js";

type ClientConfig = { origin: string; token: string };
type Api = {
  request(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<Response>;
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T>;
};
type Options = Record<string, string | boolean>;
const safe = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
const short = (value: unknown, max: number) => {
  const text = safe(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};
const age = (updatedAt: string, now: number) => {
  const elapsed = Math.max(0, now - Date.parse(updatedAt));
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.floor(elapsed / 60_000);
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
};

export function resolveMissionProject(
  groups: ProjectGroupList,
  explicitId: string | undefined,
  currentDirectory: string,
  binding: (directory: string) => string | undefined,
): ProjectGroup {
  if (explicitId) {
    const selected = groups.groups.find(group => group.id === explicitId);
    if (!selected) throw new Error(`Unknown project ID: ${explicitId}`);
    return selected;
  }
  const projectId = binding(currentDirectory);
  if (!projectId) throw new Error("No repository project is bound to this directory. Run infinite repo init or use --project ID.");
  const selected = groups.groups.find(group => group.id === projectId || group.repos.some(repo => repo.projectId === projectId));
  if (!selected) throw new Error("The current repository is not in an available project. Run infinite projects and select a project with --project ID.");
  return selected;
}

export function boardLines(
  board: Board,
  projects: ProjectGroup[],
  selectedIndex: number,
  targetProjectId: string,
  composer: string,
  width: number,
  now = Date.now(),
): string[] {
  const selectedProject = projects.find(project => project.id === targetProjectId);
  const columns = Math.max(2, Number.isFinite(width) && width > 0 ? Math.floor(width) : process.stdout.columns || 80);
  const items = board.items;
  const sections: { column: BoardItem["column"]; title: string; subtitle: string }[] = [
    { column: "needs-input", title: "Needs input", subtitle: "Waiting on your decision or a blocker needs attention" },
    { column: "working", title: "Working", subtitle: "Missions and teams making progress" },
    { column: "review", title: "Ready for review", subtitle: "Completed work waiting for your review" },
  ];
  const lines: string[] = [];
  let rowIndex = 0;
  for (const section of sections) {
    lines.push(section.title, `\x1b[2m${section.subtitle}\x1b[0m`);
    const rows = items.filter(item => item.column === section.column);
    if (!rows.length) lines.push("  Nothing here");
    for (const item of rows) {
      const progress = item.kind === "mission" && item.subtasks
        ? `${Math.max(0, item.subtasks.done)}/${Math.max(0, item.subtasks.total)}`
        : "";
      const ageText = short(age(item.updatedAt, now) || "?", columns - 1);
      const contentWidth = columns - ageText.length - 1;
      const fields = [safe(item.title), safe(item.projectName), progress, safe(item.detail)];
      const content = () => fields.filter(Boolean).join("  ");
      const shrinkOrder = [3, 0, 1, 2];
      while (content().length > contentWidth) {
        const index = shrinkOrder.find(candidate => fields[candidate]!.length > 1)
          ?? shrinkOrder.find(candidate => fields[candidate]!.length > 0);
        if (index === undefined) break;
        fields[index] = fields[index]!.length > 1 ? short(fields[index]!, fields[index]!.length - 1) : "";
      }
      const text = content();
      const progressText = progress && fields[2] ? `\x1b[2m${fields[2]}\x1b[0m` : "";
      const displayed = fields.map((field, index) => index === 2 && progressText ? progressText : field).filter(Boolean).join("  ");
      const padding = " ".repeat(Math.max(0, contentWidth - text.length));
      const row = ` ${displayed}${padding}${ageText}`;
      lines.push(rowIndex++ === selectedIndex ? `\x1b[7m${row}\x1b[0m` : row);
    }
    lines.push("");
  }
  const ended = items.filter(item => item.column === "ended").length;
  lines.push(`Ended ${ended} (collapsed)`);
  lines.push("─".repeat(Math.max(8, columns)));
  lines.push(`❯ ${composer || "describe a task for a new mission"}`);
  lines.push(`  Project: ${selectedProject?.name ?? "Choose a project"}  · Tab changes project  · ↑/↓ select  · a answer  · q quit`);
  return lines;
}

function boardItem(board: Board, index: number) {
  const rows = board.items.filter(item => item.column !== "ended");
  return rows[Math.min(Math.max(index, 0), Math.max(0, rows.length - 1))];
}
function openDecision(decisions: { id: string; question?: string; answer?: string }[] = []) {
  return decisions.find(decision => !decision.answer);
}

async function answerSelected(item: BoardItem, api: Api, text: string) {
  if (item.kind === "mission") {
    const mission = await api.json<Mission>(`/missions/${item.id}`);
    const decision = openDecision(mission.decisions);
    if (!decision) throw new Error("The selected mission has no open decision.");
    return api.json(`/missions/${item.id}/answer/${decision.id}`, { requestId: randomUUID(), revision: mission.revision, text });
  }
  if (item.kind === "team") {
    const team = await api.json<TeamRun>(`/teams/${item.id}`);
    const decision = openDecision(team.decisions);
    if (!decision) throw new Error("The selected team has no open decision.");
    return api.json(`/teams/${item.id}/decisions/${decision.id}/answer`, { requestId: randomUUID(), revision: team.revision, text });
  }
  throw new Error("Goals cannot be answered from this board.");
}

async function openItem(item: BoardItem, api: Api, config: ClientConfig, configPath: string) {
  if (item.kind === "mission") {
    const mission = await api.json<Mission>(`/missions/${item.id}`);
    const lines = [`${mission.title}  ${mission.id}`, `${mission.groupName}  · ${mission.status}  · revision ${mission.revision}`];
    if (mission.reason) lines.push(`Reason: ${safe(mission.reason)}`);
    lines.push("", safe(mission.objective));
    const decisions = mission.decisions.filter(decision => !decision.answer);
    if (decisions.length) {
      lines.push("", "Open decisions");
      for (const decision of decisions) lines.push(`  ${decision.id}  ${safe(decision.question)}`);
    }
    if (mission.subtasks.length) {
      lines.push("", "Subtasks");
      for (const task of mission.subtasks) lines.push(`  ${task.title}  ${task.repoProjectId}  ${task.status}${task.teamId ? `  infinite team watch ${task.teamId}` : ""}`);
    }
    console.log(lines.join("\n"));
    return;
  }
  if (item.kind === "team") {
    const { handleTeamClientCommand } = await import("./team-cli.js");
    await handleTeamClientCommand("team", ["watch", item.id], {}, config, api, configPath, ["team", "watch", item.id]);
  } else {
    console.log(`${item.title}  ${item.id}\n${item.status}  · ${item.projectName}\n${item.detail}`);
  }
}

export async function handleBoardClientCommand(
  command: "projects" | "start" | "mission" | "board",
  positional: string[], options: Options, config: ClientConfig, api: Api, configPath: string,
): Promise<boolean> {
  if (command === "projects") {
    const action = positional[0];
    if (action !== "group" || positional.length < 3) throw new Error("Usage: infinite projects group NAME REPO_ID...");
    const body = { requestId: randomUUID(), name: positional[1], repos: positional.slice(2) };
    const group = await api.json<ProjectGroup>("/project-groups", body);
    console.log(`${group.name}  ${group.id}`);
    return true;
  }
  if (command === "start") {
    const projectFlag = options["--project"] === undefined ? undefined : String(options["--project"]);
    const objective = positional.join(" ").trim();
    if (!objective) throw new Error('Usage: infinite start [--project ID] "task"');
    const groups = await api.json<ProjectGroupList>("/project-groups");
    const project = resolveMissionProject(groups, projectFlag, process.cwd(), directory => boundTeamProject(config, configPath, directory));
    const mission = await api.json<Mission>("/missions", { requestId: randomUUID(), groupId: project.id, objective });
    console.log(`Started mission ${mission.id} in ${project.name}.\nFollow it with infinite board.`);
    return true;
  }
  if (command === "mission") {
    const [action, id, argument, ...rest] = positional;
    if (!action || !id) throw new Error("Usage: infinite mission status ID | answer ID DECISION_ID TEXT | steer ID TEXT | pause|resume|cancel ID");
    if (action === "status") {
      if (argument || rest.length) throw new Error("Usage: infinite mission status ID");
      const mission = await api.json<Mission>(`/missions/${id}`);
      console.log(options["--json"] ? JSON.stringify(mission, null, 2) : formatMission(mission));
      return true;
    }
    const current = await api.json<Mission>(`/missions/${id}`);
    const requestId = randomUUID();
    if (action === "answer") {
      if (!argument || !rest.length) throw new Error("Usage: infinite mission answer ID DECISION_ID TEXT");
      const decisionId = argument, text = rest.join(" ");
      await api.json(`/missions/${id}/answer/${decisionId}`, { requestId, revision: current.revision, text });
    } else if (action === "steer") {
      const text = [argument, ...rest].filter(Boolean).join(" ");
      if (!text) throw new Error("Usage: infinite mission steer ID TEXT");
      await api.json(`/missions/${id}/steer`, { requestId, revision: current.revision, text });
    } else if (["pause", "resume", "cancel"].includes(action)) {
      if (argument || rest.length) throw new Error(`Usage: infinite mission ${action} ID`);
      await api.json(`/missions/${id}/${action}`, { requestId, revision: current.revision });
    } else throw new Error("Usage: infinite mission status|answer|steer|pause|resume|cancel ...");
    console.log(`Mission ${id} ${action} requested.`);
    return true;
  }
  if (command === "board") {
    if (positional.length) throw new Error("Usage: infinite board [--project ID]");
    await runBoard(api, config, configPath, options);
    return true;
  }
  return false;
}

function formatMission(mission: Mission) {
  const lines = [`${mission.title}  ${mission.id}`, `${mission.groupName}  · ${mission.status}  · revision ${mission.revision}`, safe(mission.objective)];
  if (mission.reason) lines.push(`Reason: ${safe(mission.reason)}`);
  for (const decision of mission.decisions.filter(item => !item.answer)) lines.push(`Decision ${decision.id}: ${safe(decision.question)}`);
  for (const task of mission.subtasks) lines.push(`${task.title}  ${task.repoProjectId}  ${task.status}`);
  return lines.join("\n");
}

async function runBoard(api: Api, config: ClientConfig, configPath: string, options: Options) {
  const abort = new AbortController();
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY && !options["--json"]);
  let active = true, cursor = 0, projectIndex = 0, composer = "", answerMode = false, notice = "", board: Board = { items: [] };
  let openAfterBoard: BoardItem | undefined;
  let previous: string | null = null;
  const initial = await api.json<ProjectGroupList>("/project-groups", undefined, abort.signal);
  const projects = initial.groups;
  if (!projects.length) throw new Error("No projects are available. Enroll a repository with infinite repo init first.");
  const requested = options["--project"] === undefined ? undefined : String(options["--project"]);
  projectIndex = requested ? projects.findIndex(project => project.id === requested) : 0;
  if (requested && projectIndex < 0) throw new Error(`Unknown project ID: ${requested}`);
  const target = () => projects[projectIndex]!.id;
  const visibleBoard = () => options["--project"]
    ? { ...board, items: board.items.filter(item => item.groupId === target() || (!item.groupId && item.projectName === projects[projectIndex]!.name)) }
    : board;
  const paint = (now = Date.now()) => {
    const visible = visibleBoard();
    const lines = boardLines(visible, projects, cursor, target(), composer, process.stdout.columns || 80, now);
    const text = `${notice ? `${notice}\n\n` : ""}${lines.join("\n")}`;
    if (tty) process.stdout.write(`\x1b[H\x1b[J${text}\n`);
    else if (options["--json"]) {
      const encoded = JSON.stringify(board);
      if (encoded !== previous) console.log(encoded);
      previous = encoded;
    } else {
      const frame = teamWatchFrame(previous, text, false);
      if (frame) process.stdout.write(frame);
      previous = text;
    }
  };
  const submit = async () => {
    if (answerMode && !composer.trim()) {
      notice = "Type an answer before pressing Enter.";
      return;
    }
    if (!composer.trim()) {
      const item = boardItem(visibleBoard(), cursor);
      if (item) { openAfterBoard = item; active = false; abort.abort(); }
      return;
    }
    const text = composer.trim();
    if (answerMode) {
      const item = boardItem(visibleBoard(), cursor);
      if (!item) throw new Error("Select a board row with an open decision first.");
      await answerSelected(item, api, text);
      notice = "Answer submitted.";
      answerMode = false;
    } else {
      const mission = await api.json<Mission>("/missions", { requestId: randomUUID(), groupId: target(), objective: text });
      notice = `Started mission ${mission.id}.`;
    }
    composer = "";
  };
  const onData = (data: string | Buffer) => {
    const text = String(data);
    if (text.includes("\u0003")) { active = false; abort.abort(); return; }
    if (text === "\u001b[A" || text === "\u001bOA") { cursor = Math.max(0, cursor - 1); paint(); return; }
    if (text === "\u001b[B" || text === "\u001bOB") { cursor = Math.min(Math.max(0, visibleBoard().items.filter(item => item.column !== "ended").length - 1), cursor + 1); paint(); return; }
    if (text === "\t") { projectIndex = (projectIndex + 1) % projects.length; cursor = 0; paint(); return; }
    if (text === "\r" || text === "\n") { void submit().then(() => paint()).catch(error => { notice = safe((error as Error).message); paint(); }); return; }
    if (text === "\u007f" || text === "\b") { composer = composer.slice(0, -1); paint(); return; }
    if (text === "q" && !composer) { active = false; abort.abort(); return; }
    if (text === "a" && !composer) { answerMode = true; composer = ""; notice = "Type your answer for the selected row, then press Enter."; paint(); return; }
    if (text.length === 1 && text >= " " && text !== "\u001b") { composer += text; paint(); }
  };
  const onResize = () => paint();
  const onSigint = () => { active = false; abort.abort(); };
  if (tty) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume();
    process.stdin.on("data", onData); process.stdout.on("resize", onResize);
  }
  process.once("SIGINT", onSigint);
  try {
    do {
      board = await api.json<Board>("/board", undefined, abort.signal);
      cursor = Math.min(cursor, Math.max(0, visibleBoard().items.filter(item => item.column !== "ended").length - 1));
      paint();
      if (!tty) break;
      try { await delay(2000, undefined, { signal: abort.signal }); }
      catch { if (abort.signal.aborted) break; }
    } while (active && !abort.signal.aborted);
  } finally {
    process.off("SIGINT", onSigint);
    if (tty) {
      process.stdin.off("data", onData); process.stdout.off("resize", onResize);
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
  }
  if (openAfterBoard) {
    await openItem(openAfterBoard, api, config, configPath);
    await runBoard(api, config, configPath, options);
  }
}
