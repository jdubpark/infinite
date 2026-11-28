import { PROVIDER_NAMES, type Attention, type Prompt, type Provider } from "@infinite/attention";
import { publicAttention, type Manager } from "./manager.js";
import type { PushSender, PushStore } from "./push.js";
import type { FuseService, FuseInterrupt } from "./fuse/service.js";
import type { MainCheckNotice, MainCheckService } from "./main-check.js";
import type { PermissionDeliveryService } from "./permission-agent-types.js";
import { INTERRUPT_CLASSES, type InterruptClass } from "./permission-policy.js";
import type { AutonomyMode } from "./autonomy.js";
import { isEvalSession, type ExecutionIdentity, type SessionPurpose } from "./types.js";
import { createHash } from "node:crypto";

const fuseSubject = (projectId: string | undefined) =>
  projectId === undefined ? "host" : projectId.length <= 40 ? projectId : createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 32);

type Row = {
  id: string; title: string; provider: Provider; attention: Attention; reading?: { now?: { text: string } }; purpose?: SessionPurpose; executionIdentity?: ExecutionIdentity;
  permissionChannel?: { waiting?: { interruptClass: string }; notice?: { id: string; interruptClass?: string } };
  permissionNotice?: true;
};
type TeamRow = { id: string; title: string; status: string; reason?: string; resumable?: boolean; goal?: boolean; mission?: boolean; autonomy?: AutonomyMode };
export type PromptOwner = "coordinator" | "user" | "undecided";
type Teams = { statuses(): TeamRow[]; promptOwner?(sessionId: string, prompt: Prompt): PromptOwner };
type GoalRow = { id: string; title: string; status: string; reason?: string; autonomy?: AutonomyMode };
type Lifecycle = { id: string; title: string; status: string; reason?: string; resumable?: boolean; kind: "goal" | "team"; event: string; titleText: string; body: string; priority: "default" | "high" };
type StorageVolume = { label: string; path: string; fullness: number; availableInodes: number; availableBytes: number; fullnessBy?: "bytes" | "inodes" };
type StorageAlert = { label: string; fullness: number; availableInodes: number; availableBytes: number; fullnessBy: "bytes" | "inodes"; critical: boolean };
type StorageCrossing = { previous: number; warningArmed: boolean; criticalArmed: boolean };

export function promptOwner(
  row: Pick<Row, "id" | "attention">,
  permissions?: Pick<PermissionDeliveryService, "holder">,
  teams?: Pick<Teams, "promptOwner">,
): PromptOwner {
  const prompt = row.attention.prompt;
  if (row.attention.state !== "needs-you" || !prompt) return "user";
  let holder: "agent" | "owner" | "undecided" = "owner";
  if (permissions) try { holder = permissions.holder(row.id, prompt.id); } catch {}
  if (holder !== "owner") return holder === "agent" ? "coordinator" : "undecided";
  if (!teams?.promptOwner) return "user";
  try { return teams.promptOwner(row.id, prompt); } catch { return "user"; }
}

