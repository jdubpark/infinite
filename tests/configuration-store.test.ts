import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configId, profileIdentityKey } from "../packages/host/src/config-identity.js";
import {
  advanceEpoch,
  configurationModule,
  configurationProjector,
  epochAt,
  EpochRequestConflict,
} from "../packages/host/src/configuration-store.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-configurations-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
}

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const PROFILE = { provider: "opencode", model: "model-one", effort: "high" } as const;

function components(overrides: Partial<{ model: string | null; effort: string | null; promptVersion: string; guidance: string }> = {}) {
  return {
    profile: { provider: PROFILE.provider, model: overrides.model === undefined ? PROFILE.model : overrides.model, effort: overrides.effort === undefined ? PROFILE.effort : overrides.effort },
    promptVersion: overrides.promptVersion ?? HEX_A,
    guidance: overrides.guidance ?? HEX_B,
    knowledge: "none" as const,
    routing: "off" as const,
    shape: "team" as const,
  };
}

function configuredData(overrides: Record<string, unknown> = {}, componentOverrides = {}): Record<string, unknown> {
  const parts = components(componentOverrides);
  return {
    v: 1,
    configId: configId(parts),
    provider: parts.profile.provider,
    model: parts.profile.model,
    effort: parts.profile.effort,
    promptVersion: parts.promptVersion,
    guidance: parts.guidance,
    knowledge: "none",
    routing: "off",
    shape: "team",
    ...overrides,
  };
}

function configuredEvent(memberId: string, at: string, data: Record<string, unknown>): OutboxEvent {
  return {
    key: `${memberId}:member.configured`,
    runId: "run-1",
    revision: 1,
    at,
    kind: "member.configured",
    memberId,
    data,
  };
}

/** The outbox with the configurations projector registered. The module must already be registered. */
function setupOutbox(store: EvidenceStore): EventOutbox {
  const outbox = new EventOutbox(store);
  outbox.registerProjector(configurationProjector());
  return outbox;
}

function configurationRows(store: EvidenceStore) {
  return store.read(db => db.all<{
    config_id: string;
    provider: string;
    model: string | null;
    effort: string | null;
    prompt_version: string;
    guidance: string;
    knowledge: string;
    routing: string;
    shape: string;
    first_seen_at: string;
  }>("SELECT * FROM configurations ORDER BY config_id"));
}

test("a configured member records its configuration once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    outbox.flush([configuredEvent("member-1", "2026-11-13T01:00:00.000Z", configuredData())]);
    outbox.flush([configuredEvent("member-2", "2026-11-13T02:00:00.000Z", configuredData())]);

    const rows = configurationRows(store);
    assert.equal(rows.length, 1);
    const expected = components();
    assert.deepEqual(
      { ...rows[0] },
      {
        config_id: configId(expected),
        provider: "opencode",
        model: "model-one",
        effort: "high",
        prompt_version: HEX_A,
        guidance: HEX_B,
        knowledge: "none",
        routing: "off",
        shape: "team",
        first_seen_at: "2026-11-13T01:00:00.000Z",
      },
    );
  } finally {
    store?.close();
    f.close();
  }
});

test("a profile field may be absent or null", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    // A member with no model and no effort: the emitter leaves both out, and an older or other emitter may send null.
    const absent = configuredData({}, { model: null, effort: null });
    delete absent.model;
    delete absent.effort;
    // The null form comes first, so the row's first-seen time proves that it was stored and not skipped.
    outbox.flush([configuredEvent("member-null", "2026-11-13T01:00:00.000Z", configuredData({}, { model: null, effort: null }))]);
    outbox.flush([configuredEvent("member-absent", "2026-11-13T02:00:00.000Z", absent)]);
    const rows = configurationRows(store);
    assert.equal(rows.length, 1, "both forms name one configuration");
    assert.equal(rows[0]!.model, null);
    assert.equal(rows[0]!.effort, null);
    assert.equal(rows[0]!.config_id, configId(components({ model: null, effort: null })));
    assert.equal(rows[0]!.first_seen_at, "2026-11-13T01:00:00.000Z");
  } finally {
    store?.close();
    f.close();
  }
});

