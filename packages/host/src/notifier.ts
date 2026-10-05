import { PROVIDER_NAMES, type Attention, type Provider } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PushSender, PushStore } from "./push.js";

type Row = { id: string; title: string; provider: Provider; attention: Attention };
const PUSH_STATES = new Set(["needs-you", "turn-finished", "exited", "recording-error"]);

export class Notifier {
  private seen = new Map<string, string>();
  private primed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly manager: Pick<Manager, "list">,
    private readonly store: PushStore,
    private readonly sender: PushSender,
    private readonly options: { detail: "minimal" | "full"; events: string[]; intervalMs: number },
  ) {}
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), this.options.intervalMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    const rows = (await this.manager.list()) as unknown as Row[];
    const due: Row[] = [];
    for (const row of rows) {
      const key = `${row.attention.state}:${row.attention.prompt?.id ?? ""}`;
      const previous = this.seen.get(row.id);
      this.seen.set(row.id, key);
      if (!this.primed || previous === key) continue;
      if (PUSH_STATES.has(row.attention.state) && this.options.events.includes(row.attention.state)) due.push(row);
    }
    this.primed = true;
    if (!due.length) return;
    const devices = this.store.list();
    if (!devices.length) return;
    const messages = due.flatMap((row) => devices.map((d) => this.message(row, d.token)));
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
      data: { url: `/session/${row.id}` }, channelId: "attention" as const,
      priority: row.attention.state === "needs-you" ? ("high" as const) : ("default" as const), collapseId: row.id,
    };
  }
}
