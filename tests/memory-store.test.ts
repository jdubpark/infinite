import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import test, { type TestContext } from "node:test";
import type {
  MemoryMutation,
  MemoryMutationResult,
  MemoryMutationStatusResult,
  MemoryRecordPayload,
} from "@infinite/remote";
import { MemoryStoreError } from "../packages/host/src/memory/policy.js";
import { MEMORY_RECOVERY_GENESIS_HASH, type MemoryRecoveryAppendReceipt, type MemoryRecoveryDelta, type MemoryRecoverySignedHead, type MemoryRecoveryWitness } from "../packages/host/src/memory/recovery.js";
import { MemoryStoreService } from "../packages/host/src/memory/store.js";
import type { MemoryCurrentWorkspaceBinding, MemoryPrincipalSelector, MemoryPrincipalSnapshot, MemoryStoreOptions } from "../packages/host/src/memory/types.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const recoveryPublicKey = publicKey.export({ type: "spki", format: "der" }) as Buffer;
const signPayload = (value: unknown) => sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString("base64");
const workspaceId = "22222222-2222-4222-8222-222222222222";
const bindingDigest = "a".repeat(64);
const ownerSelector = { kind: "device", deviceId: "synthetic-owner-device" } as const;
const ownerPrincipal: MemoryPrincipalSnapshot = {
  principalId: "synthetic-owner-principal",
  kind: "device",
  deviceId: ownerSelector.deviceId,
  deviceRole: "owner",
  state: "active",
};

class SyntheticWitness implements MemoryRecoveryWitness {
  readonly deltas: MemoryRecoveryDelta[] = [];
  readonly receipts: MemoryRecoveryAppendReceipt[] = [];
  readonly appendCalls: MemoryRecoveryDelta[] = [];
  loseNextAck = false;
  beforeNextAppend?: () => Promise<void>;

  async append(expectedSequence: number, expectedHeadHash: string, batch: readonly MemoryRecoveryDelta[]) {
    if (batch.length !== 1) throw new Error("Synthetic witness accepts one delta per append");
    const delta = batch[0]!;
    this.appendCalls.push(structuredClone(delta));
    const prior = this.receipts.find(value => value.eventIds[0] === delta.eventId);
    if (prior) {
      if (prior.deltaHashes[0] !== delta.deltaHash) throw new Error("Event ID reused with changed bytes");
      if (this.beforeNextAppend) {
        const wait = this.beforeNextAppend;
        this.beforeNextAppend = undefined;
        await wait();
      }
      if (this.loseNextAck) {
        this.loseNextAck = false;
        throw new Error("Acknowledgement lost after durable append");
      }
      return prior;
    }
    const current = this.deltas.at(-1);
    const sequence = this.deltas.length;
    const headHash = current?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH;
    if (expectedSequence !== sequence || expectedHeadHash !== headHash
      || delta.sequence !== sequence + 1 || delta.priorHash !== headHash) throw new Error("Witness CAS failed");
    if (this.beforeNextAppend) {
      const wait = this.beforeNextAppend;
      this.beforeNextAppend = undefined;
      await wait();
    }
    this.deltas.push(structuredClone(delta));
    const body = {
      acceptedAt: delta.timestamp,
      deltaHashes: [delta.deltaHash],
      eventIds: [delta.eventId],
      expectedHeadHash,
      expectedSequence,
      headHash: delta.deltaHash,
      sequence: sequence + 1,
    };
    const receipt = { ...body, signature: signPayload(body) };
    this.receipts.push(receipt);
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new Error("Acknowledgement lost after durable append");
    }
    return receipt;
  }

  async readFresh(challenge: string): Promise<MemoryRecoverySignedHead> {
    const body = {
      challenge,
      headHash: this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH,
      sequence: this.deltas.length,
    };
    return { ...body, signature: signPayload(body) };
  }

  async readDeltas(afterSequence: number, throughHeadHash: string): Promise<MemoryRecoveryDelta[]> {
    const deltas = this.deltas.filter(delta => delta.sequence > afterSequence);
    if ((this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH) !== throughHeadHash) throw new Error("Unknown witness head");
    return structuredClone(deltas);
  }
}

