import {
  EFFECT_REJECT_CODES,
  EVIDENCE_REJECT_CODES,
  HOST_REJECT_CODES,
  INTERRUPT_CLASSES,
  REJECT_CODES,
  REPEATS_BEFORE_LOCK,
  isEffectReject,
  isEvidenceReject,
  type RejectCode,
} from "../permission-policy.js";
import { canonicalJson } from "./crypto.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "./types.js";
import { EvidenceStore } from "./store.js";

const MODULE = "permission-journal";
const DECISIONS = "permission_decisions";
const DELIVERIES = "permission_deliveries";
const CONTROLS = "permission_journal_controls";
const ORDER = "permission_journal_order";
const NOTE_SEAL_TABLE = "permission_decision_notes";
const INPUT_SEAL_TABLE = "permission_decision_inputs";
const MAX_TEXT = 2_000;

export type PermissionTier = {
  tier: "light" | "strong";
  profileId: string;
  family: string;
  startedAt: string;
  endedAt: string;
};

export type PermissionVerdict = "allow" | "reject" | "owner";

export type PermissionDecision = {
  id: string;
  at: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  assignment: string;
  sessionId: string;
  role?: string;
  provider: string;
  family?: string;
  evidenceHash: string;
  reuseKey?: string;
  action: { tool: string; summary: string };
  rules: string[];
  tiers: PermissionTier[];
  verdict: PermissionVerdict;
  code?: RejectCode;
  interruptClass?: typeof INTERRUPT_CLASSES[number];
  note?: string;
  replayOf?: string;
  repeats?: string;
};

export type PermissionDecisionQuery = {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  verdict?: PermissionVerdict;
  rejectedOnly?: boolean;
  raisedOnly?: boolean;
  since?: string;
  limit?: number;
};

export type PermissionDelivery = {
  seq: number;
  decisionId: string;
  at: string;
  kind: "intent" | "receipt" | "refusal" | "uncertain" | "stale";
  detail?: string;
};

export type PermissionRateQuery = {
  scope: "session" | "task" | "workspace" | "host";
  id?: string;
  since: string;
  until: string;
};

export type PermissionRates = {
  decisions: number;
  perHour: number;
  byVerdict: { allow: number; reject: number; owner: number };
  byTier: { none: number; light: number; strong: number };
  replays: number;
  medianDecisionMs: number | null;
};

type DecisionRow = {
  seq: number;
  id: string;
  at: string;
  at_ms: number;
  workspace_id: string;
  project_id: string;
  task_id: string;
  assignment: string;
  session_id: string;
  role: string | null;
  provider: string;
  family: string | null;
  evidence_hash: string;
  reuse_key: string | null;
  action_tool: string;
  action_summary: string;
  rules_json: string;
  tiers_json: string;
  verdict: PermissionVerdict;
  code: RejectCode | null;
  interrupt_class: typeof INTERRUPT_CLASSES[number] | null;
  note_sealed: string | null;
  input_sealed: string;
  replay_of: string | null;
  repeats: string | null;
  raised: number;
  last_tier: "none" | "light" | "strong";
  duration_ms: number | null;
};

type ControlRow = {
  seq: number;
  kind: "reopen" | "close" | "unlock";
  at: string;
  decision_id: string | null;
  assignment: string | null;
};

