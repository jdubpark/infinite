import { canonicalJson } from "./evidence/crypto.js";
import { getForMember, listForMember, readMemberScope, supersedeTarget, type MemberEntry, type MemberList } from "./evidence/entry-reads.js";
import { MAX_ENTRY_BODY_BYTES, MAX_ENTRY_REQUEST_BYTES, memberEntryEnvelopeSchema, memberEntryId, postAllowed, refusalPath, type MemberEntryPost, type MemberScope } from "./evidence/member-entry.js";
import type { EvidenceReader } from "./evidence/reader.js";
import { findSecret, type SecretClass } from "./evidence/secret-scan.js";
import type { EvidenceDb } from "./evidence/types.js";
import { ENTRY_ROLES } from "./entry-roles.js";
import { HookPayloadError, type HookReply } from "./hooks.js";
import type { TeamAssignment, TeamRole } from "./team-types.js";

export const MAX_ATTEMPT_POSTS = 20;
export const MAX_ATTEMPT_POST_BYTES = 64 * 1024;
export const MAX_ATTEMPT_SERVED_BYTES = 256 * 1024;
export const MAX_ATTEMPT_READ_CALLS = 200;

export type PendingEntry = { entryId: string; state: "pending" };

export type EntryRefusal = "entry-tools-off" | "entry-too-large" | "entry-invalid" | "entry-binding" | "entry-closed"
  | "entry-id-mismatch" | "entry-kind-forbidden" | "entry-task-forbidden" | "entry-supersede-forbidden" | "entry-secret"
  | "entry-post-limit" | "entry-read-limit" | "entry-not-found" | "entry-unavailable";

export const ENTRY_REFUSALS: Readonly<Record<EntryRefusal, string>> = {
  "entry-tools-off": "entry-tools-off: entry tools are not enabled for this member.",
  "entry-too-large": "entry-too-large: a request is at most 16 KiB.",
  "entry-invalid": "entry-invalid: the request does not match the entry schema.",
  "entry-binding": "entry-binding: the request does not match this member's assignment.",
  "entry-closed": "entry-closed: entry tools close when the member reports or stops.",
  "entry-id-mismatch": "entry-id-mismatch: requestId must be the identity of this entry.",
  "entry-kind-forbidden": "entry-kind-forbidden: this role may not post this kind.",
  "entry-task-forbidden": "entry-task-forbidden: an entry may name only this member's own task, and a handoff needs one.",
  "entry-supersede-forbidden": "entry-supersede-forbidden: an entry may supersede only an entry of the same kind that this member wrote or that belongs to its own task.",
  "entry-secret": "entry-secret: this field looks like a secret. Remove it and post again.",
  "entry-post-limit": "entry-post-limit: this attempt has posted 20 entries or 64 KiB.",
  "entry-read-limit": "entry-read-limit: this attempt has read 256 KiB or made 200 read calls.",
  "entry-not-found": "entry-not-found: no entry with this id is visible to this member.",
  "entry-unavailable": "entry-unavailable: the entry store cannot be read now. Continue your assignment without it.",
};

const BODY_TOO_LARGE = "entry-too-large: an entry body is at most 12 KiB.";
const SERVED_TOO_LARGE = "entry-too-large: this entry's body is over 64 KiB and is not served in this phase.";
const SECRET_CLASSES: Readonly<Record<SecretClass, string>> = {
  "private-key": "a private key",
  "access-token": "an access token",
  "hook-token": "this member's hook token",
  "hook-url": "this member's hook address",
  "session-credential": "a credential the host gave this session",
};

export type EntryRouteOptions = {
  team: TeamAssignment;
  own: () => { token: string; url: string; credentials?: readonly string[] };
  reader: () => Pick<EvidenceReader, "read">;
  running: () => boolean;
  reported: () => boolean;
  append: (type: "team-entry" | "team-entry-read", data: Record<string, unknown>) => void;
};

const refuse = (status: number, text: string) => new HookPayloadError(status, text);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bytesOf = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");

function oversizedBody(body: unknown): boolean {
  if (!isRecord(body) || body.op !== "post" || !isRecord(body.entry) || body.entry.body === undefined) return false;
  return bytesOf(body.entry.body) > MAX_ENTRY_BODY_BYTES;
}

function supersedeAllowed(
  target: { kind: string; author: string; authorMemberId?: string; taskId?: string },
  entry: MemberEntryPost,
  memberId: string,
): boolean {
  if (target.author !== "member" || target.kind !== entry.kind) return false;
  if (target.authorMemberId === memberId) return true;
  return entry.taskId !== undefined && target.taskId === entry.taskId;
}

