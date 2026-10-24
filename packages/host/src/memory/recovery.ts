import { createHash, createPublicKey, KeyObject, randomBytes, verify } from "node:crypto";

export const MEMORY_RECOVERY_GENESIS_HASH = "0".repeat(64);
const MAX_RECOVERY_BATCH = 100;
const MAX_RECONCILIATION_DELTAS = 10_000;

export type MemoryRecoveryAction = "revoke" | "erase" | "binding-retire" | "grant-revoke" | "source-revoke";

export interface MemoryRecoveryDelta {
  sequence: number;
  workspaceKey: string;
  objectKey: string;
  action: MemoryRecoveryAction;
  eventId: string;
  priorHash: string;
  deltaHash: string;
  timestamp: string;
}

export interface MemoryRecoveryCheckpoint {
  sequence: number;
  headHash: string;
}

export interface MemoryRecoverySignedHead extends MemoryRecoveryCheckpoint {
  challenge: string;
  signature: string;
}

export interface MemoryRecoveryAppendReceipt {
  expectedSequence: number;
  expectedHeadHash: string;
  sequence: number;
  headHash: string;
  deltaHashes: string[];
  eventIds: string[];
  acceptedAt: string;
  signature: string;
}

/** Transport adapter contract. The caller pins and verifies the witness key. */
export interface MemoryRecoveryWitness {
  append(
    expectedSequence: number,
    expectedHeadHash: string,
    deltaBatch: readonly MemoryRecoveryDelta[],
  ): Promise<MemoryRecoveryAppendReceipt>;
  readFresh(challenge: string): Promise<MemoryRecoverySignedHead>;
  readDeltas(afterSequence: number, throughHeadHash: string): Promise<MemoryRecoveryDelta[]>;
}

export interface MemoryRecoveryCoordinatorOptions {
  witness?: MemoryRecoveryWitness;
  pinnedPublicKey?: Buffer | string | KeyObject;
  readCheckpoint(): MemoryRecoveryCheckpoint;
  /** Apply denials and the new head in one durable store transaction. */
  applyDeltas(deltas: readonly MemoryRecoveryDelta[], checkpoint: MemoryRecoveryCheckpoint): void | Promise<void>;
  randomChallenge?: () => string;
}

export class MemoryRecoveryError extends Error {
  constructor(
    public readonly error: "recovery_required" | "unavailable",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MemoryRecoveryError";
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Recovery values must use safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Recovery values must be canonical JSON");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function deltaBody(delta: Omit<MemoryRecoveryDelta, "deltaHash">): Omit<MemoryRecoveryDelta, "deltaHash"> {
  return {
    sequence: delta.sequence,
    workspaceKey: delta.workspaceKey,
    objectKey: delta.objectKey,
    action: delta.action,
    eventId: delta.eventId,
    priorHash: delta.priorHash,
    timestamp: delta.timestamp,
  };
}

export function createMemoryRecoveryDelta(input: Omit<MemoryRecoveryDelta, "deltaHash">): MemoryRecoveryDelta {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1
    || !input.workspaceKey || input.workspaceKey.length > 256
    || !input.objectKey || input.objectKey.length > 256
    || !["revoke", "erase", "binding-retire", "grant-revoke", "source-revoke"].includes(input.action)
    || !/^[0-9a-f-]{36}$/i.test(input.eventId)
    || !isDigest(input.priorHash)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.timestamp)) {
    throw new TypeError("Invalid recovery delta");
  }
  const body = deltaBody(input);
  return { ...body, deltaHash: digest(body) };
}

function verifyDelta(delta: MemoryRecoveryDelta, expectedSequence: number, expectedPriorHash: string): boolean {
  if (!Number.isSafeInteger(delta.sequence) || delta.sequence !== expectedSequence
    || delta.priorHash !== expectedPriorHash || !isDigest(delta.deltaHash)) return false;
  try {
    return createMemoryRecoveryDelta(deltaBody(delta)).deltaHash === delta.deltaHash;
  } catch {
    return false;
  }
}

function checkpointValid(checkpoint: MemoryRecoveryCheckpoint): boolean {
  return Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence >= 0 && isDigest(checkpoint.headHash);
}

function signedHeadPayload(head: MemoryRecoverySignedHead): unknown {
  return { challenge: head.challenge, headHash: head.headHash, sequence: head.sequence };
}

function appendReceiptPayload(receipt: MemoryRecoveryAppendReceipt): unknown {
  return {
    acceptedAt: receipt.acceptedAt,
    deltaHashes: receipt.deltaHashes,
    eventIds: receipt.eventIds,
    expectedHeadHash: receipt.expectedHeadHash,
    expectedSequence: receipt.expectedSequence,
    headHash: receipt.headHash,
    sequence: receipt.sequence,
  };
}

function publicKey(value: Buffer | string | KeyObject): KeyObject {
  if (value instanceof KeyObject) {
    if (value.type !== "public") throw new TypeError("Pinned recovery identity must be a public key");
    return value;
  }
  if (typeof value === "string") return createPublicKey(value);
  return createPublicKey({ key: value as Buffer, format: "der", type: "spki" });
}

/**
 * Fresh-start and witness-append verifier. It never trusts a boolean supplied
 * by a witness adapter; signatures, challenge binding, and the complete hash
 * chain are checked against the pinned Ed25519 identity.
 */