const PUSH_STATES = new Set(["needs-you", "turn-finished", "exited", "recording-error"]);
const REVIEW_START_GRACE_MS = 45_000;
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
  private notices = new Map<string, string>();
  private noticesPrimed = false;
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
    private readonly options: { detail: "minimal" | "full"; events: string[]; intervalMs: number; machineId?: string; reviewGraceMs?: number; reviewHoldLimitMs?: number; quietAutonomous?: boolean },
    private readonly teams?: Teams,
    private readonly goals?: { statuses(): GoalRow[] },
    private readonly storage?: { sample(): Promise<StorageVolume[]> },
    private readonly fuse?: Pick<FuseService, "interrupts" | "markAnnounced">,
    private readonly permissions?: Pick<PermissionDeliveryService, "holder" | "ownerClass">,
    private readonly mainCheck?: Pick<MainCheckService, "notices" | "accepted">,
  ) {}
  private fuseRetryAt = 0;
  private monotonic = () => performance.now();
  start() { this.teamEvents(); this.goalEvents(); this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    const due: Row[] = [];
    try {
      const rows = ((await this.manager.list({ includeFullMessage: true })) as unknown as Row[]).filter(row => !isEvalSession(row));
      const now = Date.now();
      const redact = (row: Row): Row => ({ ...row, attention: publicAttention(row.attention) });
      for (const row of rows) {
        const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
        const previous = this.previous("session", row.id, this.seen);
        this.seen.set(row.id, key);
        const held = this.deferred.get(row.id);
        if (held && held.key !== key) this.deferred.delete(row.id);
        if (this.primed && previous !== key && PUSH_STATES.has(row.attention.state) && this.options.events.includes(row.attention.state)) {
          if (this.promptOwner(row) !== "user") { this.deferred.set(row.id, { key, since: now }); continue; }
          due.push(redact(row));
        } else if (held && held.key === key) {
          const owner = this.promptOwner(row);
          const heldFor = now - held.since;
          if (owner === "user" || (owner === "undecided" && heldFor >= (this.options.reviewGraceMs ?? REVIEW_START_GRACE_MS)) ||
              heldFor >= (this.options.reviewHoldLimitMs ?? REVIEW_HOLD_LIMIT_MS)) {
            this.deferred.delete(row.id);
            due.push(redact(row));
          }
        }
      }
      due.push(...this.channelNotices(rows).map(redact));
      this.prune("session", this.seen, new Set(rows.map(row => row.id)));
      for (const [id, held] of this.deferred) if (!this.seen.has(id) && now - held.since >= (this.options.reviewHoldLimitMs ?? REVIEW_HOLD_LIMIT_MS)) this.deferred.delete(id);
      this.primed = true;
    } catch {}
    const lifecycle = [...this.teamEvents(), ...this.goalEvents()];
    const storageDue = await this.storageEvents(Date.now());
    const fuseDue = this.fuseEvents();
    const mainCheckDue = this.mainCheckEvents();
    if (!due.length && !lifecycle.length && !storageDue.length && !fuseDue.length && !mainCheckDue.length) return;
    const devices = this.store.list();
    if (!devices.length) return;
    const messages = [
      ...due.flatMap((row) => devices.map((d) => this.message(row, d.token))),
      ...lifecycle.flatMap((item) => devices.map((d) => this.lifecycleMessage(item, d.token))),
      ...storageDue.flatMap((item) => devices.map((d) => this.storageMessage(item, d.token))),
      ...mainCheckDue.flatMap((item) => devices.map((d) => this.mainCheckMessage(item, d.token))),
      ...fuseDue.flatMap((item) => devices.map((d) => this.fuseMessage(item, d.token))),
    ];
    const mainFirst = messages.length - (mainCheckDue.length + fuseDue.length) * devices.length;
    let tickets: Awaited<ReturnType<PushSender>>;
    try {
      tickets = await this.sender(messages);
    } catch (error) {
      console.warn(`push: sender failed (${(error as Error).name})`);
      return;
    }
    mainCheckDue.forEach((item, index) => {
      const reached = devices.some((_device, device) => tickets[mainFirst + index * devices.length + device]?.status === "ok");
      if (reached) this.mainCheck?.accepted(item.projectId, item.notice, item.outcome);
    });
    if (fuseDue.length) {
      const first = messages.length - fuseDue.length * devices.length;
      const reached = fuseDue.filter((_item, index) =>
        devices.some((_device, device) => tickets[first + index * devices.length + device]?.status === "ok"));
      if (reached.length) this.fuse?.markAnnounced(reached.map((item) => item.tripId));
      if (reached.length < fuseDue.length) this.fuseRetryAt = this.monotonic() + 60_000;
    }
    const failures = new Set<string>();
    tickets.forEach((ticket, i) => {
      if (ticket.status !== "error") return;
      if (ticket.details?.error === "DeviceNotRegistered") this.store.remove(messages[i].to);
      else failures.add(ticket.details?.error ?? ticket.message ?? "error");
    });
    if (failures.size) console.warn(`push: ${[...failures].join(", ")}`);
  }
  private mainCheckEvents(): MainCheckNotice[] {
    if (!this.mainCheck || !this.enabled("main-check")) return [];
    try { return this.mainCheck.notices(); } catch { return []; }
  }
  private mainCheckMessage(item: MainCheckNotice, to: string) {
    const { summary } = item;
    const head = summary.head.slice(0, 7);
    const text = summary.outcome === "passed"
      ? { title: "Main passes again", body: `all ${summary.expected} checks passed at ${head}.` }
      : { title: "Main is failing", body: summary.failed
        ? `check ${summary.failed.index} of ${summary.expected} ${summary.failed.exitCode === null ? "exited with no exit code" : `exited ${summary.failed.exitCode}`} at ${head}.`
        : `a check failed at ${head}.` };
    return {
      to, title: text.title, body: `${item.label}: ${text.body}`,
      data: { url: "/teams", ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: "default" as const, collapseId: `main-check:${fuseSubject(item.projectId)}`,
    };
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
  private fuseEvents(): FuseInterrupt[] {
    if (!this.fuse || !this.enabled("autonomy-interrupt") || this.monotonic() < this.fuseRetryAt) return [];
    try { return this.fuse.interrupts(); } catch { return []; }
  }
  private fuseMessage(item: FuseInterrupt, to: string) {
    const cause = item.cause === "unmeasurable" ? "its launch record cannot be read"
      : item.cause === "write-failed" ? "it cannot record a launch" : "it reached its launch limit for the last hour";
    const closing = item.cause === "unmeasurable" ? "It closes once the record can be read."
      : item.cause === "write-failed" ? "Launches resume once the host can write its state again."
      : item.ownerClose ? "It stays open until you close it." : "It closes on its own as launches leave the last hour.";
    return {
      to, title: "Spend fuse open", body: `Launches paused for ${item.label}: ${cause}. ${closing}`,
      data: { url: "/teams", ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: "high" as const, collapseId: `interrupt:fuse:${fuseSubject(item.projectId)}`,
    };
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
  private promptOwner(row: Row): PromptOwner {
    return promptOwner(row, this.permissions, this.teams);
  }
  private ownerClass(row: Row): InterruptClass | undefined {
    const prompt = row.attention.prompt;
    if (row.attention.state !== "needs-you" || !prompt || !this.permissions?.ownerClass) return undefined;
    let named: unknown;
    try { named = this.permissions.ownerClass(row.id, prompt.id); } catch { return undefined; }
    return (INTERRUPT_CLASSES as readonly unknown[]).includes(named) ? named as InterruptClass : undefined;
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
  private lifecycle(kind: "goal" | "team", rows: (TeamRow | GoalRow)[], statuses: Map<string, string>, primed: boolean, map: typeof TEAM_EVENTS, startedTitle: string) {
    const due: Lifecycle[] = [];
    for (const row of rows) {
      const previous = this.previous(kind, row.id, statuses);
      statuses.set(row.id, row.status);
      if (!primed || previous === row.status || (kind === "team" && ((row as TeamRow).goal || (row as TeamRow).mission))) continue;
      const quiet = this.options.quietAutonomous === true && row.autonomy === "autonomous";
      const base = { id: row.id, title: row.title, status: row.status, reason: row.reason, resumable: (row as TeamRow).resumable, kind };
      if (!quiet && previous === undefined && this.enabled(`${kind}-started`))
        due.push({ ...base, event: `${kind}-started`, titleText: startedTitle, body: "started", priority: "default" });
      const category = map[row.status];
      if (category && (!quiet || category.priority === "high") && this.enabled(category.event))
        due.push({ ...base, event: category.event, titleText: category.title, body: category.body, priority: category.priority });
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
  private channelNotices(rows: Row[]): Row[] {
    const due: Row[] = [];
    for (const row of rows) {
      const notice = row.permissionChannel?.notice;
      if (!notice || this.notices.get(row.id) === notice.id) continue;
      this.notices.set(row.id, notice.id);
      if (this.noticesPrimed && this.options.events.includes("needs-you")) due.push({ ...row, permissionNotice: true });
    }
    const listed = new Set(rows.map(row => row.id));
    for (const id of this.notices.keys()) if (!listed.has(id)) this.notices.delete(id);
    this.noticesPrimed = true;
    return due;
  }
  private message(row: Row, to: string) {
    const name = PROVIDER_NAMES[row.provider] ?? row.provider;
    const channel = row.permissionChannel;
    if (row.permissionNotice) {
      const named = channel?.notice?.interruptClass ? ` (${channel.notice.interruptClass})` : "";
      return {
        to, title: "Call denied: needs you", body: `${name} in ${row.title} made a call${named} that needs your own answer. It was denied and can be asked again.`,
        data: { url: `/session/${row.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
        priority: "high" as const, collapseId: `${row.id}:permission`,
      };
    }
    if (row.attention.state === "needs-you" && channel?.waiting) {
      const minimal = `${name} waits for your answer in ${row.title} (${channel.waiting.interruptClass})`;
      return {
        to, title: "Needs your answer", body: minimal,
        data: { url: `/session/${row.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
        priority: "high" as const, collapseId: row.id,
      };
    }
    const [title, minimal] =
      row.attention.state === "needs-you"
        ? row.attention.prompt?.kind === "question" ? ["Question for you", `${name} asked a question in ${row.title}`] : ["Needs your approval", `${name} needs your approval in ${row.title}`]
        : row.attention.state === "turn-finished" ? ["Turn finished", `${row.title} finished a turn`]
        : row.attention.state === "exited" ? ["Session exited", `${row.title} exited`]
        : ["Recording stopped", `${row.title} stopped recording`];
    const body = this.options.detail === "full" ? (row.attention.state === "turn-finished" ? row.reading?.now?.text : undefined) || row.attention.now || minimal : minimal;
    const interrupt = this.ownerClass(row);
    return {
      to, title, body: interrupt ? `${body} (${interrupt})` : body,
      data: { url: `/session/${row.id}`, ...(this.options.machineId ? { machineId: this.options.machineId } : {}) }, channelId: "attention" as const,
      priority: row.attention.state === "needs-you" ? ("high" as const) : ("default" as const), collapseId: row.id,
    };
  }
}
