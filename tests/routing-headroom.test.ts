import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeModule, writeOutcome, type OutcomePayload, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { ProviderLimits, type ProviderLimitEvent } from "../packages/host/src/provider-limits.js";
import { TIER_COSTS } from "../packages/host/src/routing-choice.js";
import {
  isNearLimit,
  limitPressure,
  providerHeadroom,
  readProviderHeadrooms,
  type HeadroomUsagePoint,
} from "../packages/host/src/routing-headroom.js";
import { pinRouting } from "../packages/host/src/routing-policy.js";
import { decideAutoScout } from "../packages/host/src/routing-points.js";
import { routingStatus } from "../packages/host/src/routing-reads.js";
import { RoutingRecorder, type RouterStart } from "../packages/host/src/routing-recorder.js";
import { routingModule, taskDecisions } from "../packages/host/src/routing-store.js";
import { taskFeatures } from "../packages/host/src/task-features.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamScout, TeamTask } from "../packages/host/src/team-types.js";
import type { Config, Provider } from "../packages/host/src/types.js";
import { usageModule, writeRecord, writeSession } from "../packages/host/src/usage-store.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const before = (ms: number, anchor = NOW) => new Date(Date.parse(anchor) - ms).toISOString();
const after = (ms: number, anchor: string) => new Date(Date.parse(anchor) + ms).toISOString();

test("ProviderLimits persists 30-day rolling limit history across restarts and loads legacy files", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-limit-history-"));
  const file = join(dir, "provider-limits.sealed");
  const key = randomBytes(32);
  try {
    writeSealed(file, key, "provider-limits", { limits: {}, cleared: {} });
    const legacy = new ProviderLimits(file, key);
    assert.deepEqual(legacy.history(new Date(NOW)), []);

    legacy.observe({ provider: "codex", limit: "usage", detectedAt: before(35 * DAY), resetsAt: after(5 * HOUR, before(35 * DAY)), sessionId: "s0", confidence: "corroborated" });
    legacy.clear("codex", before(34 * DAY));
    legacy.observe({ provider: "codex", limit: "usage", detectedAt: before(10 * DAY), resetsAt: after(5 * HOUR, before(10 * DAY)), sessionId: "s1", confidence: "corroborated" });
    legacy.clear("codex", before(9 * DAY));
    legacy.observe({ provider: "codex", limit: "credits", detectedAt: before(4 * DAY), sessionId: "s2", confidence: "corroborated" });
    legacy.clear("codex", before(3 * DAY));
    legacy.observe({ provider: "codex", limit: "usage", detectedAt: before(2 * DAY), resetsAt: after(5 * HOUR, before(2 * DAY)), sessionId: "s3", runId: "r3", confidence: "corroborated" });

    const reopened = new ProviderLimits(file, key);
    const events = reopened.history(new Date(NOW));
    assert.deepEqual(events.map(item => [item.provider, item.limit, item.sessionId, item.runId ?? null]), [
      ["codex", "usage", "s1", null],
      ["codex", "credits", "s2", null],
      ["codex", "usage", "s3", "r3"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limitPressure and isNearLimit follow the knee at 0.5 and near-limit threshold at 0.2", () => {
  assert.equal(limitPressure(null), 0);
  assert.equal(limitPressure(undefined), 0);
  assert.equal(limitPressure(Number.NaN), 0);
  assert.equal(limitPressure(1), 0);
  assert.equal(limitPressure(0.5), 0);
  assert.ok(Math.abs(limitPressure(0.25) - 0.5) < 1e-12);
  assert.ok(Math.abs(limitPressure(0.2) - 0.6) < 1e-12);
  assert.equal(limitPressure(0), 1);
  assert.equal(limitPressure(-0.5), 1);

  assert.equal(isNearLimit(null), false);
  assert.equal(isNearLimit(0.2), false);
  assert.equal(isNearLimit(0.199), true);
  assert.equal(isNearLimit(0), true);
});

test("providerHeadroom estimates ceilings from two short or long usage limits, falls back to tokens when unpriced, and ignores credits", () => {
  const limited = providerHeadroom({
    provider: "codex",
    limited: new Set<Provider>(["codex"]),
    events: [],
    usage: [],
    now: NOW,
  });
  assert.deepEqual(limited, { headroom: 0, basis: "limited", pressure: 1, near: true });

  const oneEvent: ProviderLimitEvent = {
    provider: "codex",
    limit: "usage",
    detectedAt: before(2 * DAY),
    resetsAt: after(5 * HOUR, before(2 * DAY)),
    sessionId: "s1",
  };
  assert.deepEqual(providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events: [oneEvent, { ...oneEvent, limit: "credits", detectedAt: before(1 * DAY), sessionId: "s2" }],
    usage: [{ completedAt: before(2 * DAY + HOUR), listUsd: 40, tokens: 100_000 }],
    now: NOW,
  }), { headroom: null, basis: "unestimated", pressure: 0, near: false });

  const e1 = before(4 * DAY);
  const e2 = before(2 * DAY);
  const shortEvents: ProviderLimitEvent[] = [
    { provider: "codex", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "s1" },
    { provider: "codex", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "s2" },
  ];
  const shortUsage: HeadroomUsagePoint[] = [
    { completedAt: before(HOUR, e1), listUsd: 40, tokens: 4_000_000 },
    { completedAt: before(HOUR, e2), listUsd: 44, tokens: 4_400_000 },
    { completedAt: before(HOUR, NOW), listUsd: 36, tokens: 3_600_000 },
  ];
  const estimated = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events: shortEvents,
    usage: shortUsage,
    now: NOW,
  });
  assert.equal(estimated.basis, "estimated");
  assert.equal(estimated.unit, "usd");
  assert.equal(estimated.near, true);
  assert.ok(Math.abs(estimated.headroom! - (1 - 36 / 42)) < 1e-12);
  assert.ok(Math.abs(estimated.pressure - (0.5 - estimated.headroom!) / 0.5) < 1e-12);

  const tokenFallback = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events: shortEvents,
    usage: [
      { completedAt: before(HOUR, e1), listUsd: 40, tokens: 1000 },
      { completedAt: before(HOUR, e2), listUsd: null, tokens: 1000 },
      { completedAt: before(HOUR, NOW), listUsd: 10, tokens: 850 },
    ],
    now: NOW,
  });
  assert.equal(tokenFallback.basis, "estimated");
  assert.equal(tokenFallback.unit, "tokens");
  assert.ok(Math.abs(tokenFallback.headroom! - 0.15) < 1e-12);
  assert.equal(tokenFallback.near, true);

  const s1 = before(14 * DAY);
  const s2 = before(9 * DAY);
  const l1 = before(25 * DAY);
  const l2 = before(16 * DAY);
  const longEvents: ProviderLimitEvent[] = [
    { provider: "codex", limit: "usage", detectedAt: s1, resetsAt: after(5 * HOUR, s1), sessionId: "s1" },
    { provider: "codex", limit: "usage", detectedAt: s2, resetsAt: after(5 * HOUR, s2), sessionId: "s2" },
    { provider: "codex", limit: "usage", detectedAt: l1, resetsAt: after(4 * DAY, l1), sessionId: "l1" },
    { provider: "codex", limit: "usage", detectedAt: l2, resetsAt: after(4 * DAY, l2), sessionId: "l2" },
  ];
  const combined = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events: longEvents,
    usage: [
      { completedAt: before(HOUR, s1), listUsd: 40, tokens: 1000 },
      { completedAt: before(HOUR, s2), listUsd: 40, tokens: 1000 },
      { completedAt: before(HOUR, l1), listUsd: 100, tokens: 5000 },
      { completedAt: before(HOUR, l2), listUsd: 100, tokens: 5000 },
      { completedAt: before(3 * DAY, NOW), listUsd: 95, tokens: 4750 },
      { completedAt: before(HOUR, NOW), listUsd: 4, tokens: 200 },
    ],
    now: NOW,
  });
  assert.equal(combined.basis, "estimated");
  assert.equal(combined.unit, "usd");
  assert.ok(Math.abs(combined.headroom! - 0.01) < 1e-12);
  assert.equal(combined.near, true);
});