/** The permission journal owns its tables and deliberately has no run-deletion hook. */
export const permissionJournalModule: EvidenceModule = {
  name: MODULE,
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${ORDER} (seq INTEGER PRIMARY KEY AUTOINCREMENT)`,
    );
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${DECISIONS} (`
      + "seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, at_ms INTEGER NOT NULL, workspace_id TEXT NOT NULL, "
      + "project_id TEXT NOT NULL, task_id TEXT NOT NULL, assignment TEXT NOT NULL, session_id TEXT NOT NULL, "
      + "role TEXT, provider TEXT NOT NULL, family TEXT, evidence_hash TEXT NOT NULL, reuse_key TEXT, "
      + "action_tool TEXT NOT NULL, action_summary TEXT NOT NULL, rules_json TEXT NOT NULL, tiers_json TEXT NOT NULL, "
      + "verdict TEXT NOT NULL, code TEXT, interrupt_class TEXT, note_sealed TEXT, input_sealed TEXT NOT NULL, "
      + "replay_of TEXT, repeats TEXT, raised INTEGER NOT NULL, last_tier TEXT NOT NULL, duration_ms INTEGER)",
    );
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_at_ms ON ${DECISIONS}(at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_workspace_at_ms ON ${DECISIONS}(workspace_id, at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_project_at_ms ON ${DECISIONS}(project_id, at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_task_at_ms ON ${DECISIONS}(task_id, at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_session_at_ms ON ${DECISIONS}(session_id, at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_assignment_at_ms ON ${DECISIONS}(assignment, at_ms DESC, seq DESC)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_task_rejects ON ${DECISIONS}(task_id, verdict, code, repeats, at_ms, seq)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_assignment_repeats ON ${DECISIONS}(assignment, repeats, at_ms, seq)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_decisions_raised ON ${DECISIONS}(raised, at_ms DESC, seq DESC)`);
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${DELIVERIES} (`
      + "seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)",
    );
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_deliveries_decision ON ${DELIVERIES}(decision_id, seq)`);
    tx.exec(
      `CREATE TABLE IF NOT EXISTS ${CONTROLS} (`
      + "seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, by TEXT, decision_id TEXT, "
      + "assignment TEXT, task_id TEXT, project_id TEXT, reason TEXT)",
    );
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_controls_decision ON ${CONTROLS}(decision_id, seq)`);
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_controls_assignment ON ${CONTROLS}(assignment, seq)`);
  },
};

/** Append-only permission decisions and their delivery/owner-control history. */
export class PermissionJournal {
  constructor(private readonly store: EvidenceStore) {
    if (store.status().modules[MODULE] !== "ready") {
      throw new TypeError("The permission-journal evidence module must be registered and ready.");
    }
  }

  appendDecision(input: PermissionDecision): void {
    const decision = normalizeDecision(input);
    const inputJson = canonicalJson(decision);
    this.store.write(tx => {
      const existing = tx.get<{ input_sealed: string }>(
        `SELECT input_sealed FROM ${DECISIONS} WHERE id=?`, decision.id,
      );
      if (existing !== undefined) {
        const prior = tx.open<string>(INPUT_SEAL_TABLE, decision.id, existing.input_sealed);
        if (prior !== inputJson) throw new TypeError("A permission decision ID already has different content.");
        return;
      }

      // A replay record answers with one earlier decision of the same task and carries that decision's outcome.
      // It is stored against the source, so no chain of replays exists and no link can cross a task.
      let replaySourceId: string | undefined;
      let replayedRepeat: string | undefined;
      if (decision.replayOf !== undefined) {
        const cited = tx.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, decision.replayOf);
        const source = cited && replaySource(tx, cited);
        if (!cited || !source || cited.task_id !== decision.taskId || source.task_id !== decision.taskId) {
          throw new TypeError("A replay must cite a decision of the same task.");
        }
        if (source.verdict === "owner" || (HOST_REJECT_CODES as readonly string[]).includes(source.code ?? "")) {
          throw new TypeError("An owner verdict and a host result are never replayed.");
        }
        if (source.verdict !== decision.verdict || (source.code ?? undefined) !== decision.code) {
          throw new TypeError("A replay must carry the verdict and code of the decision it replays.");
        }
        replaySourceId = source.id;
        // A replayed effect reject is a repeat of that reject, whether or not the caller said so.
        if (isEffectReject(source.code ?? undefined)) replayedRepeat = source.repeats ?? source.id;
      }

      let canonicalRepeat = decision.repeats ?? replayedRepeat;
      if (canonicalRepeat !== undefined) {
        const cited = tx.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, canonicalRepeat);
        if (!cited || cited.task_id !== decision.taskId || !isEffectReject(cited.code ?? undefined)
          || !isOpen(tx, cited)) {
          throw new TypeError("A repeated decision must cite an open effect reject in the same task.");
        }
        canonicalRepeat = cited.repeats ?? cited.id;
        const canonical = tx.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, canonicalRepeat);
        if (!canonical || canonical.task_id !== decision.taskId || !isEffectReject(canonical.code ?? undefined)
          || !isOpen(tx, canonical)) {
          throw new TypeError("A repeated decision must resolve to an open canonical effect reject.");
        }
        if (replayedRepeat !== undefined && replayedRepeat !== canonicalRepeat) {
          throw new TypeError("A replayed reject cannot be recorded as a repeat of a different reject.");
        }
      }

      const seq = nextSequence(tx);
      const noteSealed = decision.note === undefined
        ? null
        : tx.seal(NOTE_SEAL_TABLE, decision.id, decision.note);
      const inputSealed = tx.seal(INPUT_SEAL_TABLE, decision.id, inputJson);
      tx.run(
        `INSERT INTO ${DECISIONS} (`
        + "seq,id,at,at_ms,workspace_id,project_id,task_id,assignment,session_id,role,provider,family,evidence_hash,"
        + "reuse_key,action_tool,action_summary,rules_json,tiers_json,verdict,code,interrupt_class,note_sealed,"
        + "input_sealed,replay_of,repeats,raised,last_tier,duration_ms) "
        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        seq, decision.id, decision.at, Date.parse(decision.at), decision.workspaceId, decision.projectId, decision.taskId,
        decision.assignment, decision.sessionId, decision.role ?? null, decision.provider, decision.family ?? null,
        decision.evidenceHash, decision.reuseKey ?? null, decision.action.tool, decision.action.summary,
        JSON.stringify(decision.rules), JSON.stringify(decision.tiers), decision.verdict, decision.code ?? null,
        decision.interruptClass ?? null, noteSealed, inputSealed, replaySourceId ?? null, canonicalRepeat ?? null,
        decision.rules.some(rule => rule.startsWith("raise:")) ? 1 : 0,
        decision.tiers.at(-1)?.tier ?? "none",
        decision.tiers.length === 0
          ? null
          : Date.parse(decision.tiers.at(-1)!.endedAt) - Date.parse(decision.tiers[0].startedAt),
      );
    });
  }

  appendDelivery(input: {
    decisionId: string;
    at: string;
    kind: PermissionDelivery["kind"];
    detail?: string;
  }): void {
    assertPlainObject(input, "A delivery event is required.");
    assertOnlyKeys(input, ["decisionId", "at", "kind", "detail"]);
    const decisionId = requiredString(input.decisionId, "decisionId");
    const at = requiredTimestamp(input.at, "at");
    const kinds = ["intent", "receipt", "refusal", "uncertain", "stale"] as const;
    if (!kinds.includes(input.kind)) throw new TypeError("A delivery event kind is invalid.");
    if (input.detail !== undefined && typeof input.detail !== "string") {
      throw new TypeError("A delivery detail must be text.");
    }
    this.store.write(tx => {
      if (!tx.get(`SELECT id FROM ${DECISIONS} WHERE id=?`, decisionId)) {
        throw new TypeError("A delivery event must link to a stored decision.");
      }
      const seq = nextSequence(tx);
      tx.run(
        `INSERT INTO ${DELIVERIES} (seq,decision_id,at,kind,detail) VALUES (?,?,?,?,?)`,
        seq, decisionId, at, input.kind, input.detail ?? null,
      );
    });
  }

  reopen(input: { decisionId: string; at: string; by: string }): void {
    assertPlainObject(input, "A reopen event is required.");
    assertOnlyKeys(input, ["decisionId", "at", "by"]);
    const decisionId = requiredString(input.decisionId, "decisionId");
    const at = requiredTimestamp(input.at, "at");
    const by = requiredString(input.by, "by");
    this.store.write(tx => {
      const cited = tx.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, decisionId);
      const decision = cited && canonicalDecision(tx, cited);
      if (!decision || decision.verdict !== "reject") throw new TypeError("Only a reject can be reopened.");
      insertControl(tx, { kind: "reopen", at, by, decisionId: decision.id });
    });
  }

  unlock(input: { assignment: string; at: string; by: string }): void {
    assertPlainObject(input, "An unlock event is required.");
    assertOnlyKeys(input, ["assignment", "at", "by"]);
    const assignment = requiredString(input.assignment, "assignment");
    const at = requiredTimestamp(input.at, "at");
    const by = requiredString(input.by, "by");
    this.store.write(tx => insertControl(tx, { kind: "unlock", at, by, assignment }));
  }

  closeOpenRejects(input: {
    taskId?: string;
    projectId?: string;
    at: string;
    reason: "task-ended" | "direction-changed";
  }): void {
    assertPlainObject(input, "A reject closure is required.");
    assertOnlyKeys(input, ["taskId", "projectId", "at", "reason"]);
    const taskId = input.taskId === undefined ? undefined : requiredString(input.taskId, "taskId");
    const projectId = input.projectId === undefined ? undefined : requiredString(input.projectId, "projectId");
    if (taskId === undefined && projectId === undefined) {
      throw new TypeError("Closing rejects requires a taskId or projectId.");
    }
    const at = requiredTimestamp(input.at, "at");
    if (input.reason !== "task-ended" && input.reason !== "direction-changed") {
      throw new TypeError("A reject closure reason is invalid.");
    }
    this.store.write(tx => {
      const clauses = [
        "verdict='reject'",
        `code IN (${placeholders(EFFECT_REJECT_CODES.length)})`,
        "repeats IS NULL",
      ];
      const params: (string | number)[] = [...EFFECT_REJECT_CODES];
      if (taskId !== undefined) {
        clauses.push("task_id=?");
        params.push(taskId);
      }
      if (projectId !== undefined) {
        clauses.push("project_id=?");
        params.push(projectId);
      }
      const rows = tx.all<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE ${clauses.join(" AND ")}`, ...params);
      for (const row of rows) {
        if (!isOpen(tx, row)) continue;
        insertControl(tx, { kind: "close", at, decisionId: row.id, taskId, projectId, reason: input.reason });
      }
    });
  }

  decision(id: string): PermissionDecision | undefined {
    requiredString(id, "id");
    return this.store.read(db => {
      const row = db.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, id);
      return row === undefined ? undefined : hydrateDecision(db, row);
    });
  }

  deliveries(decisionId: string): PermissionDelivery[] {
    requiredString(decisionId, "decisionId");
    return this.store.read(db => db.all<{
      seq: number; decision_id: string; at: string; kind: PermissionDelivery["kind"]; detail: string | null;
    }>(`SELECT * FROM ${DELIVERIES} WHERE decision_id=? ORDER BY seq`, decisionId).map(row => ({
      seq: row.seq,
      decisionId: row.decision_id,
      at: row.at,
      kind: row.kind,
      ...(row.detail === null ? {} : { detail: row.detail }),
    })));
  }

  decisions(query: PermissionDecisionQuery = {}): PermissionDecision[] {
    assertPlainObject(query, "A decision query must be an object.");
    assertOnlyKeys(query, [
      "workspaceId", "projectId", "taskId", "sessionId", "verdict", "rejectedOnly", "raisedOnly", "since", "limit",
    ]);
    for (const key of ["workspaceId", "projectId", "taskId", "sessionId"] as const) {
      if (query[key] !== undefined) requiredString(query[key], key);
    }
    if (query.verdict !== undefined && !["allow", "reject", "owner"].includes(query.verdict)) {
      throw new TypeError("A decision verdict filter is invalid.");
    }
    if (query.rejectedOnly !== undefined && typeof query.rejectedOnly !== "boolean") {
      throw new TypeError("rejectedOnly must be a boolean.");
    }
    if (query.raisedOnly !== undefined && typeof query.raisedOnly !== "boolean") {
      throw new TypeError("raisedOnly must be a boolean.");
    }
    const since = query.since === undefined ? undefined : requiredTimestamp(query.since, "since");
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("A decision query limit must be between 1 and 500.");
    }
    return this.store.read(db => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      for (const [field, column] of [
        ["workspaceId", "workspace_id"],
        ["projectId", "project_id"],
        ["taskId", "task_id"],
        ["sessionId", "session_id"],
      ] as const) {
        const value = query[field];
        if (value === undefined) continue;
        clauses.push(`${column}=?`);
        params.push(value);
      }
      if (query.verdict !== undefined) {
        clauses.push("verdict=?");
        params.push(query.verdict);
      }
      if (query.rejectedOnly === true) clauses.push("verdict='reject'");
      if (query.raisedOnly === true) clauses.push("raised=1");
      if (since !== undefined) {
        clauses.push("at_ms>=?");
        params.push(Date.parse(since));
      }

      const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
      const rows = db.all<DecisionRow>(
        `SELECT * FROM ${DECISIONS}${where} ORDER BY at_ms DESC, seq DESC LIMIT ?`, ...params, limit,
      );
      return rows.map(row => hydrateDecision(db, row));
    });
  }

  openRejects(taskId: string): PermissionDecision[] {
    requiredString(taskId, "taskId");
    return this.store.read(db => {
      const rows = db.all<DecisionRow>(
        `SELECT * FROM ${DECISIONS} WHERE task_id=? AND verdict='reject' AND code IN (${placeholders(EFFECT_REJECT_CODES.length)}) `
        + "AND repeats IS NULL ORDER BY at_ms,seq",
        taskId, ...EFFECT_REJECT_CODES,
      ).filter(row => isOpen(db, row));
      return rows.map(row => hydrateDecision(db, row));
    });
  }

  evidenceRejects(assignment: string): PermissionDecision[] {
    requiredString(assignment, "assignment");
    return this.store.read(db => {
      const rows = db.all<DecisionRow>(
        `SELECT * FROM ${DECISIONS} WHERE assignment=? AND verdict='reject' AND code IN (${placeholders(EVIDENCE_REJECT_CODES.length)}) `
        + "ORDER BY at_ms,seq",
        assignment, ...EVIDENCE_REJECT_CODES,
      ).filter(row => !ownerReopened(db, row));
      return rows.map(row => hydrateDecision(db, row));
    });
  }

  /**
   * Whether a model has ever rejected a request from this assignment. The host raises every later
   * request from such an assignment to the strong tier, so an owner reopening the reject, the reject
   * closing with its task, and an unlock all leave this history in place.
   */
  hasRejectHistory(assignment: string): boolean {
    requiredString(assignment, "assignment");
    const codes = [...EFFECT_REJECT_CODES, ...EVIDENCE_REJECT_CODES];
    return this.store.read(db => db.get(
      `SELECT 1 AS found FROM ${DECISIONS} WHERE assignment=? AND verdict='reject' AND code IN (${placeholders(codes.length)}) LIMIT 1`,
      assignment, ...codes,
    ) !== undefined);
  }

  repeatCount(assignment: string, rejectId: string): number {
    requiredString(assignment, "assignment");
    requiredString(rejectId, "rejectId");
    return this.store.read(db => repeatCountInDb(db, assignment, rejectId));
  }

  isLocked(assignment: string): boolean {
    requiredString(assignment, "assignment");
    return this.store.read(db => {
      const repeatedIds = new Set(db.all<{ repeats: string }>(
        `SELECT DISTINCT repeats FROM ${DECISIONS} WHERE assignment=? AND repeats IS NOT NULL`, assignment,
      ).map(row => row.repeats));
      for (const rejectId of repeatedIds) {
        const reject = db.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, rejectId);
        if (reject && reject.repeats === null && isEffectReject(reject.code ?? undefined)
          && isOpen(db, reject) && repeatCountInDb(db, assignment, rejectId) >= REPEATS_BEFORE_LOCK) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Whether the host may answer an identical request from `requesterFamily` with this recorded
   * verdict. A replay record is judged as the decision it replays. A verdict that a strong reviewer
   * gave is not replayed to a requester of that reviewer's family, nor to a requester whose family
   * the host could not establish (`requesterFamily: undefined`).
   */
  replayEligible(decisionId: string, options: { taskId: string; requesterFamily: string | undefined }): boolean {
    requiredString(decisionId, "decisionId");
    assertPlainObject(options, "A replay query needs a taskId and the requester's family.");
    assertOnlyKeys(options, ["taskId", "requesterFamily"]);
    if (!Object.hasOwn(options, "requesterFamily")) {
      throw new TypeError("A replay query must state the requester's family, or undefined when it is unknown.");
    }
    const taskId = requiredString(options.taskId, "taskId");
    const requesterFamily = optionalString(options.requesterFamily, "requesterFamily");
    return this.store.read(db => {
      const cited = db.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, decisionId);
      const row = cited && replaySource(db, cited);
      if (!cited || !row || cited.task_id !== taskId || row.verdict === "owner") return false;
      const strongFamilies = (JSON.parse(row.tiers_json) as PermissionTier[])
        .filter(tier => tier.tier === "strong").map(tier => tier.family);
      if (strongFamilies.length > 0
        && (requesterFamily === undefined || strongFamilies.some(family => sameFamily(family, requesterFamily)))) {
        return false;
      }
      if (row.verdict === "allow") {
        return !db.all<DecisionRow>(
          `SELECT * FROM ${DECISIONS} WHERE task_id=? AND verdict='reject' AND code IN (${placeholders(EFFECT_REJECT_CODES.length)}) `
          + "AND repeats IS NULL AND seq>?",
          taskId, ...EFFECT_REJECT_CODES, row.seq,
        ).some(reject => isOpen(db, reject));
      }
      if (row.code === "unavailable" || row.code === "locked" || row.code === "needs-owner") return false;
      if (isEffectReject(row.code ?? undefined)) return isOpen(db, row);
      if (isEvidenceReject(row.code ?? undefined)) return !ownerReopened(db, row);
      return false;
    });
  }

  rates(query: PermissionRateQuery): PermissionRates {
    assertPlainObject(query, "A rate query is required.");
    assertOnlyKeys(query, ["scope", "id", "since", "until"]);
    if (!["session", "task", "workspace", "host"].includes(query.scope)) {
      throw new TypeError("A rate scope is invalid.");
    }
    if (query.scope === "host") {
      if (query.id !== undefined) throw new TypeError("A host rate query does not take an id.");
    } else if (query.id === undefined) {
      throw new TypeError("A session, task, or workspace rate query needs an id.");
    }
    const id = query.id === undefined ? undefined : requiredString(query.id, "id");
    const since = requiredTimestamp(query.since, "since");
    const until = requiredTimestamp(query.until, "until");
    const startMs = Date.parse(since);
    const endMs = Date.parse(until);
    if (endMs <= startMs) throw new TypeError("A rate window must end after it starts.");

    return this.store.read(db => {
      const clauses = ["at_ms>=?", "at_ms<=?"];
      const params: (string | number)[] = [startMs, endMs];
      if (query.scope === "session") {
        clauses.push("session_id=?");
        params.push(id!);
      } else if (query.scope === "task") {
        clauses.push("task_id=?");
        params.push(id!);
      } else if (query.scope === "workspace") {
        clauses.push("workspace_id=?");
        params.push(id!);
      }
      const where = clauses.join(" AND ");
      const groups = db.all<{ verdict: PermissionVerdict; last_tier: DecisionRow["last_tier"]; n: number; replays: number }>(
        `SELECT verdict, last_tier, COUNT(*) AS n, COUNT(replay_of) AS replays FROM ${DECISIONS} WHERE ${where} `
        + "GROUP BY verdict, last_tier",
        ...params,
      );
      const byVerdict = { allow: 0, reject: 0, owner: 0 };
      const byTier = { none: 0, light: 0, strong: 0 };
      let decisions = 0, replays = 0;
      for (const group of groups) {
        byVerdict[group.verdict] += group.n;
        byTier[group.last_tier] += group.n;
        decisions += group.n;
        replays += group.replays;
      }
      const timed = db.get<{ n: number }>(
        `SELECT COUNT(duration_ms) AS n FROM ${DECISIONS} WHERE ${where}`, ...params,
      )?.n ?? 0;
      const middle = timed === 0 ? [] : db.all<{ duration_ms: number }>(
        `SELECT duration_ms FROM ${DECISIONS} WHERE ${where} AND duration_ms IS NOT NULL `
        + "ORDER BY duration_ms LIMIT ? OFFSET ?",
        ...params, timed % 2 === 1 ? 1 : 2, Math.floor((timed - 1) / 2),
      ).map(row => row.duration_ms);
      return {
        decisions,
        perHour: decisions / ((endMs - startMs) / 3_600_000),
        byVerdict,
        byTier,
        replays,
        medianDecisionMs: median(middle),
      };
    });
  }
}

function normalizeDecision(value: PermissionDecision): PermissionDecision {
  assertPlainObject(value, "A permission decision is required.");
  assertOnlyKeys(value, [
    "id", "at", "workspaceId", "projectId", "taskId", "assignment", "sessionId", "role", "provider", "family",
    "evidenceHash", "reuseKey", "action", "rules", "tiers", "verdict", "code", "interruptClass", "note", "replayOf", "repeats",
  ]);
  const id = requiredString(value.id, "id");
  const at = requiredTimestamp(value.at, "at");
  const workspaceId = requiredString(value.workspaceId, "workspaceId");
  const projectId = requiredString(value.projectId, "projectId");
  const taskId = requiredString(value.taskId, "taskId");
  const assignment = requiredString(value.assignment, "assignment");
  const sessionId = requiredString(value.sessionId, "sessionId");
  const provider = requiredString(value.provider, "provider");
  const evidenceHash = requiredString(value.evidenceHash, "evidenceHash");
  const action = value.action;
  assertPlainObject(action, "An extracted action is required.");
  assertOnlyKeys(action, ["tool", "summary"]);
  const tool = requiredString(action.tool, "action.tool");
  if (typeof action.summary !== "string" || action.summary.length > MAX_TEXT) {
    throw new TypeError("An action summary must be text of at most 2000 characters.");
  }
  if (!Array.isArray(value.rules) || value.rules.some(rule => typeof rule !== "string")) {
    throw new TypeError("Permission rules must be an array of strings.");
  }
  if (!Array.isArray(value.tiers)) throw new TypeError("Permission tiers must be an array.");
  const tiers = value.tiers.map((tier, index) => normalizeTier(tier, index));
  for (let index = 1; index < tiers.length; index++) {
    if (compareAt(tiers[index].startedAt, tiers[index - 1].startedAt) < 0) {
      throw new TypeError("Permission tiers must be recorded in start-time order.");
    }
  }
  if (!["allow", "reject", "owner"].includes(value.verdict)) throw new TypeError("A permission verdict is invalid.");
  const verdict = value.verdict;
  if (value.code !== undefined && !(REJECT_CODES as readonly string[]).includes(value.code)) {
    throw new TypeError("A permission reject code is invalid.");
  }
  if (value.interruptClass !== undefined && !(INTERRUPT_CLASSES as readonly string[]).includes(value.interruptClass)) {
    throw new TypeError("A permission interrupt class is invalid.");
  }
  if (verdict === "reject" && (value.code === undefined || value.interruptClass !== undefined)) {
    throw new TypeError("A reject requires a code and cannot have an interrupt class.");
  }
  if (verdict === "owner" && (value.interruptClass === undefined || value.code !== undefined)) {
    throw new TypeError("An owner verdict requires an interrupt class and cannot have a reject code.");
  }
  if (verdict === "allow" && (value.code !== undefined || value.interruptClass !== undefined)) {
    throw new TypeError("An allow cannot have a reject code or interrupt class.");
  }
  const role = optionalString(value.role, "role");
  const family = optionalString(value.family, "family");
  const reuseKey = optionalString(value.reuseKey, "reuseKey");
  const replayOf = optionalString(value.replayOf, "replayOf");
  const repeats = optionalString(value.repeats, "repeats");
  if (repeats !== undefined && (verdict !== "reject" || !isEffectReject(value.code))) {
    throw new TypeError("A repeated request must be rejected with an effect reject code.");
  }
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > MAX_TEXT)) {
    throw new TypeError("A permission note must be text of at most 2000 characters.");
  }
  return {
    id, at, workspaceId, projectId, taskId, assignment, sessionId,
    ...(role === undefined ? {} : { role }), provider, ...(family === undefined ? {} : { family }), evidenceHash,
    ...(reuseKey === undefined ? {} : { reuseKey }),
    action: { tool, summary: action.summary }, rules: [...value.rules], tiers, verdict,
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.interruptClass === undefined ? {} : { interruptClass: value.interruptClass }),
    ...(value.note === undefined ? {} : { note: value.note }),
    ...(replayOf === undefined ? {} : { replayOf }), ...(repeats === undefined ? {} : { repeats }),
  };
}

