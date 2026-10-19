import { readFileSync } from "node:fs";
import type { UsageConfig } from "./config.js";
import type { Balance } from "./usage-api.js";

const refreshMs = 15 * 60_000, forcedMs = 60_000;
export class BalanceService {
  private readonly keys = new Map<string, string>();
  private readonly values = new Map<string, Balance>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly lastForced = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly accounts: UsageConfig["accounts"], private readonly fetchImpl: typeof fetch = fetch, private readonly now = () => Date.now()) {
    for (const [id, account] of Object.entries(accounts)) if (account.balance?.source === "deepseek") {
      try { this.keys.set(id, readFileSync(account.balance.apiKeyFile, "utf8").trim()); } catch { /* unavailable keys leave balances unavailable */ }
    }
  }
  get(accountId: string): Balance { const value = this.values.get(accountId); return value ? { ...value } : null; }
  async refresh(force = false) {
    if (this.closed) return;
    const entries = [...this.keys].filter(([id, key]) => key && this.accounts[id]?.balance?.source === "deepseek");
    await Promise.all(entries.map(async ([id, key]) => {
      const at = this.now(), last = this.lastAttempt.get(id) ?? -Infinity;
      if (!force && at - last < refreshMs) return;
      if (force && at - (this.lastForced.get(id) ?? -Infinity) < forcedMs) return;
      this.lastAttempt.set(id, at); if (force) this.lastForced.set(id, at);
      try {
        const response = await this.fetchImpl("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("balance request failed");
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("is_available" in body) || body.is_available !== true || !("balance_infos" in body) || !Array.isArray(body.balance_infos)) throw new Error("invalid balance response");
        const infos = body.balance_infos as unknown[];
        const valid = infos.filter((item): item is { currency: string; total_balance: string } => Boolean(item && typeof item === "object" && "currency" in item && typeof item.currency === "string" && "total_balance" in item && typeof item.total_balance === "string"));
        const selected = valid.find(item => item.currency === "USD") ?? valid[0], rawAmount = selected?.total_balance.trim(), amount = rawAmount ? Number(rawAmount) : NaN;
        if (!selected || !Number.isFinite(amount)) throw new Error("invalid balance response");
        this.values.set(id, { amount, currency: selected.currency, asOf: new Date(at).toISOString(), stale: false });
      } catch {
        const previous = this.values.get(id);
        if (previous) this.values.set(id, { ...previous, stale: true });
      }
    }));
  }
  start() {
    if (this.timer || this.closed) return;
    void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, refreshMs); this.timer.unref();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
