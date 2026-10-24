import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryRecord } from "@infinite/remote";
import { HonchoMemoryAdapter } from "../packages/host/src/memory/adapters/honcho.js";
import { projectionManifestDigest, SqliteProjectionLedger } from "../packages/host/src/memory/adapters/ledger.js";
import { LexicalMemoryAdapter, projectionHandle } from "../packages/host/src/memory/adapters/lexical.js";
import type { AuthorizedMemoryHydration, MemoryAdapterPartition, IndexedCandidateMapping, MemoryIndexSourceEvent, MemoryLexicalSource } from "../packages/host/src/memory/adapters/types.js";

const vaultKey = Buffer.alloc(32, 0x7d);
const partition: MemoryAdapterPartition = { workspaceId: "synthetic-workspace-a", collectionId: "synthetic-collection-a", generationId: "generation-a", bindingEpoch: 3, sourceEpoch: 7 };
const otherPartition: MemoryAdapterPartition = { workspaceId: "synthetic-workspace-b", collectionId: "synthetic-collection-b", generationId: "generation-b", bindingEpoch: 3, sourceEpoch: 7 };
const baseTime = "2026-10-23T00:00:00.000Z";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: "synthetic-record-owner", workspaceId: partition.workspaceId, collectionId: partition.collectionId, revision: 1,
    content: "owner-authored synthetic workspace memory exact retrieval", kind: "context", sensitivity: "standard", sourceRefs: [],
    derivedFrom: [], validFrom: null, validUntil: null, metadata: {}, provenanceClass: "owner-authored", lifecycle: "active",
    suppressed: false, createdAt: baseTime, updatedAt: baseTime, ...overrides };
}
function event(overrides: Partial<MemoryIndexSourceEvent> = {}): MemoryIndexSourceEvent {
  return { partition, sourceEnrollmentId: "synthetic-enrollment-secret", sourceId: "synthetic-source-secret", sourceRevision: "synthetic-revision-secret", eventId: "synthetic-event-secret", kind: "upsert", payloadHash: "synthetic-payload-hash-secret", recordId: "synthetic-record-source", recordRevision: 1, text: "synthetic source data", observedAt: baseTime, ...overrides };
}
function openLedger(path: string, current: () => MemoryAdapterPartition): SqliteProjectionLedger {
  return new SqliteProjectionLedger(path, vaultKey, requested => {
    const active=current();
    if(requested.workspaceId!==active.workspaceId||requested.collectionId!==active.collectionId||requested.bindingEpoch!==active.bindingEpoch||requested.sourceEpoch!==active.sourceEpoch) throw new Error("canonical binding or source epoch changed");
  });
}
function mapping(overrides: Partial<IndexedCandidateMapping> = {}): IndexedCandidateMapping {
  const base = { partition, recordId: "synthetic-record-rebuilt", recordRevision: 2,
    sourceEnrollmentId: "synthetic-enrollment", sourceId: "synthetic-source", sourceRevision: "synthetic-revision-2",
    payloadHash: "synthetic-hash", eventId: "synthetic-event-rebuilt", eventKind: "upsert" as const, ...overrides };
  return { ...base, handle: overrides.handle ?? projectionHandle(base) };
}

const emptySource: MemoryLexicalSource = {
  async searchAuthorizedRecords() { return { records: [], recheckCurrent() {} }; },
  async hydrateCurrent() { return { record: null, recheckCurrent() {} }; },
};

function beginRebuild(ledger: SqliteProjectionLedger, mappings: IndexedCandidateMapping[], target = partition) {
  return ledger.beginRebuild({ workspaceId: target.workspaceId, collectionId: target.collectionId, generationId: target.generationId,
    expectedBindingEpoch: target.bindingEpoch, expectedSourceEpoch: target.sourceEpoch,
    sourceManifestDigest: projectionManifestDigest(mappings), expectedProjectionCount: mappings.length });
}

function writeBatch(ledger: SqliteProjectionLedger, cursor: string, mappings: IndexedCandidateMapping[], target = partition) {
  return ledger.writeRebuildBatch({ partition: target, cursor, mappings, batchDigest: projectionManifestDigest(mappings) });
}

