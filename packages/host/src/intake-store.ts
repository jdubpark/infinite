import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import type { IntakeRecord, IntakeThread } from "./intake-types.js";
import type { Config } from "./types.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metaScope = "intake:meta";
const recordScope = (issueId: string) => `intake-record:${issueId}`;
const now = () => new Date().toISOString();

export class IntakeStore {
  private readonly directory: string;
  private readonly recordsDirectory: string;
  private readonly metaFile: string;
  private readonly records = new Map<string, IntakeRecord>();
  private readonly listeners = new Set<(record: IntakeRecord) => void>();
  private readonly key: Buffer;
  private enabledAtValue?: string;
  private skippedRecordCount = 0;

  constructor(config: Config, key: Buffer) {
    this.directory = join(config.stateDir, "intake");
    this.recordsDirectory = join(this.directory, "records");
    this.metaFile = join(this.directory, "meta.sealed");
    this.key = key;
    mkdirSync(this.recordsDirectory, { recursive: true, mode: 0o700 });

    for (const file of readdirSync(this.recordsDirectory).filter(name => name.endsWith(".sealed") && uuidPattern.test(name.slice(0, -7)))) {
      const issueId = file.slice(0, -7);
      try {
        const record = unseal<IntakeRecord>(key, recordScope(issueId), readFileSync(join(this.recordsDirectory, file), "utf8"));
        if (record.issueId !== issueId) throw new Error("Intake record issue ID does not match its file.");
        this.records.set(issueId, record);
      } catch {
        this.skippedRecordCount += 1;
      }
    }
  }

  enabledAt(): string {
    if (this.enabledAtValue) return this.enabledAtValue;
    if (existsSync(this.metaFile)) {
      this.enabledAtValue = unseal<{ enabledAt: string }>(this.key, metaScope, readFileSync(this.metaFile, "utf8")).enabledAt;
      return this.enabledAtValue;
    }
    const enabledAt = now();
    writeSealed(this.metaFile, this.key, metaScope, { enabledAt });
    this.enabledAtValue = enabledAt;
    return enabledAt;
  }

  list(): IntakeRecord[] {
    return [...this.records.values()]
      .sort((a, b) => a.issueCreatedAt.localeCompare(b.issueCreatedAt) || a.issueId.localeCompare(b.issueId))
      .map(record => structuredClone(record));
  }

  get(issueId: string): IntakeRecord | undefined {
    const record = this.records.get(issueId);
    return record && structuredClone(record);
  }

  create(record: IntakeRecord): IntakeRecord {
    if (!uuidPattern.test(record.issueId)) throw new Error("An intake issue ID must be a UUID.");
    if (this.records.has(record.issueId)) throw new Error("This issue already has an intake record.");
    const saved = structuredClone(record);
    this.trim(saved);
    writeSealed(join(this.recordsDirectory, `${saved.issueId}.sealed`), this.key, recordScope(saved.issueId), saved);
    this.records.set(saved.issueId, saved);
    return structuredClone(saved);
  }

  update(issueId: string, change: (record: IntakeRecord) => void): IntakeRecord {
    const current = this.records.get(issueId);
    if (!current) throw new Error("This issue does not have an intake record.");
    const changed = structuredClone(current);
    change(changed);
    if (changed.issueId !== issueId) throw new Error("An intake record issue ID cannot be changed.");
    const saved = structuredClone(changed);
    saved.updatedAt = now();
    this.trim(saved);
    writeSealed(join(this.recordsDirectory, `${issueId}.sealed`), this.key, recordScope(issueId), saved);
    this.records.set(issueId, saved);
    for (const listener of this.listeners) {
      try { listener(structuredClone(saved)); }
      catch { /* A listener cannot undo a persisted update or block another listener. */ }
    }
    return structuredClone(saved);
  }

  forThread(thread: IntakeThread): IntakeRecord | undefined {
    const bound = [...this.records.values()].filter(record =>
      record.state !== "skipped" && record.thread?.channelId === thread.channelId && record.thread.threadTs === thread.threadTs);
    const newestFirst = bound.sort((a, b) => b.issueCreatedAt.localeCompare(a.issueCreatedAt) || b.issueId.localeCompare(a.issueId));
    const preferred = newestFirst.find(record => record.state !== "finished") ?? newestFirst.find(record => record.state === "finished");
    return preferred && structuredClone(preferred);
  }

  forMission(missionId: string): IntakeRecord | undefined {
    const record = [...this.records.values()]
      .filter(item => item.missionId === missionId)
      .sort((a, b) => b.issueCreatedAt.localeCompare(a.issueCreatedAt) || b.issueId.localeCompare(a.issueId))[0];
    return record && structuredClone(record);
  }

  onChange(listener: (record: IntakeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private trim(record: IntakeRecord) {
    if (record.inbound.length > 200) record.inbound.splice(0, record.inbound.length - 200);
    if (record.messages.length > 400) record.messages.splice(0, record.messages.length - 400);
  }
}