function normalizeTier(value: PermissionTier, index: number): PermissionTier {
  assertPlainObject(value, `Permission tier ${index} must be an object.`);
  assertOnlyKeys(value, ["tier", "profileId", "family", "startedAt", "endedAt"]);
  if (value.tier !== "light" && value.tier !== "strong") throw new TypeError("A permission tier is invalid.");
  const startedAt = requiredTimestamp(value.startedAt, `tiers[${index}].startedAt`);
  const endedAt = requiredTimestamp(value.endedAt, `tiers[${index}].endedAt`);
  if (compareAt(endedAt, startedAt) < 0) throw new TypeError("A permission tier cannot end before it starts.");
  return {
    tier: value.tier,
    profileId: requiredString(value.profileId, `tiers[${index}].profileId`),
    family: requiredString(value.family, `tiers[${index}].family`),
    startedAt,
    endedAt,
  };
}

function hydrateDecision(db: EvidenceDb, row: DecisionRow): PermissionDecision {
  const note = row.note_sealed === null ? undefined : db.open<string>(NOTE_SEAL_TABLE, row.id, row.note_sealed);
  return {
    id: row.id,
    at: row.at,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    taskId: row.task_id,
    assignment: row.assignment,
    sessionId: row.session_id,
    ...(row.role === null ? {} : { role: row.role }),
    provider: row.provider,
    ...(row.family === null ? {} : { family: row.family }),
    evidenceHash: row.evidence_hash,
    ...(row.reuse_key === null ? {} : { reuseKey: row.reuse_key }),
    action: { tool: row.action_tool, summary: row.action_summary },
    rules: JSON.parse(row.rules_json) as string[],
    tiers: JSON.parse(row.tiers_json) as PermissionTier[],
    verdict: row.verdict,
    ...(row.code === null ? {} : { code: row.code }),
    ...(row.interrupt_class === null ? {} : { interruptClass: row.interrupt_class }),
    ...(note === undefined ? {} : { note }),
    ...(row.replay_of === null ? {} : { replayOf: row.replay_of }),
    ...(row.repeats === null ? {} : { repeats: row.repeats }),
  };
}

