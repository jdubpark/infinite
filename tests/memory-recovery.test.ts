import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createMemoryRecoveryDelta,
  MEMORY_RECOVERY_GENESIS_HASH,
  MemoryRecoveryCoordinator,
  MemoryRecoveryError,
  type MemoryRecoveryAppendReceipt,
  type MemoryRecoveryCheckpoint,
  type MemoryRecoveryDelta,
  type MemoryRecoverySignedHead,
  type MemoryRecoveryWitness,
} from "../packages/host/src/memory/recovery.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pinnedPublicKey = publicKey.export({ type: "spki", format: "der" }) as Buffer;
const signed = (value: unknown) => sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString("base64");

class SyntheticWitness implements MemoryRecoveryWitness {
  readonly challenges: string[] = [];
  readonly accepted: MemoryRecoveryAppendReceipt[] = [];
  readonly deltas: MemoryRecoveryDelta[] = [];
  loseNextAcknowledgement = false;
  wrongChallenge = false;
  corruptNextSignature = false;
  omitHistory = false;

  async append(expectedSequence: number, expectedHeadHash: string, batch: readonly MemoryRecoveryDelta[]) {
    if (batch.length !== 1) throw new Error("Synthetic witness accepts one delta per append");
    const delta = batch[0]!;
    const priorReceipt = this.accepted.find(receipt => receipt.eventIds[0] === delta.eventId);
    if (priorReceipt) {
      if (priorReceipt.deltaHashes[0] !== delta.deltaHash) throw new Error("Event ID reused with different bytes");
      if (this.loseNextAcknowledgement) {
        this.loseNextAcknowledgement = false;
        throw new Error("Acknowledgement lost after durable append");
      }
      return priorReceipt;
    }
    const current = this.deltas.at(-1);
    const sequence = this.deltas.length;
    const headHash = current?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH;
    if (expectedSequence !== sequence || expectedHeadHash !== headHash
      || delta.sequence !== sequence + 1 || delta.priorHash !== headHash) throw new Error("Witness CAS failed");

    this.deltas.push(delta);
    const receiptBody = {
      acceptedAt: delta.timestamp,
      deltaHashes: [delta.deltaHash],
      eventIds: [delta.eventId],
      expectedHeadHash,
      expectedSequence,
      headHash: delta.deltaHash,
      sequence: sequence + 1,
    };
    const receipt = { ...receiptBody, signature: signed(receiptBody) };
    this.accepted.push(receipt);
    if (this.loseNextAcknowledgement) {
      this.loseNextAcknowledgement = false;
      throw new Error("Acknowledgement lost after durable append");
    }
    return receipt;
  }

  async readFresh(challenge: string): Promise<MemoryRecoverySignedHead> {
    this.challenges.push(challenge);
    const body = {
      challenge: this.wrongChallenge ? "unrelated-challenge" : challenge,
      headHash: this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH,
      sequence: this.deltas.length,
    };
    let signature = signed(body);
    if (this.corruptNextSignature) {
      this.corruptNextSignature = false;
      signature = Buffer.alloc(64).toString("base64");
    }
    return { ...body, signature };
  }

  async readDeltas(afterSequence: number, throughHeadHash: string): Promise<MemoryRecoveryDelta[]> {
    const selected = this.deltas.filter(delta => delta.sequence > afterSequence);
    if (this.omitHistory) return selected.slice(1);
    if ((this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH) !== throughHeadHash) throw new Error("Unknown head");
    return selected;
  }

  seed(delta: MemoryRecoveryDelta) { this.deltas.push(delta); }
}

function coordinator(
  witness: MemoryRecoveryWitness | undefined,
  local: MemoryRecoveryCheckpoint = { sequence: 0, headHash: MEMORY_RECOVERY_GENESIS_HASH },
  applied: MemoryRecoveryDelta[][] = [],
  randomChallenge = () => "fresh-start-challenge",
) {
  let checkpoint = local;
  const recovery = new MemoryRecoveryCoordinator({
    witness,
    pinnedPublicKey,
    randomChallenge,
    readCheckpoint: () => checkpoint,
    applyDeltas: (deltas, next) => { applied.push([...deltas]); checkpoint = next; },
  });
  return { recovery, applied, get checkpoint() { return checkpoint; }, set checkpoint(value: MemoryRecoveryCheckpoint) { checkpoint = value; } };
}

test("fresh signed witness head reconciles contiguous denials before recovery opens", async () => {
  const witness = new SyntheticWitness();
  const delta = createMemoryRecoveryDelta({
    sequence: 1,
    workspaceKey: "workspace-key",
    objectKey: "grant-key",
    action: "grant-revoke",
    eventId: "6d22a7a4-1d01-4baf-ae6c-465a2f2c1c7b",
    priorHash: MEMORY_RECOVERY_GENESIS_HASH,
    timestamp: "2026-01-02T03:04:05.000Z",
  });
  witness.seed(delta);
  const target = coordinator(witness, undefined, [], () => "fresh-start-challenge-0123456789abcdef");

  await target.recovery.reconcileFresh();

  assert.equal(witness.challenges.length, 1);
  assert.ok(witness.challenges[0]!.length >= 32);
  assert.equal(target.recovery.isReady, true);
  assert.deepEqual(target.applied, [[delta]]);
  assert.deepEqual(target.checkpoint, { sequence: 1, headHash: delta.deltaHash });
});

