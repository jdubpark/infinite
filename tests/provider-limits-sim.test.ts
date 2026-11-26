import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderLimits,
  type LimitRow,
  type LimitSessions,
  type ProviderLimitEvent,
} from "../packages/host/src/provider-limits.js";
import type { Provider } from "../packages/host/src/types.js";

const DEFAULT_SEEDS = 30;
const ONLY = process.env.PROVIDER_LIMITS_SIM_SEED;
const COUNT = Number(process.env.PROVIDER_LIMITS_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.PROVIDER_LIMITS_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, i) => BASE_SEED + i) : [Number(ONLY)];
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const HISTORY_MS = 30 * DAY_MS;
const PROVIDERS: readonly Provider[] = ["claude", "codex"];

type Rand = { next(): number; int(min: number, max: number): number; pick<T>(items: readonly T[]): T };
function rng(seed: number): Rand {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)]!,
  };
}

type RefEpisode = { limit: "usage" | "credits"; startedAt: number; lastDetectedAt: number; resetsAt?: number };
type RefModel = {
  floor: Record<Provider, number>;
  activeUntil: Record<Provider, number>;
  episodes: Partial<Record<Provider, RefEpisode>>;
  history: ProviderLimitEvent[];
};

type JournalEntry = { at: string; data: Record<string, unknown> };
type InvariantViolation = { name: string; detail: string };

function checkInvariants(
  actual: ProviderLimits,
  reloaded: ProviderLimits,
  ref: RefModel,
  nowMs: number,
  prevHistoryCount: number,
  hadOpenEpisodeFor: Provider | undefined,
  openedNewAfterRecoveryFor: Provider | undefined,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const now = new Date(nowMs);
  const actualHistory = actual.history(now);
  const reloadedHistory = reloaded.history(now);
  const expectedHistory = ref.history.filter(item => {
    const at = Date.parse(item.detectedAt);
    return at >= nowMs - HISTORY_MS && at <= nowMs;
  });

  if (hadOpenEpisodeFor !== undefined && actualHistory.length > prevHistoryCount) {
    violations.push({
      name: "episode-count-matches-recoveries",
      detail: `history grew from ${prevHistoryCount} to ${actualHistory.length} while ${hadOpenEpisodeFor} episode stayed open`,
    });
  }
  if (openedNewAfterRecoveryFor !== undefined && actualHistory.length !== expectedHistory.length) {
    violations.push({
      name: "new-episode-after-recovery",
      detail: `expected ${expectedHistory.length} history events after ${openedNewAfterRecoveryFor} recovery, got ${actualHistory.length}`,
    });
  }
  const actualCredits = actualHistory.filter(e => e.limit === "credits").map(e => `${e.provider}:${e.detectedAt}`);
  const expectedCredits = expectedHistory.filter(e => e.limit === "credits").map(e => `${e.provider}:${e.detectedAt}`);
  if (JSON.stringify(actualCredits) !== JSON.stringify(expectedCredits)) {
    violations.push({
      name: "credits-never-train-usage",
      detail: `credit events mismatch: actual=${JSON.stringify(actualCredits)} expected=${JSON.stringify(expectedCredits)}`,
    });
  }
  if (
    JSON.stringify(actual.active(now)) !== JSON.stringify(reloaded.active(now))
    || JSON.stringify([...actual.limited(now)].sort()) !== JSON.stringify([...reloaded.limited(now)].sort())
    || JSON.stringify(actualHistory) !== JSON.stringify(reloadedHistory)
  ) {
    violations.push({
      name: "restart-persistence",
      detail: "reloaded ProviderLimits diverged from live state",
    });
  }
  const seenKeys = new Set<string>();
  for (let i = 0; i < actualHistory.length; i++) {
    const item = actualHistory[i]!;
    const at = Date.parse(item.detectedAt);
    const key = `${item.provider}:${item.detectedAt}`;
    if (at < nowMs - HISTORY_MS || at > nowMs || seenKeys.has(key) || (i > 0 && Date.parse(actualHistory[i - 1]!.detectedAt) > at)) {
      violations.push({
        name: "thirty-day-window-and-order",
        detail: `invalid history window/order/dedup at index ${i}: ${JSON.stringify(item)}`,
      });
      break;
    }
    seenKeys.add(key);
  }
  if (JSON.stringify(actualHistory.map(e => [e.provider, e.limit, e.detectedAt])) !== JSON.stringify(expectedHistory.map(e => [e.provider, e.limit, e.detectedAt]))) {
    violations.push({
      name: "episode-count-matches-recoveries",
      detail: `history diverged from reference model`,
    });
  }
  return violations;
}

