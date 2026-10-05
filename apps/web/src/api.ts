export type ControlLease = { id: string; label: string; expiresAt: number };
export type Session = {
  id: string;
  title: string;
  provider: string;
  projectId: string;
  status: string;
  createdAt: string;
  pid?: number;
  seq: number;
  screen?: string;
  initialPrompt?: string;
  context?: string;
  contextVersion: number;
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1 };
  control?: ControlLease | null;
  runtime?: { id: string; location: string; transport: "pty" };
  attention?: { state: string; now: string; lastMessage?: string };
};
export type LogEvent = {
  seq: number;
  at: string;
  type: "signal" | (string & {});
  data: Record<string, unknown>;
};
export type Me = {
  role: "owner" | "controller" | "viewer";
  environment: "cloud" | "local";
  providers: string[];
  projects: { id: string; name: string }[];
  terminal?: { stream: boolean; duplex: boolean; raw: boolean; snapshot?: boolean; control?: boolean };
};
// One identity per running browser tab, independent of its shared login cookie.
const clientId = crypto.randomUUID();
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly control?: ControlLease | null) {
    super(message);
  }
}
export function isControlRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 &&
    (error.code === "control-busy" || error.code === "control-lost");
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  controlId?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "X-Infinite-Client": clientId,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(controlId ? { "X-Infinite-Control": controlId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: controller.signal,
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "Connection failed", response.status, data.code, data.control);
  return data as T;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("The host did not respond.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export const names: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
  demo: "Rehearsal",
};
