import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import type { Prompt } from "@infinite/attention";
import {
  api,
  ApiError,
  ControlRefusal,
  type AnswerReceipt,
  type Connection,
} from "../../api/client";
import type { DecisionStatus } from "../../components/DecisionCard";
import { leaseFor, type SessionControlHandle } from "./useSessionControl";

type AnswerBody = {
  requestId: string;
  promptId: number;
  option?: number;
  text?: string;
};

const REFUSALS = new Set([
  "prompt-changed",
  "unsupported",
  "invalid-option",
  "text-not-accepted",
]);

const NOTICE_TEXT = {
  changed:
    "This prompt changed before the answer landed. Nothing was selected.",
  reloaded: "This prompt changed. Reloaded.",
  terminal: "This prompt must be answered in the terminal.",
  "control-busy":
    "Another device controls this session. Nothing was selected. Take over to answer here.",
  "control-lost":
    "This phone's control ended. Nothing was selected. Take control again to answer.",
} as const;
const TERMINAL_ONLY = new Set(["unsupported", "text-not-accepted"]);
const NOTICE_MS = 30_000;

type Notice = { kind: keyof typeof NOTICE_TEXT; promptId: number };
type CardState = { promptId?: number; status: DecisionStatus };
const IDLE: CardState = { status: { kind: "idle" } };

export function useAnswer(
  connection: Connection,
  id: string,
  prompt: Prompt | undefined,
  refresh: () => void,
  control: Pick<SessionControlHandle, "leaseId" | "refused">,
  requiresControl: boolean,
) {
  const [card, setCard] = useState<CardState>(IDLE);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const pendingAnswer = useRef<AnswerBody | null>(null);
  const inFlight = useRef(false);

  const promptId = prompt?.id;
  const [shownPromptId, setShownPromptId] = useState(promptId);
  if (promptId !== shownPromptId) {
    setShownPromptId(promptId);
    if (promptId !== undefined && promptId !== card.promptId) setCard(IDLE);
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  async function deliver(body: AnswerBody, retrying = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    pendingAnswer.current = body;
    setNotice(null);
    setCard({ promptId: body.promptId, status: { kind: "sending" } });
    try {
      const lease = leaseFor(control, requiresControl);
      const receipt = await api<AnswerReceipt>(
        connection,
        `/sessions/${id}/answer`,
        { body, control: lease },
      );
      if (receipt.state !== "delivered")
        throw new ApiError(
          "Delivery is uncertain. Check the terminal before answering again.",
          0,
        );
      pendingAnswer.current = null;
      if (receipt.result === "closed")
        setCard({ promptId: body.promptId, status: { kind: "sent" } });
      else if (receipt.result === "changed") {
        setCard(IDLE);
        setNotice({ kind: "changed", promptId: body.promptId });
      } else
        setCard({ promptId: body.promptId, status: { kind: "still-open" } });
    } catch (error) {
      if (error instanceof ControlRefusal) {
        control.refused();
        if (retrying)
          setCard({
            promptId: body.promptId,
            status: {
              kind: "error",
              message: `${error.message} This retry was refused. Earlier delivery remains unconfirmed; its request ID is kept.`,
              retry: true,
            },
          });
        else {
          pendingAnswer.current = null;
          setCard(IDLE);
          setNotice({ kind: error.code, promptId: body.promptId });
        }
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.attention &&
        error.code !== undefined &&
        REFUSALS.has(error.code)
      ) {
        pendingAnswer.current = null;
        setCard(IDLE);
        setNotice({
          kind: TERMINAL_ONLY.has(error.code) ? "terminal" : "reloaded",
          promptId: body.promptId,
        });
      } else if (error instanceof ApiError && error.status === 403) {
        pendingAnswer.current = null;
        setForbidden(true);
        setCard(IDLE);
      } else {
        const retry =
          !(error instanceof ApiError) ||
          error.status === 0 ||
          error.status === 409;
        if (!retry) pendingAnswer.current = null;
        setCard({
          promptId: body.promptId,
          status: {
            kind: "error",
            message:
              error instanceof ApiError
                ? error.message
                : "Could not reach the host. The answer may not have been delivered.",
            retry,
          },
        });
      }
    } finally {
      inFlight.current = false;
      refresh();
    }
  }

  function answer(option?: number, text?: string) {
    if (!prompt) return;
    void deliver({
      requestId: Crypto.randomUUID(),
      promptId: prompt.id,
      ...(option !== undefined ? { option } : {}),
      ...(text ? { text } : {}),
    });
  }

  function retry() {
    if (pendingAnswer.current) void deliver(pendingAnswer.current, true);
  }

  return {
    status:
      prompt && card.promptId === prompt.id ? card.status : IDLE.status,
    notice: notice ? NOTICE_TEXT[notice.kind] : "",
    dismissNotice: () => setNotice(null),
    forbidden,
    answer,
    retry,
  };
}