async function simulateSeed(seed: number): Promise<{ steps: number; episodes: number; recoveries: number; reloads: number }> {
  const r = rng(seed);
  const dir = mkdtempSync(join(tmpdir(), `inf-limits-sim-${seed}-`));
  const file = join(dir, "provider-limits.sealed");
  const key = randomBytes(32);
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const ref: RefModel = {
    floor: { claude: -Infinity, codex: -Infinity, grok: -Infinity, opencode: -Infinity, demo: -Infinity },
    activeUntil: { claude: -Infinity, codex: -Infinity, grok: -Infinity, opencode: -Infinity, demo: -Infinity },
    episodes: {},
    history: [],
  };
  const journals: Record<string, JournalEntry[]> = {
    "claude-1": [],
    "claude-2": [],
    "codex-1": [],
    "codex-2": [],
  };
  const rows: Record<string, LimitRow> = {
    "claude-1": { id: "claude-1", provider: "claude", attention: {} },
    "claude-2": { id: "claude-2", provider: "claude", attention: {} },
    "codex-1": { id: "codex-1", provider: "codex", attention: {} },
    "codex-2": { id: "codex-2", provider: "codex", attention: {} },
  };
  const sessions: LimitSessions = {
    events: (id, after, limit) => {
      const all = (journals[id] ?? []).map((entry, idx) => ({ ...entry, seq: idx + 1 }));
      const slice = all.filter(item => item.seq > after).slice(0, limit);
      return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: all.length > after + slice.length };
    },
  };
  let limits = new ProviderLimits(file, key);
  let episodes = 0;
  let recoveries = 0;
  let reloads = 0;

  try {
    for (let step = 1; step <= 80; step++) {
      const jump = r.next() < 0.12 ? r.int(1, 5) * DAY_MS : r.int(1, 40) * MIN_MS;
      nowMs += jump;
      const nowIso = new Date(nowMs).toISOString();
      const provider = r.pick(PROVIDERS);
      const sessionId = `${provider}-${r.int(1, 2)}`;
      const action = r.int(0, 6);
      const prevCount = limits.history(new Date(nowMs)).length;
      let hadOpenFor: Provider | undefined;
      let openedNewAfterRecoveryFor: Provider | undefined;

      if (action === 0 || action === 1) {
        const kind: "usage" | "credits" = r.next() < 0.3 ? "credits" : "usage";
        const hasReset = r.next() < 0.5;
        const resetsAt = hasReset ? new Date(nowMs + r.int(2, 6) * 3_600_000).toISOString() : undefined;
        const wasOpen = ref.episodes[provider] !== undefined;
        if (wasOpen) hadOpenFor = provider;
        if (action === 0) {
          limits.observe({ provider, limit: kind, detectedAt: nowIso, ...(resetsAt ? { resetsAt } : {}), sessionId, confidence: "corroborated" });
        } else {
          rows[sessionId]!.attention.limit = { limit: kind, confidence: "corroborated", since: nowIso, ...(resetsAt ? { resetsAt } : {}) };
          journals[sessionId]!.push({ at: nowIso, data: { kind: "provider-limit", limit: kind, confidence: "corroborated", provider, source: "protocol" } });
          await limits.reconcile(sessions, Object.values(rows), new Date(nowMs));
        }
        if (nowMs > ref.floor[provider]) {
          ref.floor[provider] = nowMs;
          ref.activeUntil[provider] = resetsAt ? Math.min(Date.parse(resetsAt), nowMs + DAY_MS) : nowMs + 15 * MIN_MS;
          if (ref.episodes[provider]) {
            ref.episodes[provider]!.lastDetectedAt = nowMs;
            if (resetsAt && ref.episodes[provider]!.resetsAt === undefined) {
              ref.episodes[provider]!.resetsAt = Date.parse(resetsAt);
            }
          } else {
            episodes++;
            openedNewAfterRecoveryFor = provider;
            ref.episodes[provider] = { limit: kind, startedAt: nowMs, lastDetectedAt: nowMs, ...(resetsAt ? { resetsAt: Date.parse(resetsAt) } : {}) };
            const cutoff = nowMs - HISTORY_MS;
            ref.history = ref.history.filter(item => Date.parse(item.detectedAt) >= cutoff);
            ref.history.push({ provider, limit: kind, detectedAt: nowIso, ...(resetsAt ? { resetsAt } : {}), sessionId });
          }
        }
      } else if (action === 2) {
        journals[sessionId]!.push({
          at: nowIso,
          data: { kind: "turn-end", source: provider === "codex" ? "protocol" : "hook", provider, ...(r.next() < 0.25 ? { failed: true } : {}) },
        });
        const succeeded = !journals[sessionId]!.at(-1)!.data.failed;
        const hadLimit = ref.activeUntil[provider] > nowMs || ref.episodes[provider] !== undefined;
        await limits.reconcile(sessions, Object.values(rows), new Date(nowMs));
        if (succeeded && hadLimit && nowMs > ref.floor[provider]) {
          ref.floor[provider] = nowMs;
          ref.activeUntil[provider] = -Infinity;
          delete ref.episodes[provider];
          for (const row of Object.values(rows)) if (row.provider === provider) row.attention = {};
          recoveries++;
        }
      } else if (action === 3) {
        const hadLimit = ref.activeUntil[provider] > -Infinity || ref.episodes[provider] !== undefined;
        limits.clear(provider, nowIso);
        if (hadLimit) {
          ref.floor[provider] = Math.max(ref.floor[provider], nowMs);
          ref.activeUntil[provider] = -Infinity;
          delete ref.episodes[provider];
          for (const row of Object.values(rows)) if (row.provider === provider) row.attention = {};
          recoveries++;
        }
      } else if (action === 4) {
        journals[sessionId]!.push({ at: nowIso, data: { kind: "provider-limit", limit: "usage", confidence: "single-source", provider, source: "screen" } });
        await limits.reconcile(sessions, Object.values(rows), new Date(nowMs));
      } else if (action === 5 && ref.episodes[provider] !== undefined && nowMs > ref.floor[provider]) {
        const recoverSession = `${provider}-${r.int(1, 2)}`;
        const hitSession = `${provider}-${r.int(1, 2)}`;
        const kind: "usage" | "credits" = r.next() < 0.3 ? "credits" : "usage";
        const recoverIso = nowIso;
        journals[recoverSession]!.push({
          at: recoverIso,
          data: { kind: "turn-end", source: provider === "codex" ? "protocol" : "hook", provider },
        });
        nowMs += r.int(1, 10) * MIN_MS;
        const hitIso = new Date(nowMs).toISOString();
        const resetsAt = r.next() < 0.5 ? new Date(nowMs + r.int(2, 6) * 3_600_000).toISOString() : undefined;
        if (r.next() < 0.5) {
          journals[hitSession]!.push({
            at: hitIso,
            data: { kind: "provider-limit", limit: kind, confidence: "corroborated", provider, source: "protocol", ...(resetsAt ? { resetsAt } : {}) },
          });
        }
        rows[hitSession]!.attention.limit = { limit: kind, confidence: "corroborated", since: hitIso, ...(resetsAt ? { resetsAt } : {}) };
        await limits.reconcile(sessions, Object.values(rows), new Date(nowMs));
        recoveries++;
        episodes++;
        openedNewAfterRecoveryFor = provider;
        ref.floor[provider] = nowMs;
        ref.activeUntil[provider] = resetsAt ? Math.min(Date.parse(resetsAt), nowMs + DAY_MS) : nowMs + 15 * MIN_MS;
        ref.episodes[provider] = { limit: kind, startedAt: nowMs, lastDetectedAt: nowMs, ...(resetsAt ? { resetsAt: Date.parse(resetsAt) } : {}) };
        const cutoff = nowMs - HISTORY_MS;
        ref.history = ref.history.filter(item => Date.parse(item.detectedAt) >= cutoff);
        ref.history.push({ provider, limit: kind, detectedAt: hitIso, ...(resetsAt ? { resetsAt } : {}), sessionId: hitSession });
      } else {
        limits = new ProviderLimits(file, key);
        reloads++;
      }

      const reloaded = new ProviderLimits(file, key);
      const violations = checkInvariants(limits, reloaded, ref, nowMs, prevCount, hadOpenFor, openedNewAfterRecoveryFor);
      assert.deepEqual(
        violations,
        [],
        `seed=${seed} step=${step} action=${action} provider=${provider}: ${JSON.stringify(violations)}`,
      );
    }
    return { steps: 80, episodes, recoveries, reloads };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ProviderLimits keeps durable episode invariants under seeded signal, recovery, and restart schedules", async t => {
  let episodes = 0;
  let recoveries = 0;
  let reloads = 0;
  for (const seed of SEEDS) {
    const stats = await simulateSeed(seed);
    episodes += stats.episodes;
    recoveries += stats.recoveries;
    reloads += stats.reloads;
  }
  t.diagnostic(`provider-limits sim: ${SEEDS.length} seeds from ${SEEDS[0]}, episodes=${episodes}, recoveries=${recoveries}, reloads=${reloads}`);
  assert.ok(episodes > 0 && recoveries > 0 && reloads > 0);
});