test("an event whose configId does not match is skipped", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    const advance = outbox.advance();
    assert.equal(advance.pending, false);

    const bad = configuredData({ configId: "0".repeat(64) });
    outbox.flush([configuredEvent("member-bad", "2026-11-13T01:00:00.000Z", bad)]);
    assert.equal(configurationRows(store).length, 0);
    assert.equal(outbox.advance().pending, false);

    outbox.flush([configuredEvent("member-ok", "2026-11-13T01:05:00.000Z", configuredData())]);
    assert.equal(configurationRows(store).length, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("the epoch in effect at a time", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const identity = profileIdentityKey(PROFILE);
    const other = profileIdentityKey({ provider: "claude", model: null, effort: null });
    const at = (time: string) => store!.read(db => epochAt(db, identity, time));

    assert.equal(at("2026-11-01T00:00:00.000Z"), 1);

    const second = advanceEpoch(store, { profile: PROFILE, requestId: "11111111-1111-4111-8111-111111111111", now: "2026-11-01T00:00:00.000Z" });
    assert.equal(second.epoch, 2);
    assert.equal(second.since, "2026-11-01T00:00:00.000Z");
    assert.equal(second.repeated, false);
    const third = advanceEpoch(store, { profile: PROFILE, requestId: "22222222-2222-4222-8222-222222222222", now: "2026-11-10T00:00:00.000Z" });
    assert.equal(third.epoch, 3);

    assert.equal(at("2026-10-31T23:59:59.999Z"), 1);
    assert.equal(at("2026-11-01T00:00:00.000Z"), 2);
    assert.equal(at("2026-11-05T00:00:00.000Z"), 2);
    assert.equal(at("2026-11-10T00:00:00.000Z"), 3);
    assert.equal(store.read(db => epochAt(db, other, "2026-11-10T00:00:00.000Z")), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("a repeated epoch request advances once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const requestId = "33333333-3333-4333-8333-333333333333";
    const first = advanceEpoch(store, { profile: PROFILE, requestId, now: "2026-11-01T00:00:00.000Z" });
    const again = advanceEpoch(store, { profile: PROFILE, requestId, now: "2026-11-02T00:00:00.000Z" });
    assert.equal(first.epoch, 2);
    assert.equal(again.epoch, 2);
    assert.equal(again.since, "2026-11-01T00:00:00.000Z");
    assert.equal(again.repeated, true);
    const rows = store.read(db => db.all<{ epoch: number }>("SELECT epoch FROM profile_epochs"));
    assert.equal(rows.length, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("a request id that belongs to another profile is refused", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const requestId = "55555555-5555-4555-8555-555555555555";
    advanceEpoch(store, { profile: PROFILE, requestId, now: "2026-11-01T00:00:00.000Z" });
    const other = { provider: "claude", model: "model-two", effort: null };
    assert.throws(
      () => advanceEpoch(store!, { profile: other, requestId, now: "2026-11-02T00:00:00.000Z" }),
      EpochRequestConflict,
    );
    const rows = store.read(db => db.all<{ identity: string }>("SELECT identity FROM profile_epochs"));
    assert.deepEqual(rows.map(row => row.identity), [profileIdentityKey(PROFILE)]);
    assert.equal(store.read(db => epochAt(db, profileIdentityKey(other), "2026-11-03T00:00:00.000Z")), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("an epoch start time must be a canonical timestamp", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    for (const now of ["2026-11-01", "2026-11-01T00:00:00Z", "2026-11-01T00:00:00.000+00:00", "soon"]) {
      assert.throws(
        () => advanceEpoch(store!, { profile: PROFILE, requestId: "66666666-6666-4666-8666-666666666666", now }),
        TypeError,
      );
    }
    assert.equal(store.read(db => db.all("SELECT epoch FROM profile_epochs")).length, 0);
  } finally {
    store?.close();
    f.close();
  }
});

test("the module reports its counts", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    outbox.flush([configuredEvent("member-1", "2026-11-13T01:00:00.000Z", configuredData())]);
    advanceEpoch(store, { profile: PROFILE, requestId: "44444444-4444-4444-8444-444444444444", now: "2026-11-01T00:00:00.000Z" });
    const counts = store.describe().counts;
    assert.equal(counts["configurations.configurations"], 1);
    assert.equal(counts["configurations.epochs"], 1);
  } finally {
    store?.close();
    f.close();
  }
});
