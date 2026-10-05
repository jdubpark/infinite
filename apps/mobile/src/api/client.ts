import type { Attention, Provider } from "@infinite/attention";
import { loadClientId } from "../store/connection";

export type Connection = { url: string; token: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly attention?: Attention,
  ) {
    super(message);
  }
}

export type ControlCode = "control-busy" | "control-lost";
/**
 * The host refused input before anything was typed: another device holds control
 * (`control-busy`), or this phone's lease changed or expired (`control-lost`).
 */
export class ControlRefusal extends ApiError {
  constructor(
    message: string,
    readonly code: ControlCode,
  ) {
    super(message, 409, code);
  }
}

export async function api<T>(
  connection: Connection,
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    /** The lease id this phone holds; the host refuses input without it. */
    control?: string;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${connection.url}/api${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "X-Infinite-Client": await loadClientId(),
        ...(init.control ? { "X-Infinite-Control": init.control } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok) {
      const message = value.error ?? "Host request failed";
      // Control refusals carry `code` and a sentence; attention refusals carry the code as `error`.
      if (value.code === "control-busy" || value.code === "control-lost")
        throw new ControlRefusal(message, value.code);
      throw new ApiError(
        message,
        response.status,
        typeof value.code === "string"
          ? value.code
          : typeof value.error === "string"
            ? value.error
            : undefined,
        value.attention,
      );
    }
    return value as T;
  } catch (error) {
    if ((error as Error).name === "AbortError")
      throw new ApiError(
        "The host did not respond. Input delivery may be uncertain.",
        0,
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One device's input lease; the host refuses input from every other device while it lasts. */
export type ControlLease = { id: string; label: string; expiresAt: number };
export type SessionRow = {
  id: string;
  title: string;
  provider: Provider;
  status: string;
  createdAt: string;
  pid?: number;
  exitCode?: number;
  seq: number;
  attention: Attention;
  /** Present on workers that enforce input control; older workers take shared input. */
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1 };
  control?: ControlLease | null;
};
export type SessionDetail = SessionRow & {
  screen?: string;
  context: string;
  contextVersion: number;
  initialPrompt: string;
};
/** `POST /sessions/:id/answer` receipt; refusals arrive as HTTP 409 instead. */
export type AnswerReceipt = {
  requestId: string;
  state: "delivered" | "uncertain";
  seq: number;
  result: "closed" | "still-open" | "changed";
};
export type Me = {
  role: "owner" | "controller" | "viewer";
  environment: string;
  capabilities?: { signals: boolean; answer: boolean; push: boolean };
};
export type LogEvent = {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
};
