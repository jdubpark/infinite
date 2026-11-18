import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence/crypto.js";
import type { MemberProposal } from "./evidence/member-proposal.js";
import { findSecret } from "./evidence/secret-scan.js";
import { testOf } from "./objective-intent.js";
import { REGISTER_OPS } from "./objective-record.js";
import { assertLogRoom, nextRecordId, nextSeq, sealRecord } from "./objective-write.js";
import { OBJECTIVE_LIMITS, cappedBytes } from "./objective-types.js";
import type { Assumption, LogEntry, ObjectiveRecord } from "./objective-types.js";
import { TeamError } from "./team-workspace.js";
import type { TeamCommand } from "./team-types.js";

/** Caps of a member's proposals. `log` is the share that proposals may fill; intent checks, receipts, and owner ops keep the rest. */
export const PROPOSAL_LIMITS = {
  log: { entries: 300, bytes: 160 * 1024 },
  cappedBytes: 24 * 1024,
  addedPerEntry: 4,
  attachedPerEntry: 16,
} as const;

export type ProposalDrop = "test" | "command" | "secret" | "target" | "attempt" | "stances" | "assumptions" | "bytes" | "log" | "refused";
export type Proposal = { entryId: string; memberId: string; revision: number; authorRole: string; summary: string; assumption: MemberProposal };
export type ProposalContext = { runId: string; configured: readonly TeamCommand[]; at: string };
export type ProposalsApplied = { record?: ObjectiveRecord; added: string[]; attached: number; dropped: Record<ProposalDrop, number> };

type Attached = { id: string; entryId: string };
type Outcome = "applied" | ProposalDrop;

const NO_OWN = { token: "", url: "" };

function noDrops(): Record<ProposalDrop, number> {
  return { test: 0, command: 0, secret: 0, target: 0, attempt: 0, stances: 0, assumptions: 0, bytes: 0, log: 0, refused: 0 };
}

const digestOf = (value: unknown): string => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");

/** The inline value of an entry, or undefined for a reference. */
function inlineOf(entry: LogEntry): Record<string, unknown> | undefined {
  const value = entry.after;
  return value !== undefined && "inline" in value && typeof value.inline === "object" && value.inline !== null ? value.inline as Record<string, unknown> : undefined;
}

/** The additions a member already holds: every proposal entry that targets the member. */
function additionsBy(record: ObjectiveRecord, memberId: string): number {
  return record.log.reduce((total, entry) => {
    if (entry.op !== REGISTER_OPS.proposed || entry.target !== memberId) return total;
    const added = inlineOf(entry)?.added;
    return total + (Array.isArray(added) ? added.length : 0);
  }, 0);
}

function afterOf(revision: number, added: readonly string[], addedDigest: string, attached: readonly Attached[]): Record<string, unknown> {
  return { revision, added: [...added], addedDigest, attached: attached.map(item => ({ id: item.id, entryId: item.entryId })) };
}

/**
 * Groups attachments 16 to an entry. Record ids are at most 40 characters and entry ids are uuids, so a full first entry
 * stays under 1.8 KiB, inside the 2 KiB inline cap.
 */
function groupAttached(items: readonly Attached[]): Attached[][] {
  const groups: Attached[][] = [];
  for (let start = 0; start < items.length; start += PROPOSAL_LIMITS.attachedPerEntry) groups.push(items.slice(start, start + PROPOSAL_LIMITS.attachedPerEntry));
  return groups.length === 0 ? [[]] : groups;
}

/** The screened proposal's assumption, as the record stores it. Its test is the screened test from `testOf`. */
function createdAssumption(id: string, propose: Extract<MemberProposal, { propose: unknown }>["propose"], test: Assumption["test"], entry: { entryId: string; summary: string; authorRole: string }): Assumption {
  return {
    id,
    statement: propose.statement,
    status: "unchecked",
    origin: "member",
    criticality: propose.criticality,
    refutedBy: propose.refutedBy,
    test,
    evidence: [],
    proposals: [{ entryId: entry.entryId, stance: "supports", summary: entry.summary, authorRole: entry.authorRole }],
  };
}

