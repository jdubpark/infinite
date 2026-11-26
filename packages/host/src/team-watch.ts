import { recommendationLine, type QuestionRecommendation } from "./question-recommendation.js";

export const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function openQuestionLines(question: { id: unknown; question: unknown; options?: unknown; recommendation?: QuestionRecommendation }): string[] {
  const options: unknown[] = Array.isArray(question.options) ? question.options : [];
  return [`Question ${clean(question.id)}: ${clean(question.question)}`,
    ...(question.recommendation ? [`  ${clean(recommendationLine(question.recommendation))}`] : []),
    ...options.map((option, index) => `  ${index + 1}. ${clean(option)}`)];
}
export const short = (value: unknown, max: number) => {
  const text = clean(value).trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};
export const roleNames: Record<string, string> = {
  "project-manager": "Coordinator",
  "intent-checker": "Intent checker",
  scout: "Scout",
  implementer: "Implementer",
  integrator: "Integrator",
  reviewer: "Reviewer",
  delivery: "Delivery",
  evaluator: "Evaluator",
  judge: "Judge",
};

export function teamMonitorText(team: any, checkedAt = "", detach = false): string {
  const lines = [
    `${clean(team.id)}  ${clean(team.status)}  ${short(team.title, 100)}`,
    `Project ${clean(team.projectId)} · workspace ${clean(team.workspace)} · branch ${clean(team.branch)}`,
  ];
  if (team.linear?.issue?.url) lines.push(`Linear ${clean(team.linear.issue.url)}`);
  else if (team.linear?.url) lines.push(`Linear ${clean(team.linear.url)}`);
  if (team.reason) lines.push(`Reason: ${short(team.reason, 240)}`);
  waitReasonLines(lines, team);
  const members = Array.isArray(team.members) ? team.members : [];
  const current = members.filter((member: any) => member?.revision === team.revision);
  const shown = (current.length ? current : members).slice(0, 8);
  if (shown.length) {
    lines.push("", "Members");
    for (const member of shown) {
      const role = roleNames[member.role] ?? short(member.role, 24);
      const task = member.taskId ? ` · ${short(member.taskId, 40)}` : "";
      const flags = [member.stalledAt ? "stalled" : "", member.spinnerOnlySince ? "spinner-only" : ""].filter(Boolean);
      const flagText = flags.length ? ` · ${flags.join(" · ")}` : "";
      const stopped = member.stoppedReason ? ` · ${short(member.stoppedReason, 80)}` : "";
      lines.push(`  ${role}  ${clean(member.status)}  ${short(member.title, 80)}${task}${flagText}${stopped}`);
    }
    const hidden = (current.length ? current.length : members.length) - shown.length;
    if (hidden > 0) lines.push(`  + ${hidden} more`);
  }
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  if (tasks.length) {
    const counts = new Map<string, number>();
    for (const task of tasks) counts.set(clean(task?.status) || "unknown", (counts.get(clean(task?.status) || "unknown") ?? 0) + 1);
    lines.push("", `Tasks  ${[...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ")}`);
  }
  let questions = 0;
  for (const question of team.decisions ?? []) {
    if (question?.answer || questions >= 3) continue;
    lines.push(`Question ${short(question.id, 40)}: ${short(question.question, 180)}`);
    if (question.recommendation) lines.push(short(recommendationLine(question.recommendation), 240));
    questions += 1;
  }
  const events = Array.isArray(team.events) ? team.events : [];
  const latest = events[events.length - 1];
  if (latest?.text) lines.push("", `Latest  ${short(latest.text, 200)}`);
  if (checkedAt) lines.push("", `Checked ${clean(checkedAt)} · Ctrl+C detaches`);
  else if (detach) lines.push("", "Ctrl+C detaches");
  return lines.join("\n");
}

export function teamWatchFrame(previous: string | null, next: string, tty: boolean): string | null {
  if (tty) return `\x1b[H\x1b[J${next}\n`;
  if (previous === next) return null;
  return `${next}\n`;
}