type Harness = {
  directory: string;
  databasePath: string;
  principals: Map<string, MemoryPrincipalSnapshot>;
  bindings: Map<string, MemoryCurrentWorkspaceBinding>;
  stores: MemoryStoreService[];
  witness: SyntheticWitness;
  owner: MemoryPrincipalSelector;
  now: () => number;
  setNow(value: number): void;
  openStore(overrides?: Partial<MemoryStoreOptions>): Promise<MemoryStoreService>;
};

function createHarness(initialTime = Date.parse("2026-10-23T12:00:00.000Z")): Harness {
  const directory = mkdtempSync(join(tmpdir(), "infinite-memory-store-"));
  const databasePath = join(directory, "canonical.sqlite");
  const principals = new Map<string, MemoryPrincipalSnapshot>([[ownerSelector.deviceId, structuredClone(ownerPrincipal)]]);
  const bindings = new Map<string, MemoryCurrentWorkspaceBinding>([[workspaceId, {
    workspaceId,
    bindingEpoch: 1,
    bindingDigest,
    repositoryBindings: [],
    state: "active",
  }]]);
  const stores: MemoryStoreService[] = [];
  const witness = new SyntheticWitness();
  let clockNow = initialTime;
  const now = () => clockNow;
  const setNow = (value: number) => { clockNow = value; };
  const options: MemoryStoreOptions = {
    databasePath,
    vaultKey: Buffer.alloc(32, 0x42),
    hostId: "synthetic-host",
    resolvePrincipal(selector) {
      const key = selector.kind === "device" ? selector.deviceId : selector.taskBindingId;
      const value = principals.get(key);
      return value ? structuredClone(value) : undefined;
    },
    resolveWorkspaceBinding(id) {
      const value = bindings.get(id);
      return value ? structuredClone(value) : undefined;
    },
    recoveryWitness: witness,
    recoveryPublicKey,
    now,
  };
  const openStore = async (overrides: Partial<MemoryStoreOptions> = {}) => {
    const store = new MemoryStoreService({ ...options, ...overrides });
    stores.push(store);
    await store.openRecovery();
    return store;
  };
  return { directory, databasePath, principals, bindings, stores, witness, owner: ownerSelector, now, setNow, openStore };
}

