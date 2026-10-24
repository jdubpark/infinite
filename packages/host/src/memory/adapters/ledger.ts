import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryAdapterPartition, IndexedCandidateMapping, MemoryIndexReceipt, MemoryProjectionLedger } from "./types.js";
import { canonicalMemoryDigest, canonicalMemoryJson } from "../policy.js";

type State = "building" | "ready" | "sealed" | "active" | "retired" | "quarantined";
const KEY_SALT = Buffer.from("infinite-memory-projection-ledger-v1", "utf8");

function canonicalMapping(mapping: IndexedCandidateMapping): IndexedCandidateMapping {
  const { partition: p } = mapping;
  if (!p || [p.workspaceId, p.collectionId, p.generationId, mapping.handle, mapping.recordId,
    mapping.sourceEnrollmentId, mapping.sourceId, mapping.sourceRevision, mapping.payloadHash, mapping.eventId]
    .some(value => typeof value !== "string" || value.length === 0)
    || [p.bindingEpoch, p.sourceEpoch, mapping.recordRevision].some(value => !Number.isSafeInteger(value) || value < 1)
    || !["snapshot", "upsert", "delete", "revoke", "checkpoint"].includes(mapping.eventKind)) {
    throw new Error("invalid projection mapping");
  }
  return {
    partition: { workspaceId: p.workspaceId, collectionId: p.collectionId, generationId: p.generationId,
      bindingEpoch: p.bindingEpoch, sourceEpoch: p.sourceEpoch },
    handle: mapping.handle, recordId: mapping.recordId, recordRevision: mapping.recordRevision,
    sourceEnrollmentId: mapping.sourceEnrollmentId, sourceId: mapping.sourceId, sourceRevision: mapping.sourceRevision,
    payloadHash: mapping.payloadHash, eventId: mapping.eventId, eventKind: mapping.eventKind,
  };
}

/**
 * SHA-256 of canonicalMemoryJson({version: 1, mappings}), with every mapping field
 * and its generation partition included and mappings sorted by handle in UTF-16
 * order. The canonical snapshot job computes this before writing any batch; the
 * ledger recomputes it from encrypted persisted mappings at seal. The same format
 * commits each batch. Duplicate handles within a manifest or batch are invalid.
 */
export function projectionManifestDigest(mappings: readonly IndexedCandidateMapping[]): string {
  const canonical = mappings.map(canonicalMapping).sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);
  if (canonical.some((mapping, index) => index > 0 && mapping.handle === canonical[index - 1]!.handle)) {
    throw new Error("duplicate projection handle in manifest");
  }
  return canonicalMemoryDigest({ version: 1, mappings: canonical });
}

/** Durable, encrypted, rebuildable provider metadata only. Never stores canonical content or grants. */
export class SqliteProjectionLedger implements MemoryProjectionLedger {
  private readonly db: DatabaseSync;
  private readonly indexKey: Buffer;
  private readonly encryptionKey: Buffer;
  private closed = false;