export type TeamBriefStatus = {
  state?: string;
  error?: string;
  summary?: {
    engine?: string;
    text?: string;
    at?: string;
    repository?: {
      generatedAt?: string;
      brief?: {
        summary?: string;
        architecture?: { text?: string }[];
        review?: { priority?: string; area?: string; why?: string; question?: string }[];
        changes?: { text?: string }[];
        checks?: { text?: string }[];
        guidance?: { basis?: string; text?: string }[];
        unknowns?: string[];
      };
    };
  };
};
export type TeamBriefRow = { sessionId: string; status: TeamBriefStatus; fetchError?: string };

export function failedTeamBriefRow(sessionId: string, error: string, previous: TeamBriefRow[] = []): TeamBriefRow {
  const prior = previous.find(row => row.sessionId === sessionId && row.status.summary);
  return prior ? { ...prior, fetchError: error } : { sessionId, status: { state: "unknown", error }, fetchError: error };
}

const roleRank = ["project-manager", "intent-checker", "scout", "implementer", "integrator", "reviewer", "evaluator", "judge", "delivery"];

export function orderedTeamMembers(team: any): any[] {
  const revision = team?.revision;
  const members = Array.isArray(team?.members) ? team.members : [];
  return [...members].sort((left, right) => {
    const rank = (member: any) => {
      const role = roleRank.indexOf(member?.role);
      return [
        member?.revision === revision ? 0 : 1,
        member?.status === "running" || member?.status === "waiting" ? 0 : 1,
        role < 0 ? roleRank.length : role,
      ];
    };
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
    return clean(left?.title).localeCompare(clean(right?.title)) || clean(left?.memberId).localeCompare(clean(right?.memberId));
  });
}

function briefBody(status: TeamBriefStatus | undefined): string {
  return clean(status?.summary?.repository?.brief?.summary || status?.summary?.text).trim();
}

function briefWhen(status: TeamBriefStatus | undefined): string {
  return status?.summary?.repository?.generatedAt || status?.summary?.at || "";
}

export function briefTime(iso: string, now?: number): string {
  const time = Date.parse(iso);
  if (!iso || Number.isNaN(time)) return clean(iso);
  const stamp = new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (now === undefined) return stamp;
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
  return `${stamp} (${age})`;
}

export function chooseTeamBrief(rows: { sessionId: string; status: TeamBriefStatus }[], coordinatorSessionId?: string) {
  const written = rows.filter(row => briefBody(row.status));
  const coordinator = rows.find(row => row.sessionId === coordinatorSessionId);
  const coordinatorText = written.find(row => row.sessionId === coordinatorSessionId);
  if (coordinatorText) return coordinatorText;
  const newest = [...written].sort((left, right) => briefWhen(right.status).localeCompare(briefWhen(left.status)))[0];
  return newest ?? coordinator ?? rows[0];
}

export function summaryMember(team: any) {
  const current = orderedTeamMembers(team).filter(member => member?.revision === team?.revision);
  return current.find(member => member?.role === "project-manager") ?? current[0] ?? orderedTeamMembers(team)[0];
}

function section(lines: string[], title: string, items: (string | string[])[], numbered = false) {
  const shown = items.map(item => (Array.isArray(item) ? item : [item]).map(part => clean(part).trim()).filter(Boolean)).filter(parts => parts.length);
  if (!shown.length) return;
  lines.push("", `${title} (${shown.length})`);
  shown.slice(0, 8).forEach((parts, index) => {
    const marker = numbered ? `${index + 1}.` : "•";
    lines.push(`  ${marker} ${short(parts[0], 600)}`);
    for (const part of parts.slice(1)) lines.push(`${" ".repeat(marker.length + 3)}${short(part, 600)}`);
  });
  if (shown.length > 8) lines.push(`  + ${shown.length - 8} more`);
}