/**
 * The decision a replay record answers with. Every link must stay in one task and carry one outcome; a
 * citation that does not has no source.
 */
function replaySource(db: EvidenceDb, row: DecisionRow, seen = new Set<string>()): DecisionRow | undefined {
  if (seen.has(row.id)) return undefined;
  seen.add(row.id);
  if (row.replay_of === null) return row;
  const source = db.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, row.replay_of);
  if (!source || source.task_id !== row.task_id || source.verdict !== row.verdict || source.code !== row.code) return undefined;
  return replaySource(db, source, seen);
}

function sameFamily(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isOpen(db: EvidenceDb, row: DecisionRow): boolean {
  const canonical = canonicalDecision(db, row);
  if (!canonical) return false;
  const closures = db.all<{ seq: number; at: string }>(
    `SELECT seq,at FROM ${CONTROLS} WHERE decision_id=? AND kind IN ('close','reopen')`, canonical.id,
  );
  return !closures.some(event => compareOrder(event.at, event.seq, canonical.at, canonical.seq) > 0);
}

function ownerReopened(db: EvidenceDb, row: DecisionRow): boolean {
  const canonical = canonicalDecision(db, row);
  if (!canonical) return false;
  return db.all<{ seq: number; at: string }>(
    `SELECT seq,at FROM ${CONTROLS} WHERE decision_id=? AND kind='reopen'`, canonical.id,
  ).some(event => compareOrder(event.at, event.seq, canonical.at, canonical.seq) > 0);
}

/**
 * The one decision whose open, closed and reopened state a record shares: the reject it repeats, else the
 * decision it replays, else itself.
 */
function canonicalDecision(db: EvidenceDb, row: DecisionRow, seen = new Set<string>()): DecisionRow | undefined {
  if (seen.has(row.id)) return undefined;
  seen.add(row.id);
  const next = row.repeats ?? row.replay_of;
  if (next === null) return row;
  const canonical = db.get<DecisionRow>(`SELECT * FROM ${DECISIONS} WHERE id=?`, next);
  return canonical === undefined ? undefined : canonicalDecision(db, canonical, seen);
}

function repeatCountInDb(db: EvidenceDb, assignment: string, rejectId: string): number {
  const repeats = db.all<DecisionRow>(
    `SELECT * FROM ${DECISIONS} WHERE assignment=? AND repeats=? AND `
    + `(code IS NULL OR code NOT IN (${placeholders(HOST_REJECT_CODES.length)}))`,
    assignment, rejectId, ...HOST_REJECT_CODES,
  );
  const resets = db.all<ControlRow>(
    `SELECT seq,kind,at,decision_id,assignment FROM ${CONTROLS} `
    + "WHERE (kind='unlock' AND assignment=?) OR (kind='reopen' AND decision_id=?)",
    assignment, rejectId,
  );
  if (resets.length === 0) return repeats.length;
  const latestReset = resets.reduce((latest, event) => compareOrder(event.at, event.seq, latest.at, latest.seq) > 0
    ? event
    : latest);
  return repeats.filter(row => compareOrder(row.at, row.seq, latestReset.at, latestReset.seq) > 0).length;
}

function insertControl(tx: EvidenceTx, event: {
  kind: ControlRow["kind"];
  at: string;
  by?: string;
  decisionId?: string;
  assignment?: string;
  taskId?: string;
  projectId?: string;
  reason?: string;
}): void {
  const seq = nextSequence(tx);
  tx.run(
    `INSERT INTO ${CONTROLS} (seq,kind,at,by,decision_id,assignment,task_id,project_id,reason) VALUES (?,?,?,?,?,?,?,?,?)`,
    seq, event.kind, event.at, event.by ?? null, event.decisionId ?? null, event.assignment ?? null,
    event.taskId ?? null, event.projectId ?? null, event.reason ?? null,
  );
}

function nextSequence(tx: EvidenceTx): number {
  return tx.run(`INSERT INTO ${ORDER} DEFAULT VALUES`).lastInsertRowid;
}

/**
 * The journal's own sequence is the order of record. Timestamps are labels: two events can carry
 * the same one, and a host clock can step backwards.
 */
function compareOrder(_leftAt: string, leftSeq: number, _rightAt: string, rightSeq: number): number {
  return leftSeq - rightSeq;
}

function compareAt(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function assertPlainObject(value: unknown, message: string): asserts value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(message);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const valid = new Set(allowed);
  if (Object.keys(value).some(key => !valid.has(key))) throw new TypeError("An input contains an unknown field.");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty text.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function requiredTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp with a timezone.`);
  }
  return value;
}