test("canonical lexical recall includes owner-authored records while semantic projection is quarantined", async t => {
  const dir=mkdtempSync(join(tmpdir(),"infinite-memory-")), path=join(dir,"projection.sqlite"); let current=partition;
  const ledger=openLedger(path,()=>current); t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
  const owner=record(); let hydration=owner;
  const adapter=new LexicalMemoryAdapter(ledger,{async searchAuthorizedRecords(input){assert.ok(input.limit<=20);return {records:[owner],recheckCurrent(){ledger.assertCanonicalCurrent(input.partition);}};},async hydrateCurrent(_partition,id,revision){return {record:hydration.id===id&&hydration.revision===revision?hydration:null,recheckCurrent(){ledger.assertCanonicalCurrent(partition);}};}});
  await ledger.quarantine(partition,"synthetic semantic generation unavailable");
  const candidates=await adapter.searchLexical({partition,query:"exact retrieval",mode:"lexical",limit:25});
  assert.equal(candidates.length,1); assert.deepEqual(owner.sourceRefs,[]); assert.equal(candidates[0]!.candidate.recordId,owner.id);
  assert.deepEqual(await adapter.hydrateCandidate(candidates[0]!.candidate),owner);
  hydration=record({revision:2,content:"changed current revision"});
  await assert.rejects(adapter.hydrateCandidate(candidates[0]!.candidate),/no longer current/);
  current={...partition,sourceEpoch:8};
  await assert.rejects(adapter.hydrateCandidate(candidates[0]!.candidate),/canonical binding or source epoch changed/);
});

test("lexical ranking preserves canonical exact IDs, full normalized content, Unicode terms and eligible candidates", async t => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-memory-lexical-"));
  const ledger = openLedger(join(dir, "projection.sqlite"), () => partition);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const proposed = record({
    id: "00000000-0000-4000-8000-000000000123", content: "Ａlpha_beta—東京  CAFÉ", lifecycle: "candidate",
    provenanceClass: "model-candidate", derivedFrom: [{ recordId: "synthetic-parent", recordRevision: 1 }],
  });
  const adapter = new LexicalMemoryAdapter(ledger, {
    async searchAuthorizedRecords() { return { records: [proposed], recheckCurrent() {} }; },
    async hydrateCurrent() { return { record: proposed, recheckCurrent() {} }; },
  });
  const cases: Array<{ mode: "exact" | "lexical"; query: string; match: "exact" | "lexical" | null }> = [
    { mode: "exact", query: proposed.id, match: "exact" },
    { mode: "exact", query: "alpha_beta—東京 café", match: "exact" },
    { mode: "exact", query: "beta", match: null },
    { mode: "lexical", query: "alpha beta 東京 café", match: "lexical" },
    { mode: "lexical", query: "beta", match: "lexical" },
    { mode: "lexical", query: "alp", match: null },
  ];
  for (const example of cases) {
    const results = await adapter.searchLexical({ partition, limit: 20, mode: example.mode, query: example.query });
    assert.deepEqual(results.map(result => result.match), example.match ? [example.match] : [], JSON.stringify(example));
    if (results.length) assert.deepEqual(await adapter.hydrateCandidate(results[0]!.candidate), proposed);
  }
});

test("deferred hydration rechecks canonical grants and lineage before exposing records with unchanged partition epochs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-memory-hydration-"));
  const ledger = openLedger(join(dir, "projection.sqlite"), () => partition);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const reason of ["canonical grant revoked", "canonical parent expired"]) {
    const current = record();
    let release!: (value: AuthorizedMemoryHydration) => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const pending = new Promise<AuthorizedMemoryHydration>(resolve => { release = resolve; });
    const adapter = new LexicalMemoryAdapter(ledger, {
      async searchAuthorizedRecords() { return { records: [current], recheckCurrent() {} }; },
      async hydrateCurrent() { admitted(); return pending; },
    });
    const [result] = await adapter.searchLexical({ partition, query: current.content, mode: "exact", limit: 1 });
    const hydration = adapter.hydrateCandidate(result!.candidate);
    await started;
    // The canonical store owns grant and lineage checks; the adapter must invoke
    // its opaque proof after the suspended read, even when epochs are unchanged.
    release({ record: current, recheckCurrent() { throw new Error(reason); } });
    await assert.rejects(hydration, error => error instanceof Error && error.message === reason);
  }
});

test("source-event receipts survive restart and changed bytes quarantine the projection", async t => {
  const dir=mkdtempSync(join(tmpdir(),"infinite-memory-replay-")),path=join(dir,"projection.sqlite"); let ledger=openLedger(path,()=>partition);
  t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});}); const adapter=new LexicalMemoryAdapter(ledger,emptySource);
  const first=await adapter.indexSourceEvent({event:event(),processingAllowed:false}); assert.deepEqual(await adapter.indexSourceEvent({event:event(),processingAllowed:false}),first);
  ledger.close(); ledger=openLedger(path,()=>partition); const restarted=new LexicalMemoryAdapter(ledger,emptySource);
  assert.deepEqual(await restarted.indexSourceEvent({event:event(),processingAllowed:false}),first,"lost-ack replay returns durable receipt");
  await assert.rejects(restarted.indexSourceEvent({event:event({eventId:"synthetic-event-changed",payloadHash:"changed-bytes"}),processingAllowed:false}),/source event collision quarantined/);
  assert.equal(ledger.isQuarantined(partition),true);
});