test("every provider-limits simulator invariant catches a deliberate mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-limits-mutants-"));
  const fileA = join(dir, "a.sealed");
  const fileB = join(dir, "b.sealed");
  const key = randomBytes(32);
  const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
  const t1 = new Date(nowMs - 2 * 3_600_000).toISOString();
  const t2 = new Date(nowMs - 3_600_000).toISOString();
  const baseRef = (): RefModel => ({
    floor: { claude: nowMs - 2 * 3_600_000, codex: -Infinity, grok: -Infinity, opencode: -Infinity, demo: -Infinity },
    activeUntil: { claude: nowMs, codex: -Infinity, grok: -Infinity, opencode: -Infinity, demo: -Infinity },
    episodes: { claude: { limit: "usage", startedAt: Date.parse(t1), lastDetectedAt: Date.parse(t1) } },
    history: [{ provider: "claude", limit: "usage", detectedAt: t1, sessionId: "s1" }],
  });
  try {
    const live = new ProviderLimits(fileA, key);
    live.observe({ provider: "claude", limit: "usage", detectedAt: t1, sessionId: "s1", confidence: "corroborated" });
    const reloaded = new ProviderLimits(fileA, key);
    assert.deepEqual(checkInvariants(live, reloaded, baseRef(), nowMs, 1, undefined, undefined), []);

    const dupMutant = {
      active: (n: Date) => live.active(n),
      limited: (n: Date) => live.limited(n),
      history: () => [
        { provider: "claude" as const, limit: "usage" as const, detectedAt: t1, sessionId: "s1" },
        { provider: "claude" as const, limit: "usage" as const, detectedAt: t2, sessionId: "s1" },
      ],
    } as unknown as ProviderLimits;
    assert.ok(checkInvariants(dupMutant, dupMutant, baseRef(), nowMs, 1, "claude", undefined).some(v => v.name === "episode-count-matches-recoveries"));

    const missedNewRef = baseRef();
    missedNewRef.history.push({ provider: "claude", limit: "usage", detectedAt: t2, sessionId: "s2" });
    assert.ok(checkInvariants(live, reloaded, missedNewRef, nowMs, 1, undefined, "claude").some(v => v.name === "new-episode-after-recovery"));

    const creditRef = baseRef();
    creditRef.history = [{ provider: "claude", limit: "credits", detectedAt: t1, sessionId: "s1" }];
    assert.ok(checkInvariants(live, reloaded, creditRef, nowMs, 1, undefined, undefined).some(v => v.name === "credits-never-train-usage"));

    const staleReload = new ProviderLimits(fileB, key);
    assert.ok(checkInvariants(live, staleReload, baseRef(), nowMs, 1, undefined, undefined).some(v => v.name === "restart-persistence"));

    const unorderedMutant = {
      active: (n: Date) => live.active(n),
      limited: (n: Date) => live.limited(n),
      history: () => [
        { provider: "claude" as const, limit: "usage" as const, detectedAt: t2, sessionId: "s2" },
        { provider: "claude" as const, limit: "usage" as const, detectedAt: t1, sessionId: "s1" },
      ],
    } as unknown as ProviderLimits;
    assert.ok(checkInvariants(unorderedMutant, unorderedMutant, baseRef(), nowMs, 2, undefined, undefined).some(v => v.name === "thirty-day-window-and-order"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery followed by a second limit hit between reconciliations records two episodes across same-session, cross-session, and paginated journals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-limits-between-"));
  const key = randomBytes(32);
  const t = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`;
  try {
    const file1 = join(dir, "same.sealed");
    const limits1 = new ProviderLimits(file1, key);
    limits1.observe({ provider: "claude", limit: "usage", detectedAt: t("10:00"), resetsAt: t("15:00"), sessionId: "s1", confidence: "corroborated" });
    const j1: Record<string, JournalEntry[]> = {
      s1: [
        { at: t("11:00"), data: { kind: "turn-end", source: "hook", provider: "claude" } },
        { at: t("12:00"), data: { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "claude", source: "screen", resetsAt: t("17:00") } },
      ],
    };
    const r1: LimitRow[] = [{ id: "s1", provider: "claude", attention: { limit: { limit: "usage", confidence: "corroborated", since: t("12:00"), resetsAt: t("17:00") } } }];
    await limits1.reconcile({
      events: (id, after, limit) => {
        const all = (j1[id] ?? []).map((entry, idx) => ({ ...entry, seq: idx + 1 }));
        const slice = all.filter(item => item.seq > after).slice(0, limit);
        return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: all.length > after + slice.length };
      },
    }, r1, new Date(t("12:05")));
    assert.deepEqual(new ProviderLimits(file1, key).history(new Date(t("12:05"))).map(e => e.detectedAt), [t("10:00"), t("12:00")]);

    const file2 = join(dir, "cross.sealed");
    const limits2 = new ProviderLimits(file2, key);
    limits2.observe({ provider: "codex", limit: "usage", detectedAt: t("10:00"), sessionId: "cx-1", confidence: "corroborated" });
    const j2: Record<string, JournalEntry[]> = {
      "cx-1": [],
      "cx-2": [{ at: t("11:00"), data: { kind: "turn-end", source: "protocol", provider: "codex" } }],
    };
    const r2: LimitRow[] = [
      { id: "cx-1", provider: "codex", attention: { limit: { limit: "usage", confidence: "corroborated", since: t("12:00"), resetsAt: t("17:00") } } },
      { id: "cx-2", provider: "codex", attention: {} },
    ];
    await limits2.reconcile({
      events: (id, after, limit) => {
        const all = (j2[id] ?? []).map((entry, idx) => ({ ...entry, seq: idx + 1 }));
        const slice = all.filter(item => item.seq > after).slice(0, limit);
        return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: all.length > after + slice.length };
      },
    }, r2, new Date(t("12:05")));
    assert.deepEqual(new ProviderLimits(file2, key).history(new Date(t("12:05"))).map(e => e.detectedAt), [t("10:00"), t("12:00")]);

    const file3 = join(dir, "paged.sealed");
    const limits3 = new ProviderLimits(file3, key);
    limits3.observe({ provider: "claude", limit: "usage", detectedAt: t("10:00"), resetsAt: t("15:00"), sessionId: "p1", confidence: "corroborated" });
    const j3: Record<string, JournalEntry[]> = {
      p1: [
        { at: t("11:00"), data: { kind: "turn-end", source: "hook", provider: "claude" } },
        { at: t("12:00"), data: { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "claude", source: "screen", resetsAt: t("17:00") } },
      ],
    };
    const r3: LimitRow[] = [{ id: "p1", provider: "claude", attention: { limit: { limit: "usage", confidence: "corroborated", since: t("12:00"), resetsAt: t("17:00") } } }];
    const pagedSessions: LimitSessions = {
      events: (id, after, limit) => {
        const all = (j3[id] ?? []).map((entry, idx) => ({ ...entry, seq: idx + 1 }));
        const slice = all.filter(item => item.seq > after).slice(0, Math.min(limit, 1));
        return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: all.length > after + slice.length };
      },
    };
    await limits3.reconcile(pagedSessions, r3, new Date(t("12:05")));
    await limits3.reconcile(pagedSessions, r3, new Date(t("12:06")));
    assert.deepEqual(new ProviderLimits(file3, key).history(new Date(t("12:06"))).map(e => e.detectedAt), [t("10:00"), t("12:00")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