export class MemoryRecoveryCoordinator {
  private ready = false;
  private readonly witness?: MemoryRecoveryWitness;
  private readonly key?: KeyObject;
  private readonly readCheckpoint: () => MemoryRecoveryCheckpoint;
  private readonly applyDeltas: MemoryRecoveryCoordinatorOptions["applyDeltas"];
  private readonly randomChallenge: () => string;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(options: MemoryRecoveryCoordinatorOptions) {
    this.witness = options.witness;
    this.key = options.pinnedPublicKey ? publicKey(options.pinnedPublicKey) : undefined;
    this.readCheckpoint = options.readCheckpoint;
    this.applyDeltas = options.applyDeltas;
    this.randomChallenge = options.randomChallenge ?? (() => randomBytes(32).toString("base64url"));
  }

  get isReady(): boolean { return this.ready; }

  async reconcileFresh(): Promise<void> {
    this.ready = false;
    if (!this.witness || !this.key) throw new MemoryRecoveryError("recovery_required", "Fresh recovery witness is not configured.", false);
    let response: MemoryRecoverySignedHead;
    const challenge = this.randomChallenge();
    try {
      response = await this.witness.readFresh(challenge);
    } catch {
      throw new MemoryRecoveryError("recovery_required", "Fresh recovery witness is unavailable.", true);
    }
    if (!response || response.challenge !== challenge || !checkpointValid(response)
      || !this.validSignature(signedHeadPayload(response), response.signature)) {
      throw new MemoryRecoveryError("recovery_required", "Recovery witness head authentication failed.", false);
    }

    const local = this.readCheckpoint();
    if (!checkpointValid(local) || local.sequence > response.sequence
      || (local.sequence === response.sequence && local.headHash !== response.headHash)) {
      throw new MemoryRecoveryError("recovery_required", "Local recovery state is newer than or inconsistent with the witness.", false);
    }

    const count = response.sequence - local.sequence;
    if (count > MAX_RECONCILIATION_DELTAS) throw new MemoryRecoveryError("recovery_required", "Recovery history exceeds the bounded reconciliation limit.", false);
    if (count === 0) {
      this.ready = true;
      return;
    }

    let deltas: MemoryRecoveryDelta[];
    try {
      deltas = await this.witness.readDeltas(local.sequence, response.headHash);
    } catch {
      throw new MemoryRecoveryError("recovery_required", "Recovery witness history is unavailable.", true);
    }
    if (!Array.isArray(deltas) || deltas.length !== count) {
      throw new MemoryRecoveryError("recovery_required", "Recovery witness history is incomplete.", false);
    }

    let sequence = local.sequence;
    let headHash = local.headHash;
    for (const delta of deltas) {
      sequence++;
      if (!delta || !verifyDelta(delta, sequence, headHash)) {
        throw new MemoryRecoveryError("recovery_required", "Recovery witness history has a sequence or hash gap.", false);
      }
      headHash = delta.deltaHash;
    }
    if (sequence !== response.sequence || headHash !== response.headHash) {
      throw new MemoryRecoveryError("recovery_required", "Recovery witness history does not reach the authenticated head.", false);
    }
    await this.applyDeltas(deltas, { sequence, headHash });
    this.ready = true;
  }

  /**
   * Append a single access-removing delta after its local deny intent is durable.
   * The callback commits the immutable success receipt and witness checkpoint in
   * one local transaction. A rejected callback can be retried with the same ID;
   * the witness returns the original append receipt for identical bytes.
   */
  async appendAndCommit(
    delta: MemoryRecoveryDelta,
    commitAcknowledgement: (checkpoint: MemoryRecoveryCheckpoint, receipt: MemoryRecoveryAppendReceipt) => void | Promise<void>,
  ): Promise<MemoryRecoveryAppendReceipt> {
    if (!this.ready || !this.witness || !this.key) throw new MemoryRecoveryError("recovery_required", "Protected memory is closed pending fresh recovery.", false);
    let release!: () => void;
    const previous = this.appendTail;
    this.appendTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const local = this.readCheckpoint();
      if (!checkpointValid(local) || delta.sequence < 1 || !verifyDelta(delta, delta.sequence, delta.priorHash)
        || local.sequence < delta.sequence - 1
        || (local.sequence === delta.sequence - 1 && local.headHash !== delta.priorHash)
        || (local.sequence === delta.sequence && local.headHash !== delta.deltaHash)) {
        throw new MemoryRecoveryError("recovery_required", "Recovery delta does not extend the current local head.", false);
      }
      let receipt: MemoryRecoveryAppendReceipt;
      try {
        // A restored database may already contain this verified delta while its
        // local mutation receipt still awaits the original signed append ack.
        receipt = await this.witness.append(delta.sequence - 1, delta.priorHash, [delta]);
      } catch {
        throw new MemoryRecoveryError("unavailable", "Recovery witness acknowledgement is unavailable.", true);
      }
      const next = local.sequence >= delta.sequence ? local : { sequence: delta.sequence, headHash: delta.deltaHash };
      if (!receipt
        || receipt.expectedSequence !== delta.sequence - 1
        || receipt.expectedHeadHash !== delta.priorHash
        || receipt.sequence !== delta.sequence
        || receipt.headHash !== delta.deltaHash
        || receipt.deltaHashes.length !== 1
        || receipt.deltaHashes[0] !== delta.deltaHash
        || receipt.eventIds.length !== 1
        || receipt.eventIds[0] !== delta.eventId
        || !this.validSignature(appendReceiptPayload(receipt), receipt.signature)) {
        throw new MemoryRecoveryError("recovery_required", "Recovery witness append receipt authentication failed.", false);
      }
      await commitAcknowledgement(next, receipt);
      return receipt;
    } finally {
      release();
    }
  }

  private validSignature(payload: unknown, encoded: string): boolean {
    if (!this.key || typeof encoded !== "string") return false;
    try {
      return verify(null, Buffer.from(canonicalJson(payload), "utf8"), this.key, Buffer.from(encoded, "base64"));
    } catch {
      return false;
    }
  }
}