const PATHS = ["packages/host/src/a.ts"];
const AREA = taskFeatures({ role: "implementer", paths: PATHS }).area;
const ENDED = before(20 * DAY);
const PRICES: NonNullable<Config["usage"]>["prices"] = {
  "openai/gpt-light": { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  "anthropic/claude-strong": { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
};

function config(tx: EvidenceTx, id: string, profile: TeamModelProfile): void {
  const effort = "effort" in profile ? profile.effort ?? null : profile.variant ?? null;
  const version = promptVersion("implementer", profile.provider, profile, false, false);
  tx.run(
    "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
    + "VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)",
    id, profile.provider, profile.model, effort, version, NOW,
  );
}

function outcomeWithCost(id: string, profile: TeamModelProfile, configId: string, listUsd: number | null, endedAt = before(2 * DAY)): OutcomeRow {
  const effort = "effort" in profile ? profile.effort ?? null : profile.variant ?? null;
  const payload: OutcomePayload = {
    projectId: "rehearsal",
    taskId: "task-x",
    area: AREA,
    featureMap: "default",
    rounds: { run: 1, attributed: 1, unknown: 0 },
    limitEvents: 0,
    costCoverage: listUsd === null ? "none" : "complete",
    ...(listUsd === null ? {} : { listUsd }),
  };
  return {
    outcomeId: `${id}:m1`,
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: id,
    revision: 1,
    memberId: "m1",
    sessionId: null,
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    effort,
    profileEpoch: 1,
    configId,
    experimentRef: null,
    kind: null,
    risk: "normal",
    featureVersion: 1,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    acceptance: 1,
    firstPass: 1,
    held: 1,
    startedAt: before(HOUR, endedAt),
    endedAt,
    frozenAt: endedAt,
    holdUntil: null,
    runDeletedAt: null,
    payload,
  };
}

test("RoutingRecorder and routingStatus consume persisted listUsd, fall back below 5 rows, and apply live headroom pressure", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-routing-headroom-int-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    store.register(usageModule);

    const codexLight: TeamModelProfile = { id: "codex-light", label: "Codex Light", provider: "codex", model: "gpt-light", effort: "high", tier: "light" };
    const claudeStrong: TeamModelProfile = { id: "claude-strong", label: "Claude Strong", provider: "claude", model: "claude-strong", effort: "high", tier: "strong" };
    const lineup: TeamLineup = {
      ...mixedLineup,
      implementers: [codexLight, claudeStrong],
      reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-rev", effort: "xhigh" },
    };

    const runOf = (id: string, routing = pinRouting({ mode: "auto", listWeight: 1, successValueUsd: 2, headroomWeight: 1 }, "supervised", lineup, ENDED)!) =>
      ({ id, revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const taskOf = (id: string) =>
      ({ id, title: id, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
    const startOf = (run: TeamRun, task: TeamTask, extra: Partial<RouterStart> = {}): RouterStart =>
      ({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), ...extra });
    const rec = new RoutingRecorder({ store, now: () => NOW });

    store.write(tx => {
      config(tx, "cfg-codex", codexLight);
      config(tx, "cfg-claude", claudeStrong);
      for (let i = 0; i < 4; i++) {
        writeOutcome(tx, outcomeWithCost(`few-codex-${i}`, codexLight, "cfg-codex", 3.5));
        writeOutcome(tx, outcomeWithCost(`few-claude-${i}`, claudeStrong, "cfg-claude", 0.2));
      }
    });

    const beforeFive = runOf("run-few");
    const taskFew = taskOf("task-few");
    beforeFive.tasks.push(taskFew);
    rec.applyStart(startOf(beforeFive, taskFew));
    const fewRow = store.read(db => taskDecisions(db, beforeFive.id, "task-few")).rows[0]!;
    assert.equal(fewRow.greedyProfileId, "codex-light");
    assert.equal(fewRow.payload?.costs.basis, "tier-default");
    assert.deepEqual(fewRow.payload?.candidates.map(c => [c.profileId, c.costUsd, c.costBasis]), [
      ["codex-light", TIER_COSTS.light, "tier-default"],
      ["claude-strong", TIER_COSTS.strong, "tier-default"],
    ]);

    store.write(tx => {
      writeOutcome(tx, outcomeWithCost("five-codex", codexLight, "cfg-codex", 3.5));
      writeOutcome(tx, outcomeWithCost("five-claude", claudeStrong, "cfg-claude", 0.2));
    });

    const afterFive = runOf("run-observed");
    const taskObs = taskOf("task-obs");
    afterFive.tasks.push(taskObs);
    rec.applyStart(startOf(afterFive, taskObs));
    const obsRow = store.read(db => taskDecisions(db, afterFive.id, "task-obs")).rows[0]!;
    assert.equal(obsRow.greedyProfileId, "claude-strong");
    assert.equal(obsRow.payload?.costs.basis, "observed");
    assert.equal(obsRow.payload?.headroom, "modelled");
    assert.deepEqual(obsRow.payload?.candidates.map(c => [c.profileId, c.costUsd, c.costBasis]), [
      ["codex-light", 3.5, "observed"],
      ["claude-strong", 0.2, "observed"],
    ]);

    const e1 = before(4 * DAY);
    const e2 = before(2 * DAY);
    const limitHistory: ProviderLimitEvent[] = [
      { provider: "claude", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "s-e1" },
      { provider: "claude", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "s-e2" },
    ];
    store.write(tx => {
      for (const [sid, at, tokens] of [
        ["s-e1", before(HOUR, e1), 4_000_000],
        ["s-e2", before(HOUR, e2), 4_400_000],
        ["s-now", before(HOUR, NOW), 3_800_000],
      ] as const) {
        writeSession(tx, { sessionId: sid, provider: "claude", projectId: "rehearsal", createdAt: at }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
        writeRecord(tx, sid, {
          provider: "claude",
          providerId: "anthropic",
          modelId: "claude-strong",
          messageId: `m-${sid}`,
          partId: `p-${sid}`,
          modelSource: "reported",
          completedAt: at,
          tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost: 0,
        });
      }
    });

    const headrooms = store.read(db => readProviderHeadrooms(db, ["codex", "claude"], new Set(), limitHistory, PRICES, NOW));
    assert.equal(headrooms.get("codex")?.basis, "unestimated");
    assert.equal(headrooms.get("claude")?.basis, "estimated");
    assert.equal(headrooms.get("claude")?.near, true);
    assert.ok((headrooms.get("claude")?.pressure ?? 0) > 0.8);

    const pressureRun = runOf("run-pressure", pinRouting({ mode: "auto", listWeight: 0.25, successValueUsd: 4, headroomWeight: 1 }, "supervised", lineup, ENDED)!);
    const taskPressure = taskOf("task-pressure");
    pressureRun.tasks.push(taskPressure);
    rec.applyStart(startOf(pressureRun, taskPressure, { limitHistory, prices: PRICES }));
    const pressureRow = store.read(db => taskDecisions(db, pressureRun.id, "task-pressure")).rows[0]!;
    assert.equal(pressureRow.greedyProfileId, "codex-light");
    const claudeCand = pressureRow.payload?.candidates.find(c => c.profileId === "claude-strong");
    assert.equal(claudeCand?.headroomBasis, "estimated");
    assert.ok((claudeCand?.pressure ?? 0) > 0.8);

    const status = routingStatus(store, {
      projectId: "rehearsal",
      saved: { mode: "auto", listWeight: 0.25, successValueUsd: 4, headroomWeight: 1 },
      autonomy: "supervised",
      lineup,
      publishHeads: false,
      entryTools: false,
      objectiveDigest: false,
      codeMode: false,
      now: NOW,
      limitHistory,
      prices: PRICES,
    });
    assert.equal(status.costs.basis, "observed");
    assert.equal(status.headroom, "modelled");
    assert.equal(status.providers?.claude?.basis, "estimated");
    assert.equal(status.providers?.claude?.near, true);
    assert.equal(status.providers?.codex?.basis, "unestimated");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto start blocks exploration into a near-limit provider with basis greedy-headroom", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-routing-near-guard-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    store.register(usageModule);

    const codexA: TeamModelProfile = { id: "codex-a", label: "Codex A", provider: "codex", model: "gpt-light", effort: "high", tier: "light" };
    const claudeB: TeamModelProfile = { id: "claude-b", label: "Claude B", provider: "claude", model: "claude-strong", effort: "high", tier: "light" };
    const lineup: TeamLineup = {
      ...mixedLineup,
      implementers: [codexA, claudeB],
      reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-rev", effort: "xhigh" },
    };

    const e1 = before(4 * DAY);
    const e2 = before(2 * DAY);
    const limitHistory: ProviderLimitEvent[] = [
      { provider: "claude", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "s-e1" },
      { provider: "claude", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "s-e2" },
    ];
    store.write(tx => {
      for (const [sid, at, tokens] of [
        ["s-e1", before(HOUR, e1), 4_000_000],
        ["s-e2", before(HOUR, e2), 4_000_000],
        ["s-now", before(HOUR, NOW), 3_400_000],
      ] as const) {
        writeSession(tx, { sessionId: sid, provider: "claude", projectId: "rehearsal", createdAt: at }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
        writeRecord(tx, sid, {
          provider: "claude",
          providerId: "anthropic",
          modelId: "claude-strong",
          messageId: `m-${sid}`,
          partId: `p-${sid}`,
          modelSource: "reported",
          completedAt: at,
          tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost: 0,
        });
      }
    });

    const routing = pinRouting({ mode: "auto", headroomWeight: 0, minSpareAttempts: 0, maxExploreShare: 1 }, "supervised", lineup, ENDED)!;
    const rec = new RoutingRecorder({ store, now: () => NOW });
    let hitHeadroomGuard = false;
    for (let i = 0; i < 40; i++) {
      const run = ({ id: `run-guard-${i}`, revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
      const task = ({ id: `task-guard-${i}`, title: `t-${i}`, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
      run.tasks.push(task);
      rec.applyStart({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), limitHistory, prices: PRICES });
      const row = store.read(db => taskDecisions(db, run.id, task.id)).rows[0]!;
      if (row.basis === "greedy-headroom") {
        hitHeadroomGuard = true;
        assert.equal(row.explore, false);
        assert.equal(row.chosenProfileId, "codex-a");
        assert.equal(row.payload?.guards?.nearLimit, true);
        break;
      }
    }
    assert.equal(hitHeadroomGuard, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providerHeadroom keeps exactly 20% headroom outside the near-limit guard in both USD and tokens", () => {
  const e1 = before(4 * DAY);
  const e2 = before(2 * DAY);
  const events: ProviderLimitEvent[] = [
    { provider: "codex", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "s1" },
    { provider: "codex", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "s2" },
  ];
  const exactUsd = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events,
    usage: [
      { completedAt: before(HOUR, e1), listUsd: 100, tokens: 1000 },
      { completedAt: before(HOUR, e2), listUsd: 100, tokens: 1000 },
      { completedAt: before(HOUR, NOW), listUsd: 80, tokens: 800 },
    ],
    now: NOW,
  });
  assert.equal(exactUsd.basis, "estimated");
  assert.equal(exactUsd.unit, "usd");
  assert.equal(exactUsd.headroom, 0.2);
  assert.equal(exactUsd.near, false);
  assert.ok(Math.abs(exactUsd.pressure - 0.6) < 1e-12);

  const justBelow = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events,
    usage: [
      { completedAt: before(HOUR, e1), listUsd: 100, tokens: 1000 },
      { completedAt: before(HOUR, e2), listUsd: 100, tokens: 1000 },
      { completedAt: before(HOUR, NOW), listUsd: 80.01, tokens: 800 },
    ],
    now: NOW,
  });
  assert.equal(justBelow.near, true);

  const exactTokens = providerHeadroom({
    provider: "codex",
    limited: new Set(),
    events,
    usage: [
      { completedAt: before(HOUR, e1), listUsd: null, tokens: 100 },
      { completedAt: before(HOUR, e2), listUsd: null, tokens: 100 },
      { completedAt: before(HOUR, NOW), listUsd: null, tokens: 80 },
    ],
    now: NOW,
  });
  assert.equal(exactTokens.basis, "estimated");
  assert.equal(exactTokens.unit, "tokens");
  assert.equal(exactTokens.headroom, 0.2);
  assert.equal(exactTokens.near, false);
});

test("readProviderHeadrooms queries only qualifying providers and never treats reportedCost as list USD", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-headroom-filter-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(usageModule);
    const e1 = before(4 * DAY);
    const e2 = before(2 * DAY);
    const events: ProviderLimitEvent[] = [
      { provider: "opencode", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "oc-1" },
      { provider: "opencode", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "oc-2" },
    ];
    store.write(tx => {
      for (const [sid, at, tokens, reportedCost] of [
        ["oc-1", before(HOUR, e1), 1000, 10],
        ["oc-2", before(HOUR, e2), 1000, 10],
        ["oc-now", before(HOUR, NOW), 850, 1],
      ] as const) {
        writeSession(tx, { sessionId: sid, provider: "opencode", projectId: "rehearsal", createdAt: at }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
        writeRecord(tx, sid, {
          provider: "opencode",
          providerId: "custom",
          modelId: "unlisted-model",
          messageId: `m-${sid}`,
          partId: `p-${sid}`,
          modelSource: "reported",
          completedAt: at,
          tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost,
        });
      }
      writeSession(tx, { sessionId: "cl-1", provider: "claude", projectId: "rehearsal", createdAt: before(HOUR, NOW) }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "cl-1", {
        provider: "claude",
        providerId: "anthropic",
        modelId: "unrelated-model",
        messageId: "m-cl",
        partId: "p-cl",
        modelSource: "reported",
        completedAt: before(HOUR, NOW),
        tokens: { input: 500, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        reportedCost: 0,
      });
      tx.run("UPDATE usage_models SET encrypted_model='corrupt' WHERE model_ref=(SELECT model_ref FROM usage_records WHERE session_id='cl-1')");
    });

    const headrooms = store.read(db => readProviderHeadrooms(db, ["opencode", "claude"], new Set(), events, {}, NOW));
    assert.equal(headrooms.get("claude")?.basis, "unestimated");
    const oc = headrooms.get("opencode")!;
    assert.equal(oc.basis, "estimated");
    assert.equal(oc.unit, "tokens");
    assert.ok(Math.abs(oc.headroom! - 0.15) < 1e-12);
    assert.equal(oc.near, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-upgrade v1/v2 pins keep deterministic tier defaults and unmodelled headroom while v3 scouts use observed listUsd", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-routing-versioning-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    store.register(usageModule);

    const codexLight: TeamModelProfile = { id: "codex-light", label: "Codex Light", provider: "codex", model: "gpt-light", effort: "high", tier: "light" };
    const claudeLight: TeamModelProfile = { id: "claude-light", label: "Claude Light", provider: "claude", model: "claude-light", effort: "high", tier: "light" };
    const claudeStrong: TeamModelProfile = { id: "claude-strong", label: "Claude Strong", provider: "claude", model: "claude-strong", effort: "high", tier: "strong" };
    const lineup: TeamLineup = {
      ...mixedLineup,
      implementers: [codexLight, claudeLight, claudeStrong],
      reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-rev", effort: "xhigh" },
    };

    const scoutOutcome = (id: string, profile: TeamModelProfile, listUsd: number): OutcomeRow => ({
      ...outcomeWithCost(id, profile, "cfg-none", listUsd),
      role: "scout",
      disposition: "completed",
      integrated: null,
      accepted: null,
      acceptance: null,
      firstPass: null,
      held: null,
      frozenAt: null,
      payload: {
        projectId: "rehearsal",
        taskId: "scout-x",
        area: "(scout)",
        featureMap: "default",
        rounds: { run: 0, attributed: 0, unknown: 0 },
        limitEvents: 0,
        costCoverage: "complete",
        listUsd,
      },
    });

    store.write(tx => {
      config(tx, "cfg-codex", codexLight);
      config(tx, "cfg-claude-strong", claudeStrong);
      for (let i = 0; i < 5; i++) {
        writeOutcome(tx, outcomeWithCost(`imp-codex-${i}`, codexLight, "cfg-codex", 3.5));
        writeOutcome(tx, outcomeWithCost(`imp-claude-${i}`, claudeStrong, "cfg-claude-strong", 0.1));
        writeOutcome(tx, scoutOutcome(`sc-codex-${i}`, codexLight, 1.4));
        writeOutcome(tx, scoutOutcome(`sc-claude-${i}`, claudeLight, 0.15));
      }
    });

    const v3Pin = pinRouting({ mode: "auto", points: ["start", "scout"], listWeight: 1, successValueUsd: 2, headroomWeight: 1 }, "supervised", lineup, ENDED)!;
    assert.equal(v3Pin.algorithmVersion, 3);
    const v1Pin = { ...v3Pin, algorithmVersion: 1 };
    const v2Pin = { ...v3Pin, algorithmVersion: 2 };
    const rec = new RoutingRecorder({ store, now: () => NOW });

    const runV1 = ({ id: "run-v1", revision: 1, projectId: "rehearsal", lineup, routing: v1Pin, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const taskV1 = ({ id: "task-v1", title: "v1", instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
    runV1.tasks.push(taskV1);
    rec.applyStart({ run: runV1, task: taskV1, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set() });
    const rowV1 = store.read(db => taskDecisions(db, "run-v1", "task-v1")).rows[0]!;
    assert.equal(rowV1.algorithmVersion, 1);
    assert.equal(rowV1.greedyProfileId, "codex-light");
    assert.equal(rowV1.payload?.costs.basis, "tier-default");
    assert.equal(rowV1.payload?.headroom, "not-modelled");

    const runV3 = ({ id: "run-v3", revision: 1, projectId: "rehearsal", lineup, routing: v3Pin, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const taskV3 = ({ id: "task-v3", title: "v3", instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
    runV3.tasks.push(taskV3);
    rec.applyStart({ run: runV3, task: taskV3, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set() });
    const rowV3 = store.read(db => taskDecisions(db, "run-v3", "task-v3")).rows[0]!;
    assert.equal(rowV3.algorithmVersion, 3);
    assert.equal(rowV3.greedyProfileId, "claude-strong");
    assert.equal(rowV3.payload?.costs.basis, "mixed");
    assert.equal(rowV3.payload?.headroom, "modelled");

    const scout: TeamScout = { id: "scout-1", title: "look", instructions: "look" } as unknown as TeamScout;
    const scoutRunV2 = ({ id: "run-scout-v2", revision: 1, projectId: "rehearsal", lineup, routing: v2Pin, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const chosenV2 = decideAutoScout(store, { run: scoutRunV2, scout, featureMap: undefined, limited: new Set() }, () => NOW, () => 0);
    assert.equal(chosenV2?.profile.id, "codex-light");
    const scoutRowV2 = store.read(db => taskDecisions(db, "run-scout-v2", "scout-1")).rows[0]!;
    assert.equal(scoutRowV2.payload?.costs.basis, "tier-default");

    const scoutRunV3 = ({ id: "run-scout-v3", revision: 1, projectId: "rehearsal", lineup, routing: v3Pin, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const chosenV3 = decideAutoScout(store, { run: scoutRunV3, scout, featureMap: undefined, limited: new Set() }, () => NOW, () => 0);
    assert.equal(chosenV3?.profile.id, "claude-light");
    const scoutRowV3 = store.read(db => taskDecisions(db, "run-scout-v3", "scout-1")).rows[0]!;
    assert.equal(scoutRowV3.payload?.costs.basis, "observed");
    assert.deepEqual(scoutRowV3.payload?.candidates.map(c => [c.profileId, c.costUsd, c.costBasis]), [
      ["codex-light", 1.4, "observed"],
      ["claude-light", 0.15, "observed"],
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ProviderLimits.reconcile preserves credit limits and counts repeated signals without recovery as one episode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-limit-reconcile-"));
  const file = join(dir, "provider-limits.sealed");
  const key = randomBytes(32);
  try {
    const limits = new ProviderLimits(file, key);
    const sessions = { events: () => ({ events: [], cursor: 0, more: false }) };
    await limits.reconcile(sessions, [
      { id: "s-credit", provider: "codex", attention: { limit: { limit: "credits", confidence: "corroborated", since: before(2 * HOUR) } } },
    ], new Date(NOW));
    await limits.reconcile(sessions, [
      { id: "s-usage-1", provider: "claude", attention: { limit: { limit: "usage", confidence: "corroborated", since: before(2 * HOUR) } } },
    ], new Date(NOW));
    await limits.reconcile(sessions, [
      { id: "s-usage-1", provider: "claude", attention: { limit: { limit: "usage", confidence: "corroborated", since: before(HOUR) } } },
    ], new Date(NOW));

    const reopened = new ProviderLimits(file, key);
    const events = reopened.history(new Date(NOW));
    assert.deepEqual(events.map(item => [item.provider, item.limit, item.detectedAt]), [
      ["codex", "credits", before(2 * HOUR)],
      ["claude", "usage", before(2 * HOUR)],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RoutingRecorder caches headroom off the decision path and invalidates on usage writes and window expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-headroom-cache-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    store.register(usageModule);

    const codexLight: TeamModelProfile = { id: "codex-light", label: "Codex Light", provider: "codex", model: "gpt-light", effort: "high", tier: "light" };
    const claudeStrong: TeamModelProfile = { id: "claude-strong", label: "Claude Strong", provider: "claude", model: "claude-strong", effort: "high", tier: "strong" };
    const claudeEscalation: TeamModelProfile = { id: "claude-esc", label: "Claude Esc", provider: "claude", model: "claude-strong", effort: "xhigh", tier: "strong" };
    const codexEscalation: TeamModelProfile = { id: "codex-esc", label: "Codex Esc", provider: "codex", model: "gpt-light", effort: "xhigh", tier: "strong" };
    const lineup: TeamLineup = {
      ...mixedLineup,
      implementers: [codexLight, claudeStrong],
      escalations: [codexEscalation, claudeEscalation],
      reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-rev", effort: "xhigh" },
    };

    const e1 = before(4 * DAY);
    const e2 = before(2 * DAY);
    const limitHistory: ProviderLimitEvent[] = [
      { provider: "claude", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "s-e1" },
      { provider: "claude", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "s-e2" },
    ];
    store.write(tx => {
      for (const [sid, at, tokens] of [
        ["s-e1", before(HOUR, e1), 4_000_000],
        ["s-e2", before(HOUR, e2), 4_000_000],
        ["s-now", before(2 * HOUR, NOW), 3_000_000],
      ] as const) {
        writeSession(tx, { sessionId: sid, provider: "claude", projectId: "rehearsal", createdAt: at }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
        writeRecord(tx, sid, {
          provider: "claude",
          providerId: "anthropic",
          modelId: "claude-strong",
          messageId: `m-${sid}`,
          partId: `p-${sid}`,
          modelSource: "reported",
          completedAt: at,
          tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost: 0,
        });
      }
    });

    let usageRecordScans = 0;
    const rawRead = store.read.bind(store);
    store.read = (<T>(fn: Parameters<EvidenceStore["read"]>[0]): T => rawRead(db => {
      const wrapped = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "all") {
            return (sql: string, ...params: unknown[]) => {
              if (sql.includes("FROM usage_records")) usageRecordScans++;
              return target.all(sql, ...params);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return fn(wrapped);
    })) as EvidenceStore["read"];

    let clockNow = NOW;
    const routing = pinRouting({ mode: "auto", points: ["start", "escalation"], listWeight: 0.25, successValueUsd: 4, headroomWeight: 1 }, "supervised", lineup, ENDED)!;
    const rec = new RoutingRecorder({ store, now: () => clockNow });

    rec.refreshHeadrooms(lineup, limitHistory, PRICES);
    assert.equal(usageRecordScans, 1);
    usageRecordScans = 0;

    for (let i = 0; i < 4; i++) {
      const run = ({ id: `run-warm-${i}`, revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
      const task = ({ id: `task-warm-${i}`, title: `t-${i}`, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
      run.tasks.push(task);
      rec.applyStart({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), limitHistory, prices: PRICES });
      rec.routeEscalation({
        run,
        task,
        ownProfileId: "codex-light",
        namedProfileId: undefined,
        publishHeads: false,
        entryTools: false,
        objectiveDigest: false,
        codeMode: false,
        featureMap: undefined,
        limited: new Set(),
        limitHistory,
        prices: PRICES,
      });
    }
    assert.equal(usageRecordScans, 0);

    const lazy = new RoutingRecorder({ store, now: () => clockNow });
    for (let i = 0; i < 4; i++) {
      const run = ({ id: `run-lazy-${i}`, revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
      const task = ({ id: `task-lazy-${i}`, title: `t-${i}`, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
      run.tasks.push(task);
      lazy.applyStart({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), limitHistory, prices: PRICES });
    }
    assert.equal(usageRecordScans, 1);

    store.write(tx => {
      writeSession(tx, { sessionId: "s-more", provider: "claude", projectId: "rehearsal", createdAt: before(HOUR / 2, NOW) }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "s-more", {
        provider: "claude",
        providerId: "anthropic",
        modelId: "claude-strong",
        messageId: "m-more",
        partId: "p-more",
        modelSource: "reported",
        completedAt: before(HOUR / 2, NOW),
        tokens: { input: 800_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        reportedCost: 0,
      });
    });

    const runAfterWrite = ({ id: "run-after-write", revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const taskAfterWrite = ({ id: "task-after-write", title: "tw", instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
    runAfterWrite.tasks.push(taskAfterWrite);
    lazy.applyStart({ run: runAfterWrite, task: taskAfterWrite, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), limitHistory, prices: PRICES });
    assert.equal(usageRecordScans, 2);
    const afterWriteRow = rawRead(db => taskDecisions(db, runAfterWrite.id, taskAfterWrite.id)).rows[0]!;
    const afterWriteClaude = afterWriteRow.payload?.candidates.find(c => c.profileId === "claude-strong");
    assert.ok((afterWriteClaude?.pressure ?? 0) > 0.85);

    clockNow = after(3 * HOUR, NOW);
    const runAfterExpiry = ({ id: "run-after-expiry", revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
    const taskAfterExpiry = ({ id: "task-after-expiry", title: "te", instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending" }) as unknown as TeamTask;
    runAfterExpiry.tasks.push(taskAfterExpiry);
    lazy.applyStart({ run: runAfterExpiry, task: taskAfterExpiry, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), limitHistory, prices: PRICES });
    assert.equal(usageRecordScans, 3);
    const afterExpiryRow = rawRead(db => taskDecisions(db, runAfterExpiry.id, taskAfterExpiry.id)).rows[0]!;
    const afterExpiryClaude = afterExpiryRow.payload?.candidates.find(c => c.profileId === "claude-strong");
    assert.equal(afterExpiryClaude?.pressure, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProviderHeadrooms isolates corrupt usage_models per provider, treats Codex cacheWrite as unpriced, and routingStatus includes escalation-only providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-headroom-isolation-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    store.register(usageModule);

    const e1 = before(4 * DAY);
    const e2 = before(2 * DAY);
    const limitHistory: ProviderLimitEvent[] = [
      { provider: "claude", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "cl-e1" },
      { provider: "claude", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "cl-e2" },
      { provider: "codex", limit: "usage", detectedAt: e1, resetsAt: after(5 * HOUR, e1), sessionId: "cx-e1" },
      { provider: "codex", limit: "usage", detectedAt: e2, resetsAt: after(5 * HOUR, e2), sessionId: "cx-e2" },
    ];
    store.write(tx => {
      for (const [sid, at, tokens, cacheWrite] of [
        ["cx-e1", before(HOUR, e1), 1_000_000, 0],
        ["cx-e2", before(HOUR, e2), 1_000_000, 0],
        ["cx-now", before(HOUR, NOW), 800_000, 50_000],
      ] as const) {
        writeSession(tx, { sessionId: sid, provider: "codex", projectId: "rehearsal", createdAt: at }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
        writeRecord(tx, sid, {
          provider: "codex",
          providerId: "openai",
          modelId: "gpt-light",
          messageId: `m-${sid}`,
          partId: `p-${sid}`,
          modelSource: "reported",
          completedAt: at,
          tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite },
          reportedCost: 0,
        });
      }
      writeSession(tx, { sessionId: "cl-bad", provider: "claude", projectId: "rehearsal", createdAt: before(HOUR, NOW) }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "cl-bad", {
        provider: "claude",
        providerId: "anthropic",
        modelId: "claude-strong",
        messageId: "m-cl-bad",
        partId: "p-cl-bad",
        modelSource: "reported",
        completedAt: before(HOUR, NOW),
        tokens: { input: 500_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        reportedCost: 0,
      });
      tx.run("UPDATE usage_models SET encrypted_model='corrupt' WHERE model_ref=(SELECT model_ref FROM usage_records WHERE session_id='cl-bad')");
    });

    const isolated = store.read(db => readProviderHeadrooms(db, ["claude", "codex"], new Set(), limitHistory, PRICES, NOW));
    assert.deepEqual(isolated.get("claude"), { headroom: null, basis: "unestimated", pressure: 0, near: false });
    const codex = isolated.get("codex")!;
    assert.equal(codex.basis, "estimated");
    assert.equal(codex.unit, "tokens");
    assert.ok(Math.abs(codex.headroom! - 0.15) < 1e-12);
    assert.equal(codex.near, true);

    const codexLight: TeamModelProfile = { id: "codex-light", label: "Codex Light", provider: "codex", model: "gpt-light", effort: "high", tier: "light" };
    const claudeEsc: TeamModelProfile = { id: "claude-esc", label: "Claude Esc", provider: "claude", model: "claude-strong", effort: "high", tier: "strong" };
    const escLineup: TeamLineup = {
      ...mixedLineup,
      implementers: [codexLight],
      escalations: [claudeEsc],
      reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-rev", effort: "xhigh" },
    };

    const withEscalation = routingStatus(store, {
      projectId: "rehearsal",
      saved: { mode: "auto", points: ["start", "escalation"] },
      autonomy: "supervised",
      lineup: escLineup,
      publishHeads: false,
      entryTools: false,
      objectiveDigest: false,
      codeMode: false,
      now: NOW,
      limitHistory,
      prices: PRICES,
    });
    assert.equal(withEscalation.providers?.codex?.basis, "estimated");
    assert.equal(withEscalation.providers?.codex?.unit, "tokens");
    assert.deepEqual(withEscalation.providers?.claude, { headroom: null, basis: "unestimated", pressure: 0, near: false });

    const startOnly = routingStatus(store, {
      projectId: "rehearsal",
      saved: { mode: "auto", points: ["start"] },
      autonomy: "supervised",
      lineup: escLineup,
      publishHeads: false,
      entryTools: false,
      objectiveDigest: false,
      codeMode: false,
      now: NOW,
      limitHistory,
      prices: PRICES,
    });
    assert.equal(startOnly.providers?.codex?.basis, "estimated");
    assert.equal(startOnly.providers?.claude, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
