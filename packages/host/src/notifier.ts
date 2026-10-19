import { PROVIDER_NAMES, type Attention, type Provider } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PushSender, PushStore } from "./push.js";

type Row = { id: string; title: string; provider: Provider; attention: Attention };
type TeamRow = { id: string; title: string; status: string; reason?: string; resumable?: boolean; goal?: boolean };
type GoalRow = { id: string; title: string; status: string; reason?: string };
type Lifecycle = { id: string; title: string; status: string; reason?: string; resumable?: boolean; kind: "goal" | "team"; event: string; titleText: string; body: string; priority: "default" | "high" };
const PUSH_STATES = new Set(["needs-you", "turn-finished", "exited", "recording-error"]);
const GOAL_EVENTS: Record<string, { event: string; title: string; body: string; priority: "default" | "high" }> = {
  achieved: { event: "goal-finished", title: "Goal finished", body: "finished", priority: "default" },
  "ready-for-review": { event: "goal-finished", title: "Goal finished", body: "finished", priority: "default" },
  "no-opportunity": { event: "goal-finished", title: "Goal finished", body: "finished", priority: "default" },
  "needs-input": { event: "goal-stuck", title: "Goal needs you", body: "is waiting for you.", priority: "high" },
  blocked: { event: "goal-stuck", title: "Goal needs you", body: "is blocked and waiting for you.", priority: "high" },
  "limit-reached": { event: "goal-stuck", title: "Goal needs you", body: "reached its limit and needs you.", priority: "high" },
  cancelled: { event: "goal-cancelled", title: "Goal cancelled", body: "was cancelled", priority: "default" },
};
const TEAM_EVENTS: Record<string, { event: string; title: string; body: string; priority: "default" | "high" }> = {
  "ready-for-review": { event: "team-finished", title: "Team finished", body: "finished", priority: "default" },
  merged: { event: "team-finished", title: "Team finished", body: "finished", priority: "default" },
  "no-change": { event: "team-finished", title: "Team finished", body: "finished", priority: "default" },
  "needs-input": { event: "team-stuck", title: "Team needs you", body: "is waiting for you.", priority: "high" },
  blocked: { event: "team-stuck", title: "Team needs you", body: "is blocked and waiting for you.", priority: "high" },
  cancelled: { event: "team-cancelled", title: "Team cancelled", body: "was cancelled", priority: "default" },
};

