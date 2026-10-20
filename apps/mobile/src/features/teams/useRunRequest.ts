import { useCallback, useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { api, ApiError, type Connection } from "../../api/client";
import { runRequests, type RunRequest } from "../../store/requests";

const inFlight = new Set<string>();

/**
 * Sends team and goal requests with a request identity and the revision they were decided
 * against. A refusal (4xx) clears the request and refreshes the run. Any other failure leaves
 * delivery unconfirmed: the exact request stays pending, and `retry` resends it so the host
 * either recovers its recorded result or applies it once.
 */
export function useRunRequest<R extends { id: string; revision: number }>(connection: Connection, key: string, handlers: {
  accepted: (result: R, request: RunRequest) => void;
  refused: () => void;
}) {
  const state = runRequests.use(key);
  const pending = state.pending;
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // A send started before this screen remounted is still in flight; its result re-renders through the store.
  const busy = sending || Boolean(pending && inFlight.has(pending.requestId));
  const mounted = useRef(true);
  const latest = useRef(handlers);
  const dismissMessage = useCallback(() => runRequests.clearMessage(key), [key]);
  useEffect(() => { latest.current = handlers; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function send(request: RunRequest) {
    if (inFlight.has(request.requestId)) return;
    inFlight.add(request.requestId);
    setSending(true);
    try {
      const result = await api<R>(connection, request.path, { body: { requestId: request.requestId, revision: request.revision, ...request.fields } });
      const settled = runRequests.complete(key, request.requestId, { id: result.id }, `${request.label} recorded · revision ${result.revision}.`);
      if (settled && mounted.current) latest.current.accepted(result, request);
    } catch (error) {
      const refused = error instanceof ApiError && error.status >= 400 && error.status < 500;
      runRequests.fail(key, request.requestId, `${(error as Error).message}${refused ? " The latest state was requested; review it before sending again." : " Delivery is unconfirmed. Retry sends this exact request."}`, refused);
      if (refused && mounted.current) latest.current.refused();
    } finally {
      inFlight.delete(request.requestId);
      if (mounted.current) { setRetrying(false); setSending(false); }
    }
  }
  return {
    pending,
    busy,
    retrying,
    message: state.message,
    /** The last message reports a recorded result rather than a failure. */
    recorded: Boolean(state.result),
    dismissMessage,
    send(path: string, label: string, revision: number, fields: Record<string, string | number> = {}) {
      if (busy || pending) return;
      // The request store's legacy field declaration is string-only; keep the runtime number intact for JSON.
      void send(runRequests.begin(key, { requestId: Crypto.randomUUID(), revision, path, label, fields: fields as Record<string, string> }));
    },
    retry() { if (pending && !busy) { setRetrying(true); void send(pending); } },
    /** Only after the person has checked the run: the host may already have applied the request. */
    discard() { if (!busy) runRequests.clear(key); },
  };
}
export type RunRequestControl = ReturnType<typeof useRunRequest>;