export function waitReasonLines(lines: string[], team: any) {
  const reasons = Array.isArray(team?.waitReasons) ? team.waitReasons : [];
  if (!reasons.length) return;
  lines.push("", `WAIT REASONS (${reasons.length})`);
  for (const reason of reasons.slice(0, 6)) {
    const kind = clean(reason?.kind || "wait");
    const summary = short(reason?.summary ?? "", 240);
    lines.push(`  • [${kind}] ${summary}`);
  }
  if (reasons.length > 6) lines.push(`  + ${reasons.length - 6} more`);
}

export function decisionLines(lines: string[], team: any) {
  const open = (team?.decisions ?? []).filter((question: any) => !question?.answer && question?.revision === team?.revision);
  if (!open.length) return;
  lines.push("", `DECISIONS FOR YOU (${open.length})`);
  for (const question of open.slice(0, 3)) {
    lines.push(`  • ${short(question.question, 400)}`);
    if (question.recommendation) lines.push(`    ${short(recommendationLine(question.recommendation), 400)}`);
    const options = Array.isArray(question.options) ? question.options.map((option: unknown) => short(option, 60)).filter(Boolean) : [];
    if (options.length) lines.push(`    Options: ${options.join(" / ")}`);
    lines.push(`    infinite team answer ${clean(team?.id)} ${clean(question.id)} "YOUR ANSWER"`);
  }
  if (open.length > 3) lines.push(`  + ${open.length - 3} more`);
}

export function teamHeading(team: any, view: string) {
  const objective = clean(team?.objective).trim();
  return [`${clean(team?.id)} · ${clean(team?.status)} · revision ${clean(team?.revision)} · ${view}`, short(objective || team?.title, 500)];
}

export function canAskForBrief(team: any, rows: { sessionId: string; status: TeamBriefStatus }[]) {
  const chosen = chooseTeamBrief(rows, summaryMember(team)?.sessionId);
  return Boolean(chosen && !briefBody(chosen.status) && (chosen.status.state === "empty" || chosen.status.state === "failed"));
}

export function teamSummaryText(team: any, rows: { sessionId: string; status: TeamBriefStatus }[], checkedAt = "", interactive = false, now?: number, repainted = false): string {
  const lines = teamHeading(team, "summary");
  if (team?.reason) lines.push(`Reason: ${short(team.reason, 400)}`);
  waitReasonLines(lines, team);
  decisionLines(lines, team);
  const coordinator = summaryMember(team);
  const chosen = chooseTeamBrief(rows, coordinator?.sessionId);
  const member = orderedTeamMembers(team).find(item => item?.sessionId === chosen?.sessionId) ?? coordinator;
  const brief = chosen?.status.summary?.repository?.brief;
  const text = briefBody(chosen?.status);
  const label = brief || chosen?.status.summary?.engine === "jevcode" ? "BRIEF" : "SESSION SUMMARY";
  const when = briefWhen(chosen?.status);
  lines.push("", [label, member ? roleNames[member.role] ?? short(member.role, 24) : "", when ? briefTime(when, now) : ""].filter(Boolean).join(" · "));
  if (!text) {
    const pending = chosen?.status.state === "pending" || chosen?.status.state === "running";
    lines.push(pending && !repainted ? "Understanding is writing the Brief." : short(chosen?.status.error || (rows.length ? "No Brief yet." : "No agent session is available for a Brief."), 400));
    if (interactive && canAskForBrief(team, rows)) lines.push("Press a to refresh the Brief.");
  } else {
    if (!repainted && (chosen?.status.state === "pending" || chosen?.status.state === "running")) lines.push("Understanding is updating this Brief.");
    lines.push(short(brief?.summary || text, 1200));
    section(lines, "SYSTEM SHAPE", (brief?.architecture ?? []).map(item => item?.text ?? ""));
    section(lines, "REVIEW FIRST", (brief?.review ?? []).map(item => [
      `${item?.priority ? `[${clean(item.priority)}] ` : ""}${clean(item?.area)}`,
      clean(item?.why),
      item?.question ? `Ask: ${clean(item.question)}` : "",
    ]), true);
    section(lines, "WHAT CHANGED", (brief?.changes ?? []).map(item => item?.text ?? ""));
    section(lines, "CHECK EVIDENCE", (brief?.checks ?? []).map(item => item?.text ?? ""));
    section(lines, "GUIDANCE FOR AGENTS", (brief?.guidance ?? []).map(item => [item?.basis, item?.text].filter(Boolean).join(": ")));
    section(lines, "GAPS AND UNKNOWNS", brief?.unknowns ?? []);
    lines.push("", "Generated reading of recorded activity and the repository. It is not completion or approval.");
  }
  const keys = ["b board", "l logs", ...(canAskForBrief(team, rows) ? ["a refresh Brief"] : []), "q quit"].join(" · ");
  const tail = interactive ? keys : `Review logs: infinite team status ${clean(team?.id)} --logs`;
  lines.push("", checkedAt ? `${clean(checkedAt)} · ${tail}` : tail);
  return lines.join("\n");
}

