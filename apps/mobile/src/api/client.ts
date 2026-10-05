import type { Attention, Provider } from "@infinite/attention";

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

export async function api<T>(
  connection: Connection,
  path: string,
  init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${connection.url}/api${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok)
      throw new ApiError(
        value.error ?? "Host request failed",
        response.status,
        typeof value.error === "string" ? value.error : undefined,
        value.attention,
      );
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
