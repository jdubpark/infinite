import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readConfig } from "../packages/host/src/config.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evaluateFuse } from "../packages/host/src/eval-budget.js";
import { FuseService, type FuseView } from "../packages/host/src/fuse/service.js";
import { fuseReason, isFuseReason } from "../packages/host/src/fuse/rules.js";
import { createFuseSpendReader } from "../packages/host/src/fuse/usage-reader.js";
import type { FuseLaunch, FuseSpendReader, FuseSpendSample } from "../packages/host/src/fuse/types.js";
import { fuseLines } from "../packages/host/src/client.js";
import type { Manager } from "../packages/host/src/manager.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import { writeRecord, writeSession } from "../packages/host/src/usage-store.js";
import { FuseBanner } from "../apps/web/src/fuse-banner";
import { HaltBanner } from "../apps/web/src/halt-banner";
import type { HaltNotice } from "../apps/web/src/halt";

(globalThis as { React?: unknown }).React = React;

const START = Date.parse("2026-11-13T10:00:00.000Z");
const DAY = 86_400_000;

function launch(id: string, projectId = "p"): FuseLaunch {
  return { launchId: id, projectId, purpose: "work", role: "implementer", profileId: "claude-haiku" };
}

function setupRig(fuse: unknown, spend?: FuseSpendReader) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fuse-spend-")));
  mkdirSync(join(root, "project-p"), { recursive: true });
  mkdirSync(join(root, "project-q"), { recursive: true });
  writeFileSync(join(root, "key"), randomBytes(32), { mode: 0o600 });
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify({
    port: 4780,
    origin: "http://127.0.0.1:4780",
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    keyFile: join(root, "key"),
    environment: "local",
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: "a".repeat(64) }],
    projects: [
      { id: "p", name: "Project P", path: join(root, "project-p") },
      { id: "q", name: "Project Q", path: join(root, "project-q") },
    ],
    autonomy: { fuse },
  }));
  const { config, key } = readConfig(file);
  mkdirSync(config.stateDir, { recursive: true });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(config.stateDir), vaultKey: key });
  const clock = { now: START };
  const service = new FuseService({ config, key, store, sessionExists: () => false, spend, now: () => clock.now });
  return {
    config,
    key,
    store,
    clock,
    service,
    close() {
      try { store.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("config parses day/week spend ceilings and unmeasured estimates", () => {
  const r = setupRig({
    host: {
      launchesPerHour: 50,
      day: { tokens: 100_000, listUsd: 5, spentUsd: 2.5 },
      week: { tokens: 500_000, listUsd: 25, spentUsd: 10 },
      unmeasuredTokenEstimate: 20_000,
      unmeasuredUsdEstimate: 0.25,
    },
    project: { day: { tokens: 40_000 }, week: { spentUsd: 4 } },
    projects: { p: { day: { listUsd: 3 } } },
  });
  try {
    const fuse = r.config.autonomy?.fuse;
    assert.equal(fuse?.host?.day?.tokens, 100_000);
    assert.equal(fuse?.host?.week?.spentUsd, 10);
    assert.equal(fuse?.host?.unmeasuredTokenEstimate, 20_000);
    assert.equal(fuse?.host?.unmeasuredUsdEstimate, 0.25);
    assert.equal(fuse?.project?.day?.tokens, 40_000);
    assert.equal(fuse?.projects?.p?.day?.listUsd, 3);
  } finally { r.close(); }
});

test("spend fuse trips on tokens, list-usd, and spent-usd across day/week and host/project", () => {
  const sample: FuseSpendSample = { tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available: true };
  const calls: { scope: string; projectId?: string; window: string; sinceMs: number }[] = [];
  const reader: FuseSpendReader = (input) => {
    calls.push({ scope: input.scope, projectId: input.projectId, window: input.window, sinceMs: input.sinceMs });
    return { ...sample };
  };
  const r = setupRig({
    host: { day: { tokens: 1_000 }, week: { spentUsd: 5 } },
    projects: { p: { day: { listUsd: 2 }, week: { tokens: 2_000 } } },
  }, reader);
  try {
    assert.equal(r.service.check({ projectId: "p" }).state, "closed");
    assert.equal(calls.some(c => c.scope === "host" && c.window === "day" && c.sinceMs === Date.parse("2026-11-13T00:00:00.000Z")), true);
    assert.equal(calls.some(c => c.scope === "host" && c.window === "week" && c.sinceMs === START - 7 * DAY), true);

    sample.tokens = 1_000;
    const hostTokens = r.service.check({ projectId: "q" });
    assert.equal(hostTokens.state, "open");
    if (hostTokens.state === "open") {
      assert.equal(hostTokens.scope, "host");
      assert.equal(hostTokens.window, "day");
      assert.equal(hostTokens.cause, "tokens");
      assert.equal(hostTokens.ownerClose, true);
    }

    sample.tokens = 0;
    sample.spentUsd = 5;
    const hostSpent = r.service.check({ projectId: "q" });
    assert.equal(hostSpent.state, "open");
    if (hostSpent.state === "open") {
      assert.equal(hostSpent.scope, "host");
      assert.equal(hostSpent.window, "week");
      assert.equal(hostSpent.cause, "spent-usd");
    }

    sample.spentUsd = 0;
    sample.listUsd = 2;
    const projList = r.service.check({ projectId: "p" });
    assert.equal(projList.state, "open");
    if (projList.state === "open") {
      assert.equal(projList.scope, "project");
      assert.equal(projList.projectId, "p");
      assert.equal(projList.window, "day");
      assert.equal(projList.cause, "list-usd");
    }

    const admitted = r.service.admit(launch("L1", "p"));
    assert.equal(admitted.ok, false);
    if (!admitted.ok && "open" in admitted) {
      assert.ok(admitted.open.tripId);
      assert.equal(admitted.open.cause, "list-usd");
      assert.equal(admitted.open.ownerClose, true);
    }
    assert.equal(r.service.interrupts().length, 1);
  } finally { r.close(); }
});

test("unmeasured sessions count at estimates and never as zero", () => {
  const sample: FuseSpendSample = { tokens: 10_000, listUsd: 0.1, spentUsd: 0.1, unmeasuredSessions: 1, available: true };
  const r = setupRig({
    project: { day: { tokens: 60_000, listUsd: 0.6 } },
  }, () => sample);
  try {
    const view = r.service.view().projects.find(p => p.projectId === "p")!;
    assert.equal(view.state, "open");
    assert.equal(view.trip?.cause, "tokens");
    assert.equal(view.day?.tokens, 60_000);
    assert.equal(view.day?.listUsd, 0.6);
    assert.equal(view.day?.unmeasuredSessions, 1);
  } finally { r.close(); }
});

test("unmeasurable spend fails closed and recovers when available again", () => {
  let available = false;
  const r = setupRig({
    project: { day: { spentUsd: 10 } },
  }, () => ({ tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available }));
  try {
    const check = r.service.check({ projectId: "p" });
    assert.equal(check.state, "open");
    if (check.state === "open") {
      assert.equal(check.cause, "unmeasurable");
      assert.equal(check.ownerClose, false);
      assert.equal(check.window, "day");
    }
    assert.equal(r.service.admit(launch("U1", "p")).ok, false);
    assert.equal(r.service.close({ scope: "project", projectId: "p" }), "not-open");

    available = true;
    assert.equal(r.service.check({ projectId: "p" }).state, "closed");
    assert.equal(r.service.admit(launch("U2", "p")).ok, true);
  } finally { r.close(); }
});

test("owner close resets spend fuse and advances window cutoff", () => {
  const records = [{ at: START - 10_000, tokens: 1_500, listUsd: 3, spentUsd: 1 }];
  const reader: FuseSpendReader = ({ sinceMs, now }) => {
    let tokens = 0, listUsd = 0, spentUsd = 0;
    for (const rec of records) {
      if (rec.at >= sinceMs && rec.at <= now) {
        tokens += rec.tokens;
        listUsd += rec.listUsd;
        spentUsd += rec.spentUsd;
      }
    }
    return { tokens, listUsd, spentUsd, unmeasuredSessions: 0, available: true };
  };
  const r = setupRig({
    project: { day: { tokens: 1_000 } },
  }, reader);
  try {
    const refused = r.service.admit(launch("S1", "p"));
    assert.equal(refused.ok, false);
    assert.equal(r.service.view().projects[0]!.state, "open");

    assert.equal(r.service.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(r.service.check({ projectId: "p" }).state, "closed");
    assert.equal(r.service.view().projects[0]!.day?.tokens, 0);
    assert.equal(r.service.admit(launch("S2", "p")).ok, true);

    r.clock.now += 5_000;
    records.push({ at: r.clock.now, tokens: 1_000, listUsd: 1, spentUsd: 0.5 });
    const reTripped = r.service.check({ projectId: "p" });
    assert.equal(reTripped.state, "open");
    if (reTripped.state === "open") assert.equal(reTripped.cause, "tokens");
  } finally { r.close(); }
});

test("createFuseSpendReader delegates to source and fails closed on throw", () => {
  let ok = true;
  const reader = createFuseSpendReader(() => {
    if (!ok) throw new Error("boom");
    return {
      spendWindow: ({ scope }) => ({ tokens: scope === "host" ? 10 : 5, listUsd: 0.2, spentUsd: 0.1, unmeasuredSessions: 0, available: true }),
    };
  });
  assert.equal(reader({ scope: "host", window: "day", sinceMs: 0, now: 100 }).tokens, 10);
  ok = false;
  assert.deepEqual(reader({ scope: "host", window: "day", sinceMs: 0, now: 100 }), {
    tokens: 0,
    listUsd: 0,
    spentUsd: 0,
    unmeasuredSessions: 0,
    available: false,
  });
});

test("fuseReason and fuseLines format spend causes cleanly", () => {
  for (const cause of ["tokens", "list-usd", "spent-usd"] as const) {
    const reason = fuseReason({ state: "open", scope: "project", projectId: "p", window: "day", cause, ownerClose: true });
    assert.equal(isFuseReason(reason), true);
    assert.doesNotMatch(reason, /\d/);
    assert.ok(reason.endsWith("It stays open until the owner closes it."));
  }
  const view: FuseView = {
    authoritative: true,
    host: {
      state: "open",
      trip: { cause: "spent-usd", window: "week", ownerClose: true },
      hour: { launches: 2, limit: 80 },
      week: { tokens: 1000, listUsd: 4, spentUsd: 10, spentUsdLimit: 10, unmeasuredSessions: 0, available: true },
    },
    projects: [
      {
        projectId: "p",
        state: "closed",
        hour: { launches: 1, limit: 30 },
        day: { tokens: 500, tokensLimit: 1000, listUsd: 0.5, spentUsd: 0.25, unmeasuredSessions: 1, available: true },
      },
    ],
  };
  const lines = fuseLines(view);
  assert.match(lines[0]!, /Host: open \(week metered spend limit, the owner must close it\); week: \$10\.00\/\$10\.00 spent/);
  assert.match(lines[1]!, /Project p: closed, 1 of 30 launches in the last hour; day: 500\/1000 tokens, 1 unmeasured/);
});

test("web HaltBanner and FuseBanner render owner controls and hide them for viewer", () => {
  const halt: HaltNotice = { kind: "host", halt: { haltId: "h1", at: "2026-11-13T10:00:00.000Z", by: "Owner" }, projects: [] };
  const ownerHaltHtml = renderToStaticMarkup(createElement(HaltBanner, { notice: halt, name: id => id, owner: true, onRelease: () => {} }));
  const viewerHaltHtml = renderToStaticMarkup(createElement(HaltBanner, { notice: halt, name: id => id, owner: false, onRelease: () => {} }));
  assert.ok(ownerHaltHtml.includes("Release halt"));
  assert.ok(!viewerHaltHtml.includes("Release halt"));

  const fuseView: FuseView = {
    authoritative: true,
    host: {
      state: "open",
      trip: { tripId: "t1", cause: "tokens", window: "day", ownerClose: true },
      hour: { launches: 1, limit: 80 },
      day: { tokens: 100_000, tokensLimit: 100_000, listUsd: 1, spentUsd: 0.5, unmeasuredSessions: 0, available: true },
    },
    projects: [],
  };
  const ownerFuseHtml = renderToStaticMarkup(createElement(FuseBanner, { view: fuseView, name: id => id, owner: true, onClose: () => {} }));
  const viewerFuseHtml = renderToStaticMarkup(createElement(FuseBanner, { view: fuseView, name: id => id, owner: false, onClose: () => {} }));
  const remoteFuseHtml = renderToStaticMarkup(createElement(FuseBanner, { view: fuseView, name: id => id, owner: true, remoteDenied: true, onClose: () => {} }));
  assert.ok(ownerFuseHtml.includes("Close fuse"));
  assert.ok(ownerFuseHtml.includes("daily token ceiling reached"));
  assert.ok(!viewerFuseHtml.includes("Close fuse"));
  assert.ok(!remoteFuseHtml.includes("Close fuse"));
});

test("tick persists spend trip across UTC midnight and emits interrupt without admit", () => {
  const sample: FuseSpendSample = { tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available: true };
  const r = setupRig({
    project: { day: { tokens: 1_000 } },
  }, () => ({ ...sample }));
  try {
    assert.equal(r.service.interrupts().length, 0);

    sample.tokens = 1_200;
    assert.equal(r.service.tick(), true);

    const interrupts = r.service.interrupts();
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0]!.scope, "project");
    assert.equal(interrupts[0]!.projectId, "p");
    assert.equal(interrupts[0]!.cause, "tokens");
    assert.equal(interrupts[0]!.window, "day");
    assert.equal(interrupts[0]!.ownerClose, true);

    assert.equal(r.service.tick(), true);
    assert.equal(r.service.interrupts().length, 1);
    r.service.markAnnounced(interrupts.map(item => item.tripId));
    assert.equal(r.service.interrupts().length, 0);

    const check = r.service.check({ projectId: "p" });
    assert.deepEqual(evaluateFuse(() => check, "p"), { state: "open", cause: "tokens" });

    sample.tokens = 0;
    r.clock.now += DAY;
    assert.equal(r.service.tick(), true);
    const nextDayCheck = r.service.check({ projectId: "p" });
    assert.equal(nextDayCheck.state, "open");
    if (nextDayCheck.state === "open") {
      assert.equal(nextDayCheck.tripId, interrupts[0]!.tripId);
      assert.equal(nextDayCheck.ownerClose, true);
    }

    assert.equal(r.service.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(r.service.check({ projectId: "p" }).state, "closed");
  } finally { r.close(); }
});

test("tick emits at-most-once-per-UTC-day unmeasurable interrupt and clears on recovery", () => {
  let available = true;
  const r = setupRig({
    project: { day: { spentUsd: 10 } },
  }, () => ({ tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available }));
  try {
    assert.equal(r.service.tick(), true);
    assert.equal(r.service.interrupts().length, 0);

    available = false;
    assert.equal(r.service.tick(), true);
    const first = r.service.interrupts();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.cause, "unmeasurable");
    assert.equal(first[0]!.scope, "project");
    assert.equal(first[0]!.projectId, "p");
    assert.equal(first[0]!.window, "day");
    assert.equal(first[0]!.ownerClose, false);

    r.service.markAnnounced(first.map(item => item.tripId));
    assert.equal(r.service.interrupts().length, 0);

    available = true;
    assert.equal(r.service.tick(), true);
    assert.equal(r.service.interrupts().length, 0);

    available = false;
    assert.equal(r.service.tick(), true);
    assert.equal(r.service.interrupts().length, 0);

    r.clock.now += DAY;
    assert.equal(r.service.tick(), true);
    const nextDay = r.service.interrupts();
    assert.equal(nextDay.length, 1);
    assert.equal(nextDay[0]!.cause, "unmeasurable");

    available = true;
    assert.equal(r.service.tick(), true);
    assert.equal(r.service.interrupts().length, 0);
  } finally { r.close(); }
});

test("UsageService.spendWindow marks partial sessions, ingestion gaps, and unpriced records as unmeasured", async () => {
  const r = setupRig({
    project: { day: { listUsd: 1 } },
  });
  try {
    let failEvents = false;
    const manager = {
      list: async () => [],
      events: (id: string) => {
        if (failEvents && id === "s-gap") throw new Error("read failed");
        return { events: [], cursor: 0, more: false };
      },
    } as unknown as Manager;
    const usage = new UsageService(r.config, r.key, manager, r.store, { now: () => r.clock.now });
    const at = new Date(START - 60_000).toISOString();

    r.store.write(tx => {
      writeSession(tx, { sessionId: "s-partial", provider: "opencode", projectId: "p", createdAt: at, lastActiveAt: at }, {
        coverage: "partial", reason: "recording-error", cursor: 0, seen: 0, refused: 0, exited: true,
      });
      writeSession(tx, { sessionId: "s-drain", provider: "opencode", projectId: "p", createdAt: at, lastActiveAt: at }, {
        coverage: "partial", reason: "drain-incomplete", cursor: 0, seen: 0, refused: 0, exited: true,
      });
      writeSession(tx, { sessionId: "s-claude-known", provider: "claude", projectId: "p", createdAt: at, lastActiveAt: at }, {
        coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true,
      });
      writeRecord(tx, "s-claude-known", {
        provider: "claude", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId: "p1",
        modelSource: "reported", completedAt: at, tokens: { input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
      });
      writeSession(tx, { sessionId: "s-claude-unknown", provider: "claude", projectId: "p", createdAt: at, lastActiveAt: at }, {
        coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true,
      });
      writeRecord(tx, "s-claude-unknown", {
        provider: "claude", providerId: "anthropic", modelId: "unknown-model-xyz", messageId: "m2", partId: "p2",
        modelSource: "reported", completedAt: at, tokens: { input: 500, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
      });
      writeSession(tx, { sessionId: "s-oc-unknown", provider: "opencode", projectId: "p", createdAt: at, lastActiveAt: at }, {
        coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true,
      });
      writeRecord(tx, "s-oc-unknown", {
        provider: "opencode", providerId: "openrouter", modelId: "unknown-oc-model", messageId: "m3", partId: "p3",
        modelSource: "reported", completedAt: at, tokens: { input: 200, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
      });
    });

    const sample = usage.spendWindow({ scope: "project", projectId: "p", sinceMs: START - DAY, now: START });
    assert.equal(sample.available, true);
    assert.equal(sample.unmeasuredSessions, 2);
    assert.equal(sample.unmeasuredListSessions, 2);
    assert.equal(sample.unmeasuredSpentSessions, 1);
    assert.equal(sample.tokens, 1870);

    const claudeOnly = usage.spendWindow({ scope: "project", projectId: "p", sinceMs: START - DAY, now: START });
    assert.ok(claudeOnly.listUsd > 0);
    assert.equal(claudeOnly.spentUsd, 0);

    failEvents = true;
    await usage.tick([{
      id: "s-gap", provider: "claude", projectId: "p", createdAt: at, status: "running",
    } as unknown as UsageSessionRow]);
    const withGap = usage.spendWindow({ scope: "project", projectId: "p", sinceMs: START - DAY, now: START });
    assert.equal(withGap.unmeasuredSessions, 3);
    usage.close();
  } finally { r.close(); }
});

test("closing a spend fuse preserves active launch-rate count and ignores future-skewed timestamps", () => {
  const futureRecords = [{ at: START + 30_000, tokens: 2_000, listUsd: 5, spentUsd: 5 }];
  const r = setupRig({
    project: { launchesPerHour: 10, day: { tokens: 1_000 } },
  }, ({ sinceMs, now }) => {
    let tokens = 0, listUsd = 0, spentUsd = 0;
    for (const rec of futureRecords) {
      if (rec.at >= sinceMs && rec.at <= now) {
        tokens += rec.tokens;
        listUsd += rec.listUsd;
        spentUsd += rec.spentUsd;
      }
    }
    return { tokens, listUsd, spentUsd, unmeasuredSessions: 0, available: true };
  });
  try {
    for (let i = 0; i < 4; i++) assert.equal(r.service.admit(launch(`L${i}`, "p")).ok, true);
    assert.equal(r.service.view().projects[0]!.hour.launches, 4);

    futureRecords.push({ at: START, tokens: 1_500, listUsd: 1, spentUsd: 1 });
    assert.equal(r.service.tick(), true);
    assert.equal(r.service.check({ projectId: "p" }).state, "open");

    assert.equal(r.service.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(r.service.check({ projectId: "p" }).state, "closed");
    assert.equal(r.service.view().projects[0]!.hour.launches, 4);
    assert.equal(r.service.view().projects[0]!.day?.tokens, 0);
    assert.equal(r.service.admit(launch("after-spend-close", "p")).ok, true);
    assert.equal(r.service.view().projects[0]!.hour.launches, 5);
  } finally { r.close(); }
});