export function visibleScreen(value: unknown, maxLines = 24): string {
  const raw = String(value ?? "");
  const plain = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  const lines = plain.split(/\r?\n/).slice(-maxLines);
  return lines.some(line => line.trim()) ? lines.join("\n") : "No screen is recorded for this agent.";
}

export type TeamWatchCommand = "logs" | "summary" | "board" | "next" | "prev" | "ask" | "detach" | "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "enter" | "follow" | "openMember";

const keySequences: [string, TeamWatchCommand][] = [
  ["\u001b[A", "up"], ["\u001bOA", "up"], ["\u001b[B", "down"], ["\u001bOB", "down"],
  ["\u001b[C", "next"], ["\u001bOC", "next"], ["\u001b[D", "prev"], ["\u001bOD", "prev"],
  ["\u001b[5~", "pageUp"], ["\u001b[6~", "pageDown"],
  ["\u001b[H", "top"], ["\u001bOH", "top"], ["\u001b[1~", "top"], ["\u001b[F", "bottom"], ["\u001bOF", "bottom"], ["\u001b[4~", "bottom"],
];
const keys: Record<string, TeamWatchCommand> = {
  l: "logs", s: "summary", b: "board", n: "next", p: "prev", a: "ask", q: "detach",
  j: "down", k: "up", " ": "pageDown", g: "top", G: "bottom",
  "\r": "enter", "\n": "enter", f: "follow", o: "openMember",
};

export function teamWatchCommand(chunk: string): TeamWatchCommand | null {
  let action: TeamWatchCommand | null = null;
  const text = String(chunk);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\u0003") return "detach";
    const sequence = keySequences.find(([bytes]) => text.startsWith(bytes, index));
    if (sequence) { action = sequence[1]; index += sequence[0].length - 1; continue; }
    if (text[index] === "\u001b") continue;
    action = keys[text[index]!] ?? action;
  }
  return action;
}

