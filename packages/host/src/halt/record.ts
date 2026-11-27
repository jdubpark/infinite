import { readFileSync } from "node:fs";
import { z } from "zod";
import { unseal, writeSealed } from "../vault.js";
import { HALT_ITEM_KINDS, HALT_RESULTS, type HaltOutcome } from "./rules.js";

export const HALT_FILE = "halt.sealed";
const HALT_SEAL_SCOPE = "halt";

export type HaltActor = { deviceId: string; label: string };
type HaltEntryBase = {
  haltId: string;
  at: number;
  reason?: string;
  requestId: string;
  by: HaltActor;
  settled: boolean;
};
export type HaltEntry =
  | (HaltEntryBase & { scope: "host"; projectId?: undefined })
  | (HaltEntryBase & { scope: "project"; projectId: string });
export type HaltReceipt = {
  requestId: string;
  action: "engage" | "release";
  fingerprint: string;
  haltId?: string;
  changed: boolean;
  keepPaused?: boolean;
  at: number;
  by: HaltActor;
  settled: boolean;
  outcomes: HaltOutcome[];
};
export type HaltRecord = { version: 1; halts: HaltEntry[]; receipts: HaltReceipt[] };

export const MAX_RECEIPTS = 100;

const uuid = z.uuid();
const time = z.number().int();
const text = (max: number) => z.string().max(max);
const actorSchema = z.object({ deviceId: z.string().min(1).max(200), label: text(200) }).strict();
const entryBase = {
  haltId: uuid,
  at: time,
  reason: text(500).optional(),
  requestId: uuid,
  by: actorSchema,
  settled: z.boolean(),
};
const entrySchema = z.discriminatedUnion("scope", [
  z.object({ ...entryBase, scope: z.literal("host"), projectId: z.undefined().optional() }).strict(),
  z.object({ ...entryBase, scope: z.literal("project"), projectId: z.string().min(1) }).strict(),
]);
const outcomeSchema = z.object({
  kind: z.enum(HALT_ITEM_KINDS),
  id: text(200),
  title: text(500),
  result: z.enum(HALT_RESULTS),
  reason: text(4000).optional(),
}).strict();
const receiptSchema = z.object({
  requestId: uuid,
  action: z.enum(["engage", "release"]),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  haltId: uuid.optional(),
  changed: z.boolean(),
  keepPaused: z.boolean().optional(),
  at: time,
  by: actorSchema,
  settled: z.boolean(),
  outcomes: z.array(outcomeSchema).max(5000),
}).strict();
const recordSchema: z.ZodType<HaltRecord> = z.object({
  version: z.literal(1),
  halts: z.array(entrySchema).max(10000),
  receipts: z.array(receiptSchema).max(MAX_RECEIPTS),
}).strict();

export type HaltRead = { state: "missing" } | { state: "readable"; record: HaltRecord } | { state: "unreadable" };

export function readHaltRecord(file: string, key: Buffer): HaltRead {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" }; }
  try {
    const parsed = recordSchema.safeParse(unseal<unknown>(key, HALT_SEAL_SCOPE, raw));
    return parsed.success ? { state: "readable", record: parsed.data } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

export function writeHaltRecord(file: string, key: Buffer, record: HaltRecord): boolean {
  try {
    if (!recordSchema.safeParse(record).success) return false;
    writeSealed(file, key, HALT_SEAL_SCOPE, record);
    return true;
  } catch {
    return false;
  }
}

export const HALT_EPOCHS_FILE = "halt-epochs.sealed";
const HALT_EPOCHS_SEAL_SCOPE = "halt-epochs";
export type HaltEpochs = { version: 1; host: string; projects: Record<string, string> };

const epochsSchema: z.ZodType<HaltEpochs> = z.object({
  version: z.literal(1),
  host: z.string().min(1).max(100),
  projects: z.record(z.string().min(1).max(200), z.string().min(1).max(100)),
}).strict();

export type HaltEpochsRead = { state: "missing" } | { state: "readable"; epochs: HaltEpochs } | { state: "unreadable" };

export function readHaltEpochs(file: string, key: Buffer): HaltEpochsRead {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" }; }
  try {
    const parsed = epochsSchema.safeParse(unseal<unknown>(key, HALT_EPOCHS_SEAL_SCOPE, raw));
    return parsed.success ? { state: "readable", epochs: parsed.data } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

export function writeHaltEpochs(file: string, key: Buffer, epochs: HaltEpochs): boolean {
  try {
    if (!epochsSchema.safeParse(epochs).success) return false;
    writeSealed(file, key, HALT_EPOCHS_SEAL_SCOPE, epochs);
    return true;
  } catch {
    return false;
  }
}
