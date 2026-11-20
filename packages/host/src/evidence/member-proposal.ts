import { z } from "zod";
import { bytes, boundedJson } from "../intent-report.js";
import { ID_RE } from "../objective-types.js";

/** Bounds of a member's assumption field. The host screens each proposal at ingest (objective-intent.ts); this file checks shape and size. */
export const PROPOSAL_FIELD_LIMITS = { statementBytes: 500, refutedByBytes: 500, testBytes: 1_024 } as const;

/** A stance on an assumption that exists, or a new proposal. A finding names at most one. */
export type MemberProposal =
  | { id: string; stance: "supports" | "contradicts" }
  | { propose: { statement: string; refutedBy: string; test: unknown; criticality: "outcome" | "plan" | "detail" } };

const L = PROPOSAL_FIELD_LIMITS;

const stanceSchema = z.object({ id: z.string().regex(ID_RE), stance: z.enum(["supports", "contradicts"]) }).strict();
const proposeSchema = z.object({
  propose: z.object({
    statement: bytes(L.statementBytes),
    refutedBy: bytes(L.refutedByBytes),
    test: boundedJson(L.testBytes),
    criticality: z.enum(["outcome", "plan", "detail"]),
  }).strict(),
}).strict();

/** Strict. `id` uses the record's own ID rule (ID_RE), so the two never drift; `test` is bounded JSON of at most 1,024 bytes. */
export const memberProposalSchema: z.ZodType<MemberProposal> = z.union([stanceSchema, proposeSchema]);