function requestId(value: number): string {
  return `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function recordPayload(content: string, options: Partial<MemoryRecordPayload> = {}): MemoryRecordPayload {
  return {
    content,
    kind: "claim",
    sensitivity: "standard",
    sourceRefs: [],
    derivedFrom: [],
    validFrom: null,
    validUntil: null,
    metadata: {},
    ...options,
  };
}

function mutation(request: number, expectedRevision: number, op: MemoryMutation["op"], expectedBindingEpoch = 1): MemoryMutation {
  return { requestId: requestId(request), expectedRevision, expectedBindingEpoch, op };
}

function responseValue(value: MemoryMutationResult | MemoryMutationStatusResult): MemoryMutationResult {
  assert.ok("receipt" in value, "mutation did not return a committed receipt");
  return value as MemoryMutationResult;
}

async function createCollection(store: MemoryStoreService, owner: MemoryPrincipalSelector, request: number, expectedWorkspaceRevision = 1): Promise<string> {
  const result = await store.mutate({
    actor: owner,
    workspaceId,
    request: mutation(request, expectedWorkspaceRevision, { type: "collection_create", scope: "private" }),
  });
  return responseValue(result.value).receipt.resourceId;
}

function provision(store: MemoryStoreService, owner = ownerSelector) {
  return store.provisionWorkspaceMemory({
    intentEventId: requestId(1),
    actor: owner as MemoryPrincipalSelector & { kind: "device" },
    workspaceId,
    expectedBindingEpoch: 1,
    bindingDigest,
  });
}

function cleanup(t: TestContext, harness: Harness): void {
  t.after(() => {
    for (const store of harness.stores) store.close();
    rmSync(harness.directory, { recursive: true, force: true });
  });
}

async function rejectsMemoryError(operation: Promise<unknown>, expected: MemoryStoreError["error"]): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof MemoryStoreError && error.error === expected);
}

test("the canonical store stays closed without a fresh signed witness and provisioning needs explicit owner intent", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const withoutWitness = new MemoryStoreService({
    databasePath: join(harness.directory, "unwitnessed.sqlite"),
    vaultKey: Buffer.alloc(32, 0x42),
    hostId: "synthetic-host",
    resolvePrincipal: () => structuredClone(ownerPrincipal),
    resolveWorkspaceBinding: () => structuredClone(harness.bindings.get(workspaceId)!),
  });
  t.after(() => withoutWitness.close());
  await assert.rejects(withoutWitness.openRecovery(), error => error instanceof Error && error.name === "MemoryRecoveryError");
  assert.equal(withoutWitness.recoveryReady, false);

  const store = await harness.openStore();
  const viewer: MemoryPrincipalSnapshot = { ...ownerPrincipal, principalId: "synthetic-viewer", deviceId: "synthetic-viewer-device", deviceRole: "viewer", workspaceId };
  harness.principals.set(viewer.deviceId!, viewer);
  await rejectsMemoryError(Promise.resolve().then(() => provision(store, { kind: "device", deviceId: viewer.deviceId! })), "not_found");
  assert.throws(() => store.getWorkspace(ownerSelector, workspaceId), error => error instanceof MemoryStoreError && error.error === "not_found");
  const enabled = provision(store);
  assert.equal(enabled.value.workspaceId, workspaceId);
  assert.equal(store.recoveryReady, true);
  const collectionId = await createCollection(store, ownerSelector, 2);
  harness.principals.set(viewer.deviceId!, { ...viewer, collectionIds: [collectionId] });
  await rejectsMemoryError(Promise.resolve().then(() => store.lexicalCandidates({ kind: "device", deviceId: viewer.deviceId! }, workspaceId, { mode: "exact", collectionIds: [collectionId], query: "unknown content", limit: 20 })), "not_found");
});

test("canonical vault authentication rejects wrong, missing and corrupt key checks without changing existing database bytes", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const initial = await harness.openStore();
  provision(initial);
  const collectionId = await createCollection(initial, ownerSelector, 2);
  initial.close();
  const before = readFileSync(harness.databasePath);
  const count = harness.stores.length;
  await assert.rejects(harness.openStore({ vaultKey: Buffer.alloc(32, 0x24) }), /vault key authentication/);
  assert.equal(harness.stores.length, count, "wrong key is rejected before a usable store or recovery exists");
  assert.deepEqual(readFileSync(harness.databasePath), before);
  const reopened = await harness.openStore();
  assert.equal(reopened.recoveryReady, true);
  assert.equal(provision(reopened).value.workspaceId, workspaceId);
  assert.equal(reopened.listCollections(ownerSelector, workspaceId).value.items[0]!.collectionId, collectionId);
  reopened.close();
  for (const defect of ["missing", "corrupt", "oversized"] as const) {
    const databasePath = join(harness.directory, `${defect}.sqlite`);
    copyFileSync(harness.databasePath, databasePath);
    const alter = new DatabaseSync(databasePath);
    if (defect === "missing") alter.exec("DELETE FROM memory_meta WHERE key='vault_key_check'");
    else alter.prepare("UPDATE memory_meta SET value=? WHERE key='vault_key_check'").run(defect === "corrupt" ? "invalid ciphertext" : "x".repeat(513));
    alter.close();
    const damaged = readFileSync(databasePath);
    await assert.rejects(harness.openStore({ databasePath }), /vault key authentication/);
    assert.deepEqual(readFileSync(databasePath), damaged, `${defect} key check must not be replaced or repaired`);
  }
});

test("mutations commit atomically, replay exact receipts, reject changed retries and keep payload bytes encrypted across restart", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  const content = "synthetic confidential payload phrase";
  const createRecord = mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload(content) });
  const created = await store.mutate({ actor: ownerSelector, workspaceId, request: createRecord });
  const recordId = responseValue(created.value).receipt.resourceId;

  const replay = await store.mutate({ actor: ownerSelector, workspaceId, request: createRecord });
  assert.deepEqual(responseValue(replay.value).receipt, responseValue(created.value).receipt);
  await rejectsMemoryError(store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload("changed confidential payload") }),
  }), "idempotency_key_reused");
  await rejectsMemoryError(store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(4, 1, { type: "record_create", collectionId, payload: recordPayload("stale collection revision") }),
  }), "stale_revision");

  const exact = store.lexicalCandidates(ownerSelector, workspaceId, { mode: "exact", query: content, limit: 20 });
  assert.equal(exact.value.length, 1);
  assert.equal(exact.value[0]!.id, recordId);
  assert.equal(exact.value[0]!.content, content);
  const lexical = store.lexicalCandidates(ownerSelector, workspaceId, { mode: "lexical", query: "confidential phrase", limit: 20 });
  assert.deepEqual(lexical.value.map(record => record.id), [recordId]);
  store.revalidateResponse(ownerSelector, exact.fence);

  const changedRecord = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(5, 2, { type: "record_create", collectionId, payload: recordPayload("different phrase") }),
  });
  responseValue(changedRecord.value);
  await rejectsMemoryError(Promise.resolve().then(() => store.revalidateResponse(ownerSelector, exact.fence)), "not_found");
  for (const file of readdirSync(harness.directory)) {
    const bytes = readFileSync(join(harness.directory, file));
    assert.equal(bytes.includes(Buffer.from(content, "utf8")), false, `plaintext content appeared in ${file}`);
  }

  store.close();
  const reopened = await harness.openStore();
  const restored = reopened.getRecord(ownerSelector, recordId);
  assert.equal(restored.value.record.content, content);
  reopened.revalidateResponse(ownerSelector, restored.fence);
});

test("a failed SQL write rolls back its record, event, receipt and lexical entries", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  const db = new DatabaseSync(harness.databasePath);
  db.exec("CREATE TRIGGER synthetic_abort_token BEFORE INSERT ON memory_lexical_tokens BEGIN SELECT RAISE(ABORT,'synthetic transaction fault'); END;");
  db.close();

  await assert.rejects(store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload("rollback-only-content") }),
  }));
  const inspect = new DatabaseSync(harness.databasePath);
  inspect.exec("DROP TRIGGER synthetic_abort_token");
  const event = inspect.prepare("SELECT COUNT(*) AS count FROM memory_events WHERE operation='record_create'").get() as { count: number };
  inspect.close();
  assert.equal(event.count, 0);
  assert.equal(store.listRecords(ownerSelector, workspaceId, { collectionId }).value.items.length, 0);
  await rejectsMemoryError(store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(4, 1, { type: "record_create", collectionId, payload: recordPayload("unsafe JSON metadata", { metadata: { counter: Number.MAX_SAFE_INTEGER + 1 } }) }),
  }), "invalid_request");
  await rejectsMemoryError(Promise.resolve().then(() => store.getMutationStatus(ownerSelector, workspaceId, requestId(3))), "not_found");
});

test("task scope, task epochs, recall modes, evidence lineage and final-send expiry are rechecked", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  const parentExpiry = new Date(harness.now() + 2_000).toISOString();
  const parentMutation = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload("expiring parent evidence", { validUntil: parentExpiry }) }),
  });
  const parentId = responseValue(parentMutation.value).receipt.resourceId;
  const childMutation = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(4, 2, { type: "record_create", collectionId, payload: recordPayload("derived childtarget evidence", { derivedFrom: [{ recordId: parentId, recordRevision: 1 }] }) }),
  });
  const childId = responseValue(childMutation.value).receipt.resourceId;
  const rootRow = store.listCollections(ownerSelector, workspaceId).value.items[0]!;
  await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(5, rootRow.revision, { type: "grant_set", collectionId, subjectKind: "task", subjectId: "synthetic-task-binding", capabilities: ["propose", "read"] }),
  });
  const taskSelector = { kind: "task", taskBindingId: "synthetic-task-binding" } as const;
  let task: MemoryPrincipalSnapshot = {
    principalId: "synthetic-task-principal",
    kind: "task",
    taskBindingId: taskSelector.taskBindingId,
    workspaceId,
    collectionIds: [collectionId],
    bindingEpoch: 1,
    grantEpoch: 3,
    allowedActions: ["recall", "record_propose"],
    allowedRecallModes: ["exact", "lexical"],
    expiresAt: new Date(harness.now() + 60_000).toISOString(),
    state: "active",
  };
  harness.principals.set(taskSelector.taskBindingId, task);
  const taskSearch = store.lexicalCandidates(taskSelector, workspaceId, { mode: "lexical", query: "childtarget", limit: 20 });
  assert.deepEqual(taskSearch.value.map(record => record.id), [childId]);
  store.revalidateResponse(taskSelector, taskSearch.fence);

  task = { ...task, collectionIds: [] };
  harness.principals.set(taskSelector.taskBindingId, task);
  await rejectsMemoryError(Promise.resolve().then(() => store.getRecord(taskSelector, childId)), "not_found");
  task = { ...task, collectionIds: [collectionId], grantEpoch: 1 };
  harness.principals.set(taskSelector.taskBindingId, task);
  await rejectsMemoryError(Promise.resolve().then(() => store.getRecord(taskSelector, childId)), "not_found");
  task = { ...task, grantEpoch: 3, allowedActions: ["record_propose"] };
  harness.principals.set(taskSelector.taskBindingId, task);
  await rejectsMemoryError(Promise.resolve().then(() => store.lexicalCandidates(taskSelector, workspaceId, { mode: "lexical", query: "child", limit: 20 })), "not_found");
  task = { ...task, allowedActions: ["recall", "record_propose"], allowedRecallModes: ["exact"] };
  harness.principals.set(taskSelector.taskBindingId, task);
  await rejectsMemoryError(Promise.resolve().then(() => store.lexicalCandidates(taskSelector, workspaceId, { mode: "lexical", query: "child", limit: 20 })), "not_found");
  task = { ...task, allowedRecallModes: ["exact", "lexical"] };
  harness.principals.set(taskSelector.taskBindingId, task);
  const childRead = store.getRecord(taskSelector, childId);
  assert.equal(childRead.value.record.id, childId);
  store.revalidateResponse(taskSelector, childRead.fence);

  await rejectsMemoryError(store.mutate({
    actor: taskSelector,
    workspaceId,
    request: mutation(6, 4, { type: "record_propose", collectionId, payload: recordPayload("lineage-free task proposal") }),
  }), "invalid_request");
  const proposal = await store.mutate({
    actor: taskSelector,
    workspaceId,
    request: mutation(7, 4, { type: "record_propose", collectionId, payload: recordPayload("evidence-backed task proposal", { derivedFrom: [{ recordId: childId, recordRevision: 1 }] }) }),
  });
  assert.equal(responseValue(proposal.value).receipt.operation, "record_propose");

  const ownExpiry = new Date(harness.now() + 1_000).toISOString();
  const expiringRecord = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(8, 5, { type: "record_create", collectionId, payload: recordPayload("expiring direct evidence", { validUntil: ownExpiry }) }),
  });
  const expiringId = responseValue(expiringRecord.value).receipt.resourceId;
  const expiringRead = store.getRecord(ownerSelector, expiringId);
  const freshChildRead = store.getRecord(taskSelector, childId);
  const epochsBefore = store.currentAuthorizationSnapshot(taskSelector, workspaceId).value;
  store.revalidateResponse(taskSelector, freshChildRead.fence);
  harness.setNow(harness.now() + 1_000);
  await rejectsMemoryError(Promise.resolve().then(() => store.revalidateResponse(ownerSelector, expiringRead.fence)), "not_found");
  store.revalidateResponse(taskSelector, freshChildRead.fence);
  harness.setNow(Date.parse(parentExpiry));
  const epochsAfter = store.currentAuthorizationSnapshot(taskSelector, workspaceId).value;
  assert.equal(epochsAfter.servingEpoch, epochsBefore.servingEpoch);
  assert.equal(epochsAfter.grantEpoch, epochsBefore.grantEpoch);
  assert.equal(epochsAfter.currentBinding.bindingEpoch, epochsBefore.currentBinding.bindingEpoch);
  await rejectsMemoryError(Promise.resolve().then(() => store.revalidateResponse(taskSelector, freshChildRead.fence)), "not_found");

  task = { ...task, expiresAt: "not-a-valid-time" };
  harness.principals.set(taskSelector.taskBindingId, task);
  await rejectsMemoryError(Promise.resolve().then(() => store.getRecord(taskSelector, childId)), "unauthenticated");
});

test("overlapping grant revocations chain behind a lost ACK and keep both principals locally denied", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionA = await createCollection(store, ownerSelector, 2, 1);
  const collectionB = await createCollection(store, ownerSelector, 3, 2);
  const recordA = await store.mutate({ actor: ownerSelector, workspaceId, request: mutation(4, 1, { type: "record_create", collectionId: collectionA, payload: recordPayload("collection alpha secret") }) });
  const recordB = await store.mutate({ actor: ownerSelector, workspaceId, request: mutation(5, 1, { type: "record_create", collectionId: collectionB, payload: recordPayload("collection beta secret") }) });
  const recordIdA = responseValue(recordA.value).receipt.resourceId;
  const recordIdB = responseValue(recordB.value).receipt.resourceId;
  const recipientId = "synthetic-controller-device";
  const recipientSelector = { kind: "device", deviceId: recipientId } as const;
  harness.principals.set(recipientId, {
    principalId: "synthetic-controller-principal",
    kind: "device",
    deviceId: recipientId,
    deviceRole: "controller",
    workspaceId,
    collectionIds: [collectionA, collectionB],
    state: "active",
  });
  for (const [collectionId, request] of [[collectionA, 6], [collectionB, 7]] as const) {
    await store.mutate({
      actor: ownerSelector,
      workspaceId,
      request: mutation(request, 2, { type: "grant_set", collectionId, subjectKind: "device", subjectId: recipientId, capabilities: ["read"] }),
    });
  }
  assert.deepEqual(store.lexicalCandidates(recipientSelector, workspaceId, { mode: "exact", collectionIds: [collectionA], query: "collection alpha secret", limit: 20 }).value.map(record => record.id), [recordIdA]);
  assert.deepEqual(store.lexicalCandidates(recipientSelector, workspaceId, { mode: "exact", collectionIds: [collectionB], query: "collection beta secret", limit: 20 }).value.map(record => record.id), [recordIdB]);

  const grantsA = store.listGrants(ownerSelector, workspaceId, { collectionId: collectionA, state: "all" }).value.items;
  const grantsB = store.listGrants(ownerSelector, workspaceId, { collectionId: collectionB, state: "all" }).value.items;
  const grantA = grantsA.find(grant => grant.subjectId === recipientId)!;
  const grantB = grantsB.find(grant => grant.subjectId === recipientId)!;
  harness.witness.loseNextAck = true;
  const firstRequest = mutation(8, grantA.revision, { type: "grant_revoke", grantId: grantA.id });
  const secondRequest = mutation(9, grantB.revision, { type: "grant_revoke", grantId: grantB.id });
  const firstMutation = store.mutate({ actor: ownerSelector, workspaceId, request: firstRequest });
  const secondMutation = store.mutate({ actor: ownerSelector, workspaceId, request: secondRequest });

  const firstResult = await firstMutation;
  assert.ok("status" in firstResult.value && firstResult.value.status.state === "pending");
  await rejectsMemoryError(Promise.resolve().then(() => store.lexicalCandidates(recipientSelector, workspaceId, { mode: "exact", collectionIds: [collectionA], query: "collection alpha secret", limit: 20 })), "not_found");
  const secondResult = await secondMutation;
  assert.ok("receipt" in secondResult.value);
  assert.deepEqual(harness.witness.deltas.map(delta => delta.sequence), [1, 2]);
  assert.equal(harness.witness.deltas[1]!.priorHash, harness.witness.deltas[0]!.deltaHash);
  assert.equal(harness.witness.appendCalls.filter(delta => delta.eventId === harness.witness.deltas[0]!.eventId).length, 2);

  const firstStatus = store.getMutationStatus(ownerSelector, workspaceId, requestId(8)).value.status;
  const secondStatus = store.getMutationStatus(ownerSelector, workspaceId, requestId(9)).value.status;
  assert.equal(firstStatus.state, "committed");
  assert.equal(secondStatus.state, "committed");
  await store.mutate({ actor: ownerSelector, workspaceId, request: firstRequest });
  assert.equal(harness.witness.deltas.length, 2);
  await rejectsMemoryError(Promise.resolve().then(() => store.lexicalCandidates(recipientSelector, workspaceId, { mode: "exact", collectionIds: [collectionB], query: "collection beta secret", limit: 20 })), "not_found");
});

test("source revoke closes source visibility, source listings require a live administer grant, and workspace grants are not inert successes", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  await assert.rejects(store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(3, 1, { type: "grant_set", collectionId, subjectKind: "workspace", subjectId: "another-workspace", capabilities: ["read"] }),
  }), error => error instanceof Error && error.name === "MemoryUnsupportedOperationError");
  const processingPolicy = { mode: "local_lexical_only", operations: [], maxInputBytes: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrounits: "0" } as const;
  const retentionPolicy = { rawPayloadDays: 0, candidateDays: 90, sourceValidationDays: 90, archivedDays: 365, receiptMinimumDays: 365 };
  const enrolled = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(4, 2, {
      type: "source_enroll", collectionId, sourceType: "owner-context", stableSourceId: "synthetic-source",
      allowedFields: ["content"], processingPolicy, retentionPolicy,
    }),
  });
  const sourceId = responseValue(enrolled.value).receipt.resourceId;
  const before = store.listSources(ownerSelector, workspaceId);
  assert.equal(before.value.items.length, 1);
  assert.equal(before.value.items[0]!.status, "pending");
  const revoked = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(5, 1, { type: "source_revoke", sourceEnrollmentId: sourceId }),
  });
  assert.ok("receipt" in revoked.value);
  await rejectsMemoryError(Promise.resolve().then(() => store.revalidateResponse(ownerSelector, before.fence)), "not_found");
  assert.equal(store.listSources(ownerSelector, workspaceId, { state: "all" }).value.items[0]!.status, "revoked");

  const ownerGrant = store.listGrants(ownerSelector, workspaceId, { collectionId, state: "all" }).value.items.find(grant => grant.subjectId === ownerSelector.deviceId)!;
  const beforeGrantRemoval = store.listSources(ownerSelector, workspaceId, { state: "all" });
  await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(6, ownerGrant.revision, { type: "grant_revoke", grantId: ownerGrant.id }),
  });
  assert.equal(store.listSources(ownerSelector, workspaceId, { state: "all" }).value.items.length, 0);
  await rejectsMemoryError(Promise.resolve().then(() => store.revalidateResponse(ownerSelector, beforeGrantRemoval.fence)), "not_found");
});

test("binding review that goes stale during witness append records failure and cannot block a fresh review or later revocation", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  const recipientId = "synthetic-recipient-device";
  const recipientSelector = { kind: "device", deviceId: recipientId } as const;
  harness.principals.set(recipientId, {
    principalId: "synthetic-recipient-principal",
    kind: "device",
    deviceId: recipientId,
    deviceRole: "controller",
    state: "active",
  });
  await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(3, 1, { type: "grant_set", collectionId, subjectKind: "device", subjectId: recipientId, capabilities: ["read"] }),
  });
  const recipientGrant = store.listGrants(ownerSelector, workspaceId, { collectionId, state: "all" }).value.items.find(grant => grant.subjectId === recipientId)!;

  const changedBinding = { ...harness.bindings.get(workspaceId)!, bindingEpoch: 2, bindingDigest: "b".repeat(64) };
  harness.bindings.set(workspaceId, changedBinding);
  let releaseAppend!: () => void;
  let enteredAppend!: () => void;
  const appendEntered = new Promise<void>(resolve => { enteredAppend = resolve; });
  const appendGate = new Promise<void>(resolve => { releaseAppend = resolve; });
  harness.witness.beforeNextAppend = async () => { enteredAppend(); await appendGate; };
  const staleReview = store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(4, 2, { type: "workspace_review_binding", repositoryBindingsDigest: changedBinding.bindingDigest }, 2),
  });
  await appendEntered;
  const newerBinding = { ...changedBinding, bindingEpoch: 3, bindingDigest: "c".repeat(64) };
  harness.bindings.set(workspaceId, newerBinding);
  releaseAppend();
  const failed = await staleReview;
  assert.ok("status" in failed.value);
  assert.equal(failed.value.status.state, "failed");
  assert.equal(store.getMutationStatus(ownerSelector, workspaceId, requestId(4)).value.status.state, "failed");
  assert.equal(harness.witness.deltas.length, 1);

  const freshReview = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(5, 2, { type: "workspace_review_binding", repositoryBindingsDigest: newerBinding.bindingDigest }, 3),
  });
  assert.ok("receipt" in freshReview.value);
  const revoked = await store.mutate({
    actor: ownerSelector,
    workspaceId,
    request: mutation(6, recipientGrant.revision, { type: "grant_revoke", grantId: recipientGrant.id }, 3),
  });
  assert.ok("receipt" in revoked.value);
  assert.deepEqual(harness.witness.deltas.map(delta => delta.sequence), [1, 2, 3]);
  assert.equal(harness.witness.deltas[2]!.priorHash, harness.witness.deltas[1]!.deltaHash);
});

test("acknowledged erase removes the record and purges encrypted projection outbox payloads", async t => {
  const harness = createHarness();
  cleanup(t, harness);
  const store = await harness.openStore();
  provision(store);
  const collectionId = await createCollection(store, ownerSelector, 2);
  const created = await store.mutate({ actor: ownerSelector, workspaceId, request: mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload("erase this synthetic projection") }) });
  const recordId = responseValue(created.value).receipt.resourceId;
  const inspectBefore = new DatabaseSync(harness.databasePath);
  const projectionBefore = inspectBefore.prepare("SELECT encrypted_payload FROM memory_outbox WHERE kind='projection-refresh'").get() as { encrypted_payload: string };
  inspectBefore.close();

  const erased = await store.mutate({ actor: ownerSelector, workspaceId, request: mutation(4, 1, { type: "record_erase", recordId, reasonCode: "owner_request" }) });
  assert.ok("receipt" in erased.value);
  const inspectAfter = new DatabaseSync(harness.databasePath);
  const projectionAfter = inspectAfter.prepare("SELECT state,encrypted_payload FROM memory_outbox WHERE kind='projection-refresh'").get() as { state: string; encrypted_payload: string };
  const recordRow = inspectAfter.prepare("SELECT encrypted_payload,lifecycle FROM memory_records WHERE record_id=?").get(recordId) as { encrypted_payload: string | null; lifecycle: string };
  inspectAfter.close();
  assert.equal(projectionAfter.state, "discarded");
  assert.notEqual(projectionAfter.encrypted_payload, projectionBefore.encrypted_payload);
  assert.equal(recordRow.encrypted_payload, null);
  assert.equal(recordRow.lifecycle, "erased");
  await rejectsMemoryError(Promise.resolve().then(() => store.getRecord(ownerSelector, recordId)), "not_found");
});

test("a pre-erasure closed snapshot reconciles newer witness erase and archive without reviving content-bearing outbox jobs", async t => {
  for (const operation of ["record_erase", "record_archive"] as const) {
    const harness = createHarness();
    cleanup(t, harness);
    const store = await harness.openStore();
    provision(store);
    const collectionId = await createCollection(store, ownerSelector, 2);
    const created = await store.mutate({ actor: ownerSelector, workspaceId,
      request: mutation(3, 1, { type: "record_create", collectionId, payload: recordPayload("synthetic restored projection content") }) });
    const recordId = responseValue(created.value).receipt.resourceId;
    store.close();
    const restoredPath = join(harness.directory, "restored.sqlite");
    copyFileSync(harness.databasePath, restoredPath);
    const inspectSnapshot = new DatabaseSync(restoredPath, { readOnly: true });
    const original = inspectSnapshot.prepare("SELECT event_id,state,encrypted_payload FROM memory_outbox WHERE kind='projection-refresh'").get() as { event_id: string; state: string; encrypted_payload: string };
    inspectSnapshot.close();
    assert.equal(original.state, "pending");
    const live = await harness.openStore();
    const acknowledged = await live.mutate({ actor: ownerSelector, workspaceId,
      request: mutation(4, 1, operation === "record_erase"
        ? { type: "record_erase", recordId, reasonCode: "owner_request" }
        : { type: "record_archive", recordId }) });
    assert.ok("receipt" in acknowledged.value);
    const head = harness.witness.deltas.at(-1)!;
    assert.equal(head.sequence, 1);
    live.close();
    const restored = await harness.openStore({ databasePath: restoredPath });
    assert.equal(restored.recoveryReady, true);
    await rejectsMemoryError(Promise.resolve().then(() => restored.getRecord(ownerSelector, recordId)), "not_found");
    const inspect = new DatabaseSync(restoredPath, { readOnly: true });
    const projection = inspect.prepare("SELECT state,encrypted_payload FROM memory_outbox WHERE event_id=?").get(original.event_id) as { state: string; encrypted_payload: string };
    const record = inspect.prepare("SELECT lifecycle,encrypted_payload FROM memory_records WHERE record_id=?").get(recordId) as { lifecycle: string; encrypted_payload: string | null };
    const checkpoint = inspect.prepare("SELECT sequence,head_hash FROM memory_recovery_state WHERE singleton=1").get();
    const tokens = inspect.prepare("SELECT COUNT(*) AS count FROM memory_lexical_tokens WHERE record_id=?").get(recordId) as { count: number };
    inspect.close();
    assert.equal(projection.state, "discarded");
    assert.notEqual(projection.encrypted_payload, original.encrypted_payload);
    assert.equal(record.lifecycle, operation === "record_erase" ? "erased" : "archived");
    if (operation === "record_erase") {
      assert.equal(record.encrypted_payload, null);
      assert.equal(tokens.count, 0);
    }
    assert.deepEqual({ ...checkpoint }, { sequence: head.sequence, head_hash: head.deltaHash });
  }
});