export function createEntryRoute(options: EntryRouteOptions): { handle(body: unknown): HookReply } {
  const { team } = options;
  const binding = { runId: team.runId, memberId: team.memberId, revision: team.revision };
  const accepted = new Map<string, HookReply>();
  let postBytes = 0;
  let readCalls = 0;
  let servedBytes = 0;

  const read = <T>(fn: (db: EvidenceDb, scope: MemberScope) => T): T => {
    try {
      return options.reader().read(db => {
        const scope = readMemberScope(db, team.memberId);
        if (scope === undefined || scope.runId !== team.runId) throw new Error("no scope for this member");
        return fn(db, scope);
      });
    } catch (error) {
      if (error instanceof HookPayloadError) throw error;
      throw refuse(503, ENTRY_REFUSALS["entry-unavailable"]);
    }
  };

  return {
    handle(body: unknown): HookReply {
      if (team.entryTools !== true || !ENTRY_ROLES.has(team.role as TeamRole)) throw refuse(403, ENTRY_REFUSALS["entry-tools-off"]);
      if (bytesOf(body) > MAX_ENTRY_REQUEST_BYTES) throw refuse(413, ENTRY_REFUSALS["entry-too-large"]);
      const parsed = memberEntryEnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        if (oversizedBody(body)) throw refuse(413, BODY_TOO_LARGE);
        const path = refusalPath(parsed.error.issues[0]?.path ?? []) || "request";
        throw refuse(400, `entry-invalid at ${path}: the request does not match the entry schema.`);
      }
      const envelope = parsed.data;
      if (envelope.runId !== binding.runId || envelope.memberId !== binding.memberId || envelope.revision !== binding.revision) {
        throw refuse(403, ENTRY_REFUSALS["entry-binding"]);
      }
      if (!options.running() || options.reported()) throw refuse(409, ENTRY_REFUSALS["entry-closed"]);

      if (envelope.op === "post") {
        const { entry, requestId } = envelope;
        if (memberEntryId(binding, entry) !== requestId) throw refuse(400, ENTRY_REFUSALS["entry-id-mismatch"]);
        const allowed = postAllowed(team, entry);
        if (allowed === "entry-kind-forbidden") throw refuse(403, ENTRY_REFUSALS["entry-kind-forbidden"]);
        if (allowed === "entry-task-forbidden") throw refuse(403, ENTRY_REFUSALS["entry-task-forbidden"]);
        const secret = findSecret({ entry }, options.own());
        if (secret) {
          throw refuse(422, `entry-secret at ${secret.path}: this field looks like ${SECRET_CLASSES[secret.cls]}. Remove it and post again.`);
        }
        const first = accepted.get(requestId);
        if (first) return first;
        const size = bytesOf(entry.body);
        if (accepted.size >= MAX_ATTEMPT_POSTS || postBytes + size > MAX_ATTEMPT_POST_BYTES) {
          throw refuse(429, ENTRY_REFUSALS["entry-post-limit"]);
        }
        const supersedes = "supersedes" in entry ? entry.supersedes : undefined;
        if (supersedes !== undefined) {
          const target = read((db, scope) => supersedeTarget(db, scope, supersedes));
          if (target === undefined) throw refuse(404, ENTRY_REFUSALS["entry-not-found"]);
          if (!supersedeAllowed(target, entry, binding.memberId)) throw refuse(403, ENTRY_REFUSALS["entry-supersede-forbidden"]);
        }
        options.append("team-entry", envelope);
        postBytes += size;
        const receipt: PendingEntry = { entryId: requestId, state: "pending" };
        const answer: HookReply = { entry: receipt };
        accepted.set(requestId, answer);
        return answer;
      }

      if (readCalls >= MAX_ATTEMPT_READ_CALLS) throw refuse(429, ENTRY_REFUSALS["entry-read-limit"]);
      let value: MemberList | MemberEntry;
      if (envelope.op === "list") {
        value = read((db, scope) => listForMember(db, scope, envelope.query));
      } else {
        const found = read((db, scope) => getForMember(db, scope, envelope.entryId));
        if (found === undefined) throw refuse(404, ENTRY_REFUSALS["entry-not-found"]);
        if (found === "too-large") throw refuse(413, SERVED_TOO_LARGE);
        value = found;
      }
      const answer: HookReply = { entry: value as unknown as Record<string, unknown> };
      const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
      if (servedBytes + bytes > MAX_ATTEMPT_SERVED_BYTES) throw refuse(429, ENTRY_REFUSALS["entry-read-limit"]);
      readCalls += 1;
      servedBytes += bytes;
      options.append("team-entry-read", { op: envelope.op, servedBytes: bytes });
      return answer;
    },
  };
}
