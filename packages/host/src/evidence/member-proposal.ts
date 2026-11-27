import { z } from "zod";
import { bytes, boundedJson } from "../intent-report.js";
import { ID_RE } from "../schema-primitives.js";

export const PROPOSAL_FIELD_LIMITS = { statementBytes: 500, refutedByBytes: 500, testBytes: 1_024 } as const;

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

export const memberProposalSchema: z.ZodType<MemberProposal> = z.union([stanceSchema, proposeSchema]);
