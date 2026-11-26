import type { Manager } from "./manager.js";
import type { MissionReport } from "./mission-types.js";
import type { MissionMessage } from "./team-prompts.js";
import type { NativeContinuation } from "./team-types.js";
import { ledgerRecord } from "./usage-store.js";

const MAX_CONTEXT_WARNING_SESSIONS = 256;
const MAX_REASON_CHARS = 200;
const MAX_SCAN_PAGES = 50;
const HOOK_DELIVERY_SIGNALS = new Set(["turn-start", "tool-start", "tool-end", "turn-end"]);

export type CoordinatorEventReader = (
  sessionId: string,
  after: number,
  limit: number,
  types?: Set<string>,
) => ReturnType<Manager["events"]>;

export type DeliveredUnappliedBatch = {
  nativeSessionId: string;
  inbox: MissionMessage[];
  notes: MissionMessage[];
};

export type ConsumedAttempt = {
  sessionId: string;
  revision: number;
  continuation?: NativeContinuation;
  nativeConfirmed?: boolean;
  report?: MissionReport;
  consumedInbox?: MissionMessage[];
  consumedNotes?: MissionMessage[];
  turnSignal?: { kind: string; at: string };
};

export type MissionQueueState = {
  inbox: MissionMessage[];
  notes: MissionMessage[];
  deliveredUnapplied?: DeliveredUnappliedBatch[];
};

export function isMissingSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function formatContextReadError(error: unknown): string {
  if (error instanceof SyntaxError) return "SyntaxError: invalid JSON";
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  const safeCode = code && /^[A-Z0-9_-]{1,32}$/i.test(code) ? code : undefined;
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = rawMessage.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  const bounded = cleaned.length > MAX_REASON_CHARS ? `${cleaned.slice(0, MAX_REASON_CHARS - 3)}...` : cleaned;
  if (safeCode && bounded) return bounded.includes(safeCode) ? bounded : `${safeCode}: ${bounded}`;
  return safeCode ?? (bounded || "unknown error");
}

export class CoordinatorContextReadTracker {
  private readonly warned = new Set<string>();

  observe(
    missionId: string,
    attempt: { sessionId: string; usageCursor?: number; contextTokens?: number },
    readEvents: CoordinatorEventReader,
  ): void {
    try {
      for (let pages = 0; pages < MAX_SCAN_PAGES; pages++) {
        const page = readEvents(attempt.sessionId, attempt.usageCursor ?? 0, 200, new Set(["usage"]));
        attempt.usageCursor = page.cursor;
        for (const event of page.events) {
          const record = event.type === "usage" ? ledgerRecord(event.data) : undefined;
          if (!record || record.secondary) continue;
          const { input, cacheRead, cacheWrite, output } = record.tokens;
          attempt.contextTokens = input + cacheRead + cacheWrite + output;
        }
        if (!page.more) {
          this.warned.delete(attempt.sessionId);
          return;
        }
      }
      this.warned.delete(attempt.sessionId);
    } catch (error) {
      if (isMissingSessionError(error)) {
        this.warned.delete(attempt.sessionId);
        return;
      }
      if (this.warned.has(attempt.sessionId)) return;
      if (this.warned.size >= MAX_CONTEXT_WARNING_SESSIONS) {
        const oldest = this.warned.values().next().value;
        if (oldest !== undefined) this.warned.delete(oldest);
      }
      this.warned.add(attempt.sessionId);
      console.warn(
        `[Infinite] Mission ${missionId} could not read context usage for coordinator session ${attempt.sessionId} (${formatContextReadError(error)}); size-based rotation is using the last observed token count.`,
      );
    }
  }
}

function transcriptContainsAttemptPrompt(text: string, revision: number): boolean {
  return text.includes(`This is coordinator attempt ${revision}.`)
    || text.includes(`This is coordinator attempt ${revision},`);
}

