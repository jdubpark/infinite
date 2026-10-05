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
};
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Connection failed");
  return data as T;
}
export const names: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
  demo: "Rehearsal",
};