function clock(iso: unknown) {
  const time = Date.parse(String(iso ?? ""));
  return Number.isNaN(time) ? short(iso, 24) : new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function teamLogsText(team: any, agents: any[], member: any, screen: unknown, events: { at?: string; text?: string }[], checkedAt = "", interactive = false, width = 80): string {
  const place = Math.max(0, agents.findIndex(item => item?.memberId === member?.memberId));
  const lines = teamHeading(team, `review logs · agent ${place + 1} of ${Math.max(agents.length, 1)}`);
  const strip = agents.slice(0, 8).map(item => {
    const name = `${roleNames[item?.role] ?? short(item?.role, 24)} ${clean(item?.status)}${item?.revision === team?.revision ? "" : ` r${clean(item?.revision)}`}`;
    return item?.memberId === member?.memberId ? `[${name}]` : ` ${name} `;
  });
  if (agents.length > 8) strip.push(` +${agents.length - 8} more`);
  lines.push("", `  ${strip.join("  ")}`.slice(0, Math.max(1, width)));
  const role = roleNames[member?.role] ?? short(member?.role, 24);
  const memberFlags = [member?.stalledAt ? "stalled" : "", member?.spinnerOnlySince ? "spinner-only" : ""].filter(Boolean);
  lines.push("", `${role.toUpperCase()} · ${clean(member?.status)} · ${short(member?.title, 120)}${member?.taskId ? ` · ${short(member.taskId, 40)}` : ""}${memberFlags.length ? ` · ${memberFlags.join(" · ")}` : ""}`);
  if (member?.stoppedReason) lines.push(`Stopped: ${short(member.stoppedReason, 240)}`);
  lines.push("", "SCREEN", visibleScreen(screen));
  const recent = events.filter(event => clean(event.text).trim()).slice(-8);
  lines.push("", "RECENT EVENTS");
  if (recent.length) for (const event of recent) lines.push(`  ${clock(event.at)}  ${short(event.text, 300)}`);
  else lines.push("  No recent control events.");
  const keys = `${agents.length > 1 ? "←→ agent · " : ""}b board · s summary · q quit`;
  const tail = interactive ? keys : `Summary: infinite team status ${clean(team?.id)}`;
  lines.push("", checkedAt ? `${clean(checkedAt)} · ${tail}` : tail);
  return lines.join("\n");
}

export function wrapText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width) || 80);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= columns) { out.push(line); continue; }
    const marker = /^(\s*(?:[•+]|\d+\.|Ask:|Options:)?\s*)/.exec(line)?.[1] ?? "";
    const hang = " ".repeat(Math.min(marker.length, Math.floor(columns / 2)));
    let current = "";
    let prefix = "";
    for (const word of line.slice(marker.length).split(/(\s+)/)) {
      if (!word) continue;
      const lead = current ? current : prefix || marker;
      if ((lead + word).length <= columns) { current = lead + word; continue; }
      if (current.trim()) out.push(current.trimEnd());
      prefix = hang;
      let rest = word.trimStart();
      while (prefix.length + rest.length > columns) { out.push(prefix + rest.slice(0, columns - prefix.length)); rest = rest.slice(columns - prefix.length); }
      current = rest ? prefix + rest : "";
    }
    if (current.trim()) out.push(current.trimEnd());
  }
  return out;
}

const heading = /^(?:[A-Z][A-Z ]+[A-Z])(?= \(\d+\)$| · |$)/;

export function teamWatchScreen(text: string, { rows, columns, offset, color, status = "" }: { rows: number; columns: number; offset: number; color: boolean; status?: string }) {
  const all = text.split("\n");
  const footer = all.pop() ?? "";
  while (all.length && !all[all.length - 1]!.trim()) all.pop();
  const width = Math.max(1, columns || 80);
  const body = wrapText(all.join("\n"), width);
  const visible = Math.max(0, Math.max(3, rows || 24) - 3);
  const maxOffset = Math.max(0, body.length - visible);
  const start = Math.min(Math.max(0, offset), maxOffset);
  const shown = body.slice(start, start + visible);
  const scroll = maxOffset ? ` · ↑↓ scroll ${start + 1}-${start + shown.length} of ${body.length}` : "";
  const bar = `${footer}${scroll}`.slice(0, width);
  const paint = (line: string, index: number) => !color ? line
    : index + start === 0 ? `\x1b[1m${line}\x1b[0m`
    : line.startsWith("DECISIONS FOR YOU") ? `\x1b[1;33m${line}\x1b[0m`
    : heading.test(line) ? `\x1b[1m${line}\x1b[0m`
    : line;
  const statusLine = status.slice(0, width);
  const lines = [...shown.map(paint), ...Array(Math.max(0, visible - shown.length)).fill(""), "", statusLine, color ? `\x1b[7m${bar.padEnd(width)}\x1b[0m` : bar];
  return { frame: `\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}`, offset: start, page: Math.max(1, visible - 1) };
}