test("challenge mismatch, bad signature, history gaps, and witness rollback keep recovery closed", async () => {
  const challengeWitness = new SyntheticWitness();
  challengeWitness.wrongChallenge = true;
  const challengeCase = coordinator(challengeWitness);
  await assert.rejects(challengeCase.recovery.reconcileFresh(), MemoryRecoveryError);
  assert.equal(challengeCase.recovery.isReady, false);

  const signatureWitness = new SyntheticWitness();
  signatureWitness.corruptNextSignature = true;
  const signatureCase = coordinator(signatureWitness);
  await assert.rejects(signatureCase.recovery.reconcileFresh(), MemoryRecoveryError);
  assert.equal(signatureCase.recovery.isReady, false);

  const gapWitness = new SyntheticWitness();
  let priorHash = MEMORY_RECOVERY_GENESIS_HASH;
  for (let i = 1; i <= 2; i++) {
    const delta = createMemoryRecoveryDelta({
      sequence: i,
      workspaceKey: "workspace-key",
      objectKey: `object-${i}`,
      action: "erase",
      eventId: `6d22a7a4-1d01-4baf-ae6c-465a2f2c1c7${i}`,
      priorHash,
      timestamp: `2026-01-02T03:04:0${i}.000Z`,
    });
    gapWitness.seed(delta);
    priorHash = delta.deltaHash;
  }
  gapWitness.omitHistory = true;
  const gapCase = coordinator(gapWitness);
  await assert.rejects(gapCase.recovery.reconcileFresh(), MemoryRecoveryError);
  assert.deepEqual(gapCase.applied, []);
  assert.equal(gapCase.recovery.isReady, false);

  const rollbackCase = coordinator(new SyntheticWitness(), { sequence: 1, headHash: "1".repeat(64) });
  await assert.rejects(rollbackCase.recovery.reconcileFresh(), MemoryRecoveryError);
  assert.equal(rollbackCase.recovery.isReady, false);
});

test("lost append acknowledgement retries the same event and commits one signed receipt", async () => {
  const witness = new SyntheticWitness();
  const target = coordinator(witness);
  await target.recovery.reconcileFresh();
  const delta = createMemoryRecoveryDelta({
    sequence: 1,
    workspaceKey: "workspace-key",
    objectKey: "source-key",
    action: "source-revoke",
    eventId: "6d22a7a4-1d01-4baf-ae6c-465a2f2c1c7c",
    priorHash: MEMORY_RECOVERY_GENESIS_HASH,
    timestamp: "2026-01-02T03:04:05.000Z",
  });
  let successReceipts = 0;
  const commit = (next: MemoryRecoveryCheckpoint) => {
    target.checkpoint = next;
    successReceipts++;
  };
  witness.loseNextAcknowledgement = true;

  await assert.rejects(target.recovery.appendAndCommit(delta, commit), (error: unknown) => {
    assert.ok(error instanceof MemoryRecoveryError);
    assert.equal(error.error, "unavailable");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(successReceipts, 0);
  assert.equal(target.checkpoint.sequence, 0);

  const receipt = await target.recovery.appendAndCommit(delta, commit);
  assert.equal(successReceipts, 1);
  assert.equal(witness.accepted.length, 1);
  assert.equal(receipt.sequence, 1);
  assert.equal(receipt.headHash, delta.deltaHash);
  assert.equal(target.checkpoint.headHash, delta.deltaHash);
});

test("restored checkpoint accepts the original signed receipt without regressing a later local head", async () => {
  const witness = new SyntheticWitness();
  const first = createMemoryRecoveryDelta({
    sequence: 1,
    workspaceKey: "workspace-key",
    objectKey: "grant-key-1",
    action: "grant-revoke",
    eventId: "6d22a7a4-1d01-4baf-ae6c-465a2f2c1d01",
    priorHash: MEMORY_RECOVERY_GENESIS_HASH,
    timestamp: "2026-01-02T03:04:05.000Z",
  });
  const second = createMemoryRecoveryDelta({
    sequence: 2,
    workspaceKey: "workspace-key",
    objectKey: "grant-key-2",
    action: "grant-revoke",
    eventId: "6d22a7a4-1d01-4baf-ae6c-465a2f2c1d02",
    priorHash: first.deltaHash,
    timestamp: "2026-01-02T03:04:06.000Z",
  });
  await witness.append(0, MEMORY_RECOVERY_GENESIS_HASH, [first]);
  await witness.append(1, first.deltaHash, [second]);
  const target = coordinator(witness, { sequence: 2, headHash: second.deltaHash });
  await target.recovery.reconcileFresh();

  let committed: MemoryRecoveryCheckpoint | undefined;
  const receipt = await target.recovery.appendAndCommit(first, checkpoint => { committed = checkpoint; });

  assert.equal(receipt.expectedSequence, 0);
  assert.equal(receipt.expectedHeadHash, MEMORY_RECOVERY_GENESIS_HASH);
  assert.equal(receipt.sequence, 1);
  assert.equal(receipt.headHash, first.deltaHash);
  assert.deepEqual(committed, { sequence: 2, headHash: second.deltaHash });
  assert.equal(target.checkpoint.sequence, 2);
  assert.equal(witness.accepted.length, 2);
});

test("unconfigured recovery witness cannot open protected serving", async () => {
  const target = coordinator(undefined);
  await assert.rejects(target.recovery.reconcileFresh(), (error: unknown) => {
    assert.ok(error instanceof MemoryRecoveryError);
    assert.equal(error.error, "recovery_required");
    return true;
  });
  assert.equal(target.recovery.isReady, false);
});