/**
 * One member's page of proposals, applied in journal order at one version up. Each proposal is screened once, in this order:
 * a repeated entry is skipped and not counted; a secret drops; a stance needs an existing assumption and a free slot; a new
 * proposal needs a valid test, the member's cap, the assumption cap, and the capped-bytes cap. Member text stays in the record.
 * A page that changes nothing returns no record. A log or schema refusal counts every proposal of the page under `log` or `refused`.
 * Never throws.
 */
export function applyProposals(record: ObjectiveRecord, proposals: readonly Proposal[], context: ProposalContext): ProposalsApplied {
  const dropped = noDrops();
  const outcomes: Outcome[] = [];
  const memberId = proposals[0]?.memberId ?? "";
  const seen = new Set(record.assumptions.flatMap(item => item.proposals.map(stance => stance.entryId)));
  let assumptions = [...record.assumptions];
  const addedIds: string[] = [];
  const addedObjects: Assumption[] = [];
  const attached: Attached[] = [];
  let revision: number | undefined;
  const memberAdded = additionsBy(record, memberId);
  const drop = (reason: ProposalDrop): void => {
    dropped[reason] += 1;
    outcomes.push(reason);
  };
  const applied = (page: number): void => {
    outcomes.push("applied");
    revision ??= page;
  };

  for (const item of proposals) {
    if (seen.has(item.entryId)) continue;
    if (item.memberId !== memberId) {
      drop("refused");
      continue;
    }
    if (findSecret({ summary: item.summary, assumption: item.assumption }, NO_OWN)) {
      drop("secret");
      continue;
    }
    const field = item.assumption;
    if ("id" in field) {
      const index = assumptions.findIndex(candidate => candidate.id === field.id);
      if (index < 0 || addedIds.includes(field.id)) {
        drop("target");
        continue;
      }
      const current = assumptions[index]!;
      if (current.proposals.length >= OBJECTIVE_LIMITS.proposalsPerAssumption) {
        drop("stances");
        continue;
      }
      assumptions[index] = {
        ...current,
        proposals: [...current.proposals, { entryId: item.entryId, stance: field.stance, summary: item.summary, authorRole: item.authorRole }],
      };
      attached.push({ id: field.id, entryId: item.entryId });
      seen.add(item.entryId);
      applied(item.revision);
      continue;
    }
    const verdict = testOf(field.propose.test, context.configured);
    if (!verdict.ok) {
      drop(verdict.drop === "command" ? "command" : "test");
      continue;
    }
    if (memberAdded + addedIds.length >= PROPOSAL_LIMITS.addedPerEntry) {
      drop("attempt");
      continue;
    }
    if (assumptions.length >= OBJECTIVE_LIMITS.assumptions) {
      drop("assumptions");
      continue;
    }
    const id = nextRecordId("a", assumptions.map(candidate => candidate.id));
    const created = createdAssumption(id, field.propose, verdict.value, { entryId: item.entryId, summary: item.summary, authorRole: item.authorRole });
    const candidate = [...assumptions, created];
    if (cappedBytes({ ...record, assumptions: candidate }) > PROPOSAL_LIMITS.cappedBytes) {
      drop("bytes");
      continue;
    }
    assumptions = candidate;
    addedIds.push(id);
    addedObjects.push(created);
    seen.add(item.entryId);
    applied(item.revision);
  }

  if (addedIds.length === 0 && attached.length === 0) return { added: [], attached: 0, dropped };

  const version = record.version + 1;
  const addedDigest = digestOf(addedObjects);
  const groups = groupAttached(attached);
  const entries: LogEntry[] = groups.map((group, index) => ({
    seq: nextSeq(record) + index,
    at: context.at,
    version,
    actor: "member",
    authority: "claim",
    op: REGISTER_OPS.proposed,
    target: memberId,
    after: {
      inline: index === 0
        ? afterOf(revision!, addedIds, addedDigest, group)
        : afterOf(revision!, [], digestOf([]), group),
    },
    handle: context.runId,
  }));

  try {
    assertLogRoom(record, entries, PROPOSAL_LIMITS.log);
    const next = sealRecord(record, { assumptions }, entries);
    return { record: next, added: addedIds, attached: attached.length, dropped };
  } catch (error) {
    // Every proposal of the page counts under the reason that refused it, so nothing is lost from the counts.
    const reason: ProposalDrop = error instanceof TeamError && error.code === "objective-log-full" ? "log" : "refused";
    const all = noDrops();
    all[reason] = outcomes.length;
    return { added: [], attached: 0, dropped: all };
  }
}
