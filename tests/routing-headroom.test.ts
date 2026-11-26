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
import { routingStatus } from "../packages/host/src/routing-reads.js";
import { RoutingRecorder, type RouterStart } from "../packages/host/src/routing-recorder.js";
import { routingModule, taskDecisions } from "../packages/host/src/routing-store.js";
import { taskFeatures } from "../packages/host/src/task-features.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
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