  constructor(databasePath: string, vaultKey: Buffer, private readonly verifyCanonicalCurrent: (partition: MemoryAdapterPartition) => void) {
    if (!Buffer.isBuffer(vaultKey) || vaultKey.byteLength !== 32) throw new TypeError("projection ledger requires a 32-byte host vault key");
    this.indexKey = Buffer.from(hkdfSync("sha256", vaultKey, KEY_SALT, Buffer.from("index:v1"), 32));
    this.encryptionKey = Buffer.from(hkdfSync("sha256", vaultKey, KEY_SALT, Buffer.from("row-encryption:v1"), 32));
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;");
    const check = this.db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") { this.db.close(); this.zeroKeys(); throw new Error("projection ledger is corrupt and must remain quarantined"); }
    const activeColumns = this.db.prepare("PRAGMA table_info(projection_active)").all() as Array<{ name: string }>;
    if (activeColumns.length && !activeColumns.some(column => column.name === "partition_key")) {
      this.db.close();
      this.zeroKeys();
      throw new Error("projection ledger schema requires rebuild: active generation partition is missing");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projection_generations (
        partition_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('building','ready','sealed','active','retired','quarantined')),
        reason_cipher TEXT, manifest_key TEXT, expected_count INTEGER
      );
      CREATE TABLE IF NOT EXISTS projection_active (
        collection_key TEXT PRIMARY KEY, generation_key TEXT NOT NULL, binding_key TEXT NOT NULL, source_key TEXT NOT NULL,
        partition_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_rebuild_batches (
        partition_key TEXT NOT NULL, cursor_key TEXT NOT NULL, digest_key TEXT NOT NULL, PRIMARY KEY(partition_key,cursor_key)
      );
      CREATE TABLE IF NOT EXISTS projection_events (
        partition_key TEXT NOT NULL, event_key TEXT NOT NULL, revision_key TEXT NOT NULL, identity_key TEXT NOT NULL,
        receipt_cipher TEXT NOT NULL, PRIMARY KEY(partition_key,identity_key), UNIQUE(partition_key,event_key), UNIQUE(partition_key,revision_key)
      );
      CREATE TABLE IF NOT EXISTS projection_handles (
        partition_key TEXT NOT NULL, handle_key TEXT NOT NULL, mapping_cipher TEXT NOT NULL, PRIMARY KEY(partition_key,handle_key)
      );
      CREATE TABLE IF NOT EXISTS projection_meta (name TEXT PRIMARY KEY, value_cipher TEXT NOT NULL);
    `);
    const sentinel = this.db.prepare("SELECT value_cipher FROM projection_meta WHERE name='key-check'").get() as { value_cipher: string } | undefined;
    if (sentinel) {
      try { if (this.decrypt("meta", "key-check", sentinel.value_cipher) !== "infinite-ledger-v1") throw new Error(); }
      catch { this.db.close(); this.zeroKeys(); throw new Error("projection ledger vault key mismatch; ledger remains quarantined"); }
    } else {
      this.db.prepare("INSERT INTO projection_meta(name,value_cipher) VALUES('key-check',?)").run(this.encrypt("meta", "key-check", "infinite-ledger-v1"));
    }
    if (this.db.prepare("SELECT 1 FROM projection_active WHERE partition_key IS NULL OR typeof(partition_key)!='text' OR length(partition_key)=0 LIMIT 1").get()) {
      this.db.close();
      this.zeroKeys();
      throw new Error("projection ledger schema requires rebuild: active generation partition is missing");
    }
  }

  assertCurrentPartition(p: MemoryAdapterPartition): void { this.assertCanonicalCurrent(p); if (this.isQuarantined(p)) throw new Error("projection generation is quarantined"); }
  assertCanonicalCurrent(p: MemoryAdapterPartition): void { this.assertOpen(); this.verifyCanonicalCurrent(p); }
  assertServingPartition(p: MemoryAdapterPartition): void { this.assertCurrentPartition(p); const row = this.db.prepare("SELECT state FROM projection_generations WHERE partition_key=?").get(this.partition(p)) as {state:string}|undefined; if (!row || (row.state !== "ready" && row.state !== "active")) throw new Error("projection generation is not active for serving"); this.assertCurrentPartition(p); }
  isQuarantined(p: MemoryAdapterPartition): boolean { this.assertOpen(); const row = this.db.prepare("SELECT state FROM projection_generations WHERE partition_key=?").get(this.partition(p)) as {state:string}|undefined; return row?.state === "quarantined"; }

  async findCandidate(p: MemoryAdapterPartition, handle: string): Promise<IndexedCandidateMapping|null> {
    this.assertServingPartition(p); const row = this.db.prepare("SELECT mapping_cipher FROM projection_handles WHERE partition_key=? AND handle_key=?").get(this.partition(p),this.key("handle",handle)) as {mapping_cipher:string}|undefined; this.assertServingPartition(p);
    return row ? JSON.parse(this.decrypt("mapping", `${this.partition(p)}:${this.key("handle",handle)}`, row.mapping_cipher)) as IndexedCandidateMapping : null;
  }

  async findEvent(e: {partition:MemoryAdapterPartition;eventId:string;sourceEnrollmentId:string;sourceId:string;sourceRevision:string;kind:string;payloadHash:string}): Promise<MemoryIndexReceipt|null> {
    this.assertCanonicalCurrent(e.partition); const part=this.partition(e.partition), identity=this.key("event-identity",[e.sourceEnrollmentId,e.sourceId,e.sourceRevision,e.kind,e.payloadHash].join("\0")), eventKey=this.key("event",e.eventId), revisionKey=this.key("source-revision",[e.sourceEnrollmentId,e.sourceId,e.sourceRevision,e.kind].join("\0"));
    const exact=this.db.prepare("SELECT receipt_cipher FROM projection_events WHERE partition_key=? AND identity_key=?").get(part,identity) as {receipt_cipher:string}|undefined;
    const rev=this.db.prepare("SELECT identity_key FROM projection_events WHERE partition_key=? AND revision_key=?").get(part,revisionKey) as {identity_key:string}|undefined;
    const event=this.db.prepare("SELECT identity_key FROM projection_events WHERE partition_key=? AND event_key=?").get(part,eventKey) as {identity_key:string}|undefined;
    if ((rev && rev.identity_key!==identity)||(event && event.identity_key!==identity)) { this.quarantineNow(e.partition,"source event collision"); throw new Error("source event collision quarantined"); }
    this.assertCanonicalCurrent(e.partition); return exact ? JSON.parse(this.decrypt("receipt",`${part}:${identity}`,exact.receipt_cipher)) as MemoryIndexReceipt : null;
  }

  async recordIndexEvent(mapping: IndexedCandidateMapping, receipt: MemoryIndexReceipt): Promise<void> {
    const { partition } = mapping;
    if (receipt.eventId !== mapping.eventId || receipt.payloadHash !== mapping.payloadHash)
      throw new Error("index receipt does not match its canonical event mapping");
    this.assertCurrentPartition(partition);
    const part = this.partition(partition);
    const identity = this.key("event-identity", [mapping.sourceEnrollmentId, mapping.sourceId, mapping.sourceRevision, mapping.eventKind, mapping.payloadHash].join("\0"));
    const eventKey = this.key("event", mapping.eventId);
    const revisionKey = this.key("source-revision", [mapping.sourceEnrollmentId, mapping.sourceId, mapping.sourceRevision, mapping.eventKind].join("\0"));
    let collision = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.db.prepare("SELECT state FROM projection_generations WHERE partition_key=?")
        .get(part) as { state: State } | undefined;
      if (generation && generation.state !== "ready" && generation.state !== "active")
        throw new Error("source events cannot mutate a rebuild or retired generation");
      const prior = this.db.prepare("SELECT identity_key FROM projection_events WHERE partition_key=? AND event_key=?")
        .get(part, eventKey) as { identity_key: string } | undefined;
      const same = this.db.prepare("SELECT identity_key FROM projection_events WHERE partition_key=? AND revision_key=?")
        .get(part, revisionKey) as { identity_key: string } | undefined;
      collision = Boolean((prior && prior.identity_key !== identity) || (same && same.identity_key !== identity));
      if (collision) {
        this.quarantineNow(partition, "source revision collision");
      } else if (!same) {
        this.db.prepare("INSERT INTO projection_events(partition_key,event_key,revision_key,identity_key,receipt_cipher) VALUES(?,?,?,?,?)")
          .run(part, eventKey, revisionKey, identity, this.encrypt("receipt", `${part}:${identity}`, JSON.stringify(receipt)));
        if (mapping.eventKind === "delete" || mapping.eventKind === "revoke") {
          this.quarantineNow(partition, "source deletion/revocation awaits verified rebuild");
        } else {
          this.insertMapping(part, mapping);
          this.db.prepare("INSERT INTO projection_generations(partition_key,state) VALUES(?,'ready') ON CONFLICT DO NOTHING").run(part);
        }
      }
      this.assertCanonicalCurrent(partition);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (collision) throw new Error("source event collision quarantined");
  }

  async quarantine(p:MemoryAdapterPartition,reason:string):Promise<void>{this.assertOpen();this.quarantineNow(p,reason);}
  async beginRebuild(input: Parameters<MemoryProjectionLedger["beginRebuild"]>[0]): Promise<void> {
    if (!Number.isSafeInteger(input.expectedProjectionCount) || input.expectedProjectionCount < 0)
      throw new RangeError("expectedProjectionCount must be a nonnegative safe integer");
    if (!/^[a-f0-9]{64}$/.test(input.sourceManifestDigest)) throw new Error("invalid source manifest digest");
    const partition = {
      workspaceId: input.workspaceId, collectionId: input.collectionId, generationId: input.generationId,
      bindingEpoch: input.expectedBindingEpoch, sourceEpoch: input.expectedSourceEpoch,
    };
    this.assertCanonicalCurrent(partition);
    const part = this.partition(partition);
    const manifest = this.key("manifest", input.sourceManifestDigest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO projection_generations(partition_key,state,manifest_key,expected_count) VALUES(?,'building',?,?) ON CONFLICT DO NOTHING")
        .run(part, manifest, input.expectedProjectionCount);
      const row = this.db.prepare("SELECT state,manifest_key,expected_count FROM projection_generations WHERE partition_key=?")
        .get(part) as { state: State; manifest_key: string | null; expected_count: number | null };
      if (row.state !== "building" || row.manifest_key !== manifest || row.expected_count !== input.expectedProjectionCount)
        throw new Error("rebuild generation already exists with a different manifest or state");
      this.assertCanonicalCurrent(partition);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async writeRebuildBatch(input: Parameters<MemoryProjectionLedger["writeRebuildBatch"]>[0]): Promise<void> {
    const { partition } = input;
    this.assertCanonicalCurrent(partition);
    const part = this.partition(partition);
    if (projectionManifestDigest(input.mappings) !== input.batchDigest)
      throw new Error("rebuild batch digest does not match its mappings");
    if (input.mappings.some(mapping => this.partition(mapping.partition) !== part))
      throw new Error("rebuild batch crosses generation partitions");
    const cursor = this.key("cursor", input.cursor);
    const digest = this.key("batch", input.batchDigest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.db.prepare("SELECT state FROM projection_generations WHERE partition_key=?")
        .get(part) as { state: State } | undefined;
      if (generation?.state !== "building") throw new Error("rebuild generation is not building");
      const prior = this.db.prepare("SELECT digest_key FROM projection_rebuild_batches WHERE partition_key=? AND cursor_key=?")
        .get(part, cursor) as { digest_key: string } | undefined;
      if (prior && prior.digest_key !== digest) throw new Error("rebuild cursor replayed with changed batch");
      for (const mapping of input.mappings) this.insertMapping(part, mapping);
      this.db.prepare("INSERT INTO projection_rebuild_batches(partition_key,cursor_key,digest_key) VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .run(part, cursor, digest);
      this.assertCanonicalCurrent(partition);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async sealRebuild(input: Parameters<MemoryProjectionLedger["sealRebuild"]>[0]): Promise<void> {
    const { partition } = input;
    this.assertCanonicalCurrent(partition);
    const part = this.partition(partition);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.db.prepare("SELECT state,manifest_key,expected_count FROM projection_generations WHERE partition_key=?")
        .get(part) as { state: State; manifest_key: string | null; expected_count: number | null } | undefined;
      const rows = this.db.prepare("SELECT handle_key,mapping_cipher FROM projection_handles WHERE partition_key=?")
        .all(part) as Array<{ handle_key: string; mapping_cipher: string }>;
      const mappings = rows.map(row => {
        const mapping = canonicalMapping(JSON.parse(this.decrypt("mapping", `${part}:${row.handle_key}`, row.mapping_cipher)) as IndexedCandidateMapping);
        if (this.partition(mapping.partition) !== part || this.key("handle", mapping.handle) !== row.handle_key)
          throw new Error("stored projection mapping does not match its partition or handle");
        return mapping;
      });
      const actualDigest = projectionManifestDigest(mappings);
      if (generation?.state !== "building" || generation.expected_count !== mappings.length
        || actualDigest !== input.expectedSourceManifestDigest
        || generation.manifest_key !== this.key("manifest", actualDigest)) {
        throw new Error("rebuild generation is incomplete or the canonical source manifest changed");
      }
      this.assertCanonicalCurrent(partition);
      this.db.prepare("UPDATE projection_generations SET state='sealed' WHERE partition_key=? AND state='building'").run(part);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async activateGeneration(input: Parameters<MemoryProjectionLedger["activateGeneration"]>[0]): Promise<void> {
    const { partition } = input;
    this.assertCanonicalCurrent(partition);
    if (partition.bindingEpoch !== input.expectedBindingEpoch || partition.sourceEpoch !== input.expectedSourceEpoch)
      throw new Error("generation epoch compare-and-swap failed");
    const collection = this.key("collection", partition.collectionId);
    const generation = this.key("generation", partition.generationId);
    const expectedGeneration = input.expectedCurrentGenerationId === null ? null : this.key("generation", input.expectedCurrentGenerationId);
    const part = this.partition(partition);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare("SELECT generation_key,partition_key FROM projection_active WHERE collection_key=?")
        .get(collection) as { generation_key: string; partition_key: string } | undefined;
      // CAS the old identity independently of the replacement's current epochs.
      if ((active?.generation_key ?? null) !== expectedGeneration) throw new Error("active generation compare-and-swap failed");
      const replacement = this.db.prepare("SELECT state FROM projection_generations WHERE partition_key=?")
        .get(part) as { state: State } | undefined;
      if (replacement?.state !== "sealed") throw new Error("only a sealed generation can be activated");
      if (active) {
        // This key retains the old epoch tuple, even when its projection is empty.
        const quarantined = this.db.prepare("UPDATE projection_generations SET state='quarantined',reason_cipher=? WHERE partition_key=?")
          .run(this.encrypt("reason", active.partition_key, "superseded generation awaiting verified retirement"), active.partition_key);
        if (quarantined.changes !== 1) throw new Error("active generation partition is unavailable; rebuild required");
      }
      this.db.prepare("INSERT INTO projection_active(collection_key,generation_key,binding_key,source_key,partition_key) VALUES(?,?,?,?,?) ON CONFLICT(collection_key) DO UPDATE SET generation_key=excluded.generation_key,binding_key=excluded.binding_key,source_key=excluded.source_key,partition_key=excluded.partition_key")
        .run(collection, generation, this.key("binding-epoch", String(partition.bindingEpoch)), this.key("source-epoch", String(partition.sourceEpoch)), part);
      this.db.prepare("UPDATE projection_generations SET state='active' WHERE partition_key=? AND state='sealed'").run(part);
      this.assertCanonicalCurrent(partition);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close():void{if(this.closed)return;this.closed=true;this.db.close();this.zeroKeys();}
  /** Called only inside the same transaction that records its event or rebuild cursor. */
  private insertMapping(part: string, mapping: IndexedCandidateMapping): void {
    const canonical = canonicalMemoryJson(canonicalMapping(mapping));
    const handle = this.key("handle", mapping.handle);
    const prior = this.db.prepare("SELECT mapping_cipher FROM projection_handles WHERE partition_key=? AND handle_key=?")
      .get(part, handle) as { mapping_cipher: string } | undefined;
    if (prior) {
      const existing = canonicalMemoryJson(canonicalMapping(JSON.parse(this.decrypt("mapping", `${part}:${handle}`, prior.mapping_cipher)) as IndexedCandidateMapping));
      if (existing !== canonical) throw new Error("projection handle reused with a different mapping");
      return;
    }
    this.db.prepare("INSERT INTO projection_handles(partition_key,handle_key,mapping_cipher) VALUES(?,?,?)")
      .run(part, handle, this.encrypt("mapping", `${part}:${handle}`, canonical));
  }
  private quarantineNow(p:MemoryAdapterPartition,reason:string):void{const part=this.partition(p);this.db.prepare("INSERT INTO projection_generations(partition_key,state,reason_cipher) VALUES(?,'quarantined',?) ON CONFLICT(partition_key) DO UPDATE SET state='quarantined',reason_cipher=excluded.reason_cipher").run(part,this.encrypt("reason",part,reason.slice(0,500)));}
  private partition(p:MemoryAdapterPartition):string{return this.key("partition",JSON.stringify([p.workspaceId,p.collectionId,p.generationId,p.bindingEpoch,p.sourceEpoch]));}
  private key(domain:string,value:string):string{return createHmac("sha256",this.indexKey).update(domain).update("\0").update(value).digest("base64url");}
  private encrypt(domain:string,aad:string,value:string):string{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.encryptionKey,nonce);cipher.setAAD(Buffer.from(`${domain}\0${aad}`));const body=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString("base64url");}
  private decrypt(domain:string,aad:string,value:string):string{try{const raw=Buffer.from(value,"base64url");if(raw.length<28)throw new Error();const decipher=createDecipheriv("aes-256-gcm",this.encryptionKey,raw.subarray(0,12));decipher.setAAD(Buffer.from(`${domain}\0${aad}`));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString("utf8");}catch{throw new Error("projection ledger ciphertext is invalid; ledger remains quarantined");}}
  private zeroKeys():void{this.indexKey.fill(0);this.encryptionKey.fill(0);}
  private assertOpen():void{if(this.closed)throw new Error("projection ledger is closed");}
}
