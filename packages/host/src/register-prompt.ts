import { autonomyOf } from "./autonomy.js";
import { entryToolsFor } from "./entry-roles.js";
import { ROLE_KINDS } from "./evidence/member-entry.js";
import type { MemberEntryKind } from "./evidence/entry-types.js";
import type { RegisterDigest, TeamMember, TeamRun } from "./team-types.js";

export const REGISTER_LEAD = "Assumptions and open questions from the owner's objective record. A verified or refuted assumption rests on a host receipt or the owner; an assumed one stands in until it is tested; plan around unchecked and refuted ones; only the owner answers an open question";
export const ASK_SENTENCE = "Ask for a user decision if a material scope decision is required.";
export const PROPOSE_SENTENCE = "When the work depends on something the record does not settle, do not wait for a user decision: post a finding whose body proposes an assumption (a statement, what would refute it, a test, and a criticality), and plan so that the work survives if it is refuted. A proposal is a claim and changes no status.";

export function registerText(register: RegisterDigest): string {
  return `${REGISTER_LEAD}:\n${JSON.stringify(register)}`;
}

export function scopeSentence(run: TeamRun, role: TeamMember["role"]): string {
  const kinds = (ROLE_KINDS as Readonly<Record<string, readonly MemberEntryKind[]>>)[role] ?? [];
  const proposes = Boolean(run.goal?.record?.register) && autonomyOf(run) === "autonomous" && entryToolsFor(run, role) && kinds.includes("finding");
  return proposes ? PROPOSE_SENTENCE : ASK_SENTENCE;
}
