import { PROVIDER_NAMES, type Attention, type Prompt, type Provider } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PushSender, PushStore } from "./push.js";

type Row = { id: string; title: string; provider: Provider; attention: Attention; reading?: { now?: { text: string } } };
type TeamRow = { id: string; title: string; status: string; reason?: string; resumable?: boolean; goal?: boolean; mission?: boolean };
/** Who a team member's open prompt waits on: the run's delegated coordinator, the owner, or a review the run has not started yet. */
export type PromptOwner = "coordinator" | "user" | "undecided";
type Teams = { statuses(): TeamRow[]; promptOwner?(sessionId: string, prompt: Prompt): PromptOwner };
type GoalRow = { id: string; title: string; status: string; reason?: string };
type Lifecycle = { id: string; title: string; status: string; reason?: string; resumable?: boolean; kind: "goal" | "team"; event: string; titleText: string; body: string; priority: "default" | "high" };
type StorageVolume = { label: string; path: string; fullness: number; availableInodes: number; availableBytes: number; fullnessBy?: "bytes" | "inodes" };
type StorageAlert = { label: string; fullness: number; availableInodes: number; availableBytes: number; fullnessBy: "bytes" | "inodes"; critical: boolean };
type StorageCrossing = { previous: number; warningArmed: boolean; criticalArmed: boolean };
const PUSH_STATES = new Set(["needs-you", "turn-finished", "exited", "recording-error"]);
/** How long a delegated run may take to pick a member's prompt up for review before the owner hears about it. */
const REVIEW_START_GRACE_MS = 45_000;
/** A review window is five minutes; a prompt held longer than this reaches the owner even if the run never settled it. */
const REVIEW_HOLD_LIMIT_MS = 8 * 60_000;
const REMOVED_LIMIT = 1024;
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
  /** Needs-you prompts held back because the run's coordinator may answer them, by session id. */
  private deferred = new Map<string, { key: string; since: number }>();
  private teamStatus = new Map<string, string>();
  private goalStatus = new Map<string, string>();
  private recentlyRemoved = new Map<string, string>();
  private primed = false;
  private teamsPrimed = false;
  private goalsPrimed = false;
  private storageStatus = new Map<string, StorageCrossing>();
  private lastStorageEvaluationAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly manager: Pick<Manager, "list">,
    private readonly store: PushStore,
    private readonly sender: PushSender,
    private readonly options: { detail: "minimal" | "full"; events: string[]; intervalMs: number; machineId?: string; reviewGraceMs?: number; reviewHoldLimitMs?: number },
    private readonly teams?: Teams,
    private readonly goals?: { statuses(): GoalRow[] },
    private readonly storage?: { sample(): Promise<StorageVolume[]> },
  ) {}
  /** Lifecycle baselines are taken now, synchronously, so a change during the first interval is not absorbed as startup state. */
  start() { this.teamEvents(); this.goalEvents(); this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    const due: Row[] = [];
    try {
      const rows = (await this.manager.list()) as unknown as Row[];
      const now = Date.now();
      for (const row of rows) {
        const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
        const previous = this.previous("session", row.id, this.seen);
        this.seen.set(row.id, key);
        const held = this.deferred.get(row.id);
        if (held && held.key !== key) this.deferred.delete(row.id);
        if (this.primed && previous !== key && PUSH_STATES.has(row.attention.state) && this.options.events.includes(row.attention.state)) {
          if (this.promptOwner(row) !== "user") { this.deferred.set(row.id, { key, since: now }); continue; }
          due.push(row);
        } else if (held && held.key === key) {
          // A held prompt reaches the owner once it is theirs: the coordinator escalated it, the
          // run never started a review in time, or the hold outlived any possible review.
          const owner = this.promptOwner(row);
          const heldFor = now - held.since;
          if (owner === "user" || (owner === "undecided" && heldFor >= (this.options.reviewGraceMs ?? REVIEW_START_GRACE_MS)) ||
              heldFor >= (this.options.reviewHoldLimitMs ?? REVIEW_HOLD_LIMIT_MS)) {
            this.deferred.delete(row.id);
            due.push(row);
          }
        }
      }
      this.prune("session", this.seen, new Set(rows.map(row => row.id)));
      // A session missing from one listing keeps its hold, so a prompt that comes back unchanged
      // can still reach the owner; the hold limit bounds how long an absent session is remembered.
      for (const [id, held] of this.deferred) if (!this.seen.has(id) && now - held.since >= (this.options.reviewHoldLimitMs ?? REVIEW_HOLD_LIMIT_MS)) this.deferred.delete(id);
      this.primed = true;
    } catch {}
    const lifecycle = [...this.teamEvents(), ...this.goalEvents()];
    const storageDue = await this.storageEvents(Date.now());
    if (!due.length && !lifecycle.length && !storageDue.length) return;
    const devices = this.store.list();
    if (!devices.length) return;
    const messages = [
      ...due.flatMap((row) => devices.map((d) => this.message(row, d.token))),
      ...lifecycle.flatMap((item) => devices.map((d) => this.lifecycleMessage(item, d.token))),
      ...storageDue.flatMap((item) => devices.map((d) => this.storageMessage(item, d.token))),
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
  private async storageEvents(now: number): Promise<StorageAlert[]> {
    if (!this.storage || !this.enabled("host-storage") || (this.lastStorageEvaluationAt !== undefined && now - this.lastStorageEvaluationAt < 60_000)) return [];
    this.lastStorageEvaluationAt = now;
    let volumes: StorageVolume[];
    try { volumes = await this.storage.sample(); } catch { return []; }
    const due: StorageAlert[] = [];
    for (const volume of volumes) {
      if (![volume.fullness, volume.availableInodes, volume.availableBytes].every(Number.isFinite)) continue;
      const fullnessBy = volume.fullnessBy ?? "inodes";
      const previous = this.storageStatus.get(volume.label);
      if (!previous) {
        // Tell the owner once at startup when a volume is already high; choose its current severity and do not emit both crossings.
        const critical = volume.fullness >= 0.95;
        if (critical || volume.fullness >= 0.85) due.push({ ...volume, fullnessBy, critical });
        this.storageStatus.set(volume.label, { previous: volume.fullness, warningArmed: volume.fullness < 0.85, criticalArmed: volume.fullness < 0.95 });
        continue;
      }
      let { warningArmed, criticalArmed } = previous;
      if (volume.fullness < 0.80) { warningArmed = true; criticalArmed = true; }
      else {
        if (warningArmed && previous.previous < 0.85 && volume.fullness >= 0.85) {
          due.push({ ...volume, fullnessBy, critical: false }); warningArmed = false;
        }
        if (criticalArmed && previous.previous < 0.95 && volume.fullness >= 0.95) {
          due.push({ ...volume, fullnessBy, critical: true }); criticalArmed = false;
        }
      }
      this.storageStatus.set(volume.label, { previous: volume.fullness, warningArmed, criticalArmed });
    }
    return due;
  }
  private storageMessage(item: StorageAlert, to: string) {
    const count = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(Math.round(value));
    const gigabytes = (value: number) => `${(value / 1024 ** 3).toFixed(0)} GB`;
    return {
      to, title: item.critical ? "Host storage critical" : "Host storage low",
      body: `${item.label} volume is ${Math.round(item.fullness * 100)}% full by ${item.fullnessBy}; ${count(item.availableInodes)} inodes and ${gigabytes(item.availableBytes)} free. New runs stop at the floor.`,
      data: { url: "/machine", ...(this.options.machineId ? { machineId: this.options.machineId } : {}) },
      channelId: "attention" as const, priority: item.critical ? "high" as const : "default" as const, collapseId: `storage:${item.label}`,
    };
  }
  /** A team member's open permission prompt is the owner's unless its run can still decide it. Everything else is always the owner's. */
  private promptOwner(row: Row): PromptOwner {
    const prompt = row.attention.prompt;
    if (row.attention.state !== "needs-you" || !prompt || !this.teams?.promptOwner) return "user";
    try { return this.teams.promptOwner(row.id, prompt); } catch { return "user"; }
  }
  private teamEvents(): Lifecycle[] {
    if (!this.teams) return [];
    let teams: TeamRow[];
    try { teams = this.teams.statuses(); } catch { return []; }
    const due = this.lifecycle("team", teams, this.teamStatus, this.teamsPrimed, TEAM_EVENTS, "Team started");
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
      const previous = this.previous(kind, row.id, statuses);
      statuses.set(row.id, row.status);
      if (!primed || previous === row.status || (kind === "team" && (row.goal || row.mission))) continue;
      const base = { id: row.id, title: row.title, status: row.status, reason: row.reason, resumable: row.resumable, kind };
      if (previous === undefined && this.enabled(`${kind}-started`))
        due.push({ ...base, event: `${kind}-started`, titleText: startedTitle, body: "started", priority: "default" });
      const category = map[row.status];
      if (category && this.enabled(category.event)) due.push({ ...base, event: category.event, titleText: category.title, body: category.body, priority: category.priority });
    }
    this.prune(kind, statuses, new Set(rows.map(row => row.id)));
    return due;
  }
  private previous(kind: "session" | "goal" | "team", id: string, statuses: Map<string, string>) {
    const previous = statuses.get(id);
    if (previous !== undefined) return previous;
    const key = `${kind}:${id}`;
    const removed = this.recentlyRemoved.get(key);
    this.recentlyRemoved.delete(key);
    return removed;
  }
  private prune(kind: "session" | "goal" | "team", statuses: Map<string, string>, listed: Set<string>) {
    for (const [id, status] of statuses) {
      if (listed.has(id)) continue;
      statuses.delete(id);
      const key = `${kind}:${id}`;
      this.recentlyRemoved.delete(key);
      this.recentlyRemoved.set(key, status);
    }
    while (this.recentlyRemoved.size > REMOVED_LIMIT) {
      const oldest = this.recentlyRemoved.keys().next().value;
      if (oldest === undefined) break;
      this.recentlyRemoved.delete(oldest);
    }
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
      to, title, body: this.options.detail === "full" ? (row.attention.state === "turn-finished" ? row.reading?.now?.text : undefined) || row.attention.now || minimal : minimal,
      data: { url: `/session/${row.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: row.attention.state === "needs-you" ? ("high" as const) : ("default" as const), collapseId: row.id,
    };
  }
}
