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
import { EvidenceError } from "../packages/host/src/evidence/types.js";

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
  // A member with no model and no effort: the emitter leaves both out, and another emitter may send null.
  const absent = configuredData({}, { model: null, effort: null });
  delete absent.model;
  delete absent.effort;
  const nulls = configuredData({}, { model: null, effort: null });
  const expected = configId(components({ model: null, effort: null }));
  // Each form is stored on its own, in an empty store, so neither passes on the other's row.
  for (const [name, data] of [["absent", absent], ["null", nulls]] as const) {
    const f = fixture();
    let store: EvidenceStore | undefined;
    try {
      store = open(f);
      store.register(configurationModule());
      setupOutbox(store).flush([configuredEvent(`member-${name}`, "2026-11-13T01:00:00.000Z", data)]);
      const rows = configurationRows(store);
      assert.equal(rows.length, 1, `${name} fields are stored`);
      assert.equal(rows[0]!.model, null);
      assert.equal(rows[0]!.effort, null);
      assert.equal(rows[0]!.config_id, expected);
    } finally {
      store?.close();
      f.close();
    }
  }
  // Both forms name one configuration.
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    outbox.flush([configuredEvent("member-null", "2026-11-13T01:00:00.000Z", nulls)]);
    outbox.flush([configuredEvent("member-absent", "2026-11-13T02:00:00.000Z", absent)]);
    const rows = configurationRows(store);
    assert.equal(rows.length, 1);
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

test("an epoch never starts before the one before it", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const identity = profileIdentityKey(PROFILE);
    advanceEpoch(store, { profile: PROFILE, requestId: "77777777-7777-4777-8777-777777777777", now: "2026-11-10T00:00:00.000Z" });
    // The clock stepped back. The new epoch starts with the one before it, never ahead of it, so that earlier
    // epoch is in effect for no time and the newest one is in effect from then on.
    const next = advanceEpoch(store, { profile: PROFILE, requestId: "88888888-8888-4888-8888-888888888888", now: "2026-11-09T00:00:00.000Z" });
    assert.equal(next.epoch, 3);
    assert.equal(next.since, "2026-11-10T00:00:00.000Z");
    assert.equal(store.read(db => epochAt(db, identity, "2026-11-10T00:00:00.000Z")), 3);
    assert.equal(store.read(db => epochAt(db, identity, "2026-11-09T12:00:00.000Z")), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("a module that is not ready is unavailable", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    // The module was never registered, as when its migration failed.
    assert.throws(
      () => advanceEpoch(store!, { profile: PROFILE, requestId: "99999999-9999-4999-8999-999999999999", now: "2026-11-01T00:00:00.000Z" }),
      (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
    );
  } finally {
    store?.close();
    f.close();
  }
});

test("a long model name is stored", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    const outbox = setupOutbox(store);
    // An OpenCode model name may hold 180 characters.
    const model = `vendor/${"m".repeat(173)}`;
    assert.equal(model.length, 180);
    outbox.flush([configuredEvent("member-long", "2026-11-13T01:00:00.000Z", configuredData({}, { model }))]);
    const rows = configurationRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.model, model);
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
