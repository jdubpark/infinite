import { HOST_REJECT_CODES } from "../permission-policy.js";
import type { EvidenceDb } from "./types.js";

/** The permission journal's tables that the count reads, by name. */
export type RepeatCountTables = { decisions: string; controls: string; inputSeals: string };

type Row = { seq: number; id: string; input_sealed: string };

/**
 * How many raised requests of the assignment repeated the reject since the latest unlock of the assignment or reopen
 * of the reject. The agent repeats a reject by raising a request. A request that the host decided again was raised
 * once, so its decisions count once, at the first of them: a request counted before a reset does not count again
 * after it. The request that got the reject is no repeat of it. A decision with no request digest counts on its own,
 * as every decision did before the digest existed.
 */
export function raisedRepeatCount(db: EvidenceDb, tables: RepeatCountTables, assignment: string, rejectId: string): number {
  const repeats = db.all<Row>(
    `SELECT seq,id,input_sealed FROM ${tables.decisions} WHERE assignment=? AND repeats=? AND `
    + `(code IS NULL OR code NOT IN (${HOST_REJECT_CODES.map(() => "?").join(",")})) ORDER BY seq`,
    assignment, rejectId, ...HOST_REJECT_CODES,
  );
  if (repeats.length === 0) return 0;
  // Decisions and owner controls take their sequence from one counter, and that sequence is the journal's order.
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

/** The request digest in a decision's sealed copy. A copy that cannot be read gives none, so the decision counts. */
function requestDigestOf(db: EvidenceDb, inputSeals: string, row: Row): string | undefined {
  try {
    const digest = (JSON.parse(db.open<string>(inputSeals, row.id, row.input_sealed)) as { requestDigest?: unknown }).requestDigest;
    return typeof digest === "string" && digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}
