import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configId,
  isRoutingComponent,
  memberConfiguration,
  type ConfigComponents,
} from "../packages/host/src/config-identity.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type EventProjector, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { outcomeModule, readOutcome } from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";

const HEX_A = "a".repeat(64);
const HEX_B = "e".repeat(64);
const DIGEST = "d".repeat(64);
const RUN = "run-1";
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const GIT = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

function components(routing: string): ConfigComponents {
  return {
    profile: { provider: "opencode", model: "vendor/model-a", effort: "high" },
    promptVersion: "a".repeat(64),
    guidance: "b".repeat(64),
    knowledge: "none",
    routing,
    shape: "team",
  };
}

test("a routing component is off or a policy digest, and off keeps main's ids", async () => {
  assert.equal(isRoutingComponent("off"), true);
  assert.equal(isRoutingComponent(DIGEST), true);
  assert.equal(isRoutingComponent("auto"), false);
  assert.equal(isRoutingComponent("shadow"), false);
  assert.equal(isRoutingComponent("d".repeat(63)), false);
  assert.equal(isRoutingComponent("D".repeat(64)), false);
  assert.equal(isRoutingComponent(42), false);
  assert.equal(isRoutingComponent(undefined), false);

  assert.equal(configId(components("off")), "c5116d39b09122c01e533092de4fbe3e670bbb980f98b7bb88f6596d36d28d79");
  assert.equal(configId({ ...components("off"), shape: "trial" }), "e1a5a2791bdf2de118e16779bf79d0bb13321f0715dcb0404cb255471fd3d701");
  assert.equal(
    configId({ ...components("off"), profile: { provider: "claude", model: null, effort: null } }),
    "96ecdf027f058e1fc6035ab603ba18a50a58457a8dc513f953798a5deac9ed17",
  );

  const routed = configId(components(DIGEST));
  assert.notEqual(routed, configId(components("off")));
  assert.match(routed, /^[0-9a-f]{64}$/);
  assert.notEqual(configId(components("e".repeat(64))), routed);

  const root = mkdtempSync(join(tmpdir(), "routing-identity-"));
  try {
    execFileSync("git", ["init", "-q", "--template="], { cwd: root });
    writeFileSync(join(root, "AGENTS.md"), "Fixture guidance.\n");
    execFileSync("git", [...GIT, "add", "AGENTS.md"], { cwd: root });
    execFileSync("git", [...GIT, "commit", "-q", "-m", "guidance"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const signal = new AbortController().signal;
    const input = { workspace: root, baseCommit: head, role: "implementer" as const, provider: "claude" as const, publishHeads: true };

    const plain = await memberConfiguration(input, signal);
    assert.ok(plain);
    assert.equal(plain.routing, "off");
    assert.equal(plain.configId, configId({
      profile: { provider: "claude", model: null, effort: null },
      promptVersion: plain.promptVersion,
      guidance: plain.guidance,
      knowledge: "none",
      routing: "off",
      shape: "team",
    }));

    const routedMember = await memberConfiguration({ ...input, routing: DIGEST }, signal);
    assert.ok(routedMember);
    assert.equal(routedMember.routing, DIGEST);
    assert.equal(routedMember.configId, configId({
      profile: { provider: "claude", model: null, effort: null },
      promptVersion: plain.promptVersion,
      guidance: plain.guidance,
      knowledge: "none",
      routing: DIGEST,
      shape: "team",
    }));
    assert.notEqual(routedMember.configId, plain.configId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

type Harness = { store: EvidenceStore; flush(events: readonly OutboxEvent[]): { stored: boolean; refused: number }; close(): void };

function harness(wrap: (projector: EventProjector) => EventProjector = projector => projector): Harness {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-identity-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => at(59) }));
  const outbox = new EventOutbox(store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(wrap(outcomeProjector(store)));
  return {
    store,
    flush: events => outbox.flush(events),
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;

function ev(kind: string, time: string, fields: { memberId?: string; taskId?: string; data?: Record<string, unknown> } = {}): OutboxEvent {
  counter += 1;
  return {
    key: runEventKey(kind, RUN, [counter]),
    runId: RUN,
    revision: 1,
    at: time,
    kind,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    data: { v: 1, ...(fields.data ?? {}) },
  };
}

function memberEvents(routing: string): OutboxEvent[] {
  const profile = { provider: "claude", model: "m-1", effort: null };
  const configured = { ...components(routing), profile, promptVersion: HEX_A, guidance: HEX_B };
  return [
    ev("run.created", at(0), { data: { projectId: "example", purpose: "work" } }),
    ev("run.prepared", at(0), { data: { baseCommit: BASE } }),
    ev("task.planned", at(1), { taskId: "a", data: { profileId: "impl", paths: ["a.txt"], features: { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" } } }),
    ev("member.started", at(2), {
      memberId: "m1", taskId: "a",
      data: {
        role: "implementer", purpose: "work", sessionId: "session-m1", startedAt: at(2), baseCommit: BASE,
        provider: "claude", profileId: "profile-m-1", model: "m-1",
      },
    }),
    ev("member.configured", at(3), {
      memberId: "m1", taskId: "a",
      data: {
        configId: configId(configured), provider: "claude", model: "m-1",
        promptVersion: HEX_A, guidance: HEX_B, knowledge: "none", routing, shape: "team",
      },
    }),
    ev("member.stopped", at(4), { memberId: "m1", taskId: "a", data: { role: "implementer", reason: "stall", reported: false } }),
  ];
}

test("a routed member's configuration is stored and its outcome row keeps the id", () => {
  const h = harness();
  try {
    const routedId = configId({ ...components(DIGEST), profile: { provider: "claude", model: "m-1", effort: null }, promptVersion: HEX_A, guidance: HEX_B });
    const result = h.flush(memberEvents(DIGEST));
    assert.equal(result.refused, 0);

    const stored = h.store.read(db => db.all<{ config_id: string; routing: string }>("SELECT config_id, routing FROM configurations"));
    assert.deepEqual(stored.map(row => ({ ...row })), [{ config_id: routedId, routing: DIGEST }]);

    const row = h.store.read(db => readOutcome(db, `${RUN}:m1`));
    assert.equal(row?.configId, routedId);
    const joined = h.store.read(db => db.get<{ prompt_version: string | null }>(
      "SELECT c.prompt_version FROM outcomes o LEFT JOIN configurations c ON c.config_id = o.config_id WHERE o.outcome_id = ?",
      `${RUN}:m1`,
    ));
    assert.equal(joined?.prompt_version, HEX_A);
  } finally {
    h.close();
  }
});

test("an auto routing component is not a configuration, so the store and the outcome row refuse it", () => {
  const h = harness();
  try {
    h.flush(memberEvents("auto"));
    const stored = h.store.read(db => db.all("SELECT config_id FROM configurations"));
    assert.deepEqual(stored, []);
    const row = h.store.read(db => readOutcome(db, `${RUN}:m1`));
    assert.ok(row);
    assert.equal(row.configId ?? null, null);
    assert.equal(row.promptVersion ?? null, null);
  } finally {
    h.close();
  }
});
