import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import {
  api,
  ApiError,
  ControlRefusal,
  type Connection,
} from "../../api/client";
import { readDraft, settleDraft, useSessionDraft, writeDraft, type PendingInput } from "../../store/drafts";
import { leaseFor, type SessionControlHandle } from "./useSessionControl";

export const KEYS = ["enter", "escape", "up", "down", "interrupt"] as const;
export type SteeringKey = (typeof KEYS)[number];

/**
 * Text input and raw keys for one session, shared by the Brief and the
 * Terminal. An uncertain text send keeps its requestId, so "Retry" resends the
 * same request and the host cannot deliver it twice. The host refuses text
 * over an open dialog (`prompt-open`) unless `force` is set, which only the
 * Terminal does: there the person sees the dialog the text lands in.
 * Every send carries this phone's control lease, and nothing is sent without
 * one when the session `requiresControl`. The unsent text and an unconfirmed
 * request stay in memory under `draftKey` across navigation. `managed` makes
 * sends no-ops; callers set it only for a mission-run session with no provider
 * prompt open, so an open prompt can still be answered from the terminal.
 */
export function useSteering(
  connection: Connection,
  id: string,
  onDelivered: () => void,
  control: Pick<SessionControlHandle, "leaseId" | "refused">,
  options: { force?: boolean; draftKey: string; requiresControl: boolean; managed?: boolean },
) {
  const { draftKey } = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const draft = useSessionDraft(draftKey);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(""), 4000);
    return () => clearTimeout(timer);
  }, [receipt]);

  /** Resolves true once the host confirms delivery to the terminal. */
  async function send(): Promise<boolean> {
    if (inFlight.current || options.managed) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setReceipt("");
    const current = readDraft(draftKey);
    const retrying = current.pending !== null;
    const request: PendingInput = current.pending ?? {
      requestId: Crypto.randomUUID(),
      text: current.text,
      submit: true,
      ...(options.force ? { force: true } : {}),
    };
    writeDraft(draftKey, { text: current.text, pending: request });
    try {
      const lease = leaseFor(control, options.requiresControl);
      const result = await api<{ state: string }>(
        connection,
        `/sessions/${id}/input`,
        { body: request, control: lease },
      );
      if (result.state !== "delivered")
        throw new Error(
          "Delivery is uncertain. Check the screen before sending again.",
        );
      settleDraft(draftKey, request.requestId, true);
      setReceipt("Delivered to terminal. Agent execution is not yet confirmed.");
      onDelivered();
      return true;
    } catch (e) {
      if (e instanceof ControlRefusal) {
        // Refused before anything was typed. A refused retry says nothing about the first try.
        control.refused();
        if (!retrying) {
          settleDraft(draftKey, request.requestId, false);
        }
        setError(
          retrying
            ? `${e.message} This retry was refused. Earlier delivery remains unconfirmed; its request ID is kept.`
            : `${e.message} Your draft was not sent.`,
        );
        onDelivered();
      } else if (e instanceof ApiError && e.code === "prompt-open") {
        // Refused before anything was typed: the text stays in the box, unsent.
        settleDraft(draftKey, request.requestId, false);
        setError("A prompt is open. Answer it above, or reply instead.");
        onDelivered();
      } else if (e instanceof ApiError && e.code === "mission-managed") {
        // The session became mission-managed while the text was in flight. The host refused before typing, so nothing is retried.
        settleDraft(draftKey, request.requestId, false);
        setError(e.message);
        onDelivered();
      } else setError((e as Error).message);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function sendKey(key: SteeringKey) {
    if (inFlight.current || options.managed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setReceipt("");
    try {
      const lease = leaseFor(control, options.requiresControl);
      const result = await api<{ state: string }>(
        connection,
        `/sessions/${id}/key`,
        { body: { requestId: Crypto.randomUUID(), key }, control: lease },
      );
      if (result.state !== "delivered")
        throw new Error("Key delivery is uncertain. Check the screen first.");
      setReceipt(`${key[0].toUpperCase()}${key.slice(1)} sent to terminal.`);
      onDelivered();
    } catch (e) {
      if (e instanceof ControlRefusal) {
        control.refused();
        setError(`${e.message} The key was not sent.`);
        onDelivered();
      } else setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    receipt,
    pending: draft.pending !== null,
    text: draft.text,
    setText: (value: string) => { writeDraft(draftKey, { ...readDraft(draftKey), text: value }); },
    dismissStatus: () => { setReceipt(""); setError(""); },
    clearPending: () => { const current = readDraft(draftKey); if (!inFlight.current) writeDraft(draftKey, { text: current.text, pending: null }); },
    send,
    sendKey,
  };
}
