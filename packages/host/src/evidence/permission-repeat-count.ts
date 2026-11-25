import { HOST_REJECT_CODES } from "../permission-policy.js";
import type { EvidenceDb } from "./types.js";

export type RepeatCountTables = { decisions: string; controls: string; inputSeals: string };

type Row = { seq: number; id: string; input_sealed: string };

export function raisedRepeatCount(db: EvidenceDb, tables: RepeatCountTables, assignment: string, rejectId: string): number {
  const repeats = db.all<Row>(
    `SELECT seq,id,input_sealed FROM ${tables.decisions} WHERE assignment=? AND repeats=? AND `
    + `(code IS NULL OR code NOT IN (${HOST_REJECT_CODES.map(() => "?").join(",")})) ORDER BY seq`,
    assignment, rejectId, ...HOST_REJECT_CODES,
  );
  if (repeats.length === 0) return 0;
  const reset = db.get<{ seq: number | null }>(
    `SELECT MAX(seq) AS seq FROM ${tables.controls} WHERE (kind='unlock' AND assignment=?) OR (kind='reopen' AND decision_id=?)`,
    assignment, rejectId,
  )?.seq ?? 0;
  const reject = db.get<Row>(`SELECT seq,id,input_sealed FROM ${tables.decisions} WHERE id=?`, rejectId);
  const digestOf = (row: Row) => requestDigestOf(db, tables.inputSeals, row);
  const counted = new Set<string>();
  const own = reject && digestOf(reject);
  if (own !== undefined) counted.add(own);
  let count = 0;
  for (const row of repeats) {
    const digest = digestOf(row);
    if (digest !== undefined) {
      if (counted.has(digest)) continue;
      counted.add(digest);
    }
    if (row.seq > reset) count++;
  }
  return count;
}

function requestDigestOf(db: EvidenceDb, inputSeals: string, row: Row): string | undefined {
  try {
    const digest = (JSON.parse(db.open<string>(inputSeals, row.id, row.input_sealed)) as { requestDigest?: unknown }).requestDigest;
    return typeof digest === "string" && digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}
