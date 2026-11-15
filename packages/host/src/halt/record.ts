import { readFileSync } from "node:fs";
import { z } from "zod";
import { unseal, writeSealed } from "../vault.js";
import { HALT_ITEM_KINDS, HALT_RESULTS, type HaltOutcome, type HaltScope } from "./rules.js";

export const HALT_FILE = "halt.sealed";
const HALT_SEAL_SCOPE = "halt";

/** The owner device that sent the request. The label is the device's own, for the owner to recognise it. */
export type HaltActor = { deviceId: string; label: string };
export type HaltEntry = {
  haltId: string;
  scope: HaltScope;
  projectId?: string;
  at: number;
  reason?: string;
  requestId: string;
  by: HaltActor;
  /** False until the stop pass has finished. A restart finishes an unsettled pass. */
  settled: boolean;
  /** Its place in the record's count of engaged halts. Absent on a halt engaged before the count was kept. */
  serial?: number;
};
export type HaltReceipt = {
  requestId: string;
  action: "engage" | "release";
  fingerprint: string;
  /** The halt this request engaged or released. Absent when a release found nothing halted. */
  haltId?: string;
  /** False when the request found the scope already halted (engage) or not halted (release). */
  changed: boolean;
  keepPaused?: boolean;
  at: number;
  by: HaltActor;
  /** False until the request's pass has finished. A restart finishes an unsettled pass. */
  settled: boolean;
  outcomes: HaltOutcome[];
};
export type HaltRecord = {
  version: 1; halts: HaltEntry[]; receipts: HaltReceipt[];
  /**
   * How many halts this record has engaged. It is never lowered and is kept apart from the receipts, so a released
   * halt is still counted after its receipt is dropped. Absent on a record written before it was kept.
   */
  engaged?: number;
};

/** Requests remembered for replay. The oldest is dropped first. */
export const MAX_RECEIPTS = 100;

const uuid = z.uuid();
const time = z.number().int();
const text = (max: number) => z.string().max(max);
const actorSchema = z.object({ deviceId: z.string().min(1).max(200), label: text(200) }).strict();
const entrySchema = z.object({
  haltId: uuid,
  scope: z.enum(["host", "project"]),
  projectId: z.string().min(1).optional(),
  at: time,
  reason: text(500).optional(),
  requestId: uuid,
  by: actorSchema,
  settled: z.boolean(),
  serial: z.number().int().positive().optional(),
}).strict();
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
  engaged: z.number().int().nonnegative().optional(),
}).strict();

export type HaltRead = { state: "missing" } | { state: "readable"; record: HaltRecord } | { state: "unreadable" };

/** A missing file is no halt. Any other failure (I/O, authentication, schema) is unreadable. Never throws. */
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

/** False on any failure, including a record outside the schema. Never throws. */
export function writeHaltRecord(file: string, key: Buffer, record: HaltRecord): boolean {
  try {
    if (!recordSchema.safeParse(record).success) return false;
    writeSealed(file, key, HALT_SEAL_SCOPE, record);
    return true;
  } catch {
    return false;
  }
}