test("replacement projection seals a complete manifest and activates with epoch and generation CAS", async t => {
  const dir=mkdtempSync(join(tmpdir(),"infinite-memory-rebuild-")),path=join(dir,"projection.sqlite");let current=partition;let ledger=openLedger(path,()=>current);t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
  await beginRebuild(ledger,[]);
  await ledger.sealRebuild({partition,expectedSourceManifestDigest:projectionManifestDigest([])});await ledger.activateGeneration({partition,expectedCurrentGenerationId:null,expectedBindingEpoch:3,expectedSourceEpoch:7});
  current={...partition,sourceEpoch:8};
  const rebuilding={...current,generationId:"generation-replacement"};const rebuilt=mapping({partition:rebuilding});const digest=projectionManifestDigest([rebuilt]);
  await beginRebuild(ledger,[rebuilt],rebuilding);
  await assert.rejects(ledger.sealRebuild({partition:rebuilding,expectedSourceManifestDigest:digest}),/incomplete/);await assert.rejects(ledger.writeRebuildBatch({partition:rebuilding,cursor:"cursor-1",batchDigest:"wrong",mappings:[rebuilt]}),/digest/);
  await writeBatch(ledger,"cursor-1",[rebuilt],rebuilding);await writeBatch(ledger,"cursor-1",[rebuilt],rebuilding);await ledger.sealRebuild({partition:rebuilding,expectedSourceManifestDigest:digest});
  await assert.rejects(ledger.activateGeneration({partition:rebuilding,expectedCurrentGenerationId:"wrong-generation",expectedBindingEpoch:3,expectedSourceEpoch:8}),/compare-and-swap/);
  await assert.rejects(ledger.activateGeneration({partition:rebuilding,expectedCurrentGenerationId:"generation-a",expectedBindingEpoch:3,expectedSourceEpoch:7}),/epoch compare-and-swap/);
  await assert.rejects(ledger.activateGeneration({partition:{...rebuilding,sourceEpoch:7},expectedCurrentGenerationId:"generation-a",expectedBindingEpoch:3,expectedSourceEpoch:7}),/canonical binding or source epoch changed/);
  await ledger.activateGeneration({partition:rebuilding,expectedCurrentGenerationId:"generation-a",expectedBindingEpoch:3,expectedSourceEpoch:8});assert.equal(ledger.isQuarantined(partition),true);assert.throws(()=>ledger.assertServingPartition(partition),/canonical binding or source epoch changed/);
  ledger.close();ledger=openLedger(path,()=>current);assert.equal(ledger.isQuarantined(partition),true);
  assert.deepEqual(await ledger.findCandidate(rebuilding,rebuilt.handle),rebuilt);
  await assert.rejects(ledger.activateGeneration({partition:rebuilding,expectedCurrentGenerationId:null,expectedBindingEpoch:3,expectedSourceEpoch:8}),/compare-and-swap/);current={...current,bindingEpoch:4};await assert.rejects(ledger.findCandidate(rebuilding,rebuilt.handle),/canonical binding or source epoch changed/);
});

test("projection manifest has fixed canonical digest vectors including the generation partition", () => {
  assert.equal(projectionManifestDigest([]), "9c02cbc1e8445352c3939efcc2da84d00f531ba153d81029d10bb287a52a1bcf");
  assert.equal(projectionManifestDigest([{
    partition: { workspaceId: "w", collectionId: "c", generationId: "g", bindingEpoch: 3, sourceEpoch: 7 },
    handle: "opaque-a", recordId: "r", recordRevision: 2, sourceEnrollmentId: "e", sourceId: "s",
    sourceRevision: "v", payloadHash: "h", eventId: "i", eventKind: "snapshot",
  }]), "7326d3852e864f21c9874d82cda5d8cfbcf568532f437ce4aeceb49bec286c93");
});

test("same-count wrong-source rebuild cannot seal or activate, including after restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-memory-manifest-"));
  const path = join(dir, "projection.sqlite");
  let ledger = openLedger(path, () => partition);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const expected = mapping();
  const substituted = { ...expected, sourceId: "synthetic-unauthorized-source" };
  await beginRebuild(ledger, [expected]);
  await writeBatch(ledger, "cursor-1", [substituted]);
  await assert.rejects(ledger.sealRebuild({ partition, expectedSourceManifestDigest: projectionManifestDigest([expected]) }), /manifest changed/);
  // Changing the seal declaration to the stored wrong source cannot rewrite the admitted manifest.
  await assert.rejects(ledger.sealRebuild({ partition, expectedSourceManifestDigest: projectionManifestDigest([substituted]) }), /manifest changed/);
  ledger.close();
  ledger = openLedger(path, () => partition);
  await assert.rejects(ledger.activateGeneration({ partition, expectedCurrentGenerationId: null,
    expectedBindingEpoch: 3, expectedSourceEpoch: 7 }), /only a sealed/);
});