function deliveredNativeSession(attempt: ConsumedAttempt, readEvents: CoordinatorEventReader): string | undefined {
  const nativeSessionId = attempt.continuation?.nativeSessionId;
  if (!nativeSessionId || !attempt.nativeConfirmed) return undefined;
  if (attempt.report !== undefined) return nativeSessionId;
  try {
    let cursor = 0;
    for (let pages = 0; pages < MAX_SCAN_PAGES; pages++) {
      const page = readEvents(attempt.sessionId, cursor, 200, new Set(["signal", "message"]));
      for (const event of page.events) {
        if (event.type === "signal") {
          const kind = typeof event.data.kind === "string" ? event.data.kind : "";
          const source = event.data.source;
          if (source === "hook" && HOOK_DELIVERY_SIGNALS.has(kind) && (kind !== "turn-end" || event.data.failed !== true)) {
            return nativeSessionId;
          }
        } else if (event.type === "message") {
          if (event.data.role === "user" && typeof event.data.text === "string" && transcriptContainsAttemptPrompt(event.data.text, attempt.revision)) {
            return nativeSessionId;
          }
        }
      }
      if (!page.more || page.cursor <= cursor) return undefined;
      cursor = page.cursor;
    }
  } catch {
    if (attempt.turnSignal && HOOK_DELIVERY_SIGNALS.has(attempt.turnSignal.kind)) return nativeSessionId;
    return undefined;
  }
  return undefined;
}

export function returnConsumedMessages(
  stored: MissionQueueState,
  attempt: Pick<ConsumedAttempt, "consumedInbox" | "consumedNotes">,
): void {
  stored.inbox = [...(attempt.consumedInbox ?? []), ...stored.inbox];
  stored.notes = [...(attempt.consumedNotes ?? []), ...stored.notes];
  delete attempt.consumedInbox;
  delete attempt.consumedNotes;
}

export function settleUnappliedConsumed(
  stored: MissionQueueState,
  attempt: ConsumedAttempt,
  readEvents: CoordinatorEventReader,
): void {
  const inbox = attempt.consumedInbox ?? [];
  const notes = attempt.consumedNotes ?? [];
  if (!inbox.length && !notes.length) {
    delete attempt.consumedInbox;
    delete attempt.consumedNotes;
    return;
  }
  const nativeSessionId = deliveredNativeSession(attempt, readEvents);
  if (!nativeSessionId) {
    returnConsumedMessages(stored, attempt);
    return;
  }
  const batches = stored.deliveredUnapplied ??= [];
  const last = batches.at(-1);
  if (last && last.nativeSessionId === nativeSessionId) {
    last.inbox.push(...inbox);
    last.notes.push(...notes);
  } else {
    batches.push({ nativeSessionId, inbox: [...inbox], notes: [...notes] });
  }
  delete attempt.consumedInbox;
  delete attempt.consumedNotes;
}

export function hasPendingCoordinatorInbox(stored: MissionQueueState): boolean {
  return stored.inbox.length > 0 || Boolean(stored.deliveredUnapplied?.some(batch => batch.inbox.length > 0));
}

export function reconcileDeliveredUnapplied(stored: MissionQueueState, resumedNativeSessionId: string | undefined): void {
  const batches = stored.deliveredUnapplied;
  if (!batches?.length) return;
  const restoredInbox: MissionMessage[] = [];
  const restoredNotes: MissionMessage[] = [];
  const kept: DeliveredUnappliedBatch[] = [];
  for (const batch of batches) {
    if (resumedNativeSessionId !== undefined && batch.nativeSessionId === resumedNativeSessionId) {
      kept.push(batch);
    } else {
      restoredInbox.push(...batch.inbox);
      restoredNotes.push(...batch.notes);
    }
  }
  if (restoredInbox.length) stored.inbox = [...restoredInbox, ...stored.inbox];
  if (restoredNotes.length) stored.notes = [...restoredNotes, ...stored.notes];
  if (kept.length) stored.deliveredUnapplied = kept;
  else delete stored.deliveredUnapplied;
}
