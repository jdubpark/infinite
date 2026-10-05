import { useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { api, ApiError, type Connection } from "../../api/client";

export const KEYS = ["enter", "escape", "up", "down", "interrupt"] as const;
export type SteeringKey = (typeof KEYS)[number];

/**
 * Text input and raw keys for one session, shared by the Brief and the
 * Terminal. An uncertain text send keeps its requestId, so "Retry" resends the
 * same request and the host cannot deliver it twice. The host refuses text
 * over an open dialog (`prompt-open`) unless `force` is set, which only the
 * Terminal does: there the person sees the dialog the text lands in.
 */
export function useSteering(
  connection: Connection,
  id: string,
  onDelivered: () => void,
  options: { force?: boolean } = {},
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const pending = useRef<{
    requestId: string;
    text: string;
    submit: boolean;
    force?: boolean;
  } | null>(null);
  const [pendingInput, setPendingInput] = useState(false);

  /** Resolves true once the host confirms delivery to the terminal. */
  async function send(text: string): Promise<boolean> {
    setBusy(true);
    setError("");
    setReceipt("");
    pending.current ??= {
      requestId: Crypto.randomUUID(),
      text,
      submit: true,
      ...(options.force ? { force: true } : {}),
    };
    setPendingInput(true);
    try {
      const result = await api<{ state: string }>(
        connection,
        `/sessions/${id}/input`,
        { body: pending.current },
      );
      if (result.state !== "delivered")
        throw new Error(
          "Delivery is uncertain. Check the screen before sending again.",
        );
      pending.current = null;
      setPendingInput(false);
      setReceipt("Delivered to terminal. Agent execution is not yet confirmed.");
      onDelivered();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "prompt-open") {
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
    try {
      await api(connection, `/sessions/${id}/key`, {
        body: { requestId: Crypto.randomUUID(), key },
      });
      setReceipt(`${key[0].toUpperCase()}${key.slice(1)} sent to terminal.`);
      onDelivered();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, receipt, pending: pendingInput, send, sendKey };
}