test("divergent rebuild handles roll back all mappings and cursor effects; exact overlap remains idempotent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-memory-atomic-batch-"));
  const ledger = openLedger(join(dir, "projection.sqlite"), () => partition);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = mapping();
  const second = mapping({ recordId: "synthetic-second", eventId: "synthetic-event-second" });
  const unexpected = mapping({ recordId: "synthetic-unexpected", eventId: "synthetic-event-unexpected" });
  await beginRebuild(ledger, [first, second]);
  await assert.rejects(ledger.writeRebuildBatch({ partition, cursor: "duplicate", mappings: [first, first], batchDigest: "0".repeat(64) }), /duplicate projection handle/);
  await writeBatch(ledger, "cursor-1", [first]);
  await writeBatch(ledger, "overlap", [first]);
  await assert.rejects(writeBatch(ledger, "cursor-2", [unexpected, { ...first, sourceRevision: "changed-version" }]), /handle reused/);
  // Reusing cursor-2 with its valid payload proves the rejected batch did not consume it.
  await writeBatch(ledger, "cursor-2", [second]);
  await ledger.sealRebuild({ partition, expectedSourceManifestDigest: projectionManifestDigest([first, second]) });
  await assert.rejects(ledger.recordIndexEvent(unexpected, { eventId: unexpected.eventId, payloadHash: unexpected.payloadHash,
    lexical: "indexed", semantic: "disabled", providerReceipt: null }), /cannot mutate/);
  await ledger.activateGeneration({ partition, expectedCurrentGenerationId: null, expectedBindingEpoch: 3, expectedSourceEpoch: 7 });
  assert.equal(await ledger.findCandidate(partition, unexpected.handle), null, "no earlier row from the rejected batch survived");
  assert.deepEqual(await ledger.findCandidate(partition, first.handle), first);
  assert.deepEqual(await ledger.findCandidate(partition, second.handle), second);
});

test("ledger encrypts linked identifiers and rejects a wrong vault key", async t => {
  const dir=mkdtempSync(join(tmpdir(),"infinite-memory-cipher-")),path=join(dir,"projection.sqlite");const ledger=openLedger(path,()=>partition);t.after(()=>{try{ledger.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  const sourceEvent=event();const adapter=new LexicalMemoryAdapter(ledger,emptySource);await adapter.indexSourceEvent({event:sourceEvent,processingAllowed:false});
  ledger.close();const bytes=readFileSync(path).toString("utf8");for(const secret of [partition.workspaceId,partition.collectionId,partition.generationId,sourceEvent.sourceEnrollmentId,sourceEvent.sourceId,sourceEvent.sourceRevision,sourceEvent.eventId,sourceEvent.payloadHash,sourceEvent.recordId]) assert.equal(bytes.includes(secret),false,`plaintext identifier ${secret} absent`);
  assert.throws(()=>new SqliteProjectionLedger(path,Buffer.alloc(32,0x2a),()=>{}),/vault key mismatch/);
});

test("pre-repair active pointers without their partition key fail closed at ledger construction", t => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-memory-old-ledger-"));
  const path = join(dir, "projection.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE projection_active (collection_key TEXT PRIMARY KEY, generation_key TEXT NOT NULL, binding_key TEXT NOT NULL, source_key TEXT NOT NULL)");
  legacy.close();
  assert.throws(() => openLedger(path, () => partition), /schema requires rebuild: active generation partition is missing/);
});

test("Honcho does not issue unmetered semantic requests",async()=>{
  let requests=0;const ledger={assertCurrentPartition(){},assertServingPartition(){},assertCanonicalCurrent(){},isQuarantined(){return false;},async findCandidate(){return null;},async findEvent(){return null;},async recordIndexEvent(){},async quarantine(){},async beginRebuild(){},async writeRebuildBatch(){},async sealRebuild(){},async activateGeneration(){}};
  const adapter=new HonchoMemoryAdapter({baseUrl:"http://127.0.0.1:19080",workspaceToken:()=>"unused",fetch:async()=>{requests++;return new Response("{}",{status:200});}},ledger);
  await assert.rejects(adapter.searchSemantic({partition,query:"synthetic query",mode:"lexical",limit:5,destination:{providerId:"provider",endpointId:"endpoint",modelId:"model"},reservationId:"reserved"}),/metering egress proxy/);
  await assert.rejects(adapter.indexSourceEvent({event:event(),processingAllowed:true}),/metered by a controlled egress proxy/);assert.equal(requests,0);
});
