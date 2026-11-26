import type { Manager } from "./manager.js";
import type { MissionReport } from "./mission-types.js";
import type { MissionMessage } from "./team-prompts.js";
import type { NativeContinuation } from "./team-types.js";
import { MAX_RECORDED_MESSAGE } from "./transcript.js";
import { ledgerRecord } from "./usage-store.js";

const MAX_CONTEXT_WARNING_SESSIONS = 256;
const MAX_SCAN_PAGES = 50;

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
  prompt: string;
  continuation?: NativeContinuation;
  nativeConfirmed?: boolean;
  resumeFailed?: boolean;
  deliveryUncertain?: boolean;
  report?: MissionReport;
  consumedInbox?: MissionMessage[];
  consumedNotes?: MissionMessage[];
};

export type MissionQueueState = {
  inbox: MissionMessage[];
  notes: MissionMessage[];
  deliveredUnapplied?: DeliveredUnappliedBatch[];
};

export type AttemptDeliveryStatus =
  | { kind: "confirmed"; nativeSessionId: string }
  | { kind: "not-delivered" }
  | { kind: "uncertain"; nativeSessionId: string };

export function isMissingSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function classifyContextReadError(error: unknown): string {
  if (error instanceof SyntaxError) return "invalid-json";
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  if (code && /^E[A-Z0-9_]{1,24}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (
    message === "Journal sequence mismatch"
    || message === "Incomplete journal; recovery required"
    || message === "Unsupported vault version"
  ) {
    return "journal-integrity";
  }
  if (/unable to authenticate|unsupported state|invalid authentication tag/i.test(message)) {
    return "decrypt-failed";
  }
  return "read-failed";
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
        `[Infinite] Mission ${missionId} could not read context usage for coordinator session ${attempt.sessionId} (${classifyContextReadError(error)}); size-based rotation is using the last observed token count.`,
      );
    }
  }
}

function revisionMarkerEnd(prompt: string, revision: number): number {
  const period = `This is coordinator attempt ${revision}.`;
  const periodIndex = prompt.indexOf(period);
  if (periodIndex >= 0) return periodIndex + period.length;
  const comma = `This is coordinator attempt ${revision},`;
  const commaIndex = prompt.indexOf(comma);
  if (commaIndex >= 0) return commaIndex + comma.length;
  return -1;
}

export function transcriptMatchesAttemptPrompt(recordedText: string, attemptPrompt: string, revision: number): boolean {
  const expected = attemptPrompt.trim();
  const actual = recordedText.trim();
  if (!expected || !actual) return false;
  if (actual === expected) return true;
  if (expected.length > MAX_RECORDED_MESSAGE && actual === expected.slice(0, MAX_RECORDED_MESSAGE).trimEnd()) {
    return true;
  }
  if (actual.startsWith("Shared project context (version ")) {
    const minPrefixLength = revisionMarkerEnd(expected, revision);
    const headerEnd = expected.indexOf("\n\n");
    const leadingLine = headerEnd >= 0 ? expected.slice(0, headerEnd) : expected;
    const boundary = `\n\n${leadingLine}`;
    let index = actual.indexOf(boundary);
    while (index >= 0) {
      const body = actual.slice(index + 2);
      if (body === expected) return true;
      if (
        minPrefixLength > 0
        && body.length >= minPrefixLength
        && recordedText.length >= MAX_RECORDED_MESSAGE
        && expected.startsWith(body)
      ) {
        return true;
      }
      index = actual.indexOf(boundary, index + 2);
    }
  }
  return false;
}

