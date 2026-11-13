import type { EventProjector } from "./evidence/outbox.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx, type RunEvent } from "./evidence/types.js";
import { type ConfigComponents, configId, type ProfileKey, profileIdentityKey } from "./config-identity.js";

export const CONFIGURATIONS_MODULE = "configurations";
const CONFIGURED_KIND = "member.configured";
const DIGEST = /^[0-9a-f]{64}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
/** A model name may hold 180 characters (the OpenCode profile rule). */
const PROFILE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/;
const DATA_KEYS = new Set([
  "v", "configId", "provider", "model", "effort", "promptVersion", "guidance", "knowledge", "routing", "shape",
]);

type Parsed = { components: ConfigComponents; configId: string };

let skipLogged = false;

/**
 * The `configurations` module (spec part 3). Plain columns hold only digests, enumerations, and times.
 * Epochs are kept with their start times. Epoch 1 is implicit and has no row.
 */
export function configurationModule(): EvidenceModule {
  return {
    name: CONFIGURATIONS_MODULE,
    version: 1,
    readVersion: 1,
    // No `deleteRun` and no `runIds`: nothing in these tables belongs to a run.
    migrate(tx) {
      tx.exec(
        "CREATE TABLE IF NOT EXISTS configurations (config_id TEXT PRIMARY KEY, provider TEXT NOT NULL, "
        + "model TEXT, effort TEXT, prompt_version TEXT NOT NULL, guidance TEXT NOT NULL, "
        + "knowledge TEXT NOT NULL, routing TEXT NOT NULL, shape TEXT NOT NULL, first_seen_at TEXT NOT NULL)",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS profile_epochs (identity TEXT NOT NULL, epoch INTEGER NOT NULL, "
        + "provider TEXT NOT NULL, model TEXT, effort TEXT, since TEXT NOT NULL, "
        + "request_id TEXT NOT NULL UNIQUE, PRIMARY KEY (identity, epoch))",
      );
    },
    counts(db) {
      const configurations = db.get<{ n: number }>("SELECT count(*) AS n FROM configurations");
      const epochs = db.get<{ n: number }>("SELECT count(*) AS n FROM profile_epochs");
      return { configurations: configurations?.n ?? 0, epochs: epochs?.n ?? 0 };
    },
  };
}

/**
 * Projects `member.configured` into `configurations`. Runs once per matching event, in `seq` order. A replayed
 * page is idempotent: a row is keyed by `config_id`, a digest of all six components, so a replay repeats the
 * same key and `DO NOTHING` keeps the first row. An event that fails the strict parse or whose `configId` does
 * not match its components is skipped with one log line per process. It never throws for one bad event.
 */
export function configurationProjector(): EventProjector {
  return {
    name: CONFIGURATIONS_MODULE,
    module: CONFIGURATIONS_MODULE,
    kinds: [CONFIGURED_KIND],
    project(tx: EvidenceTx, event: RunEvent): void {
      const parsed = parseConfigured(event.data);
      if (parsed === undefined) {
        if (!skipLogged) {
          skipLogged = true;
          console.warn("Configuration event skipped: its data does not match its configuration identity.");
        }
        return;
      }
      const { components } = parsed;
      tx.run(
        "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, "
        + "routing, shape, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(config_id) DO NOTHING",
        parsed.configId,
        components.profile.provider,
        components.profile.model,
        components.profile.effort,
        components.promptVersion,
        components.guidance,
        components.knowledge,
        components.routing,
        components.shape,
        event.at,
      );
    },
  };
}

/** The highest epoch of the identity whose `since` is at or before `at`, or 1 when none is. */
export function epochAt(db: EvidenceDb, identity: string, at: string): number {
  const row = db.get<{ epoch: number }>(
    "SELECT epoch FROM profile_epochs WHERE identity=? AND since<=? ORDER BY epoch DESC LIMIT 1",
    identity,
    at,
  );
  return row?.epoch ?? 1;
}

/** A request id that already advanced another profile's epoch. The route answers it as a request conflict. */
export class EpochRequestConflict extends Error {
  constructor() {
    super("This request ID belongs to another profile's epoch.");
    this.name = "EpochRequestConflict";
  }
}

/**
 * Advances a profile's epoch in one write. A request id that is already stored for the same identity returns
 * its stored epoch with `repeated: true` and changes nothing. One stored for another identity throws
 * EpochRequestConflict. Otherwise the new epoch is the identity's highest plus one, or 2.
 * Throws EvidenceError("unavailable") when the store is not ready.
 */
export function advanceEpoch(
  store: EvidenceStore,
  input: { profile: ProfileKey; requestId: string; now: string },
): { epoch: number; since: string; repeated: boolean } {
  const { profile, requestId, now } = input;
  if (typeof requestId !== "string" || requestId.length === 0) throw new TypeError("An epoch needs a request id.");
  // `epochAt` compares times as strings, so a start time must be in the one form `toISOString` gives.
  if (typeof now !== "string" || !isCanonicalTime(now)) throw new TypeError("An epoch needs a start time.");
  const identity = profileIdentityKey(profile);
  // A module that failed to migrate, or one a newer host wrote, is unavailable. Without this check its SQL error
  // would reach the caller as a generic failure.
  if (store.status().modules[CONFIGURATIONS_MODULE] !== "ready") {
    throw new EvidenceError("unavailable", "The configurations module is unavailable.");
  }
  return store.write(tx => {
    const stored = tx.get<{ identity: string; epoch: number; since: string }>(
      "SELECT identity, epoch, since FROM profile_epochs WHERE request_id=?",
      requestId,
    );
    if (stored && stored.identity !== identity) throw new EpochRequestConflict();
    if (stored) return { epoch: stored.epoch, since: stored.since, repeated: true };
    const top = tx.get<{ epoch: number; since: string }>(
      "SELECT epoch, since FROM profile_epochs WHERE identity=? ORDER BY epoch DESC LIMIT 1",
      identity,
    );
    const epoch = (top?.epoch ?? 1) + 1;
    // An epoch never starts before the one before it, so `epochAt` never puts a later epoch ahead of an earlier one.
    // After a clock that stepped back, the two start together, and the earlier epoch is in effect for no time.
    const since = top !== undefined && top.since > now ? top.since : now;
    tx.run(
      "INSERT INTO profile_epochs (identity, epoch, provider, model, effort, since, request_id) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?)",
      identity,
      epoch,
      profile.provider,
      profile.model ?? null,
      profile.effort ?? null,
      since,
      requestId,
    );
    return { epoch, since, repeated: false };
  });
}

/** Strict parse of `member.configured` data. Undefined for any unknown key, bad value, or mismatched `configId`. */
function parseConfigured(data: unknown): Parsed | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const source = data as Record<string, unknown>;
  if (Object.keys(source).some(key => !DATA_KEYS.has(key))) return undefined;
  if (source.v !== 1) return undefined;
  const { provider, model, effort, promptVersion, guidance, knowledge, routing, shape } = source;
  if (typeof provider !== "string" || !PROVIDER.test(provider)) return undefined;
  if (!optionalText(model) || !optionalText(effort)) return undefined;
  if (typeof promptVersion !== "string" || !DIGEST.test(promptVersion)) return undefined;
  if (typeof guidance !== "string" || !DIGEST.test(guidance)) return undefined;
  if (knowledge !== "none" || routing !== "off") return undefined;
  if (shape !== "team" && shape !== "trial") return undefined;
  const components: ConfigComponents = {
    profile: { provider, model: model ?? null, effort: effort ?? null },
    promptVersion,
    guidance,
    knowledge,
    routing,
    shape,
  };
  const id = configId(components);
  if (source.configId !== id) return undefined;
  return { components, configId: id };
}

function isCanonicalTime(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

/** A profile field a member lacks is absent or null. Both mean the same component value. */
function optionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && PROFILE_TEXT.test(value));
}
