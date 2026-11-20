import { withHandle } from "./objective-ops.js";
import type { ObjectiveReceipt, PassKind } from "./objective-receipts.js";
import { REGISTER_OPS } from "./objective-record.js";
import type { Assumption, LogEntry, ObjectiveRecord } from "./objective-types.js";
import { assertLogRoom, nextSeq, sealRecord } from "./objective-write.js";

/** Assumption changes per `test.recorded` entry. Each entry's before and after stay inline. */
export const RECEIPT_CHANGES_PER_ENTRY = 8;
const RECEIPT_PREFIX = "receipt:";

export type ReceiptContext = { runId: string; revision: number; kind: PassKind; at: string };
export type ReceiptsApplied = { record: ObjectiveRecord; changed: string[]; refutedOutcome: string[] };

type Change = { id: string; before: { id: string; status: Assumption["status"]; replaced?: { handle: string; at: number } } };

/**
 * Applies host test results to the record's assumptions, one version up. Only assumption receipts with a pass or fail count, and
 * only where the outcome differs from the assumption's status. A pinned assumption keeps its status and gains the handle. The
 * first receipt for an assumption decides it. Returns undefined when nothing changes, so an unchanged register spends no log room.
 * Throws objectiveError("objective-log-full") past CORRECTION_LOG, and objectiveError("objective-op-refused") when the schema refuses the result.
 */
export function applyReceipts(record: ObjectiveRecord, receipts: readonly ObjectiveReceipt[], context: ReceiptContext): ReceiptsApplied | undefined {
  const assumptions = [...record.assumptions];
  const seen = new Set<string>();
  const changes: Change[] = [];
  const refutedOutcome: string[] = [];
  const handle = `${RECEIPT_PREFIX}${context.runId}:${context.revision}`;

  for (const receipt of receipts) {
    if (receipt.subject !== "assumption" || (receipt.outcome !== "pass" && receipt.outcome !== "fail")) continue;
    if (seen.has(receipt.id)) continue;
    seen.add(receipt.id);
    const index = assumptions.findIndex(item => item.id === receipt.id);
    if (index === -1) continue;
    const current = assumptions[index]!;
    if (current.origin === "member" || current.test.kind !== receipt.kind) continue;

    const target = receipt.outcome === "pass" ? "verified" : "refuted";
    if (current.status === target) continue;
    const next = withHandle(current.evidence, RECEIPT_PREFIX, `${handle}:${current.id}`);
    const status = current.ownerPinned ? current.status : target;
    assumptions[index] = { ...current, status, evidence: next.evidence };
    if (!current.ownerPinned && target === "refuted" && current.criticality === "outcome") refutedOutcome.push(current.id);

    const before: Change["before"] = { id: current.id, status: current.status };
    if (next.replaced !== undefined) before.replaced = next.replaced;
    changes.push({ id: current.id, before });
  }

  if (changes.length === 0) return undefined;
  const version = record.version + 1;
  const entries: LogEntry[] = [];
  for (let start = 0; start < changes.length; start += RECEIPT_CHANGES_PER_ENTRY) {
    const group = changes.slice(start, start + RECEIPT_CHANGES_PER_ENTRY);
    entries.push({
      seq: nextSeq(record) + entries.length, at: context.at, version,
      actor: "host", authority: "receipt", op: REGISTER_OPS.tested, target: context.runId, handle,
      before: { inline: { assumptions: group.map(item => item.before) } },
      after: {
        inline: {
          revision: context.revision, kind: context.kind,
          changed: group.map(item => ({ id: item.id, status: assumptions.find(candidate => candidate.id === item.id)!.status })),
        },
      },
    });
  }

  assertLogRoom(record, entries);
  const next = sealRecord(record, { assumptions }, entries);
  return { record: next, changed: changes.map(item => item.id), refutedOutcome };
}