export function classifyAttemptDelivery(
  attempt: ConsumedAttempt,
  readEvents: CoordinatorEventReader,
): AttemptDeliveryStatus {
  const nativeSessionId = attempt.continuation?.nativeSessionId;
  if (!nativeSessionId || !attempt.nativeConfirmed) return { kind: "not-delivered" };
  if (attempt.report !== undefined) return { kind: "confirmed", nativeSessionId };
  try {
    let cursor = 0;
    let sawTurnStart = false;
    for (let pages = 0; pages < MAX_SCAN_PAGES; pages++) {
      const page = readEvents(attempt.sessionId, cursor, 200, new Set(["signal", "message"]));
      for (const event of page.events) {
        if (event.type === "message") {
          if (
            event.data.role === "user"
            && typeof event.data.text === "string"
            && transcriptMatchesAttemptPrompt(event.data.text, attempt.prompt, attempt.revision)
          ) {
            return { kind: "confirmed", nativeSessionId };
          }
        } else if (event.type === "signal" && event.data.source === "hook") {
          const kind = typeof event.data.kind === "string" ? event.data.kind : "";
          if (kind === "turn-start") {
            sawTurnStart = true;
          } else if (kind === "tool-start" || kind === "tool-end") {
            return { kind: "confirmed", nativeSessionId };
          } else if (kind === "turn-end") {
            if (event.data.failed === true) sawTurnStart = true;
            else return { kind: "confirmed", nativeSessionId };
          }
        }
      }
      if (!page.more) {
        return sawTurnStart ? { kind: "uncertain", nativeSessionId } : { kind: "not-delivered" };
      }
      if (page.cursor <= cursor) {
        return { kind: "uncertain", nativeSessionId };
      }
      cursor = page.cursor;
    }
    return { kind: "uncertain", nativeSessionId };
  } catch {
    return { kind: "uncertain", nativeSessionId };
  }
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

function restoreDeliveredBatches(
  stored: MissionQueueState,
  shouldRestore: (batch: DeliveredUnappliedBatch) => boolean,
): void {
  const batches = stored.deliveredUnapplied;
  if (!batches?.length) return;
  const restoredInbox: MissionMessage[] = [];
  const restoredNotes: MissionMessage[] = [];
  const kept: DeliveredUnappliedBatch[] = [];
  for (const batch of batches) {
    if (shouldRestore(batch)) {
      restoredInbox.push(...batch.inbox);
      restoredNotes.push(...batch.notes);
    } else {
      kept.push(batch);
    }
  }
  if (restoredInbox.length) stored.inbox = [...restoredInbox, ...stored.inbox];
  if (restoredNotes.length) stored.notes = [...restoredNotes, ...stored.notes];
  if (kept.length) stored.deliveredUnapplied = kept;
  else delete stored.deliveredUnapplied;
}

export function settleUnappliedConsumed(
  stored: MissionQueueState,
  attempt: ConsumedAttempt,
  readEvents: CoordinatorEventReader,
): AttemptDeliveryStatus {
  const inbox = attempt.consumedInbox ?? [];
  const notes = attempt.consumedNotes ?? [];
  if (!inbox.length && !notes.length) {
    delete attempt.consumedInbox;
    delete attempt.consumedNotes;
    return { kind: "not-delivered" };
  }
  const delivery = classifyAttemptDelivery(attempt, readEvents);
  if (delivery.kind === "not-delivered") {
    returnConsumedMessages(stored, attempt);
    return delivery;
  }
  if (delivery.kind === "uncertain") {
    attempt.deliveryUncertain = true;
    returnConsumedMessages(stored, attempt);
    restoreDeliveredBatches(stored, batch => batch.nativeSessionId === delivery.nativeSessionId);
    return delivery;
  }
  const batches = stored.deliveredUnapplied ??= [];
  const last = batches.at(-1);
  if (last && last.nativeSessionId === delivery.nativeSessionId) {
    last.inbox.push(...inbox);
    last.notes.push(...notes);
  } else {
    batches.push({ nativeSessionId: delivery.nativeSessionId, inbox: [...inbox], notes: [...notes] });
  }
  delete attempt.consumedInbox;
  delete attempt.consumedNotes;
  return delivery;
}

export function hasPendingCoordinatorInbox(stored: MissionQueueState): boolean {
  return stored.inbox.length > 0 || Boolean(stored.deliveredUnapplied?.some(batch => batch.inbox.length > 0));
}

export function reconcileDeliveredUnapplied(stored: MissionQueueState, resumedNativeSessionId: string | undefined): void {
  restoreDeliveredBatches(stored, batch => resumedNativeSessionId === undefined || batch.nativeSessionId !== resumedNativeSessionId);
}
