import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import {
  api,
  ApiError,
  ControlRefusal,
  type Connection,
} from "../../api/client";
import { readDraft, writeDraft, type PendingInput } from "../../store/drafts";
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
 * request stay in memory under `draftKey` across navigation.
 */
export function useSteering(
  connection: Connection,
  id: string,
  onDelivered: () => void,
  control: Pick<SessionControlHandle, "leaseId" | "refused">,
  options: { force?: boolean; draftKey: string; requiresControl: boolean },
) {
  const { draftKey } = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [text, setText] = useState(() => readDraft(draftKey).text);
  const pending = useRef<PendingInput | null>(readDraft(draftKey).pending);
  const [pendingInput, setPendingInput] = useState(
    () => readDraft(draftKey).pending !== null,
  );
  useEffect(() => {
    writeDraft(draftKey, { text, pending: pending.current });
  }, [draftKey, text, pendingInput]);

  /** Resolves true once the host confirms delivery to the terminal. */
  async function send(): Promise<boolean> {
    setBusy(true);
    setError("");
    setReceipt("");
    const retrying = pending.current !== null;
    pending.current ??= {
      requestId: Crypto.randomUUID(),
      text,
      submit: true,
      ...(options.force ? { force: true } : {}),
    };
    setPendingInput(true);
    try {
      const lease = leaseFor(control, options.requiresControl);
      const result = await api<{ state: string }>(
        connection,
        `/sessions/${id}/input`,
        { body: pending.current, control: lease },
      );
      if (result.state !== "delivered")
        throw new Error(
          "Delivery is uncertain. Check the screen before sending again.",
        );
      pending.current = null;
      setPendingInput(false);
      setText("");
      setReceipt("Delivered to terminal. Agent execution is not yet confirmed.");
      onDelivered();
      return true;
    } catch (e) {
      if (e instanceof ControlRefusal) {
        // Refused before anything was typed. A refused retry says nothing about the first try.
        control.refused();
        if (!retrying) {
          pending.current = null;
          setPendingInput(false);
        }
        setError(
          retrying
            ? `${e.message} This retry was refused. Earlier delivery remains unconfirmed; its request ID is kept.`
            : `${e.message} Your draft was not sent.`,
        );
        onDelivered();
      } else if (e instanceof ApiError && e.code === "prompt-open") {
        // Refused before anything was typed: the text stays in the box, unsent.
        pending.current = null;
        setPendingInput(false);
        setError("A prompt is open. Answer it above, or reply instead.");
        onDelivered();
      } else setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendKey(key: SteeringKey) {
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
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    receipt,
    pending: pendingInput,
    text,
    setText: (value: string) => { setText(value); setReceipt(""); setError(""); },
    send,
    sendKey,
  };
}