export class Notifier {
  private seen = new Map<string, string>();
  private teamStatus = new Map<string, string>();
  private goalStatus = new Map<string, string>();
  private primed = false;
  private teamsPrimed = false;
  private goalsPrimed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly manager: Pick<Manager, "list">,
    private readonly store: PushStore,
    private readonly sender: PushSender,
    private readonly options: { detail: "minimal" | "full"; events: string[]; intervalMs: number; machineId?: string },
    private readonly teams?: { statuses(): TeamRow[] },
    private readonly goals?: { statuses(): GoalRow[] },
  ) {}
  /** Lifecycle baselines are taken now, synchronously, so a change during the first interval is not absorbed as startup state. */
  start() { this.teamEvents(); this.goalEvents(); this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    const due: Row[] = [];
    try {
      const rows = (await this.manager.list()) as unknown as Row[];
      for (const row of rows) {
        const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
        const previous = this.seen.get(row.id);
        this.seen.set(row.id, key);
        if (this.primed && previous !== key && PUSH_STATES.has(row.attention.state) && this.options.events.includes(row.attention.state)) due.push(row);
      }
      this.primed = true;
    } catch {}
    const lifecycle = [...this.teamEvents(), ...this.goalEvents()];
    if (!due.length && !lifecycle.length) return;
    const devices = this.store.list();
    if (!devices.length) return;
    const messages = [
      ...due.flatMap((row) => devices.map((d) => this.message(row, d.token))),
      ...lifecycle.flatMap((item) => devices.map((d) => this.lifecycleMessage(item, d.token))),
    ];
    let tickets: Awaited<ReturnType<PushSender>>;
    try {
      tickets = await this.sender(messages);
    } catch (error) {
      console.warn(`push: sender failed (${(error as Error).name})`);
      return;
    }
    const failures = new Set<string>();
    tickets.forEach((ticket, i) => {
      if (ticket.status !== "error") return;
      if (ticket.details?.error === "DeviceNotRegistered") this.store.remove(messages[i].to);
      else failures.add(ticket.details?.error ?? ticket.message ?? "error");
    });
    if (failures.size) console.warn(`push: ${[...failures].join(", ")}`);
  }
  private teamEvents(): Lifecycle[] {
    if (!this.teams) return [];
    let teams: TeamRow[];
    try { teams = this.teams.statuses(); } catch { return []; }
    const due = this.lifecycle("team", teams.filter(team => !team.goal), this.teamStatus, this.teamsPrimed, TEAM_EVENTS, "Team started");
    // Goal-owned runs still record their status so they never announce as new later.
    for (const team of teams) if (team.goal) this.teamStatus.set(team.id, team.status);
    this.teamsPrimed = true;
    return due;
  }
  private goalEvents(): Lifecycle[] {
    if (!this.goals) return [];
    let goals: GoalRow[];
    try { goals = this.goals.statuses(); } catch { return []; }
    const due = this.lifecycle("goal", goals, this.goalStatus, this.goalsPrimed, GOAL_EVENTS, "Goal started");
    this.goalsPrimed = true;
    return due;
  }
  /** A record first seen after priming announces its start and, if it is already stuck or done, that status too. */
  private lifecycle(kind: "goal" | "team", rows: TeamRow[], statuses: Map<string, string>, primed: boolean, map: typeof TEAM_EVENTS, startedTitle: string) {
    const due: Lifecycle[] = [];
    for (const row of rows) {
      const previous = statuses.get(row.id);
      statuses.set(row.id, row.status);
      if (!primed || previous === row.status) continue;
      const base = { id: row.id, title: row.title, status: row.status, reason: row.reason, resumable: row.resumable, kind };
      if (previous === undefined && this.enabled(`${kind}-started`))
        due.push({ ...base, event: `${kind}-started`, titleText: startedTitle, body: "started", priority: "default" });
      const category = map[row.status];
      if (category && this.enabled(category.event)) due.push({ ...base, event: category.event, titleText: category.title, body: category.body, priority: category.priority });
    }
    return due;
  }
  private enabled(event: string) { return this.options.events.includes(event) || (event === "team-stuck" && this.options.events.includes("team-blocked")); }
  private lifecycleMessage(item: Lifecycle, to: string) {
    let body = `${item.title} ${item.body}`;
    if (this.options.detail === "full" && item.reason && (item.event.endsWith("finished") || item.event.endsWith("stuck"))) body = `${item.title}: ${item.reason}${item.kind === "team" && item.status === "blocked" && item.resumable ? " It can resume." : ""}`;
    else if (item.kind === "team" && item.status === "blocked" && item.resumable) body += " It can resume.";
    return { to, title: item.titleText, body,
      data: { url: `/${item.kind}/${item.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: item.priority, collapseId: `${item.kind}:${item.id}` };
  }
  private message(row: Row, to: string) {
    const name = PROVIDER_NAMES[row.provider] ?? row.provider;
    const [title, minimal] =
      row.attention.state === "needs-you"
        ? row.attention.prompt?.kind === "question" ? ["Question for you", `${name} asked a question in ${row.title}`] : ["Needs your approval", `${name} needs your approval in ${row.title}`]
        : row.attention.state === "turn-finished" ? ["Turn finished", `${row.title} finished a turn`]
        : row.attention.state === "exited" ? ["Session exited", `${row.title} exited`]
        : ["Recording stopped", `${row.title} stopped recording`];
    return {
      to, title, body: this.options.detail === "full" ? row.attention.now || minimal : minimal,
      data: { url: `/session/${row.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: row.attention.state === "needs-you" ? ("high" as const) : ("default" as const), collapseId: row.id,
    };
  }
}
